// ============================================================
// СВАПТАЙМ — СЕРВЕРЫ (как в Discord)
// ============================================================
// Список серверов в рейле, каналы сервера, сообщения канала,
// участники, приглашения, роли, создание/редактирование.
// ============================================================

const SERVER_ICONS = ["🏰", "🚀", "🎮", "🎧", "🐉", "🔥", "🌊", "🍕", "🧠", "🎬", "⚽", "🌸"];

let serverMembers = new Map();      // username -> member card
let serverMessages = [];            // сообщения открытого канала
let serverEditMode = false;         // создаём или редактируем сервер
let serverTypingSent = 0;
let serverTypingTimer = null;
let serverPickerIcon = SERVER_ICONS[0];

// ============================================================
// СПИСОК И ЗАГРУЗКА
// ============================================================
async function refreshServers() {
  const data = await api("/api/servers");
  state.servers = data.servers || [];
  renderServerRail();

  if (state.view === "server" && state.activeServer) {
    const exists = state.servers.some((s) => s.id === state.activeServer);
    if (!exists) {
      state.activeServer = null;
      state.serverData = null;
      setView("chats");
      return;
    }
    try {
      const full = await api("/api/servers/" + state.activeServer);
      state.serverData = full;
      serverMembers = new Map((full.members || []).map((m) => [m.username, m]));
      updateServerHeader();
      renderServerChannels();
      renderMembers();
    } catch (err) {
      if (err.status === 403 || err.status === 404) {
        state.activeServer = null;
        setView("chats");
      }
    }
  }
}

async function openServer(serverId) {
  try {
    const data = await api("/api/servers/" + serverId);
    state.activeServer = serverId;
    state.serverData = data;
    serverMembers = new Map((data.members || []).map((m) => [m.username, m]));

    setView("server");
    updateServerHeader();
    renderServerChannels();
    renderMembers();
    renderServerRail();

    const target =
      (state.activeChannel && data.channels.find((c) => c.id === state.activeChannel)) ||
      data.channels[0];
    if (target) openServerChannel(target.id);
    else $("server-messages").innerHTML = '<div class="chat-empty">В сервере нет каналов</div>';

    const showMembers = window.innerWidth > 1180;
    $("members-panel").style.display = showMembers ? "flex" : "none";
  } catch (err) {
    toast(err.message || "Не удалось открыть сервер", "error");
  }
}

function updateServerHeader() {
  const data = state.serverData;
  if (!data) return;
  $("server-head-name").textContent = data.name;
  const head = $("server-head");
  head.style.setProperty("--server-color", safeColor(data.icon_color));
  $("voice-channel-name").textContent = "общий голосовой";
  document.title = data.name + " — СвапТайм";
}

function renderServerChannels() {
  const list = $("server-channels-list");
  if (!list || !state.serverData) return;
  clear(list);

  const query = ($("search-users").value || "").trim().toLowerCase();

  (state.serverData.channels || []).forEach((channel) => {
    const item = el("div", "channel-item" + (channel.id === state.activeChannel ? " active" : ""));
    item.dataset.channelId = String(channel.id);
    if (channel.unread > 0) item.classList.add("unread");

    item.appendChild(el("span", "channel-hash", "#"));
    item.appendChild(el("span", "channel-name", channel.name));
    if (channel.unread > 0) {
      item.appendChild(el("span", "channel-unread", channel.unread > 99 ? "99+" : String(channel.unread)));
    }
    if (channel.name.toLowerCase().indexOf(query) === -1 && query) item.style.display = "none";

    item.addEventListener("click", () => openServerChannel(channel.id));
    list.appendChild(item);
  });
}

// ============================================================
// СООБЩЕНИЯ КАНАЛА
// ============================================================
async function openServerChannel(channelId) {
  if (!state.serverData) return;
  const channel = state.serverData.channels.find((c) => c.id === channelId);
  if (!channel) return;

  state.activeChannel = channelId;
  $("server-channel-name").textContent = channel.name;
  $("server-channel-topic").textContent = channel.topic || "без темы";
  $("server-input").placeholder = "Написать в #" + channel.name;
  renderServerChannels();

  const box = $("server-messages");
  clear(box);
  box.appendChild(el("div", "messages-loading", "Загружаю сообщения…"));

  try {
    const messages = await api(
      `/api/servers/${state.activeServer}/channels/${channelId}/messages`
    );
    if (state.activeChannel !== channelId) return;
    clear(box);
    serverMessages = messages;
    if (!messages.length) {
      box.appendChild(
        el("div", "chat-empty", "Это начало канала #" + channel.name + ". Напиши первым!")
      );
    } else {
      messages.forEach((msg) => appendServerMessage(msg, false));
      groupServerMessages();
    }
    box.scrollTop = box.scrollHeight;

    api(`/api/servers/${state.activeServer}/channels/${channelId}/read`, { method: "POST" }).catch(() => {});
    channel.unread = 0;
    renderServerChannels();
    updateServerUnreadInRail();
  } catch (err) {
    clear(box);
    box.appendChild(el("div", "messages-loading", err.message || "Не удалось загрузить канал"));
  }
}

function updateServerUnreadInRail() {
  if (!state.serverData) return;
  const total = (state.serverData.channels || []).reduce((sum, c) => sum + (c.unread || 0), 0);
  const entry = state.servers.find((s) => s.id === state.activeServer);
  if (entry) entry.unread = total;
  renderServerRail();
}

function serverUserCard(username) {
  if (state.user && username === state.user.username) return state.user;
  if (serverMembers.has(username)) return serverMembers.get(username);
  return getUserCard(username) || { username, display_name: username, avatar_color: "#3f3f46" };
}

function buildServerMessageNode(msg) {
  const isOwn = msg.from === state.user.username;
  const author = serverUserCard(msg.from);

  const wrapper = el("div", "message-wrapper");
  wrapper.dataset.serverMsgId = String(msg.id);
  if (msg.client_id) wrapper.dataset.clientId = msg.client_id;
  if (msg.pending) wrapper.classList.add("pending");

  wrapper.appendChild(el("div", "msg-gutter", formatTime(msg.created_at)));

  const avatarWrap = el("div", "msg-avatar");
  avatarWrap.appendChild(avatarNode(author));
  wrapper.appendChild(avatarWrap);

  const content = el("div", "msg-content");
  const header = el("div", "msg-header");
  header.appendChild(el("span", "msg-author" + (isOwn ? " is-own" : ""), author.display_name || author.username));
  const role = author.role;
  if (role === "owner") header.appendChild(el("span", "role-badge owner", "ВЛАДЕЛЕЦ"));
  else if (role === "admin") header.appendChild(el("span", "role-badge admin", "АДМИН"));
  header.appendChild(el("span", "msg-time", formatTime(msg.created_at)));
  content.appendChild(header);

  const textEl = el("div", "message" + (isOwn ? " own" : " other"));
  const textInner = el("div", "message-text");
  if (msg.deleted) {
    textInner.classList.add("deleted-text");
    textInner.textContent = "Сообщение удалено";
  } else {
    textInner.textContent = msg.text || "";
  }
  textEl.appendChild(textInner);
  if (msg.edited && !msg.deleted) {
    const meta = el("div", "message-meta");
    meta.appendChild(el("span", "edited-mark", "(изм.)"));
    textEl.appendChild(meta);
  }
  content.appendChild(textEl);
  wrapper.appendChild(content);

  if (!msg.deleted && msg.id) {
    const actions = el("div", "message-actions");

    const copyBtn = el("button", "msg-btn", "⧉");
    copyBtn.title = "Скопировать";
    copyBtn.addEventListener("click", () => {
      navigator.clipboard && navigator.clipboard.writeText(msg.text || "");
      toast("Скопировано", "success", 1500);
    });
    actions.appendChild(copyBtn);

    if (isOwn) {
      const editBtn = el("button", "msg-btn", "✏️");
      editBtn.title = "Редактировать";
      editBtn.addEventListener("click", () => editServerMessage(msg));
      actions.appendChild(editBtn);
    }

    const canDelete = isOwn || ["owner", "admin"].includes((state.serverData && state.serverData.my_role) || "");
    if (canDelete) {
      const delBtn = el("button", "msg-btn", "🗑️");
      delBtn.title = "Удалить";
      delBtn.addEventListener("click", () => deleteServerMessage(msg));
      actions.appendChild(delBtn);
    }
    wrapper.appendChild(actions);
  }

  return wrapper;
}

function appendServerMessage(msg, animate = true) {
  const box = $("server-messages");
  const placeholder = box.querySelector(".chat-empty, .messages-loading");
  if (placeholder) placeholder.remove();

  const node = buildServerMessageNode(msg);
  if (!animate) node.classList.add("no-anim");
  box.appendChild(node);
}

function groupServerMessages() {
  const nodes = Array.from($("server-messages").querySelectorAll(".message-wrapper"));
  let prev = null;
  nodes.forEach((node) => {
    const id = node.dataset.serverMsgId;
    const msg = id ? serverMessages.find((m) => String(m.id) === id) : null;
    let grouped = false;
    if (prev && prev.msg && msg) {
      grouped =
        prev.msg.from === msg.from &&
        Math.abs((msg.created_at || 0) - (prev.msg.created_at || 0)) < 300 &&
        !prev.msg.deleted;
    }
    node.classList.toggle("grouped", grouped);
    prev = { node, msg };
  });
}

function upsertServerMessage(msg) {
  if (state.view !== "server" || !state.serverData) return;
  if (msg.server_id && msg.server_id !== state.activeServer) return;
  if (msg.channel_id !== state.activeChannel) {
    const channel = state.serverData.channels.find((c) => c.id === msg.channel_id);
    if (channel && msg.from !== state.user.username) {
      channel.unread = (channel.unread || 0) + 1;
      renderServerChannels();
      updateServerUnreadInRail();
    }
    return;
  }

  const box = $("server-messages");
  const index = serverMessages.findIndex((m) => m.id === msg.id);
  if (index >= 0) serverMessages[index] = msg;
  else serverMessages.push(msg);

  const existing = (msg.client_id
    ? box.querySelector(`[data-client-id="${cssEscape(msg.client_id)}"]`)
    : null) ||
    (msg.id ? box.querySelector(`[data-server-msg-id="${msg.id}"]`) : null);

  const node = buildServerMessageNode(msg);
  const sticky = box.scrollHeight - box.scrollTop - box.clientHeight < 140;

  if (existing) existing.replaceWith(node);
  else {
    const placeholder = box.querySelector(".chat-empty, .messages-loading");
    if (placeholder) placeholder.remove();
    box.appendChild(node);
  }

  groupServerMessages();
  if (sticky || msg.from === state.user.username) box.scrollTop = box.scrollHeight;
}

function cssEscape(value) {
  return String(value).replace(/["\\]/g, "\\$&");
}

function sendServerMessage() {
  const input = $("server-input");
  const text = input.value.trim();
  if (!text || !state.activeChannel) return;

  const clientId = uuid();
  const optimistic = {
    id: null,
    client_id: clientId,
    channel_id: state.activeChannel,
    from: state.user.username,
    text,
    edited: 0,
    deleted: 0,
    created_at: Math.floor(Date.now() / 1000),
    pending: true,
  };

  upsertServerMessage(optimistic);
  input.value = "";

  const sent = sendWS({
    type: "server_message",
    channel_id: state.activeChannel,
    text,
    client_id: clientId,
  });
  if (!sent) {
    api(`/api/servers/${state.activeServer}/channels/${state.activeChannel}/messages`, {
      method: "POST",
      body: { text, client_id: clientId },
    }).catch((err) => toast(err.message, "error"));
  }
}

function sendServerTyping() {
  if (!state.activeChannel || !state.wsOpen) return;
  const now = Date.now();
  if (now - serverTypingSent < 2500) return;
  serverTypingSent = now;
  sendWS({ type: "server_typing", channel_id: state.activeChannel });
}

function editServerMessage(msg) {
  const next = prompt("Редактировать сообщение:", msg.text || "");
  if (next === null) return;
  const text = next.trim();
  if (!text || text === msg.text) return;
  sendWS({ type: "server_edit_msg", id: msg.id, text });
}

function deleteServerMessage(msg) {
  if (!confirm("Удалить сообщение?")) return;
  sendWS({ type: "server_delete_msg", id: msg.id });
}

// ============================================================
// УЧАСТНИКИ
// ============================================================
function renderMembers() {
  const list = $("members-list");
  if (!list || !state.serverData) return;
  clear(list);

  const members = state.serverData.members || [];
  $("members-count").textContent = String(members.length);

  const groups = [
    { key: "owner", title: "Владелец" },
    { key: "admin", title: "Админы" },
    { key: "member", title: "Участники" },
  ];

  groups.forEach((group) => {
    const items = members.filter((m) => (m.role || "member") === group.key);
    if (!items.length) return;

    list.appendChild(el("div", "members-group", group.title + " — " + items.length));
    items.forEach((member) => {
      const row = el("div", "member-row" + (member.online ? " online" : ""));
      row.appendChild(avatarNode(member, "", { frame: member.avatar_frame }));

      const info = el("div", "member-info");
      const name = el("div", "member-name", member.display_name || member.username);
      if (member.role !== "member") name.classList.add("role-" + member.role);
      info.appendChild(name);
      info.appendChild(el("div", "member-sub", member.online ? "в сети" : "не в сети"));
      row.appendChild(info);

      const actions = el("div", "member-actions");

      if (member.username !== state.user.username) {
        const callBtn = el("button", "member-action", "📞");
        callBtn.title = "Позвонить";
        callBtn.addEventListener("click", (e) => {
          e.stopPropagation();
          startCall({ video: true, withUser: member.username });
        });
        actions.appendChild(callBtn);

        const myRole = state.serverData.my_role;
        if (myRole === "owner" && member.role !== "owner") {
          const roleBtn = el("button", "member-action", member.role === "admin" ? "★" : "☆");
          roleBtn.title = member.role === "admin" ? "Снять админа" : "Сделать админом";
          roleBtn.addEventListener("click", (e) => {
            e.stopPropagation();
            setMemberRole(member.username, member.role === "admin" ? "member" : "admin");
          });
          actions.appendChild(roleBtn);
        }

        if (["owner", "admin"].includes(myRole) && member.role !== "owner") {
          const kickBtn = el("button", "member-action danger", "✕");
          kickBtn.title = "Исключить";
          kickBtn.addEventListener("click", (e) => {
            e.stopPropagation();
            kickMember(member.username);
          });
          actions.appendChild(kickBtn);
        }
      }

      row.appendChild(actions);
      row.addEventListener("click", () => openProfile(member.username));
      list.appendChild(row);
    });
  });
}

function toggleMembers() {
  const panel = $("members-panel");
  const visible = panel.style.display !== "none";
  if (visible) panel.style.display = "none";
  else {
    if (state.view !== "server") {
      toast("Участники доступны на сервере", "info");
      return;
    }
    panel.style.display = "flex";
    renderMembers();
  }
}

async function setMemberRole(username, role) {
  try {
    await api(`/api/servers/${state.activeServer}/members/${username}/role`, {
      method: "POST",
      body: { role },
    });
    toast(role === "admin" ? "Теперь админ" : "Права сняты", "success");
  } catch (err) {
    toast(err.message, "error");
  }
}

async function kickMember(username) {
  if (!confirm(`Исключить @${username} с сервера?`)) return;
  try {
    await api(`/api/servers/${state.activeServer}/members/${username}/kick`, { method: "POST" });
    toast("Исключён", "success");
  } catch (err) {
    toast(err.message, "error");
  }
}

// ============================================================
// МОДАЛКИ
// ============================================================
function closeModal(id) {
  const node = $(id);
  if (node) node.classList.remove("active");
}

function openServerModal(mode = "create") {
  serverEditMode = mode === "edit";
  $("server-modal-title").textContent = serverEditMode ? "Изменить сервер" : "Создать сервер";
  $("server-save-btn").textContent = serverEditMode ? "Сохранить" : "Создать";
  $("server-error").textContent = "";

  const current = serverEditMode ? state.serverData : null;
  $("server-name-input").value = current ? current.name : "";
  $("server-desc-input").value = current ? current.description : "";
  serverPickerIcon = current ? current.icon || SERVER_ICONS[0] : SERVER_ICONS[0];

  renderServerIconPicker();
  $("server-modal").classList.add("active");
  setTimeout(() => $("server-name-input").focus(), 50);
}

function renderServerIconPicker() {
  const box = $("server-icon-picker");
  clear(box);
  SERVER_ICONS.forEach((icon) => {
    const btn = el("button", "emoji-option" + (icon === serverPickerIcon ? " selected" : ""), icon);
    btn.type = "button";
    btn.addEventListener("click", () => {
      serverPickerIcon = icon;
      renderServerIconPicker();
    });
    box.appendChild(btn);
  });
}

async function saveServer() {
  const name = $("server-name-input").value.trim();
  const description = $("server-desc-input").value.trim();
  const errorEl = $("server-error");
  errorEl.textContent = "";

  if (name.length < 2) {
    errorEl.textContent = "Название — минимум 2 символа";
    return;
  }

  try {
    if (serverEditMode && state.activeServer) {
      const data = await api(`/api/servers/${state.activeServer}/update`, {
        method: "POST",
        body: { name, description, icon: serverPickerIcon },
      });
      state.serverData = data.server;
      updateServerHeader();
      renderServerChannels();
      closeModal("server-modal");
      toast("Сервер обновлён", "success");
      await refreshServers();
    } else {
      const data = await api("/api/servers", {
        method: "POST",
        body: { name, description, icon: serverPickerIcon, icon_color: state.user.avatar_color },
      });
      closeModal("server-modal");
      await refreshServers();
      await openServer(data.server.id);
      toast("Сервер создан! Код: " + data.server.invite_code, "success", 6000);
    }
  } catch (err) {
    errorEl.textContent = err.message || "Ошибка";
  }
}

function openChannelModal() {
  if (!state.serverData) return;
  if (!["owner", "admin"].includes(state.serverData.my_role)) {
    toast("Создавать каналы может владелец или админ", "warn");
    return;
  }
  $("channel-name-input").value = "";
  $("channel-topic-input").value = "";
  $("channel-error").textContent = "";
  $("channel-modal").classList.add("active");
  setTimeout(() => $("channel-name-input").focus(), 50);
}

async function saveChannel() {
  const name = $("channel-name-input").value.trim();
  const topic = $("channel-topic-input").value.trim();
  const errorEl = $("channel-error");
  errorEl.textContent = "";

  if (name.length < 1) {
    errorEl.textContent = "Введи название";
    return;
  }

  try {
    const data = await api(`/api/servers/${state.activeServer}/channels`, {
      method: "POST",
      body: { name, topic },
    });
    state.serverData = data.server;
    closeModal("channel-modal");
    renderServerChannels();
    if (data.channel_id) openServerChannel(data.channel_id);
    toast("Канал создан", "success");
  } catch (err) {
    errorEl.textContent = err.message || "Ошибка";
  }
}

function openServerMenu() {
  if (!state.serverData) return;
  $("server-menu-title").textContent = state.serverData.name;
  $("server-invite-code").textContent = state.serverData.invite_code;
  $("server-menu-error").textContent = "";

  const role = state.serverData.my_role;
  const isOwner = role === "owner";
  document.querySelectorAll('[data-action="delete-server"]').forEach((b) => {
    b.style.display = isOwner ? "" : "none";
  });
  document.querySelectorAll('[data-action="edit-server"], [data-action="create-server-channel"]').forEach((b) => {
    b.style.display = ["owner", "admin"].includes(role) ? "" : "none";
  });
  document.querySelectorAll('[data-action="leave-server"]').forEach((b) => {
    b.style.display = isOwner ? "none" : "";
  });

  $("server-menu-modal").classList.add("active");
}

async function copyInvite() {
  const code = state.serverData && state.serverData.invite_code;
  if (!code) return;
  try {
    await navigator.clipboard.writeText(code);
    toast("Код скопирован: " + code, "success");
  } catch (err) {
    toast("Код: " + code, "info", 6000);
  }
}

function openJoinModal() {
  closeModal("server-menu-modal");
  $("invite-code-input").value = "";
  $("join-error").textContent = "";
  $("join-server-modal").classList.add("active");
  setTimeout(() => $("invite-code-input").focus(), 50);
}

async function joinServer() {
  const code = $("invite-code-input").value.trim();
  const errorEl = $("join-error");
  errorEl.textContent = "";
  if (!code) {
    errorEl.textContent = "Введи код";
    return;
  }

  try {
    const data = await api("/api/servers/join", { method: "POST", body: { code } });
    closeModal("join-server-modal");
    await refreshServers();
    await openServer(data.server.id);
    toast("Ты на сервере «" + data.server.name + "»", "success");
  } catch (err) {
    errorEl.textContent = err.message || "Не удалось войти";
  }
}

async function leaveServer() {
  if (!state.activeServer) return;
  if (!confirm("Покинуть сервер?")) return;
  try {
    await api(`/api/servers/${state.activeServer}/leave`, { method: "POST" });
    closeModal("server-menu-modal");
    state.activeServer = null;
    state.serverData = null;
    setView("chats");
    await refreshServers();
    toast("Ты покинул сервер", "success");
  } catch (err) {
    $("server-menu-error").textContent = err.message;
  }
}

async function deleteServer() {
  if (!state.activeServer) return;
  if (!confirm("Удалить сервер навсегда? Каналы и сообщения пропадут.")) return;
  try {
    await api(`/api/servers/${state.activeServer}`, { method: "DELETE" });
    closeModal("server-menu-modal");
    state.activeServer = null;
    state.serverData = null;
    setView("chats");
    await refreshServers();
    toast("Сервер удалён", "success");
  } catch (err) {
    $("server-menu-error").textContent = err.message;
  }
}

function editServer() {
  closeModal("server-menu-modal");
  openServerModal("edit");
}

// ============================================================
// СОБЫТИЯ WS
// ============================================================
function handleServerEvent(msg) {
  switch (msg.type) {
    case "server_message": {
      if (state.activeServer && msg.server_id === state.activeServer) {
        upsertServerMessage(msg);
        if (serverMembers.size && msg.from && !serverMembers.has(msg.from)) {
          // новый участник — обновим список
          refreshServers();
        }
      } else {
        const entry = state.servers.find((s) => s.id === msg.server_id);
        if (entry && msg.from !== state.user.username) {
          entry.unread = (entry.unread || 0) + 1;
          renderServerRail();
        }
      }
      break;
    }

    case "server_message_updated": {
      if (msg.server_id === state.activeServer && msg.channel_id === state.activeChannel) {
        upsertServerMessage(msg);
      }
      break;
    }

    case "server_channels_changed":
    case "server_member_joined":
    case "server_member_left":
    case "server_members_changed":
    case "server_updated": {
      if (msg.server_id === state.activeServer) {
        api("/api/servers/" + msg.server_id)
          .then((data) => {
            state.serverData = data;
            serverMembers = new Map((data.members || []).map((m) => [m.username, m]));
            updateServerHeader();
            renderServerChannels();
            renderMembers();
            if (msg.type === "server_channel_created" && msg.channel_id) {
              openServerChannel(msg.channel_id);
            }
          })
          .catch(() => {});
      }
      refreshServers().catch(() => {});
      if (msg.type === "server_member_joined" && msg.user) {
        toast("@" + msg.user.username + " присоединился к серверу", "info");
      }
      break;
    }

    case "server_typing": {
      if (msg.server_id !== state.activeServer || msg.channel_id !== state.activeChannel) break;
      const line = $("server-typing");
      const card = serverUserCard(msg.from);
      line.textContent = (card.display_name || msg.from) + " печатает…";
      line.style.display = "block";
      if (serverTypingTimer) clearTimeout(serverTypingTimer);
      serverTypingTimer = setTimeout(() => {
        line.style.display = "none";
      }, 3000);
      break;
    }

    case "server_left": {
      if (msg.server_id === state.activeServer) {
        state.activeServer = null;
        state.serverData = null;
        setView("chats");
      }
      refreshServers().catch(() => {});
      toast(msg.kicked ? "Тебя исключили с сервера" : "Сервер больше недоступен", "warn");
      break;
    }

    default:
      break;
  }
}
