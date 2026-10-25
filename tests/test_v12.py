"""
Тесты v12: реакции, статусы (presence), пересылка сообщений,
версионирование статики (чтобы правки CSS доезжали до людей).

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
        alice = register(c, "anna").json()
        bob = register(c, "boris").json()
        ta, tb = alice["token"], bob["token"]

        c.post("/api/friends/request", json={"to_user": "boris"}, headers=auth(ta))
        c.post("/api/friends/accept", json={"to_user": "anna"}, headers=auth(tb))

        # ---------- статика: версия в ссылках + no-cache ----------
        page = c.get("/").text
        assert "?v=dev" not in page, "плейсхолдер версии не должен уходить клиенту"
        assert "/static/features.js?v=" in page, "features.js подключён"
        assert "/static/style.css?v=" in page
        r = c.get("/static/style.css")
        assert r.status_code == 200
        assert "no-cache" in r.headers.get("cache-control", ""), r.headers.get("cache-control")

        # ---------- статусы ----------
        me = c.get("/api/me", headers=auth(ta)).json()
        assert me["statuses"] == ["online", "idle", "dnd", "invisible"]
        assert me["user"]["status"] == "online"
        assert me["user"]["status_text"] == ""

        r = c.post("/api/presence", json={"status": "dnd", "status_text": "  на   созвоне  "}, headers=auth(ta))
        assert r.status_code == 200, r.text
        assert r.json()["status"] == "dnd"
        assert r.json()["status_text"] == "на созвоне", "пробелы нормализуются"

        card = c.get("/api/profile/anna", headers=auth(tb)).json()
        assert card["status"] == "dnd"
        assert card["status_text"] == "на созвоне"

        # неверный статус → online
        r = c.post("/api/presence", json={"status": "что-то"}, headers=auth(ta))
        assert r.json()["status"] == "online"

        # ---------- реакция по REST ----------
        msg = {"to": "boris", "text": "привет с реакцией"}
        async with websockets.connect(f"{ws_url}?token={ta}") as ws_a:
            await ws_a.send(json.dumps({"type": "message", **msg}))
            sent = await wait_msg(ws_a, "message")
            mid = sent["id"]

            r = c.post("/api/reactions", json={"scope": "dm", "message_id": mid, "emoji": "👍"}, headers=auth(tb))
            assert r.status_code == 200, r.text
            assert r.json()["reactions"] == [{"emoji": "👍", "count": 1, "users": ["boris"]}]

            event = await wait_msg(ws_a, "reaction")
            assert event["message_id"] == mid
            assert event["reactions"][0]["emoji"] == "👍"

            # второй пользователь — счётчик растёт
            r = c.post("/api/reactions", json={"scope": "dm", "message_id": mid, "emoji": "👍"}, headers=auth(ta))
            assert r.json()["reactions"][0]["count"] == 2

            # повторный клик снимает реакцию
            r = c.post("/api/reactions", json={"scope": "dm", "message_id": mid, "emoji": "👍"}, headers=auth(ta))
            assert r.json()["reactions"][0]["count"] == 1

            # реакции приходят в истории сообщений
            history = c.get("/api/messages/anna/boris", headers=auth(ta)).json()
            target = next(m for m in history if m["id"] == mid)
            assert target["reactions"][0]["emoji"] == "👍"

            # ---------- реакция по WS ----------
            await ws_a.send(json.dumps({"type": "reaction", "scope": "dm", "id": mid, "emoji": "🔥"}))
            event = await wait_until(ws_a, "reaction", lambda m: m["message_id"] == mid and any(x["emoji"] == "🔥" for x in m["reactions"]))
            assert event["message_id"] == mid

            # чужое сообщение реагировать нельзя
            r = c.post("/api/reactions", json={"scope": "dm", "message_id": 999999, "emoji": "👍"}, headers=auth(ta))
            assert r.status_code == 404

        # ---------- пересылка ----------
        async with websockets.connect(f"{ws_url}?token={tb}") as ws_b:
            await ws_b.send(json.dumps({
                "type": "message", "to": "anna", "text": "пересланный текст",
                "client_id": "fwd-1", "fwd_from": "boris", "fwd_name": "Борис",
            }))
            got = await wait_msg(ws_b, "message")
            assert got["fwd_from"] == "boris"
            assert got["fwd_name"] == "Борис"

            history = c.get("/api/messages/anna/boris", headers=auth(ta)).json()
            forwarded = [m for m in history if m.get("fwd_from") == "boris"]
            assert forwarded, "пересылка сохранена в истории"
            assert forwarded[-1]["text"] == "пересланный текст"

        # ---------- статус в /api/chats ----------
        chats = c.get("/api/chats", headers=auth(tb)).json()["chats"]
        anna = next(ch for ch in chats if ch["username"] == "anna")
        assert "status" in anna and "status_text" in anna

    print("✅ v12: реакции, статусы, пересылка и версии статики работают")


def test_v12_flow():
    with Server() as srv:
        asyncio.run(scenario(srv.http, srv.ws))


if __name__ == "__main__":
    test_v12_flow()
