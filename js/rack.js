// Rendering: CD spines on the shelf + the inline "open album" track panel.

// Deterministic colour from an album id (fallback when there's no cover).
function hashHue(str) {
  let h = 0;
  for (let i = 0; i < str.length; i++) h = (h * 31 + str.charCodeAt(i)) % 360;
  return h;
}
function fallbackStyle(album) {
  const hue = hashHue(album.id || album.name);
  return `linear-gradient(150deg, hsl(${hue} 45% 30%), hsl(${(hue + 24) % 360} 50% 20%))`;
}

function fmtDuration(ms) {
  const s = Math.round(ms / 1000);
  const m = Math.floor(s / 60);
  return `${m}:${String(s % 60).padStart(2, "0")}`;
}

function escapeHtml(s) {
  return String(s || "")
    .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

// ── Shelf of spines ─────────────────────────────────────────
export function renderRack(rackEl, albums, onOpen) {
  rackEl.innerHTML = "";
  albums.forEach(album => {
    const spine = document.createElement("button");
    spine.className = "spine";
    spine.title = `${album.name} — ${album.artist}`;

    if (album.image) {
      // The cover is the spine: zoomed to its left edge so the artwork
      // appears to wrap around, with a scrim (CSS) keeping the text legible.
      spine.classList.add("has-art");
      spine.style.backgroundImage = `url("${album.image}")`;
    } else {
      spine.style.background = fallbackStyle(album);
    }

    const label = document.createElement("span");
    label.className = "spine-label";
    label.innerHTML =
      `<span class="spine-artist">${escapeHtml(album.artist)}</span>` +
      `<span class="spine-title">${escapeHtml(album.name)}</span>`;
    spine.appendChild(label);

    spine.addEventListener("click", () => onOpen(album, spine));
    rackEl.appendChild(spine);
  });
}

// ── Inline track panel that slides out next to the opened cover ──
// Returns the panel element, with .fillTracks() and .setHint() attached.
export function makePanel(album, handlers) {
  const panel = document.createElement("div");
  panel.className = "track-panel";
  const bits = [album.year, album.type].filter(Boolean).join(" · ");

  panel.innerHTML =
    `<div class="track-panel-inner">
       <div class="tp-head">
         <div class="tp-heading">
           <h2 class="tp-title">${escapeHtml(album.name)}</h2>
           <p class="tp-artist">${escapeHtml(album.artist)}</p>
           <p class="tp-meta">${escapeHtml(bits)}</p>
         </div>
         <button class="tp-close" aria-label="Close">✕</button>
       </div>
       <button class="tp-play">▶ Play album</button>
       <p class="tp-hint"></p>
       <ol class="track-list"><li class="track loading">Loading tracks…</li></ol>
     </div>`;

  panel.querySelector(".tp-close").addEventListener("click", handlers.onClose);
  panel.querySelector(".tp-play").addEventListener("click", () => handlers.onPlayAlbum(album));

  panel.fillTracks = tracks => {
    const list = panel.querySelector(".track-list");
    list.innerHTML = "";
    const meta = panel.querySelector(".tp-meta");
    meta.textContent = [album.year, `${tracks.length} tracks`, album.type].filter(Boolean).join(" · ");
    tracks.forEach(track => {
      const li = document.createElement("li");
      li.className = "track";
      li.innerHTML =
        `<span class="track-num">${track.number}</span>` +
        `<span class="track-name">${escapeHtml(track.name)}</span>` +
        `<span class="track-time">${fmtDuration(track.durationMs)}</span>`;
      li.addEventListener("click", () => handlers.onPlayTrack(album, track));
      list.appendChild(li);
    });
  };

  panel.setHint = (msg, isError) => {
    const el = panel.querySelector(".tp-hint");
    el.textContent = msg || "";
    el.classList.toggle("error", !!isError);
  };

  return panel;
}
