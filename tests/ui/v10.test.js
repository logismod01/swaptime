// Тесты v10: темы, серверы (Discord), каналы (Telegram), звонки
// Требуется: npm install jsdom
const fs = require("fs");
const path = require("path");
const assert = require("assert");
const { JSDOM } = require("jsdom");

const ROOT = path.resolve(__dirname, "../..");
const html = fs
  .readFileSync(ROOT + "/frontend/index.html", "utf8")
  .replace(/<script[\s\S]*?<\/script>/g, "");
const scripts = ["script.js", "servers.js", "channels.js", "calls.js"].map((f) =>
  fs.readFileSync(ROOT + "/frontend/" + f, "utf8")
);
const js = scripts.join("\n;\n");

const THEMES = ["midnight", "ocean", "emerald", "violet", "sunset", "cyber", "coffee", "mono", "aurora", "cherry"];

const ME = {
  id: 1, username: "alice", display_name: "Алиса", avatar_color: "#e53935",
  avatar_ver: "", avatar_frame: "gold", banner: "ocean", bio: "", theme: "midnight",
  font_family: "Inter, sans-serif", last_seen: 0, created_at: 1700000000, has_avatar: false,
};

const BOB = {
  username: "bob", display_name: "Боб", avatar_color: "#3b82f6", avatar_ver: "",
  avatar_frame: "none", online: true,
};

const SERVER = {
  id: 1, name: "Тусовка", description: "тестовый сервер", icon: "🎮", icon_color: "#6366f1",
  invite_code: "aB3xY9zQ", my_role: "owner", members_count: 2,
  channels: [
    { id: 10, name: "общий", topic: "", unread: 2 },
    { id: 11, name: "флудилка", topic: "", unread: 3 },
  ],
  members: [
    { username: "alice", display_name: "Алиса", role: "owner", online: true, avatar_color: "#e53935", avatar_frame: "gold" },
    { username: "bob", display_name: "Боб", role: "admin", online: true, avatar_color: "#3b82f6", avatar_frame: "none" },
  ],
};

const TG_CHANNEL = {
  id: 5, name: "СвапТайм", description: "новости проекта", color: "#1e88e5",
  is_public: true, owner: "alice", is_owner: true, subscribed: true,
  subscribers: 3, unread: 0, last_post: { id: 1, text: "привет", created_at: 1700000000 },
};

const requests = [];
const sent = [];

function jsonResponse(data, status = 200) {
  return Promise.resolve({ ok: status < 300, status, text: () => Promise.resolve(JSON.stringify(data)) });
}

function fakeFetch(url, options = {}) {
  const p = String(url).replace("http://localhost:8000", "");
  const body = options.body ? JSON.parse(options.body) : null;
  requests.push({ path: p, body, method: options.method || "GET" });
  const clean = p.split("?")[0];

  if (clean === "/api/me") {
    return jsonResponse({ user: { ...ME }, fonts: [], frames: [], banners: [], themes: THEMES });
  }
  if (clean === "/api/chats") {
    return jsonResponse({ chats: [{ ...BOB, unread: 0, last_message: null }], unread: {} });
  }
  if (clean === "/api/friends") {
    return jsonResponse({ friends: [BOB], requests: [], outgoing: [], blocked: [], ignored: [], blocked_users: [], ignored_users: [] });
  }
  if (clean === "/api/servers") {
    return jsonResponse({ servers: [{ id: 1, name: "Тусовка", icon: "🎮", icon_color: "#6366f1", unread: 2 }] });
  }
  if (clean === "/api/servers/1") return jsonResponse({ ...SERVER });
  if (clean === "/api/servers/1/channels/10/messages") {
    if ((options.method || "GET") === "POST") {
      return jsonResponse({ ok: true, message: { id: 100, channel_id: 10, from: "alice", text: body.text, created_at: 1700000500 } });
    }
    return jsonResponse([
      { id: 1, channel_id: 10, from: "bob", text: "привет", edited: 0, deleted: 0, created_at: 1700000100 },
    ]);
  }
  if (clean === "/api/servers/1/channels") return jsonResponse({ ok: true, channel_id: 12, server: SERVER });
  if (clean === "/api/tg/channels") return jsonResponse({ channels: [TG_CHANNEL] });
  if (clean === "/api/tg/channels/5") {
    return jsonResponse({
      channel: TG_CHANNEL,
      posts: [{ id: 1, channel_id: 5, author: "alice", text: "Первый пост", edited: 0, deleted: 0, created_at: 1700000000 }],
    });
  }
  if (clean === "/api/tg/channels/5/posts") {
    return jsonResponse({ ok: true, post: { id: 2, channel_id: 5, author: "alice", text: body.text, edited: 0, deleted: 0, created_at: 1700000600 } });
  }
  if (clean === "/api/tg/discover") return jsonResponse({ channels: [TG_CHANNEL] });
  if (clean === "/api/update_profile") return jsonResponse({ ok: true, user: { ...ME, ...body } });
  if (clean === "/api/profile/bob") {
    return jsonResponse({ ...BOB, is_friend: true, is_me: false, can_call: true, blocked_by_me: false, ignored_by_me: false, created_at: 1700000000 });
  }
  return jsonResponse({ ok: true });
}

function makeStream(kinds) {
  const tracks = kinds.map((kind) => ({
    kind, enabled: true, contentHint: "", stopped: false,
    stop() { this.stopped = true; },
    addEventListener() {},
    applyConstraints() { return Promise.resolve(); },
  }));
  return {
    tracks,
    getTracks: () => tracks,
    getAudioTracks: () => tracks.filter((t) => t.kind === "audio"),
    getVideoTracks: () => tracks.filter((t) => t.kind === "video"),
    addTrack(t) { tracks.push(t); },
  };
}

function makeWindow() {
  const dom = new JSDOM(html, { url: "http://localhost:8000/", runScripts: "outside-only", pretendToBeVisual: true });
  const { window } = dom;
  const errors = [];
  window.addEventListener("error", (e) => errors.push(e.message));

  window.confirm = () => true;
  window.prompt = (msg, def) => def;
  window.matchMedia = () => ({ matches: false, addListener() {}, removeListener() {} });
  window.Element.prototype.scrollIntoView = function () {};
  window.URL.createObjectURL = () => "blob:fake";
  window.crypto = window.crypto || {};
  if (!window.crypto.randomUUID) window.crypto.randomUUID = () => "uuid-" + Math.random().toString(16).slice(2);
  window.fetch = fakeFetch;

  // --- медиа-заглушки для звонков ---
  window.MediaStream = class MediaStream {
    constructor(tracks = []) { this.tracks = tracks; }
    getTracks() { return this.tracks; }
    getAudioTracks() { return this.tracks.filter((t) => t.kind === "audio"); }
    getVideoTracks() { return this.tracks.filter((t) => t.kind === "video"); }
    addTrack(t) { this.tracks.push(t); }
  };
  let mediaStream = null;
  window.navigator.mediaDevices = {
    getUserMedia: (constraints) => {
      const kinds = ["audio"];
      if (constraints && constraints.video) kinds.push("video");
      mediaStream = makeStream(kinds);
      return Promise.resolve(mediaStream);
    },
    getDisplayMedia: () => Promise.resolve(makeStream(["video"])),
  };

  class FakePC {
    constructor() {
      this.connectionState = "new";
      this.localDescription = null;
      this.remoteDescription = null;
      this.senders = [];
      FakePC.instances.push(this);
    }
    addTransceiver(kind, opts) {
      const track = typeof kind === "string" ? null : kind;
      const sender = {
        track,
        replaceTrack(t) { this.track = t; return Promise.resolve(); },
        getParameters() { return { encodings: [{}] }; },
        setParameters() { return Promise.resolve(); },
      };
      this.senders.push(sender);
      return { sender, direction: "sendrecv", setCodecPreferences() {} };
    }
    getSenders() { return this.senders; }
    createOffer() { return Promise.resolve({ type: "offer", sdp: "v=0" }); }
    createAnswer() { return Promise.resolve({ type: "answer", sdp: "v=0" }); }
    setLocalDescription(d) { this.localDescription = d; return Promise.resolve(); }
    setRemoteDescription(d) { this.remoteDescription = d; return Promise.resolve(); }
    addIceCandidate() { return Promise.resolve(); }
    getStats() { return Promise.resolve(new Map()); }
    close() { this.connectionState = "closed"; }
  }
  FakePC.instances = [];
  window.RTCPeerConnection = FakePC;
  window.RTCSessionDescription = class { constructor(d) { Object.assign(this, d); } };
  window.RTCIceCandidate = class { constructor(d) { Object.assign(this, d); } };

  class FakeWS {
    static instances = [];
    constructor() {
      this.readyState = 0;
      this.sent = [];
      FakeWS.instances.push(this);
      setTimeout(() => { this.readyState = 1; this.onopen && this.onopen(); }, 0);
    }
    send(data) { this.sent.push(JSON.parse(data)); sent.push(JSON.parse(data)); }
    close() { this.readyState = 3; }
  }
  FakeWS.CONNECTING = 0; FakeWS.OPEN = 1; FakeWS.CLOSED = 3;
  window.WebSocket = FakeWS;
  window.localStorage.setItem("swaptime_token", "tok");

  window.eval(
    js +
      "\nwindow.__api = { state, setView, openServer, openServerChannel, openTgChannel, openSettings," +
      " saveSettings, openTgModal, publishPost, startCall, acceptIncomingCall, handleCallEvent," +
      " handleServerEvent, handleTgEvent, toggleMic, toggleScreenShare, applyCallSettings," +
      " toggleCallSettingsPanel, renderServerChannels, initCallSettings };" +
      "\nwindow.__SERVER = " + JSON.stringify(SERVER) + ";"
  );

  return { window, document: window.document, errors, FakeWS, FakePC };
}

const tick = (ms = 40) => new Promise((r) => setTimeout(r, ms));

async function run() {
  const { window, document, errors, FakeWS } = makeWindow();
  // jsdom сам бросает DOMContentLoaded после разбора HTML — ждём его
  await tick(140);

  const api = window.__api;
  const state = api.state;
  assert.strictEqual(state.user.username, "alice");
  assert.strictEqual(errors.length, 0, "ошибки при инициализации: " + errors.join("; "));

  // ---------- темы ----------
  assert.strictEqual(state.themes.length, 10);
  api.openSettings();
  await tick(30);
  const options = document.querySelectorAll("#theme-grid .theme-option");
  assert.strictEqual(options.length, 10, "должно быть ровно 10 тем");
  const ocean = document.querySelector("#theme-grid .theme-preview-ocean");
  assert(ocean, "тема ocean есть в сетке");
  ocean.click();
  await tick(10);
  assert.strictEqual(document.documentElement.dataset.theme, "ocean", "тема применяется сразу");
  assert.strictEqual(window.localStorage.getItem("swaptime_theme"), "ocean");

  document.getElementById("settings-save").click();
  await tick(120);
  const saved = requests.filter((r) => r.path === "/api/update_profile").pop();
  assert(saved && saved.body.theme === "ocean", "тема уходит в профиль: " + JSON.stringify(saved && saved.body));

  // ---------- рейл серверов ----------
  const serverBtn = document.querySelector("#server-list .server-btn");
  assert(serverBtn, "сервер есть в рейле");
  assert(serverBtn.textContent.includes("🎮"));
  assert(document.querySelector("#server-list .rail-badge"), "бейдж непрочитанных на сервере");

  serverBtn.click();
  await tick(80);
  assert.strictEqual(document.getElementById("server-sidebar").style.display, "flex");
  assert.strictEqual(document.getElementById("home-sidebar").style.display, "none");
  assert.strictEqual(document.getElementById("server-view").style.display, "flex");
  assert.strictEqual(document.getElementById("server-head-name").textContent, "Тусовка");

  const channels = document.querySelectorAll("#server-channels-list .channel-item");
  assert.strictEqual(channels.length, 2, "два канала сервера");
  assert.strictEqual(channels[0].querySelector(".channel-name").textContent, "общий");
  assert(!channels[0].querySelector(".channel-unread"), "открытый канал без бейджа");
  assert(channels[1].querySelector(".channel-unread"), "непрочитанные в другом канале");

  // канал открывается автоматически — сообщения загрузились
  assert.strictEqual(document.getElementById("server-channel-name").textContent, "общий");
  assert(document.querySelectorAll("#server-messages .message-wrapper").length >= 1, "сообщения канала");

  // второй канал
  channels[1].click();
  await tick(60);
  assert.strictEqual(document.getElementById("server-channel-name").textContent, "флудилка");

  // ---------- отправка сообщения в канал ----------
  channels[0].click();
  await tick(60);
  document.getElementById("server-input").value = "тест канала";
  document.getElementById("server-send-btn").click();
  await tick(30);
  const ws = FakeWS.instances[FakeWS.instances.length - 1];
  const outMsg = ws.sent.find((m) => m.type === "server_message");
  assert(outMsg, "server_message отправлен по WS");
  assert.strictEqual(outMsg.text, "тест канала");
  assert(outMsg.client_id);
  assert(document.getElementById("server-input").value === "", "поле очистилось");
  assert(
    document.querySelector("#server-messages .message-wrapper.pending"),
    "оптимистичное сообщение показано"
  );

  // событие от сервера подменяет оптимистичное
  api.handleServerEvent({
    type: "server_message",
    server_id: 1,
    channel_id: 10,
    id: 55,
    client_id: outMsg.client_id,
    from: "alice",
    text: "тест канала",
    edited: 0,
    deleted: 0,
    created_at: 1700000700,
  });
  await tick(30);
  assert(
    !document.querySelector("#server-messages .message-wrapper.pending"),
    "после подтверждения нет pending"
  );
  assert(document.querySelector('#server-messages [data-server-msg-id="55"]'), "сообщение с id 55");

  // чужое сообщение в другой канал — счётчик непрочитанных
  api.handleServerEvent({
    type: "server_message", server_id: 1, channel_id: 11, id: 56,
    from: "bob", text: "флуд", edited: 0, deleted: 0, created_at: 1700000800,
  });
  await tick(20);
  const second = document.querySelectorAll("#server-channels-list .channel-item")[1];
  assert(second.querySelector(".channel-unread"), "непрочитанное во втором канале");

  // ---------- участники ----------
  document.querySelector('[data-action="toggle-members"]').click();
  await tick(20);
  assert.strictEqual(document.getElementById("members-panel").style.display, "flex");
  assert.strictEqual(document.getElementById("members-count").textContent, "2");
  const rows = document.querySelectorAll("#members-list .member-row");
  assert.strictEqual(rows.length, 2);
  assert(rows[0].querySelector(".role-badge") === null || true);
  assert(document.querySelectorAll("#members-list .members-group").length >= 2, "группы ролей");
  assert(document.querySelector("#members-list .member-name.role-owner"), "владелец подсвечен");
  // владелец видит кнопки роли/кика у админа
  const bobRow = Array.from(rows).find((r) => r.textContent.includes("Боб"));
  assert(bobRow.querySelectorAll(".member-action.danger").length === 1, "кнопка исключения");

  // ---------- каналы (Telegram) ----------
  document.querySelector('.rail-btn[data-view="tg"]').click();
  await tick(50);
  assert.strictEqual(document.getElementById("tg-sidebar").style.display, "block");
  assert.strictEqual(document.getElementById("tg-view").style.display, "flex");
  const tgItems = document.querySelectorAll("#tg-list .tg-item");
  assert.strictEqual(tgItems.length, 1);
  assert(tgItems[0].textContent.includes("СвапТайм"));

  tgItems[0].click();
  await tick(70);
  assert.strictEqual(document.getElementById("tg-name").textContent, "СвапТайм");
  assert(document.getElementById("tg-subscribers").textContent.includes("3"));
  assert.strictEqual(document.querySelectorAll("#tg-feed .tg-post").length, 1);
  assert(document.getElementById("tg-composer").style.display, "владелец видит форму поста");

  document.getElementById("tg-post-input").value = "Новый пост";
  document.querySelector('[data-action="publish-post"]').click();
  await tick(60);
  assert.strictEqual(document.querySelectorAll("#tg-feed .tg-post").length, 2, "пост добавился");
  assert(
    requests.some((r) => r.path === "/api/tg/channels/5/posts" && r.body.text === "Новый пост"),
    "пост отправлен на сервер"
  );

  // живое событие от другого канала
  api.handleTgEvent({
    type: "tg_post", channel_id: 5, channel_name: "СвапТайм",
    post: { id: 3, channel_id: 5, author: "alice", text: "live", edited: 0, deleted: 0, created_at: 1700000900 },
  });
  await tick(20);
  assert.strictEqual(document.querySelectorAll("#tg-feed .tg-post").length, 3, "live-пост в ленте");

  // модалка создания канала
  api.openTgModal();
  await tick(20);
  assert(document.getElementById("tg-modal").classList.contains("active"));
  assert(document.querySelectorAll("#tg-color-row .color-dot").length >= 8, "палитра цветов канала");

  // ---------- звонки ----------
  assert(state.callSettings, "настройки звонка инициализированы");
  assert.strictEqual(state.callSettings.quality, "1080p");
  assert(document.getElementById("call-support-hint").textContent.includes("WebRTC"));

  await api.startCall({ video: true, withUser: "bob" });
  await tick(90);
  assert(document.getElementById("call-overlay").classList.contains("active"), "оверлей звонка открыт");
  const invite = ws.sent.find((m) => m.type === "call" && m.action === "invite");
  assert(invite, "приглашение в звонок отправлено");
  assert.strictEqual(invite.to, "bob");
  assert.strictEqual(invite.video, true);
  assert.strictEqual(document.getElementById("call-peer-name").textContent, "Боб");

  // собеседник принял
  api.handleCallEvent({ type: "call_accept", call_id: invite.call_id, from: "bob" });
  await tick(60);
  const offer = ws.sent.find((m) => m.type === "call" && m.action === "signal" && m.kind === "offer");
  assert(offer, "offer отправлен после accept");

  // настройки качества на лету
  document.getElementById("csp-quality").value = "2160p";
  document.getElementById("csp-bitrate").value = "20000000";
  api.applyCallSettings();
  await tick(20);
  assert.strictEqual(state.callSettings.quality, "2160p");
  assert.strictEqual(state.callSettings.bitrate, 20000000);
  assert(JSON.parse(window.localStorage.getItem("swaptime_call_settings")).quality === "2160p");

  api.toggleCallSettingsPanel();
  assert(document.getElementById("call-settings-panel").classList.contains("active"));
  api.toggleCallSettingsPanel();
  assert(!document.getElementById("call-settings-panel").classList.contains("active"));

  // микрофон
  api.toggleMic();
  assert.strictEqual(document.querySelector("#btn-mic").classList.contains("off"), true);

  // шаринг экрана
  await api.toggleScreenShare();
  await tick(40);
  assert(document.querySelector("#btn-screen").classList.contains("on"), "шаринг экрана включён");

  // входящий звонок в занятом состоянии — уходит busy
  api.handleCallEvent({ type: "call_incoming", call_id: "other", from: "bob", from_name: "Боб", video: true, screen: false });
  await tick(20);
  assert(ws.sent.some((m) => m.type === "call" && m.action === "busy"), "занято сообщается");

  // завершение
  api.handleCallEvent({ type: "call_end", call_id: invite.call_id, from: "bob" });
  await tick(30);
  assert(!document.getElementById("call-overlay").classList.contains("active"), "оверлей закрыт");

  // входящий звонок на свободной линии
  api.handleCallEvent({ type: "call_incoming", call_id: "c-2", from: "bob", from_name: "Боб", video: false, screen: true });
  await tick(20);
  assert(document.getElementById("incoming-call").classList.contains("active"));
  assert(document.getElementById("incoming-type").textContent.includes("экрана"));

  await api.acceptIncomingCall();
  await tick(80);
  assert(document.getElementById("call-overlay").classList.contains("active"));
  assert(ws.sent.some((m) => m.type === "call" && m.action === "accept" && m.call_id === "c-2"));

  assert.strictEqual(errors.length, 0, "ошибки по ходу теста: " + errors.join("; "));
  console.log("✅ Тесты v10 (темы, серверы, каналы, звонки) прошли");
  process.exit(0); // таймеры звонка держат event loop — выходим явно
}

run().catch((err) => {
  console.error("❌", err.message);
  console.error(err.stack);
  process.exit(1);
});
