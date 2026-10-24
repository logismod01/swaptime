// ============================================================
// СВАПТАЙМ — КАНАЛЫ (как в Telegram)
// ============================================================
// Свои каналы и подписки, публикации, поиск публичных каналов.
// ============================================================

const TG_COLORS = [
  "#e53935", "#8e24aa", "#3949ab", "#1e88e5",
  "#00897b", "#43a047", "#f4511e", "#6d4c41",
  "#d81b60", "#546e7a",
];

let tgEditMode = false;
let tgNewColor = TG_COLORS[0];
let discoverResults = [];
let discoverTimer = null;

// ============================================================
// СПИСОК КАНАЛОВ
// ============================================================
async function refreshTgChannels() {
  const data = await api("/api/tg/channels");
  state.tgChannels = data.channels || [];
  renderTgList();
  updateTgRailBadge();

  if (state.view === "tg" && state.activeTg) {
    const exists = state.tgChannels.some((c) => c.id === state.activeTg);
    if (exists) await openTgChannel(state.activeTg, { silent: true });
    else {
      state.activeTg = null;
      state.tgData = null;
      if ($("tg-feed")) clear($("tg-feed"));
    }
  }
}

function updateTgRailBadge() {
  const badge = $("rail-tg");
  if (!badge) return;
  const unread = state.tgChannels.reduce((sum, c) => sum + (c.unread || 0), 0);
  badge.hidden = unread === 0;
  badge.textContent = unread > 99 ? "99+" : String(unread);
  const unreadRail = $("rail-unread");
  if (unreadRail) {
    const dmUnread = (state.users || []).reduce((sum, u) => sum + (u.unread || 0), 0);
    unreadRail.hidden = dmUnread === 0;
    unreadRail.textContent = dmUnread > 99 ? "99+" : String(dmUnread);
  }
}

function renderTgList() {
  const list = $("tg-list");
  if (!list) return;
  clear(list);

  const query = ($("search-users").value || "").trim().toLowerCase();
  const channels = state.tgChannels.filter(
    (c) =>
      !query ||
      c.name.toLowerCase().includes(query) ||
      (c.description || "").toLowerCase().includes(query)
  );

  if (!channels.length) {
    const empty = el("div", "loading-small", query ? "Ничего не найдено" : "Пока нет каналов. Создай свой!");
    list.appendChild(empty);
    return;
  }

  channels.forEach((channel) => {
    const item = el("div", "tg-item" + (channel.id === state.activeTg ? " active" : ""));
    item.dataset.tgId = String(channel.id);

    const avatar = el("div", "tg-mini-avatar", (channel.name || "?").trim().charAt(0).toUpperCase());
    avatar.style.background = safeColor(channel.color);
    item.appendChild(avatar);

    const info = el("div", "tg-item-info");
    const title = el("div", "tg-item-name");
    title.appendChild(el("span", "tg-item-title", channel.name));
    if (channel.is_owner) title.appendChild(el("span", "tg-owned", "мой"));
    info.appendChild(title);
    info.appendChild(
      el(
        "div",
        "tg-item-sub",
        channel.last_post && channel.last_post.text
          ? channel.last_post.text
          : channel.description || "нет постов"
      )
    );
    item.appendChild(info);

    if (channel.unread > 0) {
      item.appendChild(el("span", "tg-item-unread", channel.unread > 99 ? "99+" : String(channel.unread)));
    }

    item.addEventListener("click", () => openTgChannel(channel.id));
    list.appendChild(item);
  });
}

// ============================================================
// ЭКРАН КАНАЛА
// ============================================================
async function openTgChannel(channelId, options = {}) {
  try {
    const data = await api("/api/tg/channels/" + channelId);
    if (state.view !== "tg") setView("tg");
    state.activeTg = channelId;
    if (!options.silent && typeof setMobilePane === "function") setMobilePane(true);
    state.tgData = data;

    renderTgHeader();
    renderTgFeed();
    renderTgList();

    if (!options.silent) {
      api("/api/tg/channels/" + channelId + "/read", { method: "POST" }).catch(() => {});
      const channel = state.tgChannels.find((c) => c.id === channelId);
      if (channel) channel.unread = 0;
      renderTgList();
      updateTgRailBadge();
    }
  } catch (err) {
    toast(err.message || "Не удалось открыть канал", "error");
  }
}

function renderTgHeader() {
  const channel = state.tgData.channel;
  const avatar = $("tg-avatar");
  avatar.textContent = (channel.name || "?").trim().charAt(0).toUpperCase();
  avatar.style.background = safeColor(channel.color);

  $("tg-name").textContent = channel.name;
  $("tg-subscribers").textContent =
    (channel.subscribers || 0) + " " + plural(channel.subscribers || 0, "подписчик", "подписчика", "подписчиков");

  const subBtn = $("tg-subscribe-btn");
  if (channel.is_owner) {
    subBtn.style.display = "none";
  } else {
    subBtn.style.display = "";
    subBtn.textContent = channel.subscribed ? "✓" : "＋";
    subBtn.title = channel.subscribed ? "Отписаться" : "Подписаться";
    subBtn.classList.toggle("is-subscribed", !!channel.subscribed);
  }

  const settingsBtn = $("tg-settings-btn");
  settingsBtn.style.display = channel.is_owner ? "" : "none";

  const composer = $("tg-composer");
  composer.style.display = channel.is_owner ? "flex" : "none";
  $("tg-post-input").placeholder = "Новый пост в «" + channel.name + "»…";
}

function plural(n, one, few, many) {
  const mod10 = n % 10;
  const mod100 = n % 100;
  if (mod10 === 1 && mod100 !== 11) return one;
  if (mod10 >= 2 && mod10 <= 4 && (mod100 < 10 || mod100 >= 20)) return few;
  return many;
}

function renderTgFeed() {
  const feed = $("tg-feed");
  if (!feed) return;
  clear(feed);

  const posts = state.tgData.posts || [];
  if (!posts.length) {
    feed.appendChild(el("div", "chat-empty", "В канале пока нет постов"));
    return;
  }

  const channel = state.tgData.channel;
  posts.forEach((post, index) => {
    const card = el("article", "tg-post" + (post.deleted ? " deleted" : ""));
    card.dataset.postId = String(post.id);

    const head = el("div", "tg-post-head");
    const avatar = el("div", "tg-mini-avatar small", (channel.name || "?").charAt(0).toUpperCase());
    avatar.style.background = safeColor(channel.color);
    head.appendChild(avatar);
    const info = el("div", "tg-post-author");
    info.appendChild(el("div", "tg-post-channel", channel.name));
    info.appendChild(el("div", "tg-post-time", formatPostDate(post.created_at)));
    head.appendChild(info);

    if (channel.is_owner && !post.deleted) {
      const actions = el("div", "tg-post-actions");
      const editBtn = el("button", "msg-btn", "✏️");
      editBtn.title = "Редактировать пост";
      editBtn.addEventListener("click", () => editTgPost(post));
      actions.appendChild(editBtn);
      const delBtn = el("button", "msg-btn", "🗑️");
      delBtn.title = "Удалить пост";
      delBtn.addEventListener("click", () => removeTgPost(post));
      actions.appendChild(delBtn);
      head.appendChild(actions);
    }

    card.appendChild(head);

    const body = el("div", "tg-post-text");
    if (post.deleted) {
      body.classList.add("deleted-text");
      body.textContent = "Пост удалён";
    } else {
      body.textContent = post.text || "";
    }
    card.appendChild(body);

    if (post.edited && !post.deleted) {
      card.appendChild(el("div", "tg-post-edited", "изменён"));
    }

    if (index === posts.length - 1) card.classList.add("last");
    feed.appendChild(card);
  });
}

function formatPostDate(ts) {
  if (!ts) return "";
  const date = new Date(ts * 1000);
  const today = new Date();
  const sameDay =
    date.getDate() === today.getDate() &&
    date.getMonth() === today.getMonth() &&
    date.getFullYear() === today.getFullYear();
  const time = date.toLocaleTimeString("ru-RU", { hour: "2-digit", minute: "2-digit" });
  if (sameDay) return time;
  return date.toLocaleDateString("ru-RU", { day: "numeric", month: "short" }) + ", " + time;
}

// ============================================================
// ПУБЛИКАЦИИ
// ============================================================
async function publishPost() {
  if (!state.activeTg || !state.tgData) return;
  if (!state.tgData.channel.is_owner) return;

  const input = $("tg-post-input");
  const text = input.value.trim();
  if (!text) return;

  try {
    const data = await api(`/api/tg/channels/${state.activeTg}/posts`, {
      method: "POST",
      body: { text },
    });
    input.value = "";
    state.tgData.posts.push(data.post);
    renderTgFeed();
    const feed = $("tg-feed");
    feed.scrollTop = feed.scrollHeight;
    toast("Опубликовано", "success", 1600);
  } catch (err) {
    toast(err.message || "Не удалось опубликовать", "error");
  }
}

async function editTgPost(post) {
  const next = prompt("Редактировать пост:", post.text || "");
  if (next === null) return;
  const text = next.trim();
  if (!text || text === post.text) return;
  try {
    const data = await api(`/api/tg/posts/${post.id}/edit`, { method: "POST", body: { text } });
    const current = state.tgData.posts.find((p) => p.id === post.id);
    if (current) Object.assign(current, data.post);
    renderTgFeed();
  } catch (err) {
    toast(err.message, "error");
  }
}

async function removeTgPost(post) {
  if (!confirm("Удалить пост?")) return;
  try {
    await api(`/api/tg/posts/${post.id}`, { method: "DELETE" });
    const current = state.tgData.posts.find((p) => p.id === post.id);
    if (current) {
      current.deleted = 1;
      current.text = "";
      current.edited = 0;
    }
    renderTgFeed();
  } catch (err) {
    toast(err.message, "error");
  }
}

async function toggleTgSubscription() {
  if (!state.tgData) return;
  const channel = state.tgData.channel;
  if (channel.is_owner) return;

  try {
    if (channel.subscribed) {
      await api(`/api/tg/channels/${channel.id}/unsubscribe`, { method: "POST" });
      channel.subscribed = false;
      channel.subscribers = Math.max(0, (channel.subscribers || 1) - 1);
      state.tgChannels = state.tgChannels.filter((c) => c.id !== channel.id);
      state.activeTg = null;
      state.tgData = null;
      setView("tg");
      await refreshTgChannels();
      toast("Ты отписался", "info");
      return;
    }
    await api(`/api/tg/channels/${channel.id}/subscribe`, { method: "POST" });
    channel.subscribed = true;
    channel.subscribers = (channel.subscribers || 0) + 1;
    renderTgHeader();
    await refreshTgChannels();
    toast("Ты подписался", "success");
  } catch (err) {
    toast(err.message, "error");
  }
}

// ============================================================
// СОЗДАНИЕ / РЕДАКТИРОВАНИЕ
// ============================================================
function renderTgColorRow() {
  const row = $("tg-color-row");
  if (!row) return;
  clear(row);
  TG_COLORS.forEach((color) => {
    const btn = el("button", "color-dot" + (color === tgNewColor ? " selected" : ""));
    btn.type = "button";
    btn.style.background = color;
    btn.title = color;
    btn.addEventListener("click", () => {
      tgNewColor = color;
      renderTgColorRow();
    });
    row.appendChild(btn);
  });
}

function openTgModal(channel) {
  tgEditMode = !!channel;
  $("tg-save-btn").textContent = tgEditMode ? "Сохранить" : "Создать";
  $("tg-delete-btn").style.display = tgEditMode ? "" : "none";
  $("tg-error").textContent = "";

  $("tg-name-input").value = channel ? channel.name : "";
  $("tg-desc-input").value = channel ? channel.description || "" : "";
  $("tg-public").checked = channel ? !!channel.is_public : true;
  tgNewColor = channel ? safeColor(channel.color) : TG_COLORS[Math.floor(Math.random() * TG_COLORS.length)];

  renderTgColorRow();
  $("tg-modal").classList.add("active");
  setTimeout(() => $("tg-name-input").focus(), 50);
}

function openTgSettings() {
  if (!state.tgData || !state.tgData.channel.is_owner) return;
  openTgModal(state.tgData.channel);
}

async function saveTgChannel() {
  const name = $("tg-name-input").value.trim();
  const description = $("tg-desc-input").value.trim();
  const isPublic = $("tg-public").checked;
  const errorEl = $("tg-error");
  errorEl.textContent = "";

  if (name.length < 2) {
    errorEl.textContent = "Название — минимум 2 символа";
    return;
  }

  try {
    if (tgEditMode && state.tgData) {
      const data = await api(`/api/tg/channels/${state.tgData.channel.id}/update`, {
        method: "POST",
        body: { name, description, is_public: isPublic },
      });
      Object.assign(state.tgData.channel, data.channel);
      closeModal("tg-modal");
      renderTgHeader();
      renderTgFeed();
      await refreshTgChannels();
      toast("Канал обновлён", "success");
    } else {
      const data = await api("/api/tg/channels", {
        method: "POST",
        body: { name, description, color: tgNewColor, is_public: isPublic },
      });
      closeModal("tg-modal");
      setView("tg");
      await refreshTgChannels();
      await openTgChannel(data.channel.id);
      toast("Канал «" + data.channel.name + "» создан", "success");
    }
  } catch (err) {
    errorEl.textContent = err.message || "Ошибка";
  }
}

async function deleteTgChannel() {
  if (!state.tgData) return;
  if (!confirm("Удалить канал вместе со всеми постами?")) return;
  try {
    await api(`/api/tg/channels/${state.tgData.channel.id}`, { method: "DELETE" });
    closeModal("tg-modal");
    state.activeTg = null;
    state.tgData = null;
    setView("tg");
    await refreshTgChannels();
    toast("Канал удалён", "success");
  } catch (err) {
    $("tg-error").textContent = err.message || "Ошибка";
  }
}

// ============================================================
// ПОИСК ПУБЛИЧНЫХ КАНАЛОВ
// ============================================================
function openDiscover() {
  $("discover-input").value = "";
  $("discover-list").innerHTML = '<div class="loading-small">Загрузка…</div>';
  $("discover-modal").classList.add("active");
  searchDiscover("", true);
}

async function searchDiscover(forced) {
  const query = forced === true ? "" : $("discover-input").value.trim();
  if (discoverTimer) clearTimeout(discoverTimer);

  const run = async () => {
    try {
      const data = await api("/api/tg/discover?q=" + encodeURIComponent(query));
      discoverResults = data.channels || [];
      renderDiscover();
    } catch (err) {
      $("discover-list").innerHTML = "";
      $("discover-list").appendChild(el("div", "loading-small", err.message || "Ошибка"));
    }
  };

  if (forced === true) return run();
  discoverTimer = setTimeout(run, 250);
}

function renderDiscover() {
  const list = $("discover-list");
  if (!list) return;
  clear(list);

  if (!discoverResults.length) {
    list.appendChild(el("div", "loading-small", "Публичных каналов не нашлось"));
    return;
  }

  discoverResults.forEach((channel) => {
    const row = el("div", "discover-row");
    const avatar = el("div", "tg-mini-avatar", (channel.name || "?").charAt(0).toUpperCase());
    avatar.style.background = safeColor(channel.color);
    row.appendChild(avatar);

    const info = el("div", "discover-info");
    info.appendChild(el("div", "discover-name", channel.name));
    info.appendChild(
      el("div", "discover-desc", channel.description || channel.subscribers + " подписчиков")
    );
    row.appendChild(info);

    const action = el("button", "mini-btn", channel.subscribed ? "Открыть" : "Подписаться");
    action.addEventListener("click", async () => {
      try {
        if (!channel.subscribed) {
          await api(`/api/tg/channels/${channel.id}/subscribe`, { method: "POST" });
          channel.subscribed = true;
          action.textContent = "Открыть";
          toast("Подписка оформлена", "success");
          await refreshTgChannels();
        } else {
          closeModal("discover-modal");
          setView("tg");
          await openTgChannel(channel.id);
        }
      } catch (err) {
        toast(err.message, "error");
      }
    });
    row.appendChild(action);

    list.appendChild(row);
  });
}

// ============================================================
// СОБЫТИЯ WS
// ============================================================
function handleTgEvent(msg) {
  switch (msg.type) {
    case "tg_post": {
      const mine = state.tgChannels.find((c) => c.id === msg.channel_id);
      if (state.tgData && state.tgData.channel.id === msg.channel_id) {
        // свой пост уже добавлен после ответа REST — не дублируем
        if (state.tgData.posts.some((p) => p.id === msg.post.id)) break;
        state.tgData.posts.push(msg.post);
        renderTgFeed();
        api(`/api/tg/channels/${msg.channel_id}/read`, { method: "POST" }).catch(() => {});
      } else {
        if (mine) mine.unread = (mine.unread || 0) + 1;
        refreshTgChannels().catch(() => {});
        toast("📣 " + msg.channel_name + ": новый пост", "info");
      }
      break;
    }

    case "tg_post_updated": {
      if (state.tgData && state.tgData.channel.id === msg.channel_id) {
        const index = state.tgData.posts.findIndex((p) => p.id === msg.post.id);
        if (index >= 0) state.tgData.posts[index] = msg.post;
        renderTgFeed();
      }
      break;
    }

    case "tg_channel_deleted": {
      state.tgChannels = state.tgChannels.filter((c) => c.id !== msg.channel_id);
      if (state.activeTg === msg.channel_id) {
        state.activeTg = null;
        state.tgData = null;
        if (state.view === "tg") setView("tg");
      }
      renderTgList();
      updateTgRailBadge();
      break;
    }

    default:
      break;
  }
}
