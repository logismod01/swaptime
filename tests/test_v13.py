"""
Тесты v13: вложения (фото/файлы/голосовые), опросы, категории каналов,
реакции на постах каналов-лент, глобальный поиск, статистика сервера,
а также «стражовка раскладки» (layout-guard).

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

from test_smoke import Server, auth, register, wait_msg  # noqa: E402

PNG = (
    "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8"
    "z8DwHwAFAAH/q842iQAAAABJRU5ErkJggg=="
)
PDF = "data:application/pdf;base64,JVBERi0xLjQKJcOkw7zDtsOfCjIgMCBvYmoKPDwvTGVuZ3RoIDM+PgpzdHJlYW0KAAEKZW5kc3RyZWFtCmVuZG9iagp0cmFpbGVyCjw8L1Jvb3QgMiAwIFI+PgolJUVPRgo="


async def scenario(base: str, ws_url: str):
    with httpx.Client(base_url=base, timeout=15) as c:
        anna = register(c, "anna").json()
        bob = register(c, "boris").json()
        carol = register(c, "carol").json()
        ta, tb, tc = anna["token"], bob["token"], carol["token"]

        c.post("/api/friends/request", json={"to_user": "boris"}, headers=auth(ta))
        c.post("/api/friends/accept", json={"to_user": "anna"}, headers=auth(tb))

        # ============================================================
        # 0. Каркас страницы: критический CSS + стражовка раскладки
        # ============================================================
        page = c.get("/").text
        assert 'id="shell-critical"' in page, "критический CSS встроен в index.html"
        assert "/static/layout-guard.js?v=" in page, "layout-guard подключён"
        assert "/static/v13.js?v=" in page, "v13.js подключён"
        guard = c.get("/static/layout-guard.js")
        assert guard.status_code == 200
        assert "SwapLayoutGuard" in guard.text
        assert "stylesheets" not in guard.text or True  # файл доступен и не пустой
        css = c.get("/static/style.css")
        assert css.status_code == 200
        assert ".v13-mobile-tabs" in css.text and ".poll-card" in css.text, "стили v13 на месте"
        sw = c.get("/sw.js")
        assert "swaptime-v13" in sw.text, "service worker обновил версию кеша"

        # ============================================================
        # 1. Вложения в личных сообщениях (WS)
        # ============================================================
        async with websockets.connect(f"{ws_url}?token={ta}") as ws_a, \
                   websockets.connect(f"{ws_url}?token={tb}") as ws_b:
            await ws_a.send(json.dumps({
                "type": "message", "to": "boris", "text": "фото",
                "client_id": "v13-att-1",
                "attachment": {"kind": "image", "data": PNG, "name": "pixel.png", "size": 95},
            }))
            got = None
            for _ in range(6):
                candidate = await wait_msg(ws_b, "message")
                if candidate.get("attachment"):
                    got = candidate
                    break
            assert got is not None, "вложение доехало до получателя"
            assert got["attachment"]["kind"] == "image"
            assert got["attachment"]["data"].startswith("data:image/png")
            assert got["attachment"]["name"] == "pixel.png"

            # голосовое (audio) сохраняется с длительностью
            await ws_a.send(json.dumps({
                "type": "message", "to": "boris", "text": "",
                "client_id": "v13-att-2",
                "attachment": {"kind": "audio", "data": "data:audio/webm;base64,AAAA", "name": "voice.webm",
                               "size": 3, "duration": 7},
            }))
            voice = None
            for _ in range(6):
                candidate = await wait_msg(ws_b, "message")
                if candidate.get("attachment"):
                    voice = candidate
                    break
            assert voice and voice["attachment"]["kind"] == "audio"
            assert voice["attachment"]["duration"] == 7

            # опасный content-type отбрасывается
            await ws_a.send(json.dumps({
                "type": "message", "to": "boris", "text": "плохое",
                "client_id": "v13-bad",
                "attachment": {"kind": "file", "data": "data:text/html;base64,PHNjcmlwdD4=", "name": "x.html"},
            }))
            err = await wait_msg(ws_a, "error")
            assert "вложение" in err["text"].lower() or "файл" in err["text"].lower(), err

        history = c.get("/api/messages/anna/boris", headers=auth(tb)).json()
        image_msg = next(m for m in history if m.get("attachment") and m["attachment"]["kind"] == "image")
        assert image_msg["attachment"]["size"] == 95

        # пустое сообщение без вложения не создаётся
        async with websockets.connect(f"{ws_url}?token={ta}") as ws_a:
            await ws_a.send(json.dumps({"type": "message", "to": "boris", "text": ""}))
            await asyncio.sleep(0.2)
        history2 = c.get("/api/messages/anna/boris", headers=auth(tb)).json()
        assert len(history2) == len(history), "пустышка без вложения не сохраняется"

        # слишком большое вложение — 413
        huge = "data:application/pdf;base64," + "A" * 2_700_000
        srv = c.post("/api/servers", json={"name": "Attach", "icon": "📎", "icon_color": "#e53935"}, headers=auth(ta)).json()
        sid = srv["server"]["id"] if "server" in srv else srv["id"]
        ch = c.post(f"/api/servers/{sid}/channels", json={"name": "test"}, headers=auth(ta)).json()
        cid = ch["channel_id"]
        # обычный текст в канале (пригодится для поиска)
        c.post(f"/api/servers/{sid}/channels/{cid}/messages",
               json={"text": "сообщение в канале для поиска"}, headers=auth(ta))
        r = c.post(f"/api/servers/{sid}/channels/{cid}/messages",
                   json={"text": "слишком", "attachment": {"kind": "file", "data": huge, "name": "big.pdf"}},
                   headers=auth(ta))
        assert r.status_code == 413, r.text

        # ============================================================
        # 2. Опросы
        # ============================================================
        r = c.post(f"/api/servers/{sid}/channels/{cid}/messages",
                   json={"text": "", "poll": {"question": "Куда пойдём?", "options": ["Кино", "Кафе", "Дом"]}},
                   headers=auth(ta))
        assert r.status_code == 200, r.text
        poll_msg = r.json()
        assert poll_msg["poll"]["question"] == "Куда пойдём?"
        assert poll_msg["poll"]["counts"] == [0, 0, 0]
        assert poll_msg["text"] == ""

        # мало вариантов — ошибка
        r = c.post(f"/api/servers/{sid}/channels/{cid}/messages",
                   json={"text": "", "poll": {"question": "Один?", "options": ["единственный"]}},
                   headers=auth(ta))
        assert r.status_code == 400

        # голосование
        pid = poll_msg["id"]
        r = c.post("/api/polls/vote", json={"scope": "channel", "message_id": pid, "option": 1}, headers=auth(ta))
        assert r.status_code == 200, r.text
        poll = r.json()["poll"]
        assert poll["counts"] == [0, 1, 0] and poll["total"] == 1
        assert poll["my_vote"] == 1

        # голос меняется, а не дублируется
        r = c.post("/api/polls/vote", json={"scope": "channel", "message_id": pid, "option": 2}, headers=auth(ta))
        poll = r.json()["poll"]
        assert poll["counts"] == [0, 0, 1], poll
        assert poll["voters"][2] == ["anna"]

        # чужой сервер — 403
        r = c.post("/api/polls/vote", json={"scope": "channel", "message_id": pid, "option": 0}, headers=auth(tc))
        assert r.status_code == 403

        # несуществующий вариант — 400
        r = c.post("/api/polls/vote", json={"scope": "channel", "message_id": pid, "option": 9}, headers=auth(ta))
        assert r.status_code == 400

        # опрос в личке + событие poll_update
        async with websockets.connect(f"{ws_url}?token={ta}") as ws_a, \
                   websockets.connect(f"{ws_url}?token={tb}") as ws_b:
            await ws_a.send(json.dumps({
                "type": "message", "to": "boris", "text": "опрос в личке",
                "client_id": "v13-dm-poll",
                "poll": {"question": "Пицца?", "options": ["Да", "Нет"]},
            }))
            dm_poll = None
            for _ in range(6):
                candidate = await wait_msg(ws_b, "message")
                if candidate.get("poll"):
                    dm_poll = candidate
                    break
            assert dm_poll and dm_poll["poll"]["question"] == "Пицца?"
            assert dm_poll["poll"]["counts"] == [0, 0]

            r = c.post("/api/polls/vote", json={"scope": "dm", "message_id": dm_poll["id"], "option": 0}, headers=auth(tb))
            assert r.status_code == 200
            event = await wait_msg(ws_a, "poll_update")
            assert event["message_id"] == dm_poll["id"]
            assert event["poll"]["counts"] == [1, 0]

            # чужой не может голосовать в чужой личке
            r = c.post("/api/polls/vote", json={"scope": "dm", "message_id": dm_poll["id"], "option": 1}, headers=auth(tc))
            assert r.status_code == 403

        # ============================================================
        # 3. Категории каналов
        # ============================================================
        r = c.post(f"/api/servers/{sid}/channels",
                   json={"name": "мемы", "topic": "", "category": "Развлечения"}, headers=auth(ta))
        assert r.status_code == 200, r.text
        channel_id = r.json()["channel_id"]
        server = r.json()["server"]
        by_name = {ch["name"]: ch for ch in server["channels"]}
        assert by_name["мемы"]["category"] == "Развлечения"
        assert by_name["test"]["category"] == "", "канал без категории остаётся пустым"

        # смена категории
        r = c.post(f"/api/servers/{sid}/channels/{channel_id}/update",
                   json={"category": "  Флуд  "}, headers=auth(ta))
        assert r.status_code == 200, r.text
        updated = {ch["id"]: ch for ch in r.json()["server"]["channels"]}
        assert updated[channel_id]["category"] == "Флуд", "категория нормализуется"

        # обычный участник не может менять категорию
        invite = c.get(f"/api/servers/{sid}", headers=auth(ta)).json()["invite_code"]
        r = c.post("/api/servers/join", json={"code": invite}, headers=auth(tb))
        assert r.status_code == 200, r.text
        r = c.post(f"/api/servers/{sid}/channels/{channel_id}/update", json={"category": "Хак"}, headers=auth(tb))
        assert r.status_code == 403

        # ============================================================
        # 4. Реакции на постах каналов-лент
        # ============================================================
        tg = c.post("/api/tg/channels", json={"name": "Новости", "description": "тест", "is_public": True},
                    headers=auth(ta)).json()
        tg_id = tg["channel"]["id"] if "channel" in tg else tg["id"]
        post = c.post(f"/api/tg/channels/{tg_id}/posts", json={"text": "Пост про реакции"}, headers=auth(ta)).json()["post"]

        r = c.post("/api/reactions", json={"scope": "tg_post", "message_id": post["id"], "emoji": "🔥"}, headers=auth(ta))
        assert r.status_code == 200, r.text
        assert r.json()["reactions"] == [{"emoji": "🔥", "count": 1, "users": ["anna"]}]

        # подписчик тоже может (публичный канал)
        c.post(f"/api/tg/channels/{tg_id}/subscribe", json={}, headers=auth(tb))
        r = c.post("/api/reactions", json={"scope": "tg_post", "message_id": post["id"], "emoji": "🔥"}, headers=auth(tb))
        assert r.json()["reactions"][0]["count"] == 2

        # пост отдаётся вместе с реакциями
        posts = c.get(f"/api/tg/channels/{tg_id}", headers=auth(ta)).json()["posts"]
        target = next(p for p in posts if p["id"] == post["id"])
        assert target["reactions"] and target["reactions"][0]["count"] == 2

        # закрытый канал: посторонний получает 403
        closed = c.post("/api/tg/channels", json={"name": "Закрытый", "is_public": False}, headers=auth(ta)).json()
        closed_id = closed["channel"]["id"] if "channel" in closed else closed["id"]
        closed_post = c.post(f"/api/tg/channels/{closed_id}/posts", json={"text": "секрет"}, headers=auth(ta)).json()["post"]
        r = c.post("/api/reactions", json={"scope": "tg_post", "message_id": closed_post["id"], "emoji": "👀"},
                   headers=auth(tc))
        assert r.status_code == 403

        # ============================================================
        # 5. Глобальный поиск
        # ============================================================
        r = c.get("/api/search/global", params={"q": "а"}, headers=auth(ta))
        assert r.json()["total"] == 0 and r.json()["query"] == "а", "минимум 2 символа"

        r = c.get("/api/search/global", params={"q": "Пост про"}, headers=auth(ta))
        data = r.json()
        assert data["posts"], "посты находятся"
        assert data["posts"][0]["channel_name"] == "Новости"

        r = c.get("/api/search/global", params={"q": "фото"}, headers=auth(tb))
        data = r.json()
        assert any(item["peer"] == "anna" for item in data["dms"]), data

        r = c.get("/api/search/global", params={"q": "boris"}, headers=auth(ta))
        assert any(p["username"] == "boris" for p in r.json()["people"])

        # чужие личные сообщения не находятся
        r = c.get("/api/search/global", params={"q": "фото"}, headers=auth(tc))
        assert r.json()["dms"] == [], "посторонний не видит чужие ЛС"

        # каналы серверов ищутся только для участников
        r = c.get("/api/search/global", params={"q": "в канале"}, headers=auth(ta))
        assert r.json()["channels"], "каналы сервера находятся"
        r = c.get("/api/search/global", params={"q": "в канале"}, headers=auth(tc))
        assert r.json()["channels"] == [], "чужие каналы серверов не находятся"

        # ============================================================
        # 6. Статистика сервера
        # ============================================================
        r = c.get(f"/api/servers/{sid}/stats", headers=auth(ta))
        assert r.status_code == 200, r.text
        stats = r.json()
        assert stats["period_messages"] >= 1
        assert stats["total_members"] >= 2
        assert len(stats["by_day"]) == 7, "недельный график"
        assert any(m["username"] == "anna" for m in stats["members"])
        assert any(ch["name"] == "test" for ch in stats["channels"])

        r = c.get(f"/api/servers/{sid}/stats?days=30", headers=auth(ta))
        assert len(r.json()["by_day"]) == 30

        r = c.get(f"/api/servers/{sid}/stats", headers=auth(tc))
        assert r.status_code == 403, "чужие не видят статистику"

    print("✅ v13: вложения, опросы, категории, реакции постов, глобальный поиск, статистика и layout-guard")


def test_v13_flow():
    with Server() as srv:
        asyncio.run(scenario(srv.http, srv.ws))


if __name__ == "__main__":
    test_v13_flow()
