// Thin Spotify Web API client shared by the main window and the flyout.
// Note the name: `window.Spotify` belongs to the Web Playback SDK.
// Endpoints follow the post-February-2026 Development Mode rules
// (playlist /items, /me/library for saving, search limit 10).

(function () {
  const BASE = 'https://api.spotify.com/v1';

  // When Spotify says "too many requests" it gives a Retry-After time. Every call then
  // waits that out (short waits) or fails fast with a clear message (long ones), instead
  // of each one hitting Spotify again and extending the block.
  // Remembered across restarts, so reopening the app doesn't knock on Spotify's door again.
  let cooldownUntil = 0;
  try { cooldownUntil = Number(localStorage.getItem('spotifyCooldownUntil')) || 0; } catch {}
  const saveCooldown = () => { try { localStorage.setItem('spotifyCooldownUntil', String(cooldownUntil)); } catch {} };
  let strikes = 0; // back off further each time Spotify says no in a row
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  function waitText(secs) {
    if (secs < 60) return `in ${secs} seconds`;
    if (secs < 3600) return `in ${Math.ceil(secs / 60)} minutes`;
    const at = new Date(Date.now() + secs * 1000);
    const time = at.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
    return `after ${time}${at.toDateString() !== new Date().toDateString() ? ' tomorrow' : ''}`;
  }
  const rateLimited = (secs) => Object.assign(new Error(`Spotify has paused requests from this app (too many requests). It should work again ${waitText(secs)}.`), { status: 429, retryIn: secs });

  async function api(path, { method = 'GET', query, body, retry = true } = {}) {
    const wait = cooldownUntil - Date.now();
    if (wait > 0) {
      if (wait > 15000) throw rateLimited(Math.ceil(wait / 1000));
      await sleep(wait);
    }
    const token = await window.sweetspot.getToken();
    if (!token) throw Object.assign(new Error('Not signed in'), { status: 401 });
    const url = new URL(BASE + path);
    if (query) for (const [k, v] of Object.entries(query)) if (v !== undefined && v !== null) url.searchParams.set(k, v);
    const res = await fetch(url, {
      method,
      headers: {
        Authorization: `Bearer ${token}`,
        ...(body ? { 'Content-Type': 'application/json' } : {})
      },
      body: body ? JSON.stringify(body) : undefined
    });
    if (res.status === 429) {
      // Retry-After isn't always readable from the app, so fall back to a growing wait.
      const secs = Math.max(1, Number(res.headers.get('Retry-After')) || [5, 15, 30, 60][Math.min(strikes, 3)]);
      strikes++;
      cooldownUntil = Math.max(cooldownUntil, Date.now() + secs * 1000);
      saveCooldown();
      if (retry && secs <= 15) return api(path, { method, query, body, retry: false });
      throw rateLimited(secs);
    }
    // Spotify has been lowering page-size limits. If one is rejected, retry once with 10
    // (the smallest maximum it currently uses); the endless lists simply fetch more pages.
    if (res.status === 400 && query && Number(query.limit) > 10 && retry) {
      const peek = await res.clone().json().catch(() => null);
      const m = peek && peek.error && String(peek.error.message || '');
      if (/limit/i.test(m || '')) return api(path, { method, query: { ...query, limit: 10 }, body, retry: false });
    }
    strikes = 0;
    if (res.status === 204) return null;
    const text = await res.text();
    const data = text ? (() => { try { return JSON.parse(text); } catch { return text; } })() : null;
    if (!res.ok) {
      const msg = (data && data.error && (data.error.message || data.error.reason)) || `Spotify API error ${res.status}`;
      throw Object.assign(new Error(msg), { status: res.status, data });
    }
    return data;
  }

  const ids = (arr) => arr.join(',');

  window.SpotifyAPI = {
    api,
    coolingDown: () => Math.max(0, Math.ceil((cooldownUntil - Date.now()) / 1000)),
    // Spotify's pause belongs to one developer app, so a new Client ID starts fresh.
    resetCooldown: () => { cooldownUntil = 0; strikes = 0; saveCooldown(); },
    me: () => api('/me'),

    search: (q, offset = 0) => api('/search', { query: { q, type: 'track,artist,album,playlist', limit: 10, offset } }),
    searchTracks: (q, offset = 0) => api('/search', { query: { q, type: 'track', limit: 10, offset } }),

    myPlaylists: (offset = 0) => api('/me/playlists', { query: { limit: 50, offset } }),
    playlist: (id) => api(`/playlists/${id}`),
    playlistItems: (id, offset = 0) => api(`/playlists/${id}/items`, { query: { limit: 50, offset } }),

    savedTracks: (offset = 0) => api('/me/tracks', { query: { limit: 50, offset } }),
    savedAlbums: (offset = 0) => api('/me/albums', { query: { limit: 50, offset } }),
    recentlyPlayed: () => api('/me/player/recently-played', { query: { limit: 30 } }),

    album: (id) => api(`/albums/${id}`),
    albumTracks: (id, offset = 0) => api(`/albums/${id}/tracks`, { query: { limit: 50, offset } }),
    artist: (id) => api(`/artists/${id}`),
    artistAlbums: (id, offset = 0) => api(`/artists/${id}/albums`, { query: { include_groups: 'album,single', limit: 10, offset } }),
    addToPlaylist: (id, uris) => api(`/playlists/${id}/items`, { method: 'POST', body: { uris } }),
    createPlaylist: (name, description = '', isPublic = false) => api('/me/playlists', { method: 'POST', body: { name, description, public: isPublic } }),
    updatePlaylist: (id, fields) => api(`/playlists/${id}`, { method: 'PUT', body: fields }),
    removeFromPlaylist: (id, uris) => api(`/playlists/${id}/items`, { method: 'DELETE', body: { items: uris.map((uri) => ({ uri })) } }),
    reorderPlaylist: (id, rangeStart, insertBefore) => api(`/playlists/${id}/items`, { method: 'PUT', body: { range_start: rangeStart, insert_before: insertBefore, range_length: 1 } }),
    searchTrackMatch: (q) => api('/search', { query: { q, type: 'track', limit: 5 } }),

    // Library (generic endpoints)
    libraryContains: (uris) => api('/me/library/contains', { query: { uris: ids(uris) } }),
    // Spotify's library endpoints take the URIs in the web address (max 40 per call), not in the body.
    saveToLibrary: async (uris) => { for (let i = 0; i < uris.length; i += 40) await api('/me/library', { method: 'PUT', query: { uris: ids(uris.slice(i, i + 40)) } }); },
    removeFromLibrary: async (uris) => { for (let i = 0; i < uris.length; i += 40) await api('/me/library', { method: 'DELETE', query: { uris: ids(uris.slice(i, i + 40)) } }); },

    // Player
    playbackState: () => api('/me/player'),
    queue: () => api('/me/player/queue'),
    transfer: (deviceId, play = false) => api('/me/player', { method: 'PUT', body: { device_ids: [deviceId], play } }),
    play: (deviceId, body = {}) => api('/me/player/play', { method: 'PUT', query: { device_id: deviceId }, body }),
    setShuffle: (deviceId, state) => api('/me/player/shuffle', { method: 'PUT', query: { state, device_id: deviceId } }),
    setRepeat: (deviceId, state) => api('/me/player/repeat', { method: 'PUT', query: { state, device_id: deviceId } }),
    addToQueue: (deviceId, uri) => api('/me/player/queue', { method: 'POST', query: { uri, device_id: deviceId } }),
    devices: () => api('/me/player/devices'),
    pause: (deviceId) => api('/me/player/pause', { method: 'PUT', query: { device_id: deviceId } }),
    resume: (deviceId) => api('/me/player/play', { method: 'PUT', query: { device_id: deviceId } }),
    next: (deviceId) => api('/me/player/next', { method: 'POST', query: { device_id: deviceId } }),
    previous: (deviceId) => api('/me/player/previous', { method: 'POST', query: { device_id: deviceId } }),
    seek: (deviceId, ms) => api('/me/player/seek', { method: 'PUT', query: { position_ms: Math.round(ms), device_id: deviceId } }),
    setVolume: (deviceId, pct) => api('/me/player/volume', { method: 'PUT', query: { volume_percent: Math.round(pct), device_id: deviceId } })
  };

  // Helpers for Spotify IDs/URIs and links
  window.SpotifyURI = {
    id: (uri) => (uri || '').split(':').pop(),
    type: (uri) => (uri || '').split(':')[1],
    link: (uri) => {
      const p = (uri || '').split(':');
      return p.length >= 3 ? `https://open.spotify.com/${p[1]}/${p[2]}` : '';
    }
  };

  // Small shared helpers
  window.TP = {
    esc: (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c])),
    fmt: (ms) => {
      if (!ms || ms < 0) ms = 0;
      const s = Math.floor(ms / 1000);
      return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
    },
    // Pick the smallest image that is at least `min` px wide.
    img: (images, min = 64) => {
      if (!images || !images.length) return '';
      const sorted = [...images].sort((a, b) => (a.width || 0) - (b.width || 0));
      return (sorted.find((i) => (i.width || 640) >= min) || sorted[sorted.length - 1]).url;
    },
    artists: (list) => (list || []).map((a) => a.name).join(', ')
  };
})();
