// Discover: playlists from ListenBrainz (listenbrainz.org), an open, non-profit music
// service with a public API — no account or key needed to read it.
//   - search everyone's public playlists
//   - "LB Radio": instant mixes from prompts like  artist:(Drowning Pool)  or  tag:(nu metal)
//   - a user's "Created for you" playlists (Weekly Jams, Weekly Exploration, …)
// ListenBrainz lists songs by title + artist, so the renderer looks each one up on Spotify.
// Those lookups are cached here on disk so a playlist only has to be matched once.

const fs = require('fs');
const path = require('path');
const { app, safeStorage } = require('electron');

const LB = 'https://api.listenbrainz.org/1';
const UA = 'SweetSpot/0.1 (personal desktop Spotify player)';
const PLAYLIST_TTL = 10 * 60 * 1000;
const MATCH_TTL = 60 * 24 * 60 * 60 * 1000; // 60 days
const MISS_TTL = 7 * 24 * 60 * 60 * 1000;   // retry "not found" after a week
const MAX_MATCHES = 8000;

const playlistCache = new Map();

// ---------- ListenBrainz user token (needed for LB Radio since late 2025) ----------
// Stored encrypted with Windows' data protection, like the Spotify sign-in.
const tokenFile = () => path.join(app.getPath('userData'), 'lb-token.bin');
let lbToken = null;
let lbUser = null;
(function loadToken() {
  try {
    const buf = fs.readFileSync(tokenFile());
    const json = JSON.parse(safeStorage.isEncryptionAvailable() ? safeStorage.decryptString(buf) : buf.toString());
    lbToken = json.token || null;
    lbUser = json.user || null;
  } catch {}
})();

function saveToken() {
  if (!lbToken) { try { fs.unlinkSync(tokenFile()); } catch {} return; }
  const json = JSON.stringify({ token: lbToken, user: lbUser });
  fs.writeFileSync(tokenFile(), safeStorage.isEncryptionAvailable() ? safeStorage.encryptString(json) : Buffer.from(json));
}

async function setToken(token) {
  const t = String(token || '').trim();
  if (!t) { lbToken = null; lbUser = null; saveToken(); return { connected: false }; }
  const res = await fetch(`${LB}/validate-token`, { headers: { 'User-Agent': UA, Authorization: `Token ${t}` } });
  const body = await res.json().catch(() => ({}));
  if (!res.ok || body.valid === false) throw new Error('That token wasn’t accepted. Copy it again from listenbrainz.org → Settings.');
  lbToken = t;
  lbUser = body.user_name || null;
  saveToken();
  return { connected: true, user: lbUser };
}

const tokenStatus = () => ({ connected: !!lbToken, user: lbUser });

async function lb(p, query) {
  const url = new URL(LB + p);
  if (query) for (const [k, v] of Object.entries(query)) if (v !== undefined && v !== null && v !== '') url.searchParams.set(k, v);
  for (let attempt = 0; attempt < 2; attempt++) {
    const headers = { 'User-Agent': UA, Accept: 'application/json' };
    if (lbToken) headers.Authorization = `Token ${lbToken}`;
    const res = await fetch(url, { headers });
    if (res.status === 429 && attempt === 0) {
      const wait = Math.min(Number(res.headers.get('X-RateLimit-Reset-In') || 2), 10) * 1000;
      await new Promise((r) => setTimeout(r, wait));
      continue;
    }
    const body = await res.json().catch(() => null);
    if (!res.ok) {
      const msg = (body && (body.error || body.message)) || `ListenBrainz error ${res.status}`;
      throw Object.assign(new Error(msg), { status: res.status });
    }
    return body;
  }
  throw new Error('ListenBrainz is busy, try again in a moment.');
}

const mbidOf = (identifier) => {
  const s = Array.isArray(identifier) ? identifier[0] : identifier;
  return String(s || '').split('/').filter(Boolean).pop() || null;
};

const stripHtml = (s) => String(s || '').replace(/<[^>]+>/g, ' ').replace(/&amp;/g, '&').replace(/&quot;/g, '"').replace(/&#39;|&#x27;/g, "'").replace(/\s+/g, ' ').trim();

function slimPlaylist(p) {
  const ext = (p.extension || {})['https://musicbrainz.org/doc/jspf#playlist'] || {};
  const algo = ext.additional_metadata && ext.additional_metadata.algorithm_metadata;
  return {
    id: mbidOf(p.identifier),
    title: p.title || 'Untitled playlist',
    creator: p.creator || ext.created_for || '',
    description: stripHtml(p.annotation),
    date: p.date || null,
    createdFor: ext.created_for || null,
    kind: (algo && algo.source_patch) || null,
    count: Array.isArray(p.track) && p.track.length ? p.track.length : null,
    modified: ext.last_modified_at || null,
    collaborators: Array.isArray(ext.collaborators) ? ext.collaborators.length : 0,
    copied: !!(ext.copied_from_mbid || ext.copied_from_deleted)
  };
}

function slimTracks(p) {
  return (p.track || []).map((t) => {
    const ext = (t.extension || {})['https://musicbrainz.org/doc/jspf#track'] || {};
    const am = ext.additional_metadata || {};
    // Artist names as credited (handles "A feat. B"); fall back to the creator string.
    const credits = Array.isArray(am.artists) ? am.artists.map((a) => a.artist_credit_name || a.name).filter(Boolean) : [];
    return {
      title: t.title || '',
      artist: t.creator || credits.join(', '),
      artists: credits.length ? credits : [t.creator || ''],
      album: t.album || null,
      mbid: mbidOf(t.identifier),
      durationMs: t.duration || null,
      cover: am.caa_release_mbid && am.caa_id ? `https://coverartarchive.org/release/${am.caa_release_mbid}/${am.caa_id}-250.jpg` : null
    };
  }).filter((t) => t.title);
}

// Search can return the same playlist more than once (one row per collaborator), so drop repeats.
const listOf = (body) => {
  const seen = new Set();
  return ((body && body.playlists) || []).map((x) => slimPlaylist(x.playlist || x))
    .filter((p) => p.id && !seen.has(p.id) && seen.add(p.id));
};

const searchCache = new Map();
async function searchPlaylists(query) {
  const key = String(query).toLowerCase().trim();
  const hit = searchCache.get(key);
  if (hit && Date.now() - hit.at < PLAYLIST_TTL) return hit.list;
  const list = listOf(await lb('/playlist/search', { query, count: 40 }));
  searchCache.set(key, { at: Date.now(), list });
  return list;
}

async function getPlaylist(id) {
  const hit = playlistCache.get(id);
  if (hit && Date.now() - hit.at < PLAYLIST_TTL) return hit.data;
  const body = await lb(`/playlist/${encodeURIComponent(id)}`);
  const p = body.playlist || body;
  const tracks = slimTracks(p);
  const data = { ...slimPlaylist(p), tracks, count: tracks.length, durationMs: tracks.reduce((n, t) => n + (t.durationMs || 0), 0) };
  playlistCache.set(id, { at: Date.now(), data });
  return data;
}

async function radio(prompt, mode = 'easy') {
  if (!lbToken) throw new Error('NEEDS_TOKEN');
  const body = await lb('/explore/lb-radio', { prompt, mode });
  const payload = body.payload || body;
  const p = (payload.jspf && (payload.jspf.playlist || payload.jspf)) || {};
  const feedback = (payload.feedback || []).map((f) => (typeof f === 'string' ? f : f.message || JSON.stringify(f)));
  return { ...slimPlaylist(p), title: p.title || prompt, tracks: slimTracks(p), feedback };
}

async function createdFor(user) {
  const body = await lb(`/user/${encodeURIComponent(user)}/playlists/createdfor`, { count: 25 });
  return listOf(body);
}

// ---------- Spotify match cache ----------
const matchFile = () => path.join(app.getPath('userData'), 'spotify-matches.json');
let matches = null;
let saveTimer = null;

function loadMatches() {
  if (matches) return matches;
  try { matches = JSON.parse(fs.readFileSync(matchFile(), 'utf8')); } catch { matches = {}; }
  return matches;
}

function getMatches(keys) {
  const m = loadMatches();
  const out = {};
  const now = Date.now();
  for (const k of keys) {
    const e = m[k];
    if (!e) continue;
    if (now - e.at > (e.t ? MATCH_TTL : MISS_TTL)) continue;
    out[k] = e.t || false;
  }
  return out;
}

function putMatches(entries) {
  const m = loadMatches();
  const now = Date.now();
  for (const [k, t] of Object.entries(entries)) m[k] = { at: now, t: t || null };
  const keys = Object.keys(m);
  if (keys.length > MAX_MATCHES) {
    keys.sort((a, b) => m[a].at - m[b].at).slice(0, keys.length - MAX_MATCHES).forEach((k) => delete m[k]);
  }
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => { try { fs.writeFileSync(matchFile(), JSON.stringify(m)); } catch {} }, 1500);
  return true;
}

module.exports = { searchPlaylists, getPlaylist, radio, createdFor, getMatches, putMatches, setToken, tokenStatus, _test: { slimPlaylist, slimTracks, mbidOf } };
