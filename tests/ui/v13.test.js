// Тесты v13: вложения, опросы, категории каналов, реакции на постах,
// глобальный поиск, папки чатов, мобильные вкладки, онбординг,
// статистика сервера и стражовка раскладки (layout-guard).
// Требуется: npm install jsdom
const fs = require("fs");
const path = require("path");
const assert = require("assert");
const { JSDOM } = require("jsdom");

const ROOT = path.resolve(__dirname, "../..");
const html = fs
  .readFileSync(ROOT + "/frontend/index.html", "utf8")
  .replace(/<script[\s\S]*?<\/script>/g, "");
const SCRIPTS = ["layout-guard.js", "script.js", "servers.js", "channels.js", "calls.js", "features.js", "v13.js"];
const js = SCRIPTS.map((f) => fs.readFileSync(ROOT + "/frontend/" + f, "utf8")).join("\n;\n");

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

const PNG =
  "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8DwHwAFAAH/q842iQAAAABJRU5ErkJggg==";

const MESSAGES = [
  { id: 11, from: "bob", to: "alice", text: "привет", reply_to: 0, edited: 0, deleted: 0,
    created_at: 1700000100, pinned: false, reactions: [], attachment: null, poll: null },
  { id: 12, from: "bob", to: "alice", text: "с фото", reply_to: 0, edited: 0, deleted: 0,
    created_at: 1700000200, pinned: false, reactions: [],
    attachment: { kind: "image", data: PNG, name: "pixel.png", size: 95, duration: 0 }, poll: null },
  { id: 13, from: "alice", to: "bob", text: "", reply_to: 0, edited: 0, deleted: 0,
    created_at: 1700000300, pinned: false, reactions: [], attachment: null,
    poll: { question: "Куда пойдём?", options: ["Кино", "Кафе"], counts: [1, 0], total: 1,
            voters: [["alice"], []], my_vote: 0 } },
  { id: 14, from: "bob", to: "alice", text: "голосовое", reply_to: 0, edited: 0, deleted: 0,
    created_at: 1700000400, pinned: false, reactions: [],
    attachment: { kind: "audio", data: "data:audio/webm;base64,AAAA", name: "voice.webm", size: 3, duration: 7 },
    poll: null },
];

const CHANNEL_MESSAGES = [
  { id: 51, channel_id: 7, from: "alice", text: "в канале", edited: 0, deleted: 0,
    created_at: 1700000500, pinned: false, reactions: [] },
];

const TG_POSTS = [
  { id: 91, channel_id: 3, author: "alice", text: "Пост с реакцией", edited: 0, deleted: 0,
    created_at: 1700000600, reactions: [{ emoji: "🔥", count: 2, users: ["alice", "bob"] }] },
];

const requests = [];
const wsSent = [];

function jsonResponse(data, status = 200) {
  return Promise.resolve({ ok: status < 300, status, text: () => Promise.resolve(JSON.stringify(data)) });
}

function fakeFetch(url, options = {}) {
  const p = String(url).replace("http://localhost:8000", "");
  const body = options.body ? JSON.parse(options.body) : null;
  const method = options.method || "GET";
  requests.push({ path: p, body, method });
  const clean = p.split("?")[0];

  if (clean === "/api/me") {
    return jsonResponse({
      user: { ...ME }, fonts: [], frames: [], banners: [], themes: ["midnight"],
      statuses: ["online", "idle", "dnd", "invisible"],
    });
  }
  if (clean === "/api/chats") return jsonResponse({ chats: [{ ...BOB, unread: 2, last_message: null }], unread: { bob: 2 } });
  if (clean === "/api/friends") return jsonResponse({ friends: [BOB], requests: [], outgoing: [], blocked: [], ignored: [], blocked_users: [], ignored_users: [] });
  if (clean === "/api/servers") {
    return jsonResponse({ servers: [{ id: 1, name: "Тестовый", icon: "🚀", icon_color: "#e53935", unread: 0 }] });
  }
  if (clean === "/api/servers/1") {
    return jsonResponse({
      id: 1, name: "Тестовый", owner: "alice", my_role: "owner", invite_code: "abc123",
      channels: [
        { id: 6, name: "общий", topic: "", position: 0, category: "Текстовые", unread: 0 },
        { id: 7, name: "мемы", topic: "", position: 1, category: "Текстовые", unread: 0 },
        { id: 8, name: "флуд", topic: "", position: 2, category: "", unread: 0 },
      ],
      members: [{ username: "alice", role: "owner", display_name: "Алиса" }],
    });
  }
  if (clean === "/api/tg/channels") {
    return jsonResponse({ channels: [{ id: 3, name: "Новости", color: "#e53935", is_owner: true, subscribed: true, unread: 0 }] });
  }
  if (clean === "/api/tg/channels/3") {
    return jsonResponse({
      channel: { id: 3, name: "Новости", color: "#e53935", is_owner: true, subscribed: true, unread: 0, subscribers: 2 },
      posts: TG_POSTS.map((p) => ({ ...p })),
    });
  }
  if (clean === "/api/messages/alice/bob") return jsonResponse(MESSAGES.map((m) => ({ ...m })));
  if (clean === "/api/servers/1/channels/7/messages") return jsonResponse(CHANNEL_MESSAGES.map((m) => ({ ...m })));
  if (clean === "/api/pins/bob") return jsonResponse({ pins: [] });
  if (clean === "/api/servers/1/channels/7/pins") return jsonResponse({ pins: [] });
  if (clean === "/api/reactions") {
    return jsonResponse({ ok: true, reactions: [{ emoji: body.emoji, count: 1, users: ["alice"] }] });
  }
  if (clean === "/api/polls/vote") {
    return jsonResponse({
      ok: true,
      poll: { question: "Куда пойдём?", options: ["Кино", "Кафе"], counts: [0, 1], total: 1,
              voters: [[], ["bob"]], my_vote: 1 },
    });
  }
  if (clean === "/api/search/global") {
    return jsonResponse({
      query: "кино", total: 3,
      people: [{ username: "bob", display_name: "Боб", avatar_color: "#3b82f6", friend: true, online: true }],
      dms: [{ message_id: 11, peer: "bob", from: "bob", text: "…кино…", created_at: 1700000100 }],
      channels: [{ message_id: 51, server_id: 1, server_name: "Тестовый", channel_id: 7, channel_name: "мемы", from: "alice", text: "…кино…", created_at: 1700000500 }],
      posts: [{ post_id: 91, channel_id: 3, channel_name: "Новости", text: "…кино…", created_at: 1700000600 }],
    });
  }
  if (clean === "/api/servers/1/stats") {
    return jsonResponse({
      server: { id: 1, name: "Тестовый" }, days: 7, total_messages: 12, total_members: 2, period_messages: 5,
      members: [{ username: "alice", display_name: "Алиса", avatar_color: "#e53935", count: 5 }],
      channels: [{ id: 6, name: "общий", count: 3 }, { id: 7, name: "мемы", count: 2 }],
      by_day: Array.from({ length: 7 }, (_, i) => ({ date: "2024-01-0" + (i + 1), label: "0" + (i + 1) + ".01", count: i })),
    });
  }
  return jsonResponse({ ok: true });
}

function makeWindow() {
  const dom = new JSDOM(html, { url: "http://localhost:8000/", runScripts: "outside-only", pretendToBeVisual: true });
  const { window } = dom;
  const errors = [];
  window.addEventListener("error", (e) => errors.push(e.message));

  window.confirm = () => true;
  window.prompt = () => "Своя папка";
  window.matchMedia = (query) => ({
    matches: query.includes("min-width: 761px"),
    addListener() {}, removeListener() {}, addEventListener() {}, removeEventListener() {},
  });
  window.Element.prototype.scrollIntoView = function () {};
  window.URL.createObjectURL = () => "blob:fake";
  window.URL.revokeObjectURL = () => {};
  window.fetch = fakeFetch;
  window.Notification = class { constructor() {} static permission = "denied"; static requestPermission() { return Promise.resolve("denied"); } };
  window.AudioContext = class {
    constructor() { this.currentTime = 0; this.destination = {}; }
    createOscillator() { return { type: "", frequency: { value: 0 }, connect() { return this; }, start() {}, stop() {} }; }
    createGain() { return { gain: { setValueAtTime() {}, exponentialRampToValueAtTime() {} }, connect() { return this; } }; }
  };
  // jsdom не умеет Audio — глушим воспроизведение
  window.HTMLMediaElement.prototype.play = () => Promise.resolve();
  window.HTMLMediaElement.prototype.pause = () => {};
  window.HTMLMediaElement.prototype.load = () => {};

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
  window.localStorage.setItem("swaptime_onboarding_done", "1");

  window.eval(
    js +
      "\nwindow.__api = { state, openChat, setView, renderDMList, renderServerChannels, openServer," +
      " openServerChannel, openTgChannel, buildAttachmentNode: window.buildAttachmentNode," +
      " buildPollNode: window.buildPollNode, applyPollUpdate: window.applyPollUpdate," +
      " V13: window.V13, guard: window.SwapLayoutGuard," +
      " handleSocketMessage: typeof handleSocketMessage === 'function' ? handleSocketMessage : null };"
  );

  return { window, document: window.document, errors, FakeWS };
}

const tick = (ms = 60) => new Promise((r) => setTimeout(r, ms));

async function run() {
  const { window, document, errors } = makeWindow();
  await tick(200);

  const api = window.__api;
  const state = api.state;
  assert.strictEqual(state.user.username, "alice");
  assert.strictEqual(errors.length, 0, "ошибки при инициализации: " + errors.join("; "));
  assert(api.V13, "модуль v13 загрузился");

  // ---------- 0. стражовка раскладки ----------
  assert(api.guard && typeof api.guard.apply === "function", "layout-guard подключён");
  assert(document.getElementById("shell-critical"), "критический CSS каркаса встроен");
  api.guard.apply();
  const screen = document.getElementById("chat-screen");
  if (screen.classList.contains("active")) {
    assert.strictEqual(screen.style.getPropertyValue("position"), "fixed", "каркас зафиксирован");
    assert.strictEqual(screen.style.getPropertyPriority("overflow"), "important", "overflow задан жёстко");
  }

  // ---------- 1. вложения ----------
  await api.openChat("bob");
  await tick(150);
  assert.strictEqual(document.querySelectorAll("#messages .message-wrapper").length, 4, "история отрисована");
  const photos = document.querySelectorAll("#messages [data-msg-id='12'] .attach-image img");
  assert.strictEqual(photos.length, 1, "фото отрисовано");
  assert(photos[0].src.startsWith("data:image/png"), "картинка из data-url");
  assert(document.querySelector("#messages [data-msg-id='14'] .attach-audio"), "голосовое отрисовано");
  assert.strictEqual(document.querySelectorAll("#messages [data-msg-id='14'] .audio-bar").length, 28, "волна у голосового");

  // лайтбокс
  document.querySelector("#messages [data-msg-id='12'] .attach-image").dispatchEvent(
    new window.MouseEvent("click", { bubbles: true })
  );
  await tick(30);
  assert(document.getElementById("v13-lightbox"), "лайтбокс открылся");
  document.dispatchEvent(new window.KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
  assert(!document.getElementById("v13-lightbox"), "Escape закрывает лайтбокс");

  // ---------- 2. опрос ----------
  const pollCard = document.querySelector("#messages [data-msg-id='13'] .poll-card");
  assert(pollCard, "опрос отрисован");
  assert.strictEqual(pollCard.querySelector(".poll-question").textContent, "Куда пойдём?");
  assert.strictEqual(pollCard.querySelectorAll(".poll-option").length, 2);
  assert(pollCard.querySelectorAll(".poll-option")[0].classList.contains("mine"), "свой голос подсвечен");
  assert.strictEqual(pollCard.querySelector(".poll-option-count").textContent, "1");

  pollCard.querySelectorAll(".poll-option")[1].dispatchEvent(new window.MouseEvent("click", { bubbles: true }));
  await tick(120);
  const voteReq = requests.find((r) => r.path === "/api/polls/vote");
  assert(voteReq, "голос уходит на сервер");
  assert.strictEqual(voteReq.body.option, 1);
  assert.strictEqual(voteReq.body.scope, "dm");
  const afterVote = document.querySelector("#messages [data-msg-id='13'] .poll-card");
  assert(afterVote.querySelectorAll(".poll-option")[1].classList.contains("mine"), "голос применился");
  assert.strictEqual(afterVote.querySelectorAll(".poll-option-count")[1].textContent, "1", "счётчик второго варианта");
  assert.strictEqual(afterVote.querySelectorAll(".poll-option-count")[0].textContent, "0", "первый вариант обнулился");

  // событие обновления опроса
  api.handleSocketMessage({ type: "poll_update", scope: "dm", message_id: 13,
    poll: { question: "Куда пойдём?", options: ["Кино", "Кафе"], counts: [5, 7], total: 12, voters: [[], []], my_vote: null } });
  await tick(60);
  const liveCard = document.querySelector("#messages [data-msg-id='13'] .poll-card");
  assert.strictEqual(liveCard.querySelectorAll(".poll-option-count")[0].textContent, "5", "живые результаты");

  // ---------- 3. слэш-команды ----------
  assert(api.V13.applySlashText("/shrug", "dm").includes("¯"), "/shrug превращается в жест");
  assert(api.V13.applySlashText("/spoiler секрет", "dm") === "||секрет||", "/spoiler прячет текст");
  assert(api.V13.applySlashText("/me танцует", "dm").includes("танцует"), "/me работает");
  assert(/🎲/.test(api.V13.applySlashText("/roll 1-6", "dm")), "/roll бросает кубик");
  assert.strictEqual(api.V13.applySlashText("обычный текст", "dm"), "обычный текст", "обычный текст не трогаем");

  const input = document.getElementById("message-input");
  input.value = "/s";
  input.dispatchEvent(new window.Event("input", { bubbles: true }));
  await tick(40);
  const slashMenu = document.getElementById("slash-menu");
  assert(slashMenu && slashMenu.classList.contains("active"), "подсказки слэш-команд показаны");
  assert(slashMenu.querySelectorAll(".slash-item").length >= 1);
  input.value = "";
  input.dispatchEvent(new window.Event("input", { bubbles: true }));

  // ---------- 4. папки чатов ----------
  const tabs = document.querySelectorAll("#v13-folder-tabs .v13-folder");
  assert(tabs.length >= 6, "папки отрисованы: " + tabs.length);
  const labels = [...tabs].map((t) => t.textContent);
  assert(labels.some((l) => l.includes("Непрочитанные")), "есть папка непрочитанных");

  // в чате появилось непрочитанное (как будто пришло новое сообщение)
  state.chats[0].unread = 2;
  api.renderDMList();
  await tick(60);
  document.querySelector('#v13-folder-tabs [data-folder="unread"]').dispatchEvent(new window.MouseEvent("click", { bubbles: true }));
  await tick(60);
  const items = [...document.querySelectorAll("#users-list .user-item")];
  assert(items.length >= 1, "чаты в списке есть");
  assert(items.every((i) => i.style.display !== "none"), "непрочитанные (2) показываются");

  // а прочитанный чат в этой папке скрыт
  state.chats[0].unread = 0;
  api.renderDMList();
  await tick(60);
  assert([...document.querySelectorAll("#users-list .user-item")].every((i) => i.style.display === "none"), "прочитанные скрыты");
  document.querySelector('#v13-folder-tabs [data-folder="all"]').dispatchEvent(new window.MouseEvent("click", { bubbles: true }));
  await tick(60);
  assert([...document.querySelectorAll("#users-list .user-item")].every((i) => i.style.display !== "none"), "в папке «Все» видны все");

  // ---------- 5. глобальный поиск ----------
  api.V13.openGlobalSearch();
  await tick(40);
  const searchOverlay = document.getElementById("v13-global-search");
  assert(searchOverlay, "окно глобального поиска открылось");
  const searchInput = document.getElementById("v13-global-input");
  searchInput.value = "кино";
  searchInput.dispatchEvent(new window.Event("input", { bubbles: true }));
  await tick(400);
  const groups = document.querySelectorAll("#v13-global-results .v13-search-group");
  assert(groups.length === 4, "четыре группы результатов: " + groups.length);
  const resultItems = document.querySelectorAll("#v13-global-results .v13-search-item");
  assert.strictEqual(resultItems.length, 4, "люди + ЛС + каналы + посты");
  searchOverlay.remove();

  // ---------- 6. категории каналов ----------
  api.state.serverData = await (await window.fetch("/api/servers/1")).text().then(JSON.parse);
  api.state.activeServer = 1;
  api.renderServerChannels();
  await tick(60);
  const cats = document.querySelectorAll("#server-channels-list .channel-category");
  assert.strictEqual(cats.length, 1, "категория отрисована");
  assert(cats[0].textContent.includes("Текстовые"));
  assert.strictEqual(document.querySelectorAll("#server-channels-list .channel-item").length, 3);
  cats[0].dispatchEvent(new window.MouseEvent("click", { bubbles: true }));
  await tick(60);
  assert.strictEqual(document.querySelectorAll("#server-channels-list .channel-item").length, 1, "категория сворачивается");
  document.querySelector("#server-channels-list .channel-category").dispatchEvent(new window.MouseEvent("click", { bubbles: true }));
  await tick(60);
  assert.strictEqual(document.querySelectorAll("#server-channels-list .channel-item").length, 3, "и разворачивается");

  // ---------- 7. реакции на постах Telegram ----------
  await api.openTgChannel(3);
  await tick(150);
  const tgChips = document.querySelectorAll("#tg-feed .tg-post .reaction-chip");
  assert(tgChips.length >= 1, "реакции на посте отрисованы");
  assert.strictEqual(document.querySelector("#tg-feed .reaction-emoji").textContent, "🔥");
  document.querySelector("#tg-feed .reaction-chip.reaction-add").dispatchEvent(new window.MouseEvent("click", { bubbles: true }));
  await tick(40);
  assert(document.querySelector(".reaction-picker"), "пикер реакций открылся");
  document.dispatchEvent(new window.KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
  requests.length = 0;
  const tgReaction = document.querySelector("#tg-feed .reaction-chip");
  tgReaction.dispatchEvent(new window.MouseEvent("click", { bubbles: true }));
  await tick(120);
  const tgReq = requests.find((r) => r.path === "/api/reactions");
  assert(tgReq && tgReq.body.scope === "tg_post", "реакция поста идёт через REST со scope tg_post");

  // ---------- 8. мобильные вкладки ----------
  const nav = document.getElementById("v13-mobile-tabs");
  assert(nav, "мобильная панель создана");
  assert.strictEqual(nav.querySelectorAll(".v13-tab").length, 5, "пять вкладок");
  assert([...nav.querySelectorAll(".v13-tab-label")].some((n) => n.textContent === "Чаты"));

  // ---------- 9. онбординг ----------
  api.V13.startTour(true);
  await tick(60);
  assert(document.getElementById("v13-tour"), "тур открылся");
  assert.strictEqual(document.querySelector(".v13-tour-step").textContent, "Шаг 1 из 4");
  [...document.querySelectorAll("#v13-tour .modal-btn")].find((b) => b.textContent.includes("Далее"))
    .dispatchEvent(new window.MouseEvent("click", { bubbles: true }));
  await tick(60);
  assert.strictEqual(document.querySelector(".v13-tour-step").textContent, "Шаг 2 из 4", "шаги переключаются");
  [...document.querySelectorAll("#v13-tour .modal-btn")].find((b) => b.textContent.includes("Пропустить"))
    .dispatchEvent(new window.MouseEvent("click", { bubbles: true }));
  await tick(40);
  assert(!document.getElementById("v13-tour"), "тур закрывается");
  assert.strictEqual(window.localStorage.getItem("swaptime_onboarding_done"), "1", "тур больше не покажется");

  // ---------- 10. статистика сервера ----------
  api.state.activeServer = 1;
  api.V13.openServerStats();
  await tick(150);
  const stats = document.getElementById("v13-stats-modal");
  assert(stats, "статистика открылась");
  assert.strictEqual(stats.querySelectorAll(".v13-stat-card").length, 3);
  assert.strictEqual(stats.querySelectorAll(".v13-chart-bar").length, 7, "недельный график");
  assert(stats.querySelectorAll(".v13-stat-row").length >= 3, "участники и каналы");
  stats.remove();

  // ---------- вложения в канале сервера ----------
  await api.openServer(1);
  await tick(120);
  await api.openServerChannel(7);
  await tick(150);
  assert.strictEqual(document.querySelectorAll("#server-messages .message-wrapper").length, 1, "сообщение канала отрисовано");
  const channelTools = document.querySelectorAll("#server-view .chat-input .v13-tool");
  assert.strictEqual(channelTools.length, 3, "кнопки вложений/голоса/опроса в канале");

  assert.strictEqual(errors.length, 0, "ошибки выполнения: " + errors.join("; "));
  console.log("✅ v13 UI: вложения, опросы, слэш-команды, папки, поиск, категории, реакции постов, вкладки, тур, статистика");
  process.exit(0);
}

run().catch((err) => {
  console.error("❌ v13 UI:", err && err.message ? err.message : err);
  process.exit(1);
});
