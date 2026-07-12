// App entry point: wires auth, data, rendering, and playback together.
import { isLoggedIn, login, logout, handleRedirectCallback } from "./auth.js?v=4";
import { getAlbums, getAlbumTracks, pickDevice, playAlbum,
         searchArtists, getArtistDiscography, isRateLimited } from "./api.js?v=4";
import { renderRack, makePanel } from "./rack.js?v=4";

const el = id => document.getElementById(id);
const show = (id, on) => { el(id).hidden = !on; };

// The rack shows one "view" at a time: a library range, or an artist's discography.
let currentView = { type: "range", range: "recent" };
let currentAlbums = [];       // full (unfiltered) album list for the current view
let currentFilter = "all";    // "all" | "album" | "single" | "compilation"
let albumCache = {};          // view key → albums[]
let openState = null;         // { spineEl, panelEl }

// Below this viewport height, use a single shelf (two would be too short).
const ONE_SHELF_MAX_HEIGHT = 800;

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

// ── Switch to a library range (Recent / Weeks / …) ──────────
function selectRange(range) {
  currentView = { type: "range", range };
  el("artistChip").hidden = true;
  resetFilter();
  [...document.querySelectorAll("#rangeTabs button")].forEach(b =>
    b.classList.toggle("active", b.dataset.range === range));
  loadCurrent(false);
}

// ── Switch to an artist's discography ───────────────────────
function selectArtist(id, name) {
  currentView = { type: "artist", id, name };
  resetFilter();
  [...document.querySelectorAll("#rangeTabs button")].forEach(b => b.classList.remove("active"));
  const chip = el("artistChip");
  chip.hidden = false;
  chip.querySelector(".chip-name").textContent = name;
  loadCurrent(false);
}

// ── Album-list cache (survives reloads to avoid re-hitting the API) ──
const CACHE_PREFIX = "cdrack_albums_";
const cacheTtl = key => key.startsWith("artist:") ? 24 * 60 * 60 * 1000 : 30 * 60 * 1000;
function cacheGet(key, ignoreTtl) {
  try {
    const raw = localStorage.getItem(CACHE_PREFIX + key);
    if (!raw) return null;
    const obj = JSON.parse(raw);
    if (!ignoreTtl && Date.now() - obj.t > cacheTtl(key)) return null;
    return obj.albums;
  } catch { return null; }
}
function cacheSet(key, albums) {
  try { localStorage.setItem(CACHE_PREFIX + key, JSON.stringify({ t: Date.now(), albums })); }
  catch { /* storage full — ignore */ }
}

function showAlbums(albums) {
  closeAlbum();
  renderShelves(albums);
  el("rackLoading").hidden = true;
  el("rackWrap").hidden = false;
}

// ── Load & render whatever the current view is ──────────────
async function loadCurrent(force) {
  const key = currentView.type === "range"
    ? `range:${currentView.range}`
    : `artist:${currentView.id}`;

  // Serve from cache (memory or localStorage) unless the user forced a refresh.
  if (!force) {
    const cached = albumCache[key] || cacheGet(key);
    if (cached && cached.length) {
      albumCache[key] = cached;
      showAlbums(cached);
      updateDeviceLabel();
      return;
    }
  }

  el("rackLoading").textContent = "Loading your shelf…";
  el("rackLoading").hidden = false;
  el("rackWrap").hidden = true;
  try {
    const albums = currentView.type === "range"
      ? await getAlbums(currentView.range)
      : await getArtistDiscography(currentView.id);
    albumCache[key] = albums;
    if (albums.length) cacheSet(key, albums);
    if (!albums.length) {
      const stale = cacheGet(key, true);
      if (stale && stale.length) { albumCache[key] = stale; showAlbums(stale); }
      else if (isRateLimited()) {
        el("rackLoading").textContent = "Spotify is rate-limiting the app. Wait a minute, then tap ↻ to refresh.";
      } else {
        el("rackLoading").textContent = currentView.type === "artist"
          ? "No releases found for this artist."
          : "No albums found here yet — play some music on Spotify and refresh.";
      }
      return;
    }
    showAlbums(albums);
  } catch (err) {
    // Prefer showing stale cached albums over an error screen.
    const stale = cacheGet(key, true);
    if (stale && stale.length) { albumCache[key] = stale; showAlbums(stale); }
    else handleApiError(err, "Couldn't load your shelf.");
  }
  updateDeviceLabel();
}

// Store the full list, then filter + lay out.
function renderShelves(albums) {
  currentAlbums = albums;
  applyFilterAndLayout();
}

// Reset the type filter back to "All" (on a new view).
function resetFilter() {
  currentFilter = "all";
  [...document.querySelectorAll("#filterBar button")].forEach(b =>
    b.classList.toggle("active", b.dataset.type === "all"));
}

// Apply the current type filter and lay albums onto one or two shelves.
function applyFilterAndLayout() {
  const hasAny = !!(currentAlbums && currentAlbums.length);
  el("filterBar").hidden = !hasAny;

  const albums = currentFilter === "all"
    ? currentAlbums
    : currentAlbums.filter(a => a.type === currentFilter);

  const empty = el("rackEmpty");
  if (hasAny && !albums.length) {
    const labels = { album: "albums", single: "singles", compilation: "compilations" };
    empty.textContent = "No " + (labels[currentFilter] || "items") + " here.";
    empty.hidden = false;
  } else {
    empty.hidden = true;
  }

  const single = window.innerHeight < ONE_SHELF_MAX_HEIGHT;
  el("rackWrap").classList.toggle("single", single);
  if (single) {
    renderRack(el("rackTop"), albums, openAlbum);
    renderRack(el("rackBottom"), [], openAlbum);
  } else {
    const mid = Math.ceil(albums.length / 2);
    renderRack(el("rackTop"), albums.slice(0, mid), openAlbum);
    renderRack(el("rackBottom"), albums.slice(mid), openAlbum);
  }
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
  if (err.status === 429) {
    el("rackLoading").textContent = "Spotify is rate-limiting the app. Wait a minute, then tap ↻ to refresh.";
    return;
  }
  el("rackLoading").textContent = fallback + " " + (err.message || "");
}

// ── Wire up UI ──────────────────────────────────────────────
function wireEvents() {
  el("loginBtn").addEventListener("click", async () => {
    try { await login(); }
    catch (e) { el("loginError").textContent = e.message; el("loginError").hidden = false; }
  });
  el("logoutBtn").addEventListener("click", () => { logout(); showLogin(); });
  el("refreshBtn").addEventListener("click", () => loadCurrent(true));
  [...document.querySelectorAll("#rangeTabs button")].forEach(b =>
    b.addEventListener("click", () => selectRange(b.dataset.range)));

  // Type filter (All / Albums / Singles / Compilations).
  [...document.querySelectorAll("#filterBar button")].forEach(b =>
    b.addEventListener("click", () => {
      currentFilter = b.dataset.type;
      [...document.querySelectorAll("#filterBar button")].forEach(x => x.classList.toggle("active", x === b));
      closeAlbum();
      applyFilterAndLayout();
    }));

  // Artist chip ✕ → back to the last library range.
  el("artistChip").querySelector(".chip-close").addEventListener("click", () =>
    selectRange(currentView.type === "range" ? currentView.range : "recent"));

  wireSearch();

  // Re-flow the shelves on rotate/resize (crossing the height breakpoint).
  let resizeTimer, lastSingle = window.innerHeight < ONE_SHELF_MAX_HEIGHT;
  window.addEventListener("resize", () => {
    clearTimeout(resizeTimer);
    resizeTimer = setTimeout(() => {
      const nowSingle = window.innerHeight < ONE_SHELF_MAX_HEIGHT;
      if (nowSingle === lastSingle) return; // only re-render when it actually changes
      lastSingle = nowSingle;
      if (currentAlbums.length && !el("main").hidden) {
        closeAlbum();
        renderShelves(currentAlbums);
      }
    }, 200);
  });
}

// ── Artist search ───────────────────────────────────────────
function wireSearch() {
  const input = el("searchInput");
  const results = el("searchResults");
  let timer, seq = 0;

  const hide = () => { results.hidden = true; results.innerHTML = ""; };

  input.addEventListener("input", () => {
    const q = input.value.trim();
    clearTimeout(timer);
    if (q.length < 2) { hide(); return; }
    timer = setTimeout(async () => {
      const mine = ++seq;
      try {
        const artists = await searchArtists(q);
        if (mine !== seq) return; // a newer query superseded this one
        renderSearchResults(artists);
      } catch (err) { handleApiError(err, "Search failed."); }
    }, 250);
  });

  function renderSearchResults(artists) {
    results.innerHTML = "";
    if (!artists.length) { results.hidden = true; return; }
    artists.forEach(a => {
      const row = document.createElement("div");
      row.className = "search-result";
      const sub = a.followers ? `${a.followers.toLocaleString()} followers` : "Artist";
      row.innerHTML =
        `<img src="${a.image || ""}" alt="" />` +
        `<span class="sr-text"><span class="sr-name"></span><span class="sr-sub">${sub}</span></span>`;
      row.querySelector(".sr-name").textContent = a.name;
      row.addEventListener("click", () => {
        hide();
        input.value = "";
        input.blur();
        selectArtist(a.id, a.name);
      });
      results.appendChild(row);
    });
    results.hidden = false;
  }

  // Dismiss the dropdown when tapping elsewhere.
  document.addEventListener("click", e => {
    if (!el("searchInput").parentNode.contains(e.target)) hide();
  });
}

// ── Boot ────────────────────────────────────────────────────
async function boot() {
  wireEvents();
  try {
    const returned = await handleRedirectCallback();
    if (returned || isLoggedIn()) {
      showMain();
      selectRange("recent");
    } else {
      showLogin();
    }
  } catch (err) {
    showLogin(err.message);
  }
}

boot();
