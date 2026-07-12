// Now-playing bar, transport controls, device picker, and idle ambient mode.
import {
  getPlayback, resumePlayback, pausePlayback, nextTrack, prevTrack,
  seekTo, setVolume, setShuffle, setRepeat, transferPlayback, getDevices
} from "./api.js?v=6";

const el = id => document.getElementById(id);
const artOf = it => (it && it.album && it.album.images && it.album.images[0] && it.album.images[0].url) || "";
const fmt = ms => { const s = Math.round(ms / 1000); return Math.floor(s / 60) + ":" + String(s % 60).padStart(2, "0"); };

let state = null;          // last playback state from Spotify
let localProgress = 0;     // ms, ticked locally between polls
let lastPollTs = 0;
let seeking = false;       // user dragging the scrubber
let volLockUntil = 0;      // ignore incoming volume right after user sets it
let ambientOn = false;
let idleTimer = null;

const IDLE_MS = 60000;     // 60s of no interaction → ambient mode

export function initPlayer() {
  el("npPlay").onclick = togglePlay;
  el("npPrev").onclick = () => run(prevTrack);
  el("npNext").onclick = () => run(nextTrack);
  el("npShuffle").onclick = toggleShuffle;
  el("npRepeat").onclick = cycleRepeat;
  el("npDevice").onclick = toggleDevicePicker;

  const seek = el("npSeek");
  seek.addEventListener("input", () => { seeking = true; el("npCur").textContent = fmt(seekMs()); });
  seek.addEventListener("change", onSeek);
  el("npVol").addEventListener("change", onVolume);

  el("ambient").onclick = exitAmbient;
  ["mousedown", "touchstart", "keydown", "wheel"].forEach(ev =>
    window.addEventListener(ev, onActivity, { passive: true }));

  document.addEventListener("visibilitychange", () => { if (!document.hidden) poll(); });

  poll();
  setInterval(poll, 4000);
  setInterval(tick, 1000);
  resetIdle();
}

// Called by the shelf after it starts an album, so the bar updates promptly.
export function refreshPlayer() { setTimeout(poll, 500); setTimeout(poll, 1500); }

async function poll() {
  if (document.hidden) return;
  try { applyState(await getPlayback()); } catch (e) { /* keep last state */ }
}

function applyState(s) {
  state = s;
  lastPollTs = Date.now();
  localProgress = (s && s.progress_ms) || 0;
  renderBar();
  if (ambientOn) renderAmbient();
}

function renderBar() {
  const bar = el("nowbar");
  if (!state || !state.item) { bar.hidden = true; return; }
  bar.hidden = false;
  const it = state.item;
  el("npArt").src = artOf(it);
  el("npTitle").textContent = it.name || "";
  el("npArtist").textContent = (it.artists || []).map(a => a.name).join(", ");
  el("npPlay").textContent = state.is_playing ? "⏸" : "▶";
  el("npShuffle").classList.toggle("active", !!state.shuffle_state);
  el("npRepeat").classList.toggle("active", state.repeat_state && state.repeat_state !== "off");
  el("npRepeat").textContent = state.repeat_state === "track" ? "🔂" : "🔁";
  el("npDevice").textContent = "♪ " + ((state.device && state.device.name) || "Device");
  if (state.device && typeof state.device.volume_percent === "number" && Date.now() > volLockUntil) {
    el("npVol").value = state.device.volume_percent;
  }
  el("npDur").textContent = fmt(it.duration_ms || 0);
  updateSeekUI();
}

function tick() {
  if (!state || !state.is_playing || !state.item) return;
  localProgress = Math.min(state.item.duration_ms || 0, (state.progress_ms || 0) + (Date.now() - lastPollTs));
  updateSeekUI();
}

function updateSeekUI() {
  if (seeking || !state || !state.item) return;
  const dur = state.item.duration_ms || 0;
  el("npSeek").value = dur ? (localProgress / dur) * 1000 : 0;
  el("npCur").textContent = fmt(localProgress);
}

function seekMs() {
  const dur = state && state.item ? state.item.duration_ms || 0 : 0;
  return (parseInt(el("npSeek").value, 10) / 1000) * dur;
}

// ── Controls ────────────────────────────────────────────────
function run(fn) { fn().then(soon).catch(() => {}); }
function soon() { setTimeout(poll, 400); }

async function togglePlay() {
  if (!state) return;
  try {
    if (state.is_playing) { await pausePlayback(); state.is_playing = false; }
    else { await resumePlayback(); state.is_playing = true; }
    renderBar();
  } catch (e) {}
  soon();
}
async function toggleShuffle() {
  if (!state) return;
  try { await setShuffle(!state.shuffle_state); state.shuffle_state = !state.shuffle_state; renderBar(); } catch (e) {}
}
async function cycleRepeat() {
  if (!state) return;
  const next = { off: "context", context: "track", track: "off" }[state.repeat_state || "off"];
  try { await setRepeat(next); state.repeat_state = next; renderBar(); } catch (e) {}
}
async function onSeek() {
  const ms = seekMs();
  try { await seekTo(ms); } catch (e) {}
  seeking = false; localProgress = ms; lastPollTs = Date.now();
  if (state) state.progress_ms = ms;
  soon();
}
async function onVolume() {
  volLockUntil = Date.now() + 1500;
  try { await setVolume(parseInt(el("npVol").value, 10)); } catch (e) {}
}

// ── Device picker ───────────────────────────────────────────
async function toggleDevicePicker() {
  const box = el("devicePicker");
  if (!box.hidden) { box.hidden = true; return; }
  box.innerHTML = "<div class='dp-msg'>Loading…</div>";
  box.hidden = false;
  try {
    const devs = await getDevices();
    box.innerHTML = "";
    if (!devs.length) { box.innerHTML = "<div class='dp-msg'>No devices. Open Spotify on a speaker, phone or computer.</div>"; return; }
    devs.forEach(d => {
      const b = document.createElement("button");
      b.className = "dp-item" + (d.is_active ? " active" : "");
      b.textContent = d.name;
      b.onclick = async () => { try { await transferPlayback(d.id, state ? state.is_playing : true); } catch (e) {} box.hidden = true; soon(); };
      box.appendChild(b);
    });
  } catch (e) { box.innerHTML = "<div class='dp-msg'>Couldn't load devices.</div>"; }
}

// ── Idle → ambient mode ─────────────────────────────────────
function onActivity() { if (ambientOn) exitAmbient(); else resetIdle(); }
function resetIdle() { clearTimeout(idleTimer); idleTimer = setTimeout(enterAmbient, IDLE_MS); }

function enterAmbient() {
  if (!state || !state.item || !state.is_playing) { resetIdle(); return; }  // only when music is playing
  ambientOn = true;
  renderAmbient();
  el("ambient").hidden = false;
  requestAnimationFrame(() => el("ambient").classList.add("show"));
}
function exitAmbient() {
  ambientOn = false;
  el("ambient").classList.remove("show");
  setTimeout(() => { if (!ambientOn) el("ambient").hidden = true; }, 500);
  resetIdle();
}
function renderAmbient() {
  if (!state || !state.item) return;
  const it = state.item, art = artOf(it);
  el("ambArt").src = art;
  el("ambBg").style.backgroundImage = art ? "url('" + art + "')" : "";
  el("ambTitle").textContent = it.name || "";
  el("ambArtist").textContent = (it.artists || []).map(a => a.name).join(", ");
}
