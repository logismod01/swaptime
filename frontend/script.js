// ============================================================
// СВАПТАЙМ — FRONTEND (v12, Discord-like)
// ============================================================
// Что нового относительно v7:
//   • своя аватарка (загрузка фото, обрезка в квадрат на клиенте)
//   • 10 кастомных рамок вокруг аватарки с анимацией
//   • баннеры профиля, «о себе», карточка профиля как в Discord
//   • новый интерфейс: рейл, сайдбар, вкладки друзей, настройки с разделами
//   • сообщения сгруппированы по автору, действия появляются при наведении
// ============================================================

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

const FALLBACK_FRAMES = [
  "none", "crimson", "gold", "neon", "aurora",
  "fire", "ice", "galaxy", "rainbow", "mono",
];

const FRAME_LABELS = {
  none: "Без рамки",
  crimson: "Crimson",
  gold: "Gold",
  neon: "Neon",
  aurora: "Aurora",
  fire: "Fire",
  ice: "Ice",
  galaxy: "Galaxy",
  rainbow: "Rainbow",
  mono: "Mono",
};

const FALLBACK_BANNERS = ["crimson", "sunset", "ocean", "forest", "galaxy", "night", "mono"];

const BANNER_LABELS = {
  crimson: "Crimson",
  sunset: "Sunset",
  ocean: "Ocean",
  forest: "Forest",
  galaxy: "Galaxy",
  night: "Night",
  mono: "Mono",
};

const FALLBACK_THEMES = [
  "midnight", "ocean", "emerald", "violet", "sunset",
  "cyber", "coffee", "mono", "aurora", "cherry",
];

const THEME_LABELS = {
  midnight: "Midnight Red",
  ocean: "Deep Ocean",
  emerald: "Emerald",
  violet: "Violet Dream",
  sunset: "Sunset",
  cyber: "Cyberpunk",
  coffee: "Coffee",
  mono: "Mono",
  aurora: "Aurora",
  cherry: "Cherry Blossom",
};

const COLOR_PRESETS = [
  "#e53935", "#ff7043", "#f0b232", "#3ba55d",
  "#22d3ee", "#3b82f6", "#8b5cf6", "#ec4899",
];

const state = {
  token: localStorage.getItem("swaptime_token") || null,
  tokenMode: localStorage.getItem("swaptime_token_mode") === "query" ? "query" : "header",
  user: null,
  chats: [],
  friends: [],
  requests: [],
  outgoing: [],
  blocked: [],
  ignored: [],
  blockedUsers: [],
  ignoredUsers: [],
  fonts: FALLBACK_FONTS.slice(),
  frames: FALLBACK_FRAMES.slice(),
  banners: FALLBACK_BANNERS.slice(),
  themes: FALLBACK_THEMES.slice(),
  theme: localStorage.getItem("swaptime_theme") || "midnight",

  servers: [],
  activeServer: null,     // id
  serverData: null,       // полный объект сервера
  activeChannel: null,    // id
  tgChannels: [],
  activeTg: null,         // id
  tgData: null,

  callSettings: null,

  view: "chats",          // chats | friends | tg | server
  booted: false,
  friendsTab: "all",      // all | online | pending | blocked
  current: null,
  messages: new Map(),
  byClientId: new Map(),
  pins: [],               // закреплённые в открытом личном чате
  avatarCache: new Map(),

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

  profileData: null,
  settingsTab: "profile",
  draft: null,            // черновик настроек
  pendingAvatar: undefined, // undefined — не менялась, "" — удалить, dataURL — новая
  screen: "auth",
};

// ============================================================
// МЕЛОЧИ
// ============================================================
const $ = (id) => document.getElementById(id);

function el(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined && text !== null) node.textContent = text;
  return node;
}

function clear(node) {
  while (node && node.firstChild) node.removeChild(node.firstChild);
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
  if (diffDays < 7) return date.toLocaleDateString("ru-RU", { weekday: "short" });
  return date.toLocaleDateString("ru-RU", { day: "2-digit", month: "2-digit" });
}

function formatSince(tsSeconds) {
  if (!tsSeconds) return "—";
  return new Date(tsSeconds * 1000).toLocaleDateString("ru-RU", {
    day: "numeric",
    month: "long",
    year: "numeric",
  });
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

// ============================================================
// АВАТАРКИ
// ============================================================
function avatarNode(user, sizeClass = "", options = {}) {
  const frame = options.frame !== undefined
    ? options.frame
    : (user.avatar_frame || "none");
  const color = safeColor(user.avatar_color);
  const name = user.display_name || user.username || "?";
  const ver = options.avatarVer !== undefined ? options.avatarVer : user.avatar_ver;

  const wrap = el("div", "av " + sizeClass + (frame && frame !== "none" ? " frame-" + frame : ""));
  wrap.setAttribute("aria-hidden", "true");

  const inner = el("div", "av-inner");
  inner.style.background = color;

  if (ver) {
    const img = document.createElement("img");
    img.src = `/api/avatar/${encodeURIComponent(user.username)}?v=${ver}`;
    img.alt = "";
    img.loading = "lazy";
    img.draggable = false;
    img.addEventListener("error", () => img.remove());
    inner.appendChild(img);
  }

  inner.appendChild(el("span", "av-letter", initial(name)));
  wrap.appendChild(inner);
  return wrap;
}

function fillAvatarSlot(slot, user, sizeClass = "", options = {}) {
  if (!slot) return;
  clear(slot);
  if (!user) return;
  slot.appendChild(avatarNode(user, sizeClass, options));
}

// ============================================================
// API
// ============================================================
class ApiError extends Error {
  constructor(message, status) {
    super(message);
    this.status = status;
  }
}

function withTokenInUrl(path) {
  if (!state.token) return path;
  const sep = path.includes("?") ? "&" : "?";
  return path + sep + "token=" + encodeURIComponent(state.token);
}

function rememberQueryTokenMode() {
  if (state.tokenMode === "query") return;
  state.tokenMode = "query";
  try {
    localStorage.setItem("swaptime_token_mode", "query");
  } catch (err) {}
}

async function api(path, options = {}) {
  const { method = "GET", body, auth = true, retryOn401 = true, forceQuery = false } = options;

  const useQuery = auth && !!state.token && (forceQuery || state.tokenMode === "query");
  const headers = {};
  if (body !== undefined) headers["Content-Type"] = "application/json";
  if (auth && state.token && !useQuery) headers["Authorization"] = "Bearer " + state.token;

  let resp;
  try {
    resp = await fetch(useQuery ? withTokenInUrl(path) : path, {
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
    if (resp.status === 401 && auth && state.token) {
      if (retryOn401 && !useQuery) {
        const result = await api(path, { ...options, retryOn401: false, forceQuery: true });
        rememberQueryTokenMode();
        return result;
      }
      handleSessionExpired();
    }
    const detail = data && (data.detail || data.message);
    throw new ApiError(typeof detail === "string" ? detail : "Ошибка сервера", resp.status);
  }
  return data;
}

function showAuthNotice(text) {
  const notice = $("auth-notice");
  if (!notice) return;
  notice.textContent = text;
  notice.style.display = "block";
}

function hideAuthNotice() {
  const notice = $("auth-notice");
  if (notice) notice.style.display = "none";
}

function handleSessionExpired() {
  if (!state.token) return;

  const lastUser =
    (state.user && state.user.username) ||
    localStorage.getItem("swaptime_last_user") ||
    "";
  if (lastUser) {
    try {
      localStorage.setItem("swaptime_last_user", lastUser);
    } catch (err) {}
  }

  clearSession();
  showScreen("auth");
  showAuthNotice(
    "Сессия истекла — войди заново тем же ником и паролем. Все друзья и сообщения на месте."
  );
  if (lastUser) {
    $("login-username").value = lastUser;
    setTimeout(() => $("login-password").focus(), 100);
  }
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

// ============================================================
// ЭКРАНЫ / ТЕМА
// ============================================================
function showScreen(name) {
  state.screen = name;
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
  applyColorTheme(state.user ? state.user.theme : state.theme);
  if (state.user) applyFont(state.user.font_family);
  renderMeBar();
}

function applyColorTheme(theme) {
  const value = FALLBACK_THEMES.includes(theme) ? theme : FALLBACK_THEMES[0];
  state.theme = value;
  document.documentElement.dataset.theme = value;
  try {
    localStorage.setItem("swaptime_theme", value);
  } catch (err) {}
}

function renderMeBar() {
  if (!state.user) return;
  const name = state.user.display_name || state.user.username;
  $("my-name").textContent = name;
  $("my-tag").textContent = "@" + state.user.username;
  fillAvatarSlot($("me-avatar-slot"), state.user);
  if (typeof applyMyStatus === "function") applyMyStatus();
}

// ============================================================
// КАПЧА
// ============================================================
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

// ============================================================
// АВТОРИЗАЦИЯ
// ============================================================
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
      if (!/^[a-z0-9_]{3,20}$/.test(username)) {
        throw new ApiError("Ник: 3–20 символов, латиница/цифры/_", 400);
      }
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
  try {
    localStorage.setItem("swaptime_last_user", data.user.username);
    localStorage.setItem("swaptime_token_mode", state.tokenMode);
  } catch (err) {}
  $("login-error").textContent = "";
  $("register-error").textContent = "";
  hideAuthNotice();
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

// ============================================================
// СТАРТ
// ============================================================
async function enterApp() {
  state.shouldReconnect = true;
  applyTheme();
  showScreen("chat");
  renderRail();

  try {
    const data = await api("/api/me");
    state.user = data.user;
    state.fonts = data.fonts && data.fonts.length ? data.fonts : FALLBACK_FONTS;
    state.frames = data.frames && data.frames.length ? data.frames : FALLBACK_FRAMES;
    state.banners = data.banners && data.banners.length ? data.banners : FALLBACK_BANNERS;
    state.themes = data.themes && data.themes.length ? data.themes : FALLBACK_THEMES;
    state.statuses = data.statuses || ["online", "idle", "dnd", "invisible"];
    localStorage.setItem("swaptime_user", JSON.stringify(state.user));
    applyTheme();
  } catch (err) {
    if (err.status === 401) return;
  }

  if (typeof initCallSettings === "function") initCallSettings();
  if (typeof applyMyStatus === "function") applyMyStatus();

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
    state.blockedUsers = friendsData.blocked_users || [];
    state.ignoredUsers = friendsData.ignored_users || [];

    if (state.current && !state.chats.some((c) => c.username === state.current)) {
      closeChat();
      toast("Диалог больше недоступен", "warn");
    }
    if (state.current) {
      const chat = getChat(state.current);
      if (chat) updateChatHeader(chat);
    }
    renderSidebar();
    renderRail();
    renderTitle();
  } catch (err) {
    if (err.status !== 401) toast(err.message || "Не удалось загрузить чаты", "error");
  }

  if (typeof refreshServers === "function") {
    try { await refreshServers(); } catch (err) {}
  }
  if (typeof refreshTgChannels === "function") {
    try { await refreshTgChannels(); } catch (err) {}
  }
}

function getChat(username) {
  return state.chats.find((c) => c.username === username) || null;
}

function getUserCard(username) {
  return (
    getChat(username) ||
    state.friends.find((f) => f.username === username) ||
    state.requests.find((r) => r.username === username) ||
    state.blockedUsers.find((u) => u.username === username) ||
    state.ignoredUsers.find((u) => u.username === username) ||
    null
  );
}

function sortChats() {
  state.chats.sort((a, b) => {
    const ta = a.last_message ? a.last_message.created_at : 0;
    const tb = b.last_message ? b.last_message.created_at : 0;
    return tb - ta;
  });
}

// ============================================================
// РЕЙЛ
// ============================================================
function renderRail() {
  document.querySelectorAll(".rail-btn[data-view]").forEach((btn) => {
    btn.classList.toggle("active", btn.dataset.view === state.view);
  });

  const unread = totalUnread();
  const unreadBadge = $("rail-unread");
  unreadBadge.hidden = unread === 0;
  unreadBadge.textContent = unread > 99 ? "99+" : String(unread);

  const reqBadge = $("rail-requests");
  reqBadge.hidden = state.requests.length === 0;
  reqBadge.textContent = String(state.requests.length);

  const tgBadge = $("rail-tg");
  const tgUnread = state.tgChannels.reduce((sum, c) => sum + (c.unread || 0), 0);
  if (tgBadge) {
    tgBadge.hidden = tgUnread === 0;
    tgBadge.textContent = tgUnread > 99 ? "99+" : String(tgUnread);
  }

  renderServerRail();
}

function renderServerRail() {
  const list = $("server-list");
  if (!list) return;
  clear(list);

  (state.servers || []).forEach((server) => {
    const btn = el("button", "rail-btn server-btn");
    btn.title = server.name;
    btn.dataset.serverId = String(server.id);
    if (state.view === "server" && state.activeServer === server.id) btn.classList.add("active");

    if (server.icon) {
      btn.appendChild(el("span", "server-icon-emoji", server.icon));
    } else {
      btn.appendChild(el("span", "server-icon-letter", initial(server.name)));
    }
    btn.style.setProperty("--server-color", safeColor(server.icon_color));

    if (server.unread > 0) {
      btn.appendChild(el("span", "rail-badge", server.unread > 99 ? "99+" : String(server.unread)));
    }

    btn.addEventListener("click", () => openServer(server.id));
    list.appendChild(btn);
  });
}

function moveMeBar(target) {
  const bar = $("me-bar");
  if (!bar || !target || bar.parentElement === target) return;
  target.appendChild(bar);
}

function setView(view, options = {}) {
  state.view = view;
  // личные сообщения и друзья живут в сайдбаре — мобильную панель закрываем
  if (view === "chats" || view === "friends") setMobilePane(false);

  const isServer = view === "server";
  $("home-sidebar").style.display = isServer ? "none" : "flex";
  $("server-sidebar").style.display = isServer ? "flex" : "none";
  moveMeBar(isServer ? $("server-sidebar") : $("home-sidebar"));

  $("chats-view").style.display = view === "chats" ? "block" : "none";
  $("friends-view").style.display = view === "friends" ? "block" : "none";
  $("tg-sidebar").style.display = view === "tg" ? "block" : "none";

  $("home-chat").style.display = isServer || view === "tg" ? "none" : "flex";
  $("server-view").style.display = isServer ? "flex" : "none";
  $("tg-view").style.display = view === "tg" ? "flex" : "none";

  const titles = {
    chats: ["Личные сообщения", "DM", "Поиск по друзьям…"],
    friends: ["Друзья", "DM", "Найти друга…"],
    tg: ["Каналы", "TG", "Поиск по каналам…"],
    server: ["Сервер", "", "Поиск по каналам…"],
  };
  const [title, tag, placeholder] = titles[view] || titles.chats;
  $("sidebar-title").textContent = title;
  $("sidebar-tag").textContent = tag;
  $("sidebar-tag").style.display = tag ? "" : "none";
  $("search-users").placeholder = placeholder;

  if (!isServer) {
    $("members-panel").style.display = "none";
  }

  renderRail();
  renderSidebar();
  if (view === "tg" && typeof renderTgList === "function") renderTgList();
}

// ============================================================
// САЙДБАР
// ============================================================
function previewText(msg) {
  if (!msg) return "Нет сообщений";
  if (msg.deleted) return "Сообщение удалено";
  const prefix = msg.from === state.user.username ? "Ты: " : "";
  const reply = msg.reply_to ? "↩ " : "";
  return reply + prefix + (msg.text || "");
}

function renderSidebar() {
  renderDMList();
  renderRequests();
  renderFriendsPanel();
}

function renderDMList() {
  const listEl = $("users-list");
  const query = ($("search-users").value || "").trim().toLowerCase();
  clear(listEl);

  if (!state.chats.length) {
    const empty = el("div", "empty-state");
    empty.appendChild(el("div", "empty-state-icon", "👥"));
    empty.appendChild(el("div", "empty-state-text", "Пока нет друзей"));
    empty.appendChild(el("div", "empty-state-hint", "Добавь кого-нибудь по нику"));
    listEl.appendChild(empty);
    return;
  }

  const needle = query.replace(/^@/, "");
  let visible = 0;

  state.chats.forEach((chat) => {
    const item = el("div", "user-item");
    item.dataset.username = chat.username;
    if (chat.username === state.current) item.classList.add("active");

    item.appendChild(avatarNode(chat, "", { frame: chat.avatar_frame }));

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
    item.appendChild(info);

    if (needle) {
      const haystack = ((chat.display_name || "") + " " + chat.username).toLowerCase();
      if (!haystack.includes(needle)) item.style.display = "none";
      else visible += 1;
    }

    item.addEventListener("click", () => openChat(chat.username));
    listEl.appendChild(item);
  });

  if (needle && !visible) {
    const empty = el("div", "empty-state");
    empty.appendChild(el("div", "empty-state-icon", "🔍"));
    empty.appendChild(el("div", "empty-state-text", "Ничего не найдено"));
    empty.appendChild(el("div", "empty-state-hint", "Попробуй другой ник"));
    listEl.appendChild(empty);
  }

  // закреплённые сверху, иконки тишины и превью черновика (v12)
  if (typeof decorateChatList === "function") decorateChatList(listEl);
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
    item.appendChild(el("div", "request-name", "@" + req.username));
    const actions = el("div", "request-actions");

    const accept = el("button", "request-btn accept", "✓");
    accept.title = "Принять";
    accept.addEventListener("click", (e) => { e.stopPropagation(); acceptFriend(req.username); });

    const decline = el("button", "request-btn decline", "✕");
    decline.title = "Отклонить";
    decline.addEventListener("click", (e) => { e.stopPropagation(); declineFriend(req.username); });

    actions.appendChild(accept);
    actions.appendChild(decline);
    item.appendChild(actions);
    list.appendChild(item);
  });
}

function renderFriendsPanel() {
  const list = $("friends-list");
  clear(list);

  document.querySelectorAll(".ftab").forEach((tab) => {
    tab.classList.toggle("active", tab.dataset.tab === state.friendsTab);
    if (tab.dataset.tab === "pending" && state.requests.length) {
      tab.textContent = `Заявки (${state.requests.length})`;
    } else if (tab.dataset.tab === "pending") {
      tab.textContent = "Заявки";
    }
  });

  const row = (user, actions) => {
    const item = el("div", "friend-row");
    item.appendChild(avatarNode(user, "", { frame: user.avatar_frame }));

    const info = el("div", "friend-info");
    info.appendChild(el("div", "friend-name", user.display_name || user.username));
    const sub = el("div", "friend-sub", "@" + user.username + (user.online ? " · в сети" : ""));
    if (user.online) sub.style.color = "#7ee2a8";
    info.appendChild(sub);
    item.appendChild(info);

    const actionsEl = el("div", "friend-actions");
    (actions || []).forEach(([icon, title, handler, cls]) => {
      const btn = el("button", "friend-action " + (cls || ""), icon);
      btn.title = title;
      btn.addEventListener("click", (e) => { e.stopPropagation(); handler(); });
      actionsEl.appendChild(btn);
    });
    item.appendChild(actionsEl);

    item.addEventListener("click", () => {
      openProfile(user.username);
    });
    list.appendChild(item);
  };

  const empty = (text) => list.appendChild(el("div", "loading-small", text));

  if (state.friendsTab === "all") {
    if (!state.friends.length) return empty("Пока нет друзей");
    state.friends.forEach((f) => row(f, [
      ["💬", "Написать", () => { setView("chats"); openChat(f.username); }],
      ["👤", "Профиль", () => openProfile(f.username)],
    ]));
  } else if (state.friendsTab === "online") {
    const online = state.friends.filter((f) => f.online);
    if (!online.length) return empty("Никого нет онлайн 😴");
    online.forEach((f) => row(f, [
      ["💬", "Написать", () => { setView("chats"); openChat(f.username); }],
    ]));
  } else if (state.friendsTab === "pending") {
    if (!state.requests.length && !state.outgoing.length) return empty("Нет заявок");
    state.requests.forEach((r) => row(r, [
      ["✓", "Принять", () => acceptFriend(r.username), "ok"],
      ["✕", "Отклонить", () => declineFriend(r.username), "no"],
    ]));
    state.outgoing.forEach((name) => {
      const item = el("div", "friend-row");
      item.appendChild(avatarNode({ username: name, display_name: name, avatar_color: "#3f3f46" }));
      const info = el("div", "friend-info");
      info.appendChild(el("div", "friend-name", "@" + name));
      info.appendChild(el("div", "friend-sub", "ждём ответа…"));
      item.appendChild(info);
      list.appendChild(item);
    });
  } else if (state.friendsTab === "blocked") {
    const items = state.blockedUsers.length
      ? state.blockedUsers
      : state.blocked.map((u) => ({ username: u, display_name: u, avatar_color: "#3f3f46" }));
    if (!items.length) return empty("Никого нет в блоке");
    items.forEach((u) => row(u, [
      ["✓", "Разблокировать", () => unblockUser(u.username), "ok"],
    ]));
  }
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

// ============================================================
// ЧАТ
// ============================================================
async function openChat(username) {
  if (!username) return;
  cancelReply();
  cancelEdit();

  state.current = username;
  setMobilePane(false);
  $("chat-screen").classList.add("chat-open");
  $("no-chat").style.display = "none";
  $("chat-active").style.display = "flex";
  $("message-input").placeholder = "Написать в @" + username;

  const chat = getChat(username);
  updateChatHeader(chat);
  renderDMList();

  clear($("messages"));
  state.messages.clear();
  state.byClientId.clear();
  $("messages").appendChild(el("div", "messages-loading", "Загружаю историю…"));

  try {
    const history = await api(
      `/api/messages/${encodeURIComponent(state.user.username)}/${encodeURIComponent(username)}`
    );
    if (state.current !== username) return;
    clear($("messages"));
    if (!history.length) {
      $("messages").appendChild(el("div", "chat-empty", "Начни разговор первым 👋"));
    } else {
      history.forEach((msg) => appendMessage(msg, false));
      applyGrouping();
      if (typeof placeUnreadDivider === "function") placeUnreadDivider($("messages"), chat && chat.unread);
    }
    if (typeof restoreDraft === "function") {
      if (!restoreDraft("dm", username)) scrollToBottom();
    } else {
      scrollToBottom();
    }
  } catch (err) {
    if (state.current !== username) return;
    clear($("messages"));
    $("messages").appendChild(el("div", "messages-loading", err.message || "Не удалось загрузить историю"));
  }

  if (state.current !== username) return;
  markRead(username);
  renderTitle();
  refreshPins();
  if (typeof onChatOpened === "function") onChatOpened("dm", username);

  if (window.matchMedia("(min-width: 761px)").matches) $("message-input").focus();
}

function updateChatHeader(chat) {
  if (!chat) {
    if (!state.current) return;
    const fallback = getUserCard(state.current) || { username: state.current, display_name: state.current };
    $("chat-name").textContent = fallback.display_name || state.current;
    $("chat-status").textContent = "@" + state.current;
    fillAvatarSlot($("chat-avatar-slot"), fallback);
    return;
  }

  const name = chat.display_name || chat.username;
  $("chat-name").textContent = name;
  $("chat-avatar-slot") && fillAvatarSlot($("chat-avatar-slot"), chat, "", { frame: chat.avatar_frame });

  const status = $("chat-status");
  const presence = typeof presenceLabel === "function" ? presenceLabel(chat) : "";
  status.dataset.status = chat.status || "online";
  if (chat.online && presence) {
    status.textContent = "@" + chat.username + " · " + presence;
    status.classList.add("online");
    status.classList.toggle("dnd", chat.status === "dnd");
    status.classList.toggle("idle", chat.status === "idle");
  } else {
    status.textContent = "@" + chat.username;
    status.classList.remove("online", "dnd", "idle");
  }
  if (typeof syncChatMuteButton === "function") syncChatMuteButton();
  if (typeof syncChatStatusExtra === "function") syncChatStatusExtra(chat);
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
  state.pins = [];
  renderPinnedBar();
  renderDMList();
  renderTitle();
}

function closeChatMobile() {
  closeChat();
}

/* На телефоне панель чата/канала занимает весь экран: класс pane-open
   прячет сайдбар (display у него инлайновый, поэтому в CSS есть !important).
   На широком экране класс ни на что не влияет. */
function setMobilePane(open) {
  const screen = $("chat-screen");
  if (screen) screen.classList.toggle("pane-open", !!open);
}

function openChatProfile() {
  if (!state.current) return;
  openProfile(state.current);
}

function scrollToBottom() {
  const box = $("messages");
  box.scrollTop = box.scrollHeight;
}

function isNearBottom() {
  const box = $("messages");
  return box.scrollHeight - box.scrollTop - box.clientHeight < 140;
}

// ============================================================
// СООБЩЕНИЯ
// ============================================================
function displayNameFor(username) {
  if (!state.user) return username;
  if (username === state.user.username) return state.user.display_name || username;
  const card = getUserCard(username);
  return card ? card.display_name || card.username : username;
}

function userForMessage(username) {
  if (state.user && username === state.user.username) return state.user;
  return getUserCard(username) || { username, display_name: username, avatar_color: "#3f3f46" };
}

function buildMessageNode(msg) {
  const isOwn = msg.from === state.user.username;
  const author = userForMessage(msg.from);

  const wrapper = el("div", "message-wrapper" + (isOwn ? " own" : ""));
  if (msg.pinned) wrapper.classList.add("pinned");
  if (msg.id) wrapper.dataset.msgId = String(msg.id);
  if (msg.client_id) wrapper.dataset.clientId = String(msg.client_id);
  if (msg.pending) wrapper.classList.add("pending");
  if (msg.failed) wrapper.classList.add("failed");

  wrapper.appendChild(el("div", "msg-gutter", formatTime(msg.created_at).slice(0, 5)));

  const avatarWrap = el("div", "msg-avatar");
  avatarWrap.appendChild(avatarNode(author, "", { frame: author.avatar_frame }));
  wrapper.appendChild(avatarWrap);

  const content = el("div", "msg-content");

  const header = el("div", "msg-header");
  const authorName = el("span", "msg-author" + (isOwn ? " is-own" : ""), author.display_name || author.username);
  header.appendChild(authorName);
  if (isOwn) header.appendChild(el("span", "msg-bot", "ТЫ"));
  header.appendChild(el("span", "msg-time", formatTime(msg.created_at)));
  if (msg.pinned) header.appendChild(el("span", "pin-mark", "📌"));
  content.appendChild(header);

  if (msg.reply_to) {
    const quote = el("button", "reply-quote");
    quote.type = "button";
    const preview = msg.reply_preview;
    const quotedName = preview
      ? (preview.from === state.user.username ? "Себе" : displayNameFor(preview.from))
      : "сообщение";
    quote.appendChild(el("span", "reply-quote-author", quotedName));
    quote.appendChild(
      el(
        "span",
        "reply-quote-text",
        preview ? (preview.deleted ? "Сообщение удалено" : preview.text || "…") : "Сообщение удалено"
      )
    );
    quote.addEventListener("click", () => focusMessage(msg.reply_to));
    content.appendChild(quote);
  }

  const textEl = el("div", "message " + (isOwn ? "own" : "other"));
  if (msg.fwd_from) {
    const fwd = el("div", "fwd-label", "⇄ Переслано от ");
    fwd.appendChild(el("b", null, msg.fwd_name || ("@" + msg.fwd_from)));
    textEl.appendChild(fwd);
  }
  const textInner = el("div", "message-text");
  if (msg.deleted) {
    textInner.classList.add("deleted-text");
    textInner.textContent = "Сообщение удалено";
  } else if (typeof renderRichText === "function") {
    renderRichText(textInner, msg.text || "");
  } else {
    textInner.textContent = msg.text || "";
  }
  textEl.appendChild(textInner);

  if (!msg.deleted && typeof buildReactionsNode === "function") {
    const reactions = buildReactionsNode(msg, "dm");
    if (reactions) textEl.appendChild(reactions);
  }

  const meta = el("div", "message-meta");
  if (msg.edited && !msg.deleted) meta.appendChild(el("span", "edited-mark", "(изм.)"));
  if (msg.pending) {
    meta.appendChild(el("span", "msg-status", "🕓"));
    meta.title = "Отправляется…";
  }
  if (msg.failed) {
    meta.appendChild(el("span", "msg-status failed", "⚠"));
    wrapper.title = "Нажми, чтобы отправить снова";
    wrapper.addEventListener("click", (event) => {
      if (event.target.closest(".msg-btn, .reply-quote")) return;
      retryMessage(msg);
    });
  }
  if (meta.childNodes.length) textEl.appendChild(meta);
  content.appendChild(textEl);
  wrapper.appendChild(content);

  if (!msg.deleted) {
    const actions = el("div", "message-actions");

    const replyBtn = el("button", "msg-btn", "↩");
    replyBtn.type = "button";
    replyBtn.title = "Ответить";
    replyBtn.addEventListener("click", () => startReply(msg));
    actions.appendChild(replyBtn);

    if (msg.id) {
      const pinBtn = el("button", "msg-btn pin-btn" + (msg.pinned ? " is-pinned" : ""), "📌");
      pinBtn.type = "button";
      pinBtn.title = msg.pinned ? "Открепить сообщение" : "Закрепить сообщение";
      pinBtn.addEventListener("click", () => togglePinMessage(msg));
      actions.appendChild(pinBtn);
    }

    if (typeof addMessageExtras === "function") {
      addMessageExtras(actions, msg, { scope: "dm" });
    }

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

  applyGrouping();
  if (sticky || msg.from === state.user.username) scrollToBottom();
}

/** Группировка подряд идущих сообщений одного автора (как в Discord) */
function applyGrouping() {
  const nodes = Array.from($("messages").querySelectorAll(".message-wrapper"));
  let prev = null;
  nodes.forEach((node) => {
    const msgId = node.dataset.msgId;
    const msg = msgId ? state.messages.get(Number(msgId)) : null;
    let grouped = false;

    if (prev && msg && prev.msg) {
      const sameAuthor = prev.msg.from === msg.from;
      const closeInTime = Math.abs((msg.created_at || 0) - (prev.msg.created_at || 0)) < 300;
      const noReply = !msg.reply_to;
      const prevNotDeleted = !prev.msg.deleted;
      grouped = sameAuthor && closeInTime && noReply && prevNotDeleted;
    }

    node.classList.toggle("grouped", grouped);
    prev = { node, msg };
  });
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


// ============================================================
// ЗАКРЕПЛЁННЫЕ СООБЩЕНИЯ (личные чаты)
// ============================================================
async function refreshPins() {
  const username = state.current;
  if (!username) {
    state.pins = [];
    renderPinnedBar();
    return;
  }
  if (typeof hidePinsPopover === "function") hidePinsPopover();

  try {
    const data = await api("/api/pins/" + encodeURIComponent(username));
    if (state.current !== username) return;
    state.pins = data.pins || [];
  } catch (err) {
    if (state.current !== username) return;
    state.pins = [];
  }
  renderPinnedBar();
  renderPinsPopover();
}

function renderPinnedBar() {
  const bar = $("pinned-bar");
  if (!bar) return;

  const pins = state.pins || [];
  if (!pins.length) {
    bar.style.display = "none";
    hidePinsPopover();
    return;
  }

  const latest = pins[0];
  $("pinned-text").textContent =
    (displayNameFor(latest.from) || "Кто-то") + ": " + (latest.text || "сообщение").slice(0, 90);
  $("pinned-count").textContent = pins.length > 99 ? "99+" : String(pins.length);
  bar.style.display = "block";
}

function renderPinsPopover() {
  const popover = $("pins-popover");
  if (!popover) return;
  clear(popover);

  const pins = state.pins || [];
  if (!pins.length) {
    hidePinsPopover();
    return;
  }

  const head = el("div", "pins-head");
  head.appendChild(el("span", "pins-title", "📌 Закреплённые — " + pins.length));
  const close = el("button", "pins-close", "✕");
  close.type = "button";
  close.title = "Закрыть";
  close.addEventListener("click", () => hidePinsPopover());
  head.appendChild(close);
  popover.appendChild(head);

  const list = el("div", "pins-list");
  pins.forEach((msg) => {
    const row = el("div", "pin-item");

    const main = el("button", "pin-item-main");
    main.type = "button";
    main.appendChild(el("div", "pin-item-author", displayNameFor(msg.from) || msg.from));
    main.appendChild(el("div", "pin-item-text", msg.text || "сообщение удалено"));
    main.appendChild(el("div", "pin-item-time", formatTime(msg.created_at)));
    main.addEventListener("click", () => {
      hidePinsPopover();
      jumpToPin(msg.id);
    });
    row.appendChild(main);

    const un = el("button", "pin-item-unpin", "✕");
    un.type = "button";
    un.title = "Открепить";
    un.addEventListener("click", () => togglePinMessage(msg));
    row.appendChild(un);

    list.appendChild(row);
  });
  popover.appendChild(list);
}

function hidePinsPopover() {
  const popover = $("pins-popover");
  if (popover) popover.classList.remove("active");
}

function togglePinsPopover() {
  const popover = $("pins-popover");
  if (!popover) return;
  if (popover.classList.contains("active")) {
    hidePinsPopover();
    return;
  }
  renderPinsPopover();
  popover.classList.add("active");
}

function jumpToPin(id) {
  const node = $("messages").querySelector(`[data-msg-id="${id}"]`);
  if (node) {
    node.scrollIntoView({ behavior: "smooth", block: "center" });
    node.classList.add("highlight");
    setTimeout(() => node.classList.remove("highlight"), 1400);
    return;
  }
  toast("Подгружаю сообщение…", "info", 1200);
  reloadCurrentChat().then(() => setTimeout(() => focusMessage(id), 60));
}

function togglePinMessage(msg) {
  if (!msg || !msg.id) return;
  const next = !msg.pinned;
  const sent = sendWS({ type: "pin_msg", id: msg.id, pinned: next });
  if (!sent) {
    api("/api/messages/pin", { method: "POST", body: { message_id: msg.id, pinned: next } })
      .catch((err) => toast(err.message || "Не удалось закрепить", "error"));
  }
}

function handlePinChanged(msg) {
  const data = msg.message;
  if (!data) return;

  const other = data.from === state.user.username ? data.to : data.from;
  if (state.current !== other) return;

  const known = state.messages.get(data.id);
  if (known) Object.assign(known, data);
  if (data.deleted) {
    // удалённое сообщение больше не показываем среди закреплённых
    state.pins = state.pins.filter((p) => p.id !== data.id);
  } else {
    state.pins = state.pins.filter((p) => p.id !== data.id);
    if (data.pinned) state.pins.unshift(data);
  }

  const node = $("messages").querySelector(`[data-msg-id="${data.id}"]`);
  if (node) {
    const replacement = buildMessageNode(Object.assign({}, known || data));
    node.replaceWith(replacement);
    applyGrouping();
  }

  renderPinnedBar();
  renderPinsPopover();
  toast(data.pinned ? "Сообщение закреплено" : "Сообщение откреплено", "success", 1600);
}

// ============================================================
// ОТПРАВКА / ОТВЕТ / РЕДАКТИРОВАНИЕ / УДАЛЕНИЕ
// ============================================================
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
  if (typeof clearDraft === "function") clearDraft("dm", optimistic.to);
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

// ============================================================
// WEBSOCKET
// ============================================================
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

    const queue = state.wsQueue.slice();
    state.wsQueue = [];
    queue.forEach((payload) => socket.send(JSON.stringify(payload)));

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
    applyGrouping();
    scrollToBottom();
  } catch (err) {
    // тихо
  }
}

function handleSocketMessage(msg) {
  switch (msg.type) {
    case "message": onIncomingMessage(msg); break;
    case "message_updated": onMessageUpdated(msg); break;
    case "read_sync": {
      const chat = getChat(msg.chat_with);
      if (chat) chat.unread = 0;
      renderSidebar();
      renderRail();
      renderTitle();
      break;
    }
    case "read": break;
    case "presence": onPresence(msg); break;
    case "reaction":
      if (typeof applyReactionEvent === "function") applyReactionEvent(msg);
      break;
    case "typing": onTyping(msg); break;
    case "friend_request":
      refreshChats();
      toast("@" + msg.from + " хочет добавить тебя в друзья", "info");
      break;
    case "friend_changed": refreshChats(); break;
    case "profile_updated": onFriendProfileUpdated(msg.user); break;
    case "error": handleServerError(msg); break;
    case "pin_changed": handlePinChanged(msg); break;
    case "pong": break;

    // ---- серверы ----
    case "server_message":
    case "server_message_updated":
    case "server_channels_changed":
    case "server_member_joined":
    case "server_member_left":
    case "server_members_changed":
    case "server_updated":
    case "server_typing":
    case "server_left":
      if (typeof handleServerEvent === "function") handleServerEvent(msg);
      break;

    // ---- Telegram-каналы ----
    case "tg_post":
    case "tg_post_updated":
    case "tg_channel_deleted":
      if (typeof handleTgEvent === "function") handleTgEvent(msg);
      break;

    // ---- звонки ----
    case "call_incoming":
    case "call_accept":
    case "call_reject":
    case "call_end":
    case "call_busy":
    case "call_signal":
    case "call_error":
      if (typeof handleCallEvent === "function") handleCallEvent(msg);
      break;

    default: break;
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

  updateChatFromMessage(msg);

  if (!isOwn && typeof notifyIncomingMessage === "function") {
    notifyIncomingMessage(msg, { isCurrent, focused });
  }

  if (!isOwn) {
    const chat = getChat(peer);
    if (chat && (!isCurrent || !focused)) {
      chat.unread = (chat.unread || 0) + 1;
      renderSidebar();
      renderRail();
      renderTitle();
    }
  }
}

function onMessageUpdated(msg) {
  if (!msg) return;
  const peer = msg.from === state.user.username ? msg.to : msg.from;

  if (state.current === peer) {
    upsertMessage(msg);
    if (state.editing && state.editing.id === msg.id) cancelEdit();
  }

  const chat = getChat(peer);
  if (chat && chat.last_message && chat.last_message.id === msg.id) {
    chat.last_message = msg;
    renderDMList();
  }
}

function updateChatFromMessage(msg) {
  const peer = msg.from === state.user.username ? msg.to : msg.from;
  const chat = getChat(peer);

  if (!chat) {
    refreshChats();
    return;
  }
  chat.last_message = msg;
  sortChats();
  renderDMList();
  renderTitle();
}

function onPresence(msg) {
  const chat = getChat(msg.user);
  if (chat) {
    chat.online = !!msg.online;
    if (msg.status !== undefined) chat.status = msg.status;
    if (msg.status_text !== undefined) chat.status_text = msg.status_text;
    if (state.current === msg.user) updateChatHeader(chat);
    renderDMList();
    renderRail();
  }
  const friend = state.friends.find((f) => f.username === msg.user);
  if (friend) friend.online = !!msg.online;
}

function onFriendProfileUpdated(user) {
  if (!user) return;

  const apply = (item) => {
    if (!item || item.username !== user.username) return;
    if (user.display_name !== undefined) item.display_name = user.display_name;
    if (user.avatar_color !== undefined) item.avatar_color = user.avatar_color;
    if (user.avatar_ver !== undefined) item.avatar_ver = user.avatar_ver;
    if (user.avatar_frame !== undefined) item.avatar_frame = user.avatar_frame;
    if (user.banner !== undefined) item.banner = user.banner;
    if (user.bio !== undefined) item.bio = user.bio;
  };

  state.chats.forEach(apply);
  state.friends.forEach(apply);
  state.requests.forEach(apply);
  state.blockedUsers.forEach(apply);
  state.ignoredUsers.forEach(apply);

  // свои изменения (другая вкладка / эхо сервера)
  if (state.user && user.username === state.user.username) {
    apply(state.user);
    renderMeBar();
    if (state.user.font_family) applyFont(state.user.font_family);
  }

  if (state.current === user.username) {
    updateChatHeader(getChat(state.current));
    if (!state.messages.size) return;
    // перерисовываем сообщения, чтобы обновились аватарки
    const history = Array.from(state.messages.values());
    clear($("messages"));
    state.messages.clear();
    state.byClientId.clear();
    history.forEach((msg) => appendMessage(msg, false));
    applyGrouping();
  }

  renderDMList();
  renderRail();
  renderFriendsPanel();
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

// ============================================================
// НЕПРОЧИТАННЫЕ
// ============================================================
function markRead(chatWith) {
  const chat = getChat(chatWith);
  if (chat && chat.unread) {
    chat.unread = 0;
    renderDMList();
    renderRail();
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
  const inChat = state.screen === "chat";
  document.title = inChat && count > 0 ? `(${count}) ${base}` : base;
}

// ============================================================
// КАРТОЧКА ПРОФИЛЯ
// ============================================================
async function openProfile(target) {
  const username = typeof target === "string" ? target : target && target.username;
  if (!username) return;

  $("profile-error").textContent = "";
  $("profile-modal").classList.add("active");

  // пока грузим — показываем то, что уже знаем
  const known = getUserCard(username) || (state.user.username === username ? state.user : null);
  renderProfileCard({
    username,
    display_name: (known && known.display_name) || username,
    avatar_color: (known && known.avatar_color) || "#3f3f46",
    avatar_ver: known && known.avatar_ver,
    avatar_frame: (known && known.avatar_frame) || "none",
    banner: (known && known.banner) || "crimson",
    bio: (known && known.bio) || "",
    online: !!(known && known.online),
    created_at: 0,
    is_friend: state.friends.some((f) => f.username === username),
    is_me: username === state.user.username,
    blocked_by_me: state.blocked.includes(username),
    ignored_by_me: state.ignored.includes(username),
  });

  try {
    const data = await api("/api/profile/" + encodeURIComponent(username));
    if ($("profile-modal").classList.contains("active")) renderProfileCard(data);
  } catch (err) {
    $("profile-error").textContent = err.message;
  }
}

function renderProfileCard(data) {
  state.profileData = data;

  const banner = $("profile-banner");
  banner.className = "profile-banner banner-" + (state.banners.includes(data.banner) ? data.banner : "crimson");

  fillAvatarSlot($("profile-avatar-slot"), data, "av-xl", {
    frame: data.avatar_frame,
    avatarVer: data.avatar_ver,
  });

  $("profile-name").textContent = data.display_name || data.username;
  $("profile-username").textContent = "@" + data.username;

  const status = $("profile-status");
  const presence = typeof presenceLabel === "function" ? presenceLabel(data) : (data.online ? "в сети" : "не в сети");
  if (data.is_me) {
    status.textContent = "это ты";
    status.classList.add("online");
  } else if (data.online) {
    status.textContent = presence + (data.status_text ? " · " + data.status_text : "");
    status.classList.add("online");
    status.classList.toggle("dnd", data.status === "dnd");
    status.classList.toggle("idle", data.status === "idle");
  } else {
    status.textContent = "не в сети";
    status.classList.remove("online", "dnd", "idle");
  }

  $("profile-bio").textContent = data.bio || "Пока ничего не рассказал о себе…";
  $("profile-since").textContent = data.created_at ? formatSince(data.created_at) : "—";

  const isMe = !!data.is_me;
  const isFriend = !!data.is_friend;

  $("profile-write-btn").style.display = isMe ? "none" : "";
  $("profile-write-btn").disabled = !isFriend;
  $("profile-write-btn").textContent = isFriend ? "💬 Написать" : "💬 Сначала в друзья";

  // игнор не показываем себе и уже заблокированным
  $("profile-ignore-btn").style.display = !isMe && !data.blocked_by_me ? "" : "none";
  $("profile-block-btn").style.display = isMe ? "none" : "";
  $("profile-remove-btn").style.display = !isMe && isFriend ? "" : "none";

  $("profile-ignore-btn").textContent = data.ignored_by_me ? "🔔 Убрать игнор" : "🔇 Игнорировать";
  $("profile-block-btn").textContent = data.blocked_by_me ? "✅ Разблокировать" : "🚫 Заблокировать";

  const callBtn = $("profile-call-btn");
  if (callBtn) {
    const canCall = data.can_call !== undefined ? data.can_call : isFriend;
    callBtn.style.display = isMe || data.blocked_by_me || !canCall ? "none" : "";
  }

  if (isMe) $("profile-error").textContent = "";
}

function openMyProfile() {
  if (state.user) openProfile(state.user.username);
}

function closeProfile() {
  $("profile-modal").classList.remove("active");
  state.profileData = null;
}

function writeToUser() {
  const data = state.profileData;
  if (!data) return;
  const username = data.username;
  closeProfile();
  if (!getChat(username)) {
    toast("Сначала добавь @" + username + " в друзья", "warn");
    return;
  }
  setView("chats");
  openChat(username);
}

async function removeCurrentFriend() {
  const data = state.profileData;
  if (!data) return;
  if (!confirm(`Удалить ${data.display_name || data.username} из друзей?`)) return;

  try {
    await api("/api/friends/remove", { method: "POST", body: { to_user: data.username } });
    toast("Удалён из друзей", "success");
    closeProfile();
    await refreshChats();
  } catch (err) {
    $("profile-error").textContent = err.message;
  }
}

async function toggleBlockCurrentUser() {
  const data = state.profileData;
  if (!data) return;
  const isBlocked = !!data.blocked_by_me;
  if (!isBlocked && !confirm(`Заблокировать ${data.display_name || data.username}?`)) return;

  try {
    await api(isBlocked ? "/api/friends/unblock" : "/api/friends/block", {
      method: "POST",
      body: { to_user: data.username },
    });
    toast(isBlocked ? "Разблокирован" : "Заблокирован", "success");
    closeProfile();
    await refreshChats();
  } catch (err) {
    $("profile-error").textContent = err.message;
  }
}

async function toggleIgnoreCurrentUser() {
  const data = state.profileData;
  if (!data) return;
  const isIgnored = !!data.ignored_by_me;

  try {
    await api(isIgnored ? "/api/friends/unignore" : "/api/friends/ignore", {
      method: "POST",
      body: { to_user: data.username },
    });
    toast(isIgnored ? "Игнор снят" : "Сообщения от него не будут приходить", "success");
    closeProfile();
    await refreshChats();
  } catch (err) {
    $("profile-error").textContent = err.message;
  }
}

// ============================================================
// ДОБАВИТЬ ДРУГА
// ============================================================
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
  errorEl.classList.remove("success");

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

// ============================================================
// НАСТРОЙКИ
// ============================================================
function openSettings(tab = "profile") {
  if (!state.user) return;

  state.draft = {
    display_name: state.user.display_name || state.user.username,
    avatar_color: safeColor(state.user.avatar_color),
    avatar_frame: state.user.avatar_frame || "none",
    banner: state.user.banner || "crimson",
    bio: state.user.bio || "",
    font_family: state.user.font_family || FALLBACK_FONTS[0],
    theme: state.user.theme || state.theme || "midnight",
  };
  state.pendingAvatar = undefined;

  $("avatar-error").textContent = "";
  $("settings-error").textContent = "";
  $("settings-name").value = state.draft.display_name;
  $("settings-bio").value = state.draft.bio;
  $("bio-counter").textContent = String(state.draft.bio.length);
  $("settings-color").value = state.draft.avatar_color;

  renderColorPresets();
  renderFrames();
  renderBanners();
  renderThemeGrid();
  renderFontOptions(state.draft.font_family);
  renderSettingsAvatar();

  // приватность
  renderBlockedList();
  renderIgnoredList();
  if (typeof onSettingsOpened === "function") onSettingsOpened();

  switchSettingsTab(tab);
  $("settings-modal").classList.add("active");
}

function switchSettingsTab(tab) {
  state.settingsTab = tab;
  document.querySelectorAll(".settings-tab").forEach((btn) => {
    btn.classList.toggle("active", btn.dataset.tab === tab);
  });
  document.querySelectorAll(".settings-pane").forEach((pane) => {
    pane.classList.toggle("active", pane.id === "settings-tab-" + tab);
  });
}

function renderSettingsAvatar() {
  if (!state.draft) return;
  const preview = {
    username: state.user.username,
    display_name: state.draft.display_name || state.user.username,
    avatar_color: state.draft.avatar_color,
    avatar_frame: state.draft.avatar_frame,
    avatar_ver: state.pendingAvatar !== undefined ? "" : state.user.avatar_ver,
  };

  fillAvatarSlot($("settings-avatar-slot"), preview, "av-xl", {
    frame: state.draft.avatar_frame,
    avatarVer: preview.avatar_ver,
  });

  // если выбрали новую аватарку — показываем её сразу
  if (typeof state.pendingAvatar === "string" && state.pendingAvatar.startsWith("data:")) {
    const slot = $("settings-avatar-slot");
    const inner = slot.querySelector(".av-inner");
    if (inner) {
      const img = document.createElement("img");
      img.src = state.pendingAvatar;
      img.alt = "";
      inner.insertBefore(img, inner.firstChild);
    }
  }

  const banner = $("settings-banner");
  banner.className = "settings-banner banner-" + state.draft.banner;
}

function renderFrames() {
  const grid = $("frames-grid");
  clear(grid);
  const frames = state.frames && state.frames.length ? state.frames : FALLBACK_FRAMES;

  frames.forEach((frame) => {
    const option = el("button", "frame-option" + (state.draft.avatar_frame === frame ? " selected" : ""));
    option.type = "button";
    option.appendChild(avatarNode({
      username: state.user.username,
      display_name: state.draft.display_name || state.user.username,
      avatar_color: state.draft.avatar_color,
      avatar_ver: state.pendingAvatar !== undefined ? "" : state.user.avatar_ver,
    }, "", { frame, avatarVer: state.pendingAvatar !== undefined ? "" : state.user.avatar_ver }));
    option.appendChild(el("span", "frame-option-name", FRAME_LABELS[frame] || frame));

    option.addEventListener("click", () => {
      state.draft.avatar_frame = frame;
      renderFrames();
      renderSettingsAvatar();
    });
    grid.appendChild(option);
  });
}

function renderBanners() {
  const grid = $("banners-grid");
  clear(grid);
  const banners = state.banners && state.banners.length ? state.banners : FALLBACK_BANNERS;

  banners.forEach((banner) => {
    const option = el("button", "banner-option banner-" + banner + (state.draft.banner === banner ? " selected" : ""));
    option.type = "button";
    option.title = BANNER_LABELS[banner] || banner;
    option.addEventListener("click", () => {
      state.draft.banner = banner;
      renderBanners();
      renderSettingsAvatar();
    });
    grid.appendChild(option);
  });
}

function renderThemeGrid() {
  const grid = $("theme-grid");
  if (!grid) return;
  clear(grid);
  const themes = state.themes && state.themes.length ? state.themes : FALLBACK_THEMES;

  themes.forEach((theme) => {
    const option = el("button", "theme-option theme-preview-" + theme + (state.draft.theme === theme ? " selected" : ""));
    option.type = "button";
    option.title = THEME_LABELS[theme] || theme;
    option.appendChild(el("span", "theme-swatch"));
    option.appendChild(el("span", "theme-name", THEME_LABELS[theme] || theme));

    option.addEventListener("click", () => {
      state.draft.theme = theme;
      applyColorTheme(theme); // живой предпросмотр всей темы
      renderThemeGrid();
    });
    grid.appendChild(option);
  });
}

function renderColorPresets() {
  const box = $("color-presets");
  clear(box);
  COLOR_PRESETS.forEach((color) => {
    const btn = el("button", "color-preset" + (state.draft.avatar_color === color ? " selected" : ""));
    btn.type = "button";
    btn.style.background = color;
    btn.title = color;
    btn.addEventListener("click", () => {
      state.draft.avatar_color = color;
      $("settings-color").value = color;
      renderColorPresets();
      renderFrames();
      renderSettingsAvatar();
    });
    box.appendChild(btn);
  });
}

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
  if (state.draft) state.draft.font_family = font;
  $("font-preview").style.fontFamily = font;
  document.documentElement.style.setProperty("--app-font", font);

  const chat = $("font-preview-chat");
  clear(chat);
  if (state.user) {
    const row = el("div", "preview-msg");
    row.appendChild(avatarNode({ ...state.user, avatar_frame: "none" }, "", { frame: "none" }));
    const body = el("div", "preview-msg-body");
    body.appendChild(el("div", "preview-msg-name", state.draft ? state.draft.display_name : state.user.display_name));
    body.appendChild(el("div", "preview-msg-text", "Привет! Так выглядит текст в этом шрифте."));
    row.appendChild(body);
    chat.appendChild(row);
  }
}

function closeSettings() {
  $("settings-modal").classList.remove("active");
  state.draft = null;
  state.pendingAvatar = undefined;
  applyTheme(); // откатываем предпросмотр шрифта
}

// ---------- аватарка ----------
function pickAvatarFile() {
  $("avatar-input").click();
}

function resizeImageToSquare(file, size = 256) {
  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(file);
    const img = new Image();
    img.onload = () => {
      try {
        const side = Math.min(img.width, img.height);
        const sx = (img.width - side) / 2;
        const sy = (img.height - side) / 2;

        const canvas = document.createElement("canvas");
        canvas.width = size;
        canvas.height = size;
        const ctx = canvas.getContext("2d");
        ctx.imageSmoothingQuality = "high";
        ctx.drawImage(img, sx, sy, side, side, 0, 0, size, size);

        const keepAlpha = file.type === "image/png" || file.type === "image/gif";
        const dataUrl = keepAlpha
          ? canvas.toDataURL("image/png")
          : canvas.toDataURL("image/jpeg", 0.86);
        URL.revokeObjectURL(url);
        resolve(dataUrl);
      } catch (err) {
        URL.revokeObjectURL(url);
        reject(err);
      }
    };
    img.onerror = () => {
      URL.revokeObjectURL(url);
      reject(new Error("Не удалось прочитать картинку"));
    };
    img.src = url;
  });
}

async function handleAvatarFile(file) {
  const errorEl = $("avatar-error");
  errorEl.textContent = "";

  if (!file) return;
  if (!file.type.startsWith("image/")) {
    errorEl.textContent = "Это не картинка";
    return;
  }
  if (file.size > 8 * 1024 * 1024) {
    errorEl.textContent = "Файл больше 8 МБ";
    return;
  }

  try {
    const dataUrl = await resizeImageToSquare(file, 256);
    if (dataUrl.length > 400_000) {
      errorEl.textContent = "Картинка слишком тяжёлая, попробуй другую";
      return;
    }

    const data = await api("/api/avatar", { method: "POST", body: { avatar: dataUrl } });
    applyUserUpdate(data.user);
    state.pendingAvatar = undefined;
    renderSettingsAvatar();
    renderFrames();
    toast("Аватарка обновлена", "success");
  } catch (err) {
    errorEl.textContent = err.message || "Не удалось загрузить";
  }
}

async function removeAvatar() {
  const errorEl = $("avatar-error");
  errorEl.textContent = "";
  try {
    const data = await api("/api/avatar", { method: "POST", body: { avatar: "" } });
    applyUserUpdate(data.user);
    state.pendingAvatar = undefined;
    renderSettingsAvatar();
    renderFrames();
    toast("Аватарка удалена", "success");
  } catch (err) {
    errorEl.textContent = err.message;
  }
}

function applyUserUpdate(user) {
  if (!user) return;
  state.user = { ...state.user, ...user };
  localStorage.setItem("swaptime_user", JSON.stringify(state.user));
  renderMeBar();
  renderDMList();
  renderRail();
  if (state.current) updateChatHeader(getChat(state.current));
}

async function saveSettings() {
  if (!state.draft) return;
  const btn = $("settings-save");
  const errorEl = $("settings-error");
  errorEl.textContent = "";
  btn.disabled = true;

  try {
    const data = await api("/api/update_profile", {
      method: "POST",
      body: {
        display_name: $("settings-name").value.trim(),
        avatar_color: state.draft.avatar_color,
        avatar_frame: state.draft.avatar_frame,
        banner: state.draft.banner,
        bio: $("settings-bio").value.trim(),
        font_family: $("settings-font").value,
        theme: state.draft.theme,
      },
    });
    applyUserUpdate(data.user);
    if (typeof savePresenceFromSettings === "function") await savePresenceFromSettings();
    if (typeof saveNotifySettings === "function") saveNotifySettings();
    applyTheme();
    closeSettings();
    await refreshChats();
    toast("Профиль обновлён", "success");
  } catch (err) {
    errorEl.textContent = err.message;
  } finally {
    btn.disabled = false;
  }
}

function renderBlockedList() {
  const list = $("blocked-list");
  clear(list);
  const items = state.blockedUsers.length
    ? state.blockedUsers
    : state.blocked.map((u) => ({ username: u, display_name: u }));

  if (!items.length) {
    list.appendChild(el("div", "loading-small", "Пусто"));
    return;
  }

  items.forEach((user) => {
    const row = el("div", "setting-item");
    row.appendChild(el("span", "", "@" + user.username));
    const btn = el("button", "", "Разблокировать");
    btn.addEventListener("click", () => unblockUser(user.username));
    row.appendChild(btn);
    list.appendChild(row);
  });
}

function renderIgnoredList() {
  const list = $("ignored-list");
  clear(list);
  const items = state.ignoredUsers.length
    ? state.ignoredUsers
    : state.ignored.map((u) => ({ username: u, display_name: u }));

  if (!items.length) {
    list.appendChild(el("div", "loading-small", "Пусто"));
    return;
  }

  items.forEach((user) => {
    const row = el("div", "setting-item");
    row.appendChild(el("span", "", "@" + user.username));
    const btn = el("button", "", "Убрать игнор");
    btn.addEventListener("click", () => unignoreUser(user.username));
    row.appendChild(btn);
    list.appendChild(row);
  });
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
    renderBlockedList();
    renderIgnoredList();
  } catch (err) {
    toast(err.message, "error");
  }
}

// ============================================================
// СОБЫТИЯ
// ============================================================
const ACTIONS = {
  "open-settings": () => openSettings(),
  "close-settings": () => closeSettings(),
  "logout": () => logout(),
  "install-app": () => {
    if (window.__swaptimeInstall) window.__swaptimeInstall();
  },
  "add-friend": () => openAddFriend(),
  "close-add-friend": () => closeAddFriend(),
  "send-friend-request": () => sendFriendRequest(),
  "my-profile": () => openMyProfile(),
  "close-profile": () => closeProfile(),
  "chat-profile": () => openChatProfile(),
  "close-chat": () => closeChatMobile(),
  "toggle-pins": () => togglePinsPopover(),
  "toggle-server-pins": () => {
    if (typeof toggleServerPinsPopover === "function") toggleServerPinsPopover();
  },
  "cancel-reply": () => cancelReply(),
  "cancel-edit": () => cancelEdit(),
  "write-to-user": () => writeToUser(),
  "toggle-ignore": () => toggleIgnoreCurrentUser(),
  "toggle-block": () => toggleBlockCurrentUser(),
  "remove-friend": () => removeCurrentFriend(),
  "pick-avatar": () => pickAvatarFile(),
  "remove-avatar": () => removeAvatar(),

  // серверы
  "create-server": () => openServerModal(),
  "close-server-modal": () => closeModal("server-modal"),
  "save-server": () => saveServer(),
  "server-menu": () => openServerMenu(),
  "close-server-menu": () => closeModal("server-menu-modal"),
  "create-server-channel": () => openChannelModal(),
  "close-channel-modal": () => closeModal("channel-modal"),
  "save-channel": () => saveChannel(),
  "copy-invite": () => copyInvite(),
  "leave-server": () => leaveServer(),
  "delete-server": () => deleteServer(),
  "edit-server": () => editServer(),
  "open-join-modal": () => openJoinModal(),
  "close-join-modal": () => closeModal("join-server-modal"),
  "join-server": () => joinServer(),
  "toggle-members": () => toggleMembers(),
  "close-server-chat": () => { setMobilePane(false); },

  // каналы (telegram)
  "create-channel": () => openTgModal(),
  "close-tg-modal": () => closeModal("tg-modal"),
  "save-tg-channel": () => saveTgChannel(),
  "delete-tg-channel": () => deleteTgChannel(),
  "discover-channels": () => openDiscover(),
  "close-discover": () => closeModal("discover-modal"),
  "tg-subscribe": () => toggleTgSubscription(),
  "tg-settings": () => openTgSettings(),
  "publish-post": () => publishPost(),
  "close-tg": () => { setMobilePane(false); },

  // звонки
  "start-audio-call": () => startCall({ video: false }),
  "start-video-call": () => startCall({ video: true }),
  "call-from-profile": () => { const u = state.profileData; closeProfile(); if (u) startCall({ video: true, withUser: u.username }); },
  "accept-call": () => acceptIncomingCall(),
  "reject-call": () => rejectIncomingCall(),
  "toggle-mic": () => toggleMic(),
  "toggle-cam": () => toggleCam(),
  "toggle-screen": () => toggleScreenShare(),
  "hangup": () => hangupCall(),
  "open-call-settings": () => toggleCallSettingsPanel(),
  "apply-call-settings": () => applyCallSettings(),
  "start-call-from-server": () => toast("Выбери участника справа и нажми «Позвонить»", "info"),
};

function bindEvents() {
  // все кнопки вешаем из JS (без inline-обработчиков)
  document.querySelectorAll("[data-action]").forEach((node) => {
    const handler = ACTIONS[node.dataset.action];
    if (!handler) return;
    node.addEventListener("click", (event) => {
      event.preventDefault();
      handler();
    });
  });

  $("send-btn").addEventListener("click", () => sendMessage());
  $("settings-save").addEventListener("click", () => saveSettings());
  $("login-form").addEventListener("submit", (event) => {
    event.preventDefault();
    doLogin();
  });
  $("register-form").addEventListener("submit", (event) => {
    event.preventDefault();
    doRegister();
  });
  document.querySelectorAll(".auth-tab").forEach((tab) => {
    tab.addEventListener("click", () => {
      document.querySelectorAll(".auth-tab").forEach((t) => t.classList.remove("active"));
      tab.classList.add("active");
      document.querySelectorAll(".auth-form").forEach((f) => f.classList.remove("active"));
      const form = $(tab.dataset.tab + "-form");
      if (form) form.classList.add("active");
    });
  });

  document.querySelectorAll(".rail-btn[data-view]").forEach((btn) => {
    btn.addEventListener("click", () => {
      setMobilePane(false);
      setView(btn.dataset.view);
    });
  });

  $("add-server-btn") && $("add-server-btn").addEventListener("click", () => openServerModal());

  document.querySelectorAll(".ftab").forEach((tab) => {
    tab.addEventListener("click", () => {
      state.friendsTab = tab.dataset.tab;
      renderFriendsPanel();
    });
  });

  document.querySelectorAll(".settings-tab").forEach((tab) => {
    tab.addEventListener("click", () => switchSettingsTab(tab.dataset.tab));
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

  // тач-экраны: кнопки сообщения появляются по тапу
  document.addEventListener("click", (event) => {
    if (!window.matchMedia("(hover: none)").matches) return;
    const wrapper = event.target.closest(".message-wrapper");
    document.querySelectorAll(".message-wrapper.show-actions").forEach((node) => {
      if (node !== wrapper) node.classList.remove("show-actions");
    });
    if (!wrapper || event.target.closest(".msg-btn, .reply-quote")) return;
    wrapper.classList.toggle("show-actions");
  });

  $("search-users").addEventListener("input", () => {
    if (state.view === "friends") renderFriendsPanel();
    else if (state.view === "tg" && typeof renderTgList === "function") renderTgList();
    else if (state.view === "server" && typeof renderServerChannels === "function") renderServerChannels();
    else renderDMList();
  });

  $("server-input") && $("server-input").addEventListener("keydown", (event) => {
    if (event.key === "Enter" && !event.shiftKey) {
      event.preventDefault();
      if (typeof sendServerMessage === "function") sendServerMessage();
    }
  });
  $("server-input") &&
    $("server-input").addEventListener("input", () => {
      if (typeof sendServerTyping === "function") sendServerTyping();
    });
  $("server-send-btn") &&
    $("server-send-btn").addEventListener("click", () => {
      if (typeof sendServerMessage === "function") sendServerMessage();
    });

  $("tg-post-input") && $("tg-post-input").addEventListener("keydown", (event) => {
    if (event.key === "Enter" && (event.ctrlKey || event.metaKey)) {
      event.preventDefault();
      if (typeof publishPost === "function") publishPost();
    }
  });

  $("invite-code-input") && $("invite-code-input").addEventListener("keydown", (event) => {
    if (event.key === "Enter" && typeof joinServer === "function") joinServer();
  });
  $("discover-input") &&
    $("discover-input").addEventListener("input", () => {
      if (typeof searchDiscover === "function") searchDiscover();
    });

  $("friend-username").addEventListener("keydown", (event) => {
    if (event.key === "Enter") sendFriendRequest();
  });

  $("settings-font").addEventListener("change", updateFontPreview);

  $("settings-name").addEventListener("input", () => {
    if (!state.draft) return;
    state.draft.display_name = $("settings-name").value;
    renderSettingsAvatar();
  });

  $("settings-bio").addEventListener("input", () => {
    if (!state.draft) return;
    state.draft.bio = $("settings-bio").value;
    $("bio-counter").textContent = String(state.draft.bio.length);
  });

  $("settings-color").addEventListener("input", () => {
    if (!state.draft) return;
    state.draft.avatar_color = $("settings-color").value;
    renderColorPresets();
    renderSettingsAvatar();
    renderFrames();
  });

  $("avatar-input").addEventListener("change", (event) => {
    const file = event.target.files && event.target.files[0];
    handleAvatarFile(file);
    event.target.value = "";
  });

  // закрытие по клику на фон
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

// ============================================================
// ИНИЦИАЛИЗАЦИЯ
// ============================================================
document.addEventListener("DOMContentLoaded", async () => {
  if (state.booted) return; // jsdom/некоторые браузеры могут кинуть событие дважды
  state.booted = true;
  bindEvents();
  generateCaptcha();
  applyFont(FALLBACK_FONTS[0]);
  applyColorTheme(state.theme);

  const lastName = localStorage.getItem("swaptime_last_user");
  if (lastName) $("login-username").value = lastName;

  if (!state.token) {
    showScreen("auth");
    return;
  }

  try {
    const data = await api("/api/me");
    state.user = data.user;
    state.fonts = data.fonts && data.fonts.length ? data.fonts : FALLBACK_FONTS;
    state.frames = data.frames && data.frames.length ? data.frames : FALLBACK_FRAMES;
    state.banners = data.banners && data.banners.length ? data.banners : FALLBACK_BANNERS;
    state.themes = data.themes && data.themes.length ? data.themes : FALLBACK_THEMES;
    state.statuses = data.statuses || ["online", "idle", "dnd", "invisible"];
    localStorage.setItem("swaptime_user", JSON.stringify(state.user));
    enterApp();
  } catch (err) {
    if (err.status !== 401) {
      const saved = localStorage.getItem("swaptime_user");
      if (saved) {
        try { state.user = JSON.parse(saved); } catch (e) {}
      }
      showScreen("auth");
      $("login-error").textContent = err.message || "Сервер недоступен";
    } else {
      showScreen("auth");
    }
  }
});
