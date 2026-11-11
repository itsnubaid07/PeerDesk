var pc = null;
var dc = null;
var recorder = null;
var chunks = [];
var localStream = null;
var syncing = false;

let logs = JSON.parse(localStorage.getItem("pedesk_logs") || "[]");
const chat = document.getElementById("chat");
const watchVideo = document.getElementById("watchVideo");

function addLine(who, html, save) {
  const row = document.createElement("div");
  row.innerHTML = `<b>[${who}]</b> ${html}`;
  chat.appendChild(row);
  chat.scrollTop = chat.scrollHeight;

  if (save) {
    logs.push({ who, html });
    localStorage.setItem("pedesk_logs", JSON.stringify(logs));
  }
}

for (let i = 0; i < logs.length; i++) {
  addLine(logs[i].who, logs[i].html, false);
}

function getPeer() {
  if (pc) return pc;

  const host = ["stun", "l", "google", "com"].join(".");
  pc = new RTCPeerConnection({
    iceServers: [{ urls: "stun:" + host + ":19302" }]
  });

  pc.onicecandidate = () => {
    if (pc.localDescription) {
      document.getElementById("myCode").value = JSON.stringify(pc.localDescription);
    }
  };

  pc.ondatachannel = (e) => setupChannel(e.channel);

  pc.ontrack = (e) => {
    document.getElementById("callBox").classList.remove("hidden");
    document.getElementById("remoteVideo").srcObject = e.streams[0];
  };

  return pc;
}

function cleanLink(text) {
  if (!text.startsWith("http://") && !text.startsWith("https://")) return text;
  try {
    const u = new URL(text);
    const junk = ["utm_source", "utm_medium", "utm_campaign", "utm_term", "fbclid", "si", "gclid"];
    for (let i = 0; i < junk.length; i++) {
      u.searchParams.delete(junk[i]);
    }
    return `<a href="${u.href}" target="_blank">${u.href}</a>`;
  } catch {
    return text;
  }
}

function toggleConnect() {
  document.getElementById("connectDrawer").classList.toggle("hidden");
}

function toggleWatch() {
  document.getElementById("watchBox").classList.toggle("hidden");
}

async function armMedia(audio, video) {
  try {
    const peer = getPeer();
    const stream = await navigator.mediaDevices.getUserMedia({ audio, video });
    localStream = stream;
    document.getElementById("callBox").classList.remove("hidden");
    document.getElementById("localVideo").srcObject = stream;
    const tracks = stream.getTracks();
    for (let i = 0; i < tracks.length; i++) {
      peer.addTrack(tracks[i], stream);
    }
    addLine("SYS", "Mic/Cam ready.", false);
  } catch (err) {
    addLine("SYS", "Media error: " + err.name, false);
  }
}

async function armScreen() {
  try {
    const peer = getPeer();
    const stream = await navigator.mediaDevices.getDisplayMedia({ video: true, audio: true });
    localStream = stream;
    document.getElementById("callBox").classList.remove("hidden");
    document.getElementById("localVideo").srcObject = stream;
    const tracks = stream.getTracks();
    for (let i = 0; i < tracks.length; i++) {
      peer.addTrack(tracks[i], stream);
    }
    addLine("SYS", "Screen ready.", false);
  } catch (err) {
    addLine("SYS", "Screen error: " + err.name, false);
  }
}

function stopMedia(emit) {
  if (localStream) {
    const tracks = localStream.getTracks();
    for (let i = 0; i < tracks.length; i++) {
      tracks[i].stop();
    }
    localStream = null;
  }

  if (pc) {
    const senders = pc.getSenders();
    for (let i = 0; i < senders.length; i++) {
      if (senders[i].track) pc.removeTrack(senders[i]);
    }
  }

  document.getElementById("localVideo").srcObject = null;
  document.getElementById("remoteVideo").srcObject = null;
  document.getElementById("callBox").classList.add("hidden");

  const muteBtn = document.getElementById("muteBtn");
  muteBtn.innerText = "🔇 Mute Mic";
  muteBtn.classList.remove("recording");

  if (emit && dc && dc.readyState === "open") {
    dc.send(JSON.stringify({ type: "endcall" }));
    addLine("SYS", "Call ended.", false);
  }
}

function toggleMute() {
  if (!localStream) return;
  const audioTracks = localStream.getAudioTracks();
  if (audioTracks.length === 0) return;

  const active = !audioTracks[0].enabled;
  audioTracks[0].enabled = active;

  const btn = document.getElementById("muteBtn");
  if (active) {
    btn.innerText = "🔇 Mute Mic";
    btn.classList.remove("recording");
  } else {
    btn.innerText = "🎤 Unmute Mic";
    btn.classList.add("recording");
  }
}

function setupChannel(channel) {
  dc = channel;
  dc.onopen = () => {
    const badge = document.getElementById("status");
    badge.innerText = "[CONNECTED]";
    badge.className = "status-on";
    document.getElementById("connectDrawer").classList.add("hidden");
    addLine("SYS", "Connected.", false);
  };
  dc.onclose = () => {
    const badge = document.getElementById("status");
    badge.innerText = "[OFFLINE]";
    badge.className = "status-off";
    stopMedia(false);
    addLine("SYS", "Disconnected.", false);
  };
  dc.onmessage = (e) => {
    const pkt = JSON.parse(e.data);
    if (pkt.type === "msg") addLine("FRIEND", pkt.html, true);
    if (pkt.type === "file") {
      addLine("FRIEND", `<a href="${pkt.data}" download="${pkt.name}">💾 ${pkt.name}</a>`, false);
    }
    if (pkt.type === "voice") {
      addLine("FRIEND", `<br><audio controls src="${pkt.data}"></audio>`, false);
    }
    if (pkt.type === "draw") drawLine(pkt.x1, pkt.y1, pkt.x2, pkt.y2, false);
    if (pkt.type === "wipe") wipeBoard(false);
    if (pkt.type === "endcall") stopMedia(false);
    if (pkt.type === "video") syncWatch(pkt);
    if (pkt.type === "ping") dc.send(JSON.stringify({ type: "pong", ts: pkt.ts }));
    if (pkt.type === "pong") addLine("SYS", (Date.now() - pkt.ts) + "ms", false);
  };
}

async function createInvite() {
  try {
    const peer = getPeer();
    setupChannel(peer.createDataChannel("desk"));
    const offer = await peer.createOffer();
    await peer.setLocalDescription(offer);
    document.getElementById("myCode").value = JSON.stringify(peer.localDescription);
    addLine("SYS", "Invite created.", false);
  } catch (err) {
    addLine("SYS", "Error: " + err.message, false);
  }
}

async function joinDesk() {
  const raw = document.getElementById("friendCode").value.trim();
  if (!raw) return;
  try {
    const peer = getPeer();
    await peer.setRemoteDescription(JSON.parse(raw));
    const answer = await peer.createAnswer();
    await peer.setLocalDescription(answer);
    document.getElementById("myCode").value = JSON.stringify(peer.localDescription);
    addLine("SYS", "Reply ready.", false);
  } catch {
    addLine("SYS", "Bad code.", false);
  }
}

async function finishLink() {
  const raw = document.getElementById("friendCode").value.trim();
  if (!raw) return;
  try {
    const peer = getPeer();
    await peer.setRemoteDescription(JSON.parse(raw));
  } catch {
    addLine("SYS", "Bad code.", false);
  }
}

function copyCode() {
  const box = document.getElementById("myCode");
  if (!box.value) return;
  box.select();
  document.execCommand("copy");
  if (navigator.clipboard) navigator.clipboard.writeText(box.value).catch(() => {});
  addLine("SYS", "Copied.", false);
}

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
    localStorage.removeItem("pedesk_logs");
    logs = [];
    chat.innerHTML = "";
    return;
  }

  if (text === "/export") {
    const blob = new Blob([JSON.stringify(logs, null, 2)], { type: "application/json" });
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = "pedesk_notes.json";
    a.click();
    return;
  }

  if (text === "/ping") {
    if (dc && dc.readyState === "open") {
      dc.send(JSON.stringify({ type: "ping", ts: Date.now() }));
    }
    return;
  }

  const clean = cleanLink(text);
  addLine("ME", clean, true);

  if (dc && dc.readyState === "open") {
    dc.send(JSON.stringify({ type: "msg", html: clean }));
  }
}

document.getElementById("msgInput").addEventListener("keypress", (e) => {
  if (e.key === "Enter") sendMsg();
});

function sendFile() {
  const input = document.getElementById("fileSend");
  const file = input.files[0];
  if (!file) return;

  const reader = new FileReader();
  reader.onload = (e) => {
    addLine("ME", `<a href="${e.target.result}" download="${file.name}">💾 ${file.name}</a>`, false);
    if (dc && dc.readyState === "open") {
      dc.send(JSON.stringify({ type: "file", name: file.name, data: e.target.result }));
    }
    input.value = "";
  };
  reader.readAsDataURL(file);
}

async function toggleVoice() {
  const btn = document.getElementById("recBtn");

  if (!recorder || recorder.state === "inactive") {
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      recorder = new MediaRecorder(stream);
      chunks = [];

      recorder.ondataavailable = (e) => chunks.push(e.data);
      recorder.onstop = () => {
        const blob = new Blob(chunks, { type: "audio/webm" });
        const reader = new FileReader();
        reader.onload = (ev) => {
          addLine("ME", `<br><audio controls src="${ev.target.result}"></audio>`, false);
          if (dc && dc.readyState === "open") {
            dc.send(JSON.stringify({ type: "voice", data: ev.target.result }));
          }
        };
        reader.readAsDataURL(blob);
        const tracks = stream.getTracks();
        for (let i = 0; i < tracks.length; i++) {
          tracks[i].stop();
        }
      };

      recorder.start();
      btn.innerText = "⏹ Stop";
      btn.classList.add("recording");
    } catch (err) {
      addLine("SYS", "Mic error: " + err.name, false);
    }
  } else {
    recorder.stop();
    btn.innerText = "🎤 Voice Note";
    btn.classList.remove("recording");
  }
}

function loadWatchVideo() {
  const file = document.getElementById("videoFile").files[0];
  if (!file) return;
  watchVideo.src = URL.createObjectURL(file);
  addLine("SYS", "Loaded video: " + file.name, false);
}

function sendWatch(state) {
if (syncing || !dc || dc.readyState !== "open") return;
dc.send(JSON.stringify({ type: "video", state: state, time: watchVideo.currentTime }));
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
const canvas = document.getElementById("board");
const ctx = canvas.getContext("2d");
ctx.strokeStyle = "#005a36";
ctx.lineWidth = 2;
ctx.lineCap = "round";
let drawing = false;
let lx = 0;
let ly = 0;
function drawLine(x1, y1, x2, y2, emit) {
ctx.beginPath();
ctx.moveTo(x1, y1);
ctx.lineTo(x2, y2);
ctx.stroke();
if (emit && dc && dc.readyState === "open") {
dc.send(JSON.stringify({ type: "draw", x1, y1, x2, y2 }));
}
}
function wipeBoard(emit) {
ctx.clearRect(0, 0, canvas.width, canvas.height);
if (emit && dc && dc.readyState === "open") {
dc.send(JSON.stringify({ type: "wipe" }));
}
}
function saveBoard() {
const a = document.createElement("a");
a.href = canvas.toDataURL("image/png");
a.download = "pedesk_sketch.png";
a.click();
}
canvas.onmousedown = (e) => {
drawing = true;
lx = e.offsetX;
ly = e.offsetY;
};
canvas.onmouseup = () => { drawing = false; };
canvas.onmouseleave = () => { drawing = false; };
canvas.onmousemove = (e) => {
if (!drawing) return;
drawLine(lx, ly, e.offsetX, e.offsetY, true);
lx = e.offsetX;
ly = e.offsetY;
};
canvas.ontouchstart = (e) => {
e.preventDefault();
const rect = canvas.getBoundingClientRect();
drawing = true;
lx = e.touches[0].clientX - rect.left;
ly = e.touches[0].clientY - rect.top;
};
canvas.ontouchend = () => { drawing = false; };
canvas.ontouchmove = (e) => {
e.preventDefault();
if (!drawing) return;
const rect = canvas.getBoundingClientRect();
const cx = e.touches[0].clientX - rect.left;
const cy = e.touches[0].clientY - rect.top;
drawLine(lx, ly, cx, cy, true);
lx = cx;
ly = cy;
};