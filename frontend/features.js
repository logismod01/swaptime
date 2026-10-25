// ============================================================
// СВАПТАЙМ — v12: реакции, поиск, черновики, избранное, статусы
// ============================================================
//  1. реакции-эмодзи на сообщения (личка + каналы сервера)
//  2. поиск по чату/каналу (Ctrl+F) с переходом по совпадениям
//  3. избранное — сохранённые сообщения
//  4. черновики на каждый чат и канал
//  5. закрепление чатов в списке
//  6. тихие чаты + уведомления на рабочем столе и звук
//  7. форматирование текста (**жирный**, *курсив*, ~~зачёркнутый~~, `код`, ||спойлер||)
//  8. разделитель «Новые сообщения» и кнопка «вниз» с бейджем
//  9. быстрый переход Ctrl+K
// 10. статусы: в сети / отошёл / не беспокоить / невидимка + текст
// ============================================================

// ---------- хранилище ----------
const FS_KEYS = {
  saved: "swaptime_saved_messages",
  pinnedChats: "swaptime_pinned_chats",
  muted: "swaptime_muted",
  notify: "swaptime_notify_settings",
  draft: "swaptime_draft:",
};

function fsGet(key, fallback) {
  try {
    const raw = localStorage.getItem(key);
    return raw ? JSON.parse(raw) : fallback;
  } catch (err) {
    return fallback;
  }
}

function fsSet(key, value) {
  try {
    localStorage.setItem(key, JSON.stringify(value));
  } catch (err) {
    /* приватный режим — просто не сохраняем */
  }
}

// ============================================================
// 7. ФОРМАТИРОВАНИЕ ТЕКСТА
// ============================================================
const RICH_RE =
  /```([\s\S]+?)```|`([^`\n]+)`|\*\*([\s\S]+?)\*\*|__([\s\S]+?)__|~~([\s\S]+?)~~|\|\|([\s\S]+?)\|\||\*([^*\n]+?)\*|_([^_\n]+?)_/g;

function revealSpoiler(node) {
  node.classList.add("revealed");
}

/** Безопасный рендер разметки: только DOM-узлы, никакого innerHTML. */
function renderRichText(container, text) {
  container.textContent = "";
  const value = String(text || "");
  if (!value) return;

  const appendText = (chunk) => {
    if (!chunk) return;
    // переносы строк — просто как текст, CSS держит white-space: pre-wrap
    container.appendChild(document.createTextNode(chunk));
  };

  RICH_RE.lastIndex = 0;
  let last = 0;
  let match;
  while ((match = RICH_RE.exec(value)) !== null) {
    if (match[0] === "") break;
    appendText(value.slice(last, match.index));
    const [, block, code, bold1, bold2, strike, spoiler, italic1, italic2] = match;

    if (block) {
      const pre = el("pre", "rich-code-block");
      pre.textContent = block.replace(/^\n/, "").replace(/\n$/, "");
      container.appendChild(pre);
    } else if (code) {
      container.appendChild(el("code", "rich-code", code));
    } else if (bold1 || bold2) {
      container.appendChild(el("strong", "rich-bold", bold1 || bold2));
    } else if (strike) {
      container.appendChild(el("s", "rich-strike", strike));
    } else if (spoiler) {
      const node = el("span", "rich-spoiler", spoiler);
      node.title = "Спойлер — нажми, чтобы показать";
      node.addEventListener("click", () => revealSpoiler(node));
      container.appendChild(node);
    } else if (italic1 || italic2) {
      container.appendChild(el("em", "rich-italic", italic1 || italic2));
    }
    last = match.index + match[0].length;
  }
  appendText(value.slice(last));
}

function wrapSelection(input, before, after) {
  if (!input) return;
  const start = input.selectionStart ?? input.value.length;
  const end = input.selectionEnd ?? input.value.length;
  const value = input.value;
  const selected = value.slice(start, end) || "текст";
  input.value = value.slice(0, start) + before + selected + after + value.slice(end);
  input.focus();
  input.selectionStart = start + before.length;
  input.selectionEnd = start + before.length + selected.length;
  input.dispatchEvent(new Event("input", { bubbles: true }));
}

const FORMAT_WRAP = {
  bold: ["**", "**"],
  italic: ["*", "*"],
  strike: ["~~", "~~"],
  code: ["`", "`"],
  spoiler: ["||", "||"],
};

// ============================================================
// 1. РЕАКЦИИ
// ============================================================
const QUICK_REACTIONS = ["👍", "❤️", "😂", "🔥", "🎉", "😮", "😢", "👀"];

function reactionScopeOf(msg, scope) {
  if (scope === "channel") return "channel";
  if (scope === "tg_post") return "tg_post";
  return "dm";
}

function buildReactionsNode(msg, scope, always) {
  const list = Array.isArray(msg.reactions) ? msg.reactions : [];
  // пустой контейнер не рисуем — иначе под каждым сообщением висит пустая строка
  // (кроме постов каналов-лент: там нужна кнопка «＋», чтобы начать реакцию)
  if (!list.length && !always) return null;

  const box = el("div", "reactions");
  box.dataset.reactionsFor = String(msg.id || "");
  box.dataset.reactionsScope = reactionScopeOf(msg, scope);

  list.forEach((item) => {
    if (!item || !item.emoji || !item.count) return;
    const mine = Array.isArray(item.users) && state.user && item.users.includes(state.user.username);
    const chip = el("button", "reaction-chip" + (mine ? " mine" : ""));
    chip.type = "button";
    chip.dataset.emoji = item.emoji;
    chip.title = (item.users || []).join(", ") || "реакция";
    chip.appendChild(el("span", "reaction-emoji", item.emoji));
    chip.appendChild(el("span", "reaction-count", String(item.count)));
    chip.addEventListener("click", () => toggleReaction(msg, item.emoji, scope));
    box.appendChild(chip);
  });

  const add = el("button", "reaction-chip reaction-add", "＋");
  add.type = "button";
  add.title = "Добавить реакцию";
  add.addEventListener("click", (event) => openReactionPicker(event.currentTarget, msg, scope));
  box.appendChild(add);

  return box;
}

let pickerOpenedAt = 0;

function openReactionPicker(anchor, msg, scope) {
  closeReactionPicker();

  // если кнопка за пределами видимой части чата — подкручиваем к сообщению
  const wrapper = anchor.closest(".message-wrapper");
  if (wrapper) {
    const box = wrapper.closest(".messages");
    if (box) {
      const boxRect = box.getBoundingClientRect();
      const nodeRect = wrapper.getBoundingClientRect();
      if (nodeRect.top < boxRect.top || nodeRect.bottom > boxRect.bottom) {
        scrollIntoBox(box, wrapper, 60);
      }
    }
  }

  const picker = el("div", "reaction-picker");
  picker.id = "reaction-picker";
  QUICK_REACTIONS.forEach((emoji) => {
    const btn = el("button", "reaction-pick", emoji);
    btn.type = "button";
    btn.addEventListener("click", () => {
      toggleReaction(msg, emoji, scope);
      closeReactionPicker();
    });
    picker.appendChild(btn);
  });
  document.body.appendChild(picker);

  const place = (initial) => {
    if (!picker.isConnected) return false;
    const rect = anchor.getBoundingClientRect();
    // при прокрутке кнопка может уехать за пределы чата — тогда пикер закрываем
    // первые полсекунды не закрываем: плавная прокрутка ещё доезжает
    const settled = Date.now() - pickerOpenedAt > 500;
    if (!initial && settled && (rect.bottom < 8 || rect.top > window.innerHeight - 8)) {
      closeReactionPicker();
      return false;
    }

    const width = picker.offsetWidth || 280;
    const height = picker.offsetHeight || 46;

    let left = Math.min(rect.left, window.innerWidth - width - 12);
    left = Math.max(8, left);

    // сначала над сообщением, иначе под ним, но всегда в пределах окна
    let top = rect.top - height - 8;
    if (top < 8) top = rect.bottom + 8;
    const maxTop = Math.max(8, window.innerHeight - height - 8);
    top = Math.min(Math.max(8, top), maxTop);

    picker.style.left = left + "px";
    picker.style.top = top + "px";
    return true;
  };

  pickerOpenedAt = Date.now();
  if (!place(true)) return;

  setTimeout(() => {
    document.addEventListener("click", onReactionPickerOutside, { once: true });
    // при прокрутке список уезжает — держим пикер рядом с кнопкой
    const onScroll = () => place(false);
    document.querySelectorAll(".messages").forEach((box) => {
      box.addEventListener("scroll", onScroll, { passive: true });
    });
    window.addEventListener("resize", onScroll);
  }, 0);
}

function onReactionPickerOutside(event) {
  const picker = document.getElementById("reaction-picker");
  if (picker && picker.contains(event.target)) return;
  closeReactionPicker();
}

function closeReactionPicker() {
  const picker = document.getElementById("reaction-picker");
  if (picker) picker.remove();
}

function toggleReaction(msg, emoji, scope) {
  if (!msg || !msg.id) return;
  const effective = reactionScopeOf(msg, scope);

  // посты каналов-лент идут только через REST (у WS нет такого scope)
  if (effective === "tg_post") {
    api("/api/reactions", {
      method: "POST",
      body: { scope: "tg_post", message_id: msg.id, emoji },
    }).catch((err) => toast(err.message || "Не удалось поставить реакцию", "error"));
    return;
  }

  const payload = { type: "reaction", id: msg.id, emoji, scope: effective };
  if (scope === "channel") payload.channel_id = msg.channel_id || state.activeChannel;
  const sent = sendWS(payload);
  if (!sent) {
    api("/api/reactions", {
      method: "POST",
      body: { scope: reactionScopeOf(msg, scope), message_id: msg.id, emoji },
    }).catch((err) => toast(err.message || "Не удалось поставить реакцию", "error"));
  }
}

function findMessageObjectById(id) {
  const local = state.messages.get(id);
  if (local) return local;
  if (typeof serverMessages !== "undefined" && Array.isArray(serverMessages)) {
    const found = serverMessages.find((m) => m.id === id);
    if (found) return found;
  }
  return null;
}

function applyReactionEvent(msg) {
  if (!msg || !msg.message_id) return;

  // реакции на постах каналов-лент
  if (msg.scope === "tg_post") {
    const post = state.tgData && (state.tgData.posts || []).find((p) => p.id === msg.message_id);
    if (post) {
      post.reactions = msg.reactions || [];
      if (typeof renderTgFeed === "function") renderTgFeed();
    }
    return;
  }

  const scope = msg.scope === "channel" ? "channel" : "dm";
  const target = findMessageObjectById(msg.message_id);
  if (target) target.reactions = msg.reactions || [];

  const selector =
    scope === "channel"
      ? `#server-messages [data-server-msg-id="${msg.message_id}"]`
      : `#messages [data-msg-id="${msg.message_id}"]`;
  const wrapper = document.querySelector(selector);
  if (wrapper && target) {
    const messageEl = wrapper.querySelector(".message");
    const old = messageEl && messageEl.querySelector(".reactions");
    const fresh = buildReactionsNode(target, scope);
    if (old && fresh) old.replaceWith(fresh);
    else if (old) old.remove();
    else if (fresh && messageEl) messageEl.appendChild(fresh);
  }
}

function addMessageExtras(actions, msg, ctx) {
  if (!msg.id) return;
  const scope = reactionScopeOf(msg, ctx && ctx.scope);

  const reactBtn = el("button", "msg-btn reaction-btn", "😊");
  reactBtn.type = "button";
  reactBtn.title = "Реакция";
  reactBtn.addEventListener("click", (event) => openReactionPicker(event.currentTarget, msg, scope));
  actions.appendChild(reactBtn);

  const saveBtn = el("button", "msg-btn saved-btn" + (isSavedMessage(msg.id) ? " is-saved" : ""), "🔖");
  saveBtn.type = "button";
  saveBtn.title = isSavedMessage(msg.id) ? "Убрать из избранного" : "В избранное";
  saveBtn.addEventListener("click", () => {
    const added = toggleSavedMessage(msg, scope);
    saveBtn.classList.toggle("is-saved", added);
    saveBtn.title = added ? "Убрать из избранного" : "В избранное";
  });
  actions.appendChild(saveBtn);

  const forwardBtn = el("button", "msg-btn", "⇄");
  forwardBtn.type = "button";
  forwardBtn.title = "Переслать";
  forwardBtn.addEventListener("click", () => openForward(msg, scope));
  actions.appendChild(forwardBtn);
}

// ============================================================
// 2. ПОИСК ПО ЧАТУ / КАНАЛУ
// ============================================================
const searchState = { scope: null, hits: [], index: -1 };

/** Прокрутить контейнер так, чтобы узел оказался у его верхнего края. */
function scrollIntoBox(box, node, offset = 40) {
  if (!box || !node) return;
  const boxRect = box.getBoundingClientRect();
  const nodeRect = node.getBoundingClientRect();
  box.scrollTop += nodeRect.top - boxRect.top - offset;
}

function searchBox(scope) {
  return scope === "channel" ? $("channel-search") : $("chat-search");
}

function searchInput(scope) {
  return scope === "channel" ? $("channel-search-input") : $("chat-search-input");
}

function searchMessages(scope) {
  return scope === "channel" ? $("server-messages") : $("messages");
}

function openChatSearch(scope) {
  const box = searchBox(scope);
  const input = searchInput(scope);
  if (!box || !input) return;

  document.querySelectorAll(".chat-search").forEach((node) => {
    if (node !== box) node.style.display = "none";
  });
  box.style.display = "flex";
  input.value = "";
  searchState.scope = scope;
  searchState.hits = [];
  searchState.index = -1;
  setSearchCount(scope, 0, 0);
  clearSearchHits();
  input.focus();
}

function setSearchCount(scope, index, total) {
  const label = scope === "channel" ? $("channel-search-count") : $("chat-search-count");
  if (label) label.textContent = total ? `${index + 1}/${total}` : "0/0";
}

function clearSearchHits() {
  document.querySelectorAll(".search-hit").forEach((node) => node.classList.remove("search-hit"));
}

function runSearch(scope, query) {
  clearSearchHits();
  searchState.scope = scope;
  searchState.hits = [];
  searchState.index = -1;

  const needle = (query || "").trim().toLowerCase();
  if (!needle) {
    setSearchCount(scope, 0, 0);
    return;
  }

  const box = searchMessages(scope);
  if (!box) return;
  box.querySelectorAll(".message-wrapper").forEach((node) => {
    const text = (node.textContent || "").toLowerCase();
    if (text.includes(needle)) {
      node.classList.add("search-hit");
      searchState.hits.push(node);
    }
  });

  if (searchState.hits.length) {
    searchState.index = searchState.hits.length - 1;
    scrollToHit(true);
  } else {
    setSearchCount(scope, 0, 0);
  }
}

function scrollToHit(silent) {
  const hit = searchState.hits[searchState.index];
  if (!hit) return;
  const box = searchMessages(searchState.scope);
  scrollIntoBox(box, hit, box.clientHeight / 2 - hit.offsetHeight / 2);
  hit.classList.add("search-current");
  document.querySelectorAll(".search-current").forEach((node) => {
    if (node !== hit) node.classList.remove("search-current");
  });
  setSearchCount(searchState.scope, searchState.index, searchState.hits.length);
  if (!silent) hit.classList.remove("search-current");
  setTimeout(() => hit.classList.add("search-current"), 30);
}

function stepSearch(delta) {
  if (!searchState.hits.length) return;
  const total = searchState.hits.length;
  searchState.index = (searchState.index + delta + total) % total;
  scrollToHit(false);
}

function closeChatSearch() {
  document.querySelectorAll(".chat-search").forEach((node) => (node.style.display = "none"));
  clearSearchHits();
  searchState.scope = null;
  searchState.hits = [];
  searchState.index = -1;
}

// ============================================================
// 4. ЧЕРНОВИКИ
// ============================================================
function draftStorageKey(scope, id) {
  return FS_KEYS.draft + scope + ":" + id;
}

function saveDraft(scope, id, text) {
  if (!id) return;
  try {
    if (text && text.trim()) localStorage.setItem(draftStorageKey(scope, id), text);
    else localStorage.removeItem(draftStorageKey(scope, id));
  } catch (err) {
    /* ignore */
  }
}

function clearDraft(scope, id) {
  if (!id) return;
  try {
    localStorage.removeItem(draftStorageKey(scope, id));
  } catch (err) {
    /* ignore */
  }
  if (scope === "dm") {
    const node = document.querySelector(`#users-list .user-item[data-username="${id}"]`);
    if (node) node.classList.remove("has-draft");
  }
}

function getDraft(scope, id) {
  if (!id) return "";
  try {
    return localStorage.getItem(draftStorageKey(scope, id)) || "";
  } catch (err) {
    return "";
  }
}

function restoreDraft(scope, id) {
  const text = getDraft(scope, id);
  if (!text) return false;
  const input = scope === "channel" ? $("server-input") : $("message-input");
  if (!input) return false;
  input.value = text;
  return true;
}

// ============================================================
// 5-6. ЗАКРЕПЛЕНИЕ ЧАТОВ, ТИХИЕ ЧАТЫ, ПРЕВЬЮ ЧЕРНОВИКА
// ============================================================
function pinnedChatList() {
  const list = fsGet(FS_KEYS.pinnedChats, []);
  return Array.isArray(list) ? list : [];
}

function isPinnedChat(username) {
  return pinnedChatList().includes(username);
}

function togglePinnedChat(username) {
  const list = pinnedChatList();
  const index = list.indexOf(username);
  if (index >= 0) list.splice(index, 1);
  else list.unshift(username);
  fsSet(FS_KEYS.pinnedChats, list);
  renderDMList();
}

function mutedKeys() {
  const list = fsGet(FS_KEYS.muted, []);
  return Array.isArray(list) ? list : [];
}

function muteKey(scope, id) {
  return scope + ":" + id;
}

function isMuted(scope, id) {
  return mutedKeys().includes(muteKey(scope, id));
}

function toggleMute(scope, id) {
  const list = mutedKeys();
  const key = muteKey(scope, id);
  const index = list.indexOf(key);
  if (index >= 0) list.splice(index, 1);
  else list.push(key);
  fsSet(FS_KEYS.muted, list);
  syncChatMuteButton();
  renderMuteList();
  decorateChatList($("users-list"));
  toast(index >= 0 ? "Уведомления включены" : "Чат без уведомлений", "info", 1600);
}

function syncChatMuteButton() {
  const dmBtn = $("chat-mute-btn");
  if (dmBtn && state.current) {
    const muted = isMuted("dm", state.current);
    dmBtn.textContent = muted ? "🔕" : "🔔";
    dmBtn.title = muted ? "Включить уведомления" : "Отключить уведомления";
    dmBtn.classList.toggle("muted", muted);
  }
  const chBtn = $("channel-mute-btn");
  if (chBtn && state.activeChannel) {
    const muted = isMuted("channel", String(state.activeChannel));
    chBtn.textContent = muted ? "🔕" : "🔔";
    chBtn.title = muted ? "Включить уведомления" : "Отключить уведомления";
    chBtn.classList.toggle("muted", muted);
  }
}

/** Иконки закрепления, тишины и превью черновика в списке чатов. */
function decorateChatList(listEl) {
  if (!listEl) return;
  const pinned = pinnedChatList();
  const nodes = Array.from(listEl.querySelectorAll(".user-item"));

  nodes.forEach((node) => {
    const username = node.dataset.username;
    if (!username) return;

    node.classList.toggle("chat-pinned", pinned.includes(username));

    let pinBtn = node.querySelector(".chat-pin-btn");
    if (!pinBtn) {
      pinBtn = el("button", "chat-pin-btn", "📌");
      pinBtn.type = "button";
      pinBtn.addEventListener("click", (event) => {
        event.stopPropagation();
        togglePinnedChat(username);
      });
      node.appendChild(pinBtn);
    }
    pinBtn.classList.toggle("on", pinned.includes(username));
    pinBtn.title = pinned.includes(username) ? "Открепить чат" : "Закрепить чат";

    let muteMark = node.querySelector(".chat-mute-mark");
    if (isMuted("dm", username)) {
      if (!muteMark) {
        muteMark = el("span", "chat-mute-mark", "🔕");
        node.appendChild(muteMark);
      }
    } else if (muteMark) {
      muteMark.remove();
    }

    const draft = getDraft("dm", username);
    const preview = node.querySelector(".user-item-status");
    if (preview) {
      if (draft) {
        if (!node.dataset.savedPreview) node.dataset.savedPreview = preview.textContent || "";
        preview.textContent = "Черновик: " + draft.replace(/\s+/g, " ").slice(0, 40);
        preview.classList.add("draft-preview");
        node.classList.add("has-draft");
      } else if (preview.classList.contains("draft-preview")) {
        preview.textContent = node.dataset.savedPreview || "";
        delete node.dataset.savedPreview;
        preview.classList.remove("draft-preview");
        node.classList.remove("has-draft");
      }
    }
  });

  if (!nodes.length) return;

  const ordered = nodes.slice().sort((a, b) => {
    const ap = pinned.includes(a.dataset.username) ? 0 : 1;
    const bp = pinned.includes(b.dataset.username) ? 0 : 1;
    return ap - bp;
  });
  ordered.forEach((node) => listEl.appendChild(node));

  listEl.querySelectorAll(".dm-group-label").forEach((node) => node.remove());
  const firstPinned = listEl.querySelector(".user-item.chat-pinned");
  if (firstPinned) {
    const label = el("div", "dm-group-label", "📌 Закреплённые");
    listEl.insertBefore(label, firstPinned);
  }

  const badge = $("fav-badge");
  if (badge) {
    const count = savedMessages().length;
    badge.hidden = count === 0;
    badge.textContent = count > 99 ? "99+" : String(count);
  }
}

// ============================================================
// 8. «НОВЫЕ СООБЩЕНИЯ» И КНОПКА «ВНИЗ»
// ============================================================
function placeUnreadDivider(container, unread) {
  if (!container) return;
  container.querySelectorAll(".unread-divider").forEach((node) => node.remove());
  const count = Number(unread) || 0;
  if (count <= 0) return;

  const nodes = Array.from(container.querySelectorAll(".message-wrapper"));
  if (!nodes.length) return;
  const index = Math.max(0, nodes.length - Math.min(count, nodes.length));
  const divider = el("div", "unread-divider");
  divider.appendChild(el("span", "unread-divider-text", "Новые сообщения"));
  nodes[index].before(divider);
  scrollIntoBox(container, divider, 32);
  setTimeout(() => divider.classList.add("faded"), 4000);
}

function jumpScopeBox(scope) {
  return scope === "channel" ? $("server-messages") : $("messages");
}

function updateJumpButton(scope) {
  const box = jumpScopeBox(scope);
  const btn = scope === "channel" ? $("server-jump-bottom") : $("jump-bottom");
  const countEl = scope === "channel" ? $("server-jump-count") : $("jump-count");
  if (!box || !btn) return;

  const distance = box.scrollHeight - box.scrollTop - box.clientHeight;
  if (distance < 200) {
    btn.style.display = "none";
    return;
  }

  btn.style.display = "inline-flex";
  if (countEl) {
    const boxRect = box.getBoundingClientRect();
    let below = 0;
    box.querySelectorAll(".message-wrapper").forEach((node) => {
      const rect = node.getBoundingClientRect();
      if (rect.top > boxRect.bottom - 24) below += 1;
    });
    countEl.textContent = below > 0 ? String(below) : "↓";
  }
}

function jumpToBottom(scope) {
  const box = jumpScopeBox(scope);
  if (!box) return;
  box.scrollTop = box.scrollHeight;
  const btn = scope === "channel" ? $("server-jump-bottom") : $("jump-bottom");
  if (btn) btn.style.display = "none";
}

// ============================================================
// 3. ИЗБРАННОЕ (saved messages)
// ============================================================
function savedMessages() {
  const list = fsGet(FS_KEYS.saved, []);
  return Array.isArray(list) ? list : [];
}

function isSavedMessage(msgId) {
  return savedMessages().some((item) => Number(item.id) === Number(msgId));
}

function toggleSavedMessage(msg, scope) {
  if (!msg || !msg.id) return false;
  const list = savedMessages();
  const index = list.findIndex((item) => Number(item.id) === Number(msg.id) && item.scope === scope);

  if (index >= 0) {
    list.splice(index, 1);
    fsSet(FS_KEYS.saved, list);
    renderFavorites();
    decorateChatList($("users-list"));
    toast("Убрано из избранного", "info", 1500);
    return false;
  }

  list.unshift({
    id: msg.id,
    scope,
    channel_id: msg.channel_id || state.activeChannel || null,
    server_id: scope === "channel" ? state.activeServer : null,
    chat: scope === "channel" ? "#" + (($("server-channel-name") || {}).textContent || "канал") : msg.from === state.user.username ? msg.to : msg.from,
    chat_name:
      scope === "channel"
        ? "#" + (($("server-channel-name") || {}).textContent || "канал")
        : displayNameFor(msg.from === state.user.username ? msg.to : msg.from),
    from: msg.from,
    from_name: displayNameFor(msg.from),
    text: msg.text || "",
    created_at: msg.created_at || Math.floor(Date.now() / 1000),
    saved_at: Math.floor(Date.now() / 1000),
  });
  fsSet(FS_KEYS.saved, list);
  renderFavorites();
  decorateChatList($("users-list"));
  toast("Сохранено в избранное", "success", 1500);
  return true;
}

function openFavorites() {
  renderFavorites();
  $("favorites-modal").classList.add("active");
}

function closeFavorites() {
  $("favorites-modal").classList.remove("active");
}

function renderFavorites() {
  const list = $("favorites-list");
  if (!list) return;
  const query = (($("favorites-search") || {}).value || "").trim().toLowerCase();
  const items = savedMessages().filter((item) => {
    if (!query) return true;
    return (item.text + " " + item.chat_name + " " + item.from_name).toLowerCase().includes(query);
  });

  clear(list);
  if (!items.length) {
    list.appendChild(el("div", "loading-small", query ? "Ничего не найдено" : "Пока пусто — жми 🔖 у сообщения"));
    return;
  }

  items.forEach((item) => {
    const row = el("div", "favorite-row");

    const main = el("button", "favorite-main");
    main.type = "button";
    const top = el("div", "favorite-top");
    top.appendChild(el("span", "favorite-author", item.from_name || item.from));
    top.appendChild(el("span", "favorite-chat", item.chat_name ? "· " + item.chat_name : ""));
    top.appendChild(el("span", "favorite-time", formatTime(item.created_at)));
    main.appendChild(top);
    main.appendChild(el("div", "favorite-text", item.text || "сообщение удалено"));
    main.addEventListener("click", () => jumpToSaved(item));
    row.appendChild(main);

    const del = el("button", "favorite-del", "✕");
    del.type = "button";
    del.title = "Убрать";
    del.addEventListener("click", () => {
      const next = savedMessages().filter(
        (entry) => !(Number(entry.id) === Number(item.id) && entry.scope === item.scope)
      );
      fsSet(FS_KEYS.saved, next);
      renderFavorites();
      decorateChatList($("users-list"));
    });
    row.appendChild(del);

    list.appendChild(row);
  });
}

function jumpToSaved(item) {
  closeFavorites();
  if (item.scope === "channel" && item.server_id) {
    openServer(item.server_id).then(() => {
      if (item.channel_id) {
        openServerChannel(item.channel_id).then(() => {
          setTimeout(() => focusServerMessage(item.id), 120);
        });
      }
    });
    return;
  }
  openChat(item.chat).then(() => setTimeout(() => focusMessage(item.id), 120));
}

function focusServerMessage(id) {
  const box = $("server-messages");
  if (!box) return;
  const node = box.querySelector(`[data-server-msg-id="${id}"]`);
  if (!node) return;
  scrollIntoBox(box, node, box.clientHeight / 2 - node.offsetHeight / 2);
  node.classList.add("highlight");
  setTimeout(() => node.classList.remove("highlight"), 1400);
}

function clearFavorites() {
  if (!savedMessages().length) return;
  if (!confirm("Очистить избранное?")) return;
  fsSet(FS_KEYS.saved, []);
  renderFavorites();
  decorateChatList($("users-list"));
}

// ============================================================
// ПЕРЕСЫЛКА СООБЩЕНИЙ
// ============================================================
let forwardSource = null;

function openForward(msg, scope) {
  if (!msg || !msg.text) {
    toast("Это сообщение нельзя переслать", "warn");
    return;
  }
  forwardSource = { msg, scope };
  $("forward-error").textContent = "";
  $("forward-preview").textContent = (displayNameFor(msg.from) || msg.from) + ": " + msg.text.slice(0, 120);
  $("forward-search").value = "";
  renderForwardList();
  $("forward-modal").classList.add("active");
}

function closeForward() {
  $("forward-modal").classList.remove("active");
  forwardSource = null;
}

function renderForwardList() {
  const list = $("forward-list");
  if (!list) return;
  const query = (($("forward-search") || {}).value || "").trim().toLowerCase();
  clear(list);

  const chats = (state.chats || []).filter((chat) => !query || chat.username.includes(query) || (chat.display_name || "").toLowerCase().includes(query));
  if (!chats.length) {
    list.appendChild(el("div", "loading-small", "Нет друзей для пересылки"));
    return;
  }

  chats.forEach((chat) => {
    const row = el("button", "forward-row");
    row.type = "button";
    const av = el("span", "av-slot");
    if (typeof avatarNode === "function") av.appendChild(avatarNode(chat, "", { frame: chat.avatar_frame }));
    row.appendChild(av);
    row.appendChild(el("span", "forward-name", chat.display_name || chat.username));
    row.appendChild(el("span", "forward-tag", "@" + chat.username));
    row.addEventListener("click", () => sendForward(chat.username));
    list.appendChild(row);
  });
}

function sendForward(username) {
  const source = forwardSource;
  if (!source) return;
  const { msg, scope } = source;

  const clientId = typeof uuid === "function" ? uuid() : "f-" + Date.now();
  const sent = sendWS({
    type: "message",
    to: username,
    text: msg.text,
    client_id: clientId,
    reply_to: 0,
    fwd_from: msg.from,
    fwd_name: displayNameFor(msg.from),
  });

  if (!sent) {
    $("forward-error").textContent = "Нет связи с сервером — попробуй ещё раз";
    return;
  }

  closeForward();
  toast("Переслано → " + displayNameFor(username), "success", 1800);
  if (state.current !== username) markRead(state.current);
  void scope;
}

// ============================================================
// 9. БЫСТРЫЙ ПЕРЕХОД (Ctrl+K)
// ============================================================
let quickItems = [];
let quickIndex = 0;

function buildQuickItems() {
  const items = [];

  (state.chats || []).forEach((chat) => {
    items.push({
      icon: "💬",
      title: chat.display_name || chat.username,
      hint: "@" + chat.username,
      run: () => openChat(chat.username),
    });
  });

  (state.servers || []).forEach((server) => {
    items.push({
      icon: server.icon || "🏰",
      title: server.name,
      hint: "сервер",
      run: () => openServer(server.id),
    });
  });

  if (state.serverData && state.serverData.channels) {
    state.serverData.channels.forEach((channel) => {
      items.push({
        icon: "#",
        title: "#" + channel.name,
        hint: state.serverData.name,
        run: () => openServerChannel(channel.id),
      });
    });
  }

  (state.tgChannels || []).forEach((channel) => {
    items.push({
      icon: "📣",
      title: channel.name,
      hint: "канал · " + (channel.subscribers || 0) + " подписчиков",
      run: () => openTgChannel(channel.id),
    });
  });

  items.push({ icon: "🔖", title: "Избранное", hint: "сохранённые сообщения", run: () => openFavorites() });
  items.push({ icon: "⚙", title: "Настройки", hint: "профиль, темы, звонки", run: () => openSettings() });

  return items;
}

function openQuickSwitch() {
  quickItems = buildQuickItems();
  quickIndex = 0;
  $("quick-switch-input").value = "";
  renderQuickList();
  $("quick-switch").classList.add("active");
  setTimeout(() => $("quick-switch-input").focus(), 30);
}

function closeQuickSwitch() {
  $("quick-switch").classList.remove("active");
}

function filterQuickItems(query) {
  const needle = (query || "").trim().toLowerCase();
  if (!needle) return quickItems;
  return quickItems.filter((item) => (item.title + " " + item.hint).toLowerCase().includes(needle));
}

function renderQuickList() {
  const list = $("quick-switch-list");
  if (!list) return;
  clear(list);

  const items = filterQuickItems($("quick-switch-input").value);
  if (!items.length) {
    list.appendChild(el("div", "loading-small", "Ничего не найдено"));
    return;
  }
  if (quickIndex >= items.length) quickIndex = 0;

  items.forEach((item, index) => {
    const row = el("button", "quick-row" + (index === quickIndex ? " active" : ""));
    row.type = "button";
    row.appendChild(el("span", "quick-icon", item.icon));
    row.appendChild(el("span", "quick-title", item.title));
    row.appendChild(el("span", "quick-hint", item.hint));
    row.addEventListener("click", () => {
      closeQuickSwitch();
      item.run();
    });
    row.addEventListener("mousemove", () => {
      if (quickIndex !== index) {
        quickIndex = index;
        list.querySelectorAll(".quick-row").forEach((node, i) => node.classList.toggle("active", i === quickIndex));
      }
    });
    list.appendChild(row);
  });
}

function stepQuick(delta) {
  const items = filterQuickItems($("quick-switch-input").value);
  if (!items.length) return;
  quickIndex = (quickIndex + delta + items.length) % items.length;
  renderQuickList();
  const active = document.querySelector("#quick-switch-list .quick-row.active");
  if (active) active.scrollIntoView({ block: "nearest" });
}

function runQuickItem() {
  const items = filterQuickItems($("quick-switch-input").value);
  const item = items[quickIndex];
  if (!item) return;
  closeQuickSwitch();
  item.run();
}

// ============================================================
// 6. УВЕДОМЛЕНИЯ
// ============================================================
function notifyConfig() {
  const saved = fsGet(FS_KEYS.notify, null);
  return Object.assign({ desktop: false, sound: true, preview: true }, saved || {});
}

function saveNotifySettings() {
  const desktop = $("notify-desktop");
  const sound = $("notify-sound");
  const preview = $("notify-preview");
  const cfg = {
    desktop: !!(desktop && desktop.checked),
    sound: !!(sound && sound.checked),
    preview: !!(preview && preview.checked),
  };
  fsSet(FS_KEYS.notify, cfg);
  if (cfg.desktop) requestNotificationPermission();
  return cfg;
}

function requestNotificationPermission() {
  const hint = $("notify-hint");
  if (!("Notification" in window)) {
    if (hint) hint.textContent = "Браузер не поддерживает уведомления — останутся звук и бейджи.";
    return;
  }
  if (Notification.permission === "granted") {
    if (hint) hint.textContent = "Уведомления разрешены ✓";
    return;
  }
  if (Notification.permission === "denied") {
    if (hint) hint.textContent = "Уведомления запрещены в настройках браузера.";
    return;
  }
  Notification.requestPermission().then((permission) => {
    if (hint) {
      hint.textContent =
        permission === "granted" ? "Уведомления разрешены ✓" : "Разрешение не выдано — будет только звук.";
    }
  });
}

let audioCtx = null;

function playPing() {
  try {
    const Ctx = window.AudioContext || window.webkitAudioContext;
    if (!Ctx) return;
    audioCtx = audioCtx || new Ctx();
    const osc = audioCtx.createOscillator();
    const gain = audioCtx.createGain();
    osc.type = "sine";
    osc.frequency.value = 880;
    gain.gain.setValueAtTime(0.0001, audioCtx.currentTime);
    gain.gain.exponentialRampToValueAtTime(0.09, audioCtx.currentTime + 0.02);
    gain.gain.exponentialRampToValueAtTime(0.0001, audioCtx.currentTime + 0.22);
    osc.connect(gain).connect(audioCtx.destination);
    osc.start();
    osc.stop(audioCtx.currentTime + 0.24);
  } catch (err) {
    /* без звука — не критично */
  }
}

function notifyIncomingMessage(msg, ctx) {
  const peer = msg.from;
  if (isMuted("dm", peer)) return;
  const cfg = notifyConfig();
  const focused = ctx && ctx.focused;
  if (focused && ctx && ctx.isCurrent) return;

  if (cfg.sound) playPing();

  if (cfg.desktop && "Notification" in window && Notification.permission === "granted") {
    try {
      const title = displayNameFor(peer) || peer;
      const note = new Notification(title, {
        body: cfg.preview ? (msg.text || "").slice(0, 160) : "Новое сообщение",
        tag: "dm-" + peer,
        icon: "/static/icons/icon-192.png",
      });
      note.onclick = () => {
        window.focus();
        openChat(peer);
        note.close();
      };
    } catch (err) {
      /* ignore */
    }
  }

  if (state.current !== peer) updateTitleBadge();
}

function updateTitleBadge() {
  const total = (state.chats || []).reduce((sum, chat) => sum + (isMuted("dm", chat.username) ? 0 : chat.unread || 0), 0);
  const base = "СвапТайм — Мессенджер";
  document.title = total > 0 ? `(${total}) ${base}` : base;
}

// ============================================================
// 10. СТАТУСЫ
// ============================================================
const STATUS_META = {
  online: { label: "В сети", inline: "в сети", color: "#22c55e", icon: "🟢" },
  idle: { label: "Отошёл", inline: "отошёл", color: "#f59e0b", icon: "🌙" },
  dnd: { label: "Не беспокоить", inline: "не беспокоить", color: "#ef4444", icon: "⛔" },
  invisible: { label: "Невидимка", inline: "не в сети", color: "#6b7280", icon: "⚪" },
  offline: { label: "Не в сети", inline: "не в сети", color: "#52525b", icon: "⚫" },
};

let draftStatus = null;

function statusMeta(status) {
  return STATUS_META[status] || STATUS_META.online;
}

function presenceLabel(user) {
  if (!user) return "";
  if (!user.online) return STATUS_META.offline.inline;
  return statusMeta(user.status).inline;
}

function applyMyStatus() {
  if (!state.user) return;
  const tag = $("my-tag");
  if (tag) {
    const meta = statusMeta(state.user.status || "online");
    tag.textContent = "@" + state.user.username + (state.user.status_text ? " · " + state.user.status_text : "");
    tag.style.color = state.user.status_text ? meta.color : "";
  }
  const profileBtn = document.querySelector(".me-profile");
  if (profileBtn) {
    const meta = statusMeta(state.user.status || "online");
    let dot = profileBtn.querySelector(".me-status-dot");
    if (!dot) {
      dot = el("span", "me-status-dot");
      profileBtn.appendChild(dot);
    }
    dot.style.background = meta.color;
    profileBtn.title = meta.label + (state.user.status_text ? " · " + state.user.status_text : "");
  }
}

function renderStatusRow() {
  const row = $("status-row");
  if (!row) return;
  clear(row);

  const options = state.statuses && state.statuses.length ? state.statuses : ["online", "idle", "dnd", "invisible"];
  draftStatus = state.user && state.user.status ? state.user.status : "online";

  options.forEach((status) => {
    const meta = statusMeta(status);
    const btn = el("button", "status-option" + (status === draftStatus ? " active" : ""));
    btn.type = "button";
    btn.dataset.status = status;
    btn.appendChild(el("span", "status-dot", meta.icon));
    btn.appendChild(el("span", "status-label", meta.label));
    btn.addEventListener("click", () => {
      draftStatus = status;
      row.querySelectorAll(".status-option").forEach((node) => {
        node.classList.toggle("active", node.dataset.status === status);
      });
    });
    row.appendChild(btn);
  });

  const text = $("settings-status-text");
  if (text) text.value = (state.user && state.user.status_text) || "";

  renderNotifySettings();
  renderMuteList();
}

async function savePresenceFromSettings() {
  const status = draftStatus || (state.user && state.user.status) || "online";
  const textInput = $("settings-status-text");
  const statusText = textInput ? textInput.value.trim() : "";
  try {
    const data = await api("/api/presence", { method: "POST", body: { status, status_text: statusText } });
    state.user = { ...state.user, status: data.status, status_text: data.status_text };
    applyMyStatus();
  } catch (err) {
    toast(err.message || "Не удалось сохранить статус", "error");
  }
}

// ============================================================
// НАСТРОЙКИ УВЕДОМЛЕНИЙ И СПИСОК ТИХИХ ЧАТОВ
// ============================================================
function renderNotifySettings() {
  const cfg = notifyConfig();
  const desktop = $("notify-desktop");
  const sound = $("notify-sound");
  const preview = $("notify-preview");
  if (desktop) desktop.checked = cfg.desktop;
  if (sound) sound.checked = cfg.sound;
  if (preview) preview.checked = cfg.preview;
}

function renderMuteList() {
  const list = $("mute-list");
  if (!list) return;
  clear(list);
  const keys = mutedKeys();
  if (!keys.length) {
    list.appendChild(el("div", "loading-small", "Все чаты со звуком 🔔"));
    return;
  }
  keys.forEach((key) => {
    const [scope, id] = key.split(":");
    const name = scope === "channel" ? "#" + id : displayNameFor(id) || id;
    const row = el("div", "mute-row");
    row.appendChild(el("span", "mute-name", name));
    const btn = el("button", "mute-off", "включить");
    btn.type = "button";
    btn.addEventListener("click", () => toggleMute(scope, id));
    row.appendChild(btn);
    list.appendChild(row);
  });
}

// ============================================================
// ИНТЕГРАЦИЯ С ОСТАЛЬНЫМ ИНТЕРФЕЙСОМ
// ============================================================
function onSettingsOpened() {
  renderStatusRow();
}

function syncChatStatusExtra(chat) {
  const status = $("chat-status");
  if (!status) return;
  if (chat && chat.status_text) {
    status.title = chat.status_text;
    if (!status.textContent.includes(chat.status_text)) {
      status.textContent += " · " + chat.status_text;
    }
  } else {
    status.title = "";
  }
}

function onChatOpened(scope, id) {
  closeChatSearch();
  syncChatMuteButton();

  if (scope === "dm") {
    updateTitleBadge();
    const draft = getDraft("dm", id);
    if (draft) {
      const input = $("message-input");
      if (input && !input.value) input.value = draft;
    }
  }

  setTimeout(() => {
    updateJumpButton(scope);
    const box = jumpScopeBox(scope);
    if (box) box.scrollTop = box.scrollHeight;
    updateJumpButton(scope);
  }, 60);
}

// ---------- действия (data-action) ----------
Object.assign(ACTIONS, {
  "open-chat-search": () => openChatSearch("dm"),
  "open-channel-search": () => openChatSearch("channel"),
  "close-chat-search": () => closeChatSearch(),
  "search-prev": () => stepSearch(-1),
  "search-next": () => stepSearch(1),
  "toggle-chat-mute": () => state.current && toggleMute("dm", state.current),
  "toggle-channel-mute": () => state.activeChannel && toggleMute("channel", String(state.activeChannel)),
  "jump-bottom": () => jumpToBottom("dm"),
  "server-jump-bottom": () => jumpToBottom("channel"),
  "toggle-format": () => toggleFormatBar("format-bar"),
  "toggle-server-format": () => toggleFormatBar("server-format-bar"),
  "open-favorites": () => openFavorites(),
  "close-favorites": () => closeFavorites(),
  "clear-favorites": () => clearFavorites(),
  "quick-switch": () => openQuickSwitch(),
  "close-forward": () => closeForward(),
});

function toggleFormatBar(id) {
  const bar = $(id);
  if (!bar) return;
  const visible = bar.style.display !== "none";
  bar.style.display = visible ? "none" : "flex";
}

function bindFeatureEvents() {
  const dmInput = $("message-input");
  const chInput = $("server-input");

  // ---------- черновики ----------
  let draftTimer = null;
  const scheduleDraftPreview = () => {
    clearTimeout(draftTimer);
    draftTimer = setTimeout(() => {
      if (typeof renderDMList === "function") renderDMList();
    }, 700);
  };

  if (dmInput) {
    dmInput.addEventListener("input", () => {
      if (!state.current) return;
      saveDraft("dm", state.current, dmInput.value);
      scheduleDraftPreview();
    });
  }
  if (chInput) {
    chInput.addEventListener("input", () => {
      if (!state.activeChannel) return;
      saveDraft("channel", String(state.activeChannel), chInput.value);
    });
  }

  // ---------- поиск ----------
  const dmSearch = $("chat-search-input");
  if (dmSearch) dmSearch.addEventListener("input", () => runSearch("dm", dmSearch.value));
  const chSearch = $("channel-search-input");
  if (chSearch) chSearch.addEventListener("input", () => runSearch("channel", chSearch.value));

  [dmSearch, chSearch].forEach((input) => {
    if (!input) return;
    input.addEventListener("keydown", (event) => {
      if (event.key === "Enter") {
        event.preventDefault();
        stepSearch(event.shiftKey ? -1 : 1);
      } else if (event.key === "Escape") {
        event.preventDefault();
        closeChatSearch();
      }
    });
  });

  // ---------- форматирование ----------
  document.querySelectorAll(".fmt-btn").forEach((btn) => {
    btn.addEventListener("click", () => {
      const target = btn.dataset.target === "server" ? chInput : dmInput;
      const wrap = FORMAT_WRAP[btn.dataset.format];
      if (target && wrap) wrapSelection(target, wrap[0], wrap[1]);
    });
  });

  // ---------- кнопка «вниз» ----------
  const dmBox = $("messages");
  if (dmBox) dmBox.addEventListener("scroll", () => updateJumpButton("dm"), { passive: true });
  const chBox = $("server-messages");
  if (chBox) chBox.addEventListener("scroll", () => updateJumpButton("channel"), { passive: true });

  // ---------- избранное ----------
  const favSearch = $("favorites-search");
  if (favSearch) favSearch.addEventListener("input", () => renderFavorites());

  // ---------- пересылка ----------
  const fwdSearch = $("forward-search");
  if (fwdSearch) fwdSearch.addEventListener("input", () => renderForwardList());

  // ---------- быстрый переход ----------
  const qsInput = $("quick-switch-input");
  if (qsInput) {
    qsInput.addEventListener("input", () => {
      quickIndex = 0;
      renderQuickList();
    });
    qsInput.addEventListener("keydown", (event) => {
      if (event.key === "ArrowDown") {
        event.preventDefault();
        stepQuick(1);
      } else if (event.key === "ArrowUp") {
        event.preventDefault();
        stepQuick(-1);
      } else if (event.key === "Enter") {
        event.preventDefault();
        runQuickItem();
      } else if (event.key === "Escape") {
        event.preventDefault();
        closeQuickSwitch();
      }
    });
  }

  // ---------- уведомления ----------
  ["notify-desktop", "notify-sound", "notify-preview"].forEach((id) => {
    const node = $(id);
    if (node) node.addEventListener("change", () => saveNotifySettings());
  });

  // ---------- тап по спойлеру / клик мимо пикера ----------
  document.addEventListener("click", (event) => {
    const spoiler = event.target.closest(".rich-spoiler");
    if (spoiler) revealSpoiler(spoiler);
  });

  // ---------- горячие клавиши ----------
  document.addEventListener("keydown", (event) => {
    const mod = event.ctrlKey || event.metaKey;

    if (mod && event.key.toLowerCase() === "k") {
      event.preventDefault();
      if ($("quick-switch").classList.contains("active")) closeQuickSwitch();
      else openQuickSwitch();
      return;
    }

    if (mod && event.key.toLowerCase() === "f" && (state.current || state.activeChannel)) {
      // не мешаем нативному поиску, если фокус в поле ввода
      const tag = (document.activeElement && document.activeElement.tagName) || "";
      if (tag === "INPUT" || tag === "TEXTAREA") return;
      event.preventDefault();
      openChatSearch(state.view === "server" ? "channel" : "dm");
      return;
    }

    if (mod && (event.key.toLowerCase() === "b" || event.key.toLowerCase() === "i")) {
      const active = document.activeElement;
      if (active !== dmInput && active !== chInput) return;
      event.preventDefault();
      wrapSelection(active, event.key.toLowerCase() === "b" ? "**" : "*", event.key.toLowerCase() === "b" ? "**" : "*");
      return;
    }

    if (event.key === "Escape") {
      if ($("quick-switch").classList.contains("active")) closeQuickSwitch();
      else if ($("favorites-modal").classList.contains("active")) closeFavorites();
      else if ($("forward-modal").classList.contains("active")) closeForward();
      else if (searchState.scope) closeChatSearch();
      closeReactionPicker();
    }
  });

  // ---------- черновик из списка чатов обновляем после refresh ----------
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "visible") updateTitleBadge();
  });

  applyMyStatus();
}

if (document.readyState === "loading") {
  document.addEventListener("DOMContentLoaded", bindFeatureEvents);
} else {
  bindFeatureEvents();
}
