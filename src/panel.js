// Shared setup for the floating panels (flyout, mini-player, toast): window mode,
// style + theme settings, accent colour, taskbar edge and click-through margins.
window.Panel = (() => {
  const mode = new URLSearchParams(location.search).get('mode') || 'css';
  document.body.classList.add(`mode-${mode}`);
  let settings = null;
  let accent = null;

  function applySettings(s) {
    if (!s) return;
    settings = s;
    const b = document.body;
    b.classList.remove('style-acrylic', 'style-glass', 'style-solid');
    b.classList.add(`style-${s.effectiveStyle || s.flyoutStyle}`);
    b.classList.toggle('no-wash', !s.albumWash);
    document.documentElement.style.setProperty('--panel-alpha', String(s.flyoutOpacity));
    if (window.Themes) Themes.apply(s, accent);
    if (Panel.onSettings) Panel.onSettings(s);
  }

  function setAccent(a) {
    if (a === accent) return;
    accent = a;
    if (window.Themes && settings) Themes.apply(settings, accent);
  }

  function setEdge(edge) {
    document.body.classList.remove('edge-top', 'edge-bottom', 'edge-left', 'edge-right');
    document.body.classList.add(`edge-${edge}`);
  }

  function animateIn(panel) {
    panel.classList.remove('anim-out', 'anim-in');
    void panel.offsetWidth;
    panel.classList.add('anim-in');
  }

  function init(panel) {
    window.sweetspot.getSettings().then(applySettings).catch(() => {});
    window.sweetspot.onSettings(applySettings);
    window.sweetspot.onPanelEdge(setEdge);
    // In transparent mode the window ignores the mouse until it's over the panel itself.
    if (mode === 'css') {
      panel.addEventListener('mouseenter', () => window.sweetspot.panelMouse(true));
      panel.addEventListener('mouseleave', () => { if (!Panel.dragging) window.sweetspot.panelMouse(false); });
    }
  }

  const Panel = { mode, init, animateIn, applySettings, setAccent, onSettings: null, dragging: false };
  return Panel;
})();
