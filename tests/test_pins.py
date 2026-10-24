"""
Тесты закреплённых сообщений (v10.1): личные чаты и каналы серверов.

Запуск:
    /home/user/.venv/bin/python -m pytest tests -q
"""
import asyncio
import json
import sys
from pathlib import Path

import httpx
import websockets

sys.path.insert(0, str(Path(__file__).resolve().parent))

from test_smoke import Server, auth, register, wait_msg, wait_until  # noqa: E402


async def scenario(base: str, ws_url: str):
    with httpx.Client(base_url=base, timeout=10) as c:
        alice = register(c, "pina").json()
        bob = register(c, "pinb").json()
        carol = register(c, "pinc").json()
        ta, tb, tc = alice["token"], bob["token"], carol["token"]

        # дружим alice и bob
        c.post("/api/friends/request", json={"to_user": "pinb"}, headers=auth(ta))
        c.post("/api/friends/accept", json={"to_user": "pina"}, headers=auth(tb))

        async with websockets.connect(f"{ws_url}?token={ta}") as wa, \
                   websockets.connect(f"{ws_url}?token={tb}") as wb:
            await wait_msg(wa, "presence")
            await wait_msg(wb, "presence")

            await wb.send(json.dumps({
                "type": "message", "to": "pina", "text": "закрепи меня", "client_id": "p-1",
            }))
            got = await wait_msg(wa, "message")
            msg_id = got["id"]
            assert got["pinned"] is False, "по умолчанию сообщение не закреплено"

            # ---------- закрепление по WS ----------
            await wa.send(json.dumps({"type": "pin_msg", "id": msg_id, "pinned": True}))
            pinned_b = await wait_msg(wb, "pin_changed")
            pinned_a = await wait_msg(wa, "pin_changed")
            assert pinned_b["message"]["id"] == msg_id
            assert pinned_b["message"]["pinned"] is True
            assert pinned_b["message"]["pinned_by"] == "pina"
            assert pinned_a["message"]["pinned_by"] == "pina"

            # флаг виден в истории и в списке закреплённых
            hist = c.get("/api/messages/pina/pinb", headers=auth(tb)).json()
            assert any(m["id"] == msg_id and m["pinned"] for m in hist), hist
            pins = c.get("/api/pins/pinb", headers=auth(ta)).json()["pins"]
            assert [p["id"] for p in pins] == [msg_id], pins
            # тот же список с другой стороны
            assert [p["id"] for p in c.get("/api/pins/pina", headers=auth(tb)).json()["pins"]] == [msg_id]

            # чужой чат: закрепить нельзя
            assert c.get("/api/pins/pinb", headers=auth(tc)).status_code == 403
            r = c.post("/api/messages/pin", json={"message_id": msg_id, "pinned": True},
                       headers=auth(tc))
            assert r.status_code == 403, r.text

            # ---------- REST-фолбэк: открепление ----------
            r = c.post("/api/messages/pin", json={"message_id": msg_id, "pinned": False},
                       headers=auth(tb))
            assert r.status_code == 200, r.text
            assert r.json()["message"]["pinned"] is False
            unpin = await wait_msg(wa, "pin_changed")
            assert unpin["message"]["pinned"] is False
            assert c.get("/api/pins/pinb", headers=auth(ta)).json()["pins"] == []

            # ---------- удаление снимает закрепление ----------
            c.post("/api/messages/pin", json={"message_id": msg_id, "pinned": True}, headers=auth(ta))
            await wait_msg(wb, "pin_changed")
            await wb.send(json.dumps({"type": "delete_msg", "id": msg_id}))
            deleted = await wait_msg(wb, "message_updated")
            assert deleted["deleted"] == 1
            assert deleted["pinned"] is False, "удалённое сообщение не остаётся закреплённым"
            assert c.get("/api/pins/pinb", headers=auth(ta)).json()["pins"] == []

            # нельзя закрепить удалённое
            r = c.post("/api/messages/pin", json={"message_id": msg_id, "pinned": True},
                       headers=auth(ta))
            assert r.status_code == 400, r.text

            # ---------- серверы ----------
            sid = c.post("/api/servers", json={"name": "Пины"}, headers=auth(ta)).json()["server"]["id"]
            code = c.get(f"/api/servers/{sid}", headers=auth(ta)).json()["invite_code"]
            assert c.post("/api/servers/join", json={"code": code}, headers=auth(tb)).status_code == 200
            full = c.get(f"/api/servers/{sid}", headers=auth(ta)).json()
            cid = full["channels"][0]["id"]

            await wait_msg(wa, "server_member_joined")

            r = c.post(f"/api/servers/{sid}/channels/{cid}/messages",
                       json={"text": "важное объявление"}, headers=auth(tb))
            assert r.status_code == 200, r.text
            srv_msg = r.json()["id"]

            r = c.post(f"/api/servers/{sid}/channels/{cid}/messages/{srv_msg}/pin",
                       json={"pinned": True}, headers=auth(tb))
            assert r.status_code == 200, r.text
            live = await wait_until(wa, "server_pin_changed", lambda m: m["message"]["id"] == srv_msg)
            assert live["message"]["pinned"] is True
            assert live["channel_id"] == cid

            pins = c.get(f"/api/servers/{sid}/channels/{cid}/pins", headers=auth(ta)).json()["pins"]
            assert [p["id"] for p in pins] == [srv_msg], pins

            # по WS тоже можно
            await wa.send(json.dumps({"type": "server_pin_msg", "id": srv_msg, "pinned": False}))
            live = await wait_until(wb, "server_pin_changed", lambda m: m["message"]["pinned"] is False)
            assert live["message"]["id"] == srv_msg
            assert c.get(f"/api/servers/{sid}/channels/{cid}/pins", headers=auth(ta)).json()["pins"] == []

            # посторонний не может закреплять
            r = c.post(f"/api/servers/{sid}/channels/{cid}/messages/{srv_msg}/pin",
                       json={"pinned": True}, headers=auth(tc))
            assert r.status_code == 403, r.text
            assert c.get(f"/api/servers/{sid}/channels/{cid}/pins", headers=auth(tc)).status_code == 403

            # удаление в канале снимает пин
            c.post(f"/api/servers/{sid}/channels/{cid}/messages/{srv_msg}/pin",
                   json={"pinned": True}, headers=auth(ta))
            await wait_until(wb, "server_pin_changed", lambda m: m["message"]["pinned"] is True)
            await wa.send(json.dumps({"type": "server_delete_msg", "id": srv_msg}))
            gone = await wait_until(wb, "server_message_updated", lambda m: m["id"] == srv_msg)
            assert gone["deleted"] == 1 and gone["pinned"] is False
            assert c.get(f"/api/servers/{sid}/channels/{cid}/pins", headers=auth(ta)).json()["pins"] == []

    print("✅ v10.1: закрепление сообщений работает")


def test_pins_flow():
    with Server() as srv:
        asyncio.run(scenario(srv.http, srv.ws))


if __name__ == "__main__":
    test_pins_flow()
