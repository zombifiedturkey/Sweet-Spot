// Sweet Spot — tray flyout. Displays state pushed from the main window and sends
// commands back; it never talks to the player directly.

(() => {
  const { esc, fmt } = window.TP;
  const $ = (id) => document.getElementById(id);
  let state = null;
  let seeking = false;
  let volDragging = false;
  let preMute = 0.5;

  Panel.init($('panel'));

  $('open-btn').innerHTML = ICONS.open;
  $('devices-btn').innerHTML = ICONS.devices;
  $('mini-btn').innerHTML = ICONS.mini;
  $('mini-btn').onclick = () => { window.sweetspot.hideFlyout(); window.sweetspot.toggleMini(true); };
  $('devices-btn').onclick = () => toggleDevices();
  $('empty-ico').innerHTML = ICONS.note;
  $('prev-btn').innerHTML = ICONS.prev;
  $('next-btn').innerHTML = ICONS.next;
  $('shuffle-btn').innerHTML = ICONS.shuffle;

  const cmd = (type, extra = {}) => window.sweetspot.command({ type, ...extra });

  $('open-btn').onclick = () => window.sweetspot.showMain();
  $('empty-open').onclick = () => window.sweetspot.showMain();
  $('play-btn').onclick = () => cmd('toggle');
  $('prev-btn').onclick = () => cmd('previous');
  $('next-btn').onclick = () => cmd('next');
  $('like-btn').onclick = () => cmd('like');
  $('shuffle-btn').onclick = () => cmd('shuffle');
  $('repeat-btn').onclick = () => cmd('repeat');

  // ---- Device picker (swaps in for the Up next list) ----
  const DEVICE_ICONS = { computer: 'computer', smartphone: 'phone', tablet: 'phone', speaker: 'speaker', tv: 'tv', castvideo: 'tv', castaudio: 'speaker', avr: 'speaker', stb: 'tv', audiodongle: 'speaker', gameconsole: 'tv', automobile: 'speaker' };
  const devIcon = (type) => ICONS[DEVICE_ICONS[(type || '').toLowerCase()] || 'speaker'];

  function showDevices(on) {
    $('devices').classList.toggle('hidden', !on);
    $('upnext').classList.toggle('hidden', on || !(state && state.track));
    $('devices-btn').classList.toggle('active', on || !!(state && state.source === 'remote'));
  }

  async function toggleDevices() {
    if (!$('devices').classList.contains('hidden')) return showDevices(false);
    showDevices(true);
    const list = $('device-list');
    list.innerHTML = `<div class="q-empty">Looking for devices…</div>`;
    try {
      const r = await SpotifyAPI.devices();
      const devs = (r && r.devices) || [];
      devs.sort((a, b) => (b.name === 'Sweet Spot') - (a.name === 'Sweet Spot'));
      list.innerHTML = devs.length ? devs.map((d) => `
        <button class="dev-row${d.is_active ? ' on' : ''}" data-id="${esc(d.id)}">
          <span class="dev-ico">${devIcon(d.type)}</span>
          <span class="q-text"><div>${esc(d.name === 'Sweet Spot' ? 'This computer' : d.name)}</div><div class="q-sub">${d.is_active ? 'Playing here' : esc(d.type)}</div></span>
        </button>`).join('') : `<div class="q-empty">No devices found. Open Spotify on your phone or speaker first.</div>`;
      list.querySelectorAll('.dev-row').forEach((b) => b.onclick = () => {
        cmd('transfer', { id: b.dataset.id });
        showDevices(false);
      });
    } catch (e) {
      list.innerHTML = `<div class="q-empty">${esc(e.message)}</div>`;
    }
  }

  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') { if (!$('devices').classList.contains('hidden')) return showDevices(false); window.sweetspot.hideFlyout(); }
    if (e.key === ' ') { e.preventDefault(); cmd('toggle'); }
    if (e.key === 'ArrowRight' && e.ctrlKey) cmd('next');
    if (e.key === 'ArrowLeft' && e.ctrlKey) cmd('previous');
    if (e.key === 'ArrowUp') { e.preventDefault(); cmd('volumeStep', { delta: 0.05 }); }
    if (e.key === 'ArrowDown') { e.preventDefault(); cmd('volumeStep', { delta: -0.05 }); }
  });

  const fill = (el) => el.style.setProperty('--fill', `${((el.value - el.min) / (el.max - el.min)) * 100}%`);

  // Seek bar
  $('seek').addEventListener('input', () => {
    seeking = true;
    $('pos').textContent = fmt(($('seek').value / 1000) * (state ? state.duration : 0));
    fill($('seek'));
  });
  $('seek').addEventListener('change', () => {
    if (state) {
      const ms = ($('seek').value / 1000) * state.duration;
      cmd('seek', { ms });
      // Optimistic update so the bar doesn't jump back while the player catches up.
      state = { ...state, position: ms, timestamp: Date.now() };
    }
    seeking = false;
  });

  // Volume
  $('volume').addEventListener('input', () => {
    volDragging = true;
    const v = $('volume').value / 100;
    renderVolume(v);
    cmd('volume', { value: v });
  });
  $('volume').addEventListener('change', () => { volDragging = false; });
  $('volume').addEventListener('wheel', (e) => {
    e.preventDefault();
    cmd('volumeStep', { delta: e.deltaY < 0 ? 0.05 : -0.05 });
  }, { passive: false });
  $('mute-btn').onclick = () => {
    const v = state ? state.volume : 0;
    if (v > 0) { preMute = v; cmd('volume', { value: 0 }); }
    else cmd('volume', { value: preMute || 0.5 });
  };

  function renderVolume(v) {
    $('mute-btn').innerHTML = v === 0 ? ICONS.mute : ICONS.volume;
    if (!volDragging || document.activeElement !== $('volume')) $('volume').value = Math.round(v * 100);
    $('vol-val').textContent = Math.round(v * 100);
    fill($('volume'));
  }

  const livePos = () => {
    if (!state) return 0;
    if (state.paused) return state.position;
    return Math.min(state.duration, state.position + (Date.now() - state.timestamp));
  };

  function render() {
    const has = !!(state && state.track);
    const devOpen = !$('devices').classList.contains('hidden');
    $('empty').classList.toggle('hidden', has || devOpen);
    $('np').classList.toggle('hidden', !has);
    $('upnext').classList.toggle('hidden', !has || devOpen);
    Panel.setAccent(state ? state.accent : null);
    const remote = !!(state && state.source === 'remote');
    $('np-label').textContent = remote ? `Playing on ${state.device.name}` : 'Now playing';
    $('np-label').classList.toggle('remote', remote);
    $('devices-btn').classList.toggle('active', remote || devOpen);
    if (!has) { $('bg').style.backgroundImage = ''; return; }

    const t = state.track;
    if ($('art').dataset.src !== t.art) {
      $('art').src = t.art;
      $('art').dataset.src = t.art;
      $('bg').style.backgroundImage = `url("${t.art}")`;
    }
    $('title').textContent = t.name;
    $('title').title = t.name;
    $('artist').textContent = t.artists;
    $('artist').title = `${t.artists} — ${t.album}`;
    $('dur').textContent = fmt(state.duration);

    $('play-btn').innerHTML = state.paused ? ICONS.play : ICONS.pause;
    $('play-btn').title = state.paused ? 'Play' : 'Pause';
    $('like-btn').innerHTML = state.liked ? ICONS.heart : ICONS.heartOutline;
    $('like-btn').classList.toggle('active', !!state.liked);
    $('shuffle-btn').classList.toggle('active', !!state.shuffle);
    $('repeat-btn').innerHTML = state.repeat === 2 ? ICONS.repeatOne : ICONS.repeat;
    $('repeat-btn').classList.toggle('active', !!state.repeat);
    renderVolume(typeof state.volume === 'number' ? state.volume : 0.7);

    // Rebuild the list only when it actually changes, so a double-click is never
    // interrupted by a refresh landing between the two clicks.
    const q = state.queue || [];
    const key = q.map((it) => it.uri).join('|');
    if (key !== render.queueKey) {
      render.queueKey = key;
      $('queue').innerHTML = q.length
        ? q.map((it, i) => `
          <div class="q-row" data-i="${i}" data-uri="${esc(it.uri)}" title="Double-click to play">
            <img src="${esc(it.art)}" alt="">
            <div class="q-text"><div>${esc(it.name)}</div><div class="q-sub">${esc(it.artists)}</div></div>
          </div>`).join('')
        : `<div class="q-empty">Nothing queued.</div>`;
    }
    if (pending && (t.uri === pending.uri || Date.now() - pending.at > 8000)) pending = null;
    $('queue').querySelectorAll('.q-row').forEach((r) => r.classList.toggle('pending', !!pending && r.dataset.uri === pending.uri));
    $('upnext-label').textContent = state.jumping ? `Skipping to ${state.jumping}…` : 'Up next';
    tick();
  }

  function tick() {
    if (seeking || !state || !state.track) return;
    const pos = livePos();
    $('pos').textContent = fmt(pos);
    $('seek').value = state.duration ? Math.round((pos / state.duration) * 1000) : 0;
    fill($('seek'));
  }
  setInterval(tick, 500);

  // Double-click a song in Up next to play it.
  let pending = null;
  $('queue').addEventListener('dblclick', (e) => {
    const row = e.target.closest('.q-row[data-i]');
    if (!row) return;
    pending = { uri: row.dataset.uri, at: Date.now() };
    row.classList.add('pending');
    cmd('playQueue', { index: Number(row.dataset.i), uri: row.dataset.uri });
  });

  window.sweetspot.onState((s) => { state = s; render(); });
  window.sweetspot.onFlyoutShown(() => { showDevices(false); render(); Panel.animateIn($('panel')); });
  window.sweetspot.getState().then((s) => { state = s; render(); });
})();
