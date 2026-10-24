// ============================================
// СВАПТАЙМ — FRONTEND (v7)
// ============================================
// Главные отличия от v5:
//   • сообщения больше не дублируются (client_id + сверка по id)
//   • редактирование/удаление работает и у собеседника
//   • ответы показывают автора и текст оригинала, кликом — переход
//   • непрочитанные бейджи реально живут и сбрасываются
//   • 10 шрифтов + живой предпросмотр
//   • токен реально используется, XSS через ники закрыт
// ============================================

const FALLBACK_FONTS = [
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
];

const FONT_LABELS = {
  "Inter, sans-serif": "Inter — по умолчанию",
  "Roboto, sans-serif": "Roboto",
  "Montserrat, sans-serif": "Montserrat",
  "Open Sans, sans-serif": "Open Sans",
  "Lato, sans-serif": "Lato",
  "Poppins, sans-serif": "Poppins",
  "Raleway, sans-serif": "Raleway",
  "Nunito, sans-serif": "Nunito",
  "Merriweather, serif": "Merriweather — с засечками",
  "JetBrains Mono, monospace": "JetBrains Mono — моноширинный",
};

const state = {
  token: localStorage.getItem("swaptime_token") || null,
  user: null,
  chats: [],
  friends: [],
  requests: [],
  outgoing: [],
  blocked: [],
  ignored: [],
  fonts: FALLBACK_FONTS.slice(),
  current: null,          // ник открытого чата
  messages: new Map(),    // id -> сообщение
  byClientId: new Map(),  // client_id -> сообщение
  ws: null,
  wsOpen: false,
  wsQueue: [],
  reconnectDelay: 1000,
  reconnectTimer: null,
  heartbeat: null,
  shouldReconnect: true,
  replyTo: null,
  editing: null,
  typingHideTimer: null,
  lastTypingSent: 0,
  readTimers: {},
  lastReadSent: {},
  modalUser: null,
};

// ============================================
// МЕЛОЧИ
// ============================================
const $ = (id) => document.getElementById(id);

function el(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined && text !== null) node.textContent = text;
  return node;
}

function clear(node) {
  while (node.firstChild) node.removeChild(node.firstChild);
}

function initial(name) {
  const str = (name || "?").trim();
  return str ? str[0].toUpperCase() : "?";
}

function safeColor(color) {
  return /^#[0-9a-fA-F]{6}$/.test(color || "") ? color : "#e53935";
}

function formatTime(tsSeconds) {
  const d = tsSeconds ? new Date(tsSeconds * 1000) : new Date();
  return d.toLocaleTimeString("ru-RU", { hour: "2-digit", minute: "2-digit" });
}

function formatChatTime(tsSeconds) {
  if (!tsSeconds) return "";
  const date = new Date(tsSeconds * 1000);
  const now = new Date();
  const startOfToday = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  const startOfDate = new Date(date.getFullYear(), date.getMonth(), date.getDate());
  const diffDays = Math.round((startOfToday - startOfDate) / 86400000);
  if (diffDays === 0) return formatTime(tsSeconds);
  if (diffDays === 1) return "вчера";
  if (diffDays < 7) {
    return date.toLocaleDateString("ru-RU", { weekday: "short" });
  }
  return date.toLocaleDateString("ru-RU", { day: "2-digit", month: "2-digit" });
}

function fullDate(tsSeconds) {
  const date = new Date(tsSeconds * 1000);
  return date.toLocaleDateString("ru-RU", { day: "2-digit", month: "long" });
}

function uuid() {
  if (window.crypto && crypto.randomUUID) return crypto.randomUUID();
  return "c-" + Date.now().toString(36) + "-" + Math.random().toString(36).slice(2, 10);
}

function toast(text, type = "info", ms = 3200) {
  const box = $("toast-container");
  if (!box) return;
  const node = el("div", "toast " + type, text);
  box.appendChild(node);
  setTimeout(() => {
    node.classList.add("hide");
    setTimeout(() => node.remove(), 250);
  }, ms);
}

// ============================================
// API
// ============================================
class ApiError extends Error {
  constructor(message, status) {
    super(message);
    this.status = status;
  }
}

async function api(path, options = {}) {
  const { method = "GET", body, auth = true } = options;
  const headers = {};
  if (body !== undefined) headers["Content-Type"] = "application/json";
  if (auth && state.token) headers["Authorization"] = "Bearer " + state.token;

  let resp;
  try {
    resp = await fetch(path, {
      method,
      headers,
      body: body === undefined ? undefined : JSON.stringify(body),
    });
  } catch (err) {
    throw new ApiError("Сервер недоступен", 0);
  }

  let data = null;
  const raw = await resp.text();
  if (raw) {
    try {
      data = JSON.parse(raw);
    } catch (err) {
      data = null;
    }
  }

  if (!resp.ok) {
    if (resp.status === 401 && auth) handleSessionExpired();
    const detail = data && (data.detail || data.message);
    throw new ApiError(typeof detail === "string" ? detail : "Ошибка сервера", resp.status);
  }
  return data;
}

function handleSessionExpired() {
  if (!state.token) return;
  toast("Сессия истекла, войди заново", "error");
  clearSession();
  showScreen("auth");
}

function clearSession() {
  localStorage.removeItem("swaptime_token");
  localStorage.removeItem("swaptime_user");
  state.token = null;
  state.user = null;
  state.shouldReconnect = false;
  if (state.ws) {
    try { state.ws.close(); } catch (e) {}
  }
}

// ============================================
// ЭКРАНЫ / ТЕМА
// ============================================
function showScreen(name) {
  document.querySelectorAll(".screen").forEach((screen) => {
    screen.classList.remove("active");
    screen.style.display = "none";
  });
  const target = $(name + "-screen");
  if (target) {
    target.classList.add("active");
    target.style.display = name === "auth" ? "flex" : "block";
  }
  document.body.classList.toggle("on-chat", name === "chat");
}

function applyFont(font) {
  const value = font && font.trim() ? font : FALLBACK_FONTS[0];
  document.documentElement.style.setProperty("--app-font", value);
}

function applyTheme() {
  if (!state.user) return;
  applyFont(state.user.font_family);
  $("my-name").textContent = state.user.display_name || state.user.username;
  $("my-avatar").textContent = initial(state.user.display_name || state.user.username);
  $("my-avatar").style.background = safeColor(state.user.avatar_color);
}

// ============================================
// КАПЧА (починена: единственный выбор, ошибки сбрасываются)
// ============================================
let captchaAnswer = null;
let captchaSolved = false;

function generateCaptcha() {
  const a = Math.floor(Math.random() * 10) + 1;
  const b = Math.floor(Math.random() * 10) + 1;
  captchaAnswer = a + b;
  captchaSolved = false;

  $("captcha-question").textContent = `Сколько будет ${a} + ${b}?`;

  const options = new Set([captchaAnswer]);
  while (options.size < 4) options.add(Math.floor(Math.random() * 20) + 1);

  const shuffled = Array.from(options).sort(() => Math.random() - 0.5);
  const container = $("captcha-options");
  clear(container);

  shuffled.forEach((num) => {
    const btn = el("button", "captcha-btn", String(num));
    btn.type = "button";
    btn.addEventListener("click", () => {
      container.querySelectorAll(".captcha-btn").forEach((b) => {
        b.classList.remove("correct", "wrong");
      });
      if (num === captchaAnswer) {
        btn.classList.add("correct");
        captchaSolved = true;
      } else {
        btn.classList.add("wrong");
        captchaSolved = false;
      }
    });
    container.appendChild(btn);
  });
}

// ============================================
// АВТОРИЗАЦИЯ
// ============================================
async function submitAuth(kind) {
  const isLogin = kind === "login";
  const btn = $(isLogin ? "login-submit" : "register-submit");
  const errorEl = $(isLogin ? "login-error" : "register-error");
  errorEl.textContent = "";
  btn.disabled = true;
  btn.textContent = isLogin ? "Вхожу…" : "Создаю…";

  try {
    if (isLogin) {
      const username = $("login-username").value.trim().toLowerCase();
      const password = $("login-password").value;
      if (!username || !password) throw new ApiError("Заполни все поля", 400);

      const data = await api("/api/login", {
        method: "POST",
        auth: false,
        body: { username, password },
      });
      finishAuth(data);
    } else {
      const username = $("reg-username").value.trim().toLowerCase();
      const display_name = $("reg-display-name").value.trim();
      const email = $("reg-email").value.trim().toLowerCase();
      const password = $("reg-password").value;
      const password2 = $("reg-password-2").value;

      if (!username || !password || !password2) throw new ApiError("Заполни обязательные поля", 400);
      if (!/^[a-z0-9_]{3,20}$/.test(username)) throw new ApiError("Ник: 3–20 символов, латиница/цифры/_", 400);
      if (email && (!email.includes("@") || !email.split("@")[1].includes("."))) {
        throw new ApiError("Неверный email", 400);
      }
      if (password.length < 4) throw new ApiError("Пароль — минимум 4 символа", 400);
      if (password !== password2) throw new ApiError("Пароли не совпадают", 400);
      if (!captchaSolved) throw new ApiError("Пройди капчу", 400);

      const data = await api("/api/register", {
        method: "POST",
        auth: false,
        body: { username, password, display_name, email },
      });
      finishAuth(data);
    }
  } catch (err) {
    errorEl.textContent = err.message || "Ошибка";
    if (!isLogin) generateCaptcha();
  } finally {
    btn.disabled = false;
    btn.textContent = isLogin ? "Войти" : "Создать аккаунт";
  }
}

function doLogin() { submitAuth("login"); }
function doRegister() { submitAuth("register"); }

function finishAuth(data) {
  state.token = data.token;
  state.user = data.user;
  localStorage.setItem("swaptime_token", data.token);
  localStorage.setItem("swaptime_user", JSON.stringify(data.user));
  $("login-error").textContent = "";
  $("register-error").textContent = "";
  enterApp();
}

async function logout() {
  state.shouldReconnect = false;
  if (state.reconnectTimer) clearTimeout(state.reconnectTimer);
  if (state.heartbeat) clearInterval(state.heartbeat);
  try {
    if (state.token) await api("/api/logout", { method: "POST" });
  } catch (e) {}
  if (state.ws) {
    try { state.ws.close(); } catch (e) {}
  }
  clearSession();
  location.reload();
}

// ============================================
// СТАРТ ПРИЛОЖЕНИЯ
// ============================================
async function enterApp() {
  state.shouldReconnect = true;
  applyTheme();
  showScreen("chat");

  try {
    const data = await api("/api/me");
    state.user = data.user;
    state.fonts = data.fonts && data.fonts.length ? data.fonts : FALLBACK_FONTS;
    localStorage.setItem("swaptime_user", JSON.stringify(state.user));
    applyTheme();
  } catch (err) {
    if (err.status === 401) return;
  }

  await refreshChats();
  connectWS();
  renderTitle();
}

async function refreshChats() {
  try {
    const [chatsData, friendsData] = await Promise.all([
      api("/api/chats"),
      api("/api/friends"),
    ]);
    state.chats = chatsData.chats || [];
    state.friends = friendsData.friends || [];
    state.requests = friendsData.requests || [];
    state.outgoing = friendsData.outgoing || [];
    state.blocked = friendsData.blocked || [];
    state.ignored = friendsData.ignored || [];

    // если открытый чат перестал существовать (удалили из друзей / блок)
    if (state.current && !state.chats.some((c) => c.username === state.current)) {
      closeChat();
      toast("Диалог больше недоступен", "warn");
    }
    if (state.current) {
      const chat = state.chats.find((c) => c.username === state.current);
      if (chat) updateChatHeader(chat);
    }
    renderSidebar();
    renderTitle();
  } catch (err) {
    if (err.status !== 401) toast(err.message || "Не удалось загрузить чаты", "error");
  }
}

function getChat(username) {
  return state.chats.find((c) => c.username === username) || null;
}

function sortChats() {
  state.chats.sort((a, b) => {
    const ta = a.last_message ? a.last_message.created_at : 0;
    const tb = b.last_message ? b.last_message.created_at : 0;
    return tb - ta;
  });
}

// ============================================
// БОКОВАЯ ПАНЕЛЬ
// ============================================
function previewText(msg) {
  if (!msg) return "Нет сообщений";
  if (msg.deleted) return "Сообщение удалено";
  const prefix = msg.from === state.user.username ? "Ты: " : "";
  const reply = msg.reply_to ? "↩ " : "";
  return reply + prefix + (msg.text || "");
}

function renderSidebar() {
  const listEl = $("users-list");
  const query = ($("search-users").value || "").trim().toLowerCase();
  clear(listEl);

  if (state.chats.length === 0) {
    const empty = el("div", "empty-state");
    empty.appendChild(el("div", "empty-state-icon", "👥"));
    empty.appendChild(el("div", "empty-state-text", "Пока нет друзей"));
    empty.appendChild(el("div", "empty-state-hint", "Нажми «Добавить друга» и введи ник"));
    listEl.appendChild(empty);
  } else {
    state.chats.forEach((chat) => {
      const holder = el("div", "user-item");
      holder.dataset.username = chat.username;
      if (chat.username === state.current) holder.classList.add("active");

      const avatarWrap = el("div", "avatar-wrap");
      const avatar = el("div", "avatar", initial(chat.display_name || chat.username));
      avatar.style.background = safeColor(chat.avatar_color);
      avatarWrap.appendChild(avatar);
      if (chat.online) avatarWrap.appendChild(el("span", "online-dot"));

      const info = el("div", "user-item-info");
      const top = el("div", "user-item-top");
      top.appendChild(el("span", "user-item-name", chat.display_name || chat.username));
      if (chat.last_message) {
        top.appendChild(el("span", "user-item-time", formatChatTime(chat.last_message.created_at)));
      }

      const bottom = el("div", "user-item-bottom");
      const preview = el("span", "user-item-status", previewText(chat.last_message));
      if (chat.last_message && chat.last_message.from === state.user.username) {
        preview.classList.add("own-preview");
      }
      bottom.appendChild(preview);
      if (chat.unread > 0) {
        bottom.appendChild(el("span", "unread-badge", chat.unread > 99 ? "99+" : String(chat.unread)));
      }

      info.appendChild(top);
      info.appendChild(bottom);
      holder.appendChild(avatarWrap);
      holder.appendChild(info);
      holder.addEventListener("click", () => openChat(chat.username));

      if (query) {
        const haystack = ((chat.display_name || "") + " " + chat.username).toLowerCase();
        if (!haystack.includes(query)) holder.style.display = "none";
      }
      listEl.appendChild(holder);
    });
  }

  renderRequests();
}

function renderRequests() {
  const block = $("requests-block");
  const list = $("requests-list");
  clear(list);

  if (!state.requests.length) {
    block.style.display = "none";
    return;
  }
  block.style.display = "block";

  state.requests.forEach((req) => {
    const item = el("div", "request-item");
    const name = el("div", "request-name", "@" + req.username);
    const actions = el("div", "request-actions");

    const accept = el("button", "request-btn accept", "✓");
    accept.title = "Принять";
    accept.addEventListener("click", () => acceptFriend(req.username));

    const decline = el("button", "request-btn decline", "✕");
    decline.title = "Отклонить";
    decline.addEventListener("click", () => declineFriend(req.username));

    actions.appendChild(accept);
    actions.appendChild(decline);
    item.appendChild(name);
    item.appendChild(actions);
    list.appendChild(item);
  });
}

async function acceptFriend(username) {
  try {
    await api("/api/friends/accept", { method: "POST", body: { to_user: username } });
    toast("Теперь вы друзья: @" + username, "success");
    await refreshChats();
  } catch (err) {
    toast(err.message, "error");
  }
}

async function declineFriend(username) {
  try {
    await api("/api/friends/decline", { method: "POST", body: { to_user: username } });
    await refreshChats();
  } catch (err) {
    toast(err.message, "error");
  }
}

// ============================================
// ЧАТ
// ============================================
async function openChat(username) {
  if (!username) return;
  cancelReply();
  cancelEdit();

  state.current = username;
  $("chat-screen").classList.add("chat-open");
  $("no-chat").style.display = "none";
  $("chat-active").style.display = "flex";

  const chat = getChat(username);
  const displayName = chat ? chat.display_name || chat.username : username;
  $("chat-name").textContent = displayName;
  $("chat-avatar").textContent = initial(displayName);
  $("chat-avatar").style.background = safeColor(chat ? chat.avatar_color : null);
  updateChatHeader(chat);

  renderSidebar();

  // история
  clear($("messages"));
  state.messages.clear();
  state.byClientId.clear();
  $("messages").appendChild(el("div", "messages-loading", "Загружаю историю…"));

  try {
    const history = await api(
      `/api/messages/${encodeURIComponent(state.user.username)}/${encodeURIComponent(username)}`
    );
    // пока грузили историю, могли открыть другой чат
    if (state.current !== username) return;
    clear($("messages"));
    if (!history.length) {
      const empty = el("div", "chat-empty", "Начни разговор первым 👋");
      $("messages").appendChild(empty);
    } else {
      history.forEach((msg) => appendMessage(msg, false));
    }
    scrollToBottom();
  } catch (err) {
    if (state.current !== username) return;
    clear($("messages"));
    $("messages").appendChild(el("div", "messages-loading", err.message || "Не удалось загрузить историю"));
  }

  if (state.current !== username) return;
  markRead(username);
  renderTitle();

  if (window.matchMedia("(min-width: 761px)").matches) {
    $("message-input").focus();
  }
}

function updateChatHeader(chat) {
  if (!chat) {
    $("chat-status").textContent = "@" + (state.current || "");
    $("chat-online-dot").style.display = "none";
    return;
  }
  $("chat-name").textContent = chat.display_name || chat.username;
  $("chat-avatar").textContent = initial(chat.display_name || chat.username);
  $("chat-avatar").style.background = safeColor(chat.avatar_color);

  const dot = $("chat-online-dot");
  if (chat.online) {
    dot.style.display = "block";
    $("chat-status").textContent = "@" + chat.username + " · в сети";
    $("chat-status").classList.add("online");
  } else {
    dot.style.display = "none";
    $("chat-status").textContent = "@" + chat.username;
    $("chat-status").classList.remove("online");
  }
}

function closeChat() {
  state.current = null;
  $("chat-screen").classList.remove("chat-open");
  $("chat-active").style.display = "none";
  $("no-chat").style.display = "flex";
  clear($("messages"));
  state.messages.clear();
  state.byClientId.clear();
  $("typing-line").style.display = "none";
  cancelReply();
  cancelEdit();
  renderSidebar();
  renderTitle();
}

function closeChatMobile() {
  closeChat();
}

function openChatProfile() {
  const chat = getChat(state.current);
  if (!chat) return;
  openProfile(chat);
}

function scrollToBottom() {
  const box = $("messages");
  box.scrollTop = box.scrollHeight;
}

function isNearBottom() {
  const box = $("messages");
  return box.scrollHeight - box.scrollTop - box.clientHeight < 120;
}

// ============================================
// ОТРИСОВКА СООБЩЕНИЙ
// ============================================
function displayNameFor(username) {
  if (!state.user) return username;
  if (username === state.user.username) return state.user.display_name || username;
  const chat = getChat(username);
  return chat ? chat.display_name || chat.username : username;
}

function buildMessageNode(msg) {
  const isOwn = msg.from === state.user.username;
  const wrapper = el("div", "message-wrapper" + (isOwn ? " own" : ""));
  if (msg.id) wrapper.dataset.msgId = String(msg.id);
  if (msg.client_id) wrapper.dataset.clientId = String(msg.client_id);
  if (msg.pending) wrapper.classList.add("pending");
  if (msg.failed) wrapper.classList.add("failed");

  const bubble = el("div", "message " + (isOwn ? "own" : "other"));

  if (msg.reply_to) {
    const quote = el("button", "reply-quote");
    quote.type = "button";
    const preview = msg.reply_preview;
    const quotedName = preview
      ? preview.from === state.user.username
        ? "Себе"
        : displayNameFor(preview.from)
      : "сообщение";
    quote.appendChild(el("span", "reply-quote-author", quotedName));
    quote.appendChild(
      el(
        "span",
        "reply-quote-text",
        preview ? (preview.deleted ? "Сообщение удалено" : preview.text || "…") : "Сообщение удалено"
      )
    );
    if (msg.reply_to) {
      quote.dataset.targetReply = String(msg.reply_to);
      quote.addEventListener("click", () => focusMessage(msg.reply_to));
    }
    bubble.appendChild(quote);
  }

  const textEl = el("div", "message-text");
  if (msg.deleted) {
    textEl.classList.add("deleted-text");
    textEl.textContent = "Сообщение удалено";
  } else {
    textEl.textContent = msg.text || "";
  }
  bubble.appendChild(textEl);

  const meta = el("div", "message-meta");
  if (msg.edited && !msg.deleted) meta.appendChild(el("span", "edited-mark", "изм."));
  meta.appendChild(el("span", "message-time", formatTime(msg.created_at)));
  if (msg.pending) {
    meta.appendChild(el("span", "msg-status", "🕓"));
    meta.title = "Отправляется…";
  }
  if (msg.failed) {
    meta.appendChild(el("span", "msg-status failed", "⚠"));
    meta.title = "Не отправлено";
    wrapper.title = "Нажми, чтобы отправить снова";
    wrapper.addEventListener("click", (event) => {
      if (event.target.closest(".msg-btn, .reply-quote")) return;
      retryMessage(msg);
    });
  }
  bubble.appendChild(meta);
  wrapper.appendChild(bubble);

  // действия
  if (!msg.deleted) {
    const actions = el("div", "message-actions");

    const replyBtn = el("button", "msg-btn", "↩");
    replyBtn.type = "button";
    replyBtn.title = "Ответить";
    replyBtn.addEventListener("click", () => startReply(msg));
    actions.appendChild(replyBtn);

    if (isOwn && msg.id) {
      const editBtn = el("button", "msg-btn", "✏️");
      editBtn.type = "button";
      editBtn.title = "Редактировать";
      editBtn.addEventListener("click", () => startEdit(msg.id));
      actions.appendChild(editBtn);

      const deleteBtn = el("button", "msg-btn", "🗑️");
      deleteBtn.type = "button";
      deleteBtn.title = "Удалить";
      deleteBtn.addEventListener("click", () => deleteMessage(msg.id));
      actions.appendChild(deleteBtn);
    }
    wrapper.appendChild(actions);
  }

  return wrapper;
}

function appendMessage(msg, animate = true) {
  const list = $("messages");
  const placeholder = list.querySelector(".chat-empty, .messages-loading");
  if (placeholder) placeholder.remove();

  const node = buildMessageNode(msg);
  if (!animate) node.classList.add("no-anim");
  list.appendChild(node);

  if (msg.id) state.messages.set(msg.id, msg);
  if (msg.client_id) state.byClientId.set(msg.client_id, msg);
}

/** Находит существующий узел сообщения (по id или client_id) */
function findMessageNode(msg) {
  const list = $("messages");
  if (msg.id) {
    const byId = list.querySelector(`[data-msg-id="${msg.id}"]`);
    if (byId) return byId;
  }
  if (msg.client_id) {
    const attr = String(msg.client_id).replace(/["\\]/g, "\\$&");
    const byClient = list.querySelector(`[data-client-id="${attr}"]`);
    if (byClient) return byClient;
  }
  return null;
}

/** Добавляет сообщение или обновляет существующее — БЕЗ дублей */
function upsertMessage(msg) {
  const sticky = isNearBottom();
  const existing = findMessageNode(msg);
  const node = buildMessageNode(msg);

  if (existing) {
    existing.replaceWith(node);
  } else {
    const list = $("messages");
    const placeholder = list.querySelector(".chat-empty, .messages-loading");
    if (placeholder) placeholder.remove();
    list.appendChild(node);
  }

  if (msg.id) state.messages.set(msg.id, msg);
  if (msg.client_id) state.byClientId.set(msg.client_id, msg);

  if (sticky || msg.from === state.user.username) scrollToBottom();
}

function findMessageObject(id) {
  if (state.messages.has(id)) return state.messages.get(id);
  for (const [, msg] of state.byClientId) {
    if (msg.id === id) return msg;
  }
  return null;
}

function focusMessage(id) {
  const node = $("messages").querySelector(`[data-msg-id="${id}"]`);
  if (!node) {
    toast("Оригинал не в этом чате или уже удалён", "warn");
    return;
  }
  node.scrollIntoView({ behavior: "smooth", block: "center" });
  node.classList.add("highlight");
  setTimeout(() => node.classList.remove("highlight"), 1200);
}

// ============================================
// ОТПРАВКА / ОТВЕТ / РЕДАКТИРОВАНИЕ / УДАЛЕНИЕ
// ============================================
function sendMessage() {
  if (state.editing) {
    saveEdit();
    return;
  }

  const input = $("message-input");
  const text = input.value.trim();
  if (!text || !state.current) return;

  const clientId = uuid();
  const replyTo = state.replyTo ? state.replyTo.id : 0;
  const replyPreview = state.replyTo
    ? {
        id: state.replyTo.id,
        from: state.replyTo.from,
        text: state.replyTo.text || "",
        deleted: state.replyTo.deleted || 0,
      }
    : null;

  const optimistic = {
    id: null,
    client_id: clientId,
    from: state.user.username,
    to: state.current,
    text,
    reply_to: replyTo,
    reply_preview: replyPreview,
    edited: 0,
    deleted: 0,
    created_at: Math.floor(Date.now() / 1000),
    pending: true,
  };

  upsertMessage(optimistic);
  updateChatFromMessage(optimistic);

  input.value = "";
  cancelReply();
  input.focus();

  sendWS({
    type: "message",
    to: optimistic.to,
    text,
    client_id: clientId,
    reply_to: replyTo,
  });
}

function sendWS(payload) {
  if (state.wsOpen && state.ws && state.ws.readyState === WebSocket.OPEN) {
    state.ws.send(JSON.stringify(payload));
    return true;
  }
  if (payload.type === "message") {
    state.wsQueue.push(payload);
    toast("Нет связи — сообщение уйдёт после переподключения", "warn");
  }
  return false;
}

function startReply(msg) {
  if (!msg) return;
  cancelEdit();
  state.replyTo = msg;
  $("reply-author").textContent = msg.from === state.user.username ? "(себе)" : displayNameFor(msg.from);
  $("reply-text").textContent = msg.deleted ? "Сообщение удалено" : msg.text || "";
  $("reply-box").style.display = "flex";
  $("message-input").focus();
}

function cancelReply() {
  state.replyTo = null;
  $("reply-box").style.display = "none";
}

function startEdit(id) {
  const msg = findMessageObject(id);
  if (!msg || msg.deleted) return;
  if (msg.from !== state.user.username) {
    toast("Можно редактировать только свои сообщения", "warn");
    return;
  }
  cancelReply();
  state.editing = msg;
  const input = $("message-input");
  input.value = msg.text || "";
  input.focus();
  input.setSelectionRange(input.value.length, input.value.length);
  $("edit-text").textContent = msg.text || "";
  $("edit-box").style.display = "flex";
  $("send-btn").textContent = "✓";
  $("send-btn").title = "Сохранить";
}

function cancelEdit() {
  if (!state.editing) return;
  state.editing = null;
  $("edit-box").style.display = "none";
  $("message-input").value = "";
  $("send-btn").textContent = "➤";
  $("send-btn").title = "Отправить";
}

function saveEdit() {
  const msg = state.editing;
  if (!msg) return;
  const text = $("message-input").value.trim();
  if (!text) {
    toast("Текст не может быть пустым", "warn");
    return;
  }
  if (text === msg.text) {
    cancelEdit();
    return;
  }

  const sent = sendWS({ type: "edit_msg", id: msg.id, text });
  if (!sent) {
    api("/api/messages/edit", { method: "POST", body: { message_id: msg.id, new_text: text } })
      .then((res) => onMessageUpdated(res.message))
      .catch((err) => toast(err.message, "error"));
  }
  cancelEdit();
}

function retryMessage(msg) {
  if (!msg || !msg.failed) return;
  msg.failed = false;
  msg.pending = true;

  const node = findMessageNode(msg);
  if (node) node.replaceWith(buildMessageNode(msg));

  const payload = {
    type: "message",
    to: msg.to,
    text: msg.text,
    client_id: msg.client_id,
    reply_to: msg.reply_to || 0,
  };
  if (!state.wsOpen) state.wsQueue.push(payload);
  else state.ws.send(JSON.stringify(payload));
}

function deleteMessage(id) {
  const msg = findMessageObject(id);
  if (!msg) return;
  if (!confirm("Удалить сообщение?")) return;

  const sent = sendWS({ type: "delete_msg", id });
  if (!sent) {
    api("/api/messages/delete", { method: "POST", body: { message_id: id } })
      .then((res) => onMessageUpdated(res.message))
      .catch((err) => toast(err.message, "error"));
  }
}

// ============================================
// WEBSOCKET
// ============================================
function connectWS() {
  if (!state.token) return;
  if (state.ws && (state.ws.readyState === WebSocket.CONNECTING || state.ws.readyState === WebSocket.OPEN)) {
    return;
  }

  const proto = window.location.protocol === "https:" ? "wss:" : "ws:";
  const url = `${proto}//${window.location.host}/ws?token=${encodeURIComponent(state.token)}`;

  let socket;
  try {
    socket = new WebSocket(url);
  } catch (err) {
    scheduleReconnect();
    return;
  }
  state.ws = socket;

  socket.onopen = () => {
    state.wsOpen = true;
    state.reconnectDelay = 1000;
    console.log("🟢 WebSocket подключён");

    // догоняем то, что не ушло пока не было связи
    const queue = state.wsQueue.slice();
    state.wsQueue = [];
    queue.forEach((payload) => {
      socket.send(JSON.stringify(payload));
    });

    // перечитываем данные — могли прийти сообщения, пока были офлайн
    refreshChats();
    if (state.current) reloadCurrentChat();

    if (state.heartbeat) clearInterval(state.heartbeat);
    state.heartbeat = setInterval(() => {
      if (socket.readyState === WebSocket.OPEN) socket.send(JSON.stringify({ type: "ping" }));
    }, 25000);
  };

  socket.onmessage = (event) => {
    let msg;
    try {
      msg = JSON.parse(event.data);
    } catch (err) {
      return;
    }
    handleSocketMessage(msg);
  };

  socket.onclose = (event) => {
    state.wsOpen = false;
    if (state.ws === socket) state.ws = null;
    if (state.heartbeat) clearInterval(state.heartbeat);
    console.log("🔴 WebSocket отключён", event.code);

    if (event.code === 4401) {
      handleSessionExpired();
      return;
    }
    scheduleReconnect();
  };

  socket.onerror = () => {
    try { socket.close(); } catch (e) {}
  };
}

function scheduleReconnect() {
  if (!state.shouldReconnect || !state.token) return;
  if (state.reconnectTimer) clearTimeout(state.reconnectTimer);
  const delay = state.reconnectDelay;
  state.reconnectDelay = Math.min(state.reconnectDelay * 1.7, 15000);
  state.reconnectTimer = setTimeout(() => {
    state.reconnectTimer = null;
    connectWS();
  }, delay);
}

async function reloadCurrentChat() {
  const username = state.current;
  if (!username) return;
  try {
    const history = await api(
      `/api/messages/${encodeURIComponent(state.user.username)}/${encodeURIComponent(username)}`
    );
    if (state.current !== username) return;
    clear($("messages"));
    state.messages.clear();
    state.byClientId.clear();
    history.forEach((msg) => appendMessage(msg, false));
    scrollToBottom();
  } catch (err) {
    // тихо
  }
}

function handleSocketMessage(msg) {
  switch (msg.type) {
    case "message":
      onIncomingMessage(msg);
      break;
    case "message_updated":
      onMessageUpdated(msg);
      break;
    case "read_sync": {
      const chat = getChat(msg.chat_with);
      if (chat) chat.unread = 0;
      renderSidebar();
      renderTitle();
      break;
    }
    case "read":
      break;
    case "presence":
      onPresence(msg);
      break;
    case "typing":
      onTyping(msg);
      break;
    case "friend_request":
      refreshChats();
      toast("@" + msg.from + " хочет добавить тебя в друзья", "info");
      break;
    case "friend_changed":
      refreshChats();
      break;
    case "profile_updated":
      onFriendProfileUpdated(msg.user);
      break;
    case "error":
      handleServerError(msg);
      break;
    case "pong":
      break;
    default:
      break;
  }
}

function handleServerError(msg) {
  toast(msg.text || "Ошибка", "error");

  if (msg.client_id) {
    const node = $("messages").querySelector(
      `[data-client-id="${String(msg.client_id).replace(/["\\]/g, "\\$&")}"]`
    );
    if (node) {
      node.classList.remove("pending");
      node.classList.add("failed");
      const status = node.querySelector(".msg-status");
      if (status) {
        status.textContent = "⚠";
        status.title = msg.text || "Ошибка";
      }
    }
  }
}

function onIncomingMessage(msg) {
  const isOwn = msg.from === state.user.username;
  const peer = isOwn ? msg.to : msg.from;
  const isCurrent = state.current === peer;

  const focused = document.hasFocus() && document.visibilityState === "visible";

  if (isCurrent) {
    upsertMessage(msg);
    if (!isOwn) {
      $("typing-line").style.display = "none";
      if (focused) markRead(peer);
    }
  }

  // обновляем превью/сортировку в списке
  updateChatFromMessage(msg);

  if (!isOwn) {
    const chat = getChat(peer);
    // чат не открыт ИЛИ окно не в фокусе — считаем непрочитанным
    if (chat && (!isCurrent || !focused)) {
      chat.unread = (chat.unread || 0) + 1;
      renderSidebar();
      renderTitle();
    }
  }
}

function onMessageUpdated(msg) {
  if (!msg) return;
  const peer = msg.from === state.user.username ? msg.to : msg.from;

  if (state.current === peer) {
    upsertMessage(msg);
    // если открыт режим редактирования этого сообщения — закрываем
    if (state.editing && state.editing.id === msg.id) cancelEdit();
  }

  const chat = getChat(peer);
  if (chat && chat.last_message && chat.last_message.id === msg.id) {
    chat.last_message = msg;
    renderSidebar();
  }
}

function updateChatFromMessage(msg) {
  const peer = msg.from === state.user.username ? msg.to : msg.from;
  let chat = getChat(peer);

  if (!chat) {
    // незнакомый отправитель — перезагружаем список (например, новый друг)
    refreshChats();
    return;
  }
  chat.last_message = msg;
  sortChats();
  renderSidebar();
}

function onPresence(msg) {
  const chat = getChat(msg.user);
  if (chat) {
    chat.online = !!msg.online;
    if (state.current === msg.user) updateChatHeader(chat);
    renderSidebar();
  }
}

function onFriendProfileUpdated(user) {
  const chat = getChat(user.username);
  if (chat) {
    chat.display_name = user.display_name;
    chat.avatar_color = user.avatar_color;
  }
  const friend = state.friends.find((f) => f.username === user.username);
  if (friend) {
    friend.display_name = user.display_name;
    friend.avatar_color = user.avatar_color;
  }
  if (state.current === user.username) updateChatHeader(chat);
  renderSidebar();
}

function onTyping(msg) {
  if (msg.from !== state.current) return;
  const line = $("typing-line");
  line.textContent = (displayNameFor(msg.from) || "Собеседник") + " печатает…";
  line.style.display = "block";

  if (state.typingHideTimer) clearTimeout(state.typingHideTimer);
  state.typingHideTimer = setTimeout(() => {
    line.style.display = "none";
  }, 3000);
}

function sendTyping() {
  if (!state.current || !state.wsOpen) return;
  const now = Date.now();
  if (now - state.lastTypingSent < 2200) return;
  state.lastTypingSent = now;
  sendWS({ type: "typing", to: state.current });
}

// ============================================
// НЕПРОЧИТАННЫЕ
// ============================================
function markRead(chatWith) {
  const chat = getChat(chatWith);
  if (chat && chat.unread) {
    chat.unread = 0;
    renderSidebar();
    renderTitle();
  }

  const send = () => {
    state.lastReadSent[chatWith] = Date.now();
    api("/api/mark_read", { method: "POST", body: { to_user: chatWith } })
      .then(() => renderTitle())
      .catch(() => {});
  };

  const now = Date.now();
  const last = state.lastReadSent[chatWith] || 0;
  if (now - last > 400) {
    send();
  } else if (!state.readTimers[chatWith]) {
    // «хвостовой» вызов, чтобы сервер точно узнал о последнем сообщении
    state.readTimers[chatWith] = setTimeout(() => {
      delete state.readTimers[chatWith];
      send();
    }, Math.max(50, 450 - (now - last)));
  }
}

function totalUnread() {
  return state.chats.reduce((sum, chat) => sum + (chat.unread || 0), 0);
}

function renderTitle() {
  const base = "СвапТайм — Мессенджер";
  const count = totalUnread();
  const inChat = document.getElementById("chat-screen").classList.contains("active");
  document.title = inChat && count > 0 ? `(${count}) ${base}` : base;
}

// ============================================
// ПРОФИЛЬ
// ============================================
function openProfile(user) {
  if (!user) return;
  state.modalUser = user;

  const display = user.display_name || user.username;
  $("profile-title").textContent = "Профиль";
  $("profile-name").textContent = display;
  $("profile-username").textContent = "@" + user.username;
  $("profile-avatar").textContent = initial(display);
  $("profile-avatar").style.background = safeColor(user.avatar_color);
  $("profile-status").textContent = user.online ? "в сети" : "не в сети";
  $("profile-status").classList.toggle("online", !!user.online);
  $("profile-error").textContent = "";

  const isBlocked = state.blocked.includes(user.username);
  const isIgnored = state.ignored.includes(user.username);
  const isFriend = state.friends.some((f) => f.username === user.username);

  $("profile-block-btn").textContent = isBlocked ? "✅ Разблокировать" : "🚫 Заблокировать";
  $("profile-ignore-btn").textContent = isIgnored ? "🔔 Убрать игнор" : "🔇 Игнорировать";
  $("profile-ignore-btn").style.display = isBlocked ? "none" : "";
  $("profile-remove-btn").style.display = isFriend ? "" : "none";
  $("profile-modal").classList.add("active");
}

function closeProfile() {
  $("profile-modal").classList.remove("active");
  state.modalUser = null;
}

function writeToUser() {
  if (!state.modalUser) return;
  const username = state.modalUser.username;
  const exists = getChat(username);
  closeProfile();
  if (!exists) {
    toast("Сначала добавь @" + username + " в друзья", "warn");
    return;
  }
  openChat(username);
}

async function removeCurrentFriend() {
  const user = state.modalUser;
  if (!user) return;
  if (!confirm(`Удалить ${user.display_name || user.username} из друзей?`)) return;

  try {
    await api("/api/friends/remove", { method: "POST", body: { to_user: user.username } });
    toast("Удалён из друзей", "success");
    closeProfile();
    await refreshChats();
  } catch (err) {
    $("profile-error").textContent = err.message;
  }
}

async function toggleBlockCurrentUser() {
  const user = state.modalUser;
  if (!user) return;
  const isBlocked = state.blocked.includes(user.username);

  if (!isBlocked && !confirm(`Заблокировать ${user.display_name || user.username}?`)) return;

  try {
    await api(isBlocked ? "/api/friends/unblock" : "/api/friends/block", {
      method: "POST",
      body: { to_user: user.username },
    });
    toast(isBlocked ? "Разблокирован" : "Заблокирован", "success");
    closeProfile();
    await refreshChats();
  } catch (err) {
    $("profile-error").textContent = err.message;
  }
}

async function toggleIgnoreCurrentUser() {
  const user = state.modalUser;
  if (!user) return;
  const isIgnored = state.ignored.includes(user.username);

  try {
    await api(isIgnored ? "/api/friends/unignore" : "/api/friends/ignore", {
      method: "POST",
      body: { to_user: user.username },
    });
    toast(isIgnored ? "Игнор снят" : "Сообщения от него не будут приходить", "success");
    closeProfile();
    await refreshChats();
  } catch (err) {
    $("profile-error").textContent = err.message;
  }
}

// ============================================
// ДОБАВИТЬ ДРУГА
// ============================================
function openAddFriend() {
  $("add-friend-modal").classList.add("active");
  $("friend-username").value = "";
  $("friend-error").textContent = "";
  setTimeout(() => $("friend-username").focus(), 50);
}

function closeAddFriend() {
  $("add-friend-modal").classList.remove("active");
}

async function sendFriendRequest() {
  const toUser = $("friend-username").value.trim().toLowerCase().replace(/^@/, "");
  const errorEl = $("friend-error");
  errorEl.textContent = "";

  if (!toUser) {
    errorEl.textContent = "Введи ник";
    return;
  }

  try {
    const data = await api("/api/friends/request", { method: "POST", body: { to_user: toUser } });
    errorEl.classList.add("success");
    errorEl.textContent = "✅ " + (data.message || "Запрос отправлен");
    setTimeout(() => {
      errorEl.classList.remove("success");
      errorEl.textContent = "";
      closeAddFriend();
    }, 1400);
    await refreshChats();
  } catch (err) {
    errorEl.classList.remove("success");
    errorEl.textContent = err.message || "Ошибка";
  }
}

// ============================================
// НАСТРОЙКИ
// ============================================
function renderFontOptions(selected) {
  const select = $("settings-font");
  clear(select);
  const fonts = state.fonts && state.fonts.length ? state.fonts : FALLBACK_FONTS;
  fonts.forEach((font) => {
    const option = document.createElement("option");
    option.value = font;
    option.textContent = FONT_LABELS[font] || font;
    option.style.fontFamily = font;
    select.appendChild(option);
  });
  select.value = fonts.includes(selected) ? selected : fonts[0];
  updateFontPreview();
}

function updateFontPreview() {
  const font = $("settings-font").value;
  $("font-preview").style.fontFamily = font;
  // предпросмотр на весь интерфейс, чтобы было видно разницу
  document.documentElement.style.setProperty("--app-font", font);
}

function openSettings() {
  $("settings-modal").classList.add("active");
  $("settings-name").value = state.user.display_name || state.user.username;
  $("settings-color").value = safeColor(state.user.avatar_color);
  renderFontOptions(state.user.font_family);
  renderBlockedList();
  renderIgnoredList();
}

function closeSettings() {
  $("settings-modal").classList.remove("active");
  applyTheme(); // откатываем предпросмотр, если не сохранили
}

function renderBlockedList() {
  const list = $("blocked-list");
  clear(list);
  if (!state.blocked.length) {
    list.appendChild(el("div", "loading-small", "Пусто"));
    return;
  }
  state.blocked.forEach((username) => {
    const row = el("div", "setting-item");
    row.appendChild(el("span", "", "@" + username));
    const btn = el("button", "", "Разблокировать");
    btn.addEventListener("click", () => unblockUser(username));
    row.appendChild(btn);
    list.appendChild(row);
  });
}

function renderIgnoredList() {
  const list = $("ignored-list");
  clear(list);
  if (!state.ignored.length) {
    list.appendChild(el("div", "loading-small", "Пусто"));
    return;
  }
  state.ignored.forEach((username) => {
    const row = el("div", "setting-item");
    row.appendChild(el("span", "", "@" + username));
    const btn = el("button", "", "Убрать игнор");
    btn.addEventListener("click", () => unignoreUser(username));
    row.appendChild(btn);
    list.appendChild(row);
  });
}

async function saveSettings() {
  const name = $("settings-name").value.trim();
  const color = $("settings-color").value;
  const font = $("settings-font").value;
  const btn = $("settings-save");
  btn.disabled = true;

  try {
    const data = await api("/api/update_profile", {
      method: "POST",
      body: { display_name: name, avatar_color: color, font_family: font },
    });
    state.user = data.user;
    localStorage.setItem("swaptime_user", JSON.stringify(state.user));
    applyTheme();
    closeSettings();
    await refreshChats();
    toast("Настройки сохранены", "success");
  } catch (err) {
    toast(err.message, "error");
  } finally {
    btn.disabled = false;
  }
}

async function unblockUser(username) {
  try {
    await api("/api/friends/unblock", { method: "POST", body: { to_user: username } });
    toast("Разблокирован", "success");
    await refreshChats();
    renderBlockedList();
    renderIgnoredList();
  } catch (err) {
    toast(err.message, "error");
  }
}

async function unignoreUser(username) {
  try {
    await api("/api/friends/unignore", { method: "POST", body: { to_user: username } });
    toast("Игнор снят", "success");
    await refreshChats();
    renderIgnoredList();
  } catch (err) {
    toast(err.message, "error");
  }
}

// ============================================
// СОБЫТИЯ
// ============================================
function bindEvents() {
  document.querySelectorAll(".auth-tab").forEach((tab) => {
    tab.addEventListener("click", () => {
      document.querySelectorAll(".auth-tab").forEach((t) => t.classList.remove("active"));
      tab.classList.add("active");
      document.querySelectorAll(".auth-form").forEach((f) => f.classList.remove("active"));
      const form = $(tab.dataset.tab + "-form");
      if (form) form.classList.add("active");
    });
  });

  const input = $("message-input");
  input.addEventListener("keydown", (event) => {
    if (event.key === "Enter" && !event.shiftKey) {
      event.preventDefault();
      sendMessage();
    } else if (event.key === "Escape") {
      if (state.editing) cancelEdit();
      else if (state.replyTo) cancelReply();
    }
  });
  input.addEventListener("input", sendTyping);

  $("search-users").addEventListener("input", renderSidebar);

  $("friend-username").addEventListener("keydown", (event) => {
    if (event.key === "Enter") sendFriendRequest();
  });

  $("settings-font").addEventListener("change", updateFontPreview);

  // клик по оверлею закрывает модалку
  ["add-friend-modal", "profile-modal", "settings-modal"].forEach((id) => {
    const overlay = $(id);
    overlay.addEventListener("click", (event) => {
      if (event.target !== overlay) return;
      if (id === "settings-modal") closeSettings();
      if (id === "profile-modal") closeProfile();
      if (id === "add-friend-modal") closeAddFriend();
    });
  });

  document.addEventListener("keydown", (event) => {
    if (event.key !== "Escape") return;
    if ($("settings-modal").classList.contains("active")) closeSettings();
    else if ($("profile-modal").classList.contains("active")) closeProfile();
    else if ($("add-friend-modal").classList.contains("active")) closeAddFriend();
  });

  // возвращаемся на вкладку — сбрасываем бейдж открытого чата
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState !== "visible") return;
    if (state.current && document.hasFocus()) markRead(state.current);
    renderTitle();
  });

  window.addEventListener("focus", () => {
    if (state.current) markRead(state.current);
  });

  window.addEventListener("beforeunload", () => {
    state.shouldReconnect = false;
  });
}

// ============================================
// ИНИЦИАЛИЗАЦИЯ
// ============================================
document.addEventListener("DOMContentLoaded", async () => {
  bindEvents();
  generateCaptcha();
  applyFont(FALLBACK_FONTS[0]);

  if (!state.token) {
    showScreen("auth");
    return;
  }

  try {
    const data = await api("/api/me");
    state.user = data.user;
    state.fonts = data.fonts && data.fonts.length ? data.fonts : FALLBACK_FONTS;
    localStorage.setItem("swaptime_user", JSON.stringify(state.user));
    enterApp();
  } catch (err) {
    if (err.status !== 401) {
      // сервер мог быть недоступен — покажем экран входа, но токен не тронем
      const saved = localStorage.getItem("swaptime_user");
      if (saved) {
        try {
          state.user = JSON.parse(saved);
        } catch (e) {}
      }
      showScreen("auth");
      $("login-error").textContent = err.message || "Сервер недоступен";
    } else {
      showScreen("auth");
    }
  }
});
