// Тесты v12: реакции, поиск, черновики, избранное, закрепление чатов,
// тихие чаты, форматирование, быстрый переход, статусы.
// Требуется: npm install jsdom
const fs = require("fs");
const path = require("path");
const assert = require("assert");
const { JSDOM } = require("jsdom");

const ROOT = path.resolve(__dirname, "../..");
const html = fs
  .readFileSync(ROOT + "/frontend/index.html", "utf8")
  .replace(/<script[\s\S]*?<\/script>/g, "");
const scripts = ["script.js", "servers.js", "channels.js", "calls.js", "features.js"].map((f) =>
  fs.readFileSync(ROOT + "/frontend/" + f, "utf8")
);
const js = scripts.join("\n;\n");

const ME = {
  id: 1, username: "alice", display_name: "Алиса", avatar_color: "#e53935",
  avatar_ver: "", avatar_frame: "gold", banner: "ocean", bio: "", theme: "midnight",
  font_family: "Inter, sans-serif", last_seen: 0, created_at: 1700000000,
  has_avatar: false, status: "online", status_text: "",
};

const BOB = {
  username: "bob", display_name: "Боб", avatar_color: "#3b82f6", avatar_ver: "",
  avatar_frame: "none", online: true, status: "idle", status_text: "обедаю",
};

const CHAT_MESSAGES = [
  { id: 11, from: "bob", to: "alice", text: "привет **жирный**", reply_to: 0, edited: 0, deleted: 0,
    created_at: 1700000100, pinned: false, pinned_by: "", pinned_at: 0, fwd_from: "", fwd_name: "",
    reactions: [{ emoji: "👍", count: 2, users: ["bob", "alice"] }] },
  { id: 12, from: "alice", to: "bob", text: "тут `код` и ||секрет||", reply_to: 0, edited: 0, deleted: 0,
    created_at: 1700000200, pinned: false, pinned_by: "", pinned_at: 0, fwd_from: "", fwd_name: "",
    reactions: [] },
];

const requests = [];
const wsSent = [];

function jsonResponse(data, status = 200) {
  return Promise.resolve({ ok: status < 300, status, text: () => Promise.resolve(JSON.stringify(data)) });
}

function fakeFetch(url, options = {}) {
  const p = String(url).replace("http://localhost:8000", "");
  const body = options.body ? JSON.parse(options.body) : null;
  requests.push({ path: p, body, method: options.method || "GET" });
  const clean = p.split("?")[0];

  if (clean === "/api/me") {
    return jsonResponse({
      user: { ...ME }, fonts: [], frames: [], banners: [], themes: ["midnight"],
      statuses: ["online", "idle", "dnd", "invisible"],
    });
  }
  if (clean === "/api/chats") return jsonResponse({ chats: [{ ...BOB, unread: 3, last_message: null }], unread: { bob: 3 } });
  if (clean === "/api/friends") return jsonResponse({ friends: [BOB], requests: [], outgoing: [], blocked: [], ignored: [], blocked_users: [], ignored_users: [] });
  if (clean === "/api/servers") return jsonResponse({ servers: [] });
  if (clean === "/api/tg/channels") return jsonResponse({ channels: [] });
  if (clean === "/api/messages/alice/bob") return jsonResponse(CHAT_MESSAGES.map((m) => ({ ...m })));
  if (clean === "/api/pins/bob") return jsonResponse({ pins: [] });
  if (clean === "/api/presence") return jsonResponse({ ok: true, status: body.status, status_text: body.status_text, statuses: ["online", "idle", "dnd", "invisible"] });
  if (clean === "/api/reactions") return jsonResponse({ ok: true, reactions: [{ emoji: body.emoji, count: 1, users: ["alice"] }] });
  if (clean === "/api/update_profile") return jsonResponse({ ok: true, user: { ...ME, ...body } });
  return jsonResponse({ ok: true });
}

function makeWindow() {
  const dom = new JSDOM(html, { url: "http://localhost:8000/", runScripts: "outside-only", pretendToBeVisual: true });
  const { window } = dom;
  const errors = [];
  window.addEventListener("error", (e) => errors.push(e.message));

  window.confirm = () => true;
  window.matchMedia = (query) => ({
    matches: query.includes("min-width: 761px"),
    addListener() {}, removeListener() {}, addEventListener() {}, removeEventListener() {},
  });
  window.Element.prototype.scrollIntoView = function () {};
  window.URL.createObjectURL = () => "blob:fake";
  window.fetch = fakeFetch;
  window.Notification = class { constructor() {} static permission = "denied"; static requestPermission() { return Promise.resolve("denied"); } };
  window.AudioContext = class {
    constructor() { this.currentTime = 0; this.destination = {}; }
    createOscillator() { return { type: "", frequency: { value: 0 }, connect() { return this; }, start() {}, stop() {} }; }
    createGain() { return { gain: { setValueAtTime() {}, exponentialRampToValueAtTime() {} }, connect() { return this; } }; }
  };

  window.MediaStream = class MediaStream {
    constructor(tracks = []) { this.tracks = tracks; }
    getTracks() { return this.tracks; }
    getAudioTracks() { return this.tracks; }
    getVideoTracks() { return []; }
    addTrack(t) { this.tracks.push(t); }
  };
  window.navigator.mediaDevices = {
    getUserMedia: () => Promise.resolve(new window.MediaStream([{ kind: "audio", stop() {} }])),
    getDisplayMedia: () => Promise.resolve(new window.MediaStream([{ kind: "video", stop() {} }])),
  };
  window.RTCPeerConnection = class {
    constructor() { this.connectionState = "new"; }
    addTransceiver() { return { sender: { replaceTrack() { return Promise.resolve(); } }, setCodecPreferences() {} }; }
    getSenders() { return []; }
    createOffer() { return Promise.resolve({ type: "offer", sdp: "v=0" }); }
    createAnswer() { return Promise.resolve({ type: "answer", sdp: "v=0" }); }
    setLocalDescription() { return Promise.resolve(); }
    setRemoteDescription() { return Promise.resolve(); }
    addIceCandidate() { return Promise.resolve(); }
    getStats() { return Promise.resolve(new Map()); }
    close() {}
  };
  window.RTCSessionDescription = class { constructor(d) { Object.assign(this, d); } };
  window.RTCIceCandidate = class { constructor(d) { Object.assign(this, d); } };

  class FakeWS {
    static instances = [];
    constructor() {
      this.readyState = 0;
      FakeWS.instances.push(this);
      setTimeout(() => { this.readyState = 1; this.onopen && this.onopen(); }, 0);
    }
    send(data) { wsSent.push(JSON.parse(data)); }
    close() { this.readyState = 3; }
  }
  FakeWS.CONNECTING = 0; FakeWS.OPEN = 1; FakeWS.CLOSED = 3;
  window.WebSocket = FakeWS;
  window.localStorage.setItem("swaptime_token", "tok");

  window.eval(
    js +
      "\nwindow.__api = { state, openChat, openSettings, saveSettings, setView, renderDMList," +
      " renderRichText: typeof renderRichText === 'function' ? renderRichText : null," +
      " toggleReaction: typeof toggleReaction === 'function' ? toggleReaction : null," +
      " applyReactionEvent: typeof applyReactionEvent === 'function' ? applyReactionEvent : null," +
      " openChatSearch: typeof openChatSearch === 'function' ? openChatSearch : null," +
      " runSearch: typeof runSearch === 'function' ? runSearch : null," +
      " openFavorites: typeof openFavorites === 'function' ? openFavorites : null," +
      " openQuickSwitch: typeof openQuickSwitch === 'function' ? openQuickSwitch : null," +
      " toggleMute: typeof toggleMute === 'function' ? toggleMute : null," +
      " toggleSavedMessage: typeof toggleSavedMessage === 'function' ? toggleSavedMessage : null," +
      " presenceLabel: typeof presenceLabel === 'function' ? presenceLabel : null," +
      " handleSocketMessage: typeof handleSocketMessage === 'function' ? handleSocketMessage : null };"
  );

  return { window, document: window.document, errors, FakeWS };
}

const tick = (ms = 40) => new Promise((r) => setTimeout(r, ms));

async function run() {
  const { window, document, errors, FakeWS } = makeWindow();
  await tick(160);

  const api = window.__api;
  const state = api.state;
  assert.strictEqual(state.user.username, "alice");
  assert.strictEqual(errors.length, 0, "ошибки при инициализации: " + errors.join("; "));

  // ---------- открытие чата ----------
  await api.openChat("bob");
  await tick(120);
  const wrappers = document.querySelectorAll("#messages .message-wrapper");
  assert.strictEqual(wrappers.length, 2, "оба сообщения отрисованы");

  // ---------- форматирование ----------
  assert(document.querySelector("#messages .rich-bold"), "**жирный** отрендерен");
  assert(document.querySelector("#messages .rich-code"), "`код` отрендерен");
  assert(document.querySelector("#messages .rich-spoiler"), "||спойлер|| отрендерен");

  const spoiler = document.querySelector("#messages .rich-spoiler");
  spoiler.dispatchEvent(new window.MouseEvent("click", { bubbles: true }));
  assert(spoiler.classList.contains("revealed"), "спойлер раскрывается по клику");

  // ---------- реакции ----------
  const chips = document.querySelectorAll("#messages [data-msg-id='11'] .reaction-chip");
  assert(chips.length >= 1, "реакция отрисована");
  assert(document.querySelector("#messages [data-msg-id='11'] .reaction-chip.mine"), "своя реакция подсвечена");
  assert(document.querySelector("#messages [data-msg-id='11'] .reaction-emoji").textContent === "👍");
  // у сообщения без реакций нет пустого блока
  assert(!document.querySelector("#messages [data-msg-id='12'] .reactions"), "пустой блок реакций не рисуется");

  api.toggleReaction(CHAT_MESSAGES[0], "🎉", "dm");
  await tick(20);
  const reactWs = wsSent.find((m) => m.type === "reaction");
  assert(reactWs, "реакция уходит по WS");
  assert.strictEqual(reactWs.emoji, "🎉");

  // событие с сервера обновляет чипы
  api.applyReactionEvent({ type: "reaction", scope: "dm", message_id: 11, reactions: [{ emoji: "🔥", count: 1, users: ["bob"] }] });
  await tick(20);
  const updated = document.querySelector("#messages [data-msg-id='11'] .reaction-emoji");
  assert.strictEqual(updated.textContent, "🔥", "реакция обновилась из события");

  // ---------- избранное ----------
  assert(api.toggleSavedMessage(CHAT_MESSAGES[0], "dm") === true, "сообщение сохранено");
  const saved = JSON.parse(window.localStorage.getItem("swaptime_saved_messages"));
  assert.strictEqual(saved.length, 1);
  assert.strictEqual(saved[0].id, 11);
  api.openFavorites();
  await tick(30);
  assert(document.getElementById("favorites-modal").classList.contains("active"), "модалка избранного открылась");
  assert(document.querySelectorAll("#favorites-list .favorite-row").length === 1, "запись в списке");
  assert(api.toggleSavedMessage(CHAT_MESSAGES[0], "dm") === false, "повторное нажатие убирает из избранного");
  assert(document.querySelectorAll("#favorites-list .favorite-row").length === 0, "список очистился");

  // ---------- поиск ----------
  api.openChatSearch("dm");
  await tick(20);
  assert(document.getElementById("chat-search").style.display === "flex", "панель поиска открылась");
  api.runSearch("dm", "тут");
  await tick(20);
  assert.strictEqual(document.querySelectorAll("#messages .message-wrapper.search-hit").length, 1, "нашлось одно совпадение");
  assert(document.getElementById("chat-search-count").textContent.includes("/1"), "счётчик показывает совпадения");

  // ---------- черновики ----------
  const input = document.getElementById("message-input");
  input.value = "черновик в процессе";
  input.dispatchEvent(new window.Event("input", { bubbles: true }));
  await tick(30);
  assert.strictEqual(window.localStorage.getItem("swaptime_draft:dm:bob"), "черновик в процессе", "черновик сохранён");
  api.renderDMList();
  await tick(20);
  const preview = document.querySelector("#users-list .user-item .user-item-status");
  assert(preview.textContent.startsWith("Черновик:"), "в списке виден черновик: " + preview.textContent);

  // ---------- закрепление чата ----------
  document.querySelector("#users-list .user-item .chat-pin-btn").click();
  await tick(30);
  assert(JSON.parse(window.localStorage.getItem("swaptime_pinned_chats")).includes("bob"), "чат закреплён");
  assert(document.querySelector(".dm-group-label"), "группа «Закреплённые» есть");

  // ---------- тишина ----------
  api.toggleMute("dm", "bob");
  await tick(20);
  assert(document.getElementById("chat-mute-btn").textContent === "🔕", "кнопка показывает тишину");
  assert(JSON.parse(window.localStorage.getItem("swaptime_muted")).includes("dm:bob"), "тишина сохранена");

  // ---------- быстрый переход ----------
  api.openQuickSwitch();
  await tick(30);
  assert(document.getElementById("quick-switch").classList.contains("active"), "быстрый переход открылся");
  assert(document.querySelectorAll("#quick-switch-list .quick-row").length >= 2, "есть чат и настройки");
  const qsInput = document.getElementById("quick-switch-input");
  qsInput.value = "настрой";
  qsInput.dispatchEvent(new window.Event("input", { bubbles: true }));
  await tick(20);
  assert(document.querySelectorAll("#quick-switch-list .quick-row").length === 1, "фильтр сузил список");

  // ---------- статусы ----------
  assert.strictEqual(api.presenceLabel({ online: true, status: "dnd" }), "не беспокоить");
  assert.strictEqual(api.presenceLabel({ online: false, status: "online" }), "не в сети");

  api.openSettings("profile");
  await tick(40);
  const options = document.querySelectorAll("#status-row .status-option");
  assert.strictEqual(options.length, 4, "4 варианта статуса");
  options[2].click();
  document.getElementById("settings-status-text").value = "на созвоне";
  document.getElementById("settings-save").click();
  await tick(140);
  const presenceCall = requests.filter((r) => r.path === "/api/presence").pop();
  assert(presenceCall, "статус уходит на сервер");
  assert.strictEqual(presenceCall.body.status, "dnd");
  assert.strictEqual(presenceCall.body.status_text, "на созвоне");
  assert(state.user.status === "dnd", "локальный статус обновился");

  // ---------- статус друга в шапке ----------
  await api.openChat("bob");
  await tick(100);
  const chatStatus = document.getElementById("chat-status");
  assert(chatStatus.textContent.includes("отошёл"), "статус друга в шапке: " + chatStatus.textContent);

  // ---------- presence по WS ----------
  api.handleSocketMessage({ type: "presence", user: "bob", online: true, status: "dnd", status_text: "созвон" });
  await tick(40);
  assert(chatStatus.textContent.includes("не беспокоить"), "статус обновился по WS: " + chatStatus.textContent);

  assert.strictEqual(errors.length, 0, "ошибки по ходу теста: " + errors.join("; "));
  console.log("✅ Тесты v12 (реакции, поиск, черновики, избранное, статусы) прошли");
  process.exit(0);
}

run().catch((err) => {
  console.error("❌", err.message);
  console.error(err.stack);
  process.exit(1);
});
