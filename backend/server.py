# ============================================
# СВАПТАЙМ — BACKEND (v7)
# ============================================
# Что изменилось по сравнению с v6:
#   • токены реально проверяются (раньше можно было менять чужой профиль)
#   • пароли: PBKDF2-SHA256 + соль (старые SHA-256 хеши поддерживаются
#     и автоматически обновляются при входе)
#   • сообщения: client_id (устраняет дубли), reply-превью, время в epoch
#   • редактирование/удаление доходит до СОБЕСЕДНИКА (раньше — только себе)
#   • непрочитанные считаются одним запросом и сбрасываются корректно
#   • онлайн-статус и «печатает…»
#   • внятные ошибки вместо молчаливого `continue`
#   • последние 200 сообщений, а не первые 100
# ============================================
import os
import re
import json
import time
import sqlite3
import hashlib
import secrets
from pathlib import Path
from typing import Dict, Optional, Set

from fastapi import (
    FastAPI,
    WebSocket,
    WebSocketDisconnect,
    HTTPException,
    Header,
    Query,
    Depends,
)
from fastapi.middleware.cors import CORSMiddleware
from fastapi.staticfiles import StaticFiles
from fastapi.responses import FileResponse
from pydantic import BaseModel

BASE_DIR = Path(__file__).resolve().parent.parent
DB_PATH = Path(os.environ.get("SWAPTIME_DB", BASE_DIR / "data" / "swaptime.db"))
DB_PATH.parent.mkdir(parents=True, exist_ok=True)

MAX_MESSAGE_LEN = 4000
HISTORY_LIMIT = 200
USERNAME_RE = re.compile(r"^[a-z0-9_]{3,20}$")
COLOR_RE = re.compile(r"^#[0-9a-fA-F]{6}$")
FONT_RE = re.compile(r"^[A-Za-z0-9 ,'\-]{1,80}$")

FONTS = [
    "Inter, sans-serif",
    "Roboto, sans-serif",
    "Montserrat, sans-serif",
    "Open Sans, sans-serif",
    "Lato, sans-serif",
    "Poppins, sans-serif",
    "Raleway, sans-serif",
    "Nunito, sans-serif",
    "Merriweather, serif",
    "JetBrains Mono, monospace",
]


# ============================================
# БАЗА ДАННЫХ
# ============================================
def db_connect() -> sqlite3.Connection:
    conn = sqlite3.connect(DB_PATH, timeout=15)
    conn.row_factory = sqlite3.Row
    return conn


def _add_column(c: sqlite3.Cursor, table: str, column: str, decl: str) -> None:
    """Добавляет колонку, если её нет (мягкая миграция старой базы)."""
    cols = [r[1] for r in c.execute(f"PRAGMA table_info({table})").fetchall()]
    if column not in cols:
        c.execute(f"ALTER TABLE {table} ADD COLUMN {column} {decl}")


def init_db() -> None:
    conn = db_connect()
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
            last_seen INTEGER DEFAULT 0,
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
            client_id TEXT,
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

    # мягкие миграции старых баз
    _add_column(c, "users", "last_seen", "INTEGER DEFAULT 0")
    _add_column(c, "messages", "client_id", "TEXT")

    c.execute("CREATE INDEX IF NOT EXISTS idx_msg_pair ON messages(from_user, to_user, id)")
    c.execute("CREATE INDEX IF NOT EXISTS idx_msg_to ON messages(to_user, id)")
    c.execute("CREATE INDEX IF NOT EXISTS idx_msg_client ON messages(client_id)")
    c.execute("CREATE INDEX IF NOT EXISTS idx_friends_user ON friends(user1, user2, status)")

    conn.commit()
    conn.close()
    print("✅ База данных готова")


init_db()


# ============================================
# ПАРОЛИ
# ============================================
PBKDF2_ITERATIONS = 120_000


def hash_password(password: str) -> str:
    salt = secrets.token_hex(16)
    dk = hashlib.pbkdf2_hmac("sha256", password.encode(), salt.encode(), PBKDF2_ITERATIONS)
    return f"pbkdf2_sha256${PBKDF2_ITERATIONS}${salt}${dk.hex()}"


def verify_password(password: str, stored: str) -> bool:
    """Поддерживает новый формат и старые sha256-хеши."""
    try:
        if stored.startswith("pbkdf2_sha256$"):
            _, iterations, salt, digest = stored.split("$", 3)
            dk = hashlib.pbkdf2_hmac("sha256", password.encode(), salt.encode(), int(iterations))
            return secrets.compare_digest(dk.hex(), digest)
        return secrets.compare_digest(hashlib.sha256(password.encode()).hexdigest(), stored)
    except (ValueError, TypeError):
        return False


def is_legacy_hash(stored: str) -> bool:
    return not stored.startswith("pbkdf2_sha256$")


def normalize_font(font: str) -> str:
    """Приводит старые значения ('Roboto', sans-serif) к нашему списку."""
    if font in FONTS:
        return font
    family = (font or "").split(",")[0].strip().strip("'\"")
    for candidate in FONTS:
        if candidate.split(",")[0].strip().lower() == family.lower():
            return candidate
    return FONTS[0]


# ============================================
# ПОЛЬЗОВАТЕЛИ / СЕССИИ
# ============================================
def get_user(username: str) -> Optional[dict]:
    conn = db_connect()
    row = conn.execute(
        "SELECT id, username, display_name, avatar_color, font_family, last_seen "
        "FROM users WHERE username = ?",
        (username,),
    ).fetchone()
    conn.close()
    if not row:
        return None
    return {
        "id": row["id"],
        "username": row["username"],
        "display_name": row["display_name"] or row["username"],
        "avatar_color": row["avatar_color"] or "#e53935",
        "font_family": normalize_font(row["font_family"] or FONTS[0]),
        "last_seen": row["last_seen"] or 0,
    }


def user_exists(username: str) -> bool:
    conn = db_connect()
    row = conn.execute("SELECT 1 FROM users WHERE username = ?", (username,)).fetchone()
    conn.close()
    return bool(row)


def create_session(username: str) -> str:
    token = secrets.token_urlsafe(32)
    conn = db_connect()
    conn.execute(
        "INSERT INTO sessions (token, username, created_at) VALUES (?, ?, ?)",
        (token, username, int(time.time())),
    )
    conn.commit()
    conn.close()
    return token


def session_username(token: str) -> Optional[str]:
    if not token:
        return None
    conn = db_connect()
    row = conn.execute("SELECT username FROM sessions WHERE token = ?", (token,)).fetchone()
    conn.close()
    return row["username"] if row else None


def auth_user(
    authorization: Optional[str] = Header(default=None),
    token: Optional[str] = Query(default=None),
) -> str:
    """FastAPI-зависимость: достаёт пользователя по Bearer-токену."""
    raw = token
    if authorization and authorization.lower().startswith("bearer "):
        raw = authorization[7:].strip()
    username = session_username(raw) if raw else None
    if not username:
        raise HTTPException(401, "Сессия истекла — войди заново")
    return username


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
    to_user: str
    from_user: Optional[str] = None  # игнорируется, оставлен для совместимости


class UpdateProfile(BaseModel):
    display_name: str = ""
    avatar_color: str = "#e53935"
    font_family: str = FONTS[0]


class MessageAction(BaseModel):
    message_id: int
    new_text: str = ""


class MarkRead(BaseModel):
    to_user: str
    from_user: Optional[str] = None  # игнорируется


# ============================================
# ДРУЗЬЯ / СВЯЗИ
# ============================================
def are_friends(a: str, b: str) -> bool:
    conn = db_connect()
    row = conn.execute(
        "SELECT 1 FROM friends WHERE status = 'accepted' AND "
        "((user1 = ? AND user2 = ?) OR (user1 = ? AND user2 = ?))",
        (a, b, b, a),
    ).fetchone()
    conn.close()
    return bool(row)


def friend_usernames(username: str) -> list:
    conn = db_connect()
    rows = conn.execute(
        "SELECT user1, user2 FROM friends WHERE status = 'accepted' AND (user1 = ? OR user2 = ?)",
        (username, username),
    ).fetchall()
    conn.close()
    return [r["user2"] if r["user1"] == username else r["user1"] for r in rows]


def is_blocked(a: str, b: str) -> bool:
    conn = db_connect()
    row = conn.execute(
        "SELECT 1 FROM blocks WHERE (blocker = ? AND blocked = ?) OR (blocker = ? AND blocked = ?)",
        (a, b, b, a),
    ).fetchone()
    conn.close()
    return bool(row)


def blocked_by(owner: str, other: str) -> bool:
    """Заблокировал ли `other` пользователя `owner`."""
    conn = db_connect()
    row = conn.execute(
        "SELECT 1 FROM blocks WHERE blocker = ? AND blocked = ?", (other, owner)
    ).fetchone()
    conn.close()
    return bool(row)


def is_ignored(owner: str, other: str) -> bool:
    conn = db_connect()
    row = conn.execute(
        "SELECT 1 FROM ignores WHERE ignorer = ? AND ignored = ?", (owner, other)
    ).fetchone()
    conn.close()
    return bool(row)


def block_list(username: str) -> list:
    conn = db_connect()
    rows = conn.execute(
        "SELECT blocked FROM blocks WHERE blocker = ? ORDER BY created_at DESC", (username,)
    ).fetchall()
    conn.close()
    return [r["blocked"] for r in rows]


def ignore_list(username: str) -> list:
    conn = db_connect()
    rows = conn.execute(
        "SELECT ignored FROM ignores WHERE ignorer = ? ORDER BY created_at DESC", (username,)
    ).fetchall()
    conn.close()
    return [r["ignored"] for r in rows]


def unread_map(username: str) -> Dict[str, int]:
    conn = db_connect()
    rows = conn.execute(
        """
        SELECT m.from_user AS u, COUNT(*) AS cnt
        FROM messages m
        LEFT JOIN read_status r ON r.username = ? AND r.chat_with = m.from_user
        WHERE m.to_user = ? AND m.deleted = 0 AND m.id > COALESCE(r.last_read_id, 0)
        GROUP BY m.from_user
        """,
        (username, username),
    ).fetchall()
    conn.close()
    return {r["u"]: r["cnt"] for r in rows}


def mark_read(username: str, chat_with: str) -> int:
    conn = db_connect()
    row = conn.execute(
        "SELECT MAX(id) AS m FROM messages WHERE from_user = ? AND to_user = ?",
        (chat_with, username),
    ).fetchone()
    last_id = row["m"] or 0
    conn.execute(
        """
        INSERT INTO read_status (username, chat_with, last_read_id)
        VALUES (?, ?, ?)
        ON CONFLICT(username, chat_with) DO UPDATE SET last_read_id =
            MAX(read_status.last_read_id, excluded.last_read_id)
        """,
        (username, chat_with, last_id),
    )
    conn.commit()
    conn.close()
    return last_id


# ============================================
# СЕРИАЛИЗАЦИЯ СООБЩЕНИЙ
# ============================================
MSG_COLUMNS = (
    "id, from_user, to_user, text, reply_to, edited, deleted, client_id, created_at"
)


def _replies_map(conn: sqlite3.Connection, ids) -> Dict[int, dict]:
    ids = [int(i) for i in ids if i]
    if not ids:
        return {}
    placeholders = ",".join("?" * len(ids))
    rows = conn.execute(
        f"SELECT id, from_user, text, deleted FROM messages WHERE id IN ({placeholders})",
        ids,
    ).fetchall()
    return {
        r["id"]: {
            "id": r["id"],
            "from": r["from_user"],
            "text": "" if r["deleted"] else (r["text"] or ""),
            "deleted": r["deleted"],
        }
        for r in rows
    }


def message_dict(row: sqlite3.Row, replies: Dict[int, dict]) -> dict:
    reply_to = row["reply_to"] or 0
    return {
        "id": row["id"],
        "client_id": row["client_id"],
        "from": row["from_user"],
        "to": row["to_user"],
        "text": "" if row["deleted"] else (row["text"] or ""),
        "reply_to": reply_to,
        "reply_preview": replies.get(reply_to) if reply_to else None,
        "edited": row["edited"],
        "deleted": row["deleted"],
        "created_at": row["created_at"],
    }


def fetch_message(conn: sqlite3.Connection, message_id: int) -> Optional[dict]:
    row = conn.execute(
        f"SELECT {MSG_COLUMNS} FROM messages WHERE id = ?", (message_id,)
    ).fetchone()
    if not row:
        return None
    return message_dict(row, _replies_map(conn, [row["reply_to"]]))


def messages_between(conn: sqlite3.Connection, me: str, other: str, limit: int) -> list:
    rows = conn.execute(
        f"""
        SELECT {MSG_COLUMNS} FROM messages
        WHERE (from_user = ? AND to_user = ?) OR (from_user = ? AND to_user = ?)
        ORDER BY id DESC LIMIT ?
        """,
        (me, other, other, me, limit),
    ).fetchall()
    rows = list(reversed(rows))
    replies = _replies_map(conn, [r["reply_to"] for r in rows])
    return [message_dict(r, replies) for r in rows]


# ============================================
# FASTAPI
# ============================================
app = FastAPI(title="SwapTime API")

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=False,
    allow_methods=["*"],
    allow_headers=["*"],
)

active_connections: Dict[str, Set[WebSocket]] = {}


# ============================================
# API — РЕГИСТРАЦИЯ / ВХОД
# ============================================
@app.post("/api/register")
async def register(data: RegisterData):
    username = data.username.strip().lower()
    email = (data.email or "").strip().lower()
    display_name = (data.display_name or "").strip()[:40]

    if not USERNAME_RE.match(username):
        raise HTTPException(400, "Ник: 3–20 символов, латиница/цифры/_")
    if len(data.password) < 4:
        raise HTTPException(400, "Пароль — минимум 4 символа")
    if len(data.password) > 128:
        raise HTTPException(400, "Пароль слишком длинный")
    if email and ("@" not in email or "." not in email.split("@")[-1]):
        raise HTTPException(400, "Неверный email")

    conn = db_connect()
    if conn.execute("SELECT 1 FROM users WHERE username = ?", (username,)).fetchone():
        conn.close()
        raise HTTPException(400, "Ник занят")
    if email and conn.execute("SELECT 1 FROM users WHERE email = ?", (email,)).fetchone():
        conn.close()
        raise HTTPException(400, "Email занят")

    conn.execute(
        "INSERT INTO users (username, email, password_hash, display_name, created_at) "
        "VALUES (?, ?, ?, ?, ?)",
        (username, email, hash_password(data.password), display_name or username, int(time.time())),
    )
    conn.commit()
    conn.close()

    token = create_session(username)
    return {"ok": True, "token": token, "user": get_user(username)}


@app.post("/api/login")
async def login(data: LoginData):
    username = data.username.strip().lower()

    conn = db_connect()
    row = conn.execute(
        "SELECT password_hash FROM users WHERE username = ?", (username,)
    ).fetchone()
    if not row or not verify_password(data.password, row["password_hash"]):
        conn.close()
        # одинаковый текст, чтобы не палить существование ника
        raise HTTPException(400, "Неверный ник или пароль")

    if is_legacy_hash(row["password_hash"]):
        conn.execute(
            "UPDATE users SET password_hash = ? WHERE username = ?",
            (hash_password(data.password), username),
        )
        conn.commit()
    conn.close()

    token = create_session(username)
    return {"ok": True, "token": token, "user": get_user(username)}


@app.post("/api/logout")
async def logout(authorization: Optional[str] = Header(default=None)):
    if authorization and authorization.lower().startswith("bearer "):
        token = authorization[7:].strip()
        conn = db_connect()
        conn.execute("DELETE FROM sessions WHERE token = ?", (token,))
        conn.commit()
        conn.close()
    return {"ok": True}


@app.get("/api/me")
async def me(user: str = Depends(auth_user)):
    data = get_user(user)
    if not data:
        raise HTTPException(401, "Юзер не найден")
    data["online"] = True
    return {"user": data, "fonts": FONTS}


@app.post("/api/update_profile")
async def update_profile(data: UpdateProfile, user: str = Depends(auth_user)):
    display_name = (data.display_name or "").strip()[:40] or user
    color = data.avatar_color if COLOR_RE.match(data.avatar_color or "") else "#e53935"
    font = normalize_font(data.font_family) if FONT_RE.match(data.font_family or "") else FONTS[0]

    conn = db_connect()
    conn.execute(
        "UPDATE users SET display_name = ?, avatar_color = ?, font_family = ? WHERE username = ?",
        (display_name, color, font, user),
    )
    conn.commit()
    conn.close()

    updated = get_user(user)
    await broadcast_to_friends(user, {"type": "profile_updated", "user": {
        "username": user,
        "display_name": updated["display_name"],
        "avatar_color": updated["avatar_color"],
    }})
    return {"ok": True, "user": updated}


# ============================================
# API — НАСТРОЙКИ
# ============================================
@app.get("/api/settings")
async def get_settings(user: str = Depends(auth_user)):
    return {
        "blocked": block_list(user),
        "ignored": ignore_list(user),
        "fonts": FONTS,
    }


# ============================================
# API — ИСТОРИЯ / НЕПРОЧИТАННЫЕ
# ============================================
def _can_chat(me: str, other: str) -> bool:
    if me == other or not user_exists(other):
        return False
    return are_friends(me, other)


@app.get("/api/messages/{user1}/{user2}")
async def get_messages(
    user1: str,
    user2: str,
    limit: int = Query(default=HISTORY_LIMIT, ge=1, le=500),
    me: str = Depends(auth_user),
):
    user1 = user1.strip().lower()
    user2 = user2.strip().lower()
    if me not in (user1, user2):
        raise HTTPException(403, "Это чужой чат")
    other = user2 if me == user1 else user1

    conn = db_connect()
    data = messages_between(conn, me, other, limit)
    conn.close()
    return data


@app.get("/api/unread")
async def get_unread(user: str = Depends(auth_user)):
    return {"unread": unread_map(user)}


@app.post("/api/mark_read")
async def mark_read_endpoint(data: MarkRead, user: str = Depends(auth_user)):
    other = data.to_user.strip().lower()
    last_id = mark_read(user, other)
    # синхронизируем бейджи в других вкладках этого же пользователя
    await send_to_user(user, {"type": "read_sync", "chat_with": other, "last_read_id": last_id})
    return {"ok": True, "last_read_id": last_id}


@app.get("/api/chats")
async def get_chats(user: str = Depends(auth_user)):
    """Список друзей + последнее сообщение + непрочитанные + онлайн."""
    unread = unread_map(user)
    friends = []

    conn = db_connect()
    for name in friend_usernames(user):
        info = get_user(name)
        if not info:
            continue
        last = conn.execute(
            f"""
            SELECT {MSG_COLUMNS} FROM messages
            WHERE (from_user = ? AND to_user = ?) OR (from_user = ? AND to_user = ?)
            ORDER BY id DESC LIMIT 1
            """,
            (user, name, name, user),
        ).fetchone()
        last_msg = None
        if last:
            last_msg = message_dict(last, _replies_map(conn, [last["reply_to"]]))
        friends.append({
            "username": name,
            "display_name": info["display_name"],
            "avatar_color": info["avatar_color"],
            "online": name in active_connections,
            "unread": unread.get(name, 0),
            "last_message": last_msg,
        })
    conn.close()

    def sort_key(item):
        lm = item["last_message"]
        return lm["created_at"] if lm else 0

    friends.sort(key=sort_key, reverse=True)
    return {"chats": friends, "unread": unread}


# ============================================
# API — РЕДАКТИРОВАНИЕ / УДАЛЕНИЕ (REST fallback)
# ============================================
@app.post("/api/messages/edit")
async def edit_message(data: MessageAction, user: str = Depends(auth_user)):
    text = (data.new_text or "").strip()
    if not text:
        raise HTTPException(400, "Пустое сообщение")

    conn = db_connect()
    row = conn.execute(
        "SELECT from_user, deleted FROM messages WHERE id = ?", (data.message_id,)
    ).fetchone()
    if not row:
        conn.close()
        raise HTTPException(404, "Сообщение не найдено")
    if row["from_user"] != user:
        conn.close()
        raise HTTPException(403, "Это не твоё сообщение")
    if row["deleted"]:
        conn.close()
        raise HTTPException(400, "Сообщение удалено")

    conn.execute(
        "UPDATE messages SET text = ?, edited = 1 WHERE id = ?", (text[:MAX_MESSAGE_LEN], data.message_id)
    )
    conn.commit()
    msg = fetch_message(conn, data.message_id)
    conn.close()

    await _broadcast_message_update(msg)
    return {"ok": True, "message": msg}


@app.post("/api/messages/delete")
async def delete_message(data: MessageAction, user: str = Depends(auth_user)):
    conn = db_connect()
    row = conn.execute(
        "SELECT from_user FROM messages WHERE id = ?", (data.message_id,)
    ).fetchone()
    if not row:
        conn.close()
        raise HTTPException(404, "Сообщение не найдено")
    if row["from_user"] != user:
        conn.close()
        raise HTTPException(403, "Это не твоё сообщение")

    conn.execute("UPDATE messages SET deleted = 1, text = '' WHERE id = ?", (data.message_id,))
    conn.commit()
    msg = fetch_message(conn, data.message_id)
    conn.close()

    await _broadcast_message_update(msg)
    return {"ok": True, "message": msg}


# ============================================
# API — ДРУЗЬЯ
# ============================================
def _friends_payload(user: str) -> dict:
    conn = db_connect()
    rows = conn.execute(
        "SELECT user1, user2 FROM friends WHERE status = 'accepted' AND (user1 = ? OR user2 = ?)",
        (user, user),
    ).fetchall()
    friends = []
    for r in rows:
        other = r["user2"] if r["user1"] == user else r["user1"]
        info = get_user(other)
        if info:
            friends.append({
                "username": other,
                "display_name": info["display_name"],
                "avatar_color": info["avatar_color"],
                "online": other in active_connections,
            })

    req_rows = conn.execute(
        "SELECT user1 FROM friends WHERE user2 = ? AND status = 'pending'", (user,)
    ).fetchall()
    incoming = []
    for r in req_rows:
        info = get_user(r["user1"])
        if info:
            incoming.append({
                "username": info["username"],
                "display_name": info["display_name"],
                "avatar_color": info["avatar_color"],
            })

    out_rows = conn.execute(
        "SELECT user2 FROM friends WHERE user1 = ? AND status = 'pending'", (user,)
    ).fetchall()
    outgoing = [r["user2"] for r in out_rows]
    conn.close()

    return {
        "friends": friends,
        "requests": incoming,
        "outgoing": outgoing,
        "blocked": block_list(user),
        "ignored": ignore_list(user),
    }


@app.get("/api/friends")
async def get_friends(user: str = Depends(auth_user)):
    return _friends_payload(user)


@app.get("/api/friends/{username}")
async def get_friends_legacy(username: str, user: str = Depends(auth_user)):
    """Старый адрес — оставлен для совместимости."""
    if username.strip().lower() != user:
        raise HTTPException(403, "Это чужой список")
    return _friends_payload(user)


@app.post("/api/friends/request")
async def send_friend_request(data: FriendRequest, user: str = Depends(auth_user)):
    target = data.to_user.strip().lower()

    if target == user:
        raise HTTPException(400, "Нельзя добавить себя")
    if not user_exists(target):
        raise HTTPException(400, "Юзер не найден")
    if is_blocked(user, target):
        raise HTTPException(400, "Пользователь недоступен")

    conn = db_connect()
    row = conn.execute(
        "SELECT id, status, from_user FROM friends WHERE (user1 = ? AND user2 = ?) OR (user1 = ? AND user2 = ?)",
        (user, target, target, user),
    ).fetchone()

    if row:
        if row["status"] == "accepted":
            conn.close()
            raise HTTPException(400, "Вы уже друзья")
        if row["from_user"] == user:
            conn.close()
            raise HTTPException(400, "Запрос уже отправлен")
        # встречный запрос — сразу дружим
        conn.execute("UPDATE friends SET status = 'accepted' WHERE id = ?", (row["id"],))
        conn.commit()
        conn.close()
        await _notify_friends_changed(user, target)
        return {"ok": True, "message": "Вы теперь друзья!", "accepted": True}

    conn.execute(
        "INSERT INTO friends (user1, user2, status, from_user, created_at) VALUES (?, ?, 'pending', ?, ?)",
        (user, target, user, int(time.time())),
    )
    conn.commit()
    conn.close()

    await send_to_user(target, {"type": "friend_request", "from": user})
    return {"ok": True, "message": "Запрос отправлен"}


@app.post("/api/friends/accept")
async def accept_friend(data: FriendRequest, user: str = Depends(auth_user)):
    # во фронте в поле to_user приходит ник того, КТО отправил заявку
    requester = data.to_user.strip().lower()
    conn = db_connect()
    cur = conn.execute(
        "UPDATE friends SET status = 'accepted' WHERE user1 = ? AND user2 = ? AND status = 'pending'",
        (requester, user),
    )
    conn.commit()
    changed = cur.rowcount
    conn.close()
    if not changed:
        raise HTTPException(404, "Запрос не найден")
    await _notify_friends_changed(user, requester)
    return {"ok": True, "message": "Друг добавлен"}


@app.post("/api/friends/decline")
async def decline_friend(data: FriendRequest, user: str = Depends(auth_user)):
    requester = data.to_user.strip().lower()
    conn = db_connect()
    conn.execute(
        "DELETE FROM friends WHERE user1 = ? AND user2 = ? AND status = 'pending'",
        (requester, user),
    )
    conn.commit()
    conn.close()
    await send_to_user(requester, {"type": "friend_changed"})
    return {"ok": True, "message": "Запрос отклонён"}


@app.post("/api/friends/remove")
async def remove_friend(data: FriendRequest, user: str = Depends(auth_user)):
    other = data.to_user.strip().lower()
    conn = db_connect()
    conn.execute(
        "DELETE FROM friends WHERE (user1 = ? AND user2 = ?) OR (user1 = ? AND user2 = ?)",
        (user, other, other, user),
    )
    conn.commit()
    conn.close()
    await _notify_friends_changed(user, other)
    return {"ok": True, "message": "Удалён из друзей"}


@app.post("/api/friends/block")
async def block_user(data: FriendRequest, user: str = Depends(auth_user)):
    other = data.to_user.strip().lower()
    if other == user:
        raise HTTPException(400, "Нельзя заблокировать себя")
    if not user_exists(other):
        raise HTTPException(404, "Юзер не найден")

    conn = db_connect()
    conn.execute(
        "DELETE FROM friends WHERE (user1 = ? AND user2 = ?) OR (user1 = ? AND user2 = ?)",
        (user, other, other, user),
    )
    try:
        conn.execute(
            "INSERT INTO blocks (blocker, blocked, created_at) VALUES (?, ?, ?)",
            (user, other, int(time.time())),
        )
    except sqlite3.IntegrityError:
        conn.close()
        raise HTTPException(400, "Уже заблокирован")
    conn.commit()
    conn.close()

    await _notify_friends_changed(user, other)
    return {"ok": True, "message": "Заблокирован"}


@app.post("/api/friends/unblock")
async def unblock_user(data: FriendRequest, user: str = Depends(auth_user)):
    other = data.to_user.strip().lower()
    conn = db_connect()
    conn.execute("DELETE FROM blocks WHERE blocker = ? AND blocked = ?", (user, other))
    conn.commit()
    conn.close()
    return {"ok": True, "message": "Разблокирован"}


@app.post("/api/friends/ignore")
async def ignore_user(data: FriendRequest, user: str = Depends(auth_user)):
    other = data.to_user.strip().lower()
    if other == user:
        raise HTTPException(400, "Нельзя игнорировать себя")
    if not user_exists(other):
        raise HTTPException(404, "Юзер не найден")

    conn = db_connect()
    try:
        conn.execute(
            "INSERT INTO ignores (ignorer, ignored, created_at) VALUES (?, ?, ?)",
            (user, other, int(time.time())),
        )
    except sqlite3.IntegrityError:
        conn.close()
        raise HTTPException(400, "Уже игнорируется")
    conn.commit()
    conn.close()
    return {"ok": True, "message": "Игнорируется"}


@app.post("/api/friends/unignore")
async def unignore_user(data: FriendRequest, user: str = Depends(auth_user)):
    other = data.to_user.strip().lower()
    conn = db_connect()
    conn.execute("DELETE FROM ignores WHERE ignorer = ? AND ignored = ?", (user, other))
    conn.commit()
    conn.close()
    return {"ok": True, "message": "Убран из игнора"}


# ============================================
# WEBSOCKET — ОТПРАВКА
# ============================================
async def send_to_user(username: str, payload: dict) -> None:
    text = json.dumps(payload, ensure_ascii=False)
    dead = []
    for ws in list(active_connections.get(username, ())):
        try:
            await ws.send_text(text)
        except Exception:
            dead.append(ws)
    for ws in dead:
        active_connections.get(username, set()).discard(ws)


async def broadcast_to_friends(username: str, payload: dict) -> None:
    for friend in friend_usernames(username):
        await send_to_user(friend, payload)


async def _broadcast_message_update(msg: Optional[dict]) -> None:
    if not msg:
        return
    payload = {"type": "message_updated", **msg}
    await send_to_user(msg["from"], payload)
    await send_to_user(msg["to"], payload)


async def _notify_friends_changed(a: str, b: str) -> None:
    await send_to_user(a, {"type": "friend_changed"})
    await send_to_user(b, {"type": "friend_changed"})


async def _broadcast_presence(username: str, online: bool) -> None:
    await broadcast_to_friends(
        username, {"type": "presence", "user": username, "online": online}
    )


# ============================================
# WEBSOCKET — ОБРАБОТКА
# ============================================
def _save_message(sender: str, to_user: str, text: str, client_id: Optional[str], reply_to: int):
    conn = db_connect()
    # ответ на сообщение должен существовать и относиться к этому же диалогу
    if reply_to:
        row = conn.execute(
            "SELECT 1 FROM messages WHERE id = ? AND "
            "((from_user = ? AND to_user = ?) OR (from_user = ? AND to_user = ?))",
            (reply_to, sender, to_user, to_user, sender),
        ).fetchone()
        if not row:
            reply_to = 0

    # защита от повторной отправки того же client_id (двойной клик, ретрай)
    if client_id:
        dup = conn.execute(
            "SELECT id FROM messages WHERE client_id = ? AND from_user = ?",
            (client_id, sender),
        ).fetchone()
        if dup:
            msg = fetch_message(conn, dup["id"])
            conn.close()
            return msg, False

    cur = conn.execute(
        "INSERT INTO messages (from_user, to_user, text, reply_to, client_id, created_at) "
        "VALUES (?, ?, ?, ?, ?, ?)",
        (sender, to_user, text, reply_to, client_id, int(time.time())),
    )
    msg_id = cur.lastrowid
    conn.commit()
    msg = fetch_message(conn, msg_id)
    conn.close()
    return msg, True


@app.websocket("/ws")
async def websocket_chat(websocket: WebSocket, token: Optional[str] = Query(default=None)):
    username = session_username(token or "")
    if not username:
        await websocket.close(code=4401)
        return

    await websocket.accept()
    active_connections.setdefault(username, set()).add(websocket)
    print(f"🟢 {username} подключён (онлайн: {len(active_connections)})")

    await send_to_user(username, {"type": "presence", "user": username, "online": True})
    await _broadcast_presence(username, True)

    try:
        while True:
            raw = await websocket.receive_text()
            try:
                msg = json.loads(raw)
            except json.JSONDecodeError:
                continue
            if not isinstance(msg, dict):
                continue

            msg_type = msg.get("type")

            # ---------- НОВОЕ СООБЩЕНИЕ ----------
            if msg_type == "message":
                to_user = str(msg.get("to", "")).strip().lower()
                text = str(msg.get("text", "")).strip()
                client_id = msg.get("client_id")
                reply_to = msg.get("reply_to") or 0
                try:
                    reply_to = int(reply_to)
                except (TypeError, ValueError):
                    reply_to = 0

                if not to_user or not text:
                    continue
                if len(text) > MAX_MESSAGE_LEN:
                    await websocket.send_text(json.dumps({
                        "type": "error", "client_id": client_id,
                        "text": f"Сообщение слишком длинное (макс. {MAX_MESSAGE_LEN})",
                    }, ensure_ascii=False))
                    continue
                if not user_exists(to_user):
                    await websocket.send_text(json.dumps({
                        "type": "error", "client_id": client_id, "text": "Юзер не найден",
                    }, ensure_ascii=False))
                    continue
                if is_blocked(username, to_user):
                    await websocket.send_text(json.dumps({
                        "type": "error", "client_id": client_id,
                        "text": "Нельзя написать: пользователь в блоке",
                    }, ensure_ascii=False))
                    continue
                if not are_friends(username, to_user):
                    await websocket.send_text(json.dumps({
                        "type": "error", "client_id": client_id,
                        "text": "Сначала добавь пользователя в друзья",
                    }, ensure_ascii=False))
                    continue

                saved, is_new = _save_message(username, to_user, text, client_id, reply_to)
                if not saved:
                    continue

                payload = {"type": "message", **saved}

                # получателю — только если сообщение новое и он не игнорирует отправителя
                if is_new and not is_ignored(to_user, username):
                    await send_to_user(to_user, payload)

                # отправителю — во все его вкладки (включая эту), чтобы
                # заменить оптимистичное сообщение настоящим id
                await send_to_user(username, payload)

            # ---------- РЕДАКТИРОВАНИЕ ----------
            elif msg_type == "edit_msg":
                try:
                    mid = int(msg.get("id"))
                except (TypeError, ValueError):
                    continue
                new_text = str(msg.get("text", "")).strip()
                if not new_text or len(new_text) > MAX_MESSAGE_LEN:
                    await websocket.send_text(json.dumps({
                        "type": "error", "text": "Текст пустой или слишком длинный",
                    }, ensure_ascii=False))
                    continue

                conn = db_connect()
                row = conn.execute(
                    "SELECT from_user, to_user, deleted FROM messages WHERE id = ?", (mid,)
                ).fetchone()
                if not row:
                    conn.close()
                    await websocket.send_text(json.dumps({
                        "type": "error", "text": "Сообщение не найдено",
                    }, ensure_ascii=False))
                    continue
                if row["from_user"] != username:
                    conn.close()
                    await websocket.send_text(json.dumps({
                        "type": "error", "text": "Можно редактировать только свои сообщения",
                    }, ensure_ascii=False))
                    continue
                if row["deleted"]:
                    conn.close()
                    continue

                conn.execute(
                    "UPDATE messages SET text = ?, edited = 1 WHERE id = ?", (new_text, mid)
                )
                conn.commit()
                updated = fetch_message(conn, mid)
                conn.close()
                await _broadcast_message_update(updated)

            # ---------- УДАЛЕНИЕ ----------
            elif msg_type == "delete_msg":
                try:
                    mid = int(msg.get("id"))
                except (TypeError, ValueError):
                    continue

                conn = db_connect()
                row = conn.execute(
                    "SELECT from_user FROM messages WHERE id = ?", (mid,)
                ).fetchone()
                if not row:
                    conn.close()
                    continue
                if row["from_user"] != username:
                    conn.close()
                    await websocket.send_text(json.dumps({
                        "type": "error", "text": "Можно удалять только свои сообщения",
                    }, ensure_ascii=False))
                    continue

                conn.execute("UPDATE messages SET deleted = 1, text = '' WHERE id = ?", (mid,))
                conn.commit()
                updated = fetch_message(conn, mid)
                conn.close()
                await _broadcast_message_update(updated)

            # ---------- ПРОЧИТАНО ----------
            elif msg_type == "read":
                chat_with = str(msg.get("chat_with", "")).strip().lower()
                if not chat_with:
                    continue
                last_id = mark_read(username, chat_with)
                await send_to_user(username, {
                    "type": "read_sync", "chat_with": chat_with, "last_read_id": last_id,
                })
                await send_to_user(chat_with, {
                    "type": "read", "by": username, "last_read_id": last_id,
                })

            # ---------- ПЕЧАТАЕТ ----------
            elif msg_type == "typing":
                to_user = str(msg.get("to", "")).strip().lower()
                if not to_user:
                    continue
                if is_blocked(username, to_user) or is_ignored(to_user, username):
                    continue
                if not are_friends(username, to_user):
                    continue
                await send_to_user(to_user, {"type": "typing", "from": username})

            # ---------- ЗАГЛУШКА ДЛЯ ПИНГА ----------
            elif msg_type == "ping":
                await websocket.send_text(json.dumps({"type": "pong"}))

    except WebSocketDisconnect:
        pass
    except Exception as exc:  # не роняем сервер из-за одной сессии
        print(f"⚠️ WS ошибка у {username}: {exc}")
    finally:
        conns = active_connections.get(username)
        if conns is not None:
            conns.discard(websocket)
            if not conns:
                active_connections.pop(username, None)
                conn = db_connect()
                conn.execute(
                    "UPDATE users SET last_seen = ? WHERE username = ?",
                    (int(time.time()), username),
                )
                conn.commit()
                conn.close()
                await _broadcast_presence(username, False)
        print(f"🔴 {username} отключён")


# ============================================
# СТАТИКА
# ============================================
FRONTEND_PATH = BASE_DIR / "frontend"


@app.get("/")
async def root():
    return FileResponse(FRONTEND_PATH / "index.html")


@app.get("/style.css")
async def css():
    return FileResponse(FRONTEND_PATH / "style.css")


@app.get("/script.js")
async def js():
    return FileResponse(FRONTEND_PATH / "script.js")


@app.get("/favicon.ico")
async def favicon():
    return FileResponse(FRONTEND_PATH / "favicon.svg", media_type="image/svg+xml")


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
        port=int(os.environ.get("PORT", 8000)),
        ws_ping_interval=20,
        ws_ping_timeout=20,
        timeout_graceful_shutdown=2,
    )
