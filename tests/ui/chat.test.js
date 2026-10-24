// Мини-тест фронтенда в jsdom: проверяем отрисовку, дубли, ответы, редактирование, удаление.
const fs = require("fs");
// Требуется: npm install jsdom

const assert = require("assert");
const { JSDOM } = require("jsdom");

const path = require("path");
const ROOT = path.resolve(__dirname, "../..");
const html = fs.readFileSync(ROOT + "/frontend/index.html", "utf8").replace(
  /<script[\s\S]*?<\/script>/g,
  ""
);
const js = fs.readFileSync(ROOT + "/frontend/script.js", "utf8");

const ME = {
  id: 1, username: "alice", display_name: "Алиса",
  avatar_color: "#e53935", font_family: "Inter, sans-serif", last_seen: 0,
};

const history = [
  { id: 1, client_id: "h1", from: "alice", to: "bob", text: "старое сообщение", reply_to: 0,
    reply_preview: null, edited: 0, deleted: 0, created_at: 1700000000 },
  { id: 2, client_id: "h2", from: "bob", to: "alice", text: "ответ старое", reply_to: 1,
    reply_preview: { id: 1, from: "alice", text: "старое сообщение", deleted: 0 },
    edited: 0, deleted: 0, created_at: 1700000100 },
];

let chats = [
  { username: "bob", display_name: "Боб", avatar_color: "#1e88e5", online: true, unread: 2,
    last_message: history[1] },
  { username: "carol", display_name: "Кэрол", avatar_color: "#43a047", online: false, unread: 5,
    last_message: null },
];

const calls = [];

function jsonResponse(data, status = 200) {
  return Promise.resolve({
    ok: status >= 200 && status < 300,
    status,
    text: () => Promise.resolve(JSON.stringify(data)),
  });
}

function fakeFetch(url, options = {}) {
  const method = options.method || "GET";
  calls.push({ url, method, body: options.body ? JSON.parse(options.body) : null });
  const path = String(url).replace("http://localhost:8000", "");

  if (path === "/api/me") return jsonResponse({ user: ME, fonts: [] });
  if (path === "/api/chats") {
    return jsonResponse({ chats: chats.map((c) => ({ ...c })) });
  }
  if (path === "/api/friends") {
    return jsonResponse({ friends: [{ username: "bob", display_name: "Боб", avatar_color: "#1e88e5", online: true },
      { username: "carol", display_name: "Кэрол", avatar_color: "#43a047", online: false }],
      requests: [], outgoing: [], blocked: [], ignored: [] });
  }
  if (path.startsWith("/api/messages/alice/bob")) return jsonResponse(history);
  if (path.startsWith("/api/messages/alice/carol")) return jsonResponse([]);
  if (path === "/api/mark_read") {
    const chat = chats.find((c) => c.username === "bob");
    if (chat) chat.unread = 0;
    return jsonResponse({ ok: true });
  }
  if (path.startsWith("/api/friends/")) return jsonResponse({ ok: true });
  return jsonResponse({ ok: true });
}

class FakeWS {
  static instances = [];
  constructor(url) {
    this.url = url;
    this.readyState = 0;
    this.sent = [];
    FakeWS.instances.push(this);
    setTimeout(() => {
      this.readyState = 1;
      if (this.onopen) this.onopen();
    }, 0);
  }
  send(data) { this.sent.push(JSON.parse(data)); }
  close() { this.readyState = 3; if (this.onclose) this.onclose({ code: 1000 }); }
  emit(obj) { if (this.onmessage) this.onmessage({ data: JSON.stringify(obj) }); }
}
FakeWS.CONNECTING = 0;
FakeWS.OPEN = 1;
FakeWS.CLOSING = 2;
FakeWS.CLOSED = 3;

const dom = new JSDOM(html, {
  url: "http://localhost:8000/",
  runScripts: "outside-only",
  pretendToBeVisual: true,
});
const { window } = dom;
const { document } = window;

window.fetch = fakeFetch;
window.WebSocket = FakeWS;
window.confirm = () => true;
window.matchMedia = () => ({ matches: true, addListener() {}, removeListener() {} });
window.Element.prototype.scrollIntoView = function () {};
if (!window.crypto) window.crypto = {};
if (!window.crypto.randomUUID) {
  window.crypto.randomUUID = () => "uuid-" + Math.random().toString(36).slice(2);
}
const errors = [];
window.addEventListener("error", (e) => errors.push(e.message));

window.localStorage.setItem("swaptime_token", "test-token");
window.eval(js + "\nwindow.__state = state;");

const tick = (ms = 10) => new Promise((r) => setTimeout(r, ms));

async function run() {
  document.dispatchEvent(new window.Event("DOMContentLoaded"));
  await tick(50);

  assert(ctx(), "чат-экран должен стать активным");
  const items = document.querySelectorAll("#users-list .user-item");
  assert.strictEqual(items.length, 2, "должно быть 2 чата, найдено " + items.length);
  assert.strictEqual(document.querySelector("#users-list .unread-badge").textContent, "2");
  assert.strictEqual(window.__state.user.username, "alice");
  assert.strictEqual(document.body.style.fontFamily || "", "", "шрифт ставится через переменную");
  assert.strictEqual(
    document.documentElement.style.getPropertyValue("--app-font"), "Inter, sans-serif");

  // ---- открываем чат ----
  items[0].dispatchEvent(new window.Event("click", { bubbles: true }));
  await tick(50);
  assert.strictEqual(document.getElementById("chat-name").textContent, "Боб");
  let msgs = document.querySelectorAll("#messages .message-wrapper");
  assert.strictEqual(msgs.length, 2, "история должна отрисоваться: " + msgs.length);
  // бейдж снят у открытого чата
  assert.strictEqual(
    document.querySelector('#users-list [data-username="bob"] .unread-badge'), null,
    "бейдж открытого чата должен исчезнуть");
  assert(calls.some((c) => c.url.endsWith("/api/mark_read") && c.body.to_user === "bob"),
    "mark_read должен уйти на сервер");
  assert.strictEqual(
    document.querySelector('#users-list [data-username="carol"] .unread-badge').textContent, "5");

  // цитата ответа подставлена
  const quote = msgs[1].querySelector(".reply-quote");
  assert(quote, "у второго сообщения должна быть цитата");
  assert(quote.textContent.includes("старое сообщение"), quote.textContent);

  // ---- отправка сообщения ----
  const input = document.getElementById("message-input");
  input.value = "новое сообщение";
  window.sendMessage();
  await tick(20);

  const ws = FakeWS.instances[0];
  assert(ws, "websocket должен быть создан");
  const outgoing = ws.sent.find((m) => m.type === "message");
  assert(outgoing, "сообщение ушло на сервер");
  assert(outgoing.client_id, "client_id обязателен");
  assert.strictEqual(document.querySelectorAll("#messages .message-wrapper").length, 3);
  assert(document.querySelector("#messages .message-wrapper.pending"), "оптимистичное — pending");

  // сервер вернул эхо — дубля быть не должно
  ws.emit({
    type: "message", id: 10, client_id: outgoing.client_id, from: "alice", to: "bob",
    text: "новое сообщение", reply_to: 0, reply_preview: null, edited: 0, deleted: 0,
    created_at: Math.floor(Date.now() / 1000),
  });
  await tick(20);
  msgs = document.querySelectorAll("#messages .message-wrapper");
  assert.strictEqual(msgs.length, 3, "после эха не должно быть дубля, сейчас " + msgs.length);
  assert.strictEqual(document.querySelectorAll('#messages [data-msg-id="10"]').length, 1);

  // повторное эхо того же сообщения
  ws.emit({
    type: "message", id: 10, client_id: outgoing.client_id, from: "alice", to: "bob",
    text: "новое сообщение", reply_to: 0, reply_preview: null, edited: 0, deleted: 0,
    created_at: Math.floor(Date.now() / 1000),
  });
  await tick(10);
  assert.strictEqual(document.querySelectorAll("#messages .message-wrapper").length, 3, "дубль при повторе эха");

  // ---- входящее от собеседника ----
  ws.emit({
    type: "message", id: 11, client_id: "b-1", from: "bob", to: "alice",
    text: "привет от боба", reply_to: 10,
    reply_preview: { id: 10, from: "alice", text: "новое сообщение", deleted: 0 },
    edited: 0, deleted: 0, created_at: Math.floor(Date.now() / 1000),
  });
  await tick(20);
  msgs = document.querySelectorAll("#messages .message-wrapper");
  assert.strictEqual(msgs.length, 4, "входящее добавилось");
  assert.strictEqual(
    document.getElementById("typing-line").style.display, "none");

  // ---- ответ ----
  const target = window.__state.messages.get(11);
  window.startReply(target);
  assert.strictEqual(document.getElementById("reply-box").style.display, "flex");
  input.value = "ответ на боба";
  window.sendMessage();
  await tick(20);
  const replyPayload = ws.sent.filter((m) => m.type === "message").pop();
  assert.strictEqual(replyPayload.reply_to, 11, "reply_to должен уйти на сервер");
  assert.strictEqual(document.getElementById("reply-box").style.display, "none");

  // сервер вернул ответ с превью
  ws.emit({
    type: "message", id: 12, client_id: replyPayload.client_id, from: "alice", to: "bob",
    text: "ответ на боба", reply_to: 11,
    reply_preview: { id: 11, from: "bob", text: "привет от боба", deleted: 0 },
    edited: 0, deleted: 0, created_at: Math.floor(Date.now() / 1000),
  });
  await tick(20);
  assert.strictEqual(document.querySelectorAll("#messages .message-wrapper").length, 5);

  // ---- редактирование ----
  window.startEdit(12);
  assert.strictEqual(document.getElementById("edit-box").style.display, "flex");
  assert.strictEqual(input.value, "ответ на боба");
  input.value = "исправленный ответ";
  window.saveEdit();
  await tick(20);
  const editPayload = ws.sent.filter((m) => m.type === "edit_msg").pop();
  assert.deepStrictEqual(editPayload, { type: "edit_msg", id: 12, text: "исправленный ответ" });
  assert.strictEqual(document.getElementById("edit-box").style.display, "none");

  ws.emit({
    type: "message_updated", id: 12, client_id: replyPayload.client_id, from: "alice", to: "bob",
    text: "исправленный ответ", reply_to: 11,
    reply_preview: { id: 11, from: "bob", text: "привет от боба", deleted: 0 },
    edited: 1, deleted: 0, created_at: Math.floor(Date.now() / 1000),
  });
  await tick(20);
  const editedNode = document.querySelector('#messages [data-msg-id="12"]');
  assert(editedNode.textContent.includes("исправленный ответ"));
  assert(editedNode.textContent.includes("изм."), "метка «изм.» должна появиться");

  // ---- удаление ----
  window.deleteMessage(12);
  await tick(20);
  const delPayload = ws.sent.filter((m) => m.type === "delete_msg").pop();
  assert.deepStrictEqual(delPayload, { type: "delete_msg", id: 12 });

  ws.emit({
    type: "message_updated", id: 12, client_id: replyPayload.client_id, from: "alice", to: "bob",
    text: "", reply_to: 11, reply_preview: null, edited: 0, deleted: 1,
    created_at: Math.floor(Date.now() / 1000),
  });
  await tick(20);
  const deletedNode = document.querySelector('#messages [data-msg-id="12"]');
  assert(deletedNode.textContent.includes("Сообщение удалено"), deletedNode.textContent);
  assert.strictEqual(deletedNode.querySelector(".message-actions"), null);

  // ---- чужое сообщение нельзя редактировать ----
  window.startEdit(11); // сообщение боба
  assert.strictEqual(document.getElementById("edit-box").style.display, "none");

  // ---- непрочитанные: сообщение в другой чат ----
  const before = window.__state.chats.find((c) => c.username === "carol").unread;
  ws.emit({
    type: "message", id: 13, client_id: "c-1", from: "carol", to: "alice",
    text: "я кэрол", reply_to: 0, reply_preview: null, edited: 0, deleted: 0,
    created_at: Math.floor(Date.now() / 1000),
  });
  await tick(20);
  const carolChat = window.__state.chats.find((c) => c.username === "carol");
  assert.strictEqual(carolChat.unread, before + 1, "счётчик должен вырасти");

  // ---- онлайн-статус ----
  ws.emit({ type: "presence", user: "bob", online: false });
  await tick(10);
  assert.strictEqual(window.__state.chats.find((c) => c.username === "bob").online, false);

  // ---- печатает ----
  ws.emit({ type: "typing", from: "bob" });
  await tick(10);
  assert.notStrictEqual(document.getElementById("typing-line").style.display, "none");

  // ---- шрифты в настройках ----
  window.openSettings();
  const options = document.querySelectorAll("#settings-font option");
  assert.strictEqual(options.length, 10, "должно быть 10 шрифтов, а не " + options.length);
  assert.strictEqual(document.getElementById("settings-modal").classList.contains("active"), true);
  window.closeSettings();

  // ---- выход ----
  assert.strictEqual(document.querySelectorAll("#messages .message-wrapper[data-msg-id]").length >= 1, true);

  assert.strictEqual(errors.length, 0, "ошибки JS: " + errors.join("; "));
  console.log("✅ UI-тесты прошли");
  process.exit(0);
}

function ctx() {
  return document.getElementById("chat-screen").classList.contains("active");
}

run().catch((err) => {
  console.error("❌", err.message);
  console.error(err.stack);
  console.error("Ошибки window:", errors);
  process.exit(1);
});
