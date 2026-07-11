# CD Rack

A touch-friendly web app that shows your Spotify music as the **spines of CDs on a shelf**.
Tap a spine → the album expands to show its cover and full track listing. Tap a track (or
"Play album") → it plays on any active Spotify device (phone, speaker, computer, this device).

Built as a plain static web app — no build step, no server, no secrets. It runs the same on
an old iPad mini in Safari or a Raspberry Pi in kiosk mode.

---

## What you need

- A **Spotify Premium** account (free accounts can browse but Spotify won't let apps start playback).
- A free **Spotify developer app** (2-minute setup below) for the Client ID.
- Somewhere to serve the files over **HTTPS** when running on the iPad/Pi (a local machine is fine for testing).

---

## 1. Create your Spotify app (one time)

1. Go to <https://developer.spotify.com/dashboard> and log in.
2. **Create app**. Name it anything ("CD Rack"). App type doesn't matter.
3. Copy the **Client ID**.
4. Open [`js/config.js`](js/config.js) and paste it:
   ```js
   export const CLIENT_ID = "your_client_id_here";
   ```
5. Back in the dashboard, open the app's **Settings → Redirect URIs** and add the exact URL
   the page will be served from (trailing slash included). Add every one you'll use, e.g.:
   - `http://127.0.0.1:8000/`  ← local testing
   - `https://yourname.github.io/cd-rack/`  ← if hosting on GitHub Pages
   Save.

> Not sure what URL to register? Open the app, press F12 → Console. It logs the exact
> redirect URI it will use if Spotify rejects it. It must match **character-for-character.**

No client secret is required — the app uses the PKCE flow, which is safe for public/static apps.

---

## 2. Run it locally (to test)

From this folder:

```sh
python3 -m http.server 8000
```

Then open <http://127.0.0.1:8000/> and click **Connect Spotify**.
(Use `127.0.0.1`, not `localhost` — Spotify's redirect rules prefer it.)

---

## 3. Host it (for the iPad / Pi)

Because the iPad can't reach your computer's `127.0.0.1`, put the files on any static HTTPS host.
Easiest free options:

- **GitHub Pages** — push this folder to a repo, enable Pages, register the Pages URL as a redirect URI.
- **Netlify Drop** — drag this folder onto <https://app.netlify.com/drop>, register the given URL.

Whatever URL you get, add it to the Redirect URIs list in the Spotify dashboard (step 1.5).

---

## 4. Set up the touch screen

### Option A — iPad mini (Safari)
1. Open the hosted URL in Safari and connect to Spotify once.
2. **Share → Add to Home Screen** so it launches full-screen with no browser chrome.
3. Optional: **Settings → Accessibility → Guided Access** locks it to this one app for a true kiosk.

> Note on very old iPad minis: the original 2012 mini (iOS 9) lacks some browser features this
> app needs. iPad mini 2/3 (iOS 12) and newer work. Check **Settings → General → About → Version**;
> iOS 12+ is safe.

### Option B — Raspberry Pi + touch display (recommended for a permanent unit)
Install Chromium and launch it in kiosk mode at boot:

```sh
chromium-browser --kiosk --incognito --disable-pinch \
  --overscroll-history-navigation=0 "https://your-hosted-url/"
```

Because the Pi's Chromium is modern, you get smoother touch and could later stream audio on
the Pi itself (Web Playback SDK) instead of only remote-controlling other devices.

---

## How the shelf is populated

The tabs at the top choose what fills the rack:

- **Recent** — albums from your recently played tracks.
- **Weeks / Months / Years** — albums from your Spotify "top tracks" over the short / medium / long term.

Albums are de-duplicated and ranked by how often they show up. Colours on the spines are generated
from each album's ID, so a given album always gets the same spine colour.

---

## Files

| File | Purpose |
|------|---------|
| `index.html` | Page structure |
| `css/styles.css` | The shelf / spine / overlay look |
| `js/config.js` | **Your Client ID goes here** |
| `js/auth.js` | Spotify PKCE login + token refresh |
| `js/api.js` | Spotify Web API calls |
| `js/rack.js` | Renders spines + the expanded album |
| `js/app.js` | Wires it all together |

---

## Troubleshooting

- **"No Client ID set"** — you didn't paste the Client ID into `js/config.js`.
- **"INVALID_CLIENT: Invalid redirect URI"** — the page URL isn't registered in the dashboard, or
  doesn't match exactly (trailing slash!).
- **"Playback control needs Spotify Premium"** — playback start requires Premium; browsing works regardless.
- **"No Spotify device found"** — open Spotify somewhere and start playing once so a device is active,
  then tap the track again.
