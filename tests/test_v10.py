"""
Тесты v10: темы, серверы (как Discord), каналы (как Telegram), звонки.

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
        carol = register(c, "clara").json()

        ta, tb, tc = alice["token"], bob["token"], carol["token"]

        # ---------- темы ----------
        me = c.get("/api/me", headers=auth(ta)).json()
        assert len(me["themes"]) == 10, me["themes"]
        assert "midnight" in me["themes"] and "cherry" in me["themes"]
        assert me["user"]["theme"] == "midnight"

        r = c.post("/api/update_profile", json={"theme": "ocean"}, headers=auth(ta))
        assert r.status_code == 200, r.text
        assert r.json()["user"]["theme"] == "ocean"
        # неизвестная тема откатывается в дефолт
        r = c.post("/api/update_profile", json={"theme": "hack<script>"}, headers=auth(ta))
        assert r.json()["user"]["theme"] == "midnight"

        # ---------- серверы ----------
        r = c.post(
            "/api/servers",
            json={"name": "Тусовка", "description": "тестовый сервер", "icon": "🎮"},
            headers=auth(ta),
        )
        assert r.status_code == 200, r.text
        server = r.json()["server"]
        sid = server["id"]
        code = server["invite_code"]
        assert len(code) >= 6

        full = c.get(f"/api/servers/{sid}", headers=auth(ta)).json()
        assert full["my_role"] == "owner"
        names = [ch["name"] for ch in full["channels"]]
        assert len(names) >= 2, names
        channel_id = full["channels"][0]["id"]

        # посторонний не видит сервер
        assert c.get(f"/api/servers/{sid}", headers=auth(tb)).status_code == 403
        # приглашение читается по коду
        assert c.get(f"/api/servers/invite/{code}", headers=auth(tb)).status_code == 200

        r = c.post("/api/servers/join", json={"code": code}, headers=auth(tb))
        assert r.status_code == 200, r.text
        assert c.get(f"/api/servers/{sid}", headers=auth(tb)).json()["my_role"] == "member"

        # участник не может создавать каналы
        r = c.post(f"/api/servers/{sid}/channels", json={"name": "секрет"}, headers=auth(tb))
        assert r.status_code == 403, r.text
        # владелец может
        r = c.post(f"/api/servers/{sid}/channels", json={"name": "мемы"}, headers=auth(ta))
        assert r.status_code == 200, r.text
        assert any(ch["name"] == "мемы" for ch in r.json()["server"]["channels"])

        async with websockets.connect(f"{ws_url}?token={ta}") as wa, \
                   websockets.connect(f"{ws_url}?token={tb}") as wb:
            await wait_msg(wa, "presence")
            await wait_msg(wb, "presence")

            # сообщение в канал летит всем участникам
            await wb.send(json.dumps({
                "type": "server_message", "channel_id": channel_id,
                "text": "всем привет", "client_id": "s-1",
            }))
            got = await wait_msg(wb, "server_message")
            assert got["text"] == "всем привет"
            got_alice = await wait_msg(wa, "server_message")
            assert got_alice["id"] == got["id"]
            assert got_alice["channel_id"] == channel_id
            msg_id = got["id"]

            # редактирование и удаление
            await wb.send(json.dumps({"type": "server_edit_msg", "id": msg_id, "text": "изменил"}))
            upd = await wait_msg(wa, "server_message_updated")
            assert upd["edited"] == 1 and upd["text"] == "изменил"

            # чужое сообщение участник не удалит, владелец канала — да
            await wb.send(json.dumps({"type": "server_delete_msg", "id": msg_id}))
            deleted = await wait_msg(wa, "server_message_updated")
            assert deleted["deleted"] == 1

            # ---------- роли и исключение ----------
            r = c.post(f"/api/servers/{sid}/members/boris/role",
                       json={"role": "admin"}, headers=auth(ta))
            assert r.status_code == 200, r.text
            members = {m["username"]: m for m in c.get(f"/api/servers/{sid}", headers=auth(ta)).json()["members"]}
            assert members["boris"]["role"] == "admin"

            # админ не может снять владельца
            r = c.post(f"/api/servers/{sid}/members/anna/role",
                       json={"role": "member"}, headers=auth(tb))
            assert r.status_code == 403

            await wait_until(wa, "server_members_changed", lambda m: True)

            r = c.post(f"/api/servers/{sid}/members/boris/kick", headers=auth(ta))
            assert r.status_code == 200, r.text
            left = await wait_until(wb, "server_left", lambda m: m.get("server_id") == sid)
            assert left["kicked"] is True
            assert c.get(f"/api/servers/{sid}", headers=auth(tb)).status_code == 403

            # ---------- приглашение: смена кода ----------
            new_code = c.post(f"/api/servers/{sid}/rotate_invite", headers=auth(ta)).json()["invite_code"]
            assert new_code != code
            assert c.post("/api/servers/join", json={"code": code}, headers=auth(tc)).status_code == 404
            assert c.post("/api/servers/join", json={"code": new_code}, headers=auth(tc)).status_code == 200

            # ---------- Telegram-каналы ----------
            r = c.post("/api/tg/channels", json={
                "name": "Новости", "description": "всё о сваптайме", "color": "#1e88e5", "is_public": True,
            }, headers=auth(ta))
            assert r.status_code == 200, r.text
            tg = r.json()["channel"]
            tg_id = tg["id"]
            assert tg["is_owner"] is True

            found = c.get("/api/tg/discover?q=новост", headers=auth(tc)).json()["channels"]
            assert any(ch["id"] == tg_id for ch in found), found

            assert c.post(f"/api/tg/channels/{tg_id}/subscribe", headers=auth(tc)).status_code == 200
            assert any(ch["id"] == tg_id for ch in c.get("/api/tg/channels", headers=auth(tc)).json()["channels"])

            # подписчик не может публиковать
            r = c.post(f"/api/tg/channels/{tg_id}/posts", json={"text": "я не владелец"}, headers=auth(tc))
            assert r.status_code == 403, r.text

            r = c.post(f"/api/tg/channels/{tg_id}/posts", json={"text": "Первый пост"}, headers=auth(ta))
            assert r.status_code == 200, r.text
            post_id = r.json()["post"]["id"]

            async with websockets.connect(f"{ws_url}?token={tc}") as wc:
                await wait_msg(wc, "presence")
                r = c.post(f"/api/tg/channels/{tg_id}/posts", json={"text": "Второй пост"}, headers=auth(ta))
                assert r.status_code == 200
                live = await wait_msg(wc, "tg_post")
                assert live["post"]["text"] == "Второй пост"
                assert live["channel_id"] == tg_id

                # редактирование поста доходит до подписчика
                c.post(f"/api/tg/posts/{post_id}/edit", json={"text": "Пост (изм)"}, headers=auth(ta))
                edited = await wait_msg(wc, "tg_post_updated")
                assert edited["post"]["edited"] == 1

                # закрытый канал не видно в поиске
                r = c.post("/api/tg/channels", json={"name": "Тайный", "is_public": False},
                           headers=auth(ta))
                hidden_id = r.json()["channel"]["id"]
                found = c.get("/api/tg/discover", headers=auth(tc)).json()["channels"]
                assert all(ch["id"] != hidden_id for ch in found)
                assert c.get(f"/api/tg/channels/{hidden_id}", headers=auth(tc)).status_code == 403

                # удаление канала — подписчик получает событие
                c.delete(f"/api/tg/channels/{tg_id}", headers=auth(ta))
                gone = await wait_msg(wc, "tg_channel_deleted")
                assert gone["channel_id"] == tg_id
                assert all(ch["id"] != tg_id for ch in c.get("/api/tg/channels", headers=auth(tc)).json()["channels"])

        # ---------- звонки: право звонить ----------
        r = c.get("/api/profile/boris", headers=auth(ta))
        assert r.status_code == 200
        card = r.json()
        assert "can_call" in card

        # незнакомцу звонить нельзя, другу — можно
        assert card["can_call"] is False
        c.post("/api/friends/request", json={"to_user": "boris"}, headers=auth(ta))
        c.post("/api/friends/accept", json={"to_user": "anna"}, headers=auth(tb))
        assert c.get("/api/profile/boris", headers=auth(ta)).json()["can_call"] is True

    print("✅ v10: темы, серверы, каналы и звонки работают")


def test_v10_flow():
    with Server() as srv:
        asyncio.run(scenario(srv.http, srv.ws))


if __name__ == "__main__":
    test_v10_flow()
