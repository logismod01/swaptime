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
import base64
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
    Cookie,
    Depends,
)
from fastapi.middleware.cors import CORSMiddleware
from fastapi.staticfiles import StaticFiles
from fastapi.responses import FileResponse, Response
from pydantic import BaseModel

BASE_DIR = Path(__file__).resolve().parent.parent
DB_PATH = Path(os.environ.get("SWAPTIME_DB", BASE_DIR / "data" / "swaptime.db"))
DB_PATH.parent.mkdir(parents=True, exist_ok=True)

SESSION_COOKIE = "swaptime_session"
SESSION_TTL = 60 * 60 * 24 * 365  # год

MAX_MESSAGE_LEN = 4000
HISTORY_LIMIT = 200
USERNAME_RE = re.compile(r"^[a-z0-9_]{3,20}$")
COLOR_RE = re.compile(r"^#[0-9a-fA-F]{6}$")
FONT_RE = re.compile(r"^[A-Za-z0-9 ,'\-]{1,80}$")

THEMES = [
    "midnight",
    "ocean",
    "emerald",
    "violet",
    "sunset",
    "cyber",
    "coffee",
    "mono",
    "aurora",
    "cherry",
]

MAX_SERVER_NAME = 32
MAX_CHANNEL_NAME = 32
MAX_SERVER_DESC = 300
MAX_TG_POST = 4000
MAX_SERVER_MSG = 4000

FRAMES = [
    "none",
    "crimson",
    "gold",
    "neon",
    "aurora",
    "fire",
    "ice",
    "galaxy",
    "rainbow",
    "mono",
]

BANNERS = ["crimson", "sunset", "ocean", "forest", "galaxy", "night", "mono"]

MAX_AVATAR_CHARS = 420_000  # ~300 КБ картинки в base64
AVATAR_RE = re.compile(r"^data:image/(png|jpeg|jpg|webp|gif);base64,[A-Za-z0-9+/=\s]+$")
BIO_MAX = 190

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
            avatar TEXT DEFAULT '',
            avatar_frame TEXT DEFAULT 'none',
            banner TEXT DEFAULT 'crimson',
            bio TEXT DEFAULT '',
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

    # ---------- серверы (как в Discord) ----------
    c.execute("""
        CREATE TABLE IF NOT EXISTS servers (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            name TEXT NOT NULL,
            icon TEXT DEFAULT '',
            icon_color TEXT DEFAULT '#e53935',
            description TEXT DEFAULT '',
            owner TEXT NOT NULL,
            invite_code TEXT UNIQUE NOT NULL,
            created_at INTEGER NOT NULL
        )
    """)

    c.execute("""
        CREATE TABLE IF NOT EXISTS server_members (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            server_id INTEGER NOT NULL,
            username TEXT NOT NULL,
            role TEXT DEFAULT 'member',
            joined_at INTEGER NOT NULL,
            UNIQUE(server_id, username)
        )
    """)

    c.execute("""
        CREATE TABLE IF NOT EXISTS server_channels (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            server_id INTEGER NOT NULL,
            name TEXT NOT NULL,
            topic TEXT DEFAULT '',
            position INTEGER DEFAULT 0,
            created_at INTEGER NOT NULL
        )
    """)

    c.execute("""
        CREATE TABLE IF NOT EXISTS server_messages (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            channel_id INTEGER NOT NULL,
            from_user TEXT NOT NULL,
            text TEXT NOT NULL,
            edited INTEGER DEFAULT 0,
            deleted INTEGER DEFAULT 0,
            client_id TEXT,
            created_at INTEGER NOT NULL
        )
    """)

    c.execute("""
        CREATE TABLE IF NOT EXISTS server_read (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            username TEXT NOT NULL,
            channel_id INTEGER NOT NULL,
            last_read_id INTEGER DEFAULT 0,
            UNIQUE(username, channel_id)
        )
    """)

    # ---------- Telegram-каналы ----------
    c.execute("""
        CREATE TABLE IF NOT EXISTS tg_channels (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            owner TEXT NOT NULL,
            name TEXT NOT NULL,
            description TEXT DEFAULT '',
            color TEXT DEFAULT '#e53935',
            is_public INTEGER DEFAULT 1,
            created_at INTEGER NOT NULL
        )
    """)

    c.execute("""
        CREATE TABLE IF NOT EXISTS tg_posts (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            channel_id INTEGER NOT NULL,
            author TEXT NOT NULL,
            text TEXT NOT NULL,
            edited INTEGER DEFAULT 0,
            deleted INTEGER DEFAULT 0,
            created_at INTEGER NOT NULL
        )
    """)

    c.execute("""
        CREATE TABLE IF NOT EXISTS tg_subscribers (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            channel_id INTEGER NOT NULL,
            username TEXT NOT NULL,
            created_at INTEGER NOT NULL,
            UNIQUE(channel_id, username)
        )
    """)

    c.execute("""
        CREATE TABLE IF NOT EXISTS tg_read (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            username TEXT NOT NULL,
            channel_id INTEGER NOT NULL,
            last_read_id INTEGER DEFAULT 0,
            UNIQUE(username, channel_id)
        )
    """)

    # мягкие миграции старых баз
    _add_column(c, "users", "last_seen", "INTEGER DEFAULT 0")
    _add_column(c, "users", "avatar", "TEXT DEFAULT ''")
    _add_column(c, "users", "avatar_frame", "TEXT DEFAULT 'none'")
    _add_column(c, "users", "banner", "TEXT DEFAULT 'crimson'")
    _add_column(c, "users", "bio", "TEXT DEFAULT ''")
    _add_column(c, "users", "theme", "TEXT DEFAULT 'midnight'")
    _add_column(c, "messages", "client_id", "TEXT")
    _add_column(c, "messages", "pinned", "INTEGER DEFAULT 0")
    _add_column(c, "messages", "pinned_by", "TEXT DEFAULT ''")
    _add_column(c, "messages", "pinned_at", "INTEGER DEFAULT 0")
    _add_column(c, "server_messages", "pinned", "INTEGER DEFAULT 0")
    _add_column(c, "server_messages", "pinned_by", "TEXT DEFAULT ''")
    _add_column(c, "server_messages", "pinned_at", "INTEGER DEFAULT 0")

    c.execute("CREATE INDEX IF NOT EXISTS idx_msg_pair ON messages(from_user, to_user, id)")
    c.execute("CREATE INDEX IF NOT EXISTS idx_msg_to ON messages(to_user, id)")
    c.execute("CREATE INDEX IF NOT EXISTS idx_msg_client ON messages(client_id)")
    c.execute("CREATE INDEX IF NOT EXISTS idx_friends_user ON friends(user1, user2, status)")
    c.execute("CREATE INDEX IF NOT EXISTS idx_srv_msg ON server_messages(channel_id, id)")
    c.execute("CREATE INDEX IF NOT EXISTS idx_srv_members ON server_members(server_id, username)")
    c.execute("CREATE INDEX IF NOT EXISTS idx_tg_posts ON tg_posts(channel_id, id)")
    c.execute("CREATE INDEX IF NOT EXISTS idx_msg_pinned ON messages(pinned)")
    c.execute("CREATE INDEX IF NOT EXISTS idx_srv_msg_pinned ON server_messages(pinned)")

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
def avatar_version(data: str) -> str:
    """Короткий хеш аватарки — попадает в URL, чтобы сбросить кеш браузера."""
    if not data:
        return ""
    return hashlib.md5(data.encode()).hexdigest()[:10]


def get_user(username: str) -> Optional[dict]:
    conn = db_connect()
    row = conn.execute(
        "SELECT id, username, display_name, avatar_color, font_family, last_seen, "
        "avatar, avatar_frame, banner, bio, theme, created_at "
        "FROM users WHERE username = ?",
        (username,),
    ).fetchone()
    conn.close()
    if not row:
        return None
    avatar = row["avatar"] or ""
    return {
        "id": row["id"],
        "username": row["username"],
        "display_name": row["display_name"] or row["username"],
        "avatar_color": row["avatar_color"] or "#e53935",
        "avatar": avatar,
        "avatar_ver": avatar_version(avatar),
        "avatar_frame": row["avatar_frame"] or "none",
        "banner": row["banner"] or "crimson",
        "bio": row["bio"] or "",
        "theme": row["theme"] if row["theme"] in THEMES else THEMES[0],
        "font_family": normalize_font(row["font_family"] or FONTS[0]),
        "last_seen": row["last_seen"] or 0,
        "created_at": row["created_at"] or 0,
    }


def client_user(user: Optional[dict]) -> Optional[dict]:
    """Пользователь без тяжёлой base64-картинки — её отдаёт /api/avatar."""
    if not user:
        return None
    data = dict(user)
    data.pop("avatar", None)
    data["has_avatar"] = bool(user.get("avatar"))
    return data


def short_profile(user: dict) -> dict:
    """Компактная карточка для списков (чаты, друзья, заявки)."""
    return {
        "username": user["username"],
        "display_name": user["display_name"],
        "avatar_color": user["avatar_color"],
        "avatar_ver": user["avatar_ver"],
        "avatar_frame": user["avatar_frame"],
        "online": user["username"] in active_connections,
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
    swaptime_session: Optional[str] = Cookie(default=None),
) -> str:
    """Достаёт пользователя по токену: Authorization → ?token= → cookie.

    Три способа нужны, потому что некоторые прокси срезают заголовок
    Authorization: тогда браузер автоматически пришлёт cookie, а фронтенд
    в крайнем случае повторит запрос с токеном в query.
    """
    raw = None
    if authorization:
        # если заголовок пришёл, но битый — не подставляем cookie,
        # иначе ошибка клиента маскируется валидной cookie
        if authorization.lower().startswith("bearer "):
            raw = authorization[7:].strip()
    elif token:
        raw = token
    if not raw:
        raw = swaptime_session
    username = session_username(raw) if raw else None
    if not username:
        raise HTTPException(401, "Сессия истекла — войди заново")
    return username


def set_session_cookie(response: Response, token: str) -> None:
    response.set_cookie(
        SESSION_COOKIE,
        token,
        max_age=SESSION_TTL,
        httponly=True,
        samesite="lax",
        path="/",
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
    to_user: str
    from_user: Optional[str] = None  # игнорируется, оставлен для совместимости


class UpdateProfile(BaseModel):
    display_name: Optional[str] = None
    avatar_color: Optional[str] = None
    font_family: Optional[str] = None
    avatar_frame: Optional[str] = None
    banner: Optional[str] = None
    bio: Optional[str] = None
    theme: Optional[str] = None


class AvatarPayload(BaseModel):
    avatar: str = ""


class MessageAction(BaseModel):
    message_id: int
    new_text: str = ""


class MessagePin(BaseModel):
    message_id: int
    pinned: bool = True


class PinToggle(BaseModel):
    pinned: bool = True


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
    "id, from_user, to_user, text, reply_to, edited, deleted, client_id, created_at, "
    "pinned, pinned_by, pinned_at"
)

SRV_MSG_COLUMNS = (
    "id, channel_id, from_user, text, edited, deleted, client_id, created_at, "
    "pinned, pinned_by, pinned_at"
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
        "pinned": bool(row["pinned"]),
        "pinned_by": row["pinned_by"] or "",
        "pinned_at": row["pinned_at"] or 0,
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
async def register(data: RegisterData, response: Response):
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
    set_session_cookie(response, token)
    return {"ok": True, "token": token, "user": client_user(get_user(username))}


@app.post("/api/login")
async def login(data: LoginData, response: Response):
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
    set_session_cookie(response, token)
    return {"ok": True, "token": token, "user": client_user(get_user(username))}


@app.post("/api/logout")
async def logout(
    response: Response,
    authorization: Optional[str] = Header(default=None),
    swaptime_session: Optional[str] = Cookie(default=None),
):
    token = None
    if authorization and authorization.lower().startswith("bearer "):
        token = authorization[7:].strip()
    if not token:
        token = swaptime_session
    if token:
        conn = db_connect()
        conn.execute("DELETE FROM sessions WHERE token = ?", (token,))
        conn.commit()
        conn.close()
    response.delete_cookie(SESSION_COOKIE, path="/")
    return {"ok": True}


@app.get("/api/me")
async def me(user: str = Depends(auth_user)):
    data = client_user(get_user(user))
    if not data:
        raise HTTPException(401, "Юзер не найден")
    data["online"] = True
    return {
        "user": data,
        "fonts": FONTS,
        "frames": FRAMES,
        "banners": BANNERS,
        "themes": THEMES,
    }


def _apply_profile_update(user: str, data: UpdateProfile) -> dict:
    current = get_user(user)
    if not current:
        raise HTTPException(401, "Юзер не найден")

    display_name = current["display_name"]
    if data.display_name is not None:
        display_name = (data.display_name or "").strip()[:40] or user

    color = current["avatar_color"]
    if data.avatar_color is not None:
        color = data.avatar_color if COLOR_RE.match(data.avatar_color) else "#e53935"

    font = current["font_family"]
    if data.font_family is not None:
        font = normalize_font(data.font_family) if FONT_RE.match(data.font_family) else FONTS[0]

    frame = current["avatar_frame"]
    if data.avatar_frame is not None:
        frame = data.avatar_frame if data.avatar_frame in FRAMES else "none"

    banner = current["banner"]
    if data.banner is not None:
        banner = data.banner if data.banner in BANNERS else "crimson"

    bio = current["bio"]
    if data.bio is not None:
        bio = (data.bio or "").strip()[:BIO_MAX]

    theme = current["theme"]
    if data.theme is not None:
        theme = data.theme if data.theme in THEMES else THEMES[0]

    conn = db_connect()
    conn.execute(
        "UPDATE users SET display_name = ?, avatar_color = ?, font_family = ?, "
        "avatar_frame = ?, banner = ?, bio = ?, theme = ? WHERE username = ?",
        (display_name, color, font, frame, banner, bio, theme, user),
    )
    conn.commit()
    conn.close()
    return get_user(user)


@app.post("/api/update_profile")
async def update_profile(data: UpdateProfile, user: str = Depends(auth_user)):
    updated = _apply_profile_update(user, data)
    await broadcast_profile(user, updated)
    return {"ok": True, "user": client_user(updated)}


@app.post("/api/avatar")
async def set_avatar(payload: AvatarPayload, user: str = Depends(auth_user)):
    """Аватарка приходит уже обрезанной квадратом на клиенте (≤ 300 КБ)."""
    raw = (payload.avatar or "").strip()

    if raw:
        if len(raw) > MAX_AVATAR_CHARS:
            raise HTTPException(413, "Аватарка слишком большая (макс. 300 КБ)")
        if not AVATAR_RE.match(raw):
            raise HTTPException(400, "Поддерживаются только PNG, JPEG, WEBP и GIF")

    conn = db_connect()
    conn.execute("UPDATE users SET avatar = ? WHERE username = ?", (raw, user))
    conn.commit()
    conn.close()

    updated = get_user(user)
    await broadcast_profile(user, updated)
    return {"ok": True, "user": client_user(updated)}


@app.get("/api/avatar/{username}")
async def get_avatar(username: str, v: Optional[str] = None):  # noqa: ARG001
    username = username.strip().lower()
    conn = db_connect()
    row = conn.execute("SELECT avatar FROM users WHERE username = ?", (username,)).fetchone()
    conn.close()

    if not row or not row["avatar"]:
        raise HTTPException(404, "Нет аватарки")

    match = re.match(r"^data:(image/[a-zA-Z0-9.+-]+);base64,(.+)$", row["avatar"], re.S)
    if not match:
        raise HTTPException(404, "Нет аватарки")
    media_type, b64 = match.group(1), match.group(2)
    try:
        content = base64.b64decode(b64)
    except Exception:
        raise HTTPException(404, "Аватарка повреждена")

    return Response(
        content=content,
        media_type=media_type,
        headers={
            "Cache-Control": "public, max-age=31536000, immutable",
            "ETag": '"' + avatar_version(row["avatar"]) + '"',
            "X-Content-Type-Options": "nosniff",
        },
    )


@app.get("/api/profile/{username}")
async def get_profile(username: str, viewer: str = Depends(auth_user)):
    username = username.strip().lower()
    user = get_user(username)
    if not user:
        raise HTTPException(404, "Юзер не найден")

    payload = short_profile(user)
    payload.update({
        "bio": user["bio"],
        "banner": user["banner"],
        "created_at": user["created_at"],
        "last_seen": user["last_seen"],
        "is_friend": are_friends(viewer, username),
        "is_me": viewer == username,
        "blocked_by_me": username in block_list(viewer),
        "blocked_me": blocked_by(viewer, username),
        "ignored_by_me": username in ignore_list(viewer),
        "can_call": can_call(viewer, username),
        "same_server": same_server(viewer, username),
    })
    return payload


# ============================================
# API — НАСТРОЙКИ
# ============================================
@app.get("/api/settings")
async def get_settings(user: str = Depends(auth_user)):
    return {
        "blocked": block_list(user),
        "ignored": ignore_list(user),
        "fonts": FONTS,
        "frames": FRAMES,
        "banners": BANNERS,
        "themes": THEMES,
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
        entry = short_profile(info)
        entry["unread"] = unread.get(name, 0)
        entry["last_message"] = last_msg
        friends.append(entry)
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

    conn.execute(
        "UPDATE messages SET deleted = 1, text = '', pinned = 0, pinned_by = '', pinned_at = 0 "
        "WHERE id = ?",
        (data.message_id,),
    )
    conn.commit()
    msg = fetch_message(conn, data.message_id)
    conn.close()

    await _broadcast_message_update(msg)
    return {"ok": True, "message": msg}


@app.get("/api/pins/{other}")
async def get_pins(other: str, user: str = Depends(auth_user)):
    """Закреплённые сообщения личного чата."""
    other = other.strip().lower()
    if not _can_chat(user, other):
        raise HTTPException(403, "Нет доступа к этому чату")

    conn = db_connect()
    rows = conn.execute(
        f"""
        SELECT {MSG_COLUMNS} FROM messages
        WHERE pinned = 1 AND deleted = 0
          AND ((from_user = ? AND to_user = ?) OR (from_user = ? AND to_user = ?))
        ORDER BY pinned_at DESC, id DESC LIMIT 50
        """,
        (user, other, other, user),
    ).fetchall()
    replies = _replies_map(conn, [r["reply_to"] for r in rows])
    pins = [message_dict(r, replies) for r in rows]
    conn.close()
    return {"pins": pins}


@app.post("/api/messages/pin")
async def pin_message(data: MessagePin, user: str = Depends(auth_user)):
    """Закрепить/открепить сообщение в личном чате (REST-фолбэк для WS)."""
    conn = db_connect()
    row = conn.execute(
        "SELECT from_user, to_user, deleted FROM messages WHERE id = ?", (data.message_id,)
    ).fetchone()
    if not row:
        conn.close()
        raise HTTPException(404, "Сообщение не найдено")
    if user not in (row["from_user"], row["to_user"]):
        conn.close()
        raise HTTPException(403, "Это чужой чат")
    if row["deleted"] and data.pinned:
        conn.close()
        raise HTTPException(400, "Сообщение удалено")

    now = int(time.time())
    conn.execute(
        "UPDATE messages SET pinned = ?, pinned_by = ?, pinned_at = ? WHERE id = ?",
        (1 if data.pinned else 0, user if data.pinned else "", now if data.pinned else 0,
         data.message_id),
    )
    conn.commit()
    msg = fetch_message(conn, data.message_id)
    conn.close()

    payload = {"type": "pin_changed", "message": msg}
    await send_to_user(msg["from"], payload)
    await send_to_user(msg["to"], payload)
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
            friends.append(short_profile(info))

    req_rows = conn.execute(
        "SELECT user1 FROM friends WHERE user2 = ? AND status = 'pending'", (user,)
    ).fetchall()
    incoming = []
    for r in req_rows:
        info = get_user(r["user1"])
        if info:
            incoming.append(short_profile(info))

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
        "blocked_users": [short_profile(u) for u in map(get_user, block_list(user)) if u],
        "ignored_users": [short_profile(u) for u in map(get_user, ignore_list(user)) if u],
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
# СЕРВЕРЫ (как в Discord) — ХЕЛПЕРЫ
# ============================================
def _invite_code() -> str:
    return secrets.token_urlsafe(6).replace("-", "").replace("_", "")[:8]


def server_role(server_id: int, username: str) -> Optional[str]:
    conn = db_connect()
    row = conn.execute(
        "SELECT role FROM server_members WHERE server_id = ? AND username = ?",
        (server_id, username),
    ).fetchone()
    conn.close()
    return row["role"] if row else None


def server_member_names(server_id: int) -> list:
    conn = db_connect()
    rows = conn.execute(
        "SELECT username FROM server_members WHERE server_id = ?", (server_id,)
    ).fetchall()
    conn.close()
    return [r["username"] for r in rows]


def can_manage_server(server_id: int, username: str) -> bool:
    return server_role(server_id, username) in ("owner", "admin")


def same_server(a: str, b: str) -> bool:
    conn = db_connect()
    row = conn.execute(
        """
        SELECT 1 FROM server_members m1
        JOIN server_members m2 ON m1.server_id = m2.server_id
        WHERE m1.username = ? AND m2.username = ? LIMIT 1
        """,
        (a, b),
    ).fetchone()
    conn.close()
    return bool(row)


def can_call(a: str, b: str) -> bool:
    """Звонить можно друзьям и людям с общего сервера."""
    if a == b:
        return False
    if is_blocked(a, b):
        return False
    return are_friends(a, b) or same_server(a, b)


def _server_channels_payload(conn: sqlite3.Connection, server_id: int, viewer: str) -> list:
    rows = conn.execute(
        "SELECT id, name, topic, position FROM server_channels "
        "WHERE server_id = ? ORDER BY position, id",
        (server_id,),
    ).fetchall()

    reads = dict(
        conn.execute(
            "SELECT channel_id, last_read_id FROM server_read WHERE username = ?", (viewer,)
        ).fetchall()
    )

    channels = []
    for row in rows:
        last_read = reads.get(row["id"], 0)
        unread = conn.execute(
            "SELECT COUNT(*) FROM server_messages "
            "WHERE channel_id = ? AND id > ? AND deleted = 0 AND from_user != ?",
            (row["id"], last_read, viewer),
        ).fetchone()[0]
        channels.append({
            "id": row["id"],
            "name": row["name"],
            "topic": row["topic"] or "",
            "position": row["position"],
            "unread": unread,
        })
    return channels


def _server_payload(server_id: int, viewer: str) -> Optional[dict]:
    conn = db_connect()
    row = conn.execute(
        "SELECT id, name, icon, icon_color, description, owner, invite_code, created_at "
        "FROM servers WHERE id = ?",
        (server_id,),
    ).fetchone()
    if not row:
        conn.close()
        return None

    member_rows = conn.execute(
        "SELECT username, role, joined_at FROM server_members "
        "WHERE server_id = ? ORDER BY CASE role WHEN 'owner' THEN 0 WHEN 'admin' THEN 1 ELSE 2 END, joined_at",
        (server_id,),
    ).fetchall()

    members = []
    for m in member_rows:
        info = get_user(m["username"])
        if not info:
            continue
        card = short_profile(info)
        card["role"] = m["role"]
        card["joined_at"] = m["joined_at"]
        members.append(card)

    channels = _server_channels_payload(conn, server_id, viewer)
    my_role = server_role(server_id, viewer)
    conn.close()

    return {
        "id": row["id"],
        "name": row["name"],
        "icon": row["icon"] or "",
        "icon_color": row["icon_color"] or "#e53935",
        "description": row["description"] or "",
        "owner": row["owner"],
        "invite_code": row["invite_code"],
        "created_at": row["created_at"],
        "channels": channels,
        "members": members,
        "member_count": len(members),
        "my_role": my_role,
        "unread": sum(ch["unread"] for ch in channels),
    }


async def broadcast_to_server(server_id: int, payload: dict, exclude: Optional[str] = None) -> None:
    for member in server_member_names(server_id):
        if member == exclude:
            continue
        await send_to_user(member, payload)


# ============================================
# API — СЕРВЕРЫ
# ============================================
class ServerCreate(BaseModel):
    name: str
    icon: str = ""
    icon_color: str = "#e53935"
    description: str = ""


class ServerUpdate(BaseModel):
    name: Optional[str] = None
    icon: Optional[str] = None
    icon_color: Optional[str] = None
    description: Optional[str] = None


class ServerJoin(BaseModel):
    code: str


class ChannelCreate(BaseModel):
    name: str
    topic: str = ""


class ChannelUpdate(BaseModel):
    name: Optional[str] = None
    topic: Optional[str] = None


class ServerMessageIn(BaseModel):
    text: str
    client_id: Optional[str] = None


def _clean_channel_name(name: str) -> str:
    cleaned = re.sub(r"\s+", "-", (name or "").strip().lower())
    cleaned = re.sub(r"[^a-zа-я0-9_-]", "", cleaned)
    return cleaned[:MAX_CHANNEL_NAME] or "канал"


@app.get("/api/servers")
async def list_servers(user: str = Depends(auth_user)):
    conn = db_connect()
    rows = conn.execute(
        """
        SELECT s.id FROM servers s
        JOIN server_members m ON m.server_id = s.id
        WHERE m.username = ?
        ORDER BY s.id
        """,
        (user,),
    ).fetchall()
    conn.close()

    servers = []
    for r in rows:
        payload = _server_payload(r["id"], user)
        if payload:
            servers.append({
                "id": payload["id"],
                "name": payload["name"],
                "icon": payload["icon"],
                "icon_color": payload["icon_color"],
                "unread": payload["unread"],
                "member_count": payload["member_count"],
                "my_role": payload["my_role"],
            })
    return {"servers": servers}


@app.post("/api/servers")
async def create_server(data: ServerCreate, user: str = Depends(auth_user)):
    name = (data.name or "").strip()[:MAX_SERVER_NAME]
    if len(name) < 2:
        raise HTTPException(400, "Название сервера — минимум 2 символа")

    icon = (data.icon or "").strip()[:4]
    color = data.icon_color if COLOR_RE.match(data.icon_color or "") else "#e53935"
    description = (data.description or "").strip()[:MAX_SERVER_DESC]
    now = int(time.time())

    conn = db_connect()
    code = _invite_code()
    while conn.execute("SELECT 1 FROM servers WHERE invite_code = ?", (code,)).fetchone():
        code = _invite_code()

    cur = conn.execute(
        "INSERT INTO servers (name, icon, icon_color, description, owner, invite_code, created_at) "
        "VALUES (?, ?, ?, ?, ?, ?, ?)",
        (name, icon, color, description, user, code, now),
    )
    server_id = cur.lastrowid

    conn.execute(
        "INSERT INTO server_members (server_id, username, role, joined_at) VALUES (?, ?, 'owner', ?)",
        (server_id, user, now),
    )
    conn.execute(
        "INSERT INTO server_channels (server_id, name, topic, position, created_at) VALUES (?, ?, ?, 0, ?)",
        (server_id, "общий", "Главный канал сервера", now),
    )
    conn.execute(
        "INSERT INTO server_channels (server_id, name, topic, position, created_at) VALUES (?, ?, ?, 1, ?)",
        (server_id, "флудилка", "Обо всём и ни о чём", now),
    )
    conn.commit()
    conn.close()

    payload = _server_payload(server_id, user)
    return {"ok": True, "server": payload}


@app.get("/api/servers/invite/{code}")
async def invite_preview(code: str, user: str = Depends(auth_user)):
    code = (code or "").strip()
    conn = db_connect()
    row = conn.execute(
        "SELECT id, name, icon, icon_color, description FROM servers WHERE invite_code = ?",
        (code,),
    ).fetchone()
    count = 0
    already = False
    if row:
        count = conn.execute(
            "SELECT COUNT(*) FROM server_members WHERE server_id = ?", (row["id"],)
        ).fetchone()[0]
        already = server_role(row["id"], user) is not None
    conn.close()

    if not row:
        raise HTTPException(404, "Приглашение недействительно")
    return {
        "id": row["id"],
        "name": row["name"],
        "icon": row["icon"] or "",
        "icon_color": row["icon_color"] or "#e53935",
        "description": row["description"] or "",
        "member_count": count,
        "already_member": already,
    }


@app.post("/api/servers/join")
async def join_server(data: ServerJoin, user: str = Depends(auth_user)):
    code = (data.code or "").strip()
    conn = db_connect()
    row = conn.execute("SELECT id, name FROM servers WHERE invite_code = ?", (code,)).fetchone()
    if not row:
        conn.close()
        raise HTTPException(404, "Приглашение недействительно")
    server_id = row["id"]

    if conn.execute(
        "SELECT 1 FROM server_members WHERE server_id = ? AND username = ?", (server_id, user)
    ).fetchone():
        conn.close()
        raise HTTPException(400, "Ты уже на этом сервере")

    conn.execute(
        "INSERT INTO server_members (server_id, username, role, joined_at) VALUES (?, ?, 'member', ?)",
        (server_id, user, int(time.time())),
    )
    conn.commit()
    conn.close()

    payload = _server_payload(server_id, user)
    await broadcast_to_server(server_id, {"type": "server_member_joined", "server_id": server_id, "user": short_profile(get_user(user))})
    return {"ok": True, "server": payload}


@app.get("/api/servers/{server_id}")
async def get_server(server_id: int, user: str = Depends(auth_user)):
    if not server_role(server_id, user):
        raise HTTPException(403, "Ты не участник этого сервера")
    payload = _server_payload(server_id, user)
    if not payload:
        raise HTTPException(404, "Сервер не найден")
    return payload


@app.post("/api/servers/{server_id}/update")
async def update_server(server_id: int, data: ServerUpdate, user: str = Depends(auth_user)):
    if not can_manage_server(server_id, user):
        raise HTTPException(403, "Нужны права администратора")

    conn = db_connect()
    row = conn.execute("SELECT * FROM servers WHERE id = ?", (server_id,)).fetchone()
    if not row:
        conn.close()
        raise HTTPException(404, "Сервер не найден")

    name = (data.name or "").strip()[:MAX_SERVER_NAME] if data.name is not None else row["name"]
    icon = (data.icon or "").strip()[:4] if data.icon is not None else row["icon"]
    color = data.icon_color if data.icon_color and COLOR_RE.match(data.icon_color) else row["icon_color"]
    description = (data.description or "").strip()[:MAX_SERVER_DESC] if data.description is not None else row["description"]

    conn.execute(
        "UPDATE servers SET name = ?, icon = ?, icon_color = ?, description = ? WHERE id = ?",
        (name or row["name"], icon, color, description, server_id),
    )
    conn.commit()
    conn.close()

    await broadcast_to_server(server_id, {"type": "server_updated", "server_id": server_id})
    return {"ok": True, "server": _server_payload(server_id, user)}


@app.post("/api/servers/{server_id}/rotate_invite")
async def rotate_invite(server_id: int, user: str = Depends(auth_user)):
    if not can_manage_server(server_id, user):
        raise HTTPException(403, "Нужны права администратора")
    conn = db_connect()
    code = _invite_code()
    while conn.execute("SELECT 1 FROM servers WHERE invite_code = ?", (code,)).fetchone():
        code = _invite_code()
    conn.execute("UPDATE servers SET invite_code = ? WHERE id = ?", (code, server_id))
    conn.commit()
    conn.close()
    return {"ok": True, "invite_code": code}


@app.delete("/api/servers/{server_id}")
async def delete_server(server_id: int, user: str = Depends(auth_user)):
    if server_role(server_id, user) != "owner":
        raise HTTPException(403, "Удалить сервер может только владелец")

    members = server_member_names(server_id)
    conn = db_connect()
    channel_ids = [r["id"] for r in conn.execute(
        "SELECT id FROM server_channels WHERE server_id = ?", (server_id,)
    ).fetchall()]
    for cid in channel_ids:
        conn.execute("DELETE FROM server_messages WHERE channel_id = ?", (cid,))
        conn.execute("DELETE FROM server_read WHERE channel_id = ?", (cid,))
    conn.execute("DELETE FROM server_channels WHERE server_id = ?", (server_id,))
    conn.execute("DELETE FROM server_members WHERE server_id = ?", (server_id,))
    conn.execute("DELETE FROM servers WHERE id = ?", (server_id,))
    conn.commit()
    conn.close()

    for member in members:
        await send_to_user(member, {"type": "server_left", "server_id": server_id, "deleted": True})
    return {"ok": True}


@app.post("/api/servers/{server_id}/leave")
async def leave_server(server_id: int, user: str = Depends(auth_user)):
    role = server_role(server_id, user)
    if not role:
        raise HTTPException(404, "Ты не на этом сервере")
    if role == "owner":
        raise HTTPException(400, "Владелец не может выйти — передай сервер или удали его")

    conn = db_connect()
    conn.execute("DELETE FROM server_members WHERE server_id = ? AND username = ?", (server_id, user))
    conn.commit()
    conn.close()

    await send_to_user(user, {"type": "server_left", "server_id": server_id})
    await broadcast_to_server(server_id, {"type": "server_member_left", "server_id": server_id, "username": user})
    return {"ok": True}


@app.post("/api/servers/{server_id}/channels")
async def create_server_channel(server_id: int, data: ChannelCreate, user: str = Depends(auth_user)):
    if not can_manage_server(server_id, user):
        raise HTTPException(403, "Нужны права администратора")

    name = _clean_channel_name(data.name)
    conn = db_connect()
    if not conn.execute("SELECT 1 FROM servers WHERE id = ?", (server_id,)).fetchone():
        conn.close()
        raise HTTPException(404, "Сервер не найден")
    if conn.execute(
        "SELECT 1 FROM server_channels WHERE server_id = ? AND name = ?", (server_id, name)
    ).fetchone():
        conn.close()
        raise HTTPException(400, "Канал с таким названием уже есть")

    pos = conn.execute(
        "SELECT COALESCE(MAX(position), 0) + 1 FROM server_channels WHERE server_id = ?", (server_id,)
    ).fetchone()[0]
    cur = conn.execute(
        "INSERT INTO server_channels (server_id, name, topic, position, created_at) VALUES (?, ?, ?, ?, ?)",
        (server_id, name, (data.topic or "").strip()[:120], pos, int(time.time())),
    )
    channel_id = cur.lastrowid
    conn.commit()
    conn.close()

    await broadcast_to_server(server_id, {"type": "server_channels_changed", "server_id": server_id})
    return {"ok": True, "channel_id": channel_id, "server": _server_payload(server_id, user)}


@app.post("/api/servers/{server_id}/channels/{channel_id}/update")
async def update_server_channel(server_id: int, channel_id: int, data: ChannelUpdate, user: str = Depends(auth_user)):
    if not can_manage_server(server_id, user):
        raise HTTPException(403, "Нужны права администратора")

    conn = db_connect()
    row = conn.execute(
        "SELECT name, topic FROM server_channels WHERE id = ? AND server_id = ?", (channel_id, server_id)
    ).fetchone()
    if not row:
        conn.close()
        raise HTTPException(404, "Канал не найден")

    name = _clean_channel_name(data.name) if data.name else row["name"]
    topic = (data.topic or "").strip()[:120] if data.topic is not None else row["topic"]
    conn.execute("UPDATE server_channels SET name = ?, topic = ? WHERE id = ?", (name, topic, channel_id))
    conn.commit()
    conn.close()

    await broadcast_to_server(server_id, {"type": "server_channels_changed", "server_id": server_id})
    return {"ok": True, "server": _server_payload(server_id, user)}


@app.delete("/api/servers/{server_id}/channels/{channel_id}")
async def delete_server_channel(server_id: int, channel_id: int, user: str = Depends(auth_user)):
    if not can_manage_server(server_id, user):
        raise HTTPException(403, "Нужны права администратора")

    conn = db_connect()
    total = conn.execute(
        "SELECT COUNT(*) FROM server_channels WHERE server_id = ?", (server_id,)
    ).fetchone()[0]
    if total <= 1:
        conn.close()
        raise HTTPException(400, "Нельзя удалить последний канал")
    conn.execute("DELETE FROM server_channels WHERE id = ? AND server_id = ?", (channel_id, server_id))
    conn.execute("DELETE FROM server_messages WHERE channel_id = ?", (channel_id,))
    conn.execute("DELETE FROM server_read WHERE channel_id = ?", (channel_id,))
    conn.commit()
    conn.close()

    await broadcast_to_server(server_id, {"type": "server_channels_changed", "server_id": server_id})
    return {"ok": True, "server": _server_payload(server_id, user)}


def _server_message_dict(row: sqlite3.Row, conn: sqlite3.Connection) -> dict:
    return {
        "id": row["id"],
        "channel_id": row["channel_id"],
        "from": row["from_user"],
        "text": "" if row["deleted"] else (row["text"] or ""),
        "edited": row["edited"],
        "deleted": row["deleted"],
        "client_id": row["client_id"],
        "created_at": row["created_at"],
        "pinned": bool(row["pinned"]),
        "pinned_by": row["pinned_by"] or "",
        "pinned_at": row["pinned_at"] or 0,
    }


@app.get("/api/servers/{server_id}/channels/{channel_id}/messages")
async def server_messages(
    server_id: int,
    channel_id: int,
    limit: int = Query(default=100, ge=1, le=300),
    user: str = Depends(auth_user),
):
    if not server_role(server_id, user):
        raise HTTPException(403, "Ты не участник этого сервера")

    conn = db_connect()
    if not conn.execute(
        "SELECT 1 FROM server_channels WHERE id = ? AND server_id = ?", (channel_id, server_id)
    ).fetchone():
        conn.close()
        raise HTTPException(404, "Канал не найден")

    rows = conn.execute(
        f"SELECT {SRV_MSG_COLUMNS} "
        "FROM server_messages WHERE channel_id = ? ORDER BY id DESC LIMIT ?",
        (channel_id, limit),
    ).fetchall()
    messages = [_server_message_dict(r, conn) for r in reversed(rows)]
    conn.close()
    return messages


@app.post("/api/servers/{server_id}/channels/{channel_id}/messages")
async def post_server_message(
    server_id: int,
    channel_id: int,
    data: ServerMessageIn,
    user: str = Depends(auth_user),
):
    if not server_role(server_id, user):
        raise HTTPException(403, "Ты не участник этого сервера")
    text = (data.text or "").strip()
    if not text:
        raise HTTPException(400, "Пустое сообщение")
    if len(text) > MAX_SERVER_MSG:
        raise HTTPException(400, "Слишком длинное сообщение")

    conn = db_connect()
    if not conn.execute(
        "SELECT 1 FROM server_channels WHERE id = ? AND server_id = ?", (channel_id, server_id)
    ).fetchone():
        conn.close()
        raise HTTPException(404, "Канал не найден")

    cur = conn.execute(
        "INSERT INTO server_messages (channel_id, from_user, text, client_id, created_at) "
        "VALUES (?, ?, ?, ?, ?)",
        (channel_id, user, text, data.client_id, int(time.time())),
    )
    msg_id = cur.lastrowid
    conn.commit()
    row = conn.execute(
        f"SELECT {SRV_MSG_COLUMNS} FROM server_messages WHERE id = ?", (msg_id,)
    ).fetchone()
    payload = {"type": "server_message", "server_id": server_id, **_server_message_dict(row, conn)}
    conn.close()

    await broadcast_to_server(server_id, payload)
    return payload


@app.get("/api/servers/{server_id}/channels/{channel_id}/pins")
async def server_channel_pins(server_id: int, channel_id: int, user: str = Depends(auth_user)):
    if not server_role(server_id, user):
        raise HTTPException(403, "Ты не участник этого сервера")

    conn = db_connect()
    if not conn.execute(
        "SELECT 1 FROM server_channels WHERE id = ? AND server_id = ?", (channel_id, server_id)
    ).fetchone():
        conn.close()
        raise HTTPException(404, "Канал не найден")

    rows = conn.execute(
        f"SELECT {SRV_MSG_COLUMNS} FROM server_messages "
        "WHERE channel_id = ? AND pinned = 1 AND deleted = 0 "
        "ORDER BY pinned_at DESC, id DESC LIMIT 50",
        (channel_id,),
    ).fetchall()
    pins = [_server_message_dict(r, conn) for r in rows]
    conn.close()
    return {"pins": pins}


@app.post("/api/servers/{server_id}/channels/{channel_id}/messages/{message_id}/pin")
async def pin_server_message(
    server_id: int,
    channel_id: int,
    message_id: int,
    data: PinToggle,
    user: str = Depends(auth_user),
):
    """Закрепить/открепить сообщение в канале сервера — может любой участник."""
    if not server_role(server_id, user):
        raise HTTPException(403, "Ты не участник этого сервера")

    conn = db_connect()
    row = conn.execute(
        "SELECT m.deleted FROM server_messages m JOIN server_channels c ON c.id = m.channel_id "
        "WHERE m.id = ? AND m.channel_id = ? AND c.server_id = ?",
        (message_id, channel_id, server_id),
    ).fetchone()
    if not row:
        conn.close()
        raise HTTPException(404, "Сообщение не найдено")
    if row["deleted"] and data.pinned:
        conn.close()
        raise HTTPException(400, "Сообщение удалено")

    now = int(time.time())
    conn.execute(
        "UPDATE server_messages SET pinned = ?, pinned_by = ?, pinned_at = ? WHERE id = ?",
        (1 if data.pinned else 0, user if data.pinned else "", now if data.pinned else 0, message_id),
    )
    conn.commit()
    msg = _server_message_dict(
        conn.execute(f"SELECT {SRV_MSG_COLUMNS} FROM server_messages WHERE id = ?",
                     (message_id,)).fetchone(),
        conn,
    )
    conn.close()

    await broadcast_to_server(server_id, {
        "type": "server_pin_changed",
        "server_id": server_id,
        "channel_id": channel_id,
        "message": msg,
    })
    return {"ok": True, "message": msg}


@app.post("/api/servers/{server_id}/channels/{channel_id}/read")
async def read_server_channel(server_id: int, channel_id: int, user: str = Depends(auth_user)):
    if not server_role(server_id, user):
        raise HTTPException(403, "Ты не участник этого сервера")
    conn = db_connect()
    last_id = conn.execute(
        "SELECT COALESCE(MAX(id), 0) FROM server_messages WHERE channel_id = ?", (channel_id,)
    ).fetchone()[0]
    conn.execute(
        """
        INSERT INTO server_read (username, channel_id, last_read_id) VALUES (?, ?, ?)
        ON CONFLICT(username, channel_id) DO UPDATE SET last_read_id =
            MAX(server_read.last_read_id, excluded.last_read_id)
        """,
        (user, channel_id, last_id),
    )
    conn.commit()
    conn.close()
    return {"ok": True, "last_read_id": last_id}


@app.post("/api/servers/{server_id}/members/{member}/kick")
async def kick_member(server_id: int, member: str, user: str = Depends(auth_user)):
    member = member.strip().lower()
    my_role = server_role(server_id, user)
    target_role = server_role(server_id, member)

    if my_role not in ("owner", "admin"):
        raise HTTPException(403, "Нужны права администратора")
    if not target_role:
        raise HTTPException(404, "Пользователь не на сервере")
    if target_role == "owner":
        raise HTTPException(400, "Владельца нельзя исключить")
    if my_role == "admin" and target_role == "admin":
        raise HTTPException(403, "Админ не может исключить админа")

    conn = db_connect()
    conn.execute("DELETE FROM server_members WHERE server_id = ? AND username = ?", (server_id, member))
    conn.commit()
    conn.close()

    await send_to_user(member, {"type": "server_left", "server_id": server_id, "kicked": True})
    await broadcast_to_server(server_id, {"type": "server_member_left", "server_id": server_id, "username": member})
    return {"ok": True}


class RoleUpdate(BaseModel):
    role: str


@app.post("/api/servers/{server_id}/members/{member}/role")
async def set_member_role(server_id: int, member: str, data: RoleUpdate, user: str = Depends(auth_user)):
    member = member.strip().lower()
    if server_role(server_id, user) != "owner":
        raise HTTPException(403, "Менять роли может только владелец")
    if data.role not in ("admin", "member"):
        raise HTTPException(400, "Неверная роль")
    if server_role(server_id, member) in (None, "owner"):
        raise HTTPException(400, "Этому пользователю нельзя менять роль")

    conn = db_connect()
    conn.execute(
        "UPDATE server_members SET role = ? WHERE server_id = ? AND username = ?",
        (data.role, server_id, member),
    )
    conn.commit()
    conn.close()

    await broadcast_to_server(server_id, {"type": "server_members_changed", "server_id": server_id})
    return {"ok": True}


# ============================================
# API — TELEGRAM-КАНАЛЫ
# ============================================
class TgChannelCreate(BaseModel):
    name: str
    description: str = ""
    color: str = "#e53935"
    is_public: bool = True


class TgPostIn(BaseModel):
    text: str


class TgPostEdit(BaseModel):
    text: str


def _tg_channel_payload(conn: sqlite3.Connection, row: sqlite3.Row, viewer: str) -> dict:
    subscribed = bool(conn.execute(
        "SELECT 1 FROM tg_subscribers WHERE channel_id = ? AND username = ?",
        (row["id"], viewer),
    ).fetchone())

    read_row = conn.execute(
        "SELECT last_read_id FROM tg_read WHERE username = ? AND channel_id = ?",
        (viewer, row["id"]),
    ).fetchone()
    last_read = read_row["last_read_id"] if read_row else 0

    unread = conn.execute(
        "SELECT COUNT(*) FROM tg_posts WHERE channel_id = ? AND id > ? AND deleted = 0",
        (row["id"], last_read),
    ).fetchone()[0]

    subs = conn.execute(
        "SELECT COUNT(*) FROM tg_subscribers WHERE channel_id = ?", (row["id"],)
    ).fetchone()[0]

    last_post = conn.execute(
        "SELECT id, text, created_at FROM tg_posts WHERE channel_id = ? AND deleted = 0 "
        "ORDER BY id DESC LIMIT 1",
        (row["id"],),
    ).fetchone()

    return {
        "id": row["id"],
        "name": row["name"],
        "description": row["description"] or "",
        "color": row["color"] or "#e53935",
        "is_public": bool(row["is_public"]),
        "owner": row["owner"],
        "created_at": row["created_at"],
        "subscribers": subs,
        "subscribed": subscribed,
        "is_owner": row["owner"] == viewer,
        "unread": 0 if row["owner"] == viewer else unread,
        "last_post": (
            {"id": last_post["id"], "text": last_post["text"][:120], "created_at": last_post["created_at"]}
            if last_post else None
        ),
    }


def _tg_post_dict(row: sqlite3.Row) -> dict:
    return {
        "id": row["id"],
        "channel_id": row["channel_id"],
        "author": row["author"],
        "text": "" if row["deleted"] else (row["text"] or ""),
        "edited": row["edited"],
        "deleted": row["deleted"],
        "created_at": row["created_at"],
    }


@app.get("/api/tg/channels")
async def list_tg_channels(user: str = Depends(auth_user)):
    conn = db_connect()
    mine = conn.execute(
        "SELECT * FROM tg_channels WHERE owner = ? ORDER BY id DESC", (user,)
    ).fetchall()
    subscribed_ids = [r["channel_id"] for r in conn.execute(
        "SELECT channel_id FROM tg_subscribers WHERE username = ?", (user,)
    ).fetchall()]

    rows = list(mine)
    for cid in subscribed_ids:
        if any(r["id"] == cid for r in rows):
            continue
        extra = conn.execute("SELECT * FROM tg_channels WHERE id = ?", (cid,)).fetchone()
        if extra:
            rows.append(extra)

    channels = [_tg_channel_payload(conn, r, user) for r in rows]
    conn.close()

    channels.sort(key=lambda c: (not c["is_owner"], -(c["last_post"]["created_at"] if c["last_post"] else 0)))
    return {"channels": channels}


@app.get("/api/tg/discover")
async def discover_tg_channels(q: str = "", user: str = Depends(auth_user)):
    conn = db_connect()
    query = (q or "").strip().casefold()
    rows = conn.execute(
        "SELECT * FROM tg_channels WHERE is_public = 1 ORDER BY id DESC LIMIT 60"
    ).fetchall()
    if query:
        # SQLite LOWER() не умеет юникод — фильтруем в Python
        rows = [
            r for r in rows
            if query in (r["name"] or "").casefold() or query in (r["description"] or "").casefold()
        ][:30]
    channels = [_tg_channel_payload(conn, r, user) for r in rows]
    conn.close()
    return {"channels": channels}


@app.post("/api/tg/channels")
async def create_tg_channel(data: TgChannelCreate, user: str = Depends(auth_user)):
    name = (data.name or "").strip()[:40]
    if len(name) < 2:
        raise HTTPException(400, "Название канала — минимум 2 символа")
    color = data.color if COLOR_RE.match(data.color or "") else "#e53935"
    description = (data.description or "").strip()[:300]
    now = int(time.time())

    conn = db_connect()
    cur = conn.execute(
        "INSERT INTO tg_channels (owner, name, description, color, is_public, created_at) "
        "VALUES (?, ?, ?, ?, ?, ?)",
        (user, name, description, color, 1 if data.is_public else 0, now),
    )
    channel_id = cur.lastrowid
    conn.execute(
        "INSERT INTO tg_subscribers (channel_id, username, created_at) VALUES (?, ?, ?)",
        (channel_id, user, now),
    )
    conn.execute(
        "INSERT INTO tg_posts (channel_id, author, text, created_at) VALUES (?, ?, ?, ?)",
        (channel_id, user, f"Канал «{name}» создан. Здесь будут публикации.", now),
    )
    conn.commit()
    row = conn.execute("SELECT * FROM tg_channels WHERE id = ?", (channel_id,)).fetchone()
    payload = _tg_channel_payload(conn, row, user)
    conn.close()
    return {"ok": True, "channel": payload}


@app.get("/api/tg/channels/{channel_id}")
async def get_tg_channel(channel_id: int, user: str = Depends(auth_user)):
    conn = db_connect()
    row = conn.execute("SELECT * FROM tg_channels WHERE id = ?", (channel_id,)).fetchone()
    if not row:
        conn.close()
        raise HTTPException(404, "Канал не найден")
    if not row["is_public"] and row["owner"] != user and not conn.execute(
        "SELECT 1 FROM tg_subscribers WHERE channel_id = ? AND username = ?", (channel_id, user)
    ).fetchone():
        conn.close()
        raise HTTPException(403, "Это закрытый канал")

    channel = _tg_channel_payload(conn, row, user)
    posts = [_tg_post_dict(p) for p in conn.execute(
        "SELECT * FROM tg_posts WHERE channel_id = ? ORDER BY id DESC LIMIT 100", (channel_id,)
    ).fetchall()][::-1]
    conn.close()
    return {"channel": channel, "posts": posts}


@app.post("/api/tg/channels/{channel_id}/posts")
async def create_tg_post(channel_id: int, data: TgPostIn, user: str = Depends(auth_user)):
    text = (data.text or "").strip()
    if not text:
        raise HTTPException(400, "Пустой пост")
    if len(text) > MAX_TG_POST:
        raise HTTPException(400, "Пост слишком длинный")

    conn = db_connect()
    row = conn.execute("SELECT owner, name FROM tg_channels WHERE id = ?", (channel_id,)).fetchone()
    if not row:
        conn.close()
        raise HTTPException(404, "Канал не найден")
    if row["owner"] != user:
        conn.close()
        raise HTTPException(403, "Публиковать может только владелец канала")

    cur = conn.execute(
        "INSERT INTO tg_posts (channel_id, author, text, created_at) VALUES (?, ?, ?, ?)",
        (channel_id, user, text, int(time.time())),
    )
    post_id = cur.lastrowid
    conn.commit()
    post = _tg_post_dict(conn.execute("SELECT * FROM tg_posts WHERE id = ?", (post_id,)).fetchone())
    subscribers = [r["username"] for r in conn.execute(
        "SELECT username FROM tg_subscribers WHERE channel_id = ?", (channel_id,)
    ).fetchall()]
    conn.close()

    payload = {
        "type": "tg_post",
        "channel_id": channel_id,
        "channel_name": row["name"],
        "post": post,
    }
    for username in subscribers:
        await send_to_user(username, payload)
    return {"ok": True, "post": post}


@app.post("/api/tg/posts/{post_id}/edit")
async def edit_tg_post(post_id: int, data: TgPostEdit, user: str = Depends(auth_user)):
    text = (data.text or "").strip()
    if not text:
        raise HTTPException(400, "Пустой пост")

    conn = db_connect()
    row = conn.execute(
        "SELECT p.id, p.channel_id, c.owner FROM tg_posts p "
        "JOIN tg_channels c ON c.id = p.channel_id WHERE p.id = ?",
        (post_id,),
    ).fetchone()
    if not row:
        conn.close()
        raise HTTPException(404, "Пост не найден")
    if row["owner"] != user:
        conn.close()
        raise HTTPException(403, "Это не твой канал")

    conn.execute("UPDATE tg_posts SET text = ?, edited = 1 WHERE id = ?", (text, post_id))
    conn.commit()
    post = _tg_post_dict(conn.execute("SELECT * FROM tg_posts WHERE id = ?", (post_id,)).fetchone())
    subscribers = [r["username"] for r in conn.execute(
        "SELECT username FROM tg_subscribers WHERE channel_id = ?", (row["channel_id"],)
    ).fetchall()]
    conn.close()

    for username in subscribers:
        await send_to_user(username, {"type": "tg_post_updated", "channel_id": row["channel_id"], "post": post})
    return {"ok": True, "post": post}


@app.delete("/api/tg/posts/{post_id}")
async def delete_tg_post(post_id: int, user: str = Depends(auth_user)):
    conn = db_connect()
    row = conn.execute(
        "SELECT p.channel_id, c.owner FROM tg_posts p JOIN tg_channels c ON c.id = p.channel_id "
        "WHERE p.id = ?",
        (post_id,),
    ).fetchone()
    if not row:
        conn.close()
        raise HTTPException(404, "Пост не найден")
    if row["owner"] != user:
        conn.close()
        raise HTTPException(403, "Это не твой канал")

    conn.execute("UPDATE tg_posts SET deleted = 1, text = '' WHERE id = ?", (post_id,))
    conn.commit()
    subscribers = [r["username"] for r in conn.execute(
        "SELECT username FROM tg_subscribers WHERE channel_id = ?", (row["channel_id"],)
    ).fetchall()]
    conn.close()

    for username in subscribers:
        await send_to_user(username, {
            "type": "tg_post_updated",
            "channel_id": row["channel_id"],
            "post": {"id": post_id, "channel_id": row["channel_id"], "author": user,
                     "text": "", "edited": 0, "deleted": 1, "created_at": int(time.time())},
        })
    return {"ok": True}


class TgChannelUpdate(BaseModel):
    name: Optional[str] = None
    description: Optional[str] = None
    is_public: Optional[bool] = None


@app.post("/api/tg/channels/{channel_id}/update")
async def update_tg_channel(channel_id: int, data: TgChannelUpdate, user: str = Depends(auth_user)):
    conn = db_connect()
    row = conn.execute("SELECT * FROM tg_channels WHERE id = ?", (channel_id,)).fetchone()
    if not row:
        conn.close()
        raise HTTPException(404, "Канал не найден")
    if row["owner"] != user:
        conn.close()
        raise HTTPException(403, "Это не твой канал")

    name = (data.name or "").strip()[:40] if data.name is not None else row["name"]
    if len(name) < 2:
        conn.close()
        raise HTTPException(400, "Название — минимум 2 символа")
    description = (data.description or "").strip()[:300] if data.description is not None else row["description"]
    is_public = int(bool(data.is_public)) if data.is_public is not None else row["is_public"]

    conn.execute(
        "UPDATE tg_channels SET name = ?, description = ?, is_public = ? WHERE id = ?",
        (name, description, is_public, channel_id),
    )
    conn.commit()
    row = conn.execute("SELECT * FROM tg_channels WHERE id = ?", (channel_id,)).fetchone()
    payload = _tg_channel_payload(conn, row, user)
    conn.close()
    return {"ok": True, "channel": payload}


@app.post("/api/tg/channels/{channel_id}/subscribe")
async def subscribe_tg(channel_id: int, user: str = Depends(auth_user)):
    conn = db_connect()
    row = conn.execute("SELECT owner, is_public FROM tg_channels WHERE id = ?", (channel_id,)).fetchone()
    if not row:
        conn.close()
        raise HTTPException(404, "Канал не найден")
    if not row["is_public"] and row["owner"] != user:
        conn.close()
        raise HTTPException(403, "Это закрытый канал")
    try:
        conn.execute(
            "INSERT INTO tg_subscribers (channel_id, username, created_at) VALUES (?, ?, ?)",
            (channel_id, user, int(time.time())),
        )
    except sqlite3.IntegrityError:
        pass
    conn.commit()
    conn.close()
    return {"ok": True}


@app.post("/api/tg/channels/{channel_id}/unsubscribe")
async def unsubscribe_tg(channel_id: int, user: str = Depends(auth_user)):
    conn = db_connect()
    row = conn.execute("SELECT owner FROM tg_channels WHERE id = ?", (channel_id,)).fetchone()
    if row and row["owner"] == user:
        conn.close()
        raise HTTPException(400, "Владелец не может отписаться от своего канала")
    conn.execute(
        "DELETE FROM tg_subscribers WHERE channel_id = ? AND username = ?", (channel_id, user)
    )
    conn.commit()
    conn.close()
    return {"ok": True}


@app.post("/api/tg/channels/{channel_id}/read")
async def read_tg_channel(channel_id: int, user: str = Depends(auth_user)):
    conn = db_connect()
    last_id = conn.execute(
        "SELECT COALESCE(MAX(id), 0) FROM tg_posts WHERE channel_id = ?", (channel_id,)
    ).fetchone()[0]
    conn.execute(
        """
        INSERT INTO tg_read (username, channel_id, last_read_id) VALUES (?, ?, ?)
        ON CONFLICT(username, channel_id) DO UPDATE SET last_read_id =
            MAX(tg_read.last_read_id, excluded.last_read_id)
        """,
        (user, channel_id, last_id),
    )
    conn.commit()
    conn.close()
    return {"ok": True, "last_read_id": last_id}


@app.delete("/api/tg/channels/{channel_id}")
async def delete_tg_channel(channel_id: int, user: str = Depends(auth_user)):
    conn = db_connect()
    row = conn.execute("SELECT owner FROM tg_channels WHERE id = ?", (channel_id,)).fetchone()
    if not row:
        conn.close()
        raise HTTPException(404, "Канал не найден")
    if row["owner"] != user:
        conn.close()
        raise HTTPException(403, "Это не твой канал")

    subscribers = [r["username"] for r in conn.execute(
        "SELECT username FROM tg_subscribers WHERE channel_id = ?", (channel_id,)
    ).fetchall()]
    conn.execute("DELETE FROM tg_posts WHERE channel_id = ?", (channel_id,))
    conn.execute("DELETE FROM tg_subscribers WHERE channel_id = ?", (channel_id,))
    conn.execute("DELETE FROM tg_read WHERE channel_id = ?", (channel_id,))
    conn.execute("DELETE FROM tg_channels WHERE id = ?", (channel_id,))
    conn.commit()
    conn.close()

    for username in subscribers:
        await send_to_user(username, {"type": "tg_channel_deleted", "channel_id": channel_id})
    return {"ok": True}


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


async def broadcast_profile(username: str, user: dict) -> None:
    """Сообщаем друзьям и всем вкладкам самого пользователя."""
    payload = {
        "type": "profile_updated",
        "user": {
            "username": username,
            "display_name": user["display_name"],
            "avatar_color": user["avatar_color"],
            "avatar_ver": user["avatar_ver"],
            "avatar_frame": user["avatar_frame"],
            "banner": user["banner"],
            "bio": user["bio"],
        },
    }
    await broadcast_to_friends(username, payload)
    await send_to_user(username, payload)


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

                conn.execute(
                    "UPDATE messages SET deleted = 1, text = '', pinned = 0, pinned_by = '', "
                    "pinned_at = 0 WHERE id = ?",
                    (mid,),
                )
                conn.commit()
                updated = fetch_message(conn, mid)
                conn.close()
                await _broadcast_message_update(updated)

            # ---------- ЗАКРЕПЛЕНИЕ В ЛИЧКЕ ----------
            elif msg_type == "pin_msg":
                try:
                    mid = int(msg.get("id"))
                except (TypeError, ValueError):
                    continue
                want_pinned = bool(msg.get("pinned", True))

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
                if username not in (row["from_user"], row["to_user"]):
                    conn.close()
                    await websocket.send_text(json.dumps({
                        "type": "error", "text": "Это чужой чат",
                    }, ensure_ascii=False))
                    continue
                if row["deleted"] and want_pinned:
                    conn.close()
                    continue

                now = int(time.time())
                conn.execute(
                    "UPDATE messages SET pinned = ?, pinned_by = ?, pinned_at = ? WHERE id = ?",
                    (1 if want_pinned else 0, username if want_pinned else "",
                     now if want_pinned else 0, mid),
                )
                conn.commit()
                updated = fetch_message(conn, mid)
                conn.close()

                payload = {"type": "pin_changed", "message": updated}
                await send_to_user(updated["from"], payload)
                await send_to_user(updated["to"], payload)

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


            # ---------- СООБЩЕНИЯ В КАНАЛАХ СЕРВЕРА ----------
            elif msg_type == "server_message":
                try:
                    channel_id = int(msg.get("channel_id"))
                except (TypeError, ValueError):
                    continue
                text = str(msg.get("text", "")).strip()
                client_id = msg.get("client_id")

                if not text or len(text) > MAX_SERVER_MSG:
                    await websocket.send_text(json.dumps({
                        "type": "error", "client_id": client_id, "text": "Пустое или слишком длинное сообщение",
                    }, ensure_ascii=False))
                    continue

                conn = db_connect()
                ch = conn.execute(
                    "SELECT id, server_id FROM server_channels WHERE id = ?", (channel_id,)
                ).fetchone()
                if not ch:
                    conn.close()
                    continue
                server_id = ch["server_id"]
                if not server_role(server_id, username):
                    conn.close()
                    await websocket.send_text(json.dumps({
                        "type": "error", "client_id": client_id, "text": "Ты не участник этого сервера",
                    }, ensure_ascii=False))
                    continue

                cur = conn.execute(
                    "INSERT INTO server_messages (channel_id, from_user, text, client_id, created_at) "
                    "VALUES (?, ?, ?, ?, ?)",
                    (channel_id, username, text, client_id, int(time.time())),
                )
                msg_id = cur.lastrowid
                conn.commit()
                row = conn.execute(
                    f"SELECT {SRV_MSG_COLUMNS} FROM server_messages WHERE id = ?",
                    (msg_id,),
                ).fetchone()
                payload = {"type": "server_message", "server_id": server_id,
                           **_server_message_dict(row, conn)}
                conn.close()

                await broadcast_to_server(server_id, payload)

            elif msg_type == "server_edit_msg":
                try:
                    mid = int(msg.get("id"))
                except (TypeError, ValueError):
                    continue
                text = str(msg.get("text", "")).strip()
                if not text or len(text) > MAX_SERVER_MSG:
                    continue

                conn = db_connect()
                row = conn.execute(
                    "SELECT m.id, m.from_user, m.channel_id, c.server_id FROM server_messages m "
                    "JOIN server_channels c ON c.id = m.channel_id WHERE m.id = ?",
                    (mid,),
                ).fetchone()
                if not row or row["from_user"] != username:
                    conn.close()
                    continue

                conn.execute("UPDATE server_messages SET text = ?, edited = 1 WHERE id = ?", (text, mid))
                conn.commit()
                updated = conn.execute(
                    f"SELECT {SRV_MSG_COLUMNS} FROM server_messages WHERE id = ?",
                    (mid,),
                ).fetchone()
                payload = {"type": "server_message_updated", "server_id": row["server_id"],
                           **_server_message_dict(updated, conn)}
                conn.close()
                await broadcast_to_server(row["server_id"], payload)

            elif msg_type == "server_delete_msg":
                try:
                    mid = int(msg.get("id"))
                except (TypeError, ValueError):
                    continue

                conn = db_connect()
                row = conn.execute(
                    "SELECT m.id, m.from_user, m.channel_id, c.server_id FROM server_messages m "
                    "JOIN server_channels c ON c.id = m.channel_id WHERE m.id = ?",
                    (mid,),
                ).fetchone()
                if not row:
                    conn.close()
                    continue

                can_delete = row["from_user"] == username or can_manage_server(row["server_id"], username)
                if not can_delete:
                    conn.close()
                    continue

                conn.execute(
                    "UPDATE server_messages SET deleted = 1, text = '', pinned = 0, "
                    "pinned_by = '', pinned_at = 0 WHERE id = ?",
                    (mid,),
                )
                conn.commit()
                updated = conn.execute(
                    f"SELECT {SRV_MSG_COLUMNS} FROM server_messages WHERE id = ?",
                    (mid,),
                ).fetchone()
                payload = {"type": "server_message_updated", "server_id": row["server_id"],
                           **_server_message_dict(updated, conn)}
                conn.close()
                await broadcast_to_server(row["server_id"], payload)

            elif msg_type == "server_pin_msg":
                try:
                    mid = int(msg.get("id"))
                except (TypeError, ValueError):
                    continue
                want_pinned = bool(msg.get("pinned", True))

                conn = db_connect()
                row = conn.execute(
                    "SELECT m.channel_id, m.deleted, c.server_id FROM server_messages m "
                    "JOIN server_channels c ON c.id = m.channel_id WHERE m.id = ?",
                    (mid,),
                ).fetchone()
                if not row or not server_role(row["server_id"], username):
                    conn.close()
                    continue
                if row["deleted"] and want_pinned:
                    conn.close()
                    continue

                now = int(time.time())
                conn.execute(
                    "UPDATE server_messages SET pinned = ?, pinned_by = ?, pinned_at = ? "
                    "WHERE id = ?",
                    (1 if want_pinned else 0, username if want_pinned else "",
                     now if want_pinned else 0, mid),
                )
                conn.commit()
                updated = conn.execute(
                    f"SELECT {SRV_MSG_COLUMNS} FROM server_messages WHERE id = ?", (mid,)
                ).fetchone()
                payload = {
                    "type": "server_pin_changed",
                    "server_id": row["server_id"],
                    "channel_id": row["channel_id"],
                    "message": _server_message_dict(updated, conn),
                }
                conn.close()
                await broadcast_to_server(row["server_id"], payload)

            elif msg_type == "server_typing":
                try:
                    channel_id = int(msg.get("channel_id"))
                except (TypeError, ValueError):
                    continue
                conn = db_connect()
                ch = conn.execute(
                    "SELECT server_id FROM server_channels WHERE id = ?", (channel_id,)
                ).fetchone()
                conn.close()
                if not ch or not server_role(ch["server_id"], username):
                    continue
                await broadcast_to_server(
                    ch["server_id"],
                    {"type": "server_typing", "channel_id": channel_id, "from": username},
                    exclude=username,
                )

            # ---------- ЗВОНКИ (WebRTC-СИГНАЛИНГ) ----------
            elif msg_type == "call":
                action = str(msg.get("action", "")).strip()
                call_id = str(msg.get("call_id", "")).strip()[:64]
                target = str(msg.get("to", "")).strip().lower()

                if action == "invite":
                    if not target or not call_id:
                        continue
                    if not user_exists(target):
                        await websocket.send_text(json.dumps({
                            "type": "call_error", "call_id": call_id, "text": "Пользователь не найден",
                        }, ensure_ascii=False))
                        continue
                    if not can_call(username, target):
                        await websocket.send_text(json.dumps({
                            "type": "call_error", "call_id": call_id,
                            "text": "Звонить можно друзьям и участникам своих серверов",
                        }, ensure_ascii=False))
                        continue

                    await send_to_user(target, {
                        "type": "call_incoming",
                        "call_id": call_id,
                        "from": username,
                        "from_name": (get_user(username) or {}).get("display_name", username),
                        "video": bool(msg.get("video")),
                        "screen": bool(msg.get("screen")),
                    })
                    continue

                if action in ("accept", "reject", "end", "busy", "signal"):
                    if not target:
                        continue
                    payload = {
                        "type": "call_" + action,
                        "call_id": call_id,
                        "from": username,
                    }
                    if action == "signal":
                        payload["data"] = msg.get("data")
                        payload["kind"] = msg.get("kind")
                    if action == "end":
                        payload["reason"] = msg.get("reason", "")
                    await send_to_user(target, payload)
                    continue

            # ---------- ПЕЧАТАЕТ В КАНАЛЕ ----------
            elif msg_type == "tg_typing":
                continue

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
    # index.html не кешируем, иначе после обновления остаётся старый script.js
    return FileResponse(
        FRONTEND_PATH / "index.html",
        headers={"Cache-Control": "no-cache, no-store, must-revalidate"},
    )


@app.get("/api/ice")
async def ice_servers(user: str = Depends(auth_user)):
    """ICE-серверы для звонков: STUN по умолчанию + TURN, если задан в окружении.

    TURN нужен, когда оба собеседника за строгими NAT — без него
    видео/экран может не пробиться. Настройка:
        SWAPTIME_TURN_URL=turn:turn.example.com:3478
        SWAPTIME_TURN_USER=user
        SWAPTIME_TURN_PASS=secret
    """
    servers = [
        {"urls": "stun:stun.l.google.com:19302"},
        {"urls": "stun:stun1.l.google.com:19302"},
        {"urls": "stun:global.stun.twilio.com:3478"},
    ]

    turn_urls = [u.strip() for u in os.environ.get("SWAPTIME_TURN_URL", "").split(",") if u.strip()]
    turn_user = os.environ.get("SWAPTIME_TURN_USER", "").strip()
    turn_pass = os.environ.get("SWAPTIME_TURN_PASS", "").strip()
    if turn_urls:
        entry = {"urls": turn_urls}
        if turn_user:
            entry["username"] = turn_user
            entry["credential"] = turn_pass
        servers.append(entry)

    return {"iceServers": servers, "turn": bool(turn_urls)}


@app.get("/manifest.webmanifest")
async def manifest():
    return FileResponse(
        FRONTEND_PATH / "manifest.webmanifest",
        media_type="application/manifest+json",
        headers={"Cache-Control": "no-cache"},
    )


@app.get("/sw.js")
async def service_worker():
    # service worker обязан лежать в корне scope, иначе не увидит всё приложение
    return FileResponse(
        FRONTEND_PATH / "sw.js",
        media_type="application/javascript",
        headers={"Cache-Control": "no-cache", "Service-Worker-Allowed": "/"},
    )


@app.get("/offline.html")
async def offline_page():
    return FileResponse(
        FRONTEND_PATH / "offline.html",
        headers={"Cache-Control": "no-cache, no-store, must-revalidate"},
    )


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
