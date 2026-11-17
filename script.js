// Peer Desk — Private, Zero-Server Study Table for Two
// Handcrafted out of personal necessity using native browser APIs

let pc = null;
let dcChat = null;
let dcSketch = null;
let dcFiles = null;
let recorder = null;
let audioChunks = [];
let localStream = null;
let syncing = false;
let padSyncing = false;
let padTimer = null;
let incomingFiles = {};
let connectTimer = null;
let sdpVersion = 0;

let logs = JSON.parse(sessionStorage.getItem("pedesk_logs") || "[]");
const chat = document.getElementById("chat");
const watchVideo = document.getElementById("watchVideo");
const sharedPad = document.getElementById("sharedPad");

// --- SAFE DOM & CHAT HELPERS ---
function escapeHTML(str) {
  const div = document.createElement("div");
  div.textContent = str;
  return div.innerHTML;
}

function addLine(who, html, save) {
  const row = document.createElement("div");
  row.innerHTML = `<b>[${escapeHTML(who)}]</b> ${html}`;
  chat.appendChild(row);
  chat.scrollTop = chat.scrollHeight;

  if (save) {
    logs.push({ who, html });
    sessionStorage.setItem("pedesk_logs", JSON.stringify(logs));
  }
}

function addAudioLine(who, dataUrl) {
  if (typeof dataUrl !== "string" || !dataUrl.startsWith("data:audio/")) return;

  const row = document.createElement("div");
  const label = document.createElement("b");
  label.textContent = `[${who}] `;

  const audio = document.createElement("audio");
  audio.controls = true;
  audio.src = dataUrl;

  row.append(label, document.createElement("br"), audio);
  chat.appendChild(row);
  chat.scrollTop = chat.scrollHeight;
}

function addFileLine(who, fileName, dataUrl) {
  if (typeof dataUrl !== "string" || !dataUrl.startsWith("data:")) return;
  if (dataUrl.startsWith("data:text/html") || dataUrl.startsWith("data:image/svg")) return;

  const row = document.createElement("div");
  const label = document.createElement("b");
  label.textContent = `[${who}] `;

  const link = document.createElement("a");
  link.href = dataUrl;
  link.download = fileName;
  link.textContent = `💾 ${fileName}`;

  row.append(label, link);
  chat.appendChild(row);
  chat.scrollTop = chat.scrollHeight;
}

for (let i = 0; i < logs.length; i++) {
  addLine(logs[i].who, logs[i].html, false);
}

// --- ZERO-SERVER MAGIC LINK COMPRESSION ---
async function encodeSDP(desc) {
  const json = JSON.stringify(desc);
  if (!window.CompressionStream) return btoa(json);
  const stream = new Blob([json]).stream().pipeThrough(new CompressionStream("gzip"));
  const buf = await new Response(stream).arrayBuffer();
  const bytes = new Uint8Array(buf);
  let bin = "";
  for (let i = 0; i < bytes.length; i++) {
    bin += String.fromCharCode(bytes[i]);
  }
  return "PD1_" + btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

async function decodeSDP(str) {
  let clean = str.trim();
  if (clean.includes("#invite=")) clean = clean.split("#invite=").pop();
  if (clean.includes("#reply=")) clean = clean.split("#reply=").pop();

  if (!clean.startsWith("PD1_") && !clean.startsWith("PD1:")) {
    return JSON.parse(clean.startsWith("{") ? clean : atob(clean));
  }
  let b64 = clean.slice(4).replace(/-/g, "+").replace(/_/g, "/");
  while (b64.length % 4) b64 += "=";
  const bin = Uint8Array.from(atob(b64), c => c.charCodeAt(0));
  const stream = new Blob([bin]).stream().pipeThrough(new DecompressionStream("gzip"));
  const text = await new Response(stream).text();
  return JSON.parse(text);
}

function buildMagicLink(type, code) {
  const base = window.location.href.split("#").shift();
  return `${base}#${type}=${code}`;
}

// --- DIRECT WEBRTC PEER SETUP ---
function getPeer() {
  if (pc) return pc;

  pc = new RTCPeerConnection({
    iceServers: [
      { urls: "stun:stun.l.google.com:19302" },
      { urls: "stun:stun1.l.google.com:19302" },
      { urls: "stun:stun.cloudflare.com:3478" }
    ]
  });

  pc.onicecandidate = async () => {
    if (!pc.localDescription) return;
    const currentVersion = ++sdpVersion;
    const code = await encodeSDP(pc.localDescription);

    if (currentVersion === sdpVersion) {
      const tag = pc.localDescription.type === "offer" ? "invite" : "reply";
      document.getElementById("myCode").value = buildMagicLink(tag, code);
    }
  };

  pc.oniceconnectionstatechange = () => {
    const state = pc.iceConnectionState;
    if (state === "checking") {
      addLine("SYS", "Punching through network...", false);
      clearTimeout(connectTimer);
      connectTimer = setTimeout(() => {
        if (pc && pc.iceConnectionState === "checking") {
          addLine("SYS", "Network firewall is slowing direct P2P. Try switching Wi-Fi or mobile data.", false);
        }
      }, 15000);
    }
    if (state === "connected" || state === "completed") {
      clearTimeout(connectTimer);
    }
    if (state === "failed") {
      clearTimeout(connectTimer);
      addLine("SYS", "Direct P2P blocked by strict router NAT.", false);
    }
  };

  pc.ondatachannel = (e) => {
    if (e.channel.label === "sketch") setupSketchChannel(e.channel);
    else if (e.channel.label === "files") setupFileChannel(e.channel);
    else setupChatChannel(e.channel);
  };

  pc.ontrack = (e) => {
    document.getElementById("callBox").classList.remove("hidden");
    document.getElementById("remoteVideo").srcObject = e.streams.at(0);
  };

  return pc;
}

// --- PRIVACY-FIRST LINK CLEANER ---
function cleanLink(text) {
  const safeText = escapeHTML(text);
  if (!text.startsWith("http://") && !text.startsWith("https://")) return safeText;
  try {
    const u = new URL(text);
    const junk = ["utm_source", "utm_medium", "utm_campaign", "utm_term", "fbclid", "si", "gclid", "igshid"];
    for (let i = 0; i < junk.length; i++) {
      u.searchParams.delete(junk[i]);
    }
    const cleanHref = escapeHTML(u.href);
    return `<a href="${cleanHref}" target="_blank" rel="noopener noreferrer">${cleanHref}</a>`;
  } catch {
    return safeText;
  }
}

function toggleConnect() {
  document.getElementById("connectDrawer").classList.toggle("hidden");
}

function toggleWatch() {
  document.getElementById("watchBox").classList.toggle("hidden");
}

// --- VOICE, VIDEO & SCREEN SHARE ---
async function startStream(getStreamFn, readyMsg) {
  try {
    if (localStream) {
      localStream.getTracks().forEach(track => track.stop());
    }

    const peer = getPeer();
    const stream = await getStreamFn();
    localStream = stream;

    document.getElementById("callBox").classList.remove("hidden");
    document.getElementById("localVideo").srcObject = stream;

    peer.getSenders().forEach(sender => {
      if (sender.track) peer.removeTrack(sender);
    });

    stream.getTracks().forEach(track => {
      peer.addTrack(track, stream);
      track.onended = () => stopMedia(true);
    });

    if (dcChat && dcChat.readyState === "open") {
      const offer = await peer.createOffer();
      await peer.setLocalDescription(offer);
      dcChat.send(JSON.stringify({ type: "renegotiate", sdp: peer.localDescription }));
    }

    addLine("SYS", readyMsg, false);
  } catch (err) {
    addLine("SYS", "Media error: " + escapeHTML(err.name), false);
  }
}

const armMedia = (audio, video) =>
  startStream(() => navigator.mediaDevices.getUserMedia({ audio, video }), "Mic/Cam ready.");

const armScreen = () =>
  startStream(() => navigator.mediaDevices.getDisplayMedia({ video: true, audio: true }), "Screen ready.");

function stopMedia(emit) {
  if (localStream) {
    localStream.getTracks().forEach(track => {
      track.onended = null;
      track.stop();
    });
    localStream = null;
  }

  if (pc) {
    pc.getSenders().forEach(sender => {
      if (sender.track) pc.removeTrack(sender);
    });
  }

  document.getElementById("localVideo").srcObject = null;
  document.getElementById("remoteVideo").srcObject = null;
  document.getElementById("callBox").classList.add("hidden");

  const muteBtn = document.getElementById("muteBtn");
  muteBtn.innerText = "🔇 Mute Mic";
  muteBtn.classList.remove("recording");

  if (emit && dcChat && dcChat.readyState === "open") {
    dcChat.send(JSON.stringify({ type: "endcall" }));
    addLine("SYS", "Call ended.", false);
  }
}

function toggleMute() {
  if (!localStream) return;
  const audioTracks = localStream.getAudioTracks();
  if (audioTracks.length === 0) return;

  const track = audioTracks.at(0);
  const active = !track.enabled;
  track.enabled = active;

  const btn = document.getElementById("muteBtn");
  if (active) {
    btn.innerText = "🔇 Mute Mic";
    btn.classList.remove("recording");
  } else {
    btn.innerText = "🎤 Unmute Mic";
    btn.classList.add("recording");
  }
}

// --- CHANNEL 1: RELIABLE CHAT, VIDEO & SHARED PAD SYNC ---
function setupChatChannel(channel) {
  dcChat = channel;
  dcChat.onopen = () => {
    const badge = document.getElementById("status");
    badge.innerText = "[CONNECTED]";
    badge.className = "status-on";
    document.getElementById("connectDrawer").classList.add("hidden");
    if (window.location.hash) history.replaceState(null, "", window.location.pathname);
    addLine("SYS", "Connected (3 isolated channels active).", false);

    if (sharedPad && sharedPad.value) {
      dcChat.send(JSON.stringify({ type: "pad", text: sharedPad.value }));
    }
    if (hasDrawn) {
      dcChat.send(JSON.stringify({ type: "board-snap", img: canvas.toDataURL("image/png") }));
    }
  };
  dcChat.onclose = () => {
    const badge = document.getElementById("status");
    badge.innerText = "[OFFLINE]";
    badge.className = "status-off";
    stopMedia(false);
    addLine("SYS", "Disconnected.", false);
  };
  dcChat.onmessage = async (e) => {
    try {
      const pkt = JSON.parse(e.data);

      if (pkt.type === "renegotiate" && pc) {
        await pc.setRemoteDescription(pkt.sdp);
        if (pkt.sdp.type === "offer") {
          const answer = await pc.createAnswer();
          await pc.setLocalDescription(answer);
          dcChat.send(JSON.stringify({ type: "renegotiate", sdp: pc.localDescription }));
        }
        return;
      }

      if (pkt.type === "msg") addLine("FRIEND", cleanLink(pkt.text), true);
      if (pkt.type === "voice") addAudioLine("FRIEND", pkt.data);
      if (pkt.type === "wipe") wipeBoard(false);
      if (pkt.type === "board-snap" && typeof pkt.img === "string" && pkt.img.startsWith("data:image/png")) {
        const img = new Image();
        img.onload = () => {
          ctx.drawImage(img, 0, 0);
          hasDrawn = true;
        };
        img.src = pkt.img;
      }
      if (pkt.type === "endcall") stopMedia(false);
      if (pkt.type === "video") syncWatch(pkt);
      if (pkt.type === "pad" && sharedPad) {
        const start = sharedPad.selectionStart;
        const end = sharedPad.selectionEnd;
        padSyncing = true;
        sharedPad.value = pkt.text;
        sharedPad.setSelectionRange(start, end);
        setTimeout(() => { padSyncing = false; }, 50);
      }
      if (pkt.type === "ping") dcChat.send(JSON.stringify({ type: "pong", ts: pkt.ts }));
      if (pkt.type === "pong") addLine("SYS", (Date.now() - pkt.ts) + "ms", false);
    } catch {
      // Ignore malformed packets silently
    }
  };
}

// --- CHANNEL 2: LOW-LATENCY SKETCHPAD ---
function setupSketchChannel(channel) {
  dcSketch = channel;
  dcSketch.onmessage = (e) => {
    try {
      const pkt = JSON.parse(e.data);
      if (pkt.type === "draw") drawLine(pkt.x1, pkt.y1, pkt.x2, pkt.y2, false);
    } catch {
      // Ignore malformed packets silently
    }
  };
}

// --- CHANNEL 3: DEDICATED 16KB CHUNKED FILE PIPE ---
function setupFileChannel(channel) {
  dcFiles = channel;
  dcFiles.onmessage = (e) => {
    try {
      const pkt = JSON.parse(e.data);
      if (pkt.type === "file-meta") {
        incomingFiles[pkt.id] = { name: pkt.name, total: pkt.total, received: 0, parts: new Array(pkt.total) };
        addLine("SYS", `Receiving ${escapeHTML(pkt.name)}...`, false);
      }
      if (pkt.type === "file-chunk") {
        const f = incomingFiles[pkt.id];
        if (!f || pkt.index < 0 || pkt.index >= f.total) return;
        if (!f.parts[pkt.index]) f.received++;
        f.parts[pkt.index] = pkt.data;

        if (f.received === f.total) {
          addFileLine("FRIEND", f.name, f.parts.join(""));
          delete incomingFiles[pkt.id];
        }
      }
    } catch {
      // Ignore malformed packets silently
    }
  };
}

function waitForICE(peer) {
  return new Promise((resolve) => {
    if (peer.iceGatheringState === "complete") return resolve();
    const check = () => {
      if (peer.iceGatheringState === "complete") {
        peer.removeEventListener("icegatheringstatechange", check);
        resolve();
      }
    };
    peer.addEventListener("icegatheringstatechange", check);
    setTimeout(resolve, 1500);
  });
}

async function createInvite() {
  try {
    const peer = getPeer();
    setupChatChannel(peer.createDataChannel("chat"));
    setupSketchChannel(peer.createDataChannel("sketch", { ordered: false, maxRetransmits: 0 }));
    setupFileChannel(peer.createDataChannel("files"));

    const offer = await peer.createOffer();
    await peer.setLocalDescription(offer);
    await waitForICE(peer);

    const code = await encodeSDP(peer.localDescription);
    const link = buildMagicLink("invite", code);
    document.getElementById("myCode").value = link;
    if (navigator.clipboard) navigator.clipboard.writeText(link).catch(() => {});
    addLine("SYS", "Magic Invite Link created & auto-copied! Send it to your friend.", false);
  } catch (err) {
    addLine("SYS", "Error: " + escapeHTML(err.message), false);
  }
}

async function joinDesk() {
  const raw = document.getElementById("friendCode").value.trim();
  if (!raw) return;
  try {
    const peer = getPeer();
    const desc = await decodeSDP(raw);
    await peer.setRemoteDescription(desc);
    const answer = await peer.createAnswer();
    await peer.setLocalDescription(answer);
    await waitForICE(peer);

    const code = await encodeSDP(peer.localDescription);
    const replyLink = buildMagicLink("reply", code);
    document.getElementById("myCode").value = replyLink;
    if (navigator.clipboard) navigator.clipboard.writeText(replyLink).catch(() => {});
    addLine("SYS", "Magic Reply Link ready & auto-copied! Send it back to host.", false);
  } catch (err) {
    addLine("SYS", "Invite error: " + escapeHTML(err.message), false);
  }
}

async function finishLink() {
  const raw = document.getElementById("friendCode").value.trim();
  if (!raw) return;
  const peer = getPeer();
  if (peer.signalingState !== "have-local-offer") return;
  try {
    const desc = await decodeSDP(raw);
    await peer.setRemoteDescription(desc);
  } catch (err) {
    addLine("SYS", "Reply error: " + escapeHTML(err.message), false);
  }
}

function smartConnect() {
  if (pc && pc.signalingState === "stable") return;
  if (pc && pc.signalingState === "have-local-offer") finishLink();
  else joinDesk();
}

function copyCode() {
  const box = document.getElementById("myCode");
  if (!box.value) return;
  box.focus();
  box.select();
  box.setSelectionRange(0, box.value.length);
  if (navigator.clipboard) navigator.clipboard.writeText(box.value).catch(() => {});
  addLine("SYS", "Full link copied to clipboard.", false);
}

// --- AUTO-DETECT INVITE / REPLY ON PASTE OR URL OPEN ---
document.getElementById("friendCode").addEventListener("input", () => {
  setTimeout(() => {
    const val = document.getElementById("friendCode").value.trim();
    if (!val.includes("PD1_") && !val.startsWith("{")) return;

    if (pc && pc.signalingState === "have-local-offer") {
      if (val.includes("#invite=")) {
        addLine("SYS", "That is your own Invite link! Paste your friend's Reply link instead.", false);
        return;
      }
      addLine("SYS", "Reply detected! Connecting automatically...", false);
      finishLink();
    } else if (!pc) {
      addLine("SYS", "Invite detected! Generating reply automatically...", false);
      joinDesk();
    }
  }, 50);
});

window.addEventListener("DOMContentLoaded", () => {
  if (window.location.hash.startsWith("#invite=")) {
    document.getElementById("connectDrawer").classList.remove("hidden");
    document.getElementById("friendCode").value = window.location.href;
    addLine("SYS", "Magic Invite opened! Generating your reply link...", false);
    joinDesk();
  }
});

// --- SHARED CODE & NOTE PAD LIVE SYNC ---
if (sharedPad) {
  sharedPad.addEventListener("input", () => {
    if (padSyncing || !dcChat || dcChat.readyState !== "open") return;
    clearTimeout(padTimer);
    padTimer = setTimeout(() => {
      if (dcChat && dcChat.readyState === "open") {
        dcChat.send(JSON.stringify({ type: "pad", text: sharedPad.value }));
      }
    }, 120);
  });

  sharedPad.addEventListener("keydown", (e) => {
    if (e.key === "Tab") {
      e.preventDefault();
      const start = sharedPad.selectionStart;
      const end = sharedPad.selectionEnd;
      sharedPad.value = sharedPad.value.substring(0, start) + "  " + sharedPad.value.substring(end);
      sharedPad.selectionStart = sharedPad.selectionEnd = start + 2;
      sharedPad.dispatchEvent(new Event("input"));
    }
  });
}

function copyPad() {
  if (!sharedPad || !sharedPad.value) return;
  sharedPad.select();
  if (navigator.clipboard) navigator.clipboard.writeText(sharedPad.value).catch(() => {});
  addLine("SYS", "Code/Notes copied.", false);
}

function savePad() {
  if (!sharedPad) return;
  const blob = new Blob([sharedPad.value], { type: "text/plain" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = "pedesk_notes.txt";
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

// --- CHAT & LOCAL SLASH COMMANDS ---
function sendMsg() {
  const input = document.getElementById("msgInput");
  const text = input.value.trim();
  if (!text) return;
  input.value = "";

  if (text === "/help") {
    addLine("SYS", "/clear = wipe chat | /export = save JSON | /ping = check speed", false);
    return;
  }

  if (text === "/clear") {
    sessionStorage.removeItem("pedesk_logs");
    logs = [];
    chat.innerHTML = "";
    return;
  }

  if (text === "/export") {
    const blob = new Blob([JSON.stringify(logs, null, 2)], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = "pedesk_notes.json";
    a.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
    return;
  }

  if (text === "/ping") {
    if (dcChat && dcChat.readyState === "open") {
      dcChat.send(JSON.stringify({ type: "ping", ts: Date.now() }));
    }
    return;
  }

  const clean = cleanLink(text);
  addLine("ME", clean, true);

  if (dcChat && dcChat.readyState === "open") {
    dcChat.send(JSON.stringify({ type: "msg", text: text }));
  }
}

document.getElementById("msgInput").addEventListener("keypress", (e) => {
  if (e.key === "Enter") sendMsg();
});

// --- 16KB CHUNKED FILE TRANSFER ---
function sendFile() {
  const input = document.getElementById("fileSend");
  const file = input.files.item(0);
  if (!file) return;

  const reader = new FileReader();
  reader.onload = async (e) => {
    const dataUrl = e.target.result;
    addFileLine("ME", file.name, dataUrl);

    const pipe = (dcFiles && dcFiles.readyState === "open") ? dcFiles : dcChat;
    if (pipe && pipe.readyState === "open") {
      const CHUNK_SIZE = 16000;
      const total = Math.ceil(dataUrl.length / CHUNK_SIZE);
      const id = Date.now().toString(36);

      pipe.send(JSON.stringify({ type: "file-meta", id, name: file.name, total }));

      for (let i = 0; i < total; i++) {
        while (pipe.bufferedAmount > 65536) {
          await new Promise(r => setTimeout(r, 20));
        }
        const slice = dataUrl.slice(i * CHUNK_SIZE, (i + 1) * CHUNK_SIZE);
        pipe.send(JSON.stringify({ type: "file-chunk", id, index: i, data: slice }));
      }
    }
    input.value = "";
  };
  reader.readAsDataURL(file);
}

// --- VOICE NOTES ---
async function toggleVoice() {
  const btn = document.getElementById("recBtn");

  if (!recorder || recorder.state === "inactive") {
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      recorder = new MediaRecorder(stream);
      audioChunks = [];

      recorder.ondataavailable = (e) => audioChunks.push(e.data);
      recorder.onstop = () => {
        const blob = new Blob(audioChunks, { type: "audio/webm" });
        const reader = new FileReader();
        reader.onload = (ev) => {
          addAudioLine("ME", ev.target.result);
          if (dcChat && dcChat.readyState === "open") {
            dcChat.send(JSON.stringify({ type: "voice", data: ev.target.result }));
          }
        };
        reader.readAsDataURL(blob);
        stream.getTracks().forEach(track => track.stop());
      };

      recorder.start();
      btn.innerText = "⏹ Stop";
      btn.classList.add("recording");
    } catch (err) {
      addLine("SYS", "Mic error: " + escapeHTML(err.name), false);
    }
  } else {
    recorder.stop();
    btn.innerText = "🎤 Voice Note";
    btn.classList.remove("recording");
  }
}

// --- LOCAL WATCH TOGETHER SYNC ---
function loadWatchVideo() {
  const file = document.getElementById("videoFile").files.item(0);
  if (!file) return;
  if (watchVideo.src && watchVideo.src.startsWith("blob:")) {
    URL.revokeObjectURL(watchVideo.src);
  }
  watchVideo.src = URL.createObjectURL(file);
  addLine("SYS", "Loaded video: " + escapeHTML(file.name), false);
}

function sendWatch(state) {
  if (syncing || !dcChat || dcChat.readyState !== "open") return;
  dcChat.send(JSON.stringify({ type: "video", state: state, time: watchVideo.currentTime }));
}

function syncWatch(pkt) {
  document.getElementById("watchBox").classList.remove("hidden");
  syncing = true;
  if (Math.abs(watchVideo.currentTime - pkt.time) > 0.5) {
    watchVideo.currentTime = pkt.time;
  }
  if (pkt.state === "play") watchVideo.play().catch(() => {});
  if (pkt.state === "pause") watchVideo.pause();
  setTimeout(() => { syncing = false; }, 250);
}

watchVideo.onplay = () => sendWatch("play");
watchVideo.onpause = () => sendWatch("pause");
watchVideo.onseeked = () => sendWatch(watchVideo.paused ? "pause" : "play");

// --- SHARED FLAG-GREEN SKETCHPAD ---
const canvas = document.getElementById("board");
const ctx = canvas.getContext("2d");
ctx.strokeStyle = "#005a36";
ctx.lineWidth = 2;
ctx.lineCap = "round";
let drawing = false;
let hasDrawn = false;
let lx = 0;
let ly = 0;

function drawLine(x1, y1, x2, y2, emit) {
  hasDrawn = true;
  ctx.beginPath();
  ctx.moveTo(x1, y1);
  ctx.lineTo(x2, y2);
  ctx.stroke();
  const pipe = (dcSketch && dcSketch.readyState === "open") ? dcSketch : dcChat;
  if (emit && pipe && pipe.readyState === "open") {
    pipe.send(JSON.stringify({ type: "draw", x1, y1, x2, y2 }));
  }
}

function wipeBoard(emit) {
  hasDrawn = false;
  ctx.clearRect(0, 0, canvas.width, canvas.height);
  if (emit && dcChat && dcChat.readyState === "open") {
    dcChat.send(JSON.stringify({ type: "wipe" }));
  }
}

function saveBoard() {
  const a = document.createElement("a");
  a.href = canvas.toDataURL("image/png");
  a.download = "pedesk_sketch.png";
  a.click();
}

function getCanvasPos(clientX, clientY) {
  const rect = canvas.getBoundingClientRect();
  return {
    x: (clientX - rect.left) * (canvas.width / rect.width),
    y: (clientY - rect.top) * (canvas.height / rect.height)
  };
}

canvas.onmousedown = (e) => {
  const pos = getCanvasPos(e.clientX, e.clientY);
  drawing = true;
  lx = pos.x;
  ly = pos.y;
};
canvas.onmouseup = () => { drawing = false; };
canvas.onmouseleave = () => { drawing = false; };
canvas.onmousemove = (e) => {
  if (!drawing) return;
  const pos = getCanvasPos(e.clientX, e.clientY);
  drawLine(lx, ly, pos.x, pos.y, true);
  lx = pos.x;
  ly = pos.y;
};

canvas.ontouchstart = (e) => {
  e.preventDefault();
  const touch = e.touches.item(0);
  const pos = getCanvasPos(touch.clientX, touch.clientY);
  drawing = true;
  lx = pos.x;
  ly = pos.y;
};
canvas.ontouchend = () => { drawing = false; };
canvas.ontouchmove = (e) => {
  e.preventDefault();
  if (!drawing) return;
  const touch = e.touches.item(0);
  const pos = getCanvasPos(touch.clientX, touch.clientY);
  drawLine(lx, ly, pos.x, pos.y, true);
  lx = pos.x;
  ly = pos.y;
};
