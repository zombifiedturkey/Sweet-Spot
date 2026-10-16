// Sweet Spot — desktop window.
// Hosts the Web Playback SDK player and the browsing UI, tracks what's playing
// (here or on another Spotify Connect device), and pushes that state to the
// tray flyout, mini-player and toast through the main process.

(() => {
  const { esc, fmt, img, artists } = window.TP;
  const API = window.SpotifyAPI;
  const U = window.SpotifyURI;
  const $ = (id) => document.getElementById(id);
  const content = $('content');
  const view = $('view');

  // ---------- State ----------
  let me = null;
  let player = null;
  let deviceId = null;        // this app's Spotify Connect device
  let sdkState = null;        // last SDK state while this app is the active device
  let np = null;              // normalised "now playing", local or remote (see fromSdk/fromApi)
  let liked = false;
  let queueFull = [];         // upcoming tracks (normalised)
  let volume = 0.7;           // this computer's volume
  let seeking = false;
  let settings = {};
  let accent = null;          // accent colour picked from the current album art
  let pollTimer = null;
  let myPlaylists = [];

  // ---------- Startup gates ----------
  function show(id) {
    ['setup', 'login', 'app'].forEach((s) => $(s).classList.toggle('hidden', s !== id));
  }

  document.querySelectorAll('[data-icon]').forEach((el) => { el.innerHTML = ICONS[el.dataset.icon]; });
  $('setup-mark').innerHTML = ICONS.note;
  $('login-mark').innerHTML = ICONS.note;

  async function boot() {
    try {
      settings = await window.sweetspot.getSettings();
      volume = typeof settings.volume === 'number' ? settings.volume : 0.7;
      applyLook();
      renderVolume();
    } catch {}
    const status = await window.sweetspot.authStatus();
    $('redirect-uri').textContent = status.redirectUri;
    if (!status.clientId) return show('setup');
    if (!status.signedIn) {
      if (status.needsReauth) {
        $('login-text').textContent = 'Sweet Spot needs one more permission from Spotify to play music smoothly. Please sign in again; it only takes a moment.';
      }
      return show('login');
    }
    startApp();
  }

  window.sweetspot.onSettings((s) => {
    settings = s;
    applyLook();
    pushState();
  });

  function applyLook() {
    Themes.apply(settings, accent);
    document.body.classList.toggle('no-glass', settings.glass === false);
    toggleQueuePanel(!!settings.queueOpen, false);
    setLibraryPinned(!!settings.libraryPinned, false);
  }

  $('setup-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    const id = $('client-id').value.trim();
    if (!id) return;
    const before = (await window.sweetspot.authStatus().catch(() => ({}))).clientId;
    await window.sweetspot.setClientId(id);
    if (id !== before) window.SpotifyAPI.resetCooldown();
    show('login');
  });

  $('change-client').addEventListener('click', async () => {
    const status = await window.sweetspot.authStatus();
    $('client-id').value = status.clientId || '';
    show('setup');
  });

  $('login-btn').addEventListener('click', async () => {
    $('login-error').textContent = '';
    $('login-btn').disabled = true;
    $('login-btn').textContent = 'Waiting for Spotify…';
    try {
      await window.sweetspot.login();
      startApp();
    } catch (err) {
      $('login-error').textContent = err.message.replace(/^Error invoking remote method '[^']+': (Error: )?/, '');
    } finally {
      $('login-btn').disabled = false;
      $('login-btn').textContent = 'Sign in with Spotify';
    }
  });

  async function signOut() {
    if (player) player.disconnect();
    await window.sweetspot.logout();
    location.reload();
  }

  async function startApp() {
    show('app');
    try {
      me = await API.me();
    } catch (e) {
      if (e.status === 401) { await window.sweetspot.logout(); return show('login'); }
      if (e.status === 403) banner('Spotify refused access. Check your account is added under User Management in your developer dashboard app, and that it has Premium.');
    }
    loadPlaylists();
    navigate({ view: 'home' });
    loadSDK();
    poll(); // pick up anything already playing on another device
  }

  function banner(msg, sticky = false) {
    const b = $('banner');
    b.textContent = msg;
    b.classList.remove('hidden');
    clearTimeout(banner.t);
    if (!sticky) banner.t = setTimeout(() => b.classList.add('hidden'), 4000);
  }
  $('banner').addEventListener('click', () => $('banner').classList.add('hidden'));

  // ---------- Update prompt ----------
  // A small card, bottom right, when a new release is out. "Later" hides it until the
  // next check (a downloaded update also installs itself when you quit).
  const updateCard = document.createElement('div');
  updateCard.className = 'update-card glass hidden';
  document.body.appendChild(updateCard);
  let updDismissed = null;
  function renderUpdate(st) {
    if (!st || !['available', 'downloading', 'ready', 'error'].includes(st.state) || (st.state === 'error' && !st.message)) {
      updateCard.classList.add('hidden'); return;
    }
    if (st.state === 'error' && st.manual) { updateCard.classList.add('hidden'); return; } // Settings shows it
    if (updDismissed === `${st.state}:${st.version}`) return;
    const head = (t) => `<div class="uc-head"><span class="uc-ico">${ICONS.sparkle}</span><b>${t}</b></div>`;
    if (st.state === 'available') {
      updateCard.innerHTML = `${head(`Sweet Spot ${esc(st.version)} is out`)}
        ${st.notes ? `<p class="muted small uc-notes">${esc(st.notes).replace(/\n/g, '<br>')}</p>` : ''}
        <div class="uc-actions"><button class="btn-secondary" data-u="later">Later</button>
        <button class="btn-primary" data-u="get">${st.canInstall ? 'Update now' : 'Download'}</button></div>`;
    } else if (st.state === 'downloading') {
      updateCard.innerHTML = `${head(`Downloading ${esc(st.version || 'update')}…`)}
        <div class="uc-bar"><span style="width:${st.percent || 0}%"></span></div>`;
    } else if (st.state === 'ready') {
      updateCard.innerHTML = `${head(`Update ${esc(st.version)} is ready`)}
        <p class="muted small uc-notes">Restart Sweet Spot to finish. Or choose Later and it installs next time you quit.</p>
        <div class="uc-actions"><button class="btn-secondary" data-u="later">Later</button>
        <button class="btn-primary" data-u="install">Restart now</button></div>`;
    } else {
      updateCard.innerHTML = `${head('Update didn’t finish')}<p class="muted small uc-notes">${esc(st.message)}</p>
        <div class="uc-actions"><button class="btn-secondary" data-u="later">Close</button></div>`;
    }
    updateCard.dataset.key = `${st.state}:${st.version}`;
    updateCard.classList.remove('hidden');
  }
  updateCard.addEventListener('click', (e) => {
    const b = e.target.closest('[data-u]');
    if (!b) return;
    if (b.dataset.u === 'later') { updDismissed = updateCard.dataset.key; updateCard.classList.add('hidden'); }
    if (b.dataset.u === 'get') window.sweetspot.downloadUpdate();
    if (b.dataset.u === 'install') window.sweetspot.installUpdate();
  });
  window.sweetspot.onUpdate(renderUpdate);
  window.sweetspot.getUpdate().then(renderUpdate).catch(() => {});

  // ---------- Normalising playback state ----------
  function normTrack(t) {
    if (!t) return null;
    const album = t.album || {};
    const show = t.show || null;
    let arts = (t.artists || []).map((a) => ({ id: a.id || U.id(a.uri), name: a.name }));
    if (!arts.length && show) arts = [{ id: null, name: show.name }];
    return {
      id: t.id || U.id(t.uri),
      uri: t.uri,
      name: t.name,
      artists: arts,
      album: { id: album.id || (album.uri ? U.id(album.uri) : null), name: album.name || (show && show.name) || '', images: album.images || t.images || (show && show.images) || [] },
      duration_ms: t.duration_ms
    };
  }

  function fromSdk(s) {
    return {
      source: 'local',
      device: { id: deviceId, name: 'This computer', type: 'Computer' },
      track: normTrack(s.track_window.current_track),
      paused: s.paused,
      position: s.position,
      duration: s.duration,
      timestamp: Date.now(),
      shuffle: s.shuffle,
      repeat: s.repeat_mode,
      contextUri: (s.context && s.context.uri) || null
    };
  }

  function fromApi(p) {
    if (!p || !p.item || !p.device) return null;
    return {
      source: p.device.id === deviceId ? 'local' : 'remote',
      device: {
        id: p.device.id,
        name: p.device.name,
        type: p.device.type,
        volume: typeof p.device.volume_percent === 'number' ? p.device.volume_percent / 100 : null,
        supportsVolume: p.device.supports_volume !== false
      },
      track: normTrack(p.item),
      paused: !p.is_playing,
      position: p.progress_ms || 0,
      duration: p.item.duration_ms,
      timestamp: Date.now(),
      shuffle: !!p.shuffle_state,
      repeat: { off: 0, context: 1, track: 2 }[p.repeat_state] || 0,
      contextUri: (p.context && p.context.uri) || null
    };
  }

  const isLocal = () => !!(np && np.source === 'local' && sdkState && player);
  const activeDeviceId = () => (np ? np.device.id : deviceId);

  function livePos() {
    if (!np) return 0;
    if (np.paused) return np.position;
    return Math.min(np.duration, np.position + (Date.now() - np.timestamp));
  }

  function setNp(next) {
    const prevUri = np && np.track && np.track.uri;
    np = next;
    const uri = np && np.track && np.track.uri;
    if (uri !== prevUri) onTrackChange();
    else if (np) { clearTimeout(setNp.qt); setNp.qt = setTimeout(refreshQueue, 800); }
    renderPlayer();
    renderDevicesBar();
    pushState();
    schedulePoll();
  }

  function onTrackChange() {
    if (!np) { liked = false; queueFull = []; renderQueue(); Backdrop.setNowPlaying(null); return; }
    if (jump) return; // mid-skip: wait until we land on the chosen song
    renderQueue();
    refreshLiked();
    refreshQueue();
    const art = img(np.track.album.images, 300);
    Backdrop.setNowPlaying(art);
    Themes.extract(art).then((c) => {
      if (!np || img(np.track.album.images, 300) !== art) return;
      accent = c && c.accent;
      Themes.apply(settings, accent);
      pushState();
    });
  }

  // While another device is playing (or nothing is), check in with Spotify regularly.
  function schedulePoll(delay) {
    clearTimeout(pollTimer);
    if (!me) return;
    let d = delay;
    if (d === undefined) {
      d = isLocal() ? 15000 : np && !np.paused ? 5000 : 10000;
      if (np && !np.paused) d = Math.min(d, Math.max(500, np.duration - livePos() + 400)); // catch the track change
    }
    pollTimer = setTimeout(poll, d);
  }

  async function poll() {
    try {
      const p = await API.playbackState(true);
      // While this computer is playing, the SDK is the source of truth — only a
      // different device taking over (which the SDK also announces) should change that.
      if (isLocal() && (!p || !p.device || p.device.id === deviceId)) { schedulePoll(); return; }
      setNp(fromApi(p));
    } catch {
      schedulePoll(15000);
    }
  }

  async function refreshLiked() {
    const uri = np && np.track.uri;
    try {
      const [isLiked] = await API.libraryContains([uri], true);
      if (!np || np.track.uri !== uri) return;
      liked = !!isLiked;
    } catch { liked = false; }
    renderPlayer();
    pushState();
  }

  async function refreshQueue() {
    try {
      const q = await API.queue(true);
      queueFull = (q && q.queue ? q.queue : []).slice(0, 30).map(normTrack).filter(Boolean);
    } catch {
      const next = sdkState && sdkState.track_window ? sdkState.track_window.next_tracks : [];
      queueFull = next.map(normTrack);
    }
    renderQueue();
    pushState();
  }

  // State for the flyout, mini-player and toast.
  function pushState() {
    updateMediaSession();
    window.sweetspot.pushState(np ? {
      source: np.source,
      device: { name: np.device.name, type: np.device.type },
      track: {
        id: np.track.id,
        uri: np.track.uri,
        name: np.track.name,
        artists: artists(np.track.artists),
        album: np.track.album.name,
        art: img(np.track.album.images, 300),
        artLarge: img(np.track.album.images, 600)
      },
      paused: np.paused,
      position: np.position,
      duration: np.duration,
      timestamp: np.timestamp,
      shuffle: np.shuffle,
      repeat: np.repeat,
      liked,
      volume: effectiveVolume(),
      accent,
      jumping: jump ? jump.name : null,
      queue: queueFull.map((t) => ({ name: t.name, artists: artists(t.artists), art: img(t.album.images, 64), uri: t.uri }))
    } : null);
  }

  // ---------- Web Playback SDK ----------
  function loadSDK() {
    window.onSpotifyWebPlaybackSDKReady = initPlayer;
    const s = document.createElement('script');
    s.src = 'https://sdk.scdn.co/spotify-player.js';
    s.onerror = () => banner('Could not load the Spotify player. Check your internet connection.', true);
    document.head.appendChild(s);
  }

  function initPlayer() {
    player = new Spotify.Player({
      name: 'Sweet Spot',
      getOAuthToken: (cb) => window.sweetspot.getToken().then((t) => cb(t || '')),
      volume
    });

    player.addListener('ready', ({ device_id }) => {
      deviceId = device_id;
      // If nothing is playing anywhere, make Sweet Spot the active device (without starting audio).
      API.playbackState().then((st) => {
        if (!st || !st.is_playing) API.transfer(deviceId, false).catch(() => {});
      }).catch(() => {});
    });
    player.addListener('not_ready', () => { deviceId = null; });
    player.addListener('initialization_error', ({ message }) =>
      banner(`Player couldn't start (${message}). This usually means Widevine isn't available — see the README section on VMP signing.`, true));
    player.addListener('authentication_error', ({ message }) => banner(`Spotify sign-in problem: ${message}`, true));
    player.addListener('account_error', () => banner('Playback needs a Spotify Premium account.', true));
    player.addListener('playback_error', ({ message }) => banner(`Playback error: ${message}`));
    player.addListener('autoplay_failed', () => banner('Autoplay was blocked. Press play to start.'));
    player.addListener('player_state_changed', (state) => {
      sdkState = state && state.track_window && state.track_window.current_track ? state : null;
      if (sdkState) setNp(fromSdk(sdkState));
      else schedulePoll(400); // playback moved elsewhere or stopped — go and look
    });

    player.connect();
  }

  // ---------- Windows media overlay (volume flyout, lock screen, media keys) ----------
  // The SDK plays audio inside its own iframe, so Windows would otherwise show that
  // frame's (empty) session. A silent looping clip here makes this page the active
  // media session, so our track info and button handlers win.
  function makeSilentWav(seconds) {
    const rate = 8000, n = rate * seconds;
    const buf = new ArrayBuffer(44 + n);
    const v = new DataView(buf);
    const str = (o, s) => [...s].forEach((c, i) => v.setUint8(o + i, c.charCodeAt(0)));
    str(0, 'RIFF'); v.setUint32(4, 36 + n, true); str(8, 'WAVE');
    str(12, 'fmt '); v.setUint32(16, 16, true); v.setUint16(20, 1, true); v.setUint16(22, 1, true);
    v.setUint32(24, rate, true); v.setUint32(28, rate, true); v.setUint16(32, 1, true); v.setUint16(34, 8, true);
    str(36, 'data'); v.setUint32(40, n, true);
    new Uint8Array(buf, 44).fill(128); // 8-bit PCM silence
    return URL.createObjectURL(new Blob([buf], { type: 'audio/wav' }));
  }
  const silentClip = new Audio(makeSilentWav(10));
  silentClip.loop = true; // silent data, not muted — muted players are ignored by the media session

  if ('mediaSession' in navigator) {
    const handlers = {
      play: () => runCommand({ type: 'toggle' }),
      pause: () => runCommand({ type: 'toggle' }),
      nexttrack: () => runCommand({ type: 'next' }),
      previoustrack: () => runCommand({ type: 'previous' }),
      seekto: (d) => runCommand({ type: 'seek', ms: d.seekTime * 1000 })
    };
    for (const [action, fn] of Object.entries(handlers)) {
      try { navigator.mediaSession.setActionHandler(action, fn); } catch {}
    }
  }

  function updateMediaSession() {
    if (!('mediaSession' in navigator)) return;
    const ms = navigator.mediaSession;
    if (!isLocal()) {
      ms.metadata = null;
      ms.playbackState = 'none';
      silentClip.pause();
      return;
    }
    const t = np.track;
    if (updateMediaSession.uri !== t.uri) {
      updateMediaSession.uri = t.uri;
      ms.metadata = new MediaMetadata({
        title: t.name,
        artist: artists(t.artists),
        album: t.album.name,
        artwork: t.album.images.map((i) => ({ src: i.url, sizes: `${i.width || 300}x${i.height || 300}`, type: 'image/jpeg' }))
      });
    }
    ms.playbackState = np.paused ? 'paused' : 'playing';
    try { ms.setPositionState({ duration: np.duration / 1000, position: Math.min(livePos(), np.duration) / 1000, playbackRate: 1 }); } catch {}
    if (np.paused) silentClip.pause();
    else silentClip.play().catch(() => {});
  }

  // ---------- Commands (player bar, flyout, mini-player, tray, hotkeys, media keys) ----------
  function afterRemote(delay = 500) { schedulePoll(delay); }

  function optimistic(patch) {
    if (!np) return;
    np = { ...np, position: livePos(), timestamp: Date.now(), ...patch };
    renderPlayer();
    pushState();
  }

  const commands = {
    async toggle() {
      if (isLocal()) return player.togglePlay();
      if (np) {
        const wasPaused = np.paused;
        optimistic({ paused: !wasPaused });
        if (wasPaused) await API.resume(np.device.id); else await API.pause(np.device.id);
        return afterRemote();
      }
      // Nothing playing anywhere: start here.
      if (!deviceId) return banner('The player isn’t ready yet.');
      await API.transfer(deviceId, true);
    },
    async next() {
      if (isLocal()) return player.nextTrack();
      if (np) { await API.next(np.device.id); afterRemote(600); }
    },
    async previous() {
      // Like the official app: restart the track if we're more than 3s in.
      if (isLocal()) return livePos() > 3000 ? player.seek(0) : player.previousTrack();
      if (np) {
        if (livePos() > 3000) { optimistic({ position: 0 }); await API.seek(np.device.id, 0); }
        else await API.previous(np.device.id);
        afterRemote(600);
      }
    },
    async seek({ ms }) {
      ms = Math.max(0, Math.round(ms));
      if (isLocal()) return player.seek(ms);
      if (np) { optimistic({ position: ms }); await API.seek(np.device.id, ms); afterRemote(800); }
    },
    async seekBy({ delta }) { if (np) await commands.seek({ ms: Math.min(np.duration - 1000, livePos() + delta) }); },
    async like() { if (np) await toggleSaved(np.track.uri, liked); },
    async shuffle() {
      if (!np) return;
      optimistic({ shuffle: !np.shuffle });
      await API.setShuffle(np.device.id, np.shuffle);
      afterRemote(600);
    },
    async repeat() {
      if (!np) return;
      const nextMode = (np.repeat + 1) % 3; // off → context → track → off
      optimistic({ repeat: nextMode });
      await API.setRepeat(np.device.id, ['off', 'context', 'track'][nextMode]);
      afterRemote(600);
    },
    async volume({ value }) { setVolume(value); },
    async volumeStep({ delta }) { setVolume(effectiveVolume() + delta); },
    async transfer({ id }) { await transferTo(id); },
    async playQueue({ index, uri }) { await jumpInQueue(index, uri); },
    async refresh() { schedulePoll(0); }
  };

  // Jump to a song in Up next. Spotify has no "play queue item N" command, so:
  //  1) if what's playing is a playlist, album or Liked Songs, restart it at that song
  //     (instant, and the rest carries on in order);
  //  2) otherwise, or if that fails because the song was added with "Add to queue",
  //     skip forward to it, muted so the songs in between don't blip.
  let jump = null;
  async function jumpInQueue(index, uri) {
    if (!np || jump) return;
    const i = queueFull[index] && queueFull[index].uri === uri ? index : queueFull.findIndex((t) => t.uri === uri);
    if (i < 0) return banner('That song isn’t in the queue any more.');
    if (i === 0) return commands.next();
    const target = queueFull[i];
    const dev = np.device.id;
    const ctx = np.contextUri;
    if (ctx && /^spotify:(playlist|album):|^spotify:user:[^:]+:collection$/.test(ctx)) {
      try {
        await API.play(dev, { context_uri: ctx, offset: { uri: target.uri } });
        afterRemote(700);
        return;
      } catch { /* not part of that playlist/album: fall back to skipping */ }
    }
    jump = { name: target.name, uri: target.uri };
    pushState();
    const local = isLocal();
    if (local) player.setVolume(0);
    try {
      for (let k = 0; k <= i; k++) {
        await API.next(dev);
        await new Promise((r) => setTimeout(r, 300));
      }
    } catch (e) {
      banner(e.message);
    } finally {
      if (local && player) player.setVolume(volume);
      jump = null;
      onTrackChange();
      pushState();
      schedulePoll(800);
    }
  }

  async function runCommand(cmd) {
    const fn = commands[cmd && cmd.type];
    if (!fn) return;
    try { await fn(cmd); } catch (e) { banner(e.message); schedulePoll(800); }
  }
  window.sweetspot.onCommand(runCommand);

  function effectiveVolume() {
    return np && np.source === 'remote' ? (np.device.volume ?? 0) : volume;
  }

  function setVolume(value) {
    const v = Math.round(Math.max(0, Math.min(1, value)) * 100) / 100;
    if (np && np.source === 'remote') {
      if (!np.device.supportsVolume) return banner(`${np.device.name} doesn’t allow volume control.`);
      np.device.volume = v;
      renderVolume();
      pushState();
      clearTimeout(setVolume.rt);
      setVolume.rt = setTimeout(() => API.setVolume(np.device.id, v * 100).catch((e) => banner(e.message)), 250);
      return;
    }
    volume = v;
    if (player) player.setVolume(volume);
    renderVolume();
    pushState();
    clearTimeout(setVolume.t);
    setVolume.t = setTimeout(() => window.sweetspot.setSettings({ volume }), 600);
  }

  async function playItems(body) {
    // Play on whichever device is active; fall back to this computer.
    const target = np ? np.device.id : deviceId;
    if (!target) return banner('The player isn’t ready yet — give it a second.');
    try { await API.play(target, body); afterRemote(700); }
    catch (e) { banner(e.message); }
  }

  async function transferTo(id) {
    try {
      await API.transfer(id, !!(np && !np.paused));
      schedulePoll(900);
    } catch (e) { banner(e.message); }
  }

  async function toggleSaved(uri, isSaved) {
    try {
      if (isSaved) await API.removeFromLibrary([uri]); else await API.saveToLibrary([uri]);
      if (np && np.track.uri === uri) { liked = !isSaved; renderPlayer(); pushState(); }
      banner(isSaved ? 'Removed from Liked Songs' : 'Saved to Liked Songs');
    } catch (e) { banner(e.message); }
  }

  async function addToQueue(uri) {
    const dev = activeDeviceId();
    if (!dev) return banner('Start playing something first.');
    try { await API.addToQueue(dev, uri); banner('Added to queue'); setTimeout(refreshQueue, 600); }
    catch (e) { banner(e.message); }
  }

  async function addToPlaylist(p, uri) {
    try { await API.addToPlaylist(p.id, [uri]); banner(`Added to ${p.name}`); }
    catch (e) { banner(e.message); }
  }

  // ---------- Player bar ----------
  const setIcons = {
    'prev-btn': 'prev', 'next-btn': 'next', 'shuffle-btn': 'shuffle', 'queue-toggle': 'queue', 'qp-close': 'close', 'devices-btn': 'devices', 'mini-btn': 'mini',
    'hist-back': 'back', 'hist-fwd': 'forward', 'library-btn': 'library', 'lib-pin': 'pin', 'lib-close': 'close', 'lib-new': 'plus',
    'win-min': 'winMin', 'win-max': 'winMax', 'win-close': 'winClose'
  };
  for (const [id, icon] of Object.entries(setIcons)) $(id).innerHTML = ICONS[icon];

  $('play-btn').onclick = () => runCommand({ type: 'toggle' });
  $('prev-btn').onclick = () => runCommand({ type: 'previous' });
  $('next-btn').onclick = () => runCommand({ type: 'next' });
  $('like-btn').onclick = () => runCommand({ type: 'like' });
  $('shuffle-btn').onclick = () => runCommand({ type: 'shuffle' });
  $('repeat-btn').onclick = () => runCommand({ type: 'repeat' });
  $('queue-toggle').onclick = () => toggleQueuePanel();
  $('qp-close').onclick = () => toggleQueuePanel(false);
  $('mini-btn').onclick = () => window.sweetspot.toggleMini();
  $('devices-btn').onclick = (e) => { e.stopPropagation(); toggleDevices(); };

  // The Now playing panel stays open on every page until toggled off, and is remembered.
  function toggleQueuePanel(force, save = true) {
    const open = typeof force === 'boolean' ? force : $('queue-panel').classList.contains('hidden');
    const was = !$('queue-panel').classList.contains('hidden');
    $('queue-panel').classList.toggle('hidden', !open);
    $('queue-toggle').classList.toggle('active', open);
    $('queue-toggle').title = open ? 'Hide Now playing (Ctrl+Q)' : 'Now playing and queue (Ctrl+Q)';
    document.body.classList.toggle('queue-open', open);
    if (open && !was) renderQueue();
    if (save && open !== !!settings.queueOpen) {
      settings.queueOpen = open;
      window.sweetspot.setSettings({ queueOpen: open });
    }
  }

  let preMute = 0.7;
  $('mute-btn').onclick = () => {
    const v = effectiveVolume();
    if (v > 0) { preMute = v; runCommand({ type: 'volume', value: 0 }); }
    else runCommand({ type: 'volume', value: preMute || 0.5 });
  };
  $('volume').oninput = (e) => runCommand({ type: 'volume', value: e.target.value / 100 });

  $('seek').addEventListener('input', () => {
    seeking = true;
    $('pos').textContent = fmt(($('seek').value / 1000) * (np ? np.duration : 0));
    setRangeFill($('seek'));
  });
  $('seek').addEventListener('change', () => {
    runCommand({ type: 'seek', ms: ($('seek').value / 1000) * (np ? np.duration : 0) });
    seeking = false;
  });

  // Right-click the now-playing track for its menu.
  $('np-area').addEventListener('contextmenu', (e) => {
    if (!np) return;
    e.preventDefault();
    openTrackMenu(e.clientX, e.clientY, np.track);
  });
  $('np-title').onclick = () => np && np.track.album.id && navigate({ view: 'album', id: np.track.album.id });
  $('np-artist').onclick = () => np && np.track.artists[0] && np.track.artists[0].id && navigate({ view: 'artist', id: np.track.artists[0].id });

  function renderVolume() {
    const v = effectiveVolume();
    $('mute-btn').innerHTML = v === 0 ? ICONS.mute : ICONS.volume;
    $('volume').value = Math.round(v * 100);
    setRangeFill($('volume'));
  }

  function setRangeFill(el) {
    el.style.setProperty('--fill', `${((el.value - el.min) / (el.max - el.min)) * 100}%`);
  }

  function renderPlayer() {
    const playing = np && !np.paused;
    $('play-btn').innerHTML = playing ? ICONS.pause : ICONS.play;
    $('play-btn').title = playing ? 'Pause (Space)' : 'Play (Space)';
    $('like-btn').innerHTML = liked ? ICONS.heart : ICONS.heartOutline;
    $('like-btn').classList.toggle('active', liked);
    $('shuffle-btn').classList.toggle('active', !!(np && np.shuffle));
    $('repeat-btn').innerHTML = np && np.repeat === 2 ? ICONS.repeatOne : ICONS.repeat;
    $('repeat-btn').classList.toggle('active', !!(np && np.repeat));

    if (np) {
      const t = np.track;
      $('np-art').src = img(t.album.images, 64);
      $('np-art').classList.remove('empty');
      $('np-title').textContent = t.name;
      $('np-artist').textContent = artists(t.artists);
      $('dur').textContent = fmt(np.duration);
      document.title = `${t.name} · ${artists(t.artists)}`;
    } else {
      $('np-art').removeAttribute('src');
      $('np-art').classList.add('empty');
      $('np-title').textContent = 'Nothing playing';
      $('np-artist').textContent = '';
      $('dur').textContent = '0:00';
      document.title = 'Sweet Spot';
    }
    renderVolume();
    markPlaying();
    tick();
  }

  function tick() {
    if (seeking) return;
    const dur = np ? np.duration : 0;
    const pos = livePos();
    $('pos').textContent = fmt(pos);
    $('seek').value = dur ? Math.round((pos / dur) * 1000) : 0;
    setRangeFill($('seek'));
  }
  setInterval(tick, 500);

  // ---------- Devices ----------
  const DEVICE_ICONS = { computer: 'computer', smartphone: 'phone', tablet: 'phone', speaker: 'speaker', tv: 'tv', castvideo: 'tv', castaudio: 'speaker', avr: 'speaker', stb: 'tv', audiodongle: 'speaker', gameconsole: 'tv', automobile: 'speaker' };
  const deviceIcon = (type) => ICONS[DEVICE_ICONS[(type || '').toLowerCase()] || 'speaker'];

  // "Playing on …" pops up when playback moves to another device, then fades after a few
  // seconds. The highlighted devices button stays as the reminder; hovering it shows the pill again.
  let remoteShownFor = null, remoteTimer = null;
  function flashRemoteBar() {
    const bar = $('remote-bar');
    if (!np || np.source !== 'remote') return;
    bar.innerHTML = `${deviceIcon(np.device.type)}<span>Playing on <b>${esc(np.device.name)}</b></span>`;
    bar.classList.remove('hidden', 'fading');
    clearTimeout(remoteTimer);
    remoteTimer = setTimeout(() => {
      bar.classList.add('fading');
      remoteTimer = setTimeout(() => bar.classList.add('hidden'), 600);
    }, 4000);
  }
  function renderDevicesBar() {
    const remote = np && np.source === 'remote';
    $('devices-btn').classList.toggle('active', !!remote);
    if (!remote) {
      remoteShownFor = null;
      clearTimeout(remoteTimer);
      $('remote-bar').classList.add('hidden');
      return;
    }
    const key = np.device.id || np.device.name;
    if (key !== remoteShownFor) { remoteShownFor = key; flashRemoteBar(); }
  }
  $('devices-btn').addEventListener('mouseenter', flashRemoteBar);

  async function toggleDevices() {
    const pop = $('device-pop');
    if (!pop.classList.contains('hidden')) { pop.classList.add('hidden'); return; }
    closeMenus();
    // Open above the whole volume/buttons block so it never covers the volume bar.
    const br = document.querySelector('.extras').getBoundingClientRect();
    const bar = $('player').getBoundingClientRect();
    pop.style.right = `${Math.max(8, window.innerWidth - (br.left + br.width / 2) - 150)}px`;
    pop.style.bottom = `${window.innerHeight - bar.top + 10}px`;
    pop.classList.remove('hidden');
    pop.innerHTML = `<div class="pop-title">Connect to a device</div><div class="muted small pad">Looking for devices…</div>`;
    try {
      const r = await API.devices();
      const list = (r && r.devices) || [];
      if (deviceId && !list.some((d) => d.id === deviceId)) list.unshift({ id: deviceId, name: 'Sweet Spot', type: 'Computer' });
      list.sort((a, b) => (b.id === deviceId) - (a.id === deviceId));
      const active = activeDeviceId();
      pop.innerHTML = `<div class="pop-title">Connect to a device</div>` + list.map((d) => `
        <button class="dev-row${d.id === active && np ? ' on' : ''}" data-id="${esc(d.id)}">
          <span class="dev-ico">${deviceIcon(d.type)}</span>
          <span class="dev-text"><span class="dev-name">${esc(d.id === deviceId ? 'This computer' : d.name)}</span>
          <span class="dev-sub">${d.id === active && np ? (np.paused ? 'Paused here' : 'Playing') : esc(d.type)}</span></span>
        </button>`).join('') +
        `<div class="pop-hint">Don’t see a device? Open Spotify on it first.</div>`;
      pop.querySelectorAll('.dev-row').forEach((b) => b.onclick = () => { pop.classList.add('hidden'); transferTo(b.dataset.id); });
    } catch (e) {
      pop.innerHTML = `<div class="pop-title">Connect to a device</div><div class="error small pad">${esc(e.message)}</div>`;
    }
  }

  // ---------- Now playing panel ----------
  function renderQueue() {
    const now = $('qp-now'), el = $('queue-list');
    if (!np) {
      now.innerHTML = `<div class="qp-empty">${ICONS.note}<p>Nothing playing</p><span class="muted small">Pick something to play and it’ll show here with what’s coming up next.</span></div>`;
      $('qp-from').innerHTML = '';
      el.innerHTML = '';
      return;
    }
    const t = np.track;
    now.innerHTML = `
      <img class="qp-art" src="${esc(img(t.album.images, 300))}" alt=""${t.album.id ? ` data-qnav="album:${esc(t.album.id)}" title="Go to album"` : ''}>
      <div class="qp-meta">
        <div class="qp-text">
          <div class="qp-title" title="${esc(t.name)}">${esc(t.name)}</div>
          <div class="qp-artist muted">${t.artists.map((a) => (a.id ? `<span class="link" data-qnav="artist:${esc(a.id)}">${esc(a.name)}</span>` : esc(a.name))).join(', ')}</div>
        </div>
        ${np.source === 'remote' ? `<span class="qp-device" title="Playing on ${esc(np.device.name)}">${deviceIcon(np.device.type)}</span>` : ''}
      </div>`;
    renderFrom();
    el.innerHTML = `<div class="q-label">Next up${queueFull.length ? '<span class="muted small q-hint">Double-click to play</span>' : ''}</div>` +
      (queueFull.length ? queueFull.map((x, i) => queueRow(x, i)).join('') : '<p class="muted small pad">Nothing queued.</p>');
  }

  // "Playing from …" — the playlist, album, artist or Liked Songs the music is coming from.
  const ctxNames = new Map();
  async function contextInfo(uri) {
    if (!uri) return null;
    if (ctxNames.has(uri)) return ctxNames.get(uri);
    const [, type, id] = uri.split(':');
    let info = null;
    try {
      if (/:collection$/.test(uri)) info = { kind: 'Playlist', label: 'Liked Songs', nav: 'liked:' };
      else if (type === 'playlist') {
        const own = myPlaylists.find((p) => p.id === id);
        info = { kind: 'Playlist', label: own ? own.name : (await API.playlist(id)).name, nav: `playlist:${id}` };
      } else if (type === 'album') info = { kind: 'Album', label: (await API.album(id)).name, nav: `album:${id}` };
      else if (type === 'artist') info = { kind: 'Artist', label: (await API.artist(id)).name, nav: `artist:${id}` };
    } catch { info = { kind: type ? type[0].toUpperCase() + type.slice(1) : '', label: null, nav: null }; }
    ctxNames.set(uri, info);
    return info;
  }

  async function renderFrom() {
    const el = $('qp-from');
    const uri = np && np.contextUri;
    if (!uri) { el.innerHTML = ''; return; }
    const info = await contextInfo(uri);
    if (!np || np.contextUri !== uri) return;
    el.innerHTML = info && info.label
      ? `<span class="muted small">Playing from ${esc(info.kind.toLowerCase())}</span><span class="qp-from-name link" data-qnav="${esc(info.nav)}">${esc(info.label)}</span>`
      : '';
  }

  $('queue-panel').addEventListener('click', (e) => {
    const n = e.target.closest('[data-qnav]');
    if (!n) return;
    const [view_, id] = n.dataset.qnav.split(':');
    navigate({ view: view_, id: id || undefined });
  });

  const queueRow = (t, i) => `
    <div class="q-row" data-q-index="${i}" title="Double-click to play">
      <span class="q-num muted">${i + 1}</span>
      <img src="${esc(img(t.album.images, 64))}" alt="">
      <div class="q-text"><div class="q-title">${esc(t.name)}</div><div class="muted small">${esc(artists(t.artists))}</div></div>
    </div>`;
  $('queue-list').addEventListener('dblclick', (e) => {
    const row = e.target.closest('[data-q-index]');
    const i = row ? Number(row.dataset.qIndex) : -1;
    if (i >= 0 && queueFull[i]) runCommand({ type: 'playQueue', index: i, uri: queueFull[i].uri });
  });
  $('queue-list').addEventListener('contextmenu', (e) => {
    const row = e.target.closest('[data-q-index]');
    if (!row) return;
    e.preventDefault();
    const i = Number(row.dataset.qIndex);
    const t = i < 0 ? np && np.track : queueFull[i];
    if (t) openTrackMenu(e.clientX, e.clientY, t);
  });

  // ---------- Context menus ----------
  const ctx = $('ctx');

  function closeMenus() {
    ctx.classList.add('hidden');
    ctx.innerHTML = '';
    $('device-pop').classList.add('hidden');
  }

  // items: [{ label, action, submenu: [] | async () => [], disabled, danger } | { sep: true }]
  function buildMenu(items) {
    const m = document.createElement('div');
    m.className = 'menu';
    for (const it of items) {
      if (!it) continue;
      if (it.sep) { m.insertAdjacentHTML('beforeend', '<div class="menu-sep"></div>'); continue; }
      const el = document.createElement('div');
      el.className = `menu-item${it.disabled ? ' disabled' : ''}${it.submenu ? ' has-sub' : ''}`;
      el.innerHTML = `<span>${esc(it.label)}</span>${it.submenu ? `<span class="sub-arrow">${ICONS.forward}</span>` : ''}`;
      if (it.action && !it.disabled) el.onclick = (e) => { e.stopPropagation(); closeMenus(); it.action(); };
      if (it.submenu) {
        let sub = null;
        el.addEventListener('mouseenter', async () => {
          m.querySelectorAll(':scope > .menu-item > .menu').forEach((x) => x !== sub && x.remove());
          if (sub && sub.isConnected) return;
          const list = typeof it.submenu === 'function' ? await it.submenu() : it.submenu;
          sub = buildMenu(list.length ? list : [{ label: 'Nothing here', disabled: true }]);
          sub.classList.add('submenu');
          el.appendChild(sub);
          // Flip left / nudge up if it would run off-screen.
          const r = sub.getBoundingClientRect();
          if (r.right > window.innerWidth - 8) sub.classList.add('flip');
          if (r.bottom > window.innerHeight - 8) sub.style.top = `${Math.max(-r.top + 8, window.innerHeight - 8 - r.bottom)}px`;
        });
      } else {
        el.addEventListener('mouseenter', () => m.querySelectorAll(':scope > .menu-item > .menu').forEach((x) => x.remove()));
      }
      m.appendChild(el);
    }
    return m;
  }

  function openMenu(x, y, items) {
    closeMenus();
    ctx.appendChild(buildMenu(items));
    ctx.classList.remove('hidden');
    const r = ctx.firstChild.getBoundingClientRect();
    ctx.style.left = `${Math.min(x, window.innerWidth - r.width - 8)}px`;
    ctx.style.top = `${Math.min(y, window.innerHeight - r.height - 8)}px`;
  }

  document.addEventListener('mousedown', (e) => {
    if (!ctx.contains(e.target) && !$('device-pop').contains(e.target) && !$('devices-btn').contains(e.target)) closeMenus();
  });
  window.addEventListener('blur', closeMenus);
  window.addEventListener('resize', closeMenus);
  content.addEventListener('scroll', () => { if (!ctx.classList.contains('hidden')) closeMenus(); }, { passive: true });

  const editablePlaylists = () => myPlaylists.filter((p) => p && ((me && p.owner && p.owner.id === me.id) || p.collaborative));

  async function openTrackMenu(x, y, t, extra) {
    if (!t || !t.uri) return;
    const isEpisode = U.type(t.uri) === 'episode';
    let saved = null;
    try { [saved] = await API.libraryContains([t.uri]); } catch {}
    const arts = (t.artists || []).filter((a) => a.id);
    openMenu(x, y, [
      { label: 'Add to queue', action: () => addToQueue(t.uri) },
      !isEpisode && {
        label: 'Add to playlist',
        submenu: () => [
          { label: 'New playlist…', action: () => createPlaylistFlow({ uris: [t.uri] }) },
          { sep: true },
          ...editablePlaylists().map((p) => ({ label: p.name, action: () => addToPlaylist(p, t.uri) }))
        ]
      },
      ...(extra && extra.length ? [{ sep: true }, ...extra] : []),
      saved !== null && !isEpisode && { label: saved ? 'Remove from Liked Songs' : 'Save to Liked Songs', action: () => toggleSaved(t.uri, saved) },
      { sep: true },
      t.album && t.album.id && !isEpisode && { label: 'Go to album', action: () => navigate({ view: 'album', id: t.album.id }) },
      arts.length === 1 && { label: 'Go to artist', action: () => navigate({ view: 'artist', id: arts[0].id }) },
      arts.length > 1 && { label: 'Go to artist', submenu: arts.map((a) => ({ label: a.name, action: () => navigate({ view: 'artist', id: a.id }) })) },
      { sep: true },
      { label: 'Copy song link', action: () => copyLink(t.uri) }
    ]);
  }

  async function openCardMenu(x, y, { uri, nav, title }) {
    const type = U.type(uri);
    const [view_, id] = nav.split(':');
    let saved = null;
    if (type === 'album') { try { [saved] = await API.libraryContains([uri]); } catch {} }
    openMenu(x, y, [
      { label: 'Play', action: () => playItems({ context_uri: uri }) },
      { label: `Open ${type}`, action: () => navigate({ view: view_, id }) },
      saved !== null && { label: saved ? 'Remove from Your Library' : 'Save to Your Library', action: async () => {
        try { if (saved) await API.removeFromLibrary([uri]); else await API.saveToLibrary([uri]); banner(saved ? `Removed ${title}` : `Saved ${title}`); }
        catch (e) { banner(e.message); }
      } },
      { sep: true },
      { label: `Copy ${type} link`, action: () => copyLink(uri) }
    ]);
  }

  async function copyLink(uri) {
    try { await navigator.clipboard.writeText(U.link(uri)); banner('Link copied'); }
    catch { banner('Couldn’t copy the link.'); }
  }

  // ---------- Navigation with history ----------
  const hist = [];
  let hIdx = -1;
  let renderToken = 0;
  let observers = [];

  document.querySelectorAll('.dock-item').forEach((b) => b.addEventListener('click', () => navigate({ view: b.dataset.view })));
  $('hist-back').onclick = goBack;
  $('hist-fwd').onclick = goForward;
  // Mouse back/forward buttons
  window.addEventListener('mouseup', (e) => {
    if (e.button === 3) { e.preventDefault(); goBack(); }
    if (e.button === 4) { e.preventDefault(); goForward(); }
  });
  window.sweetspot.onNavigate((route) => {
    if ($('app').classList.contains('hidden')) return;
    if (route.history === 'back') goBack();
    else if (route.history === 'forward') goForward();
    else navigate(route);
  });

  function sameRoute(a, b) { return a && b && a.view === b.view && a.id === b.id && (a.q || '') === (b.q || ''); }

  function navigate(route) {
    if (sameRoute(hist[hIdx], route) && route.view !== 'search') return;
    if (hIdx >= 0) hist[hIdx].scroll = content.scrollTop;
    hist.splice(hIdx + 1);
    hist.push({ ...route });
    hIdx = hist.length - 1;
    render(hist[hIdx], 0);
  }

  function goBack() {
    if (hIdx <= 0) return;
    hist[hIdx].scroll = content.scrollTop;
    hIdx--;
    render(hist[hIdx], hist[hIdx].scroll || 0);
  }

  function goForward() {
    if (hIdx >= hist.length - 1) return;
    hist[hIdx].scroll = content.scrollTop;
    hIdx++;
    render(hist[hIdx], hist[hIdx].scroll || 0);
  }

  function setActiveNav(route) {
    const dockView = route.view === 'lb' || route.view === 'mix' ? 'discover' : route.view;
    document.querySelectorAll('.dock-item').forEach((b) => b.classList.toggle('active', b.dataset.view === dockView));
    moveDockGlow();
    document.querySelectorAll('.pl-item').forEach((b) => b.classList.toggle('active', route.view === 'playlist' && b.dataset.id === route.id));
    $('settings-btn').classList.toggle('active', route.view === 'settings');
  }

  async function render(route, scroll) {
    const token = ++renderToken;
    observers.forEach((o) => o.disconnect());
    observers = [];
    closeMenus();
    setActiveNav(route);
    $('hist-back').disabled = hIdx <= 0;
    $('hist-fwd').disabled = hIdx >= hist.length - 1;
    Backdrop.setPage(null);
    content.scrollTop = 0;
    view.innerHTML = `<div class="loading">Loading…</div>`;
    const ctxObj = { token, alive: () => token === renderToken };
    try {
      switch (route.view) {
        case 'home': await renderHome(ctxObj); break;
        case 'search': renderSearch(route, ctxObj); break;
        case 'liked': await renderLiked(ctxObj); break;
        case 'playlist': await renderPlaylist(route.id, ctxObj); break;
        case 'album': await renderAlbum(route.id, ctxObj); break;
        case 'artist': await renderArtist(route.id, ctxObj); break;
        case 'discover': await renderDiscover(route, ctxObj); break;
        case 'lb': case 'mix': await renderLb(route, ctxObj); break;
        case 'settings': await renderSettings(ctxObj); break;
      }
      if (!ctxObj.alive()) return;
      await restoreScroll(scroll, ctxObj);
    } catch (e) {
      if (ctxObj.alive()) view.innerHTML = `<div class="view"><p class="error">Couldn't load this: ${esc(ipcMsg(e))}</p></div>`;
    }
  }

  // Scroll back to where you were, loading more rows if the list was longer.
  async function restoreScroll(target, c) {
    if (!target) return;
    for (let i = 0; i < 12 && content.scrollHeight - content.clientHeight < target; i++) {
      const list = view.querySelector('.track-body');
      if (!list || !list._list || list._list.done) break;
      await list._list.more();
      if (!c.alive()) return;
    }
    content.scrollTop = target;
  }


  // Delegated clicks in the content area.
  content.addEventListener('click', (e) => {
    const more = e.target.closest('.row-more');
    if (more) {
      e.stopPropagation();
      const row = more.closest('.track-row');
      const list = row.parentElement._list;
      const r = more.getBoundingClientRect();
      const i = Number(row.dataset.trackIndex);
      return openTrackMenu(r.left - 180, r.bottom + 4, list.tracks[i], list.menuExtra ? list.menuExtra(i, list) : null);
    }
    const playCtx = e.target.closest('[data-play-context]');
    if (playCtx) { e.stopPropagation(); return playItems({ context_uri: playCtx.dataset.playContext }); }
    const nav = e.target.closest('[data-nav]');
    if (nav) {
      e.stopPropagation();
      const [v, id] = nav.dataset.nav.split(':');
      return navigate({ view: v, id });
    }
    const row = e.target.closest('.track-row');
    if (row && row.parentElement._list) row.parentElement._list.play(Number(row.dataset.trackIndex));
  });

  content.addEventListener('contextmenu', (e) => {
    const row = e.target.closest('.track-row');
    if (row && row.parentElement._list) {
      e.preventDefault();
      const list = row.parentElement._list;
      const i = Number(row.dataset.trackIndex);
      return openTrackMenu(e.clientX, e.clientY, list.tracks[i], list.menuExtra ? list.menuExtra(i, list) : null);
    }
    const c = e.target.closest('.card[data-uri]');
    if (c) {
      e.preventDefault();
      openCardMenu(e.clientX, e.clientY, { uri: c.dataset.uri, nav: c.dataset.nav, title: c.dataset.title });
    }
  });

  // ---------- Sidebar playlists ----------
  async function loadPlaylists() {
    const el = $('playlists');
    try {
      const all = [];
      let offset = 0;
      for (let i = 0; i < 10; i++) {
        const page = await API.myPlaylists(offset);
        all.push(...page.items.filter(Boolean));
        if (!page.next) break;
        offset += 50;
      }
      myPlaylists = all;
      el.innerHTML = all.map((p) => `
        <button class="pl-item" data-id="${esc(p.id)}" data-uri="${esc(p.uri)}" data-title="${esc(p.name)}">
          <img src="${esc(img(p.images, 64))}" alt="">
          <span class="pl-text"><span class="pl-name">${esc(p.name)}</span><span class="pl-sub">Playlist${p.owner && p.owner.display_name ? ` • ${esc(p.owner.display_name)}` : ''}</span></span>
        </button>`).join('');
      el.querySelectorAll('.pl-item').forEach((b) => {
        b.addEventListener('click', () => { navigate({ view: 'playlist', id: b.dataset.id }); if (!settings.libraryPinned) toggleLibrary(false); });
        b.addEventListener('contextmenu', (e) => {
          e.preventDefault();
          openCardMenu(e.clientX, e.clientY, { uri: b.dataset.uri, nav: `playlist:${b.dataset.id}`, title: b.dataset.title });
        });
      });
      setActiveNav(hist[hIdx] || { view: 'home' });
    } catch {
      el.innerHTML = `<p class="muted small pad">Couldn't load playlists.</p>`;
    }
  }

  // ---------- Building blocks ----------
  const card = ({ image, title, sub, nav, uri, round }) => `
    <div class="card" data-nav="${esc(nav)}" data-uri="${esc(uri || '')}" data-title="${esc(title)}">
      <div class="card-art${round ? ' round' : ''}">
        ${image ? `<img src="${esc(image)}" alt="" loading="lazy">` : `<div class="art-ph">${ICONS.note}</div>`}
        ${uri ? `<button class="card-play" data-play-context="${esc(uri)}" title="Play">${ICONS.play}</button>` : ''}
      </div>
      <div class="card-title">${esc(title)}</div>
      <div class="card-sub muted">${esc(sub)}</div>
    </div>`;

  const rowHtml = (t, i, { showAlbum, showArt, draggable }) => `
    <div class="track-row" data-track-index="${i}" data-uri="${esc(t.uri)}"${draggable ? ' draggable="true"' : ''}>
      <span class="idx muted">${i + 1}</span>
      <span class="t-main">
        ${showArt ? `<img src="${esc(img(t.album.images, 48))}" alt="" loading="lazy">` : ''}
        <span class="t-text"><span class="t-name">${esc(t.name)}</span><span class="muted small">${t.artists.map((a) => a.id ? `<span class="t-artist" data-nav="artist:${esc(a.id)}">${esc(a.name)}</span>` : esc(a.name)).join(', ')}</span></span>
      </span>
      ${showAlbum && t.album.id ? `<span class="muted small t-album"><span data-nav="album:${esc(t.album.id)}">${esc(t.album.name)}</span></span>` : '<span></span>'}
      <span class="muted small r">${fmt(t.duration_ms)}</span>
      <button class="row-more" title="More options">${ICONS.more}</button>
    </div>`;

  // A track list that loads more rows as you scroll.
  //   fetchMore(offset) → { tracks, consumed, hasMore }
  function trackList(container, { tracks = [], offset = tracks.length, hasMore = false, fetchMore = null, onPlay, showAlbum = true, showArt = true, root = content, menuExtra = null, reorder = null }) {
    container.insertAdjacentHTML('beforeend', `<div class="tracks">
      <div class="track-head muted"><span>#</span><span>Title</span><span>${showAlbum ? 'Album' : ''}</span><span class="r">Time</span><span></span></div>
      <div class="track-body"></div>
      <div class="list-sentinel"><span class="spinner"></span></div>
    </div>`);
    const wrap = container.lastElementChild;
    const body = wrap.querySelector('.track-body');
    const sentinel = wrap.querySelector('.list-sentinel');
    const opts = { showAlbum, showArt, draggable: !!reorder };

    const list = {
      tracks: [],
      menuExtra,
      offset,
      done: !(hasMore && fetchMore),
      loading: null,
      play: (i) => onPlay(i, list),
      append(arr) {
        const start = list.tracks.length;
        list.tracks.push(...arr);
        body.insertAdjacentHTML('beforeend', arr.map((t, i) => rowHtml(t, start + i, opts)).join(''));
        markPlaying();
      },
      more() {
        if (list.done) return Promise.resolve();
        if (list.loading) return list.loading;
        sentinel.classList.add('busy');
        list.loading = fetchMore(list.offset).then((r) => {
          list.offset += r.consumed;
          list.append(r.tracks);
          list.done = !r.hasMore || r.consumed === 0;
        }).catch((e) => {
          list.done = true;
          sentinel.innerHTML = `<span class="error small">Couldn’t load more: ${esc(e.message)}</span>`;
        }).finally(() => {
          list.loading = null;
          sentinel.classList.remove('busy');
          if (list.done) sentinel.classList.add('done');
          else if (isVisible(sentinel, root)) list.more();
        });
        return list.loading;
      }
    };
    body._list = list;
    if (reorder) enableReorder(body, list, opts, reorder);
    list.append(tracks);
    if (list.done) sentinel.classList.add('done');
    else {
      const io = new IntersectionObserver((entries) => { if (entries.some((x) => x.isIntersecting)) list.more(); }, { root, rootMargin: root === content ? '800px' : '120px' });
      io.observe(sentinel);
      observers.push(io);
    }
    return list;
  }

  function isVisible(el, root = content) {
    const r = el.getBoundingClientRect();
    const c = root.getBoundingClientRect();
    return r.top < c.bottom + (root === content ? 800 : 300);
  }

  // Grid of cards that loads more as you scroll. fetchMore(offset) → { items, consumed, hasMore }
  function cardGrid(container, { items, offset = items.length, hasMore = false, fetchMore = null, toCard }) {
    container.insertAdjacentHTML('beforeend', `<div class="grid"></div><div class="list-sentinel"><span class="spinner"></span></div>`);
    const sentinel = container.lastElementChild;
    const grid = sentinel.previousElementSibling;
    let off = offset, done = !(hasMore && fetchMore), loading = false;
    const add = (arr) => grid.insertAdjacentHTML('beforeend', arr.map(toCard).join(''));
    add(items);
    if (done) { sentinel.classList.add('done'); return; }
    const more = async () => {
      if (done || loading) return;
      loading = true;
      sentinel.classList.add('busy');
      try {
        const r = await fetchMore(off);
        off += r.consumed;
        add(r.items);
        done = !r.hasMore || r.consumed === 0;
      } catch { done = true; }
      loading = false;
      sentinel.classList.remove('busy');
      if (done) sentinel.classList.add('done');
      else if (isVisible(sentinel)) more();
    };
    const io = new IntersectionObserver((e) => { if (e.some((x) => x.isIntersecting)) more(); }, { root: content, rootMargin: '800px' });
    io.observe(sentinel);
    observers.push(io);
  }

  function markPlaying() {
    const uri = np && np.track.uri;
    view.querySelectorAll('.track-row').forEach((r) => r.classList.toggle('playing', !!uri && r.dataset.uri === uri));
  }

  function header({ image, kind, title, meta, desc, round, liked: isLiked, rawMeta, aside = '' }) {
    return `<header class="hero${aside ? ' has-aside' : ''}">
      <div class="hero-art${round ? ' round' : ''}${isLiked ? ' liked' : ''}">
        ${image ? `<img src="${esc(image)}" alt="">` : `<div class="art-ph">${isLiked ? ICONS.heart : ICONS.note}</div>`}
      </div>
      <div class="hero-text">
        <div class="small">${esc(kind)}</div>
        <h1 class="hero-title">${esc(title)}</h1>
        ${desc ? `<div class="muted small hero-desc">${esc(desc.replace(/<[^>]*>/g, '').replace(/&amp;/g, '&').replace(/&#x27;|&#39;/g, "'").replace(/&quot;/g, '"'))}</div>` : ''}
        <div class="small hero-meta">${rawMeta ? meta : esc(meta)}</div>
      </div>
      ${aside}
    </header>`;
  }

  // Pages with cover art (albums, playlists, artists) set the window backdrop to that art.
  function tintHero(image, c) {
    if (c.alive()) Backdrop.setPage(image || null);
  }

  const playBtn = () => `<div class="actions"><button class="play-btn big" id="hero-play" title="Play">${ICONS.play}</button></div>`;

  // ---------- Dialogs ----------
  // dialog({ title, text, fields: [{ label, value, placeholder, multiline, optional }], ok, danger })
  // → resolves to an array of field values (or true when there are no fields), or null if cancelled.
  function dialog({ title, text = '', fields = [], ok = 'Save', danger = false }) {
    return new Promise((resolve) => {
      const m = document.createElement('div');
      m.className = 'modal';
      m.innerHTML = `<form class="modal-card dlg" autocomplete="off">
        <div class="modal-head"><h2>${esc(title)}</h2></div>
        ${text ? `<p class="muted dlg-text">${esc(text)}</p>` : ''}
        ${fields.map((f, i) => `<label class="dlg-field"><span>${esc(f.label)}</span>${f.multiline
          ? `<textarea name="f${i}" rows="3" placeholder="${esc(f.placeholder || '')}">${esc(f.value || '')}</textarea>`
          : `<input name="f${i}" value="${esc(f.value || '')}" placeholder="${esc(f.placeholder || '')}" spellcheck="false">`}</label>`).join('')}
        <div class="dlg-actions">
          <button type="button" class="btn-secondary" data-cancel>Cancel</button>
          <button type="submit" class="btn-primary${danger ? ' danger' : ''}">${esc(ok)}</button>
        </div>
      </form>`;
      document.body.appendChild(m);
      const form = m.querySelector('form');
      const close = (v) => { m.remove(); resolve(v); };
      form.addEventListener('submit', (e) => {
        e.preventDefault();
        const vals = fields.map((_, i) => form.elements[`f${i}`].value.trim());
        const missing = fields.findIndex((f, i) => !f.optional && !vals[i]);
        if (missing >= 0) return form.elements[`f${missing}`].focus();
        close(fields.length ? vals : true);
      });
      m.querySelector('[data-cancel]').onclick = () => close(null);
      m.addEventListener('mousedown', (e) => { if (e.target === m) close(null); });
      m.addEventListener('keydown', (e) => { if (e.key === 'Escape') { e.stopPropagation(); close(null); } });
      setTimeout(() => {
        const first = form.querySelector('input, textarea') || form.querySelector('[type=submit]');
        first.focus();
        if (first.select) first.select();
      }, 30);
    });
  }

  // ---------- Your own playlists ----------
  const ownsPlaylist = (p) => !!(p && me && p.owner && p.owner.id === me.id);

  async function createPlaylistFlow({ name = '', description = '', uris = [], open = true } = {}) {
    const n = myPlaylists.filter(ownsPlaylist).length + 1;
    const res = await dialog({
      title: uris.length > 1 ? 'Save as a playlist' : 'New playlist',
      fields: [
        { label: 'Name', value: name || `My playlist #${n}` },
        { label: 'Description', value: description, placeholder: 'Optional', multiline: true, optional: true }
      ],
      ok: uris.length > 1 ? `Save ${uris.length} songs` : 'Create'
    });
    if (!res) return null;
    const [title, desc] = res;
    try {
      const p = await API.createPlaylist(title, desc, false);
      for (let i = 0; i < uris.length; i += 100) await API.addToPlaylist(p.id, uris.slice(i, i + 100));
      await loadPlaylists();
      banner(uris.length > 1 ? `Saved “${title}” with ${uris.length} songs` : uris.length ? `Created “${title}” and added the song` : `Created “${title}”`);
      if (open) navigate({ view: 'playlist', id: p.id });
      return p;
    } catch (e) { banner(e.message); return null; }
  }

  async function editPlaylistFlow(p) {
    const res = await dialog({
      title: 'Edit details',
      fields: [
        { label: 'Name', value: p.name },
        { label: 'Description', value: (p.description || '').replace(/<[^>]*>/g, ''), placeholder: 'Optional', multiline: true, optional: true }
      ]
    });
    if (!res) return;
    try {
      await API.updatePlaylist(p.id, { name: res[0], description: res[1] });
      await loadPlaylists();
      render(hist[hIdx], content.scrollTop);
      banner('Playlist updated');
    } catch (e) { banner(e.message); }
  }

  async function deletePlaylistFlow(p) {
    const ok = await dialog({
      title: `Delete “${p.name}”?`,
      text: 'It will be removed from Your Library. Spotify keeps it in your account’s recently deleted list for a while if you change your mind.',
      ok: 'Delete', danger: true
    });
    if (!ok) return;
    try {
      await API.removeFromLibrary([p.uri]);
      await loadPlaylists();
      navigate({ view: 'home' });
      banner(`Deleted “${p.name}”`);
    } catch (e) { banner(e.message); }
  }

  // Drag-and-drop reordering for a track list. reorder(from, insertBefore, list) → true if saved.
  function enableReorder(body, list, opts, reorder) {
    body.classList.add('reorderable');
    let from = -1;
    const clear = () => body.querySelectorAll('.drop-above, .drop-below, .dragging').forEach((r) => r.classList.remove('drop-above', 'drop-below', 'dragging'));
    const spot = (e) => {
      const row = e.target.closest('.track-row');
      if (!row) return null;
      const r = row.getBoundingClientRect();
      return { row, index: Number(row.dataset.trackIndex), below: e.clientY > r.top + r.height / 2 };
    };
    body.addEventListener('dragstart', (e) => {
      const row = e.target.closest('.track-row');
      if (!row) return;
      from = Number(row.dataset.trackIndex);
      row.classList.add('dragging');
      e.dataTransfer.effectAllowed = 'move';
      e.dataTransfer.setData('text/plain', String(from));
    });
    body.addEventListener('dragend', () => { clear(); from = -1; });
    body.addEventListener('dragover', (e) => {
      if (from < 0) return;
      const s = spot(e);
      if (!s) return;
      e.preventDefault();
      body.querySelectorAll('.drop-above, .drop-below').forEach((r) => r.classList.remove('drop-above', 'drop-below'));
      s.row.classList.add(s.below ? 'drop-below' : 'drop-above');
    });
    body.addEventListener('drop', async (e) => {
      const s = spot(e);
      const start = from;
      clear();
      from = -1;
      if (!s || start < 0) return;
      e.preventDefault();
      const to = s.below ? s.index + 1 : s.index;
      if (to === start || to === start + 1) return;
      if (!(await reorder(start, to, list))) return;
      const [t] = list.tracks.splice(start, 1);
      list.tracks.splice(to > start ? to - 1 : to, 0, t);
      body.innerHTML = list.tracks.map((x, i) => rowHtml(x, i, opts)).join('');
      markPlaying();
    });
  }

  // ---------- Views ----------
  async function renderHome(c) {
    const hour = new Date().getHours();
    const greet = hour < 12 ? 'Good morning' : hour < 18 ? 'Good afternoon' : 'Good evening';
    const [recent, saved] = await Promise.all([
      API.recentlyPlayed().catch(() => null),
      API.savedAlbums().catch(() => null)
    ]);
    if (!c.alive()) return;
    const playlists = myPlaylists.length ? myPlaylists : await API.myPlaylists().then((p) => p.items.filter(Boolean)).catch(() => []);
    const albums = (saved ? saved.items : []).map((x) => x.album).filter(Boolean).slice(0, 18);
    const seen = new Set();
    const recentTracks = (recent ? recent.items : []).map((i) => normTrack(i.track)).filter((t) => t && !seen.has(t.id) && seen.add(t.id)).slice(0, 20);

    view.innerHTML = `<div class="view home">
      <h1 class="page-title">${greet}</h1>
      <div class="home-cols">
        <div class="home-main">
          ${playlists.length ? `<h2 class="section-title">Your playlists</h2>
          <div class="grid">${playlists.slice(0, 12).map((p) => card({ image: img(p.images, 200), title: p.name, sub: p.owner ? `By ${p.owner.display_name}` : '', nav: `playlist:${p.id}`, uri: p.uri })).join('')}</div>` : ''}
          ${albums.length ? `<h2 class="section-title">Your albums</h2>
          <div class="grid">${albums.map((a) => card({ image: img(a.images, 200), title: a.name, sub: artists(a.artists), nav: `album:${a.id}`, uri: a.uri })).join('')}</div>` : ''}
          ${!playlists.length && !albums.length ? `<p class="muted">Your playlists and saved albums will show up here.</p>` : ''}
        </div>
        <aside class="home-side glass-panel">
          <h2 class="section-title">Recently played</h2>
          <div id="home-recent">${recentTracks.length ? '' : '<p class="muted small pad">Nothing yet.</p>'}</div>
        </aside>
      </div>
    </div>`;
    if (recentTracks.length) {
      trackList($('home-recent'), {
        tracks: recentTracks,
        showAlbum: false,
        onPlay: (i, l) => playItems({ uris: l.tracks.map((t) => t.uri), offset: { position: i } })
      });
    }
  }

  function renderSearch(route, c) {
    view.innerHTML = `<div class="view">
      <div class="search-bar"><span class="ico">${ICONS.search}</span><input id="search-input" placeholder="What do you want to play?  (Ctrl+L)" value="${esc(route.q || '')}" autocomplete="off" spellcheck="false"></div>
      <div id="search-results"></div>
    </div>`;
    const input = $('search-input');
    input.focus();
    let timer;
    input.addEventListener('input', () => {
      clearTimeout(timer);
      timer = setTimeout(() => {
        route.q = input.value.trim(); // update history entry in place
        runSearch(route.q, c);
      }, 550);
    });
    if (route.q) runSearch(route.q, c);
  }

  // Recent searches are reused, so backspacing or going Back doesn't ask Spotify again.
  const searchCache = new Map();
  let searchRetry = null;
  async function runSearch(q, c) {
    const out = $('search-results');
    if (!out) return;
    observers.forEach((o) => o.disconnect());
    observers = [];
    clearTimeout(searchRetry);
    if (!q) { out.innerHTML = ''; return; }
    if (q.length < 2) { out.innerHTML = `<p class="muted">Keep typing…</p>`; return; }
    out.innerHTML = `<div class="loading">Searching…</div>`;
    try {
      const key = q.toLowerCase();
      const hit = searchCache.get(key);
      let r;
      if (hit && Date.now() - hit.at < 5 * 60 * 1000) r = hit.r;
      else {
        r = await API.search(q);
        searchCache.set(key, { at: Date.now(), r });
        if (searchCache.size > 40) searchCache.delete(searchCache.keys().next().value);
      }
      if (!c.alive() || ($('search-input') || {}).value?.trim() !== q) return; // a newer search is running
      const tracks = (r.tracks ? r.tracks.items : []).filter(Boolean).map(normTrack);
      const artistsList = (r.artists ? r.artists.items : []).filter(Boolean);
      const albums = (r.albums ? r.albums.items : []).filter(Boolean);
      const pls = (r.playlists ? r.playlists.items : []).filter(Boolean);
      const nothing = !tracks.length && !artistsList.length && !albums.length && !pls.length;
      out.innerHTML = nothing ? `<p class="muted">No results for “${esc(q)}”.</p>` : `
        <div class="split-cols">
          <div class="split-main">
            ${artistsList.length ? `<h2 class="section-title">Artists</h2><div class="grid">${artistsList.map((a) => card({ image: img(a.images, 200), title: a.name, sub: 'Artist', nav: `artist:${a.id}`, uri: a.uri, round: true })).join('')}</div>` : ''}
            ${albums.length ? `<h2 class="section-title">Albums</h2><div class="grid">${albums.map((a) => card({ image: img(a.images, 200), title: a.name, sub: artists(a.artists), nav: `album:${a.id}`, uri: a.uri })).join('')}</div>` : ''}
            ${pls.length ? `<h2 class="section-title">Playlists</h2><div class="grid">${pls.map((p) => card({ image: img(p.images, 200), title: p.name, sub: p.owner ? `By ${p.owner.display_name}` : '', nav: `playlist:${p.id}`, uri: p.uri })).join('')}</div>` : ''}
          </div>
          ${tracks.length ? `<aside class="side-box glass-panel" id="song-box">
            <h2 class="section-title">Songs</h2>
            <div id="song-results"></div>
          </aside>` : ''}
        </div>`;
      if (tracks.length) {
        // Songs keep loading as you scroll inside their own box, so the page itself stays short.
        trackList($('song-results'), {
          tracks,
          showAlbum: false,
          root: $('song-box'),
          hasMore: !!(r.tracks && r.tracks.next),
          fetchMore: async (offset) => {
            const p = (await API.searchTracks(q, offset)).tracks;
            const items = (p.items || []).filter(Boolean);
            return { tracks: items.map(normTrack), consumed: p.items.length, hasMore: !!p.next && offset < 100 };
          },
          onPlay: (i, l) => playItems({ uris: l.tracks.slice(i, i + 100).map((t) => t.uri) })
        });
      }
    } catch (e) {
      if (!c.alive()) return;
      if (e.status === 429 && e.retryIn <= 120) {
        // Spotify asked us to wait: say so, count down and search again by itself.
        let left = e.retryIn;
        const tick = () => {
          if (!c.alive() || ($('search-input') || {}).value?.trim() !== q) return;
          if (left <= 0) { runSearch(q, c); return; }
          out.innerHTML = `<p class="muted">Spotify’s asking us to slow down for a moment. Searching again in ${left}s…</p>`;
          left--; searchRetry = setTimeout(tick, 1000);
        };
        tick();
        return;
      }
      out.innerHTML = `<p class="error">Search failed: ${esc(e.message)}</p>`;
    }
  }

  async function renderLiked(c) {
    const first = await API.savedTracks(0);
    if (!c.alive()) return;
    view.innerHTML = `<div class="view">
      ${header({ image: '', kind: 'Playlist', title: 'Liked Songs', meta: `${me ? (me.display_name || me.id) + ' • ' : ''}${first.total} songs`, liked: true })}
      ${playBtn()}
    </div>`;
    tintHero('', c);
    const list = trackList(view.firstElementChild, {
      tracks: first.items.map((x) => normTrack(x.track)).filter(Boolean),
      offset: first.items.length,
      hasMore: !!first.next,
      fetchMore: async (offset) => {
        const p = await API.savedTracks(offset);
        return { tracks: p.items.map((x) => normTrack(x.track)).filter(Boolean), consumed: p.items.length, hasMore: !!p.next };
      },
      onPlay: playLiked
    });
    $('hero-play').onclick = () => list.tracks.length && playLiked(0, list);
  }

  // Liked Songs plays as a proper context so it keeps going past what's loaded.
  async function playLiked(i, list) {
    const target = np ? np.device.id : deviceId;
    if (!target) return banner('The player isn’t ready yet — give it a second.');
    try {
      await API.play(target, { context_uri: `spotify:user:${me.id}:collection`, offset: { uri: list.tracks[i].uri } });
      afterRemote(700);
    } catch {
      playItems({ uris: list.tracks.slice(i, i + 100).map((t) => t.uri) });
    }
  }

  async function renderPlaylist(id, c) {
    const p = await API.playlist(id);
    if (!c.alive()) return;
    // Development Mode only returns contents for playlists you own or collaborate on.
    const page = p.items;
    const mine = ownsPlaylist(p) || !!p.collaborative;
    // Remember each song's real position in the playlist (needed for reordering).
    const pick = (x, pos) => { const t = normTrack(x.item || x.track); if (t) t.pos = pos; return t; };
    view.innerHTML = `<div class="view">
      ${header({ image: img(p.images, 300), kind: p.public === false ? 'Private playlist' : 'Playlist', title: p.name, meta: [p.owner && p.owner.display_name, page ? `${page.total} songs` : null].filter(Boolean).join(' • '), desc: p.description })}
      <div class="actions pl-actions">
        <button class="play-btn big" id="hero-play" title="Play">${ICONS.play}</button>
        ${mine ? `<button class="icon-btn big" id="pl-more" title="More options">${ICONS.more}</button>` : ''}
        ${mine && page && page.total > 1 ? '<span class="muted small pl-hint">Drag songs to reorder</span>' : ''}
      </div>
      ${page ? (page.total ? '' : '<p class="muted note">This playlist is empty. Right-click any song and choose <b>Add to playlist</b>.</p>') : `<p class="muted note">Spotify only shares the track list for playlists you own or collaborate on, but you can still play this one.</p>`}
    </div>`;
    tintHero(img(p.images, 300), c);
    $('hero-play').onclick = () => playItems({ context_uri: p.uri });
    if (mine) {
      $('pl-more').onclick = (e) => {
        const r = e.currentTarget.getBoundingClientRect();
        openMenu(r.left, r.bottom + 6, [
          { label: 'Edit details…', action: () => editPlaylistFlow(p) },
          ownsPlaylist(p) && { label: 'Delete playlist…', action: () => deletePlaylistFlow(p) }
        ]);
      };
    }
    if (page && page.total) {
      trackList(view.firstElementChild, {
        tracks: page.items.map((x, k) => pick(x, k)).filter((t) => t && t.uri),
        offset: page.items.length,
        hasMore: !!page.next,
        fetchMore: async (offset) => {
          const r = await API.playlistItems(id, offset);
          return { tracks: r.items.map((x, k) => pick(x, offset + k)).filter((t) => t && t.uri), consumed: r.items.length, hasMore: !!r.next };
        },
        onPlay: (i, l) => playItems({ context_uri: p.uri, offset: { uri: l.tracks[i].uri } }),
        menuExtra: mine ? (i, l) => [{ label: 'Remove from this playlist', action: async () => {
          try {
            await API.removeFromPlaylist(id, [l.tracks[i].uri]);
            banner(`Removed from ${p.name}`);
            render(hist[hIdx], content.scrollTop);
          } catch (e) { banner(e.message); }
        } }] : null,
        reorder: mine ? async (from, to, l) => {
          const a = l.tracks[from].pos;
          const b = to < l.tracks.length ? l.tracks[to].pos : l.tracks[l.tracks.length - 1].pos + 1;
          try { await API.reorderPlaylist(id, a, b); } catch (e) { banner(e.message); return false; }
          // Shift the remembered positions the same way Spotify just did.
          for (const t of l.tracks) {
            const q = t.pos;
            if (a < b) { if (q === a) t.pos = b - 1; else if (q > a && q < b) t.pos = q - 1; }
            else { if (q === a) t.pos = b; else if (q >= b && q < a) t.pos = q + 1; }
          }
          return true;
        } : null
      });
    }
  }

  async function renderAlbum(id, c) {
    const a = await API.album(id);
    if (!c.alive()) return;
    const albumRef = { id: a.id, name: a.name, images: a.images };
    const withAlbum = (t) => normTrack({ ...t, album: albumRef });
    const year = (a.release_date || '').slice(0, 4);
    view.innerHTML = `<div class="view">
      ${header({ image: img(a.images, 300), kind: a.album_type === 'single' ? 'Single' : 'Album', title: a.name, meta: [a.artists.map((ar) => `<span class="link" data-nav="artist:${esc(ar.id)}">${esc(ar.name)}</span>`).join(', '), year, `${a.total_tracks} songs`].filter(Boolean).join(' • '), rawMeta: true })}
      ${playBtn()}
    </div>`;
    tintHero(img(a.images, 300), c);
    $('hero-play').onclick = () => playItems({ context_uri: a.uri });
    trackList(view.firstElementChild, {
      tracks: a.tracks.items.map(withAlbum),
      offset: a.tracks.items.length,
      hasMore: !!a.tracks.next,
      fetchMore: async (offset) => {
        const r = await API.albumTracks(id, offset);
        return { tracks: r.items.map(withAlbum), consumed: r.items.length, hasMore: !!r.next };
      },
      onPlay: (i) => playItems({ context_uri: a.uri, offset: { position: i } }),
      showAlbum: false,
      showArt: false
    });
  }

  async function renderArtist(id, c) {
    const [a, albums] = await Promise.all([API.artist(id), API.artistAlbums(id)]);
    if (!c.alive()) return;
    view.innerHTML = `<div class="view">
      ${header({ image: img(a.images, 300), kind: 'Artist', title: a.name, meta: (a.genres || []).slice(0, 3).join(', '), round: true,
        aside: `<aside class="about" id="artist-about"><div class="about-loading"><span class="spinner"></span><span class="muted small">Looking up ${esc(a.name)}…</span></div></aside>` })}
      ${playBtn()}
      <div class="split-cols artist-cols">
        <div class="split-main" id="disco"><h2 class="section-title">Discography</h2></div>
        <aside class="side-box glass-panel" id="popular-box">
          <h2 class="section-title">Popular</h2>
          <div id="popular-list"><div class="about-loading"><span class="spinner"></span></div></div>
        </aside>
      </div>
    </div>`;
    tintHero(img(a.images, 300), c);
    $('hero-play').onclick = () => playItems({ context_uri: a.uri });
    const toCard = (al) => card({ image: img(al.images, 200), title: al.name, sub: `${(al.release_date || '').slice(0, 4)} • ${al.album_type === 'single' ? 'Single' : 'Album'}`, nav: `album:${al.id}`, uri: al.uri });
    loadPopular(a, c);
    cardGrid($('disco'), {
      items: albums.items.filter(Boolean),
      offset: albums.items.length,
      hasMore: !!albums.next,
      fetchMore: async (offset) => {
        const r = await API.artistAlbums(id, offset);
        return { items: r.items.filter(Boolean), consumed: r.items.length, hasMore: !!r.next };
      },
      toCard
    });
    // Bio and facts arrive separately so the page never waits on them.
    window.sweetspot.artistInfo(a.id, a.name, a.genres || []).then((info) => {
      if (c.alive() && $('artist-about')) renderAbout($('artist-about'), info, a);
    }).catch(() => { if (c.alive() && $('artist-about')) renderAbout($('artist-about'), { found: false }, a); });
  }

  // Spotify no longer offers "top tracks" to personal apps, so this uses Spotify search,
  // which ranks an artist's most-played songs first. Keeps only songs by this artist and
  // drops repeats such as remasters, live cuts of the same name and re-releases.
  async function loadPopular(a, c) {
    const box = $('popular-list');
    const key = (n) => n.toLowerCase().replace(/\s*[-–(\[].*(remaster|version|edit|mix|live|mono|stereo|deluxe|anniversary|single).*$/i, '').replace(/[^a-z0-9]+/g, '');
    try {
      const q = `artist:"${a.name.replace(/"/g, '')}"`;
      const pages = await Promise.all([0, 10, 20].map((off) => API.searchTracks(q, off).catch(() => null)));
      if (!c.alive() || !$('popular-list')) return;
      const seen = new Set();
      const tracks = [];
      for (const p of pages) {
        for (const t of (p && p.tracks && p.tracks.items) || []) {
          if (!t || !(t.artists || []).some((x) => x.id === a.id)) continue;
          const k = key(t.name);
          if (seen.has(k)) continue;
          seen.add(k);
          tracks.push(normTrack(t));
        }
      }
      if (!tracks.length) { box.innerHTML = '<p class="muted small pad">Couldn’t find popular songs for this artist.</p>'; return; }
      box.innerHTML = '';
      trackList(box, {
        tracks: tracks.slice(0, 15),
        showAlbum: false,
        root: $('popular-box'),
        onPlay: (i, l) => playItems({ uris: l.tracks.map((t) => t.uri), offset: { position: i } })
      });
    } catch (e) {
      if (c.alive() && $('popular-list')) box.innerHTML = `<p class="muted small pad">Couldn’t load popular songs.</p>`;
    }
  }

  function renderAbout(el, info, a) {
    if (!info || !info.found) {
      el.innerHTML = `<div class="about-head"><span class="about-label">About</span></div>
        <p class="muted small">No extra info found for ${esc(a.name)}.${info && info.error ? ' (Couldn’t reach the music databases.)' : ''}</p>`;
      return;
    }
    const isPerson = info.type === 'Person';
    const facts = [];
    if (info.begin) facts.push(`<span><b>${isPerson ? 'Born' : 'Formed'}</b>${esc(info.begin)}</span>`);
    if (info.origin) facts.push(`<span><b>From</b>${esc(info.origin)}</span>`);
    if (info.end && !isPerson) facts.push(`<span><b>Split</b>${esc(info.end === 'yes' ? '' : info.end)}</span>`);
    const members = info.members || [];
    const current = members.filter((m) => m.current);
    const former = members.filter((m) => !m.current);
    const memberChip = (m) => `<span class="chip${m.current ? '' : ' former'}" title="${esc([m.roles.join(', '), [m.from, m.current ? 'present' : m.to].filter(Boolean).join('–')].filter(Boolean).join(' • '))}">${esc(m.name)}</span>`;
    const genres = (info.genres && info.genres.length ? info.genres : a.genres || []).slice(0, 5);
    const links = [];
    if (info.links && info.links.wikipedia) links.push(`<a href="${esc(info.links.wikipedia)}" target="_blank">Wikipedia</a>`);
    if (info.links && info.links.official) links.push(`<a href="${esc(info.links.official)}" target="_blank">Official site</a>`);
    const mb = (info.sources || []).find((x) => x.name === 'MusicBrainz');
    if (mb) links.push(`<a href="${esc(mb.url)}" target="_blank">MusicBrainz</a>`);

    el.innerHTML = `
      <div class="about-head"><span class="about-label">About</span>${info.description ? `<span class="about-desc">${esc(info.description)}</span>` : ''}</div>
      ${info.extract ? `<p class="about-text" id="about-text">${esc(info.extract)}</p>` : ''}
      ${facts.length ? `<div class="about-facts">${facts.join('')}</div>` : ''}
      ${current.length || former.length ? `<div class="about-row"><span class="about-sub">${current.length ? 'Members' : 'Former members'}</span>
        <div class="chips">${(current.length ? current : former.slice(0, 6)).slice(0, 8).map(memberChip).join('')}
        ${current.length && former.length ? `<button class="chip former more" id="former-btn">+${former.length} former</button>` : ''}</div></div>` : ''}
      ${genres.length ? `<div class="about-row"><span class="about-sub">Genres</span><div class="chips">${genres.map((g) => `<span class="chip genre">${esc(g)}</span>`).join('')}</div></div>` : ''}
      ${links.length ? `<div class="about-links">${links.join('<span>·</span>')}</div>` : ''}`;

    const txt = $('about-text');
    if (txt && txt.scrollHeight > txt.clientHeight + 4) {
      txt.insertAdjacentHTML('afterend', '<button class="about-more" id="about-more">Read more</button>');
      $('about-more').onclick = () => {
        const open = txt.classList.toggle('open');
        $('about-more').textContent = open ? 'Show less' : 'Read more';
      };
    }
    const fb = $('former-btn');
    if (fb) fb.onclick = () => { fb.insertAdjacentHTML('beforebegin', former.map(memberChip).join('')); fb.remove(); };
  }

  // Errors from the main process arrive as "Error invoking remote method 'x': Error: …".
  const ipcMsg = (e) => String((e && e.message) || e).replace(/^Error invoking remote method '[^']+': (Error: )?/, '');

  // ---------- Discover (ListenBrainz) ----------
  // ListenBrainz lists songs by title + artist, so each one is looked up on Spotify.
  // Matches are cached (in memory and on disk) so a playlist only needs matching once.
  const Matcher = (() => {
    const mem = new Map();
    const nk = (s) => String(s || '').toLowerCase().normalize('NFKD').replace(/[̀-ͯ]/g, '')
      .replace(/\s*[([][^)\]]*[)\]]/g, '')
      .replace(/\s+-\s+.*(remaster|version|edit|mix|live|mono|stereo).*$/, '')
      .replace(/^the\s+/, '').replace(/[^a-z0-9]+/g, '');
    const firstArtist = (t) => (t.artists && t.artists[0]) || t.artist || '';
    const keyOf = (t) => `${nk(firstArtist(t))}|${nk(t.title)}`;
    const clean = (s) => String(s || '').replace(/"/g, '').replace(/\s*[([][^)\]]*[)\]]/g, '').trim();
    const slim = (s) => ({
      id: s.id, uri: s.uri, name: s.name, duration_ms: s.duration_ms,
      artists: (s.artists || []).map((a) => ({ id: a.id, name: a.name })),
      album: s.album ? { id: s.album.id, name: s.album.name, images: (s.album.images || []).slice(-2) } : null
    });
    function score(s, t) {
      const tn = nk(t.title), sn = nk(s.name);
      const titleOk = sn === tn || (tn.length > 3 && (sn.startsWith(tn) || tn.startsWith(sn)));
      const wanted = (t.artists && t.artists.length ? t.artists : [t.artist]).map(nk).filter(Boolean);
      const have = (s.artists || []).map((a) => nk(a.name));
      const artistOk = wanted.some((w) => have.some((h) => h === w || (w.length > 3 && h.length > 3 && (h.includes(w) || w.includes(h)))));
      return (titleOk ? 2 : 0) + (artistOk ? 2 : 0) + (sn === tn ? 1 : 0);
    }
    // One Spotify search per song (a looser second search only when the first finds
    // nothing at all). Results are remembered in memory and on disk, so a song is only
    // ever looked up once.
    async function lookup(t, background) {
      const title = clean(t.title), artist = clean(firstArtist(t));
      for (const q of [`track:"${title}" artist:"${artist}"`, `${title} ${artist}`]) {
        const r = await API.searchTrackMatch(q, background);
        const items = ((r && r.tracks && r.tracks.items) || []).filter(Boolean);
        let best = null, bestScore = 0;
        for (const s of items) {
          const sc = score(s, t);
          if (sc > bestScore) { best = s; bestScore = sc; }
        }
        if (best && bestScore >= 4) return slim(best);
        if (items.length) return false; // Spotify had results, just not this song
      }
      return false;
    }

    // Fill in whatever is already known (memory or the disk cache), without asking Spotify.
    async function prime(tracks) {
      const unknown = [...new Set(tracks.map(keyOf).filter((k) => !mem.has(k)))];
      if (unknown.length) {
        const cached = await window.sweetspot.matchGet(unknown).catch(() => ({}));
        for (const [k, val] of Object.entries(cached)) mem.set(k, val);
      }
      return tracks.map((t) => (t.spotify ? t.spotify : mem.has(keyOf(t)) ? mem.get(keyOf(t)) : undefined));
    }

    const inflight = new Map();
    let fresh = {}, saveTimer = null;
    // Returns the Spotify track, false if it isn't on Spotify, or null if the lookup failed.
    function matchOne(t, background = true) {
      if (t.spotify) return Promise.resolve(t.spotify);
      const k = keyOf(t);
      if (mem.has(k)) return Promise.resolve(mem.get(k));
      if (!inflight.has(k)) {
        inflight.set(k, lookup(t, background).then((m) => {
          mem.set(k, m); fresh[k] = m;
          clearTimeout(saveTimer);
          saveTimer = setTimeout(() => { const f = fresh; fresh = {}; window.sweetspot.matchPut(f).catch(() => {}); }, 2000);
          return m;
        }, () => null).finally(() => inflight.delete(k)));
      }
      return inflight.get(k);
    }
    return { prime, matchOne, slim };
  })();

  // Quick mix straight from Spotify search, used when ListenBrainz can't make one
  // (no token connected, or the service is busy). Deeper "modes" read further down
  // Spotify's results, which run from most to least popular.
  async function spotifyMix(prompt, mode) {
    const a = /^artist:\(([^)]+)\)$/.exec(prompt);
    const g = /^tag:\(([^)]+)\)$/.exec(prompt);
    if (!a && !g) throw new Error('Custom prompts need ListenBrainz connected (Settings → ListenBrainz).');
    const base = { easy: 0, medium: 40, hard: 100 }[mode] || 0;
    const search = (q, offset, type = 'track') => API.api('/search', { query: { q, type, limit: 10, offset } }).catch(() => null);
    const items = (r, type = 'tracks') => ((r && r[type] && r[type].items) || []).filter(Boolean);
    const shuffle = (arr) => { for (let i = arr.length - 1; i > 0; i--) { const j = Math.floor(Math.random() * (i + 1)); [arr[i], arr[j]] = [arr[j], arr[i]]; } return arr; };
    // Keep it varied: at most `cap` songs per artist.
    const varied = (list, cap, skipArtist) => {
      const per = new Map(), seen = new Set(), out = [];
      for (const t of list) {
        const id = t.artists && t.artists[0] && t.artists[0].id;
        if (!t.uri || seen.has(t.uri) || (skipArtist && id === skipArtist)) continue;
        if ((per.get(id) || 0) >= cap) continue;
        per.set(id, (per.get(id) || 0) + 1);
        seen.add(t.uri);
        out.push(t);
      }
      return out;
    };
    const genreSongs = async (genre, pages) => (await Promise.all(pages.map((o) => search(`genre:"${genre}"`, base + o)))).flatMap((r) => items(r));

    let songs;
    if (g) {
      songs = shuffle(varied(await genreSongs(g[1], [0, 10, 20, 30, 40]), 3)).slice(0, 40);
    } else {
      const name = a[1];
      const found = items(await search(`artist:"${name}"`, 0, 'artist'), 'artists');
      const want = name.toLowerCase();
      const artist = found.find((x) => x.name.toLowerCase() === want) || found[0];
      if (!artist) throw new Error(`Couldn’t find ${name} on Spotify.`);
      const own = varied((await Promise.all([0, 10].map((o) => search(`artist:"${artist.name}"`, (mode === 'hard' ? 20 : 0) + o)))).flatMap((r) => items(r))
        .filter((t) => (t.artists || []).some((x) => x.id === artist.id)), 99).slice(0, 10);
      let genres = (artist.genres || []).slice(0, 2);
      if (!genres.length) {
        // Spotify sometimes has no genres for an artist; MusicBrainz (the About card's source) usually does.
        const info = await window.sweetspot.artistInfo(artist.id, artist.name, []).catch(() => null);
        genres = ((info && info.genres) || []).slice(0, 2);
      }
      const others = shuffle(varied((await Promise.all(genres.map((ge) => genreSongs(ge, [0, 10, 20])))).flat(), 2, artist.id)).slice(0, 30);
      // Spread the artist's own songs through the mix.
      songs = [];
      const step = others.length && own.length ? Math.max(1, Math.round(others.length / own.length)) : 1;
      let oi = 0;
      others.forEach((t, i) => { if (i % step === 0 && oi < own.length) songs.push(own[oi++]); songs.push(t); });
      while (oi < own.length) songs.push(own[oi++]);
    }
    return {
      title: prompt,
      source: 'spotify',
      feedback: [],
      tracks: songs.map((s) => ({
        title: s.name, artist: artists(s.artists), artists: (s.artists || []).map((x) => x.name),
        album: s.album && s.album.name, cover: img(s.album && s.album.images, 64), spotify: Matcher.slim(s)
      }))
    };
  }

  // Colour for ListenBrainz playlists (they have no cover art of their own).
  const hueOf = (title) => { let h = 0; for (const ch of String(title)) h = (h * 31 + ch.charCodeAt(0)) % 360; return h; };
  function lbTile(title, kind = 'people') {
    return `<div class="lb-tile" style="--h:${hueOf(title)}"><span class="lb-tile-ico">${ICONS[kind] || ICONS.people}</span><span class="lb-tile-title">${esc(title)}</span></div>`;
  }

  // Playlist details for the Discover lists.
  const DAY = 86400000;
  function relTime(iso) {
    const t = Date.parse(iso || '');
    if (!t) return '';
    const d = Math.floor((Date.now() - t) / DAY);
    if (d < 1) return 'today';
    if (d < 2) return 'yesterday';
    if (d < 14) return `${d} days ago`;
    if (d < 60) return `${Math.round(d / 7)} wk ago`;
    if (d < 365) return `${Math.round(d / 30)} mo ago`;
    const y = Math.round(d / 365);
    return `${y} yr${y > 1 ? 's' : ''} ago`;
  }
  const longDate = (iso) => { const t = Date.parse(iso || ''); return t ? new Date(t).toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: 'numeric' }) : ''; };
  function fmtLen(ms) {
    if (!ms) return '';
    const m = Math.round(ms / 60000);
    return m >= 60 ? `${Math.floor(m / 60)} hr ${m % 60} min` : `${m} min`;
  }
  const statSongs = (n) => (n == null ? '' : `${n} song${n === 1 ? '' : 's'}`);

  // One row in the Discover playlist lists: title and author on the left, stats on the right.
  // Song count and length need the full playlist, so they fill in as rows scroll into view.
  const lbItem = (p, kind) => {
    const updated = p.modified || p.date;
    const tip = [p.title,
      p.date ? `Created ${longDate(p.date)}` : '',
      p.modified ? `Last updated ${longDate(p.modified)}` : '',
      p.collaborators ? `${p.collaborators} collaborator${p.collaborators > 1 ? 's' : ''}` : '',
      p.copied ? 'Copied from another playlist' : ''].filter(Boolean).join('\n');
    const badges = [p.collaborators ? `<span class="lb-badge" title="Collaborative">${ICONS.people} ${p.collaborators + 1}</span>` : '',
      p.copied ? '<span class="lb-badge">Copy</span>' : ''].join('');
    return `
    <button class="lb-item" data-id="${esc(p.id)}" data-kind="${kind}" title="${esc(tip)}">
      <span class="lb-chip" style="--h:${hueOf(p.title)}">${ICONS[kind === 'mfy' ? 'sparkle' : 'people']}</span>
      <span class="lb-item-text">
        <span class="lb-item-title">${esc(p.title)}</span>
        <span class="muted small">${esc(p.creator ? `By ${p.creator}` : 'Playlist')}${badges}</span>
      </span>
      <span class="lb-stats">
        <span class="lb-stat" data-stat="songs">${p.count != null ? esc(statSongs(p.count)) : '<i class="lb-skel"></i>'}</span>
        <span class="lb-stat lb-stat-len" data-stat="len">${p.durationMs ? esc(fmtLen(p.durationMs)) : '<i class="lb-skel"></i>'}</span>
        <span class="lb-stat lb-stat-date">${updated ? esc(`${p.modified ? 'Updated' : 'Created'} ${relTime(updated)}`) : ''}</span>
      </span>
      <span class="lb-item-arrow">${ICONS.forward}</span>
    </button>`;
  };

  // Loads each visible row's full playlist (one at a time, in the background) to fill in song count and length.
  // The results are cached in the app, so opening the playlist afterwards is instant.
  function loadLbStats(container, c) {
    const rows = [...container.querySelectorAll('.lb-item')].filter((r) => r.querySelector('.lb-skel'));
    if (!rows.length) return;
    const queue = [];
    let running = 0;
    const fill = (row, data) => {
      const n = data ? (data.tracks || []).length : null;
      row.querySelector('[data-stat="songs"]').textContent = data ? statSongs(n) : '';
      row.querySelector('[data-stat="len"]').textContent = data ? fmtLen(data.durationMs || (data.tracks || []).reduce((a, t) => a + (t.durationMs || 0), 0)) : '';
      row.classList.toggle('lb-empty', n === 0);
    };
    const pump = () => {
      while (running < 1 && queue.length) {
        const row = queue.shift();
        if (!c.alive() || !row.isConnected) continue;
        running++;
        window.sweetspot.lbPlaylist(row.dataset.id, { background: true })
          .then((d) => { if (row.isConnected) fill(row, d); }, () => { if (row.isConnected) fill(row, null); })
          .finally(() => { running--; pump(); });
      }
    };
    const io = new IntersectionObserver((entries) => {
      for (const e of entries) if (e.isIntersecting) { io.unobserve(e.target); queue.push(e.target); }
      if (!c.alive()) io.disconnect(); else pump();
    }, { root: content, rootMargin: '200px' });
    rows.forEach((r) => io.observe(r));
  }

  const MIX_MODES = [['easy', 'Familiar'], ['medium', 'Mixed'], ['hard', 'Deep cuts']];
  const GENRES = ['rock', 'nu metal', 'metal', 'hip hop', 'electronic', 'indie', 'pop punk', 'chill', 'jazz', 'acoustic', '80s', '90s'];
  const COMMUNITY_IDEAS = ['road trip', 'workout', 'chill', 'gaming', 'study', 'party', 'sleep', 'summer'];

  function mixPrompt(kind, text) {
    const t = text.trim();
    if (kind === 'custom' || /[a-z]+:/.test(t)) return t; // already an LB Radio prompt
    const name = t.replace(/[()]/g, '');
    return kind === 'artist' ? `artist:(${name})` : `tag:(${name})`;
  }

  function mixTitle(prompt) {
    const a = /^artist:\(([^)]+)\)$/.exec(prompt);
    if (a) return `${a[1]} mix`;
    const g = /^tag:\(([^)]+)\)$/.exec(prompt);
    if (g) return `${g[1].replace(/\b\w/g, (m) => m.toUpperCase())} mix`;
    return 'Instant mix';
  }

  async function renderDiscover(route, c) {
    const s = settings;
    const npArtist = np && np.track.artists[0] && np.track.artists[0].name;
    view.innerHTML = `<div class="view discover">
      <h1 class="page-title">Discover</h1>

      <section class="disc-panel glass-panel">
        <div class="disc-head"><span class="disc-ico">${ICONS.sparkle}</span>
          <div><h2>Instant mix</h2><p class="muted small">A fresh playlist built around an artist or genre, from ListenBrainz’s open music data.</p></div></div>
        <form id="mix-form" class="mix-form" autocomplete="off">
          <div class="seg" id="mix-kind"><button type="button" data-value="artist" class="on">Artist</button><button type="button" data-value="tag">Genre</button></div>
          <div class="search-bar mix-input"><span class="ico">${ICONS.search}</span><input id="mix-q" placeholder="Artist name, e.g. ${esc(npArtist || 'Drowning Pool')}" spellcheck="false"></div>
          <div class="seg" id="mix-mode">${MIX_MODES.map(([v, l], i) => `<button type="button" data-value="${v}" class="${i === 0 ? 'on' : ''}">${l}</button>`).join('')}</div>
          <button class="btn-primary" type="submit">Create mix</button>
        </form>
        <p class="muted small mix-src" id="mix-src"></p>
        <div class="chips mix-ideas">
          ${npArtist ? `<button class="chip idea np-idea" data-kind="artist" data-q="${esc(npArtist)}">${ICONS.sparkle} More like ${esc(npArtist)}</button>` : ''}
          ${GENRES.map((g) => `<button class="chip idea" data-kind="tag" data-q="${esc(g)}">${esc(g)}</button>`).join('')}
        </div>
      </section>

      <div class="disc-split">
        <div class="disc-left" id="disc-left">
          <section class="disc-section">
            <h2 class="section-title">Community playlists</h2>
            <div class="search-bar"><span class="ico">${ICONS.search}</span><input id="lb-q" placeholder="Search playlists people have shared, e.g. road trip" value="${esc(route.q || '')}" spellcheck="false"></div>
            <div class="chips comm-ideas">${COMMUNITY_IDEAS.map((q) => `<button class="chip" data-cq="${esc(q)}">${esc(q)}</button>`).join('')}</div>
            <div id="lb-results" class="lb-list"><p class="muted small lb-hint">Search, or pick a topic above.</p></div>
          </section>

          <section class="disc-section">
            <h2 class="section-title">Made for you</h2>
            <div id="made-for-you" class="lb-list">${s.lbUser ? '<div class="loading">Loading your ListenBrainz playlists…</div>' : `
              <div class="disc-hint glass-panel">
                <span class="disc-ico">${ICONS.compass}</span>
                <div><b>Get weekly playlists made for you</b>
                  <p class="muted small">ListenBrainz builds <i>Weekly Jams</i> and <i>Weekly Exploration</i> from what you listen to, much like Discover Weekly used to. Connect ListenBrainz in Settings.</p></div>
                <button class="btn-secondary" id="lb-link">Open Settings</button>
              </div>`}</div>
          </section>
        </div>

        <aside class="disc-detail glass-panel" id="disc-detail">
          <div class="dd-empty">
            <span class="disc-ico">${ICONS.people}</span>
            <b>Pick a playlist</b>
            <p class="muted small">Choose one on the left to see its songs here. You can play it straight away or save it to your Spotify playlists.</p>
          </div>
        </aside>
      </div>
    </div>`;

    // Instant mix
    let kind = 'artist', mode = 'easy';
    const segPick = (id, set) => $(id).querySelectorAll('button').forEach((b) => b.onclick = () => {
      $(id).querySelectorAll('button').forEach((x) => x.classList.toggle('on', x === b));
      set(b.dataset.value);
    });
    segPick('mix-kind', (v) => { kind = v; $('mix-q').placeholder = v === 'artist' ? `Artist name, e.g. ${npArtist || 'Drowning Pool'}` : 'Genre, e.g. nu metal'; });
    segPick('mix-mode', (v) => { mode = v; });
    $('mix-form').onsubmit = (e) => {
      e.preventDefault();
      const q = $('mix-q').value.trim();
      if (!q) return $('mix-q').focus();
      navigate({ view: 'mix', id: mode, q: mixPrompt(kind, q) });
    };
    view.querySelectorAll('.chip.idea').forEach((b) => b.onclick = () => navigate({ view: 'mix', id: mode, q: mixPrompt(b.dataset.kind, b.dataset.q) }));
    if ($('lb-link')) $('lb-link').onclick = () => navigate({ view: 'settings' });
    window.sweetspot.lbTokenStatus().then((st) => {
      if (!c.alive() || !$('mix-src')) return;
      $('mix-src').innerHTML = st.connected
        ? `Mixes come from ListenBrainz and include similar artists.`
        : `Mixes come from Spotify search for now. <button class="btn-link inline" id="mix-src-link">Connect ListenBrainz</button> for smarter mixes with similar artists.`;
      if ($('mix-src-link')) $('mix-src-link').onclick = () => navigate({ view: 'settings' });
    }).catch(() => {});

    // Clicking a playlist shows it on the right; the lists on the left stay put.
    const markSelected = () => view.querySelectorAll('.lb-item').forEach((r) => r.classList.toggle('on', r.dataset.id === route.sel));
    $('disc-left').addEventListener('click', (e) => {
      const item = e.target.closest('.lb-item');
      if (item) showPlaylistDetail(item.dataset.id, item.dataset.kind, route, c, markSelected);
    });

    // Made for you
    if (s.lbUser) {
      window.sweetspot.lbCreatedFor(s.lbUser).then((list) => {
        if (!c.alive()) return;
        $('made-for-you').innerHTML = list.length
          ? list.slice(0, 12).map((p) => lbItem(p, 'mfy')).join('')
          : `<p class="muted small">No playlists yet for <b>${esc(s.lbUser)}</b>. ListenBrainz makes them once it has a week or so of your listening.</p>`;
        markSelected();
        loadLbStats($('made-for-you'), c);
      }).catch((e) => {
        if (c.alive()) $('made-for-you').innerHTML = `<p class="muted small">Couldn’t load playlists for <b>${esc(s.lbUser)}</b>: ${esc(ipcMsg(e))}. Check the username in Settings.</p>`;
      });
    }

    // Community search
    let timer;
    const runCommunity = async (q) => {
      route.q = q; // kept in history so Back returns to the same results
      const out = $('lb-results');
      if (!out) return;
      view.querySelectorAll('[data-cq]').forEach((b) => b.classList.toggle('on', b.dataset.cq === q));
      if (q.length < 3) { out.innerHTML = `<p class="muted small lb-hint">${q ? 'Type at least 3 letters.' : 'Search, or pick a topic above.'}</p>`; return; }
      out.innerHTML = '<div class="loading">Searching ListenBrainz…</div>';
      try {
        const list = await window.sweetspot.lbSearch(q);
        if (!c.alive() || $('lb-q').value.trim() !== q) return;
        out.innerHTML = list.length ? list.map((p) => lbItem(p, 'community')).join('') : `<p class="muted small lb-hint">No shared playlists match “${esc(q)}”.</p>`;
        markSelected();
        loadLbStats(out, c);
      } catch (e) {
        if (c.alive()) out.innerHTML = `<p class="error small">Search failed: ${esc(ipcMsg(e))}</p>`;
      }
    };
    $('lb-q').addEventListener('input', () => { clearTimeout(timer); timer = setTimeout(() => runCommunity($('lb-q').value.trim()), 350); });
    view.querySelectorAll('[data-cq]').forEach((b) => b.onclick = () => { $('lb-q').value = b.dataset.cq; runCommunity(b.dataset.cq); });
    if (route.q) runCommunity(route.q);
    if (route.sel) showPlaylistDetail(route.sel, route.selKind, route, c, markSelected);
  }

  // The right-hand panel on Discover.
  let detailToken = 0;
  async function showPlaylistDetail(id, kind, route, c, markSelected) {
    route.sel = id;
    route.selKind = kind;
    markSelected();
    const my = ++detailToken;
    const alive = () => c.alive() && my === detailToken;
    const d = $('disc-detail');
    d.scrollTop = 0;
    d.innerHTML = '<div class="dd-loading"><span class="spinner"></span>Loading playlist…</div>';
    let data;
    try { data = await window.sweetspot.lbPlaylist(id); }
    catch (e) { if (alive()) d.innerHTML = `<p class="error small pad">Couldn’t load this playlist: ${esc(ipcMsg(e))}</p>`; return; }
    if (!alive()) return;
    const tracks = data.tracks || [];
    const mfy = kind === 'mfy' || !!data.createdFor;
    d.innerHTML = `
      <div class="dd-head">
        <div class="dd-art" id="dd-art">${lbTile(data.title, mfy ? 'sparkle' : 'people')}</div>
        <div class="dd-text">
          <div class="small muted">${mfy ? 'Made for you' : 'Community playlist'}</div>
          <h2 class="dd-title">${esc(data.title)}</h2>
          <div class="muted small">${esc([data.creator ? `By ${data.creator}` : '', statSongs(tracks.length), fmtLen(data.durationMs), data.modified ? `Updated ${relTime(data.modified)}` : (data.date ? `Created ${relTime(data.date)}` : '')].filter(Boolean).join(' • '))}<span id="dd-status"></span></div>
        </div>
      </div>
      ${data.description ? `<p class="dd-desc muted small">${esc(data.description)}</p>` : ''}
      <div class="dd-actions">
        <button class="play-btn" id="dd-play" title="Play">${ICONS.play}</button>
        <button class="btn-secondary" id="dd-save" disabled>Save to my playlists</button>
        <a class="lb-link" href="https://listenbrainz.org/playlist/${esc(id)}/" target="_blank">Open on ListenBrainz</a>
      </div>
      <div id="dd-tracks" class="dd-tracks"></div>`;
    if (!tracks.length) {
      $('dd-tracks').innerHTML = '<p class="muted small pad">This playlist is empty.</p>';
      $('dd-save').remove();
      $('dd-play').disabled = true;
      return;
    }
    const m = mountLbTracks({
      host: $('dd-tracks'), tracks, statusEl: $('dd-status'), artEl: $('dd-art'), alive, compact: true,
      onDone: (found) => { if ($('dd-save')) $('dd-save').disabled = !found; }
    });
    $('dd-play').onclick = () => m.playFrom(0);
    $('dd-save').onclick = () => saveLbPlaylist($('dd-save'), m, data.title, `From “${data.title}” by ${data.creator || 'a ListenBrainz user'} on ListenBrainz.`);
  }

  // Track list for ListenBrainz playlists and mixes: rows start as ListenBrainz data,
  // then fill in with the Spotify match. Used by the Discover panel and the mix page.
  function mountLbTracks({ host, tracks, statusEl, artEl, alive, compact = false, onDone }) {
    host.innerHTML = `<div class="tracks">
      <div class="track-head muted"><span>#</span><span>Title</span><span>${compact ? '' : 'Album'}</span><span class="r">Time</span><span></span></div>
      <div class="track-body"></div></div>`;
    const body = host.querySelector('.track-body');
    const matched = new Array(tracks.length).fill(null);
    const list = { tracks: matched, play: (i) => playFrom(i) };
    body._list = list;

    const pendingRow = (t, i, state) => `
      <div class="track-row lb-row ${state}" data-track-index="${i}"${state === 'missing' ? ' title="Couldn’t find this song on Spotify"' : ''}>
        <span class="idx muted">${i + 1}</span>
        <span class="t-main">
          ${t.cover ? `<img src="${esc(t.cover)}" alt="" loading="lazy">` : '<span class="ph-art"></span>'}
          <span class="t-text"><span class="t-name">${esc(t.title)}</span><span class="muted small">${esc(t.artist)}${state === 'missing' ? ' · <i>not on Spotify</i>' : ''}</span></span>
        </span>
        <span class="muted small t-album">${compact ? '' : esc(t.album || '')}</span>
        <span class="muted small r">${state === 'missing' ? '–' : '<span class="spinner tiny"></span>'}</span>
        <span></span>
      </div>`;
    body.innerHTML = tracks.map((t, i) => pendingRow(t, i, 'pending')).join('');

    // Songs are matched to Spotify as their rows come into view (plus whatever Play or
    // Save needs), not all at once: a long playlist would otherwise cost a hundred
    // Spotify searches before you'd even scrolled.
    const state = new Array(tracks.length).fill(undefined); // undefined = not looked up yet
    let artSet = false;
    const resolved = () => state.filter((x) => x !== undefined && x !== null).length;
    const found = () => matched.filter(Boolean).length;
    const status = (extra) => {
      if (!statusEl || !statusEl.isConnected) return;
      const n = resolved();
      statusEl.textContent = extra ? ` · ${extra}` : n < tracks.length ? ` · ${found()} found on Spotify so far` : ` · ${found()} of ${tracks.length} found on Spotify`;
    };
    const setArt = (force) => {
      const covers = [...new Set(matched.filter(Boolean).map((m) => img(m.album && m.album.images, 200)).filter(Boolean))].slice(0, 4);
      if ((covers.length < 4 && !force) || !covers.length || !artEl || !artEl.isConnected) return;
      artSet = true;
      artEl.innerHTML = covers.length >= 4 ? `<div class="mosaic">${covers.map((u) => `<img src="${esc(u)}" alt="">`).join('')}</div>` : `<img src="${esc(covers[0])}" alt="">`;
      if (alive()) Backdrop.setPage(covers[0]);
    };
    const apply = (i, m) => {
      if (state[i] !== undefined && state[i] !== null) return;
      state[i] = m;
      const row = body.querySelector(`.lb-row[data-track-index="${i}"]`);
      if (m) {
        matched[i] = normTrack(m);
        if (row) row.outerHTML = rowHtml(matched[i], i, { showAlbum: !compact, showArt: true });
      } else if (m === false && row) {
        row.outerHTML = pendingRow(tracks[i], i, 'missing');
      }
    };

    // Rows already known (from earlier visits or the disk cache) fill in straight away.
    const primed = Matcher.prime(tracks).then((known) => {
      if (!alive()) return;
      known.forEach((m, i) => { if (m !== undefined) apply(i, m); });
      status(); setArt(resolved() === tracks.length); markPlaying();
      watchRows();
    });

    // Background queue for rows on screen, one lookup at a time.
    const queue = [];
    let working = false;
    async function work() {
      if (working) return;
      working = true;
      while (queue.length && alive()) {
        const i = queue.shift();
        if (state[i] !== undefined && state[i] !== null) continue;
        const m = await Matcher.matchOne(tracks[i], true);
        if (!alive()) break;
        if (m === null) { if (API.coolingDown()) { status('Spotify has paused requests for now'); break; } continue; }
        apply(i, m); status(); if (!artSet) setArt(resolved() === tracks.length); markPlaying();
      }
      working = false;
    }
    let io = null;
    function watchRows() {
      io = new IntersectionObserver((entries) => {
        if (!alive()) { io.disconnect(); return; }
        for (const e of entries) {
          if (!e.isIntersecting) continue;
          const i = Number(e.target.dataset.trackIndex);
          io.unobserve(e.target);
          if (state[i] === undefined || state[i] === null) queue.push(i);
        }
        queue.sort((a, b) => a - b);
        work();
      }, { rootMargin: '150px' });
      body.querySelectorAll('.lb-row.pending').forEach((r) => io.observe(r));
    }

    // Make sure a range of songs is matched now (for Play and Save), with progress.
    async function ensure(from, to) {
      await primed;
      for (let i = from; i < to && alive(); i++) {
        if (state[i] !== undefined && state[i] !== null) continue;
        status(`Finding songs on Spotify… ${i + 1}/${to}${to - from > 30 ? ' (pacing it so Spotify doesn’t block us)' : ''}`);
        const m = await Matcher.matchOne(tracks[i], false);
        if (m === null) { status(); throw new Error(API.coolingDown() ? 'Spotify has paused requests for now. Try again later.' : 'Couldn’t reach Spotify.'); }
        apply(i, m);
      }
      status(); if (!artSet) setArt(true); markPlaying();
    }

    async function playFrom(i) {
      try { await ensure(i, Math.min(tracks.length, i + 15)); }
      catch (e) { if (!matched.some(Boolean)) return banner(e.message); }
      const songs = matched.map((m, k) => (m ? { k, uri: m.uri } : null)).filter(Boolean);
      if (!songs.length) return banner('None of these songs are on Spotify.');
      let at = songs.findIndex((x) => x.k >= i);
      if (at < 0) at = 0;
      const start = Math.max(0, at - 20);
      playItems({ uris: songs.slice(start, start + 100).map((x) => x.uri), offset: { position: at - start } });
    }
    const matching = primed.then(() => { if (onDone) onDone(1); });
    return { matching, playFrom, ensureAll: () => ensure(0, tracks.length), uris: () => [...new Set(matched.filter(Boolean).map((m) => m.uri))] };
  }

  async function saveLbPlaylist(btn, m, name, description) {
    btn.disabled = true;
    try { await m.ensureAll(); }
    catch (e) { banner(e.message); if (btn.isConnected) btn.disabled = false; return; }
    if (!m.uris().length) { banner('None of these songs are on Spotify.'); if (btn.isConnected) btn.disabled = false; return; }
    await createPlaylistFlow({ name, description, uris: m.uris() });
    if (btn.isConnected) btn.disabled = false;
  }

  // Full page for an instant mix (and for ListenBrainz playlist links).
  async function renderLb(route, c) {
    const isMix = route.view === 'mix';
    let data = route.data; // mixes are random, so keep the one we made for Back/Forward
    if (!data) {
      if (isMix) {
        const tok = await window.sweetspot.lbTokenStatus().catch(() => ({}));
        if (tok.connected) {
          try {
            data = { ...(await window.sweetspot.lbRadio(route.q, route.id || 'easy')), source: 'lb' };
            if (!data.tracks.length) throw new Error(data.feedback && data.feedback.length ? data.feedback.join(' ') : 'no songs');
          } catch (e) {
            data = await spotifyMix(route.q, route.id);
            data.note = `ListenBrainz couldn’t make this one (${ipcMsg(e)}), so here’s a quick mix from Spotify instead.`;
          }
        } else {
          data = await spotifyMix(route.q, route.id);
          data.note = 'Quick mix from Spotify search. Connect ListenBrainz in Settings for smarter mixes that bring in similar artists.';
          data.needsToken = true;
        }
      } else {
        data = await window.sweetspot.lbPlaylist(route.id);
      }
      route.data = data;
    }
    if (!c.alive()) return;
    const tracks = data.tracks || [];
    const title = isMix ? mixTitle(route.q) : data.title;
    const modeName = (MIX_MODES.find(([v]) => v === route.id) || MIX_MODES[0])[1];
    const kindLabel = isMix ? (data.source === 'spotify' ? `Quick mix · ${modeName} · Spotify` : `Instant mix · ${modeName} · ListenBrainz`) : `${data.createdFor ? 'Made for you' : 'Community playlist'} · ListenBrainz`;
    view.innerHTML = `<div class="view">
      <header class="hero">
        <div class="hero-art lb-art" id="lb-art">${lbTile(title, isMix ? 'sparkle' : data.createdFor ? 'sparkle' : 'people')}</div>
        <div class="hero-text">
          <div class="small">${esc(kindLabel)}</div>
          <h1 class="hero-title">${esc(title)}</h1>
          ${data.description ? `<div class="muted small hero-desc">${esc(data.description)}</div>` : ''}
          <div class="small hero-meta">${esc([!isMix && data.creator ? `By ${data.creator}` : '', `${tracks.length} songs`].filter(Boolean).join(' • '))}
            <span class="muted lb-status" id="lb-status"></span></div>
        </div>
      </header>
      <div class="actions lb-actions">
        <button class="play-btn big" id="hero-play" title="Play">${ICONS.play}</button>
        <button class="btn-secondary" id="lb-save" disabled>Save to my playlists</button>
        ${isMix ? '<button class="btn-secondary" id="lb-remix">Shuffle up a new mix</button>' : `<a class="lb-link" href="https://listenbrainz.org/playlist/${esc(route.id)}/" target="_blank">Open on ListenBrainz</a>`}
      </div>
      ${data.note ? `<p class="muted small note mix-note">${esc(data.note)}${data.needsToken ? ' <button class="btn-link inline" id="mix-connect">Connect ListenBrainz</button>' : ''}</p>` : ''}
      ${data.feedback && data.feedback.length ? `<p class="muted small note">${esc(data.feedback.join(' '))}</p>` : ''}
      ${tracks.length ? '<div id="lb-tracks"></div>' : `<p class="muted note">${isMix ? 'ListenBrainz couldn’t build a mix from that. Artist names need to match how MusicBrainz spells them; try a genre, or another artist.' : 'This playlist is empty.'}</p>`}
    </div>`;
    if (isMix) $('lb-remix').onclick = () => { delete route.data; render(route, 0); };
    if ($('mix-connect')) $('mix-connect').onclick = () => navigate({ view: 'settings' });
    if (!tracks.length) { $('lb-save').remove(); $('hero-play').disabled = true; return; }

    const m = mountLbTracks({
      host: $('lb-tracks'), tracks, statusEl: $('lb-status'), artEl: $('lb-art'), alive: () => c.alive(),
      onDone: (found) => { if ($('lb-save')) $('lb-save').disabled = !found; }
    });
    $('hero-play').onclick = () => m.playFrom(0);
    $('lb-save').onclick = () => saveLbPlaylist($('lb-save'), m, title,
      isMix ? `${data.source === 'spotify' ? 'Quick mix' : 'Instant mix'} (${route.q}) made with Sweet Spot.` : `From “${data.title}” by ${data.creator || 'a ListenBrainz user'} on ListenBrainz.`);
  }

  // ---------- Keyboard shortcuts (inside the window) ----------
  const SHORTCUTS = [
    ['Space', 'Play / pause'],
    ['Ctrl + → / ←', 'Next / previous track'],
    ['Shift + → / ←', 'Skip forward / back 10 seconds'],
    ['Ctrl + ↑ / ↓', 'Volume up / down'],
    ['Ctrl + S', 'Shuffle'],
    ['Ctrl + R', 'Repeat'],
    ['Alt + Shift + B', 'Like / unlike current song'],
    ['Ctrl + L', 'Search'],
    ['Alt + ← / →', 'Back / forward (mouse side buttons too)'],
    ['Ctrl + Q', 'Now playing panel'],
    ['Ctrl + B', 'Your Library'],
    ['Ctrl + M', 'Mini-player'],
    ['Ctrl + ,', 'Settings'],
    ['?', 'This list']
  ];

  function showShortcuts() {
    const m = $('kbd-modal');
    m.innerHTML = `<div class="modal-card">
      <div class="modal-head"><h2>Keyboard shortcuts</h2><button class="icon-btn" id="kbd-close" title="Close">${ICONS.close}</button></div>
      <div class="kbd-list">${SHORTCUTS.map(([k, d]) => `<div class="kbd-row"><span>${esc(d)}</span><kbd>${esc(k)}</kbd></div>`).join('')}</div>
      <p class="muted small">System-wide shortcuts that work while Sweet Spot is hidden are in Settings.</p>
    </div>`;
    m.classList.remove('hidden');
    $('kbd-close').onclick = () => m.classList.add('hidden');
  }
  $('kbd-modal').addEventListener('mousedown', (e) => { if (e.target === $('kbd-modal')) $('kbd-modal').classList.add('hidden'); });
  $('help-btn').innerHTML = ICONS.keyboard;
  $('help-btn').onclick = showShortcuts;

  document.addEventListener('keydown', (e) => {
    if ($('app').classList.contains('hidden')) return;
    const typing = e.target.closest('input, textarea, [contenteditable]') && e.target.type !== 'range' && e.target.type !== 'checkbox';
    if (e.key === 'Escape') {
      if ($('library').classList.contains('open') && !settings.libraryPinned && !$('ctx').firstChild) toggleLibrary(false);
      closeMenus();
      $('kbd-modal').classList.add('hidden');
      if (typing) e.target.blur();
      return;
    }
    if (e.target.classList.contains('hotkey')) return; // capturing a global shortcut in Settings
    const k = e.key;
    const handled = () => e.preventDefault();

    if (e.ctrlKey && !e.altKey && (k === 'l' || k === 'L' || k === 'f' || k === 'F')) {
      handled();
      if ((hist[hIdx] || {}).view === 'search' && $('search-input')) $('search-input').select();
      else navigate({ view: 'search' });
      return;
    }
    if (e.altKey && !e.ctrlKey && k === 'ArrowLeft') { handled(); return goBack(); }
    if (e.altKey && !e.ctrlKey && k === 'ArrowRight') { handled(); return goForward(); }
    if (typing) return;

    if (k === ' ' && !e.ctrlKey && !e.altKey) { handled(); return runCommand({ type: 'toggle' }); }
    if (e.ctrlKey && k === 'ArrowRight') { handled(); return runCommand({ type: 'next' }); }
    if (e.ctrlKey && k === 'ArrowLeft') { handled(); return runCommand({ type: 'previous' }); }
    if (e.shiftKey && k === 'ArrowRight') { handled(); return runCommand({ type: 'seekBy', delta: 10000 }); }
    if (e.shiftKey && k === 'ArrowLeft') { handled(); return runCommand({ type: 'seekBy', delta: -10000 }); }
    if (e.ctrlKey && k === 'ArrowUp') { handled(); return runCommand({ type: 'volumeStep', delta: 0.05 }); }
    if (e.ctrlKey && k === 'ArrowDown') { handled(); return runCommand({ type: 'volumeStep', delta: -0.05 }); }
    if (e.ctrlKey && (k === 's' || k === 'S')) { handled(); return runCommand({ type: 'shuffle' }); }
    if (e.ctrlKey && (k === 'r' || k === 'R')) { handled(); return runCommand({ type: 'repeat' }); }
    if (e.altKey && e.shiftKey && (k === 'b' || k === 'B')) { handled(); return runCommand({ type: 'like' }); }
    if (e.ctrlKey && (k === 'q' || k === 'Q')) { handled(); return toggleQueuePanel(); }
    if (e.ctrlKey && (k === 'b' || k === 'B')) { handled(); return toggleLibrary(); }
    if (e.ctrlKey && (k === 'm' || k === 'M')) { handled(); return window.sweetspot.toggleMini(); }
    if (e.ctrlKey && k === ',') { handled(); return navigate({ view: 'settings' }); }
    if (k === '?' || (e.ctrlKey && k === '/')) { handled(); return showShortcuts(); }
  });

  // ---------- Liquid-glass backdrop ----------
  // A blurred copy of album art fills the window. It follows what's playing (or the
  // album/playlist page you're on) and, while you hover any cover, crossfades to that.
  const Backdrop = (() => {
    const layers = [...document.querySelectorAll('#backdrop .bd-layer')];
    let front = 0, current, nowPlaying = null, page = null, hovering = null, hoverTimer;
    const base = () => page || nowPlaying;
    function show(url) {
      if (url === current) return;
      current = url;
      if (!url) { layers.forEach((l) => l.classList.remove('on')); return; }
      const im = new Image();
      im.onload = () => {
        if (current !== url) return; // something newer was requested meanwhile
        const next = layers[1 - front];
        next.style.backgroundImage = `url("${url}")`;
        next.classList.add('on');
        layers[front].classList.remove('on');
        front = 1 - front;
      };
      im.src = url;
    }
    // A hovered cover "sticks" until something else should take over:
    // hovering another cover, the song changing, or opening a different page.
    const reset = () => { hovering = null; clearTimeout(hoverTimer); show(base()); };
    return {
      setNowPlaying(url) { if (url === nowPlaying) return; nowPlaying = url; reset(); },
      setPage(url) { page = url; reset(); },
      hover(url) {
        hovering = url;
        clearTimeout(hoverTimer);
        hoverTimer = setTimeout(() => show(url), 120); // small delay so sweeping across a grid isn't flashy
      },
      // Moving off a cover only cancels a pending change; the backdrop stays where it landed.
      leave() { clearTimeout(hoverTimer); }
    };
  })();

  let hoverEl = null;
  document.addEventListener('mouseover', (e) => {
    if (settings.glass === false || settings.hoverBackdrop === false) return;
    const el = e.target.closest('.card, .track-row, .pl-item, .q-row, .hero-art, #np-area');
    if (el === hoverEl) return;
    hoverEl = el;
    const im = el && el.querySelector('img');
    const src = im && im.getAttribute('src');
    if (src) Backdrop.hover(src); else Backdrop.leave();
  });
  document.addEventListener('mouseleave', () => { hoverEl = null; Backdrop.leave(); });

  // ---------- Dock ----------
  function moveDockGlow() {
    const a = document.querySelector('.dock-item.active');
    const g = $('dock-glow');
    if (!a || !a.offsetWidth) { g.style.opacity = 0; return; }
    g.style.opacity = 1;
    g.style.width = `${a.offsetWidth}px`;
    g.style.transform = `translateX(${a.offsetLeft}px)`;
  }
  window.addEventListener('resize', moveDockGlow);

  // ---------- Library flyout ----------
  const lib = $('library');
  let libByHover = false, edgeTimer, libLeaveTimer;

  function toggleLibrary(force) {
    const open = typeof force === 'boolean' ? force : !lib.classList.contains('open');
    if (!open && settings.libraryPinned) return;
    lib.classList.toggle('open', open);
    $('library-btn').classList.toggle('active', open);
    if (!open) libByHover = false;
  }

  function setLibraryPinned(pinned, save = true) {
    document.body.classList.toggle('lib-pinned', pinned);
    $('lib-pin').classList.toggle('active', pinned);
    $('lib-pin').title = pinned ? 'Unpin' : 'Keep open';
    if (pinned) { lib.classList.add('open'); $('library-btn').classList.add('active'); libByHover = false; }
    if (save) {
      settings.libraryPinned = pinned;
      window.sweetspot.setSettings({ libraryPinned: pinned });
    }
    setTimeout(moveDockGlow, 320);
  }

  $('library-btn').onclick = () => {
    if (settings.libraryPinned) return setLibraryPinned(false), toggleLibrary(false);
    libByHover = false;
    toggleLibrary();
  };
  $('lib-pin').onclick = () => setLibraryPinned(!settings.libraryPinned);
  $('lib-new').onclick = () => createPlaylistFlow();
  $('lib-close').onclick = () => { if (settings.libraryPinned) setLibraryPinned(false); toggleLibrary(false); };

  // Rest the mouse on the left edge to slide it out; it tucks away again when you leave.
  $('lib-edge').addEventListener('mouseenter', () => {
    edgeTimer = setTimeout(() => { if (!lib.classList.contains('open')) { libByHover = true; toggleLibrary(true); } }, 220);
  });
  $('lib-edge').addEventListener('mouseleave', () => clearTimeout(edgeTimer));
  lib.addEventListener('mouseenter', () => clearTimeout(libLeaveTimer));
  lib.addEventListener('mouseleave', () => {
    if (!libByHover || settings.libraryPinned || document.activeElement === $('lib-filter')) return;
    libLeaveTimer = setTimeout(() => { if (!ctx.firstChild) toggleLibrary(false); }, 450);
  });
  document.addEventListener('mousedown', (e) => {
    if (!lib.classList.contains('open') || settings.libraryPinned) return;
    if (lib.contains(e.target) || $('library-btn').contains(e.target) || ctx.contains(e.target)) return;
    toggleLibrary(false);
  });

  $('lib-filter').addEventListener('input', () => {
    const q = $('lib-filter').value.trim().toLowerCase();
    $('playlists').querySelectorAll('.pl-item').forEach((b) => {
      b.classList.toggle('hidden', !!q && !b.dataset.title.toLowerCase().includes(q));
    });
  });

  // ---------- Window buttons (frameless window) ----------
  $('win-min').onclick = () => window.sweetspot.windowControl('minimize');
  $('win-max').onclick = () => window.sweetspot.windowControl('maximize');
  $('win-close').onclick = () => window.sweetspot.windowControl('close');
  const showMaximized = (m) => {
    $('win-max').innerHTML = m ? ICONS.winRestore : ICONS.winMax;
    $('win-max').title = m ? 'Restore' : 'Maximise';
  };
  window.sweetspot.onMaximized(showMaximized);
  window.sweetspot.isMaximized().then(showMaximized).catch(() => {});

  // ---------- Settings ----------
  $('settings-btn').innerHTML = ICONS.settings;
  $('settings-btn').onclick = () => navigate({ view: 'settings' });

  const HOTKEY_LABELS = {
    playPause: 'Play / pause',
    next: 'Next track',
    previous: 'Previous track',
    volumeUp: 'Volume up',
    volumeDown: 'Volume down',
    like: 'Like / unlike current song',
    toggleFlyout: 'Open tray panel',
    toggleMini: 'Show / hide mini-player',
    showMain: 'Show main window'
  };

  const DEFAULT_HOTKEYS = {
    playPause: 'Ctrl+Alt+Space', next: 'Ctrl+Alt+Right', previous: 'Ctrl+Alt+Left',
    volumeUp: 'Ctrl+Alt+Up', volumeDown: 'Ctrl+Alt+Down', like: 'Ctrl+Alt+L',
    toggleFlyout: 'Ctrl+Alt+M', toggleMini: 'Ctrl+Alt+N', showMain: ''
  };

  const toggleRow = (key, label, hint, s) => `
    <label class="set-row">
      <span><span class="set-label">${label}</span>${hint ? `<span class="set-hint">${hint}</span>` : ''}</span>
      <input type="checkbox" class="switch" data-key="${key}" ${s[key] ? 'checked' : ''}>
    </label>`;

  const seg = (id, current, options) => `<div class="seg" id="${id}">${options.map(([v, l]) => `<button data-value="${v}" class="${current === v ? 'on' : ''}">${l}</button>`).join('')}</div>`;

  function accentChips(s) {
    const current = s.accent || 'auto';
    const preset = Themes.presets[s.theme || 'classic'] || {};
    const themeAccent = preset.accent || getComputedStyle(document.documentElement).getPropertyValue('--accent').trim() || '#1ed760';
    const chip = (key, label, style, extraClass = '') => `
      <button class="acc${current === key ? ' on' : ''}" data-accent="${key}" title="${esc(label)}">
        <span class="acc-dot ${extraClass}" style="${style}"></span>${esc(label)}
      </button>`;
    return chip('auto', 'Album art', '', 'auto') +
      chip('theme', 'Theme', `background:${preset.accent || '#1ed760'}`) +
      Object.entries(Themes.accents).map(([k, a]) => chip(k, a.name, `background:${a.hex}`)).join('');
  }

  async function renderSettings(c) {
    const s = await window.sweetspot.getSettings();
    if (!c.alive()) return;
    const failed = new Set(s.hotkeyFailures || []);
    const swatch = (key, p) => {
      const col = key === 'classic' ? getComputedStyle(document.documentElement).getPropertyValue('--accent-base') || '#1ed760' : p.accent;
      const bg = p.bg || '#121212';
      return `<button class="swatch${s.theme === key ? ' on' : ''}" data-theme="${key}" title="${esc(p.hint || p.name)}">
        <span class="sw-chip" style="background:${esc(bg)}"><span style="background:${esc(col)}"></span></span>${esc(p.name)}</button>`;
    };
    view.innerHTML = `<div class="view settings">
      <h1 class="page-title">Settings</h1>

      <section class="set-group">
        <h2>Appearance</h2>
        ${toggleRow('glass', 'Liquid glass', 'Frosted glass panels over a blurred backdrop of the album art.', s)}
        ${toggleRow('hoverBackdrop', 'Backdrop follows the cover under your mouse', 'Hovering any album art fades the background to it. Otherwise it follows what’s playing, or the page you’re on.', s)}
        <div class="set-row column">
          <span><span class="set-label">Accent colour</span><span class="set-hint">Used for the play button, sliders, highlights and the drop-down.</span></span>
          <div class="accent-swatches" id="accent-swatches">${accentChips(s)}</div>
        </div>
        <div class="set-row column">
          <span><span class="set-label">Background theme</span><span class="set-hint">The tint behind the glass. Classic uses the colours in <code>src/theme.css</code>.</span></span>
          <div class="swatches">${Object.entries(Themes.presets).map(([k, p]) => swatch(k, p)).join('')}</div>
        </div>
      </section>

      <section class="set-group">
        <h2>Account</h2>
        <div class="set-row">
          <span class="account">
            <span class="avatar">${me && me.images && me.images[0] ? `<img src="${esc(me.images[0].url)}" alt="">` : esc(((me && (me.display_name || me.id)) || '?').slice(0, 1).toUpperCase())}</span>
            <span><span class="set-label">${esc(me ? (me.display_name || me.id) : 'Signed in')}</span><span class="set-hint">Spotify Premium</span></span>
          </span>
          <button class="btn-secondary" id="signout-btn">Sign out</button>
        </div>
      </section>

      <section class="set-group">
        <h2>ListenBrainz</h2>
        <div class="set-row">
          <span><span class="set-label">Your ListenBrainz username</span>
            <span class="set-hint">Adds your weekly “Made for you” playlists to Discover. Make a free account at <a href="https://listenbrainz.org" target="_blank">listenbrainz.org</a> and connect Spotify there so it learns what you play. Playlists appear after about a week of listening.</span></span>
          <span class="hk-wrap"><input class="text-input" id="lb-user" value="${esc(s.lbUser || '')}" placeholder="Username" spellcheck="false"><button class="btn-secondary" id="lb-user-save">Save</button></span>
        </div>
        <div class="set-row">
          <span><span class="set-label">ListenBrainz token</span>
            <span class="set-hint">Needed for instant mixes, which ListenBrainz now limits to signed-in users. Find it at <a href="https://listenbrainz.org/settings/" target="_blank">listenbrainz.org → Settings</a> under <i>User token</i>. It’s stored encrypted on this PC.</span></span>
          <span class="hk-wrap" id="lb-token-wrap"><span class="muted small">Checking…</span></span>
        </div>
      </section>

      <section class="set-group">
        <h2>General</h2>
        ${toggleRow('closeToTray', 'Close to tray', 'The × button hides Sweet Spot instead of quitting. Quit from the tray menu.', s)}
        ${toggleRow('startWithWindows', 'Start with Windows', 'Launches quietly in the tray when you sign in.', s)}
        ${toggleRow('startMinimised', 'Always start minimised', 'Open straight to the tray, even when launched by hand.', s)}
      </section>

      <section class="set-group">
        <h2>Tray icon and mini-player</h2>
        <div class="set-row">
          <span><span class="set-label">Clicking the tray icon opens</span><span class="set-hint">The other one is always in the tray’s right-click menu.</span></span>
          ${seg('trayclick-seg', s.trayClick, [['flyout', 'Drop-down'], ['mini', 'Mini-player']])}
        </div>
        <div class="set-row">
          <span><span class="set-label">Mini-player layout</span><span class="set-hint">You can also switch from the mini-player itself.</span></span>
          ${seg('minilayout-seg', s.miniLayout, [['compact', 'Compact'], ['square', 'Album art']])}
        </div>
      </section>

      <section class="set-group">
        <h2>Notifications</h2>
        ${toggleRow('notifications', 'Show a pop-up when the song changes', 'Appears beside the tray icon for a few seconds. Click it to open the panel.', s)}
        ${toggleRow('notifyOnlyWhenHidden', 'Only when Sweet Spot isn’t in front', 'Never shown while the mini-player is open.', s)}
        <div class="set-row"><span></span><button class="btn-secondary" id="preview-toast">Preview</button></div>
      </section>

      <section class="set-group">
        <h2>Panels</h2>
        <div class="set-row">
          <span><span class="set-label">Style</span>
            <span class="set-hint">${s.acrylicSupported ? 'Applies to the drop-down, mini-player and pop-up. Frosted blurs whatever is behind them.' : 'Frosted needs Windows 11 22H2 or later, so Glass is used instead.'}</span></span>
          ${seg('style-seg', s.flyoutStyle, [['acrylic', 'Frosted'], ['glass', 'Glass'], ['solid', 'Solid']])}
        </div>
        <div class="set-row ${s.flyoutStyle === 'solid' ? 'disabled' : ''}" id="opacity-row">
          <span><span class="set-label">Opacity</span><span class="set-hint">How much of the desktop shows through.</span></span>
          <span class="range-wrap"><input type="range" id="opacity" min="30" max="100" value="${Math.round(s.flyoutOpacity * 100)}"><span id="opacity-val" class="muted small">${Math.round(s.flyoutOpacity * 100)}%</span></span>
        </div>
        ${toggleRow('albumWash', 'Tint with album colours', 'Blends the current album art into the panel background.', s)}
      </section>

      <section class="set-group">
        <h2>System-wide shortcuts</h2>
        <p class="set-hint block">These work anywhere in Windows. Click a box and press a key combination; Backspace clears it. Your keyboard's media keys also work through the Windows media controls. <a href="#" id="kbd-link">Shortcuts inside the app</a></p>
        ${Object.entries(HOTKEY_LABELS).map(([k, label]) => `
          <div class="set-row">
            <span class="set-label">${label}</span>
            <span class="hk-wrap">
              ${failed.has(k) ? '<span class="hk-warn" title="Another app is already using this shortcut">In use</span>' : ''}
              <input class="hotkey${failed.has(k) ? ' bad' : ''}" data-action="${k}" value="${esc(s.hotkeys[k] || '')}" placeholder="Not set" readonly>
            </span>
          </div>`).join('')}
        <div class="set-row"><span></span><button class="btn-secondary" id="reset-hotkeys">Reset to defaults</button></div>
      </section>
      <section class="set-group">
        <h2>Updates</h2>
        ${toggleRow('autoUpdate', 'Check for updates automatically', 'Looks for a new release on GitHub when Sweet Spot starts and every few hours, and asks before installing.', s)}
        <div class="set-row">
          <span><span class="set-label">Version ${esc(s.appVersion || '')}</span><span class="set-hint" id="upd-status">${s.updatesFromSource ? 'Running from source: updates open the download page.' : ''}</span></span>
          <button class="btn-secondary" id="upd-check">Check for updates</button>
        </div>
      </section>
      <p class="muted small set-version">Sweet Spot ${esc(s.appVersion || '')} · <a href="https://github.com/zombifiedturkey/Sweet-Spot" target="_blank">GitHub</a></p>
    </div>`;

    view.querySelectorAll('.switch').forEach((cb) => {
      cb.addEventListener('change', () => window.sweetspot.setSettings({ [cb.dataset.key]: cb.checked }));
    });
    $('signout-btn').onclick = signOut;
    const saveLb = async () => {
      const u = $('lb-user').value.trim().replace(/^https?:\/\/listenbrainz\.org\/user\//, '').replace(/\/.*$/, '');
      $('lb-user').value = u;
      await window.sweetspot.setSettings({ lbUser: u });
      banner(u ? `Linked ListenBrainz user ${u}` : 'ListenBrainz username removed');
    };
    $('lb-user-save').onclick = saveLb;
    const tokenUi = (st) => {
      const w = $('lb-token-wrap');
      if (!w) return;
      if (st.connected) {
        w.innerHTML = `<span class="tok-ok">${ICONS.check} Connected${st.user ? ` as <b>${esc(st.user)}</b>` : ''}</span><button class="btn-secondary" id="lb-token-off">Disconnect</button>`;
        $('lb-token-off').onclick = async () => { tokenUi(await window.sweetspot.lbSetToken('')); banner('ListenBrainz disconnected'); };
      } else {
        w.innerHTML = '<input class="text-input" type="password" id="lb-token" placeholder="Paste your token" spellcheck="false"><button class="btn-secondary" id="lb-token-save">Connect</button>';
        const go = async () => {
          const v = $('lb-token').value.trim();
          if (!v) return $('lb-token').focus();
          $('lb-token-save').disabled = true;
          try {
            const st2 = await window.sweetspot.lbSetToken(v);
            if (st2.user && !$('lb-user').value.trim()) {
              $('lb-user').value = st2.user;
              await window.sweetspot.setSettings({ lbUser: st2.user });
            }
            tokenUi(st2);
            banner(`ListenBrainz connected${st2.user ? ` as ${st2.user}` : ''}`);
          } catch (e) {
            banner(ipcMsg(e));
            if ($('lb-token-save')) $('lb-token-save').disabled = false;
          }
        };
        $('lb-token-save').onclick = go;
        $('lb-token').addEventListener('keydown', (e) => { if (e.key === 'Enter') go(); });
      }
    };
    window.sweetspot.lbTokenStatus().then(tokenUi).catch(() => tokenUi({ connected: false }));
    $('lb-user').addEventListener('keydown', (e) => { if (e.key === 'Enter') saveLb(); });
    $('accent-swatches').querySelectorAll('.acc').forEach((b) => b.onclick = () => {
      $('accent-swatches').querySelectorAll('.acc').forEach((x) => x.classList.toggle('on', x === b));
      window.sweetspot.setSettings({ accent: b.dataset.accent });
    });
    view.querySelectorAll('.swatch').forEach((b) => b.onclick = () => {
      view.querySelectorAll('.swatch').forEach((x) => x.classList.toggle('on', x === b));
      window.sweetspot.setSettings({ theme: b.dataset.theme });
    });
    const bindSeg = (id, key, after) => $(id).querySelectorAll('button').forEach((b) => b.onclick = () => {
      $(id).querySelectorAll('button').forEach((x) => x.classList.toggle('on', x === b));
      window.sweetspot.setSettings({ [key]: b.dataset.value });
      if (after) after(b.dataset.value);
    });
    bindSeg('trayclick-seg', 'trayClick');
    bindSeg('minilayout-seg', 'miniLayout');
    bindSeg('style-seg', 'flyoutStyle', (v) => $('opacity-row').classList.toggle('disabled', v === 'solid'));

    $('preview-toast').onclick = () => {
      if (!np) return banner('Play something first, then preview.');
      window.sweetspot.previewToast();
    };
    $('kbd-link').onclick = (e) => { e.preventDefault(); showShortcuts(); };

    const op = $('opacity');
    setRangeFill(op);
    op.oninput = () => {
      $('opacity-val').textContent = `${op.value}%`;
      setRangeFill(op);
      clearTimeout(op.t);
      op.t = setTimeout(() => window.sweetspot.setSettings({ flyoutOpacity: op.value / 100 }), 120);
    };

    view.querySelectorAll('.hotkey').forEach((input) => {
      input.addEventListener('focus', () => { input.dataset.prev = input.value; input.value = ''; input.placeholder = 'Press keys…'; window.sweetspot.pauseHotkeys(true); });
      input.addEventListener('blur', () => { if (!input.value) input.value = input.dataset.prev || ''; input.placeholder = 'Not set'; window.sweetspot.pauseHotkeys(false); });
      input.addEventListener('keydown', async (e) => {
        e.preventDefault();
        if (e.key === 'Escape') { input.blur(); return; }
        if (e.key === 'Backspace' || e.key === 'Delete') {
          input.dataset.prev = '';
          input.value = '';
          input.blur();
          await saveHotkey(input.dataset.action, '');
          return;
        }
        const accel = toAccelerator(e);
        if (!accel) return; // only modifiers so far
        input.value = accel;
        input.dataset.prev = accel;
        input.blur();
        await saveHotkey(input.dataset.action, accel);
      });
    });
    $('upd-check').onclick = async () => {
      const b = $('upd-check');
      b.disabled = true; b.textContent = 'Checking…';
      const st = await window.sweetspot.checkUpdate().catch(() => null);
      if (!$('upd-check')) return;
      b.disabled = false; b.textContent = 'Check for updates';
      $('upd-status').textContent = !st ? 'Couldn’t check right now.'
        : st.state === 'none' ? 'You’re on the latest version.'
        : st.state === 'available' ? `Version ${st.version} is available.`
        : st.state === 'ready' ? `Version ${st.version} is ready to install.`
        : st.state === 'downloading' ? 'Downloading the update…'
        : st.message || '';
    };
    $('reset-hotkeys').onclick = async () => {
      await window.sweetspot.setSettings({ hotkeys: DEFAULT_HOTKEYS });
      render(hist[hIdx], content.scrollTop);
    };
  }

  async function saveHotkey(action, accel) {
    const res = await window.sweetspot.setSettings({ hotkeys: { [action]: accel } });
    const failed = new Set(res.hotkeyFailures || []);
    view.querySelectorAll('.hotkey').forEach((inp) => {
      const bad = failed.has(inp.dataset.action);
      inp.classList.toggle('bad', bad);
      const wrap = inp.parentElement;
      const warn = wrap.querySelector('.hk-warn');
      if (bad && !warn) wrap.insertAdjacentHTML('afterbegin', '<span class="hk-warn" title="Another app is already using this shortcut">In use</span>');
      if (!bad && warn) warn.remove();
    });
  }

  // KeyboardEvent → Electron accelerator string. Requires at least one modifier
  // (except F-keys) so ordinary typing can't be hijacked system-wide.
  function toAccelerator(e) {
    const mods = [];
    if (e.ctrlKey) mods.push('Ctrl');
    if (e.altKey) mods.push('Alt');
    if (e.shiftKey) mods.push('Shift');
    if (e.metaKey) mods.push('Super');
    const named = {
      ' ': 'Space', ArrowUp: 'Up', ArrowDown: 'Down', ArrowLeft: 'Left', ArrowRight: 'Right',
      Enter: 'Enter', Tab: 'Tab', Home: 'Home', End: 'End', PageUp: 'PageUp', PageDown: 'PageDown',
      Insert: 'Insert', '+': 'Plus'
    };
    if (['Control', 'Alt', 'Shift', 'Meta', 'AltGraph'].includes(e.key)) return null;
    let key = null;
    if (named[e.key]) key = named[e.key];
    else if (/^F\d{1,2}$/.test(e.key)) key = e.key;
    else if (/^Key[A-Z]$/.test(e.code)) key = e.code.slice(3);
    else if (/^Digit\d$/.test(e.code)) key = e.code.slice(5);
    else if (e.key.length === 1) key = e.key.toUpperCase();
    if (!key) return null;
    if (!mods.length && !/^F\d{1,2}$/.test(key)) return null;
    return [...mods, key].join('+');
  }

  // ---------- Go ----------
  renderPlayer();
  renderQueue();
  boot();
})();
