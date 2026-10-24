// Тест экрана входа/регистрации и капчи
const fs = require("fs");
// Требуется: npm install jsdom

const assert = require("assert");
const { JSDOM } = require("jsdom");

const path = require("path");
const ROOT = path.resolve(__dirname, "../..");
const html = fs.readFileSync(ROOT + "/frontend/index.html", "utf8").replace(/<script[\s\S]*?<\/script>/g, "");
const js = fs.readFileSync(ROOT + "/frontend/script.js", "utf8");

const USER = { id: 1, username: "newbie", display_name: "Новичок",
  avatar_color: "#e53935", font_family: "Poppins, sans-serif", last_seen: 0 };

const requests = [];
let loginAttempts = 0;

function jsonResponse(data, status = 200) {
  return Promise.resolve({ ok: status < 300, status, text: () => Promise.resolve(JSON.stringify(data)) });
}

function fakeFetch(url, options = {}) {
  const path = String(url);
  const body = options.body ? JSON.parse(options.body) : null;
  requests.push({ path, method: options.method, body });

  if (path === "/api/login") {
    loginAttempts++;
    if (body.password !== "1234") return jsonResponse({ detail: "Неверный ник или пароль" }, 400);
    return jsonResponse({ ok: true, token: "tok-login", user: USER });
  }
  if (path === "/api/register") {
    return jsonResponse({ ok: true, token: "tok-reg", user: USER });
  }
  if (path === "/api/me") return jsonResponse({ user: USER, fonts: [] });
  if (path === "/api/chats") return jsonResponse({ chats: [], unread: {} });
  if (path === "/api/friends") return jsonResponse({ friends: [], requests: [], outgoing: [], blocked: [], ignored: [] });
  return jsonResponse({ ok: true });
}

class FakeWS {
  static instances = [];
  constructor() { this.readyState = 0; FakeWS.instances.push(this); setTimeout(() => { this.readyState = 1; this.onopen && this.onopen(); }, 0); }
  send() {}
  close() { this.readyState = 3; }
}
FakeWS.CONNECTING = 0; FakeWS.OPEN = 1;

const dom = new JSDOM(html, { url: "http://localhost:8000/", runScripts: "outside-only", pretendToBeVisual: true });
const { window } = dom;
const { document } = window;

window.fetch = fakeFetch;
window.WebSocket = FakeWS;
window.confirm = () => true;
window.matchMedia = () => ({ matches: false, addListener() {}, removeListener() {} });
window.Element.prototype.scrollIntoView = function () {};
if (!window.crypto) window.crypto = {};
if (!window.crypto.randomUUID) window.crypto.randomUUID = () => "uuid-x";

const errors = [];
window.addEventListener("error", (e) => errors.push(e.message));
window.eval(js + "\nwindow.__state = state; window.__generateCaptcha = generateCaptcha;");

const tick = (ms = 20) => new Promise((r) => setTimeout(r, ms));

async function run() {
  document.dispatchEvent(new window.Event("DOMContentLoaded"));
  await tick(30);

  // стартовый экран — вход
  assert(document.getElementById("auth-screen").classList.contains("active"));
  assert(!document.getElementById("chat-screen").classList.contains("active"));

  // капча нарисовалась
  const options = [...document.querySelectorAll(".captcha-btn")];
  assert.strictEqual(options.length, 4, "4 варианта капчи");
  const question = document.getElementById("captcha-question").textContent;
  const numbers = question.match(/\d+/g).map(Number);
  const answer = numbers[0] + numbers[1];
  const correct = options.find((b) => b.textContent === String(answer));
  assert(correct, "среди вариантов есть правильный ответ");

  // неверный вариант
  const wrong = options.find((b) => b.textContent !== String(answer));
  wrong.dispatchEvent(new window.Event("click", { bubbles: true }));
  assert(wrong.classList.contains("wrong"));
  assert.strictEqual(window.__state && true, true);

  // правильный — ошибка снимается
  correct.dispatchEvent(new window.Event("click", { bubbles: true }));
  assert(correct.classList.contains("correct"));
  assert(!wrong.classList.contains("wrong"), "подсветка ошибки должна сниматься");

  // регистрация без заполненных полей
  const registerTab = document.querySelector('[data-tab="register"]');
  registerTab.dispatchEvent(new window.Event("click", { bubbles: true }));
  assert(document.getElementById("register-form").classList.contains("active"));
  window.doRegister();
  await tick(20);
  assert(document.getElementById("register-error").textContent.length > 0);

  // заполняем и регистрируемся
  document.getElementById("reg-username").value = "newbie";
  document.getElementById("reg-display-name").value = "Новичок";
  document.getElementById("reg-email").value = "new@mail.ru";
  document.getElementById("reg-password").value = "1234";
  document.getElementById("reg-password-2").value = "1234";
  window.__generateCaptcha();
  await tick(10);
  const opts2 = [...document.querySelectorAll(".captcha-btn")];
  const q2 = document.getElementById("captcha-question").textContent.match(/\d+/g).map(Number);
  opts2.find((b) => b.textContent === String(q2[0] + q2[1])).dispatchEvent(new window.Event("click", { bubbles: true }));

  window.doRegister();
  await tick(60);

  const regCall = requests.find((r) => r.path === "/api/register");
  assert(regCall, "запрос регистрации ушёл");
  assert.strictEqual(regCall.body.username, "newbie");
  assert.strictEqual(window.localStorage.getItem("swaptime_token"), "tok-reg");
  assert(document.getElementById("chat-screen").classList.contains("active"), "после регистрации — чат");
  assert.strictEqual(document.querySelectorAll("#users-list .user-item").length, 0);

  // применяется сохранённый шрифт
  assert.strictEqual(window.__state.user.font_family, "Poppins, sans-serif");
  assert.strictEqual(document.documentElement.style.getPropertyValue("--app-font"), "Poppins, sans-serif");

  // ---- выход и вход с неверным паролем ----
  window.__state.shouldReconnect = false;
  window.localStorage.removeItem("swaptime_token");
  window.__state.token = null;
  window.showScreen("auth");
  document.getElementById("login-username").value = "newbie";
  document.getElementById("login-password").value = "wrong";
  window.doLogin();
  await tick(40);
  assert(document.getElementById("login-error").textContent.includes("Неверный"));
  assert.strictEqual(window.localStorage.getItem("swaptime_token"), null);

  // верный пароль
  document.getElementById("login-password").value = "1234";
  window.doLogin();
  await tick(60);
  assert.strictEqual(window.localStorage.getItem("swaptime_token"), "tok-login");
  assert(document.getElementById("chat-screen").classList.contains("active"));
  assert.strictEqual(loginAttempts, 2);

  assert.strictEqual(errors.length, 0, "ошибки JS: " + errors.join("; "));
  console.log("✅ Тесты авторизации прошли");
  process.exit(0);
}

run().catch((err) => {
  console.error("❌", err.message);
  console.error(err.stack);
  console.error("Ошибки window:", errors);
  process.exit(1);
});
