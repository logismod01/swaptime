// ============================================================
// СВАПТАЙМ — ЗВОНКИ (WebRTC: аудио, видео, шаринг экрана до 4K)
// ============================================================
// Сигналинг идёт через наш WS (/ws), медиа — напрямую P2P.
// ============================================================

const CALL_SETTINGS_KEY = "swaptime_call_settings";

const CALL_DEFAULT_SETTINGS = {
  quality: "1080p",
  fps: 30,
  bitrate: 5000000,
  codec: "auto",
  echo: true,
  noise: true,
  agc: true,
  mirror: false,
  stats: true,
  screen4k: true,
};

const CALL_QUALITY_PRESETS = {
  "480p": { width: 854, height: 480 },
  "720p": { width: 1280, height: 720 },
  "1080p": { width: 1920, height: 1080 },
  "1440p": { width: 2560, height: 1440 },
  "2160p": { width: 3840, height: 2160 },
};

let ICE_SERVERS = [
  { urls: "stun:stun.l.google.com:19302" },
  { urls: "stun:stun1.l.google.com:19302" },
  { urls: "stun:global.stun.twilio.com:3478" },
];

// TURN с сервера (если настроен в окружении) — нужен, когда оба за строгим NAT
async function loadIceServers() {
  try {
    const data = await api("/api/ice");
    if (data && Array.isArray(data.iceServers) && data.iceServers.length) {
      ICE_SERVERS = data.iceServers;
    }
  } catch (err) {
    // остаёмся на STUN — звонок всё равно может установиться
  }
}

const call = {
  active: false,
  callId: null,
  peer: null,          // имя собеседника
  peerData: null,      // карточка для аватарки
  isCaller: false,
  video: false,
  screen: false,
  pc: null,
  videoSender: null,
  localStream: null,
  screenStream: null,
  remoteStream: null,
  pendingCandidates: [],
  pendingIncoming: null,
  micOn: true,
  camOn: false,
  screenOn: false,
  startedAt: 0,
  timer: null,
  statsTimer: null,
  lastStats: null,
  inviteTimeout: null,
  answered: false,
};

// ============================================================
// НАСТРОЙКИ
// ============================================================
function loadCallSettings() {
  let saved = {};
  try {
    saved = JSON.parse(localStorage.getItem(CALL_SETTINGS_KEY) || "{}") || {};
  } catch (err) {
    saved = {};
  }
  state.callSettings = Object.assign({}, CALL_DEFAULT_SETTINGS, saved);
  return state.callSettings;
}

function saveCallSettings() {
  try {
    localStorage.setItem(CALL_SETTINGS_KEY, JSON.stringify(state.callSettings));
  } catch (err) {}
}

function readCallSettingsFromInputs(prefix) {
  const values = {};
  const quality = $(prefix + "quality");
  const fps = $(prefix + "fps");
  const bitrate = $(prefix + "bitrate");
  if (quality) values.quality = quality.value;
  if (fps) values.fps = parseInt(fps.value, 10) || 30;
  if (bitrate) values.bitrate = parseInt(bitrate.value, 10) || 5000000;
  return values;
}

function initCallSettings() {
  loadCallSettings();
  const s = state.callSettings;

  const setValue = (id, value) => {
    const node = $(id);
    if (node) node.value = String(value);
  };
  const setChecked = (id, value) => {
    const node = $(id);
    if (node) node.checked = !!value;
  };

  // панель в настройках профиля
  setValue("call-quality", s.quality);
  setValue("call-fps", s.fps);
  setValue("call-bitrate", s.bitrate);
  setValue("call-codec", s.codec);
  setChecked("call-echo", s.echo);
  setChecked("call-noise", s.noise);
  setChecked("call-agc", s.agc);
  setChecked("call-mirror", s.mirror);
  setChecked("call-stats-toggle", s.stats);

  // панель внутри звонка
  setValue("csp-quality", s.quality);
  setValue("csp-fps", s.fps);
  setValue("csp-bitrate", s.bitrate);
  setChecked("csp-screen4k", s.screen4k);

  const bind = (id, key, kind) => {
    const node = $(id);
    if (!node) return;
    node.addEventListener("change", () => {
      if (kind === "check") state.callSettings[key] = node.checked;
      else if (kind === "int") state.callSettings[key] = parseInt(node.value, 10);
      else state.callSettings[key] = node.value;
      saveCallSettings();
      syncCallSettingsInputs();
      if (call.active) {
        applyBitrateToSenders();
        applyMirror();
      }
    });
  };

  bind("call-quality", "quality", "str");
  bind("call-fps", "fps", "int");
  bind("call-bitrate", "bitrate", "int");
  bind("call-codec", "codec", "str");
  bind("call-echo", "echo", "check");
  bind("call-noise", "noise", "check");
  bind("call-agc", "agc", "check");
  bind("call-mirror", "mirror", "check");
  bind("call-stats-toggle", "stats", "check");
  bind("csp-quality", "quality", "str");
  bind("csp-fps", "fps", "int");
  bind("csp-bitrate", "bitrate", "int");
  bind("csp-screen4k", "screen4k", "check");

  const hint = $("call-support-hint");
  if (hint) {
    const parts = [];
    parts.push(navigator.mediaDevices && navigator.mediaDevices.getUserMedia ? "✅ микрофон и камера" : "⚠️ браузер не даёт доступ к камере");
    parts.push(navigator.mediaDevices && navigator.mediaDevices.getDisplayMedia ? "✅ шаринг экрана" : "⚠️ шаринг экрана недоступен");
    parts.push(window.RTCPeerConnection ? "✅ WebRTC" : "⚠️ нет WebRTC");
    hint.textContent = parts.join(" · ");
  }
}

function syncCallSettingsInputs() {
  const s = state.callSettings;
  const setValue = (id, value) => {
    const node = $(id);
    if (node && node.value !== String(value)) node.value = String(value);
  };
  const setChecked = (id, value) => {
    const node = $(id);
    if (node) node.checked = !!value;
  };
  setValue("call-quality", s.quality);
  setValue("call-fps", s.fps);
  setValue("call-bitrate", s.bitrate);
  setValue("csp-quality", s.quality);
  setValue("csp-fps", s.fps);
  setValue("csp-bitrate", s.bitrate);
  setChecked("csp-screen4k", s.screen4k);
  setChecked("call-mirror", s.mirror);
  setChecked("call-stats-toggle", s.stats);
  if ($("call-stats")) $("call-stats").style.display = call.active && s.stats ? "block" : "none";
}

function applyCallSettings() {
  const values = readCallSettingsFromInputs("csp-");
  if (values.quality) state.callSettings.quality = values.quality;
  if (values.fps) state.callSettings.fps = values.fps;
  if (values.bitrate) state.callSettings.bitrate = values.bitrate;
  if ($("csp-screen4k")) state.callSettings.screen4k = $("csp-screen4k").checked;
  saveCallSettings();
  syncCallSettingsInputs();

  if (call.active) {
    applyBitrateToSenders();
    applyMirror();
    if (call.localStream) {
      const videoTrack = call.localStream.getVideoTracks()[0];
      if (videoTrack && videoTrack.applyConstraints) {
        const preset = CALL_QUALITY_PRESETS[state.callSettings.quality] || CALL_QUALITY_PRESETS["1080p"];
        videoTrack
          .applyConstraints({
            width: { ideal: preset.width },
            height: { ideal: preset.height },
            frameRate: { ideal: state.callSettings.fps },
          })
          .catch(() => {});
      }
    }
    toast("Настройки звонка применены", "success", 1800);
  } else {
    toast("Настройки звонка сохранены", "success", 1800);
  }
}

function toggleCallSettingsPanel() {
  const panel = $("call-settings-panel");
  if (!panel) return;
  panel.classList.toggle("active");
}

function applyMirror() {
  const local = $("local-video");
  if (!local) return;
  local.classList.toggle("mirrored", !!state.callSettings.mirror);
}

// ============================================================
// ЗАПУСК ЗВОНКА
// ============================================================
function callTargetFromView() {
  if (state.current) return state.current;
  return null;
}

async function startCall(options = {}) {
  if (call.active) {
    toast("Ты уже в звонке", "warn");
    return;
  }
  const target = options.withUser || callTargetFromView();
  if (!target) {
    toast("Открой чат с другом или выбери участника сервера", "info");
    return;
  }
  if (state.user && target === state.user.username) return;

  loadCallSettings();
  if (!ICE_SERVERS.length || ICE_SERVERS.length < 4) loadIceServers();
  const wantsVideo = options.video !== false;
  const wantsScreen = !!options.screen;

  resetCallState();
  call.active = true;
  call.isCaller = true;
  call.callId = uuid();
  call.peer = target;
  call.peerData = getUserCard(target) || { username: target, display_name: target };
  call.video = wantsVideo;
  call.screen = wantsScreen;

  showCallOverlay("Звоним…");

  try {
    await ensureLocalMedia({ video: wantsVideo || wantsScreen, screen: wantsScreen });
  } catch (err) {
    endCall("Не удалось получить доступ к микрофону или камере");
    return;
  }

  setupPeerConnection();

  const sent = sendWS({
    type: "call",
    action: "invite",
    to: target,
    call_id: call.callId,
    video: wantsVideo,
    screen: wantsScreen,
  });

  if (!sent) {
    endCall("Нет соединения с сервером");
    return;
  }

  call.inviteTimeout = setTimeout(() => {
    if (call.active && !call.answered) endCall("Никто не ответил", true);
  }, 45000);
}

async function acceptIncomingCall() {
  const incoming = call.pendingIncoming;
  if (!incoming) return;
  call.pendingIncoming = null;
  $("incoming-call").classList.remove("active");

  loadCallSettings();
  loadIceServers();
  resetCallState();
  call.active = true;
  call.isCaller = false;
  call.callId = incoming.call_id;
  call.peer = incoming.from;
  call.peerData = getUserCard(incoming.from) || { username: incoming.from, display_name: incoming.from_name || incoming.from };
  call.video = !!incoming.video;
  call.screen = !!incoming.screen;

  showCallOverlay("Соединяем…");

  try {
    await ensureLocalMedia({ video: call.video || call.screen, screen: false });
  } catch (err) {
    sendWS({ type: "call", action: "reject", to: call.peer, call_id: call.callId });
    endCall("Не удалось получить доступ к микрофону");
    return;
  }

  setupPeerConnection();
  call.answered = true;
  startCallTimer();

  sendWS({ type: "call", action: "accept", to: call.peer, call_id: call.callId });
}

function rejectIncomingCall() {
  const incoming = call.pendingIncoming;
  call.pendingIncoming = null;
  $("incoming-call").classList.remove("active");
  if (!incoming) return;
  sendWS({ type: "call", action: "reject", to: incoming.from, call_id: incoming.call_id });
  toast("Звонок отклонён", "info");
}

// ============================================================
// МЕДИА
// ============================================================
async function ensureLocalMedia(options = {}) {
  const s = state.callSettings;
  const preset = CALL_QUALITY_PRESETS[s.quality] || CALL_QUALITY_PRESETS["1080p"];

  if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
    throw new Error("Браузер не поддерживает доступ к медиа");
  }

  if (!call.localStream) {
    const constraints = {
      audio: {
        echoCancellation: s.echo,
        noiseSuppression: s.noise,
        autoGainControl: s.agc,
        channelCount: 2,
      },
      video: options.video
        ? {
            width: { ideal: preset.width, max: 3840 },
            height: { ideal: preset.height, max: 2160 },
            frameRate: { ideal: s.fps, max: 60 },
            facingMode: "user",
          }
        : false,
    };
    call.localStream = await navigator.mediaDevices.getUserMedia(constraints);
  }

  call.micOn = call.localStream.getAudioTracks().length > 0;
  call.camOn = call.localStream.getVideoTracks().length > 0;

  const local = $("local-video");
  if (local) {
    local.srcObject = call.localStream;
    local.muted = true;
    local.classList.toggle("hidden", !call.camOn);
  }
  applyMirror();
  updateCallButtons();

  if (options.screen) await startScreenShare();
}

async function startScreenShare() {
  if (!navigator.mediaDevices || !navigator.mediaDevices.getDisplayMedia) {
    toast("Браузер не поддерживает шаринг экрана", "warn");
    return false;
  }
  const s = state.callSettings;
  const preset = CALL_QUALITY_PRESETS[s.quality] || CALL_QUALITY_PRESETS["1080p"];
  const width = s.screen4k ? 3840 : preset.width;
  const height = s.screen4k ? 2160 : preset.height;

  try {
    const stream = await navigator.mediaDevices.getDisplayMedia({
      video: {
        width: { ideal: width, max: width },
        height: { ideal: height, max: height },
        frameRate: { ideal: s.fps, max: 60 },
      },
      audio: false,
    });

    call.screenStream = stream;
    call.screenOn = true;
    const track = stream.getVideoTracks()[0];

    if (track) {
      track.contentHint = "detail";
      track.addEventListener("ended", () => stopScreenShare());
    }

    attachVideoTrack(track);
    const local = $("local-video");
    if (local) {
      local.srcObject = stream;
      local.classList.remove("hidden");
      local.classList.add("is-screen");
    }
    applyBitrateToSenders();
    updateCallButtons();
    toast("Экран транслируется" + (s.screen4k ? " в 4K" : ""), "success", 2000);
    return true;
  } catch (err) {
    if (err && err.name === "NotAllowedError") toast("Шаринг экрана отменён", "info");
    else toast("Не удалось поделиться экраном", "error");
    return false;
  }
}

function stopScreenShare() {
  if (call.screenStream) {
    call.screenStream.getTracks().forEach((t) => t.stop());
    call.screenStream = null;
  }
  call.screenOn = false;

  const camTrack = call.localStream ? call.localStream.getVideoTracks()[0] : null;
  if (camTrack && call.camOn) attachVideoTrack(camTrack);
  else attachVideoTrack(null);

  const local = $("local-video");
  if (local) {
    local.srcObject = call.localStream;
    local.classList.toggle("hidden", !call.camOn);
    local.classList.remove("is-screen");
  }
  updateCallButtons();
}

function attachVideoTrack(track) {
  if (!call.videoSender) return;
  call.videoSender.replaceTrack(track).catch(() => {});
  applyBitrateToSenders();
}

function setupPeerConnection() {
  if (!window.RTCPeerConnection) {
    endCall("Браузер не поддерживает WebRTC");
    return;
  }

  const pc = new RTCPeerConnection({ iceServers: ICE_SERVERS, bundlePolicy: "max-bundle" });
  call.pc = pc;
  call.pendingCandidates = [];
  call.remoteStream = new MediaStream();

  const remote = $("remote-video");
  if (remote) remote.srcObject = call.remoteStream;

  pc.onicecandidate = (event) => {
    if (!event.candidate) return;
    sendWS({
      type: "call",
      action: "signal",
      to: call.peer,
      call_id: call.callId,
      kind: "candidate",
      data: event.candidate.toJSON ? event.candidate.toJSON() : event.candidate,
    });
  };

  pc.ontrack = (event) => {
    const [stream] = event.streams;
    if (stream) {
      call.remoteStream = stream;
    } else {
      call.remoteStream.addTrack(event.track);
    }
    if (remote) {
      remote.srcObject = call.remoteStream;
      remote.classList.remove("hidden");
      remote.play && remote.play().catch(() => {});
    }
    $("call-placeholder") && $("call-placeholder").classList.add("hidden");
  };

  pc.onconnectionstatechange = () => {
    if (!call.pc) return;
    if (pc.connectionState === "connected") {
      call.answered = true;
      $("call-state").textContent = "Соединено";
      startCallTimer();
      startStatsLoop();
    } else if (pc.connectionState === "failed") {
      endCall("Соединение потеряно");
    }
  };

  pc.onnegotiationneeded = async () => {
    // пересогласование нужно только инициатору
    if (!call.active || !call.isCaller || call.pc !== pc) return;
    if (!call.answered) return;
    try {
      const offer = await pc.createOffer();
      await pc.setLocalDescription(offer);
      sendSignal("offer", pc.localDescription);
    } catch (err) {}
  };

  // добавляем дорожки и предпочитаемый кодек
  const transceivers = [];
  const audioTrack = call.localStream ? call.localStream.getAudioTracks()[0] : null;
  const videoTrack = call.screenOn && call.screenStream
    ? call.screenStream.getVideoTracks()[0]
    : call.localStream
      ? call.localStream.getVideoTracks()[0]
      : null;

  const audioTx = pc.addTransceiver(audioTrack || "audio", { direction: "sendrecv", streams: [call.localStream || new MediaStream()] });
  const videoTx = pc.addTransceiver(videoTrack || "video", { direction: "sendrecv" });
  transceivers.push(audioTx, videoTx);
  call.videoSender = videoTx.sender;

  preferCodec(audioTx, "audio");
  preferCodec(videoTx, "video");
  applyBitrateToSenders();
  updateCallButtons();
}

function preferCodec(transceiver, kind) {
  if (!window.RTCRtpSender || !RTCRtpSender.getCapabilities) return;
  const wanted = state.callSettings.codec;
  if (!wanted || wanted === "auto") return;
  const caps = RTCRtpSender.getCapabilities(kind);
  if (!caps || !caps.codecs) return;
  const codecs = caps.codecs.slice().sort((a, b) => {
    const aM = (a.mimeType || "").toLowerCase().includes(wanted) ? 1 : 0;
    const bM = (b.mimeType || "").toLowerCase().includes(wanted) ? 1 : 0;
    return bM - aM;
  });
  try {
    transceiver.setCodecPreferences(codecs);
  } catch (err) {}
}

function applyBitrateToSenders() {
  if (!call.pc) return;
  const s = state.callSettings;
  const maxBitrate = Math.max(100000, parseInt(s.bitrate, 10) || 5000000);
  const maxFramerate = Math.max(1, parseInt(s.fps, 10) || 30);

  call.pc.getSenders().forEach((sender) => {
    if (!sender.track || sender.track.kind !== "video") return;
    try {
      const params = sender.getParameters();
      if (!params.encodings || !params.encodings.length) params.encodings = [{}];
      params.encodings[0].maxBitrate = maxBitrate;
      params.encodings[0].maxFramerate = maxFramerate;
      params.degradationPreference = call.screenOn ? "maintain-resolution" : "balanced";
      const promise = sender.setParameters(params);
      if (promise && promise.catch) promise.catch(() => {});
    } catch (err) {}
  });
}

async function sendSignal(kind, data) {
  sendWS({
    type: "call",
    action: "signal",
    to: call.peer,
    call_id: call.callId,
    kind,
    data,
  });
}

async function handleCallSignal(msg) {
  if (!call.pc) return;
  const pc = call.pc;

  try {
    if (msg.kind === "offer") {
      await pc.setRemoteDescription(new RTCSessionDescription(msg.data));
      await flushCandidates();
      attachLocalTracksToSenders();
      const answer = await pc.createAnswer();
      await pc.setLocalDescription(answer);
      sendSignal("answer", pc.localDescription);
    } else if (msg.kind === "answer") {
      await pc.setRemoteDescription(new RTCSessionDescription(msg.data));
      await flushCandidates();
      call.answered = true;
      startCallTimer();
    } else if (msg.kind === "candidate" && msg.data) {
      if (!pc.remoteDescription || !pc.remoteDescription.type) {
        call.pendingCandidates.push(msg.data);
      } else {
        await pc.addIceCandidate(new RTCIceCandidate(msg.data));
      }
    }
  } catch (err) {
    console.warn("call signal", err);
  }
}

async function flushCandidates() {
  if (!call.pc) return;
  while (call.pendingCandidates.length) {
    const candidate = call.pendingCandidates.shift();
    try {
      await call.pc.addIceCandidate(new RTCIceCandidate(candidate));
    } catch (err) {}
  }
}

function attachLocalTracksToSenders() {
  if (!call.pc || !call.localStream) return;
  const audioTrack = call.localStream.getAudioTracks()[0];
  const videoTrack = call.screenOn && call.screenStream
    ? call.screenStream.getVideoTracks()[0]
    : call.localStream.getVideoTracks()[0];

  call.pc.getSenders().forEach((sender) => {
    if (sender.track === null) return;
    if (sender.track.kind === "audio" && audioTrack) sender.replaceTrack(audioTrack).catch(() => {});
    if (sender.track.kind === "video" && videoTrack) sender.replaceTrack(videoTrack).catch(() => {});
  });

  applyBitrateToSenders();
}

// ============================================================
// UI ЗВОНКА
// ============================================================
function showCallOverlay(stateText) {
  $("call-overlay").classList.add("active");
  document.body.classList.add("in-call");

  const peer = call.peerData || getUserCard(call.peer) || { username: call.peer, display_name: call.peer };
  fillAvatarSlot($("call-avatar"), peer, "av-xl", { frame: peer.avatar_frame });
  $("call-peer-name").textContent = peer.display_name || peer.username;
  $("call-peer-name-2").textContent = peer.display_name || peer.username;
  $("call-state").textContent = stateText || "Звоним…";
  $("call-timer").textContent = "00:00";
  $("call-placeholder").classList.remove("hidden");
  $("remote-video").classList.add("hidden");
  $("call-settings-panel").classList.remove("active");
  syncCallSettingsInputs();
  updateCallButtons();
}

function hideCallOverlay() {
  $("call-overlay").classList.remove("active");
  document.body.classList.remove("in-call");
  const local = $("local-video");
  if (local) {
    local.srcObject = null;
    local.classList.add("hidden");
  }
  const remote = $("remote-video");
  if (remote) {
    remote.srcObject = null;
    remote.classList.add("hidden");
  }
  $("call-settings-panel").classList.remove("active");
}

function updateCallButtons() {
  const mic = $("btn-mic");
  const cam = $("btn-cam");
  const screenBtn = $("btn-screen");
  if (mic) mic.classList.toggle("off", !call.micOn);
  if (cam) cam.classList.toggle("off", !call.camOn);
  if (screenBtn) screenBtn.classList.toggle("on", call.screenOn);
  if (mic) mic.textContent = call.micOn ? "🎙" : "🔇";
  if (cam) cam.textContent = call.camOn ? "🎥" : "📷";
}

function toggleMic() {
  if (!call.active || !call.localStream) return;
  const tracks = call.localStream.getAudioTracks();
  if (!tracks.length) return;
  call.micOn = !call.micOn;
  tracks.forEach((t) => (t.enabled = call.micOn));
  updateCallButtons();
}

function toggleCam() {
  if (!call.active) return;
  if (!call.localStream) return;
  const tracks = call.localStream.getVideoTracks();
  if (!tracks.length) {
    toast("Камера недоступна", "warn");
    return;
  }
  call.camOn = !call.camOn;
  tracks.forEach((t) => (t.enabled = call.camOn));

  if (call.camOn && !call.screenOn) attachVideoTrack(tracks[0]);
  else if (!call.screenOn) attachVideoTrack(null);

  const local = $("local-video");
  if (local) local.classList.toggle("hidden", !call.camOn && !call.screenOn);
  updateCallButtons();
}

async function toggleScreenShare() {
  if (!call.active) {
    toast("Сначала начни звонок", "info");
    return;
  }
  if (call.screenOn) {
    stopScreenShare();
    return;
  }
  const ok = await startScreenShare();
  if (ok) call.answered = true;
}

function startCallTimer() {
  if (call.timer) return;
  call.startedAt = Date.now();
  call.timer = setInterval(() => {
    const total = Math.floor((Date.now() - call.startedAt) / 1000);
    const mins = String(Math.floor(total / 60)).padStart(2, "0");
    const secs = String(total % 60).padStart(2, "0");
    const node = $("call-timer");
    if (node) node.textContent = mins + ":" + secs;
  }, 1000);
}

function stopCallTimer() {
  if (call.timer) clearInterval(call.timer);
  call.timer = null;
}

// ============================================================
// СТАТИСТИКА
// ============================================================
function startStatsLoop() {
  if (call.statsTimer) clearInterval(call.statsTimer);
  const box = $("call-stats");
  if (box) box.style.display = state.callSettings.stats ? "block" : "none";

  call.statsTimer = setInterval(async () => {
    if (!call.pc || !call.active) return;
    try {
      const stats = await call.pc.getStats();
      let inboundVideo = null;
      let outboundVideo = null;
      let candidatePair = null;

      stats.forEach((report) => {
        if (report.type === "inbound-rtp" && report.kind === "video") inboundVideo = report;
        if (report.type === "outbound-rtp" && report.kind === "video") outboundVideo = report;
        if (report.type === "candidate-pair" && report.selected) candidatePair = report;
      });

      const prev = call.lastStats || {};
      const now = Date.now();
      let recvBitrate = 0;
      let sendBitrate = 0;
      if (inboundVideo && prev.inbound) {
        const dBytes = (inboundVideo.bytesReceived || 0) - (prev.inbound.bytesReceived || 0);
        const dTime = (now - prev.time) / 1000;
        if (dTime > 0) recvBitrate = Math.max(0, (dBytes * 8) / dTime);
      }
      if (outboundVideo && prev.outbound) {
        const dBytes = (outboundVideo.bytesSent || 0) - (prev.outbound.bytesSent || 0);
        const dTime = (now - prev.time) / 1000;
        if (dTime > 0) sendBitrate = Math.max(0, (dBytes * 8) / dTime);
      }

      call.lastStats = { inbound: inboundVideo, outbound: outboundVideo, time: now };

      if (!box || !state.callSettings.stats) return;
      const rows = [];
      rows.push(["Отправка", (sendBitrate / 1e6).toFixed(2) + " Мбит/с"]);
      rows.push(["Приём", (recvBitrate / 1e6).toFixed(2) + " Мбит/с"]);
      if (inboundVideo) {
        rows.push([
          "Входящее",
          (inboundVideo.frameWidth || 0) + "×" + (inboundVideo.frameHeight || 0) +
            " · " + (inboundVideo.framesPerSecond || 0) + " fps",
        ]);
        const lost = inboundVideo.packetsLost || 0;
        const received = inboundVideo.packetsReceived || 0;
        const loss = received + lost > 0 ? (lost / (received + lost)) * 100 : 0;
        rows.push(["Потери", loss.toFixed(2) + " %"]);
      }
      if (outboundVideo && outboundVideo.frameWidth) {
        rows.push([
          "Исходящее",
          outboundVideo.frameWidth + "×" + outboundVideo.frameHeight + " · " + Math.round(outboundVideo.framesPerSecond || 0) + " fps",
        ]);
      }
      if (candidatePair && candidatePair.currentRoundTripTime !== undefined) {
        rows.push(["Пинг", Math.round(candidatePair.currentRoundTripTime * 1000) + " мс"]);
      }
      if (call.pc.connectionState) rows.push(["Состояние", call.pc.connectionState]);

      clear(box);
      rows.forEach(([label, value]) => {
        const row = el("div", "stats-row");
        row.appendChild(el("span", "stats-label", label));
        row.appendChild(el("span", "stats-value", value));
        box.appendChild(row);
      });
    } catch (err) {}
  }, 1500);
}

function stopStatsLoop() {
  if (call.statsTimer) clearInterval(call.statsTimer);
  call.statsTimer = null;
  call.lastStats = null;
  const box = $("call-stats");
  if (box) {
    clear(box);
    box.style.display = "none";
  }
}

// ============================================================
// ЗАВЕРШЕНИЕ
// ============================================================
function resetCallState() {
  stopCallTimer();
  stopStatsLoop();
  if (call.inviteTimeout) clearTimeout(call.inviteTimeout);

  [call.localStream, call.screenStream].forEach((stream) => {
    if (stream) stream.getTracks().forEach((t) => t.stop());
  });

  if (call.pc) {
    try {
      call.pc.getSenders().forEach((s) => s.track && s.track.stop && s.track.stop());
    } catch (err) {}
    try {
      call.pc.close();
    } catch (err) {}
  }

  call.active = false;
  call.callId = null;
  call.isCaller = false;
  call.video = false;
  call.screen = false;
  call.pc = null;
  call.videoSender = null;
  call.localStream = null;
  call.screenStream = null;
  call.remoteStream = null;
  call.pendingCandidates = [];
  call.pendingIncoming = null;
  call.micOn = true;
  call.camOn = false;
  call.screenOn = false;
  call.answered = false;
  call.inviteTimeout = null;
}

function endCall(reason, silent) {
  if (call.peer) {
    sendWS({
      type: "call",
      action: "end",
      to: call.peer,
      call_id: call.callId,
      reason: reason || "",
    });
  }
  const name = call.peerData ? call.peerData.display_name || call.peerData.username : null;
  resetCallState();
  hideCallOverlay();
  if (!silent && name) toast("Звонок завершён" + (reason ? ": " + reason : ""), "info", 2600);
}

function hangupCall() {
  endCall("");
}

// ============================================================
// WS СОБЫТИЯ
// ============================================================
function handleCallEvent(msg) {
  switch (msg.type) {
    case "call_incoming": {
      if (call.active) {
        sendWS({ type: "call", action: "busy", to: msg.from, call_id: msg.call_id });
        return;
      }
      call.pendingIncoming = msg;
      const card = getUserCard(msg.from) || { username: msg.from, display_name: msg.from_name || msg.from };
      fillAvatarSlot($("incoming-avatar"), card, "av-xl", { frame: card.avatar_frame });
      $("incoming-name").textContent = card.display_name || msg.from;
      $("incoming-type").textContent = msg.screen
        ? "Демонстрация экрана"
        : msg.video
          ? "Входящий видеозвонок"
          : "Входящий звонок";
      $("incoming-call").classList.add("active");

      try {
        if (window.AudioContext) {
          const ctx = new AudioContext();
          const osc = ctx.createOscillator();
          const gain = ctx.createGain();
          gain.gain.value = 0.03;
          osc.frequency.value = 520;
          osc.connect(gain).connect(ctx.destination);
          osc.start();
          setTimeout(() => {
            try {
              osc.stop();
              ctx.close();
            } catch (err) {}
          }, 900);
        }
      } catch (err) {}
      break;
    }

    case "call_accept": {
      if (!call.active || call.callId !== msg.call_id) return;
      if (!call.pc) return;
      if (call.answered) return;
      call.answered = true;
      if (call.inviteTimeout) clearTimeout(call.inviteTimeout);
      $("call-state").textContent = "Соединяем…";
      (async () => {
        try {
          const offer = await call.pc.createOffer();
          await call.pc.setLocalDescription(offer);
          sendSignal("offer", call.pc.localDescription);
        } catch (err) {
          endCall("Не удалось установить соединение");
        }
      })();
      break;
    }

    case "call_signal": {
      if (!call.active || call.callId !== msg.call_id) return;
      handleCallSignal(msg);
      break;
    }

    case "call_reject": {
      if (!call.active || call.callId !== msg.call_id) return;
      const name = call.peerData ? call.peerData.display_name || call.peerData.username : "Собеседник";
      resetCallState();
      hideCallOverlay();
      toast(name + " отклонил звонок", "info");
      break;
    }

    case "call_busy": {
      if (!call.active || call.callId !== msg.call_id) return;
      const name = call.peerData ? call.peerData.display_name || call.peerData.username : "Собеседник";
      resetCallState();
      hideCallOverlay();
      toast(name + " сейчас в другом звонке", "warn");
      break;
    }

    case "call_end": {
      if (!call.active || call.callId !== msg.call_id) return;
      const name = call.peerData ? call.peerData.display_name || call.peerData.username : "Собеседник";
      resetCallState();
      hideCallOverlay();
      toast(name + " завершил звонок", "info");
      break;
    }

    case "call_error": {
      if (call.active && call.callId && msg.call_id && msg.call_id !== call.callId) return;
      resetCallState();
      hideCallOverlay();
      toast(msg.text || "Ошибка звонка", "error");
      break;
    }

    default:
      break;
  }
}
