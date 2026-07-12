// Spotify Authorization Code + PKCE flow — fully client-side, no secret.
import { CLIENT_ID, SCOPES, REDIRECT_URI } from "./config.js?v=7";

const TOKEN_URL = "https://accounts.spotify.com/api/token";
const AUTH_URL = "https://accounts.spotify.com/authorize";
const LS_KEY = "cdrack_tokens";

// ── PKCE helpers ────────────────────────────────────────────
function randomString(len) {
  const chars = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-._~";
  const bytes = new Uint8Array(len);
  crypto.getRandomValues(bytes);
  let out = "";
  for (let i = 0; i < len; i++) out += chars[bytes[i] % chars.length];
  return out;
}

function base64url(buffer) {
  let str = "";
  const bytes = new Uint8Array(buffer);
  for (let i = 0; i < bytes.length; i++) str += String.fromCharCode(bytes[i]);
  return btoa(str).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

async function sha256(text) {
  const data = new TextEncoder().encode(text);
  return crypto.subtle.digest("SHA-256", data);
}

// ── Token storage ───────────────────────────────────────────
function saveTokens(t) {
  t.expires_at = Date.now() + (t.expires_in - 60) * 1000; // refresh 60s early
  localStorage.setItem(LS_KEY, JSON.stringify(t));
}
function loadTokens() {
  try { return JSON.parse(localStorage.getItem(LS_KEY)); } catch { return null; }
}
export function isLoggedIn() {
  const t = loadTokens();
  return !!(t && t.refresh_token);
}
export function logout() {
  localStorage.removeItem(LS_KEY);
  localStorage.removeItem("cdrack_verifier");
}

// ── Step 1: kick off login (redirect to Spotify) ────────────
export async function login() {
  if (!CLIENT_ID || CLIENT_ID.indexOf("PASTE_") === 0) {
    throw new Error("No Client ID set. Edit js/config.js and add your Spotify Client ID.");
  }
  const verifier = randomString(96);
  const challenge = base64url(await sha256(verifier));
  const state = randomString(16);
  localStorage.setItem("cdrack_verifier", verifier);
  localStorage.setItem("cdrack_state", state);

  const params = new URLSearchParams({
    client_id: CLIENT_ID,
    response_type: "code",
    redirect_uri: REDIRECT_URI,
    code_challenge_method: "S256",
    code_challenge: challenge,
    state: state,
    scope: SCOPES
  });
  window.location.href = `${AUTH_URL}?${params.toString()}`;
}

// ── Step 2: on return, exchange ?code for tokens ────────────
// Returns true if a redirect was handled (call this on page load).
export async function handleRedirectCallback() {
  const url = new URL(window.location.href);
  const code = url.searchParams.get("code");
  const err = url.searchParams.get("error");
  const state = url.searchParams.get("state");
  if (!code && !err) return false;

  // Clean the query string out of the URL bar regardless of outcome.
  const cleanUrl = REDIRECT_URI;
  window.history.replaceState({}, document.title, cleanUrl);

  if (err) throw new Error("Spotify authorization was denied: " + err);
  if (state !== localStorage.getItem("cdrack_state")) {
    throw new Error("State mismatch — please try connecting again.");
  }
  const verifier = localStorage.getItem("cdrack_verifier");
  if (!verifier) throw new Error("Missing PKCE verifier — please try connecting again.");

  const body = new URLSearchParams({
    client_id: CLIENT_ID,
    grant_type: "authorization_code",
    code: code,
    redirect_uri: REDIRECT_URI,
    code_verifier: verifier
  });
  const res = await fetch(TOKEN_URL, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: body.toString()
  });
  if (!res.ok) {
    const txt = await res.text();
    throw new Error("Token exchange failed: " + txt);
  }
  saveTokens(await res.json());
  return true;
}

// ── Refresh flow ────────────────────────────────────────────
async function refresh() {
  const t = loadTokens();
  if (!t || !t.refresh_token) throw new Error("Not logged in.");
  const body = new URLSearchParams({
    client_id: CLIENT_ID,
    grant_type: "refresh_token",
    refresh_token: t.refresh_token
  });
  const res = await fetch(TOKEN_URL, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: body.toString()
  });
  if (!res.ok) {
    logout();
    throw new Error("Session expired — please reconnect.");
  }
  const fresh = await res.json();
  // Spotify may omit refresh_token on refresh; keep the old one.
  if (!fresh.refresh_token) fresh.refresh_token = t.refresh_token;
  saveTokens(fresh);
  return fresh.access_token;
}

// ── Get a valid access token (refreshing if needed) ─────────
export async function getAccessToken() {
  const t = loadTokens();
  if (!t) throw new Error("Not logged in.");
  if (Date.now() < t.expires_at) return t.access_token;
  return refresh();
}
