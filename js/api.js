// Thin wrapper over the Spotify Web API.
import { getAccessToken } from "./auth.js?v=3";
import { MAX_ALBUMS, MARKET } from "./config.js?v=3";

const BASE = "https://api.spotify.com/v1";

const sleep = ms => new Promise(r => setTimeout(r, ms));

// Global request gate: never let more than MAX_INFLIGHT requests run at
// once, so we never burst hard enough to trip Spotify's rate limit.
const MAX_INFLIGHT = 3;
let inflight = 0;
const waiters = [];
function acquire() {
  if (inflight < MAX_INFLIGHT) { inflight++; return Promise.resolve(); }
  return new Promise(res => waiters.push(res));
}
function release() {
  inflight--;
  const next = waiters.shift();
  if (next) { inflight++; next(); }
}

// Circuit breaker: after a rate-limit, refuse all requests until this time,
// so a single 429 doesn't turn into a storm of failing calls.
let blockedUntil = 0;
export function isRateLimited() { return Date.now() < blockedUntil; }
function rateLimitError() { const e = new Error("Rate limited — cooling down"); e.status = 429; return e; }

async function api(path, opts = {}, retries = 2) {
  if (Date.now() < blockedUntil) throw rateLimitError();
  const token = await getAccessToken();
  await acquire();
  // Re-check after waiting for a slot — the breaker may have tripped meanwhile.
  if (Date.now() < blockedUntil) { release(); throw rateLimitError(); }
  let res;
  try {
    res = await fetch(BASE + path, {
      ...opts,
      headers: {
        Authorization: "Bearer " + token,
        "Content-Type": "application/json",
        ...(opts.headers || {})
      }
    });
  } finally {
    release(); // free the slot before any retry wait
  }
  if (res.status === 429) {
    const ra = parseInt(res.headers.get("Retry-After") || "1", 10);
    const secs = Number.isNaN(ra) ? 1 : ra;
    // Only retry very short, transient limits.
    if (retries > 0 && secs <= 3) {
      await sleep(secs * 1000 + 300);
      return api(path, opts, retries - 1);
    }
    // Otherwise trip the breaker so sibling/later calls stop hammering.
    blockedUntil = Date.now() + Math.min(Math.max(secs, 5), 60) * 1000;
  }
  if (res.status === 204) return null; // No Content (common for player calls)
  if (!res.ok) {
    let detail = "";
    try { detail = (await res.json()).error?.message || ""; } catch {}
    const e = new Error(detail || `Spotify API ${res.status}`);
    e.status = res.status;
    throw e;
  }
  const text = await res.text();
  return text ? JSON.parse(text) : null;
}

// Normalise a Spotify album object down to what the shelf needs.
function toAlbum(album) {
  const img = (album.images && album.images[0] && album.images[0].url) || "";
  return {
    id: album.id,
    uri: album.uri,
    name: album.name,
    artist: (album.artists || []).map(a => a.name).join(", "),
    image: img,
    year: (album.release_date || "").slice(0, 4),
    totalTracks: album.total_tracks,
    type: album.album_type
  };
}

// Run a fetch that might fail (e.g. a source needing a scope the user
// hasn't granted) without letting it break the whole rack.
async function safe(fn) {
  try { return await fn(); } catch (e) { console.warn("source skipped:", e.message); return []; }
}

// Build a ranked, de-duplicated list of albums for a given range.
// The selected tab is the PRIMARY source (weighted highest); we then fold
// in every other library source we can reach to fill the shelves.
export async function getAlbums(range) {
  const albums = new Map(); // id → { album, score }
  const bump = (album, weight) => {
    if (!album || !album.id) return;
    const existing = albums.get(album.id);
    if (existing) existing.score += weight;
    else albums.set(album.id, { album: toAlbum(album), score: weight });
  };

  // 1) Primary source for the chosen tab — dominates the ordering.
  const primary = range === "recent"
    ? await safe(fetchRecent)
    : await safe(() => fetchTopTracks(range));
  const pn = primary.length;
  primary.forEach((t, i) => bump(t.album, (pn - i) * 4));

  // 2) Broadening sources. Kept lean to stay well under the rate limit.
  const [saved, liked] = await Promise.all([
    safe(fetchSavedAlbums),          // "Your Library" albums (needs user-library-read)
    safe(fetchLikedTrackAlbums)      // albums behind liked songs (needs user-library-read)
  ]);

  saved.forEach((a, i) => bump(a, 350 - Math.min(i, 300)));   // explicitly saved → prominent
  liked.forEach(a => bump(a, 40));                            // one hit per liked track in the album

  return [...albums.values()]
    .sort((a, b) => b.score - a.score)
    .slice(0, MAX_ALBUMS)
    .map(x => x.album);
}

// Follow Spotify's `next` links to page through any list endpoint.
async function paginate(startPath, maxPages, pick) {
  const out = [];
  let path = startPath;
  for (let p = 0; p < maxPages; p++) {
    const data = await api(path);
    const items = data?.items || [];
    items.forEach(it => { const v = pick(it); if (v) out.push(v); });
    if (!data?.next || items.length === 0) break;
    path = data.next.replace("https://api.spotify.com/v1", "");
  }
  return out;
}

// Several pages of top tracks (API caps each page at 50).
async function fetchTopTracks(range) {
  const out = [];
  for (const offset of [0, 49]) {
    const data = await api(`/me/top/tracks?limit=50&offset=${offset}&time_range=${range}`);
    const items = data?.items || [];
    out.push(...items);
    if (items.length < 50) break;
  }
  return out;
}

// Walk back through recently-played history via the `before` cursor.
async function fetchRecent(maxPages = 3) {
  const out = [];
  let url = "/me/player/recently-played?limit=50";
  for (let p = 0; p < maxPages; p++) {
    const data = await api(url);
    const items = data?.items || [];
    out.push(...items.map(it => ({ album: it.track && it.track.album })));
    const before = data && data.cursors && data.cursors.before;
    if (!before || items.length < 50) break;
    url = `/me/player/recently-played?limit=50&before=${before}`;
  }
  return out;
}

// Saved albums from "Your Library".
function fetchSavedAlbums() {
  return paginate("/me/albums?limit=50", 3, it => it.album);
}

// Albums behind the user's liked songs.
function fetchLikedTrackAlbums() {
  return paginate("/me/tracks?limit=50", 2, it => it.track && it.track.album);
}

// Full track listing for one album.
export async function getAlbumTracks(albumId) {
  const data = await api(`/albums/${albumId}/tracks?limit=50`);
  return (data?.items || []).map(t => ({
    uri: t.uri,
    name: t.name,
    number: t.track_number,
    disc: t.disc_number,
    durationMs: t.duration_ms,
    artist: (t.artists || []).map(a => a.name).join(", ")
  }));
}

// ── Search & artist discography ─────────────────────────────
export async function searchArtists(query) {
  const data = await api(`/search?type=artist&limit=8&q=${encodeURIComponent(query)}`);
  return (data?.artists?.items || []).map(a => ({
    id: a.id,
    name: a.name,
    // Smallest image is plenty for a result thumbnail.
    image: (a.images && (a.images[a.images.length - 1] || a.images[0]) || {}).url || "",
    followers: (a.followers && a.followers.total) || 0
  }));
}

// An artist's full discography, newest first. Every edition is kept
// (deluxe, remaster, single, etc.); only exact-duplicate IDs from
// pagination are collapsed.
export async function getArtistDiscography(artistId) {
  const byId = new Map();
  // This endpoint caps `limit` far lower than the library endpoints (50 → 400
  // "Invalid limit"), so page in small chunks and follow `next`.
  let path = `/artists/${artistId}/albums?include_groups=album,single,compilation&limit=10&market=${MARKET}`;
  for (let p = 0; p < 20; p++) {
    const data = await api(path);
    (data?.items || []).forEach(a => { if (a && a.id && !byId.has(a.id)) byId.set(a.id, a); });
    if (!data?.next) break;
    path = data.next.replace("https://api.spotify.com/v1", "");
  }
  return [...byId.values()]
    .sort((x, y) => (y.release_date || "").localeCompare(x.release_date || ""))
    .map(toAlbum);
}

// ── Playback ────────────────────────────────────────────────
export async function getDevices() {
  const data = await api("/me/player/devices");
  return data?.devices || [];
}

// Pick the active device, else the first available one.
export async function pickDevice() {
  const devices = await getDevices();
  if (!devices.length) return null;
  return devices.find(d => d.is_active) || devices[0];
}

// Play a whole album (optionally starting at a given track uri).
export async function playAlbum(albumUri, deviceId, offsetUri) {
  const q = deviceId ? `?device_id=${deviceId}` : "";
  const body = { context_uri: albumUri };
  if (offsetUri) body.offset = { uri: offsetUri };
  await api(`/me/player/play${q}`, { method: "PUT", body: JSON.stringify(body) });
}
