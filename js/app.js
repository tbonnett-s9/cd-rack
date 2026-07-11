// App entry point: wires auth, data, rendering, and playback together.
import { isLoggedIn, login, logout, handleRedirectCallback } from "./auth.js";
import { getAlbums, getAlbumTracks, pickDevice, playAlbum } from "./api.js";
import { renderRack, makePanel } from "./rack.js";

const el = id => document.getElementById(id);
const show = (id, on) => { el(id).hidden = !on; };

let currentRange = "recent";
let albumCache = {}; // range → albums[]
let openState = null; // { spineEl, panelEl, shelfEl, otherShelf }

// ── Screens ─────────────────────────────────────────────────
function showLogin(errMsg) {
  show("login", true);
  show("main", false);
  const e = el("loginError");
  if (errMsg) { e.textContent = errMsg; e.hidden = false; }
  else e.hidden = true;
}

function showMain() {
  show("login", false);
  show("main", true);
}

// ── Load & render the shelf for a range ─────────────────────
async function loadRange(range, force) {
  currentRange = range;
  [...document.querySelectorAll("#rangeTabs button")].forEach(b =>
    b.classList.toggle("active", b.dataset.range === range));

  el("rackLoading").hidden = false;
  el("rackWrap").hidden = true;
  try {
    if (force || !albumCache[range]) albumCache[range] = await getAlbums(range);
    const albums = albumCache[range];
    if (!albums.length) {
      el("rackLoading").textContent =
        "No albums found here yet — play some music on Spotify and refresh.";
      return;
    }
    closeAlbum();
    // Split across the two shelves: first half on top, rest on the bottom.
    const mid = Math.ceil(albums.length / 2);
    renderRack(el("rackTop"), albums.slice(0, mid), openAlbum);
    renderRack(el("rackBottom"), albums.slice(mid), openAlbum);
    el("rackLoading").hidden = true;
    el("rackWrap").hidden = false;
  } catch (err) {
    handleApiError(err, "Couldn't load your shelf.");
  }
  updateDeviceLabel();
}

// ── Expand one album in place, inside its shelf ─────────────
async function openAlbum(album, spineEl) {
  // Clicking the already-open cover closes it.
  if (openState && openState.spineEl === spineEl) { closeAlbum(); return; }
  closeAlbum();

  const rackEl = spineEl.parentNode;              // the .rack

  // The spine becomes its square cover.
  spineEl.classList.add("open");

  // Build the track panel and slide it out to the right of the cover.
  const panel = makePanel(album, { onPlayTrack, onPlayAlbum, onClose: closeAlbum });
  rackEl.insertBefore(panel, spineEl.nextSibling);

  openState = { spineEl, panelEl: panel };

  requestAnimationFrame(() => {
    panel.classList.add("open");
    // Keep the cover where it is; only nudge if the panel would overflow.
    requestAnimationFrame(() => {
      const coverW = spineEl.getBoundingClientRect().width;
      const panelW = Math.min(440, window.innerWidth * 0.66);
      const rightEdge = spineEl.offsetLeft + coverW + panelW;
      const viewRight = rackEl.scrollLeft + rackEl.clientWidth;
      if (rightEdge > viewRight) {
        rackEl.scrollTo({ left: rightEdge - rackEl.clientWidth + 16, behavior: "smooth" });
      } else if (spineEl.offsetLeft < rackEl.scrollLeft) {
        rackEl.scrollTo({ left: Math.max(0, spineEl.offsetLeft - 16), behavior: "smooth" });
      }
    });
  });

  try {
    const tracks = await getAlbumTracks(album.id);
    if (openState && openState.panelEl === panel) panel.fillTracks(tracks);
  } catch (err) {
    if (err.status === 401) { handleApiError(err); return; }
    panel.setHint("Couldn't load tracks. " + (err.message || ""), true);
  }
}

function closeAlbum() {
  if (!openState) return;
  const { spineEl, panelEl } = openState;
  spineEl.classList.remove("open");
  panelEl.classList.remove("open");
  setTimeout(() => { if (panelEl.parentNode) panelEl.parentNode.removeChild(panelEl); }, 400);
  openState = null;
}

// Update the play hint inside the currently-open panel, if any.
function playHint(msg, isError) {
  if (openState && openState.panelEl) openState.panelEl.setHint(msg, isError);
}

// ── Playback ────────────────────────────────────────────────
async function onPlayAlbum(album) { await startPlayback(album, null); }
async function onPlayTrack(album, track) { await startPlayback(album, track.uri); }

async function startPlayback(album, offsetUri) {
  playHint("Connecting to a device…", false);
  try {
    const device = await pickDevice();
    if (!device) {
      playHint("No Spotify device found. Open Spotify on a phone, speaker, or computer, start playing, then try again.", true);
      return;
    }
    await playAlbum(album.uri, device.id, offsetUri);
    playHint(`Playing on ${device.name} ▶`, false);
  } catch (err) {
    if (err.status === 403) {
      playHint("Playback control needs Spotify Premium.", true);
    } else if (err.status === 404) {
      playHint("No active device. Start Spotify playing somewhere first, then tap again.", true);
    } else {
      playHint("Couldn't start playback: " + err.message, true);
    }
  }
}

async function updateDeviceLabel() {
  try {
    const d = await pickDevice();
    el("deviceLabel").textContent = d ? `♪ ${d.name}` : "No device";
  } catch { el("deviceLabel").textContent = ""; }
}

// ── Errors ──────────────────────────────────────────────────
function handleApiError(err, fallback) {
  console.error(err);
  if (err.status === 401) { logout(); showLogin("Session expired — please reconnect."); return; }
  el("rackLoading").hidden = false;
  el("rackLoading").textContent = fallback + " " + (err.message || "");
}

// ── Wire up UI ──────────────────────────────────────────────
function wireEvents() {
  el("loginBtn").addEventListener("click", async () => {
    try { await login(); }
    catch (e) { el("loginError").textContent = e.message; el("loginError").hidden = false; }
  });
  el("logoutBtn").addEventListener("click", () => { logout(); showLogin(); });
  el("refreshBtn").addEventListener("click", () => loadRange(currentRange, true));
  [...document.querySelectorAll("#rangeTabs button")].forEach(b =>
    b.addEventListener("click", () => loadRange(b.dataset.range, false)));
}

// ── Boot ────────────────────────────────────────────────────
async function boot() {
  wireEvents();
  try {
    const returned = await handleRedirectCallback();
    if (returned || isLoggedIn()) {
      showMain();
      await loadRange("recent", false);
    } else {
      showLogin();
    }
  } catch (err) {
    showLogin(err.message);
  }
}

boot();
