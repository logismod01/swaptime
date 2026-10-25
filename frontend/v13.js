// ============================================================
// СВАПТАЙМ — v13: десять новых функций
// ============================================================
// 1. Вложения: фото, голосовые, файлы (личка + каналы серверов)
// 2. Категории каналов (как в Discord)  — см. servers.js
// 3. Реакции на постах Telegram-каналов — см. channels.js
// 4. Глобальный поиск (Ctrl+Shift+F)
// 5. Опросы (как в Telegram/Discord)
// 6. Слэш-команды с подсказками (/spoiler, /me, /shrug, /roll …)
// 7. Папки чатов (как в Telegram)
// 8. Мобильная нижняя панель вкладок
// 9. Онбординг-тур при первом входе
// 10. Статистика сервера (как Discord Insights)
// ============================================================

(function () {
    "use strict";

    const V13 = {
        MAX_IMAGE_SIDE: 1600,
        MAX_ATTACH_BYTES: 1_800_000,
        MAX_VOICE_MS: 10 * 60 * 1000,
    };

    const KEYS = {
        categories: "swaptime_collapsed_categories",
        folders: "swaptime_chat_folders",
        folderActive: "swaptime_chat_folder",
        onboarding: "swaptime_onboarding_done",
        draftPrefix: "swaptime_draft:",
    };

    function store(key, value) {
        try {
            localStorage.setItem(key, JSON.stringify(value));
        } catch (e) { /* приватный режим */ }
    }

    function load(key, fallback) {
        try {
            const raw = localStorage.getItem(key);
            return raw ? JSON.parse(raw) : fallback;
        } catch (e) {
            return fallback;
        }
    }

    function fmtSize(bytes) {
        const n = Number(bytes) || 0;
        if (n < 1024) return n + " Б";
        if (n < 1024 * 1024) return (n / 1024).toFixed(1) + " КБ";
        return (n / 1024 / 1024).toFixed(1) + " МБ";
    }

    function fmtDuration(ms) {
        const total = Math.max(0, Math.round(ms / 1000));
        return Math.floor(total / 60) + ":" + String(total % 60).padStart(2, "0");
    }

    // ============================================================
    // 1. ВЛОЖЕНИЯ
    // ============================================================
    function scopeTarget(scope) {
        if (scope === "channel") {
            if (!state.activeChannel) return null;
            return { scope: "channel", id: state.activeChannel };
        }
        if (!state.current) return null;
        return { scope: "dm", id: state.current };
    }

    function dataUrlBytes(dataUrl) {
        const comma = String(dataUrl || "").indexOf(",");
        const body = comma >= 0 ? dataUrl.slice(comma + 1) : "";
        return Math.floor((body.length * 3) / 4);
    }

    function readAsDataUrl(file) {
        return new Promise((resolve, reject) => {
            const reader = new FileReader();
            reader.onload = () => resolve(String(reader.result || ""));
            reader.onerror = () => reject(new Error("Не удалось прочитать файл"));
            reader.readAsDataURL(file);
        });
    }

    function shrinkImage(file) {
        return new Promise((resolve) => {
            const url = URL.createObjectURL(file);
            const img = new Image();
            img.onload = () => {
                const side = Math.max(img.width, img.height);
                const scale = side > V13.MAX_IMAGE_SIDE ? V13.MAX_IMAGE_SIDE / side : 1;
                const canvas = document.createElement("canvas");
                canvas.width = Math.round(img.width * scale);
                canvas.height = Math.round(img.height * scale);
                const ctx = canvas.getContext("2d");
                ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
                URL.revokeObjectURL(url);
                let data = canvas.toDataURL("image/jpeg", 0.82);
                if (dataUrlBytes(data) > V13.MAX_ATTACH_BYTES) {
                    data = canvas.toDataURL("image/jpeg", 0.6);
                }
                resolve({
                    kind: "image",
                    data,
                    name: file.name || "photo.jpg",
                    size: dataUrlBytes(data),
                    duration: 0,
                });
            };
            img.onerror = () => {
                URL.revokeObjectURL(url);
                resolve(null);
            };
            img.src = url;
        });
    }

    async function fileToAttachment(file) {
        if (!file) return null;
        const isImage = (file.type || "").startsWith("image/");
        if (isImage) {
            const shrunk = await shrinkImage(file);
            if (shrunk) return shrunk;
        }
        if (file.size > V13.MAX_ATTACH_BYTES) {
            toast("Файл больше 1,8 МБ — выбери поменьше", "error");
            return null;
        }
        const data = await readAsDataUrl(file);
        const kind = (file.type || "").startsWith("audio/") ? "audio" : "file";
        return {
            kind,
            data,
            name: file.name || (kind === "audio" ? "voice.webm" : "file"),
            size: file.size || dataUrlBytes(data),
            duration: 0,
        };
    }

    function buildAttachmentNode(msg, scope) {
        const att = msg && msg.attachment;
        if (!att || !att.data) return null;
        const wrap = el("div", "attach-wrap");

        if (att.kind === "image") {
            const btn = el("button", "attach-image");
            btn.type = "button";
            btn.title = "Открыть фото";
            const img = el("img");
            img.src = att.data;
            img.alt = att.name || "фото";
            img.loading = "lazy";
            btn.appendChild(img);
            btn.addEventListener("click", () => openLightbox(att.data, att.name));
            wrap.appendChild(btn);
            return wrap;
        }

        if (att.kind === "audio") {
            const card = el("div", "attach-audio");
            const audio = new Audio(att.data);
            audio.preload = "metadata";

            const playBtn = el("button", "audio-play", "▶");
            playBtn.type = "button";
            playBtn.title = "Прослушать";

            const bars = el("div", "audio-bars");
            const barCount = 28;
            const heights = [];
            for (let i = 0; i < barCount; i++) {
                // псевдо-волна: стабильная для каждого файла
                const seed = (att.data.length + i * 37) % 100;
                const h = 20 + ((seed * 7) % 70);
                heights.push(h);
                const bar = el("span", "audio-bar");
                bar.style.height = h + "%";
                bars.appendChild(bar);
            }

            const time = el("span", "audio-time", fmtDuration((att.duration || 0) * 1000));

            const update = () => {
                const total = audio.duration || att.duration || 0;
                if (total) time.textContent = fmtDuration(audio.currentTime * 1000) + " / " + fmtDuration(total * 1000);
                const progress = total ? audio.currentTime / total : 0;
                bars.querySelectorAll(".audio-bar").forEach((bar, index) => {
                    bar.classList.toggle("played", index / barCount <= progress);
                });
            };

            playBtn.addEventListener("click", () => {
                if (audio.paused) {
                    audio.play().catch(() => toast("Не удалось воспроизвести", "error"));
                } else {
                    audio.pause();
                }
            });
            audio.addEventListener("play", () => { playBtn.textContent = "⏸"; });
            audio.addEventListener("pause", () => { playBtn.textContent = "▶"; });
            audio.addEventListener("ended", () => { playBtn.textContent = "▶"; update(); });
            audio.addEventListener("timeupdate", update);
            audio.addEventListener("loadedmetadata", update);

            card.appendChild(playBtn);
            card.appendChild(bars);
            card.appendChild(time);
            wrap.appendChild(card);
            return wrap;
        }

        const link = el("a", "attach-file");
        link.href = att.data;
        link.download = att.name || "file";
        link.appendChild(el("span", "file-icon", "📄"));
        const meta = el("span", "file-meta");
        meta.appendChild(el("span", "file-name", att.name || "файл"));
        meta.appendChild(el("span", "file-size", fmtSize(att.size)));
        link.appendChild(meta);
        link.appendChild(el("span", "file-download", "⬇"));
        wrap.appendChild(link);
        return wrap;
    }

    function openLightbox(src, name) {
        closeLightbox();
        const overlay = el("div", "v13-lightbox");
        overlay.id = "v13-lightbox";
        const img = el("img", "v13-lightbox-img");
        img.src = src;
        img.alt = name || "фото";
        const close = el("button", "v13-lightbox-close", "✕");
        close.type = "button";
        close.title = "Закрыть";
        close.addEventListener("click", closeLightbox);
        overlay.addEventListener("click", (event) => {
            if (event.target === overlay) closeLightbox();
        });
        overlay.appendChild(img);
        overlay.appendChild(close);
        document.body.appendChild(overlay);
        requestAnimationFrame(() => overlay.classList.add("active"));
    }

    function closeLightbox() {
        const overlay = document.getElementById("v13-lightbox");
        if (overlay) overlay.remove();
    }

    // ---------- отправка личных сообщений с вложениями/опросом ----------
    function sendDirect(payload) {
        if (!state.current) return;
        const text = String(payload.text || "").trim();
        const hasExtra = Boolean(payload.attachment || payload.poll);
        if (!text && !hasExtra) return;

        const clientId = uuid();
        const replyTo = state.replyTo ? state.replyTo.id : 0;
        const replyPreview = state.replyTo
            ? { id: state.replyTo.id, from: state.replyTo.from, text: state.replyTo.text || "", deleted: state.replyTo.deleted || 0 }
            : null;

        const optimistic = {
            id: null,
            client_id: clientId,
            from: state.user.username,
            to: state.current,
            text,
            reply_to: replyTo,
            reply_preview: replyPreview,
            edited: 0,
            deleted: 0,
            created_at: Math.floor(Date.now() / 1000),
            pending: true,
            attachment: payload.attachment || null,
            poll: payload.poll ? normalizePollPreview(payload.poll) : null,
        };

        upsertMessage(optimistic);
        if (typeof updateChatFromMessage === "function") updateChatFromMessage(optimistic);
        if (payload.clearInput !== false) {
            const input = $("message-input");
            if (input) input.value = "";
            if (typeof clearDraft === "function") clearDraft("dm", optimistic.to);
        }
        if (typeof cancelReply === "function") cancelReply();

        const body = {
            type: "message",
            to: optimistic.to,
            text,
            client_id: clientId,
            reply_to: replyTo,
        };
        if (payload.attachment) body.attachment = payload.attachment;
        if (payload.poll) body.poll = payload.poll;

        const sent = sendWS(body);
        if (!sent) {
            toast("Нет связи с сервером — попробуй ещё раз", "error");
        }
    }

    // ---------- отправка в канал сервера ----------
    async function sendToChannel(payload) {
        if (!state.activeServer || !state.activeChannel) return;
        const text = String(payload.text || "").trim();
        if (!text && !payload.attachment && !payload.poll) return;

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
            attachment: payload.attachment || null,
            poll: payload.poll ? normalizePollPreview(payload.poll) : null,
        };
        upsertServerMessage(optimistic);
        if (payload.clearInput !== false) {
            const input = $("server-input");
            if (input) input.value = "";
            if (typeof clearDraft === "function") clearDraft("channel", String(state.activeChannel));
        }

        try {
            const saved = await api(
                `/api/servers/${state.activeServer}/channels/${state.activeChannel}/messages`,
                { method: "POST", body: { text, client_id: clientId, attachment: payload.attachment || null, poll: payload.poll || null } }
            );
            if (saved && saved.id) upsertServerMessage(saved);
        } catch (err) {
            toast(err.message || "Не удалось отправить", "error");
        }
    }

    function sendToScope(scope, payload) {
        if (scope === "channel") return sendToChannel(payload);
        return sendDirect(payload);
    }

    function normalizePollPreview(poll) {
        const options = (poll.options || []).map((o) => String(o));
        return {
            question: String(poll.question || ""),
            options,
            counts: options.map(() => 0),
            total: 0,
            voters: options.map(() => []),
            my_vote: null,
            pending: true,
        };
    }

    // ---------- панель вложений в композере ----------
    function composerFor(scope) {
        return scope === "channel"
            ? document.querySelector("#server-view .chat-input")
            : document.querySelector("#chat-active .chat-input");
    }

    function inputFor(scope) {
        return $(scope === "channel" ? "server-input" : "message-input");
    }

    function buildComposerTools(scope) {
        const footer = composerFor(scope);
        if (!footer || footer.querySelector(".v13-tools")) return;

        const tools = el("div", "v13-tools");

        const fileInput = document.createElement("input");
        fileInput.type = "file";
        fileInput.className = "v13-file-input";
        fileInput.accept = "image/*,audio/*,.pdf,.zip,.txt,.doc,.docx,.xls,.xlsx,.csv";
        fileInput.addEventListener("change", async () => {
            const file = fileInput.files && fileInput.files[0];
            fileInput.value = "";
            if (!file) return;
            const att = await fileToAttachment(file);
            if (!att) return;
            sendToScope(scope, { attachment: att });
        });
        footer.appendChild(fileInput);

        const attachBtn = el("button", "v13-tool", "📎");
        attachBtn.type = "button";
        attachBtn.title = "Прикрепить фото или файл";
        attachBtn.addEventListener("click", () => fileInput.click());
        tools.appendChild(attachBtn);

        const voiceBtn = el("button", "v13-tool", "🎤");
        voiceBtn.type = "button";
        voiceBtn.title = "Голосовое сообщение";
        voiceBtn.addEventListener("click", () => toggleVoiceRecording(scope, voiceBtn));
        tools.appendChild(voiceBtn);

        const pollBtn = el("button", "v13-tool", "📊");
        pollBtn.type = "button";
        pollBtn.title = "Создать опрос";
        pollBtn.addEventListener("click", () => openPollModal(scope));
        tools.appendChild(pollBtn);

        footer.insertBefore(tools, footer.querySelector(".send-btn"));
    }

    // ---------- голосовые ----------
    let voice = null;

    async function toggleVoiceRecording(scope, button) {
        if (voice && voice.scope === scope) {
            stopVoiceRecording(false);
            return;
        }
        if (voice) stopVoiceRecording(true);

        if (!navigator.mediaDevices || !window.MediaRecorder) {
            toast("Браузер не умеет записывать голос", "error");
            return;
        }

        let stream;
        try {
            stream = await navigator.mediaDevices.getUserMedia({ audio: true });
        } catch (err) {
            toast("Нет доступа к микрофону", "error");
            return;
        }

        const chunks = [];
        let recorder;
        try {
            recorder = new MediaRecorder(stream);
        } catch (err) {
            stream.getTracks().forEach((t) => t.stop());
            toast("Запись не поддерживается", "error");
            return;
        }

        const bar = el("div", "v13-voice-bar");
        bar.appendChild(el("span", "v13-voice-dot"));
        const timer = el("span", "v13-voice-timer", "0:00");
        bar.appendChild(timer);
        const hint = el("span", "v13-voice-hint", "Запись… нажми 🎤 чтобы отправить");
        bar.appendChild(hint);
        const cancelBtn = el("button", "v13-voice-cancel", "✕");
        cancelBtn.type = "button";
        cancelBtn.title = "Отменить запись";
        cancelBtn.addEventListener("click", () => stopVoiceRecording(true));
        bar.appendChild(cancelBtn);

        const footer = composerFor(scope);
        footer.parentNode.insertBefore(bar, footer);

        recorder.ondataavailable = (event) => {
            if (event.data && event.data.size) chunks.push(event.data);
        };
        recorder.onstop = async () => {
            stream.getTracks().forEach((t) => t.stop());
            bar.remove();
            if (voice) voice.button.classList.remove("recording");
            const cancelled = voice && voice.cancelled;
            const duration = voice ? Math.min(Date.now() - voice.startedAt, V13.MAX_VOICE_MS) : 0;
            voice = null;
            if (cancelled || !chunks.length) return;

            const blob = new Blob(chunks, { type: chunks[0].type || "audio/webm" });
            if (blob.size > V13.MAX_ATTACH_BYTES) {
                toast("Голосовое слишком длинное", "error");
                return;
            }
            const data = await readAsDataUrl(blob);
            sendToScope(scope, {
                attachment: {
                    kind: "audio",
                    data,
                    name: "voice-" + Date.now() + ".webm",
                    size: blob.size,
                    duration: Math.round(duration / 1000),
                },
            });
        };

        voice = { scope, recorder, startedAt: Date.now(), button, cancelled: false };
        button.classList.add("recording");
        recorder.start();

        const tick = setInterval(() => {
            if (!voice || voice.recorder !== recorder) {
                clearInterval(tick);
                return;
            }
            const elapsed = Date.now() - voice.startedAt;
            timer.textContent = fmtDuration(Math.min(elapsed, V13.MAX_VOICE_MS));
            if (elapsed >= V13.MAX_VOICE_MS) stopVoiceRecording(false);
        }, 250);
    }

    function stopVoiceRecording(cancelled) {
        if (!voice) return;
        voice.cancelled = Boolean(cancelled);
        try {
            voice.recorder.stop();
        } catch (e) { /* уже остановлен */ }
    }

    // ============================================================
    // 5. ОПРОСЫ
    // ============================================================
    function buildPollNode(msg, scope) {
        const poll = msg && msg.poll;
        if (!poll || !poll.options || !poll.options.length) return null;

        const card = el("div", "poll-card");
        card.dataset.pollFor = String(msg.id || "");
        card.appendChild(el("div", "poll-question", poll.question || "Опрос"));

        const counts = poll.counts || [];
        const total = poll.total || counts.reduce((a, b) => a + b, 0);
        const myVote = typeof poll.my_vote === "number" ? poll.my_vote : computeMyVote(poll);

        poll.options.forEach((option, index) => {
            const row = el("button", "poll-option" + (myVote === index ? " mine" : ""));
            row.type = "button";
            row.disabled = msg.pending || !msg.id;
            const share = total ? Math.round(((counts[index] || 0) / total) * 100) : 0;
            const fill = el("span", "poll-fill");
            fill.style.width = share + "%";
            row.appendChild(fill);
            row.appendChild(el("span", "poll-option-text", option));
            row.appendChild(el("span", "poll-option-count", String(counts[index] || 0)));
            row.addEventListener("click", () => votePoll(msg, scope, index));
            card.appendChild(row);
        });

        const footer = el("div", "poll-footer");
        footer.appendChild(el("span", "poll-total", total ? total + " голосов" : "Пока никто не голосовал"));
        if (myVote !== null && myVote !== undefined) {
            footer.appendChild(el("span", "poll-mine", "✓ твой голос"));
        }
        card.appendChild(footer);
        return card;
    }

    function computeMyVote(poll) {
        if (!poll || !Array.isArray(poll.voters)) return null;
        const me = state.user && state.user.username;
        for (let i = 0; i < poll.voters.length; i++) {
            if (Array.isArray(poll.voters[i]) && poll.voters[i].includes(me)) return i;
        }
        return null;
    }

    async function votePoll(msg, scope, index) {
        if (!msg.id) return;
        try {
            const data = await api("/api/polls/vote", {
                method: "POST",
                body: { scope: scope === "channel" ? "channel" : "dm", message_id: msg.id, option: index },
            });
            msg.poll = data.poll;
            refreshPollNode(msg, scope);
        } catch (err) {
            toast(err.message || "Не удалось проголосовать", "error");
        }
    }

    function refreshPollNode(msg, scope) {
        if (!msg.id) return;
        const selector = scope === "channel"
            ? `#server-messages [data-server-msg-id="${msg.id}"]`
            : `#messages [data-msg-id="${msg.id}"]`;
        const wrapper = document.querySelector(selector);
        if (!wrapper) return;
        const old = wrapper.querySelector(".poll-card");
        const fresh = buildPollNode(msg, scope);
        if (old && fresh) old.replaceWith(fresh);
        else if (old && !fresh) old.remove();
        else if (fresh) {
            const target = wrapper.querySelector(".message-text");
            if (target) target.insertAdjacentElement("afterend", fresh);
        }
    }

    function applyPollUpdate(payload) {
        if (!payload || !payload.message_id) return;
        const id = payload.message_id;
        if (payload.scope === "channel") {
            if (typeof serverMessages !== "undefined" && Array.isArray(serverMessages)) {
                const found = serverMessages.find((m) => m.id === id);
                if (found) {
                    found.poll = payload.poll;
                    refreshPollNode(found, "channel");
                }
            }
        } else {
            const msg = state.messages.get(id);
            if (msg) {
                msg.poll = payload.poll;
                refreshPollNode(msg, "dm");
            }
        }
    }

    function openPollModal(scope) {
        closePollModal();
        const overlay = el("div", "modal-overlay active");
        overlay.id = "v13-poll-modal";
        const box = el("div", "modal-box poll-modal-box");
        box.appendChild(el("h3", null, "📊 Новый опрос"));
        box.appendChild(el("p", "modal-hint", "Вопрос и от 2 до 6 вариантов ответа."));

        const question = document.createElement("input");
        question.type = "text";
        question.placeholder = "Вопрос";
        question.maxLength = 200;
        question.id = "v13-poll-question";
        box.appendChild(question);

        const optionsBox = el("div", "poll-options-inputs");
        box.appendChild(optionsBox);

        const addOption = () => {
            if (optionsBox.querySelectorAll("input").length >= 6) return;
            const input = document.createElement("input");
            input.type = "text";
            input.placeholder = "Вариант " + (optionsBox.querySelectorAll("input").length + 1);
            input.maxLength = 80;
            input.className = "v13-poll-option";
            optionsBox.appendChild(input);
        };
        addOption();
        addOption();
        const addBtn = el("button", "modal-btn secondary", "＋ Вариант");
        addBtn.type = "button";
        addBtn.addEventListener("click", addOption);
        box.appendChild(addBtn);

        const error = el("div", "modal-error");
        box.appendChild(error);

        const actions = el("div", "modal-actions");
        const cancel = el("button", "modal-btn secondary", "Отмена");
        cancel.type = "button";
        cancel.addEventListener("click", closePollModal);
        const submit = el("button", "modal-btn primary", "Создать опрос");
        submit.type = "button";
        submit.addEventListener("click", () => {
            const q = question.value.trim();
            const options = Array.from(optionsBox.querySelectorAll("input"))
                .map((i) => i.value.trim())
                .filter(Boolean);
            if (q.length < 3) {
                error.textContent = "Напиши вопрос";
                return;
            }
            if (options.length < 2) {
                error.textContent = "Нужно минимум два варианта";
                return;
            }
            closePollModal();
            sendToScope(scope, { poll: { question: q, options } });
        });
        actions.appendChild(cancel);
        actions.appendChild(submit);
        box.appendChild(actions);

        overlay.appendChild(box);
        overlay.addEventListener("click", (event) => {
            if (event.target === overlay) closePollModal();
        });
        document.body.appendChild(overlay);
        setTimeout(() => question.focus(), 50);
    }

    function closePollModal() {
        const modal = document.getElementById("v13-poll-modal");
        if (modal) modal.remove();
    }

    // ============================================================
    // 6. СЛЭШ-КОМАНДЫ
    // ============================================================
    const SLASH_COMMANDS = [
        { cmd: "/spoiler", hint: "скрытый текст", run: (arg) => (arg ? "||" + arg + "||" : "||текст||") },
        { cmd: "/me", hint: "действие от третьего лица", run: (arg) => "*" + (arg || "что-то делает") + "*" },
        { cmd: "/shrug", hint: "¯\\_(ツ)_/¯", run: (arg) => (arg ? arg + " " : "") + "¯\\_(ツ)_/¯" },
        { cmd: "/tableflip", hint: "(╯°□°)╯︵ ┻━┻", run: (arg) => (arg ? arg + " " : "") + "(╯°□°)╯︵ ┻━┻" },
        { cmd: "/unflip", hint: "┬─┬ノ( º _ ºノ)", run: () => "┬─┬ノ( º _ ºノ)" },
        { cmd: "/roll", hint: "кубик: /roll 1-100", run: (arg) => rollDice(arg) },
        { cmd: "/poll", hint: "создать опрос", run: null },
        { cmd: "/shrugs", hint: "¯\\_(ツ)_/¯", run: (arg) => (arg ? arg + " " : "") + "¯\\_(ツ)_/¯" },
    ];

    function rollDice(arg) {
        const match = String(arg || "").match(/^(\d+)\s*-\s*(\d+)$/);
        let min = 1;
        let max = 100;
        if (match) {
            min = parseInt(match[1], 10);
            max = parseInt(match[2], 10);
            if (min > max) [min, max] = [max, min];
        }
        const value = Math.floor(Math.random() * (max - min + 1)) + min;
        return "🎲 " + value + " (из " + min + "–" + max + ")";
    }

    let slashBox = null;
    let slashIndex = 0;
    let slashItems = [];

    function slashMenuFor(input) {
        if (!slashBox) {
            slashBox = el("div", "slash-menu");
            slashBox.id = "slash-menu";
            document.body.appendChild(slashBox);
            slashBox.addEventListener("mousedown", (event) => {
                const item = event.target.closest("[data-slash]");
                if (item) {
                    event.preventDefault();
                    applySlash(item.dataset.slash, input);
                }
            });
        }
        return slashBox;
    }

    function updateSlashMenu(scope) {
        const input = inputFor(scope);
        if (!input) return;
        const value = input.value;
        if (!value.startsWith("/") || value.includes("\n")) {
            hideSlashMenu();
            return;
        }
        const query = value.slice(1).split(/\s/)[0].toLowerCase();
        slashItems = SLASH_COMMANDS.filter((c) => c.cmd.slice(1).startsWith(query));
        if (!slashItems.length) {
            hideSlashMenu();
            return;
        }
        slashIndex = Math.min(slashIndex, slashItems.length - 1);
        const menu = slashMenuFor(input);
        clear(menu);
        slashItems.forEach((item, index) => {
            const row = el("button", "slash-item" + (index === slashIndex ? " active" : ""));
            row.type = "button";
            row.dataset.slash = item.cmd;
            row.appendChild(el("span", "slash-cmd", item.cmd));
            row.appendChild(el("span", "slash-hint", item.hint));
            menu.appendChild(row);
        });

        const rect = input.getBoundingClientRect();
        menu.style.left = Math.round(rect.left) + "px";
        menu.style.width = Math.round(Math.min(420, rect.width)) + "px";
        menu.style.top = Math.round(rect.top - menu.offsetHeight - 10) + "px";
        menu.classList.add("active");
    }

    function hideSlashMenu() {
        if (slashBox) slashBox.classList.remove("active");
        slashItems = [];
        slashIndex = 0;
    }

    function applySlash(cmd, input) {
        if (!input) return;
        const item = SLASH_COMMANDS.find((c) => c.cmd === cmd);
        const rest = input.value.replace(/^\/\S*\s?/, "");
        hideSlashMenu();
        if (!item) return;

        if (cmd === "/poll") {
            input.value = "";
            openPollModal(state.view === "server" ? "channel" : "dm");
            return;
        }
        input.value = item.run(rest);
        input.focus();
        input.selectionStart = input.value.length;
        input.selectionEnd = input.value.length;
    }

    /** Превращает «/команда текст» в готовый текст (или открывает опрос). */
    function applySlashText(value, scope) {
        const raw = String(value || "");
        if (!raw.startsWith("/")) return raw;
        const cmd = raw.split(/\s/)[0].toLowerCase();
        const match = SLASH_COMMANDS.find((c) => c.cmd === cmd);
        if (!match) return raw;

        if (cmd === "/poll") {
            const input = inputFor(scope);
            if (input) input.value = "";
            hideSlashMenu();
            openPollModal(scope);
            return "";
        }
        hideSlashMenu();
        return match.run(raw.slice(cmd.length).trim());
    }

    function handleSlashKey(event, scope) {
        const input = inputFor(scope);
        if (event.target !== input) return false;
        if (slashBox && slashBox.classList.contains("active") && slashItems.length) {
            if (event.key === "ArrowDown") {
                event.preventDefault();
                slashIndex = (slashIndex + 1) % slashItems.length;
                updateSlashMenu(scope);
                return true;
            }
            if (event.key === "ArrowUp") {
                event.preventDefault();
                slashIndex = (slashIndex - 1 + slashItems.length) % slashItems.length;
                updateSlashMenu(scope);
                return true;
            }
            if (event.key === "Tab") {
                event.preventDefault();
                applySlash(slashItems[slashIndex].cmd, input);
                return true;
            }
            if (event.key === "Escape") {
                hideSlashMenu();
                return false;
            }
        }
        return false;
    }

    // ============================================================
    // 4. ГЛОБАЛЬНЫЙ ПОИСК
    // ============================================================
    let globalSearchTimer = null;

    function openGlobalSearch(prefill) {
        closeGlobalSearch();
        const overlay = el("div", "v13-search-overlay active");
        overlay.id = "v13-global-search";
        const box = el("div", "v13-search-box");

        const head = el("div", "v13-search-head");
        head.appendChild(el("span", "v13-search-icon", "🔎"));
        const input = document.createElement("input");
        input.type = "search";
        input.id = "v13-global-input";
        input.placeholder = "Поиск по людям, чатам, каналам и постам…";
        input.autocomplete = "off";
        head.appendChild(input);
        const close = el("button", "v13-search-close", "✕");
        close.type = "button";
        close.title = "Закрыть (Esc)";
        close.addEventListener("click", closeGlobalSearch);
        head.appendChild(close);
        box.appendChild(head);

        const results = el("div", "v13-search-results");
        results.id = "v13-global-results";
        results.appendChild(el("div", "v13-search-empty", "Начни вводить — минимум 2 символа"));
        box.appendChild(results);

        overlay.appendChild(box);
        overlay.addEventListener("click", (event) => {
            if (event.target === overlay) closeGlobalSearch();
        });
        document.body.appendChild(overlay);

        if (prefill) input.value = prefill;
        input.addEventListener("input", () => {
            clearTimeout(globalSearchTimer);
            globalSearchTimer = setTimeout(() => runGlobalSearch(input.value), 220);
        });
        input.addEventListener("keydown", (event) => {
            if (event.key === "Escape") closeGlobalSearch();
        });
        setTimeout(() => input.focus(), 40);
        if (prefill && prefill.length >= 2) runGlobalSearch(prefill);
    }

    function closeGlobalSearch() {
        const overlay = document.getElementById("v13-global-search");
        if (overlay) overlay.remove();
    }

    async function runGlobalSearch(query) {
        const box = document.getElementById("v13-global-results");
        if (!box) return;
        const q = String(query || "").trim();
        if (q.length < 2) {
            clear(box);
            box.appendChild(el("div", "v13-search-empty", "Начни вводить — минимум 2 символа"));
            return;
        }
        clear(box);
        box.appendChild(el("div", "v13-search-empty", "Ищу…"));
        try {
            const data = await api("/api/search/global?q=" + encodeURIComponent(q));
            if (!document.getElementById("v13-global-results")) return;
            renderGlobalResults(box, data);
        } catch (err) {
            clear(box);
            box.appendChild(el("div", "v13-search-empty", err.message || "Поиск не удался"));
        }
    }

    function renderGlobalResults(box, data) {
        clear(box);
        const groups = [
            ["people", "Люди", data.people || []],
            ["dms", "Личные сообщения", data.dms || []],
            ["channels", "Каналы серверов", data.channels || []],
            ["posts", "Посты каналов", data.posts || []],
        ];
        let shown = 0;

        groups.forEach(([kind, title, items]) => {
            if (!items.length) return;
            shown += items.length;
            box.appendChild(el("div", "v13-search-group", title + " · " + items.length));
            items.forEach((item) => {
                const row = el("button", "v13-search-item");
                row.type = "button";
                if (kind === "people") {
                    const av = el("span", "v13-search-av", (item.display_name || item.username || "?").charAt(0).toUpperCase());
                    av.style.background = item.avatar_color || "#6366f1";
                    row.appendChild(av);
                    const info = el("span", "v13-search-text");
                    info.appendChild(el("span", "v13-search-title", item.display_name || item.username));
                    info.appendChild(el("span", "v13-search-sub", "@" + item.username + (item.friend ? " · друг" : " · не в друзьях")));
                    row.appendChild(info);
                    row.addEventListener("click", () => {
                        closeGlobalSearch();
                        if (item.friend) openChat(item.username);
                        else toast("Сначала добавь @" + item.username + " в друзья", "info");
                    });
                } else if (kind === "dms") {
                    const info = el("span", "v13-search-text");
                    info.appendChild(el("span", "v13-search-title", "@" + item.peer));
                    info.appendChild(el("span", "v13-search-sub", item.text));
                    row.appendChild(info);
                    row.addEventListener("click", () => {
                        closeGlobalSearch();
                        jumpToDm(item.peer, item.message_id);
                    });
                } else if (kind === "channels") {
                    const info = el("span", "v13-search-text");
                    info.appendChild(el("span", "v13-search-title", "#" + item.channel_name + " · " + item.server_name));
                    info.appendChild(el("span", "v13-search-sub", "@" + item.from + ": " + item.text));
                    row.appendChild(info);
                    row.addEventListener("click", () => {
                        closeGlobalSearch();
                        jumpToChannel(item.server_id, item.channel_id, item.message_id);
                    });
                } else {
                    const info = el("span", "v13-search-text");
                    info.appendChild(el("span", "v13-search-title", "📣 " + item.channel_name));
                    info.appendChild(el("span", "v13-search-sub", item.text));
                    row.appendChild(info);
                    row.addEventListener("click", () => {
                        closeGlobalSearch();
                        if (typeof openTgChannel === "function") openTgChannel(item.channel_id);
                    });
                }
                box.appendChild(row);
            });
        });

        if (!shown) box.appendChild(el("div", "v13-search-empty", "Ничего не нашлось"));
    }

    async function jumpToDm(peer, messageId) {
        if (typeof openChat === "function") openChat(peer);
        setTimeout(() => {
            if (typeof focusMessage === "function") focusMessage(messageId);
        }, 700);
    }

    async function jumpToChannel(serverId, channelId, messageId) {
        try {
            if (typeof openServer === "function" && state.activeServer !== serverId) {
                await openServer(serverId);
            }
            if (typeof openServerChannel === "function") await openServerChannel(channelId);
            setTimeout(() => {
                if (typeof focusServerMessage === "function") focusServerMessage(messageId);
            }, 600);
        } catch (err) {
            toast(err.message || "Не удалось открыть канал", "error");
        }
    }

    // ============================================================
    // 7. ПАПКИ ЧАТОВ
    // ============================================================
    const DEFAULT_FOLDERS = [
        { id: "all", name: "Все", icon: "💬", filter: "all" },
        { id: "unread", name: "Непрочитанные", icon: "🔴", filter: "unread" },
        { id: "dm", name: "Личные", icon: "👤", filter: "dm" },
        { id: "servers", name: "Серверы", icon: "🏰", filter: "servers" },
        { id: "channels", name: "Каналы", icon: "📣", filter: "channels" },
    ];

    let activeFolder = load(KEYS.folderActive, "all");
    let customFolders = load(KEYS.folders, []);

    function allFolders() {
        return DEFAULT_FOLDERS.concat(customFolders);
    }

    function currentFolder() {
        return allFolders().find((f) => f.id === activeFolder) || DEFAULT_FOLDERS[0];
    }

    function buildFolderTabs() {
        const host = document.querySelector("#home-sidebar .sidebar-scroll");
        if (!host || document.getElementById("v13-folder-tabs")) return;

        const bar = el("div", "v13-folders");
        bar.id = "v13-folder-tabs";
        allFolders().forEach((folder) => {
            const tab = el("button", "v13-folder" + (folder.id === activeFolder ? " active" : ""));
            tab.type = "button";
            tab.dataset.folder = folder.id;
            tab.appendChild(el("span", "v13-folder-icon", folder.icon || "📁"));
            tab.appendChild(el("span", "v13-folder-name", folder.name));
            if (folder.filter === "unread") {
                const badge = el("span", "v13-folder-badge");
                const total = (state.chats || []).reduce((sum, c) => sum + (c.unread || 0), 0);
                if (total) badge.textContent = total > 99 ? "99+" : String(total);
                tab.appendChild(badge);
            }
            tab.addEventListener("click", () => setFolder(folder.id));
            bar.appendChild(tab);
        });

        const add = el("button", "v13-folder v13-folder-add", "＋");
        add.type = "button";
        add.title = "Своя папка";
        add.addEventListener("click", createCustomFolder);
        bar.appendChild(add);

        host.insertBefore(bar, host.firstChild);
    }

    function setFolder(id) {
        activeFolder = id;
        store(KEYS.folderActive, id);
        const folder = currentFolder();

        document.querySelectorAll("#v13-folder-tabs .v13-folder").forEach((tab) => {
            tab.classList.toggle("active", tab.dataset.folder === id);
        });

        if (folder.filter === "servers") {
            if (typeof setView === "function") setView("server");
            renderServersFolder();
            return;
        }
        if (folder.filter === "channels") {
            if (typeof setView === "function") setView("tg");
            return;
        }
        if (typeof setView === "function") setView("chats");
        if (typeof renderDMList === "function") renderDMList();

        const serversBox = document.getElementById("v13-servers-folder");
        if (serversBox) serversBox.remove();
    }

    function renderServersFolder() {
        const host = document.querySelector("#home-sidebar .sidebar-scroll");
        if (!host) return;
        let box = document.getElementById("v13-servers-folder");
        if (!box) {
            box = el("div", "v13-servers-folder");
            box.id = "v13-servers-folder";
            const chatsView = document.getElementById("chats-view");
            host.insertBefore(box, chatsView ? chatsView.nextSibling : null);
        }
        clear(box);
        const servers = state.servers || [];
        if (!servers.length) {
            box.appendChild(el("div", "loading-small", "Серверов пока нет — создай первый"));
            return;
        }
        servers.forEach((server) => {
            const row = el("button", "v13-server-row");
            row.type = "button";
            const icon = el("span", "v13-server-icon", (server.name || "?").charAt(0).toUpperCase());
            icon.style.background = server.icon_color || "#6366f1";
            row.appendChild(icon);
            row.appendChild(el("span", "v13-server-name", server.name || "сервер"));
            if (server.unread) row.appendChild(el("span", "channel-unread", String(server.unread)));
            row.addEventListener("click", () => {
                if (typeof openServer === "function") openServer(server.id);
            });
            box.appendChild(row);
        });
    }

    function createCustomFolder() {
        const name = prompt("Название папки:");
        if (!name || !name.trim()) return;
        const filter = prompt("Что показывать: all / unread / dm / servers / channels", "unread");
        if (!filter) return;
        const allowed = ["all", "unread", "dm", "servers", "channels"];
        if (!allowed.includes(filter)) {
            toast("Фильтр должен быть одним из: " + allowed.join(", "), "error");
            return;
        }
        const folder = {
            id: "custom-" + Date.now(),
            name: name.trim().slice(0, 20),
            icon: "📁",
            filter,
            custom: true,
        };
        customFolders.push(folder);
        store(KEYS.folders, customFolders);
        const bar = document.getElementById("v13-folder-tabs");
        if (bar) bar.remove();
        buildFolderTabs();
        setFolder(folder.id);
    }

    // фильтрация списка чатов по активной папке (вызывается из renderDMList)
    function filterDmList(listEl) {
        if (!listEl) return;
        const folder = currentFolder();
        const filter = folder ? folder.filter : "all";
        let visible = 0;

        Array.from(listEl.children).forEach((row) => {
            if (!row.classList.contains("user-item")) {
                row.style.display = "";
                return;
            }
            const badge = row.querySelector(".unread-badge");
            const unread = Number(row.dataset.unread || (badge ? badge.textContent.replace("+", "") : 0)) || 0;
            row.dataset.unread = String(unread);
            let show = true;
            if (filter === "unread") show = unread > 0;
            else if (filter === "servers" || filter === "channels") show = false;
            row.style.display = show ? "" : "none";
            if (show) visible += 1;
        });

        const empty = listEl.querySelector(".v13-folder-empty");
        if (!visible && filter === "unread") {
            if (!empty) {
                const node = el("div", "loading-small v13-folder-empty", "Нет непрочитанных — красота!");
                listEl.appendChild(node);
            }
        } else if (empty) {
            empty.remove();
        }
    }

    // ============================================================
    // 8. МОБИЛЬНАЯ ПАНЕЛЬ ВКЛАДОК
    // ============================================================
    function buildMobileTabs() {
        if (document.getElementById("v13-mobile-tabs")) return;
        const nav = el("nav", "v13-mobile-tabs");
        nav.id = "v13-mobile-tabs";

        const tabs = [
            { view: "chats", icon: "💬", label: "Чаты", badge: "rail-unread" },
            { view: "tg", icon: "📣", label: "Каналы", badge: "rail-tg" },
            { view: "server", icon: "🏰", label: "Серверы", badge: null },
            { view: "friends", icon: "👥", label: "Друзья", badge: "rail-requests" },
            { action: "settings", icon: "⚙", label: "Ещё", badge: null },
        ];

        tabs.forEach((tab) => {
            const btn = el("button", "v13-tab");
            btn.type = "button";
            btn.appendChild(el("span", "v13-tab-icon", tab.icon));
            btn.appendChild(el("span", "v13-tab-label", tab.label));
            if (tab.badge) {
                const badge = el("span", "v13-tab-badge");
                badge.dataset.badgeSource = tab.badge;
                badge.hidden = true;
                btn.appendChild(badge);
            }
            btn.addEventListener("click", () => {
                if (tab.action === "settings") {
                    const openSettings = document.querySelector('[data-action="open-settings"]');
                    if (openSettings) openSettings.click();
                    return;
                }
                if (tab.view === "server") {
                    const servers = state.servers || [];
                    if (servers.length) {
                        setFolder("servers");
                        if (typeof openServer === "function") openServer(servers[0].id);
                    } else {
                        toast("Серверов пока нет", "info");
                    }
                    return;
                }
                setFolder(tab.view === "tg" ? "channels" : tab.view === "friends" ? "all" : "all");
                if (typeof setView === "function") setView(tab.view);
                syncMobileTabs();
            });
            nav.appendChild(btn);
        });

        document.body.appendChild(nav);
    }

    function syncMobileTabs() {
        const nav = document.getElementById("v13-mobile-tabs");
        if (!nav) return;
        const order = ["chats", "tg", "server", "friends"];
        const buttons = nav.querySelectorAll(".v13-tab");
        buttons.forEach((btn, index) => {
            const view = order[index] || "settings";
            btn.classList.toggle("active", state.view === view && !(view === "chats" && document.body.classList.contains("chat-open")));
            const badge = btn.querySelector(".v13-tab-badge");
            if (!badge) return;
            const source = document.getElementById(badge.dataset.badgeSource);
            if (source && !source.hidden && source.textContent.trim()) {
                badge.textContent = source.textContent.trim();
                badge.hidden = false;
            } else {
                badge.hidden = true;
            }
        });
    }

    // ============================================================
    // 9. ОНБОРДИНГ
    // ============================================================
    const TOUR_STEPS = [
        {
            target: ".rail",
            title: "Рейл — как в Discord",
            text: "Слева переключаются личные чаты, друзья, каналы и серверы. Красные точки — непрочитанное.",
        },
        {
            target: "#home-sidebar",
            title: "Список чатов и папки",
            text: "Сверху папки: все, непрочитанные, личные, серверы, каналы. Можно добавить свою папку.",
        },
        {
            target: "#chat-active .chat-input",
            title: "Всё в одном поле",
            text: "📎 — фото и файлы, 🎤 — голосовое, 📊 — опрос. Начни с «/» — подскажем команды.",
        },
        {
            target: ".rail-bottom",
            title: "Избранное и поиск",
            text: "🔖 — сохранённые сообщения, ⌕ — глобальный поиск (Ctrl+Shift+F), ⚙ — настройки.",
        },
    ];

    let tourIndex = 0;

    function startTour(force) {
        if (!force && localStorage.getItem(KEYS.onboarding) === "1") return;
        if (!document.getElementById("chat-screen").classList.contains("active")) return;
        tourIndex = 0;
        renderTourStep();
    }

    function renderTourStep() {
        closeTour();
        const step = TOUR_STEPS[tourIndex];
        if (!step) {
            finishTour();
            return;
        }

        const target = document.querySelector(step.target);
        const overlay = el("div", "v13-tour");
        overlay.id = "v13-tour";
        overlay.addEventListener("click", (event) => {
            if (event.target === overlay) closeTour();
        });

        if (target) {
            const rect = target.getBoundingClientRect();
            const spot = el("div", "v13-tour-spot");
            spot.style.left = Math.max(0, rect.left - 6) + "px";
            spot.style.top = Math.max(0, rect.top - 6) + "px";
            spot.style.width = rect.width + 12 + "px";
            spot.style.height = rect.height + 12 + "px";
            overlay.appendChild(spot);
        }

        const card = el("div", "v13-tour-card");
        card.appendChild(el("div", "v13-tour-step", "Шаг " + (tourIndex + 1) + " из " + TOUR_STEPS.length));
        card.appendChild(el("h3", null, step.title));
        card.appendChild(el("p", null, step.text));

        const actions = el("div", "v13-tour-actions");
        const skip = el("button", "modal-btn secondary", "Пропустить");
        skip.type = "button";
        skip.addEventListener("click", () => {
            localStorage.setItem(KEYS.onboarding, "1");
            closeTour();
        });
        const next = el("button", "modal-btn primary", tourIndex === TOUR_STEPS.length - 1 ? "Готово" : "Далее");
        next.type = "button";
        next.addEventListener("click", () => {
            tourIndex += 1;
            if (tourIndex >= TOUR_STEPS.length) {
                localStorage.setItem(KEYS.onboarding, "1");
                closeTour();
            } else {
                renderTourStep();
            }
        });
        actions.appendChild(skip);
        actions.appendChild(next);
        card.appendChild(actions);

        overlay.appendChild(card);
        document.body.appendChild(overlay);
        positionTourCard(card, target);
    }

    function positionTourCard(card, target) {
        const vw = window.innerWidth;
        const vh = window.innerHeight;
        card.style.maxWidth = Math.min(360, vw - 32) + "px";
        if (!target) {
            card.style.left = "50%";
            card.style.top = "50%";
            card.style.transform = "translate(-50%, -50%)";
            return;
        }
        const rect = target.getBoundingClientRect();
        const width = Math.min(360, vw - 32);
        let left = rect.right + 16;
        if (left + width > vw - 16) left = Math.max(16, rect.left - width - 16);
        let top = Math.min(Math.max(16, rect.top), Math.max(16, vh - 260));
        card.style.left = Math.round(left) + "px";
        card.style.top = Math.round(top) + "px";
        card.style.transform = "none";
    }

    function closeTour() {
        const overlay = document.getElementById("v13-tour");
        if (overlay) overlay.remove();
    }

    function finishTour() {
        localStorage.setItem(KEYS.onboarding, "1");
        closeTour();
    }

    // ============================================================
    // 10. СТАТИСТИКА СЕРВЕРА
    // ============================================================
    async function openServerStats() {
        if (!state.activeServer) {
            toast("Сначала открой сервер", "info");
            return;
        }
        try {
            const data = await api(`/api/servers/${state.activeServer}/stats?days=7`);
            renderServerStats(data);
        } catch (err) {
            toast(err.message || "Не удалось получить статистику", "error");
        }
    }

    function renderServerStats(data) {
        const existing = document.getElementById("v13-stats-modal");
        if (existing) existing.remove();

        const overlay = el("div", "modal-overlay active");
        overlay.id = "v13-stats-modal";
        const box = el("div", "modal-box v13-stats-box");

        const head = el("div", "v13-stats-head");
        head.appendChild(el("h3", null, "📊 Статистика · " + (data.server ? data.server.name : "сервер")));
        const close = el("button", "v13-stats-close", "✕");
        close.type = "button";
        close.title = "Закрыть";
        close.addEventListener("click", () => overlay.remove());
        head.appendChild(close);
        box.appendChild(head);

        const cards = el("div", "v13-stats-cards");
        const addCard = (label, value) => {
            const card = el("div", "v13-stat-card");
            card.appendChild(el("div", "v13-stat-value", String(value)));
            card.appendChild(el("div", "v13-stat-label", label));
            cards.appendChild(card);
        };
        addCard("сообщений за 7 дней", data.period_messages || 0);
        addCard("всего сообщений", data.total_messages || 0);
        addCard("участников", data.total_members || 0);
        box.appendChild(cards);

        const chart = el("div", "v13-chart");
        const maxDay = Math.max(1, ...(data.by_day || []).map((d) => d.count));
        (data.by_day || []).forEach((day) => {
            const col = el("div", "v13-chart-col");
            col.title = day.label + ": " + day.count;
            const bar = el("div", "v13-chart-bar");
            bar.style.height = Math.max(3, Math.round((day.count / maxDay) * 90)) + "px";
            col.appendChild(bar);
            col.appendChild(el("span", "v13-chart-label", day.label));
            chart.appendChild(col);
        });
        box.appendChild(chart);

        box.appendChild(el("div", "v13-stats-sub", "Самые активные участники"));
        const members = el("div", "v13-stats-rows");
        const maxMember = Math.max(1, ...(data.members || []).map((m) => m.count));
        (data.members || []).forEach((m) => {
            const row = el("div", "v13-stat-row");
            row.appendChild(el("span", "v13-stat-name", m.display_name || m.username));
            const track = el("span", "v13-stat-track");
            const fill = el("span", "v13-stat-fill");
            fill.style.width = Math.round((m.count / maxMember) * 100) + "%";
            track.appendChild(fill);
            row.appendChild(track);
            row.appendChild(el("span", "v13-stat-count", String(m.count)));
            members.appendChild(row);
        });
        if (!(data.members || []).length) members.appendChild(el("div", "loading-small", "Пока тихо"));
        box.appendChild(members);

        box.appendChild(el("div", "v13-stats-sub", "По каналам"));
        const channels = el("div", "v13-stats-rows");
        (data.channels || []).forEach((c) => {
            const row = el("div", "v13-stat-row");
            row.appendChild(el("span", "v13-stat-name", "#" + c.name));
            const track = el("span", "v13-stat-track");
            const fill = el("span", "v13-stat-fill");
            const maxCh = Math.max(1, ...(data.channels || []).map((x) => x.count));
            fill.style.width = Math.round((c.count / maxCh) * 100) + "%";
            track.appendChild(fill);
            row.appendChild(track);
            row.appendChild(el("span", "v13-stat-count", String(c.count)));
            channels.appendChild(row);
        });
        box.appendChild(channels);

        overlay.appendChild(box);
        overlay.addEventListener("click", (event) => {
            if (event.target === overlay) overlay.remove();
        });
        document.body.appendChild(overlay);
    }

    // кнопка статистики в шапке серверного сайдбара
    function addStatsButton() {
        const head = document.getElementById("server-head");
        if (!head || head.querySelector(".v13-stats-btn")) return;
        const btn = el("button", "server-head-btn v13-stats-btn", "📊");
        btn.type = "button";
        btn.title = "Статистика сервера";
        btn.addEventListener("click", openServerStats);
        head.appendChild(btn);
    }

    // ============================================================
    // МОНТАЖ
    // ============================================================
    function installComposers() {
        buildComposerTools("dm");
        buildComposerTools("channel");
    }

    function installSlashListeners() {
        const dmInput = $("message-input");
        const chInput = $("server-input");

        const bind = (input, scope) => {
            if (!input || input.dataset.v13Slash === "1") return;
            input.dataset.v13Slash = "1";
            input.addEventListener("input", () => updateSlashMenu(scope));
            // Enter обрабатывает сам композер (script.js / servers.js) —
            // здесь только навигация по подсказкам, чтобы не отправить дважды
            input.addEventListener("keydown", (event) => {
                if (handleSlashKey(event, scope)) return;
                if (event.key === "Escape") hideSlashMenu();
            });
            input.addEventListener("blur", () => setTimeout(hideSlashMenu, 120));
        };
        bind(dmInput, "dm");
        bind(chInput, "channel");
    }

    function bindHotkeys() {
        document.addEventListener("keydown", (event) => {
            const mod = event.ctrlKey || event.metaKey;
            if (mod && event.shiftKey && event.key.toLowerCase() === "f") {
                event.preventDefault();
                openGlobalSearch();
                return;
            }
            if (event.key === "Escape") {
                if (document.getElementById("v13-global-search")) closeGlobalSearch();
                if (document.getElementById("v13-tour")) closeTour();
                if (document.getElementById("v13-poll-modal")) closePollModal();
                closeLightbox();
            }
        });
    }

    function observeUi() {
        const screen = document.getElementById("chat-screen");
        if (!screen) return;
        const refresh = () => {
            installComposers();
            installSlashListeners();
            buildFolderTabs();
            addStatsButton();
            syncMobileTabs();
            if (state.view === "chats") {
                const list = document.getElementById("users-list");
                if (list) filterDmList(list);
            }
        };
        if ("MutationObserver" in window) {
            const mo = new MutationObserver(() => {
                if (observeUi.timer) return;
                observeUi.timer = setTimeout(() => {
                    observeUi.timer = null;
                    refresh();
                }, 120);
            });
            mo.observe(screen, { attributes: true, subtree: true, attributeFilter: ["class"] });
        }
        setInterval(syncMobileTabs, 2000);
        refresh();
    }

    function boot() {
        if (document.readyState === "loading") return;
        installComposers();
        installSlashListeners();
        bindHotkeys();
        observeUi();
        buildMobileTabs();

        // появляется после входа
        const tick = setInterval(() => {
            const screen = document.getElementById("chat-screen");
            if (screen && screen.classList.contains("active")) {
                installComposers();
                installSlashListeners();
                buildFolderTabs();
                addStatsButton();
                buildMobileTabs();
                clearInterval(tick);
                setTimeout(() => startTour(false), 900);
            }
        }, 400);
    }

    // глобальные хелперы: их вызывают script.js / servers.js / channels.js
    // (проверяя `typeof ... === "function"`), поэтому одного window.V13 мало
    if (typeof window.buildAttachmentNode !== "function") window.buildAttachmentNode = buildAttachmentNode;
    if (typeof window.buildPollNode !== "function") window.buildPollNode = buildPollNode;
    if (typeof window.applyPollUpdate !== "function") window.applyPollUpdate = applyPollUpdate;

    // публичный интерфейс для других модулей
    window.V13 = {
        buildAttachmentNode,
        buildPollNode,
        applyPollUpdate,
        filterDmList,
        openGlobalSearch,
        openServerStats,
        startTour,
        applySlashText,
        collapseKey: KEYS.categories,
        sendDirect,
        sendToChannel,
    };

    if (document.readyState === "loading") {
        document.addEventListener("DOMContentLoaded", boot, { once: true });
    } else {
        boot();
    }
})();
