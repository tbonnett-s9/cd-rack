// ─────────────────────────────────────────────────────────────
//  CONFIG — fill in your Spotify app's Client ID below.
//
//  1. Go to https://developer.spotify.com/dashboard  → Create app
//  2. Copy the "Client ID" and paste it below.
//  3. In the app's Settings → "Redirect URIs", add the exact URL
//     this page is served from. For example:
//        - Local testing:   http://127.0.0.1:5173/
//        - GitHub Pages:     https://yourname.github.io/cd-rack/
//     (The redirect URI must match the page URL character-for-character,
//      including the trailing slash.)
//  4. Save. No client secret is needed — this uses PKCE.
// ─────────────────────────────────────────────────────────────

export const CLIENT_ID = "d1af7c792eae4b81923e05f9e552c903";

// Permissions we ask Spotify for. Don't change unless you know why.
export const SCOPES = [
  "user-top-read",             // top tracks / artists
  "user-read-recently-played", // recently played
  "user-library-read",         // saved albums + liked songs
  "user-read-playback-state",  // see active devices
  "user-modify-playback-state" // start playback on a device
].join(" ");

// The redirect URI is derived automatically from the current page URL,
// so it works the same locally and when hosted. Whatever this prints in
// the browser console MUST be registered in the Spotify dashboard.
export const REDIRECT_URI = window.location.origin + window.location.pathname;

// How many albums to show on the shelf (split across the two shelves).
export const MAX_ALBUMS = 250;

// Country market (ISO 3166-1 alpha-2) for artist discographies. Using a single
// market avoids the same album being listed once per country. Change to yours.
export const MARKET = "GB";
