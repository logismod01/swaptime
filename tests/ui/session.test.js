// Тесты: истёкшая сессия и прокси, срезающий Authorization
const fs = require("fs");
// Требуется: npm install jsdom

const assert = require("assert");
const { JSDOM } = require("jsdom");

const path = require("path");
const ROOT = path.resolve(__dirname, "../..");
const html = fs.readFileSync(ROOT + "/frontend/index.html", "utf8").replace(/<script[\s\S]*?<\/script>/g, "");
const js = fs.readFileSync(ROOT + "/frontend/script.js", "utf8");

const USER = { id: 1, username: "alice", display_name: "Алиса",
  avatar_color: "#e53935", font_family: "Inter, sans-serif", last_seen: 0 };

function jsonResponse(data, status = 200) {
  return Promise.resolve({ ok: status < 300, status, text: () => Promise.resolve(JSON.stringify(data)) });
}

function makeWindow({ storage, fetchImpl }) {
  const dom = new JSDOM(html, { url: "http://localhost:8000/", runScripts: "outside-only", pretendToBeVisual: true });
  const { window } = dom;
  const errors = [];
  window.addEventListener("error", (e) => errors.push(e.message));
  window.fetch = fetchImpl;
  window.confirm = () => true;
  window.matchMedia = () => ({ matches: false, addListener() {}, removeListener() {} });
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

  Object.entries(storage).forEach(([k, v]) => window.localStorage.setItem(k, v));
  window.eval(js + "\nwindow.__state = state;");
  window.document.dispatchEvent(new window.Event("DOMContentLoaded"));
  return { window, document: window.document, errors, FakeWS };
}

const tick = (ms = 60) => new Promise((r) => setTimeout(r, ms));

async function staleSession() {
  const calls = [];
  const fetchImpl = (url) => {
    calls.push(String(url));
    return jsonResponse({ detail: "Сессия истекла — войди заново" }, 401);
  };

  const { window, document, errors } = makeWindow({
    storage: { swaptime_token: "stale-token", swaptime_last_user: "alice" },
    fetchImpl,
  });
  await tick(80);

  assert(document.getElementById("auth-screen").classList.contains("active"), "должен быть экран входа");
  const notice = document.getElementById("auth-notice");
  assert.notStrictEqual(notice.style.display, "none", "плашка должна быть видна");
  assert(notice.textContent.includes("Сессия истекла"), notice.textContent);
  assert.strictEqual(document.getElementById("login-username").value, "alice", "ник подставлен");
  assert.strictEqual(window.localStorage.getItem("swaptime_token"), null, "битый токен удалён");
  assert.strictEqual(document.getElementById("chat-screen").classList.contains("active"), false);
  // токен пробуем и в заголовке, и в query — но плашка одна
  assert(calls.length >= 1);
  assert.strictEqual(document.querySelectorAll(".toast").length, 0, "не должно быть плавающего тоста");
  assert.strictEqual(errors.length, 0, "ошибки JS: " + errors.join("; "));

  // после ввода пароля вход должен работать (fetch уже отвечает 200 на login)
  console.log("  ✓ истёкшая сессия обработана мягко");
}

async function strippedHeader() {
  const calls = [];
  const requireToken = (url, data) => {
    const u = String(url);
    calls.push(u);
    return u.includes("token=tok") ? jsonResponse(data) : jsonResponse({ detail: "Сессия истекла" }, 401);
  };

  const fetchImpl = (url) => {
    const u = String(url);
    if (u === "/api/me") return requireToken(u, { user: USER, fonts: [] });
    if (u.startsWith("/api/chats")) return requireToken(u, { chats: [], unread: {} });
    if (u.startsWith("/api/friends")) {
      return requireToken(u, { friends: [], requests: [], outgoing: [], blocked: [], ignored: [] });
    }
    return jsonResponse({ ok: true });
  };

  const { window, document, errors } = makeWindow({
    storage: { swaptime_token: "tok" },
    fetchImpl,
  });
  await tick(120);

  assert(document.getElementById("chat-screen").classList.contains("active"),
    "должен открыться чат даже без заголовка Authorization");
  assert.strictEqual(window.__state.tokenMode, "query", "режим токена в query должен запомниться");
  assert.strictEqual(window.localStorage.getItem("swaptime_token_mode"), "query");
  assert(calls.some((u) => u.startsWith("/api/chats") && u.includes("token=tok")),
    "запросы чатов должны идти с токеном в URL: " + calls.join(", "));
  assert.strictEqual(errors.length, 0, "ошибки JS: " + errors.join("; "));
  console.log("  ✓ прокси без Authorization: авто-фолбэк на ?token= работает");
}

async function main() {
  await staleSession();
  await strippedHeader();
  console.log("✅ Тесты сессии прошли");
  process.exit(0);
}

main().catch((err) => {
  console.error("❌", err.message);
  console.error(err.stack);
  process.exit(1);
});
