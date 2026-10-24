# ============================================
# СВАПТАЙМ — BACKEND (v6 — ПОЛНЫЙ)
# ============================================
import sqlite3
import hashlib
import secrets
import json
from pathlib import Path
from datetime import datetime
from typing import Dict, Set

from fastapi import FastAPI, WebSocket, WebSocketDisconnect, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from fastapi.staticfiles import StaticFiles
from fastapi.responses import FileResponse
from pydantic import BaseModel

# ============================================
# БАЗА ДАННЫХ
# ============================================
DB_PATH = Path(__file__).parent.parent / "data" / "swaptime.db"
DB_PATH.parent.mkdir(exist_ok=True)


def init_db():
    """Создаёт таблицы."""
    conn = sqlite3.connect(DB_PATH)
    c = conn.cursor()

    c.execute("""
        CREATE TABLE IF NOT EXISTS users (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            username TEXT UNIQUE NOT NULL,
            email TEXT,
            password_hash TEXT NOT NULL,
            display_name TEXT,
            avatar_color TEXT DEFAULT '#e53935',
            font_family TEXT DEFAULT 'Inter, sans-serif',
            created_at INTEGER NOT NULL
        )
    """)

    c.execute("""
        CREATE TABLE IF NOT EXISTS messages (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            from_user TEXT NOT NULL,
            to_user TEXT NOT NULL,
            text TEXT NOT NULL,
            reply_to INTEGER DEFAULT 0,
            edited INTEGER DEFAULT 0,
            deleted INTEGER DEFAULT 0,
            created_at INTEGER NOT NULL
        )
    """)

    c.execute("""
        CREATE TABLE IF NOT EXISTS sessions (
            token TEXT PRIMARY KEY,
            username TEXT NOT NULL,
            created_at INTEGER NOT NULL
        )
    """)

    c.execute("""
        CREATE TABLE IF NOT EXISTS friends (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            user1 TEXT NOT NULL,
            user2 TEXT NOT NULL,
            status TEXT DEFAULT 'pending',
            from_user TEXT NOT NULL,
            created_at INTEGER NOT NULL,
            UNIQUE(user1, user2)
        )
    """)

    c.execute("""
        CREATE TABLE IF NOT EXISTS read_status (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            username TEXT NOT NULL,
            chat_with TEXT NOT NULL,
            last_read_id INTEGER DEFAULT 0,
            UNIQUE(username, chat_with)
        )
    """)

    c.execute("""
        CREATE TABLE IF NOT EXISTS blocks (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            blocker TEXT NOT NULL,
            blocked TEXT NOT NULL,
            created_at INTEGER NOT NULL,
            UNIQUE(blocker, blocked)
        )
    """)

    c.execute("""
        CREATE TABLE IF NOT EXISTS ignores (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            ignorer TEXT NOT NULL,
            ignored TEXT NOT NULL,
            created_at INTEGER NOT NULL,
            UNIQUE(ignorer, ignored)
        )
    """)

    conn.commit()
    conn.close()
    print("✅ База данных готова")


init_db()


def hash_password(password: str) -> str:
    return hashlib.sha256(password.encode()).hexdigest()


def get_user(username: str):
    conn = sqlite3.connect(DB_PATH)
    c = conn.cursor()
    c.execute("SELECT id, username, display_name, avatar_color, font_family FROM users WHERE username = ?", (username,))
    row = c.fetchone()
    conn.close()
    if not row:
        return None
    return {
        "id": row[0],
        "username": row[1],
        "display_name": row[2],
        "avatar_color": row[3],
        "font_family": row[4],
    }


# ============================================
# FASTAPI
# ============================================
app = FastAPI(title="SwapTime API")

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)


# ============================================
# МОДЕЛИ
# ============================================
class RegisterData(BaseModel):
    username: str
    password: str
    display_name: str = ""
    email: str = ""


class LoginData(BaseModel):
    username: str
    password: str


class FriendRequest(BaseModel):
    from_user: str
    to_user: str


class UpdateProfile(BaseModel):
    username: str
    display_name: str
    avatar_color: str
    font_family: str


class MessageAction(BaseModel):
    message_id: int
    username: str
    new_text: str = ""


# ============================================
# API — РЕГИСТРАЦИЯ
# ============================================
@app.post("/api/register")
async def register(data: RegisterData):
    username = data.username.strip().lower()
    email = data.email.strip().lower()
    if len(username) < 3:
        raise HTTPException(400, "Ник — минимум 3 символа")
    if len(data.password) < 4:
        raise HTTPException(400, "Пароль — минимум 4 символа")
    if email and ("@" not in email or "." not in email):
        raise HTTPException(400, "Неверный email")

    conn = sqlite3.connect(DB_PATH)
    c = conn.cursor()

    c.execute("SELECT id FROM users WHERE username = ?", (username,))
    if c.fetchone():
        conn.close()
        raise HTTPException(400, "Ник занят")

    if email:
        c.execute("SELECT id FROM users WHERE email = ?", (email,))
        if c.fetchone():
            conn.close()
            raise HTTPException(400, "Email занят")

    c.execute(
        "INSERT INTO users (username, email, password_hash, display_name, created_at) VALUES (?, ?, ?, ?, ?)",
        (username, email, hash_password(data.password), data.display_name or username, int(datetime.now().timestamp()))
    )
    conn.commit()
    conn.close()

    token = secrets.token_urlsafe(32)
    conn = sqlite3.connect(DB_PATH)
    c = conn.cursor()
    c.execute("INSERT INTO sessions (token, username, created_at) VALUES (?, ?, ?)",
              (token, username, int(datetime.now().timestamp())))
    conn.commit()
    conn.close()

    return {"ok": True, "token": token, "user": get_user(username)}


# ============================================
# API — ЛОГИН
# ============================================
@app.post("/api/login")
async def login(data: LoginData):
    username = data.username.strip().lower()

    conn = sqlite3.connect(DB_PATH)
    c = conn.cursor()
    c.execute("SELECT password_hash FROM users WHERE username = ?", (username,))
    row = c.fetchone()
    conn.close()

    if not row:
        raise HTTPException(400, "Юзер не найден")
    if row[0] != hash_password(data.password):
        raise HTTPException(400, "Неверный пароль")

    token = secrets.token_urlsafe(32)
    conn = sqlite3.connect(DB_PATH)
    c = conn.cursor()
    c.execute("INSERT INTO sessions (token, username, created_at) VALUES (?, ?, ?)",
              (token, username, int(datetime.now().timestamp())))
    conn.commit()
    conn.close()

    return {"ok": True, "token": token, "user": get_user(username)}


# ============================================
# API — ОБНОВЛЕНИЕ ПРОФИЛЯ
# ============================================
@app.post("/api/update_profile")
async def update_profile(data: UpdateProfile):
    conn = sqlite3.connect(DB_PATH)
    c = conn.cursor()
    c.execute(
        "UPDATE users SET display_name = ?, avatar_color = ?, font_family = ? WHERE username = ?",
        (data.display_name, data.avatar_color, data.font_family, data.username)
    )
    conn.commit()
    conn.close()
    return {"ok": True, "user": get_user(data.username)}


# ============================================
# API — НАСТРОЙКИ (БЛОКИРОВКИ / ИГНОР)
# ============================================
@app.get("/api/settings/{username}")
async def get_settings(username: str):
    username = username.strip().lower()

    conn = sqlite3.connect(DB_PATH)
    c = conn.cursor()

    c.execute("SELECT blocked FROM blocks WHERE blocker = ?", (username,))
    blocked = [r[0] for r in c.fetchall()]

    c.execute("SELECT ignored FROM ignores WHERE ignorer = ?", (username,))
    ignored = [r[0] for r in c.fetchall()]

    conn.close()
    return {"blocked": blocked, "ignored": ignored}


# ============================================
# API — ИСТОРИЯ
# ============================================
@app.get("/api/messages/{user1}/{user2}")
async def get_messages(user1: str, user2: str):
    user1 = user1.strip().lower()
    user2 = user2.strip().lower()

    conn = sqlite3.connect(DB_PATH)
    c = conn.cursor()
    c.execute(
        """SELECT id, from_user, to_user, text, reply_to, edited, deleted, created_at
           FROM messages
           WHERE (from_user = ? AND to_user = ?) OR (from_user = ? AND to_user = ?)
           ORDER BY created_at ASC
           LIMIT 100""",
        (user1, user2, user2, user1)
    )
    rows = c.fetchall()
    conn.close()

    return [
        {
            "id": r[0],
            "from": r[1],
            "to": r[2],
            "text": r[3],
            "reply_to": r[4],
            "edited": r[5],
            "deleted": r[6],
            "time": datetime.fromtimestamp(r[7]).strftime("%H:%M")
        }
        for r in rows
    ]


@app.post("/api/messages/delete")
async def delete_message(data: MessageAction):
    conn = sqlite3.connect(DB_PATH)
    c = conn.cursor()
    c.execute("UPDATE messages SET deleted = 1, text = 'Сообщение удалено' WHERE id = ? AND from_user = ?", (data.message_id, data.username))
    conn.commit()
    conn.close()
    return {"ok": True}


@app.post("/api/messages/edit")
async def edit_message(data: MessageAction):
    conn = sqlite3.connect(DB_PATH)
    c = conn.cursor()
    c.execute("UPDATE messages SET text = ?, edited = 1 WHERE id = ? AND from_user = ?", (data.new_text, data.message_id, data.username))
    conn.commit()
    conn.close()
    return {"ok": True}


# ============================================
# API — НЕПРОЧИТАННЫЕ
# ============================================
@app.get("/api/unread/{username}")
async def get_unread(username: str):
    username = username.strip().lower()

    conn = sqlite3.connect(DB_PATH)
    c = conn.cursor()

    c.execute("SELECT chat_with, last_read_id FROM read_status WHERE username = ?", (username,))
    read_map = dict(c.fetchall())

    c.execute("SELECT from_user, COUNT(*) FROM messages WHERE to_user = ? AND deleted = 0 GROUP BY from_user", (username,))
    rows = c.fetchall()

    unread = {}
    for from_user, total in rows:
        last_read = read_map.get(from_user, 0)
        c.execute("SELECT COUNT(*) FROM messages WHERE from_user = ? AND to_user = ? AND id > ? AND deleted = 0",
                  (from_user, username, last_read))
        count = c.fetchone()[0]
        if count > 0:
            unread[from_user] = count

    conn.close()
    return {"unread": unread}


@app.post("/api/mark_read")
async def mark_read(payload: FriendRequest):
    username = payload.from_user.strip().lower()
    chat_with = payload.to_user.strip().lower()

    conn = sqlite3.connect(DB_PATH)
    c = conn.cursor()

    c.execute("SELECT MAX(id) FROM messages WHERE from_user = ? AND to_user = ?", (chat_with, username))
    last_id = c.fetchone()[0] or 0

    c.execute(
        """INSERT INTO read_status (username, chat_with, last_read_id)
           VALUES (?, ?, ?)
           ON CONFLICT(username, chat_with) DO UPDATE SET last_read_id = ?""",
        (username, chat_with, last_id, last_id)
    )

    conn.commit()
    conn.close()
    return {"ok": True}


# ============================================
# API — ДРУЗЬЯ
# ============================================
@app.post("/api/friends/request")
async def send_friend_request(data: FriendRequest):
    user1 = data.from_user.strip().lower()
    user2 = data.to_user.strip().lower()

    if user1 == user2:
        raise HTTPException(400, "Нельзя добавить себя")

    conn = sqlite3.connect(DB_PATH)
    c = conn.cursor()

    c.execute("SELECT id FROM users WHERE username = ?", (user2,))
    if not c.fetchone():
        conn.close()
        raise HTTPException(400, "Юзер не найден")

    c.execute(
        "SELECT id, status FROM friends WHERE (user1 = ? AND user2 = ?) OR (user1 = ? AND user2 = ?)",
        (user1, user2, user2, user1)
    )
    existing = c.fetchone()
    if existing:
        conn.close()
        raise HTTPException(400, "Вы уже друзья" if existing[1] == "accepted" else "Запрос уже отправлен")

    c.execute(
        "INSERT INTO friends (user1, user2, status, from_user, created_at) VALUES (?, ?, ?, ?, ?)",
        (user1, user2, "pending", user1, int(datetime.now().timestamp()))
    )
    conn.commit()
    conn.close()
    return {"ok": True, "message": "Запрос отправлен"}


@app.post("/api/friends/accept")
async def accept_friend(data: FriendRequest):
    user1 = data.from_user.strip().lower()
    user2 = data.to_user.strip().lower()

    conn = sqlite3.connect(DB_PATH)
    c = conn.cursor()
    c.execute(
        "UPDATE friends SET status = 'accepted' WHERE user1 = ? AND user2 = ? AND status = 'pending'",
        (user2, user1)
    )
    conn.commit()
    conn.close()
    return {"ok": True, "message": "Друг добавлен"}


@app.post("/api/friends/decline")
async def decline_friend(data: FriendRequest):
    user1 = data.from_user.strip().lower()
    user2 = data.to_user.strip().lower()

    conn = sqlite3.connect(DB_PATH)
    c = conn.cursor()
    c.execute("DELETE FROM friends WHERE user1 = ? AND user2 = ? AND status = 'pending'", (user2, user1))
    conn.commit()
    conn.close()
    return {"ok": True, "message": "Отклонён"}


@app.post("/api/friends/remove")
async def remove_friend(data: FriendRequest):
    user1 = data.from_user.strip().lower()
    user2 = data.to_user.strip().lower()

    conn = sqlite3.connect(DB_PATH)
    c = conn.cursor()
    c.execute(
        "DELETE FROM friends WHERE (user1 = ? AND user2 = ?) OR (user1 = ? AND user2 = ?)",
        (user1, user2, user2, user1)
    )
    conn.commit()
    conn.close()
    return {"ok": True, "message": "Удалён из друзей"}


@app.post("/api/friends/block")
async def block_user(data: FriendRequest):
    blocker = data.from_user.strip().lower()
    blocked = data.to_user.strip().lower()

    conn = sqlite3.connect(DB_PATH)
    c = conn.cursor()

    c.execute(
        "DELETE FROM friends WHERE (user1 = ? AND user2 = ?) OR (user1 = ? AND user2 = ?)",
        (blocker, blocked, blocked, blocker)
    )

    try:
        c.execute(
            "INSERT INTO blocks (blocker, blocked, created_at) VALUES (?, ?, ?)",
            (blocker, blocked, int(datetime.now().timestamp()))
        )
    except sqlite3.IntegrityError:
        conn.close()
        raise HTTPException(400, "Уже заблокирован")

    conn.commit()
    conn.close()
    return {"ok": True, "message": "Заблокирован"}


@app.post("/api/friends/unblock")
async def unblock_user(data: FriendRequest):
    blocker = data.from_user.strip().lower()
    blocked = data.to_user.strip().lower()

    conn = sqlite3.connect(DB_PATH)
    c = conn.cursor()
    c.execute("DELETE FROM blocks WHERE blocker = ? AND blocked = ?", (blocker, blocked))
    conn.commit()
    conn.close()
    return {"ok": True, "message": "Разблокирован"}


@app.post("/api/friends/ignore")
async def ignore_user(data: FriendRequest):
    ignorer = data.from_user.strip().lower()
    ignored = data.to_user.strip().lower()

    conn = sqlite3.connect(DB_PATH)
    c = conn.cursor()

    try:
        c.execute(
            "INSERT INTO ignores (ignorer, ignored, created_at) VALUES (?, ?, ?)",
            (ignorer, ignored, int(datetime.now().timestamp()))
        )
    except sqlite3.IntegrityError:
        conn.close()
        raise HTTPException(400, "Уже игнорируется")

    conn.commit()
    conn.close()
    return {"ok": True, "message": "Игнорируется"}


@app.post("/api/friends/unignore")
async def unignore_user(data: FriendRequest):
    ignorer = data.from_user.strip().lower()
    ignored = data.to_user.strip().lower()

    conn = sqlite3.connect(DB_PATH)
    c = conn.cursor()
    c.execute("DELETE FROM ignores WHERE ignorer = ? AND ignored = ?", (ignorer, ignored))
    conn.commit()
    conn.close()
    return {"ok": True, "message": "Убран из игнора"}


@app.get("/api/friends/{username}")
async def get_friends(username: str):
    username = username.strip().lower()

    conn = sqlite3.connect(DB_PATH)
    c = conn.cursor()

    c.execute(
        "SELECT user1, user2 FROM friends WHERE (user1 = ? OR user2 = ?) AND status = 'accepted'",
        (username, username)
    )
    rows = c.fetchall()
    friends = []
    for u1, u2 in rows:
        friend = u2 if u1 == username else u1
        c.execute("SELECT username, display_name, avatar_color FROM users WHERE username = ?", (friend,))
        row = c.fetchone()
        if row:
            friends.append({"username": row[0], "display_name": row[1], "avatar_color": row[2]})

    c.execute("SELECT from_user FROM friends WHERE user2 = ? AND status = 'pending'", (username,))
    requests = [r[0] for r in c.fetchall()]

    conn.close()
    return {"friends": friends, "requests": requests}


# ============================================
# WEBSOCKET
# ============================================
active_connections: Dict[str, Set[WebSocket]] = {}


@app.websocket("/ws/{username}")
async def websocket_chat(websocket: WebSocket, username: str):
    await websocket.accept()

    if username not in active_connections:
        active_connections[username] = set()
    active_connections[username].add(websocket)

    print(f"🟢 {username} подключён (всего: {len(active_connections)})")

    try:
        while True:
            data = await websocket.receive_text()
            try:
                msg = json.loads(data)
            except:
                continue

            msg_type = msg.get("type")

            if msg_type == "message":
                to_user = msg.get("to", "").strip().lower()
                text = msg.get("text", "").strip()
                reply_to = msg.get("reply_to", 0)

                if not to_user or not text:
                    continue

                conn = sqlite3.connect(DB_PATH)
                c = conn.cursor()

                # Проверяем блокировку
                c.execute(
                    "SELECT id FROM blocks WHERE (blocker = ? AND blocked = ?) OR (blocker = ? AND blocked = ?)",
                    (to_user, username, username, to_user)
                )
                if c.fetchone():
                    conn.close()
                    continue

                # Проверяем игнор
                c.execute("SELECT id FROM ignores WHERE ignorer = ? AND ignored = ?", (to_user, username))
                ignored = c.fetchone() is not None

                c.execute(
                    "INSERT INTO messages (from_user, to_user, text, reply_to, created_at) VALUES (?, ?, ?, ?, ?)",
                    (username, to_user, text, reply_to, int(datetime.now().timestamp()))
                )
                msg_id = c.lastrowid
                conn.commit()
                conn.close()

                payload = json.dumps({
                    "type": "message",
                    "id": msg_id,
                    "from": username,
                    "to": to_user,
                    "text": text,
                    "reply_to": reply_to,
                    "time": datetime.now().strftime("%H:%M"),
                })

                if not ignored and to_user in active_connections:
                    for ws in active_connections[to_user]:
                        try:
                            await ws.send_text(payload)
                        except:
                            pass

                for ws in active_connections.get(username, []):
                    try:
                        await ws.send_text(payload)
                    except:
                        pass

            elif msg_type == "delete_msg":
                mid = msg.get("id")
                conn = sqlite3.connect(DB_PATH)
                c = conn.cursor()
                c.execute("UPDATE messages SET deleted = 1, text = 'Сообщение удалено' WHERE id = ? AND from_user = ?", (mid, username))
                conn.commit()
                conn.close()

                payload = json.dumps({"type": "update_msg", "id": mid, "text": "Сообщение удалено", "deleted": 1})
                for ws in active_connections.get(username, []):
                    try:
                        await ws.send_text(payload)
                    except:
                        pass

            elif msg_type == "edit_msg":
                mid = msg.get("id")
                new_text = msg.get("text")
                conn = sqlite3.connect(DB_PATH)
                c = conn.cursor()
                c.execute("UPDATE messages SET text = ?, edited = 1 WHERE id = ? AND from_user = ?", (new_text, mid, username))
                conn.commit()
                conn.close()

                payload = json.dumps({"type": "update_msg", "id": mid, "text": new_text, "edited": 1})
                for ws in active_connections.get(username, []):
                    try:
                        await ws.send_text(payload)
                    except:
                        pass

            elif msg_type == "ping":
                await websocket.send_text(json.dumps({"type": "pong"}))

    except WebSocketDisconnect:
        active_connections[username].discard(websocket)
        if not active_connections[username]:
            del active_connections[username]
        print(f"🔴 {username} отключён")


# ============================================
# СТАТИКА
# ============================================
FRONTEND_PATH = Path(__file__).parent.parent / "frontend"


@app.get("/")
async def root():
    return FileResponse(FRONTEND_PATH / "index.html")


@app.get("/style.css")
async def css():
    return FileResponse(FRONTEND_PATH / "style.css")


@app.get("/script.js")
async def js():
    return FileResponse(FRONTEND_PATH / "script.js")


if FRONTEND_PATH.exists():
    app.mount("/static", StaticFiles(directory=FRONTEND_PATH), name="static")


# ============================================
# ЗАПУСК
# ============================================
if __name__ == "__main__":
    import uvicorn
    print("🚀 СвапТайм запускается...")
    print("📍 Открой: http://localhost:8000")
    uvicorn.run(
        app,
        host="0.0.0.0",
        port=8000,
        ws_ping_interval=20,
        ws_ping_timeout=20,
        timeout_graceful_shutdown=2,
    )