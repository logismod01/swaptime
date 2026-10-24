// Тесты новых фич: аватарка, рамки, баннеры, карточка профиля, рейл
const fs = require("fs");
// Требуется: npm install jsdom

const assert = require("assert");
const { JSDOM } = require("jsdom");

const path = require("path");
const ROOT = path.resolve(__dirname, "../..");
const html = fs.readFileSync(ROOT + "/frontend/index.html", "utf8").replace(/<script[\s\S]*?<\/script>/g, "");
const js = fs.readFileSync(ROOT + "/frontend/script.js", "utf8");

const ME = {
  id: 1, username: "alice", display_name: "Алиса", avatar_color: "#e53935",
  avatar_ver: "aaaa111111", avatar_frame: "gold", banner: "ocean",
  bio: "Люблю котиков", font_family: "Inter, sans-serif", last_seen: 0, created_at: 1700000000,
  has_avatar: true,
};

const BOB = {
  username: "bob", display_name: "Боб", avatar_color: "#3b82f6", avatar_ver: "bbb",
  avatar_frame: "neon", online: true,
};
const CAROL = {
  username: "carol", display_name: "Кэрол", avatar_color: "#22d3ee", avatar_ver: "",
  avatar_frame: "none", online: false,
};

const requests = [];

function jsonResponse(data, status = 200) {
  return Promise.resolve({ ok: status < 300, status, text: () => Promise.resolve(JSON.stringify(data)) });
}

function makeWindow() {
  const dom = new JSDOM(html, { url: "http://localhost:8000/", runScripts: "outside-only", pretendToBeVisual: true });
  const { window } = dom;
  const errors = [];
  window.addEventListener("error", (e) => errors.push(e.message));

  // --- canvas / Image / FileReader заглушки ---
  window.URL.createObjectURL = () => "blob:fake";
  window.URL.revokeObjectURL = () => {};
  class FakeImage {
    constructor() { this.width = 800; this.height = 600; }
    set src(_v) { setTimeout(() => this.onload && this.onload(), 0); }
    get src() { return "blob:fake"; }
  }
  window.Image = FakeImage;
  window.HTMLCanvasElement.prototype.getContext = function () {
    return { drawImage() {}, imageSmoothingQuality: "" };
  };
  window.HTMLCanvasElement.prototype.toDataURL = function () {
    return "data:image/png;base64,iVBORw0KGgo=";
  };

  window.fetch = fakeFetch;
  window.confirm = () => true;
  window.matchMedia = () => ({ matches: true, addListener() {}, removeListener() {} });
  window.Element.prototype.scrollIntoView = function () {};
  if (!window.crypto) window.crypto = {};
  if (!window.crypto.randomUUID) window.crypto.randomUUID = () => "uuid-x";

  class FakeWS {
    static instances = [];
    constructor() { this.readyState = 0; FakeWS.instances.push(this); setTimeout(() => { this.readyState = 1; this.onopen && this.onopen(); }, 0); }
    send() {}
    close() { this.readyState = 3; }
  }
  FakeWS.CONNECTING = 0; FakeWS.OPEN = 1;
  window.WebSocket = FakeWS;

  window.localStorage.setItem("swaptime_token", "tok");
  window.eval(js + "\nwindow.__state = state; window.__openProfile = openProfile; window.__openSettings = openSettings;");

  return { window, document: window.document, errors, FakeWS };
}

function fakeFetch(url, options = {}) {
  const path = String(url).replace("http://localhost:8000", "");
  const body = options.body ? JSON.parse(options.body) : null;
  requests.push({ path, body, method: options.method || "GET" });

  if (path === "/api/me") return jsonResponse({ user: { ...ME }, fonts: [], frames: [], banners: [] });

  if (path === "/api/chats") {
    return jsonResponse({
      chats: [
        { ...BOB, unread: 1, last_message: { id: 5, from: "bob", to: "alice", text: "привет", created_at: 1700000500, reply_to: 0, deleted: 0 } },
        { ...CAROL, unread: 0, last_message: null },
      ],
      unread: { bob: 1 },
    });
  }

  if (path === "/api/friends") {
    return jsonResponse({
      friends: [{ ...BOB }, { ...CAROL }],
      requests: [], outgoing: [], blocked: [], ignored: [],
      blocked_users: [], ignored_users: [],
    });
  }

  if (path.startsWith("/api/profile/bob")) {
    return jsonResponse({
      ...BOB, banner: "galaxy", bio: "Пишу музыку\nи код", created_at: 1690000000,
      is_friend: true, is_me: false, blocked_by_me: false, ignored_by_me: false,
    });
  }

  if (path.startsWith("/api/profile/carol")) {
    return jsonResponse({
      ...CAROL, banner: "sunset", bio: "", created_at: 1680000000,
      is_friend: false, is_me: false, blocked_by_me: false, ignored_by_me: false,
    });
  }

  if (path.startsWith("/api/profile/alice")) {
    return jsonResponse({
      ...ME, online: true, is_friend: false, is_me: true,
      blocked_by_me: false, ignored_by_me: false,
    });
  }

  if (path === "/api/update_profile") {
    return jsonResponse({
      ok: true,
      user: {
        ...ME,
        display_name: body.display_name,
        avatar_color: body.avatar_color,
        avatar_frame: body.avatar_frame,
        banner: body.banner,
        bio: body.bio,
        font_family: body.font_family,
      },
    });
  }

  if (path === "/api/avatar") {
    if (body.avatar === "") return jsonResponse({ ok: true, user: { ...ME, avatar_ver: "", has_avatar: false } });
    return jsonResponse({ ok: true, user: { ...ME, avatar_ver: "newhash123", has_avatar: true } });
  }

  if (path.startsWith("/api/mark_read")) return jsonResponse({ ok: true });

  return jsonResponse({ ok: true });
}

const tick = (ms = 40) => new Promise((r) => setTimeout(r, ms));

async function run() {
  const { window, document, errors } = makeWindow();
  document.dispatchEvent(new window.Event("DOMContentLoaded"));
  await tick(80);

  const state = window.__state;
  assert.strictEqual(state.user.username, "alice");

  // ---------- рейл и вкладки ----------
  assert(document.querySelector('.rail-btn[data-view="chats"]').classList.contains("active"));
  assert.notStrictEqual(document.getElementById("rail-unread").hidden, true, "бейдж непрочитанных виден");
  assert.strictEqual(document.getElementById("rail-unread").textContent, "1");

  document.querySelector('.rail-btn[data-view="friends"]').click();
  await tick(10);
  assert.strictEqual(document.getElementById("friends-view").style.display, "block");
  assert.strictEqual(document.getElementById("chats-view").style.display, "none");
  assert.strictEqual(document.getElementById("sidebar-title").textContent, "Друзья");
  assert.strictEqual(document.querySelectorAll("#friends-list .friend-row").length, 2);

  // вкладка «Онлайн» — только Боб
  document.querySelector('.ftab[data-tab="online"]').click();
  await tick(10);
  assert.strictEqual(document.querySelectorAll("#friends-list .friend-row").length, 1);

  document.querySelector('.ftab[data-tab="blocked"]').click();
  await tick(10);
  assert(document.querySelector("#friends-list").textContent.includes("Никого нет в блоке"));

  document.querySelector('.rail-btn[data-view="chats"]').click();
  await tick(10);
  assert.strictEqual(document.getElementById("chats-view").style.display, "block");

  // ---------- карточка профиля ----------
  await window.__state && window.__openProfile("bob");
  await tick(80);

  assert(document.getElementById("profile-modal").classList.contains("active"));
  assert.strictEqual(document.getElementById("profile-name").textContent, "Боб");
  assert.strictEqual(document.getElementById("profile-username").textContent, "@bob");
  assert.strictEqual(document.getElementById("profile-bio").textContent, "Пишу музыку\nи код");
  assert(document.getElementById("profile-banner").className.includes("banner-galaxy"),
    "баннер должен примениться: " + document.getElementById("profile-banner").className);
  assert(document.getElementById("profile-since").textContent.includes("2023"));

  const avatarNode = document.querySelector("#profile-avatar-slot .av");
  assert(avatarNode.className.includes("frame-neon"), "рамка профиля: " + avatarNode.className);
  assert(avatarNode.querySelector("img"), "у профиля должна быть картинка аватарки");

  const writeBtn = document.getElementById("profile-write-btn");
  assert.strictEqual(writeBtn.disabled, false, "другу можно писать");
  assert.strictEqual(writeBtn.textContent.includes("Написать"), true);
  assert.notStrictEqual(document.getElementById("profile-remove-btn").style.display, "none");
  assert.notStrictEqual(document.getElementById("profile-block-btn").style.display, "none");

  window.closeProfile();

  // ---------- не друг: писать нельзя ----------
  await window.__openProfile("carol");
  await tick(80);
  assert.strictEqual(document.getElementById("profile-write-btn").disabled, true);
  assert(document.getElementById("profile-write-btn").textContent.includes("в друзья"));
  assert.strictEqual(document.getElementById("profile-remove-btn").style.display, "none");
  window.closeProfile();

  // ---------- свой профиль: кнопки действий скрыты ----------
  window.openMyProfile();
  await tick(80);
  assert.strictEqual(document.getElementById("profile-name").textContent, "Алиса");
  assert.strictEqual(document.getElementById("profile-write-btn").style.display, "none");
  assert.strictEqual(document.getElementById("profile-block-btn").style.display, "none");
  assert.strictEqual(document.getElementById("profile-ignore-btn").style.display, "none");
  assert.strictEqual(document.getElementById("profile-status").textContent, "это ты");
  window.closeProfile();

  // ---------- настройки: рамки, баннеры, био ----------
  window.__openSettings("profile");
  await tick(60);

  const frameOptions = document.querySelectorAll("#frames-grid .frame-option");
  assert.strictEqual(frameOptions.length, 10, "должно быть 10 рамок, а не " + frameOptions.length);

  const bannerOptions = document.querySelectorAll("#banners-grid .banner-option");
  assert.strictEqual(bannerOptions.length, 7, "баннеров: " + bannerOptions.length);

  // текущая рамка (gold) отмечена
  const selectedFrame = document.querySelector("#frames-grid .frame-option.selected");
  assert(selectedFrame, "рамка пользователя должна быть выбрана");
  assert(selectedFrame.className.includes("frame-gold") || selectedFrame.textContent.includes("Gold"),
    selectedFrame.textContent);

  // выбираем «rainbow»
  const rainbow = [...frameOptions].find((o) => o.textContent.includes("Rainbow"));
  assert(rainbow, "есть рамка Rainbow");
  rainbow.click();
  await tick(10);
  assert.strictEqual(state.draft.avatar_frame, "rainbow");
  // сетка перерисовывается, поэтому берём актуальный узел
  const rainbowNow = [...document.querySelectorAll("#frames-grid .frame-option")]
    .find((o) => o.textContent.includes("Rainbow"));
  assert(rainbowNow.classList.contains("selected"), "выбранная рамка подсвечена");
  assert(document.querySelector("#settings-avatar-slot .av").className.includes("frame-rainbow"),
    "preview должен показать рамку сразу");

  // баннер forest
  const forest = [...document.querySelectorAll("#banners-grid .banner-option")]
    .find((o) => o.className.includes("banner-forest"));
  forest.click();
  await tick(10);
  assert.strictEqual(state.draft.banner, "forest");
  assert(document.getElementById("settings-banner").className.includes("banner-forest"));

  // цвет и био
  document.getElementById("settings-name").value = "Алиса К.";
  document.getElementById("settings-name").dispatchEvent(new window.Event("input"));
  document.getElementById("settings-bio").value = "Новое био";
  document.getElementById("settings-bio").dispatchEvent(new window.Event("input"));
  assert.strictEqual(document.getElementById("bio-counter").textContent, "9");

  const blue = [...document.querySelectorAll(".color-preset")].find((b) => b.title === "#3b82f6");
  blue.click();
  await tick(10);
  assert.strictEqual(state.draft.avatar_color, "#3b82f6");
  assert.strictEqual(document.getElementById("settings-color").value, "#3b82f6");

  // ---------- вкладки настроек ----------
  document.querySelector('.settings-tab[data-tab="appearance"]').click();
  await tick(10);
  assert(document.getElementById("settings-tab-appearance").classList.contains("active"));
  assert.strictEqual(document.querySelectorAll("#settings-font option").length, 10);
  assert(document.querySelectorAll("#font-preview-chat .preview-msg").length, "предпросмотр чата есть");

  document.querySelector('.settings-tab[data-tab="privacy"]').click();
  await tick(10);
  assert(document.getElementById("settings-tab-privacy").classList.contains("active"));

  // ---------- сохранение ----------
  requests.length = 0;
  const saveBtn = document.getElementById("settings-save");
  saveBtn.click();
  await tick(120);

  const saved = requests.find((r) => r.path === "/api/update_profile");
  assert(saved, "запрос сохранения ушёл");
  assert.strictEqual(saved.body.avatar_frame, "rainbow");
  assert.strictEqual(saved.body.banner, "forest");
  assert.strictEqual(saved.body.bio, "Новое био");
  assert.strictEqual(saved.body.avatar_color, "#3b82f6");
  assert.strictEqual(saved.body.display_name, "Алиса К.");

  assert.strictEqual(document.getElementById("settings-modal").classList.contains("active"), false,
    "после сохранения модалка закрывается");
  assert.strictEqual(state.user.avatar_frame, "rainbow");
  const meAvatar = document.querySelector("#me-avatar-slot .av");
  assert(meAvatar.className.includes("frame-rainbow"), "рамка применилась в панели: " + meAvatar.className);
  assert.strictEqual(document.getElementById("my-name").textContent, "Алиса К.");

  // ---------- загрузка аватарки ----------
  window.__openSettings("profile");
  await tick(40);
  requests.length = 0;

  const file = new window.File([new Uint8Array([137, 80, 78, 71])], "avatar.png", { type: "image/png" });
  const input = document.getElementById("avatar-input");
  Object.defineProperty(input, "files", { value: [file], configurable: true });
  input.dispatchEvent(new window.Event("change"));
  await tick(150);

  const avatarReq = requests.find((r) => r.path === "/api/avatar");
  assert(avatarReq, "запрос загрузки аватарки ушёл");
  assert(avatarReq.body.avatar.startsWith("data:image/png;base64,"), avatarReq.body.avatar.slice(0, 40));
  assert.strictEqual(state.user.avatar_ver, "newhash123");
  assert(document.querySelector("#settings-avatar-slot .av img"), "превью показывает загруженную аватарку");
  assert.strictEqual(document.getElementById("avatar-error").textContent, "");

  // ---------- удаление аватарки ----------
  requests.length = 0;
  window.removeAvatar();
  await tick(120);
  const removeReq = requests.find((r) => r.path === "/api/avatar");
  assert(removeReq, "запрос удаления ушёл");
  assert.strictEqual(removeReq.body.avatar, "");
  assert.strictEqual(state.user.avatar_ver, "");
  assert.strictEqual(document.querySelector("#settings-avatar-slot .av img"), null, "картинка пропала");
  assert(document.querySelector("#settings-avatar-slot .av-letter"), "вернулась буква");

  // ---------- не картинка не грузится ----------
  requests.length = 0;
  const badFile = new window.File([new Uint8Array([1, 2])], "doc.pdf", { type: "application/pdf" });
  Object.defineProperty(input, "files", { value: [badFile], configurable: true });
  input.dispatchEvent(new window.Event("change"));
  await tick(80);
  assert.strictEqual(requests.filter((r) => r.path === "/api/avatar").length, 0, "pdf не должен уходить на сервер");
  assert(document.getElementById("avatar-error").textContent.includes("не картинка"));

  window.closeSettings();
  await tick(20);

  assert.strictEqual(errors.length, 0, "ошибки JS: " + errors.join("; "));
  console.log("✅ Тесты профиля, рамок и аватарки прошли");
  process.exit(0);
}

run().catch((err) => {
  console.error("❌", err.message);
  console.error(err.stack);
  process.exit(1);
});
