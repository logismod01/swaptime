"""
Смоук-тесты СвапТайм.

Запуск:
    python -m pytest tests -q
или без pytest:
    python tests/test_smoke.py

Тест сам поднимает uvicorn на свободном порту с временной базой данных,
чтобы не трогать data/swaptime.db.
"""
import asyncio
import json
import os
import socket
import subprocess
import sys
import tempfile
import time
from pathlib import Path

import httpx
import websockets

ROOT = Path(__file__).resolve().parent.parent
PY = sys.executable


def free_port() -> int:
    with socket.socket() as s:
        s.bind(("127.0.0.1", 0))
        return s.getsockname()[1]


class Server:
    def __init__(self):
        self.port = free_port()
        self.db = tempfile.NamedTemporaryFile(suffix=".db", delete=False).name
        os.unlink(self.db)
        self.proc = None

    def __enter__(self):
        env = dict(os.environ, SWAPTIME_DB=self.db, PORT=str(self.port))
        self.proc = subprocess.Popen(
            [PY, "-m", "uvicorn", "backend.server:app", "--host", "127.0.0.1",
             "--port", str(self.port), "--log-level", "warning"],
            cwd=str(ROOT), env=env,
        )
        base = f"http://127.0.0.1:{self.port}"
        deadline = time.time() + 25
        while time.time() < deadline:
            try:
                httpx.get(base + "/", timeout=1.0)
                return self
            except Exception:
                time.sleep(0.2)
        raise RuntimeError("Сервер не поднялся")

    def __exit__(self, *exc):
        if self.proc:
            self.proc.terminate()
            try:
                self.proc.wait(timeout=10)
            except subprocess.TimeoutExpired:
                self.proc.kill()
        try:
            os.unlink(self.db)
        except OSError:
            pass

    @property
    def http(self):
        return f"http://127.0.0.1:{self.port}"

    @property
    def ws(self):
        return f"ws://127.0.0.1:{self.port}/ws"


def register(client: httpx.Client, name: str, password="pass1234"):
    return client.post("/api/register", json={
        "username": name, "password": password, "display_name": name.title(), "email": f"{name}@mail.ru",
    })


def auth(token: str):
    return {"Authorization": f"Bearer {token}"}


async def wait_msg(ws, msg_type=None, timeout=4.0, skip=0):
    """Ждёт сообщение нужного типа, пропуская служебные (presence/pong)."""
    seen = 0
    deadline = asyncio.get_event_loop().time() + timeout
    while asyncio.get_event_loop().time() < deadline:
        raw = await asyncio.wait_for(ws.recv(), timeout=max(0.1, deadline - asyncio.get_event_loop().time()))
        data = json.loads(raw)
        if msg_type and data.get("type") != msg_type:
            continue
        if seen < skip:
            seen += 1
            continue
        return data
    raise AssertionError(f"не дождались {msg_type}")


async def wait_until(ws, msg_type, predicate, timeout=6.0, limit=60):
    """Ждёт событие нужного типа, пока не совпадёт predicate (в очереди их может быть много)."""
    for _ in range(limit):
        data = await wait_msg(ws, msg_type, timeout=timeout)
        if predicate(data):
            return data
    raise AssertionError(f"не дождались {msg_type} по условию")


async def scenario(base: str, ws_url: str):
    with httpx.Client(base_url=base, timeout=10) as c:
        # ---------- регистрация ----------
        r = register(c, "alice")
        assert r.status_code == 200, r.text
        alice = r.json()
        # cookie-аутентификация: токен не передаём, браузер шлёт cookie
        assert c.get("/api/me").status_code == 200, "cookie-авторизация не работает"
        # токен в query — запасной вариант, если прокси срезал Authorization
        assert c.get(f"/api/me?token={alice['token']}").status_code == 200

        r = register(c, "bob")
        assert r.status_code == 200, r.text
        bob = r.json()
        r = register(c, "carol")
        carol = r.json()
        assert len(alice["user"]["username"]) >= 3

        # ник с html/спецсимволами не должен пройти
        bad = c.post("/api/register", json={"username": "<script>", "password": "1234"})
        assert bad.status_code == 400

        # ---------- авторизация ----------
        anon = httpx.Client(base_url=base, timeout=10)
        assert anon.get("/api/me").status_code == 401
        assert anon.get("/api/me", headers=auth("nope")).status_code == 401
        anon.close()
        # битый заголовок не должен «проваливаться» в cookie
        assert c.get("/api/me", headers=auth("nope")).status_code == 401
        me = c.get("/api/me", headers=auth(alice["token"])).json()
        assert me["user"]["username"] == "alice"
        assert len(me["fonts"]) == 10, me["fonts"]

        # чужой чат читать нельзя
        r = c.get("/api/messages/bob/carol", headers=auth(alice["token"]))
        assert r.status_code == 403, r.text

        # профиль без токена менять нельзя
        anon = httpx.Client(base_url=base, timeout=10)
        r = anon.post("/api/update_profile", json={"display_name": "hack"})
        assert r.status_code == 401
        anon.close()

        # ---------- друзья ----------
        r = c.post("/api/friends/request", json={"to_user": "bob"}, headers=auth(alice["token"]))
        assert r.status_code == 200, r.text

        r = c.get("/api/friends", headers=auth(bob["token"])).json()
        assert [u["username"] for u in r["requests"]] == ["alice"], r

        r = c.post("/api/friends/accept", json={"to_user": "alice"}, headers=auth(bob["token"]))
        assert r.status_code == 200, r.text

        chats = c.get("/api/chats", headers=auth(bob["token"])).json()["chats"]
        assert [ch["username"] for ch in chats] == ["alice"], chats

        # ---------- websocket: сообщения ----------
        async with websockets.connect(f"{ws_url}?token={alice['token']}") as wa, \
                   websockets.connect(f"{ws_url}?token={bob['token']}") as wb:

            # пропускаем presence
            await wait_msg(wa, "presence")
            await wait_msg(wb, "presence")

            payload = {"type": "message", "to": "bob", "text": "привет!", "client_id": "c-1"}
            await wa.send(json.dumps(payload))

            got_bob = await wait_msg(wb, "message")
            got_alice = await wait_msg(wa, "message")
            assert got_bob["id"] == got_alice["id"]
            assert got_bob["text"] == "привет!"
            assert got_bob["client_id"] == "c-1"
            msg_id = got_bob["id"]

            # повторная отправка того же client_id не создаёт дубль
            await wa.send(json.dumps(payload))
            dup = await wait_msg(wa, "message")
            assert dup["id"] == msg_id

            # ---------- ответ ----------
            await wb.send(json.dumps({
                "type": "message", "to": "alice", "text": "ответ", "reply_to": msg_id, "client_id": "c-2",
            }))
            reply = await wait_msg(wa, "message")
            assert reply["reply_to"] == msg_id
            assert reply["reply_preview"]["text"] == "привет!"
            assert reply["reply_preview"]["from"] == "alice"

            # ---------- непрочитанные ----------
            unread = c.get("/api/unread", headers=auth(alice["token"])).json()["unread"]
            assert unread.get("bob", 0) >= 1, unread

            c.post("/api/mark_read", json={"to_user": "bob"}, headers=auth(alice["token"]))
            unread = c.get("/api/unread", headers=auth(alice["token"])).json()["unread"]
            assert unread.get("bob", 0) == 0, unread
            chats = c.get("/api/chats", headers=auth(alice["token"])).json()["chats"]
            assert chats[0]["last_message"]["text"] == "ответ"
            assert chats[0]["unread"] == 0

            # ---------- редактирование доходит до собеседника ----------
            await wa.send(json.dumps({"type": "edit_msg", "id": msg_id, "text": "привет (изм)"}))
            upd_bob = await wait_msg(wb, "message_updated")
            assert upd_bob["id"] == msg_id
            assert upd_bob["edited"] == 1
            assert upd_bob["text"] == "привет (изм)"

            hist = c.get("/api/messages/alice/bob", headers=auth(bob["token"])).json()
            assert hist[0]["text"] == "привет (изм)"

            # чужое сообщение редактировать нельзя
            await wb.send(json.dumps({"type": "edit_msg", "id": msg_id, "text": "взлом"}))
            err = await wait_msg(wb, "error")
            assert "только свои" in err["text"]

            # ---------- удаление ----------
            await wa.send(json.dumps({"type": "delete_msg", "id": msg_id}))
            deleted = await wait_msg(wb, "message_updated")
            assert deleted["deleted"] == 1
            assert deleted["text"] == ""

            hist = c.get("/api/messages/alice/bob", headers=auth(bob["token"])).json()
            assert hist[0]["deleted"] == 1 and hist[0]["text"] == ""

            # ---------- печатает ----------
            await wa.send(json.dumps({"type": "typing", "to": "bob"}))
            typing = await wait_msg(wb, "typing")
            assert typing["from"] == "alice"

            # ---------- писать незнакомцам нельзя ----------
            async with websockets.connect(f"{ws_url}?token={carol['token']}") as wc:
                await wait_msg(wc, "presence")
                await wc.send(json.dumps({"type": "message", "to": "bob", "text": "незнакомец",
                                          "client_id": "c-0"}))
                not_friend = await wait_msg(wc, "error")
                assert "друз" in not_friend["text"], not_friend

            # ---------- игнор ----------
            c.post("/api/friends/request", json={"to_user": "carol"}, headers=auth(bob["token"]))
            c.post("/api/friends/accept", json={"to_user": "bob"}, headers=auth(carol["token"]))
            c.post("/api/friends/ignore", json={"to_user": "carol"}, headers=auth(bob["token"]))
            async with websockets.connect(f"{ws_url}?token={carol['token']}") as wc:
                await wait_msg(wc, "presence")
                await wc.send(json.dumps({"type": "message", "to": "bob", "text": "спам", "client_id": "c-3"}))
                echo = await wait_msg(wc, "message")
                assert echo["text"] == "спам"
                try:
                    await wait_msg(wb, "message", timeout=1.0)
                    raise AssertionError("игнорируемое сообщение дошло до bob")
                except asyncio.TimeoutError:
                    pass

            # ---------- аватарки, рамки, профиль ----------
            me_data = c.get("/api/me", headers=auth(alice["token"])).json()
            assert len(me_data["frames"]) == 10, me_data["frames"]
            assert "crimson" in me_data["banners"]
            assert me_data["user"]["has_avatar"] is False

            png = (
                "data:image/png;base64,"
                "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8DwHwAF"
                "AAH/q842iQAAAABJRU5ErkJggg=="
            )
            r = c.post("/api/avatar", json={"avatar": png}, headers=auth(alice["token"]))
            assert r.status_code == 200, r.text
            alice_avatar = r.json()["user"]
            assert alice_avatar["has_avatar"] is True
            assert len(alice_avatar["avatar_ver"]) == 10

            # сам файл отдаётся с картинкой и кешем
            av = c.get(f"/api/avatar/alice?v={alice_avatar['avatar_ver']}")
            assert av.status_code == 200
            assert av.headers["content-type"].startswith("image/png")
            assert "immutable" in av.headers.get("cache-control", "")
            assert av.content[:4] == b"\x89PNG"

            # смена аватарки меняет версию (сброс кеша)
            r = c.post("/api/avatar", json={"avatar": png + ""}, headers=auth(alice["token"]))
            assert r.json()["user"]["avatar_ver"] == alice_avatar["avatar_ver"]

            # не картинка — отказ
            assert c.post("/api/avatar", json={"avatar": "data:text/html;base64,PHNjcmlwdD4="},
                          headers=auth(alice["token"])).status_code == 400
            # слишком большая — отказ
            huge = "data:image/png;base64," + "A" * 500_000
            assert c.post("/api/avatar", json={"avatar": huge},
                          headers=auth(alice["token"])).status_code == 413

            # удаление аватарки
            r = c.post("/api/avatar", json={"avatar": ""}, headers=auth(alice["token"]))
            assert r.json()["user"]["has_avatar"] is False
            assert c.get("/api/avatar/alice").status_code == 404
            assert c.get("/api/avatar/nobody").status_code == 404

            # рамка, баннер и био
            r = c.post("/api/update_profile", json={
                "avatar_frame": "gold", "banner": "ocean", "bio": "Привет, я Алиса 👋",
            }, headers=auth(alice["token"]))
            assert r.status_code == 200, r.text
            prof = r.json()["user"]
            assert prof["avatar_frame"] == "gold"
            assert prof["banner"] == "ocean"
            assert prof["bio"].startswith("Привет")

            # неизвестная рамка/баннер сбрасываются в дефолт
            prof = c.post("/api/update_profile", json={"avatar_frame": "<script>", "banner": "xxx"},
                          headers=auth(alice["token"])).json()["user"]
            assert prof["avatar_frame"] == "none"
            assert prof["banner"] == "crimson"

            # изменение профиля доходит до друга по WS
            c.post("/api/avatar", json={"avatar": png}, headers=auth(alice["token"]))
            c.post("/api/update_profile", json={"avatar_frame": "neon", "bio": "новое био"},
                   headers=auth(alice["token"]))
            upd = await wait_until(
                wb, "profile_updated", lambda m: m["user"].get("avatar_frame") == "neon"
            )
            assert upd["user"]["avatar_ver"], "в событии должна быть версия аватарки"
            assert upd["user"]["bio"] == "новое био"

            # публичная карточка профиля
            card = c.get("/api/profile/alice", headers=auth(bob["token"])).json()
            assert card["display_name"]
            assert card["avatar_frame"] == "neon"
            assert card["is_friend"] is True
            assert card["is_me"] is False
            assert card["created_at"] > 0
            assert "avatar" not in card, "base64 не должен утекать в карточку"

            # ---------- блокировка ----------
            r = c.post("/api/friends/block", json={"to_user": "bob"}, headers=auth(alice["token"]))
            assert r.status_code == 200, r.text
            await wait_msg(wb, "friend_changed")
            await wa.send(json.dumps({"type": "message", "to": "bob", "text": "не пройдёт", "client_id": "c-4"}))
            blocked_err = await wait_msg(wa, "error")
            assert "блоке" in blocked_err["text"]

            # ---------- шрифты ----------
            r = c.post("/api/update_profile", json={
                "display_name": "Алиса", "avatar_color": "#123456", "font_family": "Poppins, sans-serif",
            }, headers=auth(alice["token"]))
            assert r.status_code == 200, r.text
            assert r.json()["user"]["font_family"] == "Poppins, sans-serif"
            assert r.json()["user"]["avatar_color"] == "#123456"

            # кривой цвет не проходит
            r = c.post("/api/update_profile", json={
                "display_name": "Алиса", "avatar_color": "javascript:alert(1)", "font_family": "Poppins, sans-serif",
            }, headers=auth(alice["token"]))
            assert r.json()["user"]["avatar_color"] == "#e53935"

        # ---------- выход по cookie ----------
        c2 = httpx.Client(base_url=base, timeout=10)
        r = c2.post("/api/register", json={
            "username": "dave", "password": "pass1234", "display_name": "Dave", "email": "dave@mail.ru",
        })
        assert r.status_code == 200, r.text
        assert c2.get("/api/me").status_code == 200
        assert c2.post("/api/logout").status_code == 200
        assert c2.get("/api/me").status_code == 401, "после выхода cookie должна перестать работать"
        c2.close()

    print("✅ Все проверки прошли")


def test_full_flow():
    with Server() as srv:
        asyncio.run(scenario(srv.http, srv.ws))


if __name__ == "__main__":
    test_full_flow()
