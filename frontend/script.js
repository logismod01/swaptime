// ============================================
// СВАПТАЙМ — FRONTEND (v5 — ПОЛНЫЙ)
// ============================================

const API_URL = window.location.origin;
let currentUser = null;
let currentChat = null;
let ws = null;
let captchaAnswer = null;
let captchaSolved = false;
let profileUser = null;
let replyToMsg = null; // Для ответа на сообщение

// ============================================
// УТИЛИТЫ
// ============================================
function $(id) {
    return document.getElementById(id);
}

function showScreen(name) {
    document.querySelectorAll(".screen").forEach(s => {
        s.style.display = "none";
        s.classList.remove("active");
    });
    const el = document.getElementById(name + "-screen");
    if (el) {
        el.style.display = (name === "auth") ? "flex" : "block";
        el.classList.add("active");
    }
}

function escapeHtml(text) {
    const div = document.createElement("div");
    div.textContent = text;
    return div.innerHTML;
}

// ============================================
// КАПЧА
// ============================================
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
    container.innerHTML = "";

    shuffled.forEach(num => {
        const btn = document.createElement("button");
        btn.className = "captcha-btn";
        btn.textContent = num;
        btn.onclick = () => {
            if (num === captchaAnswer) {
                btn.classList.add("correct");
                captchaSolved = true;
            } else {
                btn.classList.add("wrong");
                captchaSolved = false;
            }
        };
        container.appendChild(btn);
    });
}

// ============================================
// АВТОРИЗАЦИЯ
// ============================================
async function doLogin() {
    const username = $("login-username").value.trim().toLowerCase();
    const password = $("login-password").value;
    const errorEl = $("login-error");

    errorEl.textContent = "";

    if (!username || !password) {
        errorEl.textContent = "Заполни все поля";
        return;
    }

    try {
        const resp = await fetch(API_URL + "/api/login", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ username, password }),
        });
        const data = await resp.json();

        if (!resp.ok) {
            errorEl.textContent = data.detail || "Ошибка";
            return;
        }

        localStorage.setItem("swaptime_token", data.token);
        localStorage.setItem("swaptime_user", JSON.stringify(data.user));
        currentUser = data.user;
        startChat();
    } catch (e) {
        errorEl.textContent = "Ошибка соединения";
    }
}

async function doRegister() {
    const username = $("reg-username").value.trim().toLowerCase();
    const display_name = $("reg-display-name").value.trim();
    const email = $("reg-email").value.trim().toLowerCase();
    const password = $("reg-password").value;
    const password2 = $("reg-password-2").value;
    const errorEl = $("register-error");

    errorEl.textContent = "";

    if (!username || !email || !password || !password2) { errorEl.textContent = "Заполни все поля"; return; }
    if (username.length < 3) { errorEl.textContent = "Ник — минимум 3 символа"; return; }
    if (!email.includes("@") || !email.includes(".")) { errorEl.textContent = "Неверный email"; return; }
    if (password.length < 4) { errorEl.textContent = "Пароль — минимум 4 символа"; return; }
    if (password !== password2) { errorEl.textContent = "Пароли не совпадают"; return; }
    if (!captchaSolved) { errorEl.textContent = "Пройди капчу"; return; }

    try {
        const resp = await fetch(API_URL + "/api/register", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ username, password, display_name, email }),
        });
        const data = await resp.json();

        if (!resp.ok) {
            errorEl.textContent = data.detail || "Ошибка";
            generateCaptcha();
            return;
        }

        localStorage.setItem("swaptime_token", data.token);
        localStorage.setItem("swaptime_user", JSON.stringify(data.user));
        currentUser = data.user;
        startChat();
    } catch (e) {
        errorEl.textContent = "Ошибка соединения";
    }
}

function logout() {
    localStorage.removeItem("swaptime_token");
    localStorage.removeItem("swaptime_user");
    if (ws) ws.close();
    currentUser = null;
    currentChat = null;
    location.reload();
}

// ============================================
// СТАРТ
// ============================================
function startChat() {
    showScreen("chat");
    $("my-name").textContent = currentUser.display_name || currentUser.username;
    $("my-avatar").textContent = (currentUser.display_name || currentUser.username)[0].toUpperCase();
    $("my-avatar").style.background = currentUser.avatar_color || "var(--red)";
    
    // Применяем шрифт
    if (currentUser.font_family) {
        document.body.style.fontFamily = currentUser.font_family;
    } else {
        document.body.style.fontFamily = "'Inter', -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif";
    }
    
    loadFriends();
    connectWebSocket();
}

// ============================================
// ДРУЗЬЯ
// ============================================
async function loadFriends() {
    try {
        const [friendsResp, unreadResp] = await Promise.all([
            fetch(API_URL + "/api/friends/" + currentUser.username),
            fetch(API_URL + "/api/unread/" + currentUser.username),
        ]);
        const data = await friendsResp.json();
        const unreadData = await unreadResp.json();
        const unread = unreadData.unread || {};

        const listEl = $("users-list");
        listEl.innerHTML = "";

        if (data.friends.length === 0) {
            listEl.innerHTML = '<div class="loading-small">Пока нет друзей 🤷</div>';
        } else {
            data.friends.forEach(user => {
                const el = document.createElement("div");
                el.className = "user-item";
                el.dataset.username = user.username;

                const count = unread[user.username] || 0;
                let badgeHtml = "";
                if (count > 0) {
                    badgeHtml = `<div class="unread-badge">${count > 99 ? "99+" : count}</div>`;
                }

                el.innerHTML = `
                    <div class="avatar" style="background:${user.avatar_color || "var(--red)"}">${(user.display_name || user.username)[0].toUpperCase()}</div>
                    <div class="user-item-info">
                        <div class="user-item-name">${escapeHtml(user.display_name || user.username)}</div>
                        <div class="user-item-status">@${user.username}</div>
                    </div>
                    ${badgeHtml}
                `;
                el.onclick = () => openProfile(user);
                listEl.appendChild(el);
            });
        }

        const requestsEl = $("requests-block");
        const requestsList = $("requests-list");

        if (data.requests.length === 0) {
            requestsEl.style.display = "none";
        } else {
            requestsEl.style.display = "block";
            requestsList.innerHTML = "";
            data.requests.forEach(fromUser => {
                const el = document.createElement("div");
                el.className = "request-item";
                el.innerHTML = `
                    <div class="request-name">@${fromUser}</div>
                    <div class="request-actions">
                        <button class="request-btn accept" onclick="acceptFriend('${fromUser}')">✓</button>
                        <button class="request-btn decline" onclick="declineFriend('${fromUser}')">✕</button>
                    </div>
                `;
                requestsList.appendChild(el);
            });
        }
    } catch (e) {
        console.error("Ошибка загрузки друзей:", e);
    }
}

async function acceptFriend(fromUser) {
    await fetch(API_URL + "/api/friends/accept", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ from_user: currentUser.username, to_user: fromUser }) });
    loadFriends();
}

async function declineFriend(fromUser) {
    await fetch(API_URL + "/api/friends/decline", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ from_user: currentUser.username, to_user: fromUser }) });
    loadFriends();
}

// ============================================
// ЧАТ (с историей и ответами)
// ============================================
async function openChat(user) {
    currentChat = user;
    replyToMsg = null;
    $("reply-box").style.display = "none";

    document.querySelectorAll(".user-item").forEach(el => {
        el.classList.toggle("active", el.dataset.username === user.username);
    });

    $("no-chat").style.display = "none";
    $("chat-active").style.display = "flex";
    $("chat-name").textContent = user.display_name || user.username;
    $("chat-status").textContent = "@" + user.username;
    $("chat-avatar").textContent = (user.display_name || user.username)[0].toUpperCase();
    $("chat-avatar").style.background = user.avatar_color || "var(--red)";
    $("messages").innerHTML = "";

    try {
        const resp = await fetch(`${API_URL}/api/messages/${currentUser.username}/${user.username}`);
        const messages = await resp.json();
        messages.forEach(msg => {
            addMessageDOM(msg);
        });
    } catch (e) {
        console.error("Ошибка загрузки истории:", e);
    }

    try {
        await fetch(API_URL + "/api/mark_read", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ from_user: currentUser.username, to_user: user.username }),
        });
        loadFriends();
    } catch (e) {}

    $("message-input").focus();
}

function sendMessage() {
    const input = $("message-input");
    const text = input.value.trim();
    if (!text || !currentChat || !ws) return;

    const payload = {
        type: "message",
        to: currentChat.username,
        text: text,
        reply_to: replyToMsg ? replyToMsg.id : 0
    };

    ws.send(JSON.stringify(payload));
    
    // Локально добавляем сразу (чтобы не ждать ответа сервера)
    addMessageDOM({
        id: Date.now(), // Временный ID
        from: currentUser.username,
        to: currentChat.username,
        text: text,
        reply_to: replyToMsg ? replyToMsg.id : 0,
        time: new Date().toLocaleTimeString('ru-RU', { hour: '2-digit', minute: '2-digit' })
    });

    input.value = "";
    cancelReply();
}

// Отрисовка сообщения (с кнопками)
function addMessageDOM(msg) {
    const messagesEl = $("messages");
    const isOwn = msg.from === currentUser.username;

    const wrapper = document.createElement("div");
    wrapper.className = "message-wrapper " + (isOwn ? "own" : "");
    wrapper.id = "msg-" + msg.id;

    let contentHtml = "";
    if (msg.reply_to) {
        contentHtml += `<div class="reply-quote">Ответ на сообщение #${msg.reply_to}</div>`;
    }

    contentHtml += escapeHtml(msg.text);
    if (msg.edited) contentHtml += `<span class="edited-mark">(изм.)</span>`;

    wrapper.innerHTML = `
        <div class="message ${isOwn ? "own" : "other"}">
            ${contentHtml}
            <span class="message-time">${msg.time || ""}</span>
        </div>
        ${isOwn ? `
        <div class="message-actions">
            <button class="msg-btn" onclick="startEditMsg(${msg.id}, '${escapeHtml(msg.text)}')">✏️</button>
            <button class="msg-btn" onclick="deleteMsg(${msg.id})">🗑️</button>
        </div>` : `
        <div class="message-actions">
            <button class="msg-btn" onclick="startReply(${msg.id}, '${escapeHtml(msg.text)}')">↩️</button>
        </div>
        `}
    `;

    messagesEl.appendChild(wrapper);
    messagesEl.scrollTop = messagesEl.scrollHeight;
}

function deleteMsg(id) {
    if (!confirm("Удалить сообщение?")) return;
    ws.send(JSON.stringify({ type: "delete_msg", id: id }));
}

function startEditMsg(id, oldText) {
    const newText = prompt("Редактировать сообщение:", oldText);
    if (newText !== null && newText.trim() !== "" && newText !== oldText) {
        ws.send(JSON.stringify({ type: "edit_msg", id: id, text: newText }));
    }
}

function startReply(id, text) {
    replyToMsg = { id: id, text: text };
    $("reply-text").textContent = "Ответ: " + text;
    $("reply-box").style.display = "flex";
    $("message-input").focus();
}

function cancelReply() {
    replyToMsg = null;
    $("reply-box").style.display = "none";
}

// ============================================
// WEBSOCKET
// ============================================
function connectWebSocket() {
    const protocol = window.location.protocol === "https:" ? "wss:" : "ws:";
    ws = new WebSocket(`${protocol}//${window.location.host}/ws/${currentUser.username}`);

    ws.onopen = () => console.log("🟢 WebSocket подключён");

    ws.onmessage = (event) => {
        try {
            const msg = JSON.parse(event.data);
            
            if (msg.type === "message") {
                if (currentChat && (msg.from === currentChat.username || msg.to === currentChat.username)) {
                    addMessageDOM(msg);
                }
                loadFriends();
            } else if (msg.type === "update_msg") {
                const wrapper = document.getElementById("msg-" + msg.id);
                if (wrapper) {
                    const content = wrapper.querySelector(".message");
                    let inner = escapeHtml(msg.text);
                    if (msg.edited) inner += `<span class="edited-mark">(изм.)</span>`;
                    content.innerHTML = inner + `<span class="message-time">${msg.time || ""}</span>`;
                }
            }
        } catch (e) {
            console.error("Ошибка сообщения:", e);
        }
    };

    ws.onclose = () => {
        console.log("🔴 WebSocket отключён");
        setTimeout(connectWebSocket, 3000);
    };
}

// ============================================
// ПРОФИЛЬ
// ============================================
function openProfile(user) {
    profileUser = user;
    $("profile-title").textContent = user.display_name || user.username;
    $("profile-name").textContent = user.display_name || user.username;
    $("profile-username").textContent = "@" + user.username;
    $("profile-avatar").textContent = (user.display_name || user.username)[0].toUpperCase();
    $("profile-avatar").style.background = user.avatar_color || "var(--red)";
    $("profile-error").textContent = "";
    $("profile-modal").classList.add("active");
}

function closeProfile() {
    $("profile-modal").classList.remove("active");
    profileUser = null;
}

function writeToUser() {
    if (!profileUser) return;
    const user = profileUser;
    closeProfile();
    openChat(user);
}

async function removeCurrentFriend() {
    if (!profileUser) return;
    if (!confirm(`Удалить ${profileUser.display_name || profileUser.username} из друзей?`)) return;

    await fetch(API_URL + "/api/friends/remove", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ from_user: currentUser.username, to_user: profileUser.username }),
    });
    closeProfile();
    loadFriends();
}

async function blockCurrentUser() {
    if (!profileUser) return;
    if (!confirm(`Заблокировать ${profileUser.display_name || profileUser.username}?`)) return;

    await fetch(API_URL + "/api/friends/block", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ from_user: currentUser.username, to_user: profileUser.username }),
    });
    closeProfile();
    loadFriends();
}

async function ignoreCurrentUser() {
    if (!profileUser) return;

    await fetch(API_URL + "/api/friends/ignore", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ from_user: currentUser.username, to_user: profileUser.username }),
    });
    closeProfile();
}

// ============================================
// ДОБАВИТЬ ДРУГА
// ============================================
function openAddFriend() {
    $("add-friend-modal").classList.add("active");
    $("friend-username").value = "";
    $("friend-error").textContent = "";
    $("friend-username").focus();
}

function closeAddFriend() {
    $("add-friend-modal").classList.remove("active");
}

async function sendFriendRequest() {
    const toUser = $("friend-username").value.trim().toLowerCase();
    const errorEl = $("friend-error");
    errorEl.textContent = "";

    if (!toUser) { errorEl.textContent = "Введи ник"; return; }

    try {
        const resp = await fetch(API_URL + "/api/friends/request", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ from_user: currentUser.username, to_user: toUser }),
        });
        const data = await resp.json();

        if (!resp.ok) {
            errorEl.textContent = data.detail || "Ошибка";
            return;
        }

        errorEl.style.color = "#2e7d32";
        errorEl.textContent = "✅ Запрос отправлен!";
        setTimeout(() => {
            closeAddFriend();
            errorEl.style.color = "";
        }, 1500);
    } catch (e) {
        errorEl.textContent = "Ошибка соединения";
    }
}

// ============================================
// НАСТРОЙКИ (Смена имени, цвета, шрифта, списки)
// ============================================
async function openSettings() {
    $("settings-modal").classList.add("active");
    $("settings-name").value = currentUser.display_name || currentUser.username;
    $("settings-color").value = currentUser.avatar_color || "#e53935";
    $("settings-font").value = currentUser.font_family || "Inter, sans-serif";
    await loadBlockedAndIgnored();
}

function closeSettings() {
    $("settings-modal").classList.remove("active");
}

async function loadBlockedAndIgnored() {
    try {
        const resp = await fetch(API_URL + "/api/settings/" + currentUser.username);
        const data = await resp.json();
        
        const bList = $("blocked-list");
        bList.innerHTML = data.blocked.length === 0 ? '<div class="loading-small">Пусто</div>' : "";
        data.blocked.forEach(u => {
            bList.innerHTML += `<div class="setting-item"><span>@${u}</span><button onclick="unblockUser('${u}')">Разблокировать</button></div>`;
        });

        const iList = $("ignored-list");
        iList.innerHTML = data.ignored.length === 0 ? '<div class="loading-small">Пусто</div>' : "";
        data.ignored.forEach(u => {
            iList.innerHTML += `<div class="setting-item"><span>@${u}</span><button onclick="unignoreUser('${u}')">Убрать игнор</button></div>`;
        });
    } catch (e) {
        console.error("Ошибка настроек:", e);
    }
}

async function saveSettings() {
    const name = $("settings-name").value.trim();
    const color = $("settings-color").value;
    const font = $("settings-font").value;

    try {
        const resp = await fetch(API_URL + "/api/update_profile", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ username: currentUser.username, display_name: name, avatar_color: color, font_family: font }),
        });
        const data = await resp.json();

        if (resp.ok) {
            currentUser = data.user;
            localStorage.setItem("swaptime_user", JSON.stringify(currentUser));
            startChat();
            closeSettings();
        }
    } catch (e) {
        alert("Ошибка сохранения");
    }
}

async function unblockUser(u) {
    await fetch(API_URL + "/api/friends/unblock", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ from_user: currentUser.username, to_user: u }),
    });
    loadBlockedAndIgnored();
}

async function unignoreUser(u) {
    await fetch(API_URL + "/api/friends/unignore", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ from_user: currentUser.username, to_user: u }),
    });
    loadBlockedAndIgnored();
}

// ============================================
// ОБРАБОТЧИКИ
// ============================================
document.addEventListener("DOMContentLoaded", () => {
    document.querySelectorAll(".auth-tab").forEach(tab => {
        tab.onclick = () => {
            document.querySelectorAll(".auth-tab").forEach(t => t.classList.remove("active"));
            tab.classList.add("active");
            document.querySelectorAll(".auth-form").forEach(f => f.classList.remove("active"));
            $(tab.dataset.tab + "-form").classList.add("active");
        };
    });

    generateCaptcha();

    $("login-password").addEventListener("keypress", e => { if (e.key === "Enter") doLogin(); });
    $("reg-password-2").addEventListener("keypress", e => { if (e.key === "Enter") doRegister(); });
    $("message-input").addEventListener("keypress", e => { if (e.key === "Enter") sendMessage(); });

    $("search-users").addEventListener("input", e => {
        const q = e.target.value.toLowerCase();
        document.querySelectorAll(".user-item").forEach(el => {
            const name = el.querySelector(".user-item-name").textContent.toLowerCase();
            const username = el.dataset.username.toLowerCase();
            el.style.display = (name.includes(q) || username.includes(q)) ? "" : "none";
        });
    });

    const token = localStorage.getItem("swaptime_token");
    const savedUser = localStorage.getItem("swaptime_user");
    if (token && savedUser) {
        try {
            currentUser = JSON.parse(savedUser);
            startChat();
        } catch {}
    }
});