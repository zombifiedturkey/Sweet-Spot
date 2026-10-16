// Sweet Spot — mini-player. Always-on-top, draggable; shows state pushed from the
// main window and sends commands back, like the tray flyout.

(() => {
  const $ = (id) => document.getElementById(id);
  const panel = $('panel');
  let state = null;
  let layout = 'compact';

  Panel.init(panel);
  Panel.onSettings = (s) => {
    layout = s.miniLayout || 'compact';
    document.body.classList.toggle('layout-compact', layout === 'compact');
    document.body.classList.toggle('layout-square', layout === 'square');
    $('layout-btn').innerHTML = layout === 'compact' ? ICONS.square : ICONS.compact;
    $('layout-btn').title = layout === 'compact' ? 'Album-art layout' : 'Compact layout';
    render();
  };

  $('prev-btn').innerHTML = ICONS.prev;
  $('next-btn').innerHTML = ICONS.next;
  $('open-btn').innerHTML = ICONS.open;
  $('close-btn').innerHTML = ICONS.close;
  $('layout-btn').innerHTML = ICONS.square;

  const cmd = (type, extra = {}) => window.sweetspot.command({ type, ...extra });
  $('play-btn').onclick = () => cmd('toggle');
  $('prev-btn').onclick = () => cmd('previous');
  $('next-btn').onclick = () => cmd('next');
  $('like-btn').onclick = () => cmd('like');
  $('open-btn').onclick = () => window.sweetspot.showMain();
  $('close-btn').onclick = () => window.sweetspot.toggleMini(false);
  $('layout-btn').onclick = () => window.sweetspot.setSettings({ miniLayout: layout === 'compact' ? 'square' : 'compact' });

  // Click the thin progress bar to seek.
  $('progress').addEventListener('click', (e) => {
    if (!state) return;
    const r = $('progress').getBoundingClientRect();
    cmd('seek', { ms: ((e.clientX - r.left) / r.width) * state.duration });
  });

  // Scroll anywhere on the mini-player to change volume.
  panel.addEventListener('wheel', (e) => {
    e.preventDefault();
    cmd('volumeStep', { delta: e.deltaY < 0 ? 0.05 : -0.05 });
  }, { passive: false });

  document.addEventListener('keydown', (e) => {
    if (e.key === ' ') { e.preventDefault(); cmd('toggle'); }
    if (e.key === 'ArrowRight' && e.ctrlKey) cmd('next');
    if (e.key === 'ArrowLeft' && e.ctrlKey) cmd('previous');
  });

  // Drag the window by any empty area. (Done by hand rather than with
  // -webkit-app-region so clicks still work in see-through mode.)
  let drag = null;
  panel.addEventListener('pointerdown', (e) => {
    if (e.button !== 0 || e.target.closest('button, .progress')) return;
    drag = { x: e.screenX, y: e.screenY, moved: false };
    Panel.dragging = true;
    panel.setPointerCapture(e.pointerId);
    window.sweetspot.miniDrag('start');
  });
  panel.addEventListener('pointermove', (e) => {
    if (!drag) return;
    const dx = e.screenX - drag.x, dy = e.screenY - drag.y;
    if (!drag.moved && Math.abs(dx) + Math.abs(dy) < 3) return;
    drag.moved = true;
    panel.classList.add('grabbing');
    window.sweetspot.miniDrag('move', dx, dy);
  });
  const endDrag = (e) => {
    if (!drag) return;
    panel.releasePointerCapture(e.pointerId);
    panel.classList.remove('grabbing');
    window.sweetspot.miniDrag('end');
    drag = null;
    Panel.dragging = false;
  };
  panel.addEventListener('pointerup', endDrag);
  panel.addEventListener('pointercancel', endDrag);
  // Double-click (not on a button) opens the main window.
  panel.addEventListener('dblclick', (e) => { if (!e.target.closest('button, .progress')) window.sweetspot.showMain(); });

  const livePos = () => {
    if (!state) return 0;
    if (state.paused) return state.position;
    return Math.min(state.duration, state.position + (Date.now() - state.timestamp));
  };

  function render() {
    const t = state && state.track;
    $('play-btn').innerHTML = state && !state.paused ? ICONS.pause : ICONS.play;
    $('like-btn').innerHTML = state && state.liked ? ICONS.heart : ICONS.heartOutline;
    $('like-btn').classList.toggle('active', !!(state && state.liked));
    Panel.setAccent(state ? state.accent : null);
    if (!t) {
      $('title').textContent = 'Nothing playing';
      $('artist').textContent = 'Press play to start';
      $('art').removeAttribute('src');
      $('art').dataset.src = '';
      $('bg').style.backgroundImage = '';
      $('device').classList.add('hidden');
      tick();
      return;
    }
    const src = layout === 'square' ? t.artLarge || t.art : t.art;
    if ($('art').dataset.src !== src) {
      $('art').src = src;
      $('art').dataset.src = src;
      $('bg').style.backgroundImage = `url("${t.art}")`;
    }
    $('title').textContent = t.name;
    $('title').title = t.name;
    $('artist').textContent = t.artists;
    const remote = state.source === 'remote';
    $('device').classList.toggle('hidden', !remote);
    if (remote) $('device').textContent = `On ${state.device.name}`;
    tick();
  }

  function tick() {
    const pct = state && state.duration ? (livePos() / state.duration) * 100 : 0;
    $('bar').style.width = `${pct}%`;
  }
  setInterval(tick, 500);

  window.sweetspot.onState((s) => { state = s; render(); });
  window.sweetspot.getState().then((s) => { state = s; render(); });
})();
