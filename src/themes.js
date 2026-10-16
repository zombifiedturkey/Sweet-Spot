// Theme presets + album-art accent colour. Shared by every window.
window.Themes = (() => {
  // "classic" applies nothing, so the values in theme.css are used as-is.
  const presets = {
    classic:  { name: 'Classic', hint: 'Uses theme.css' },
    midnight: { name: 'Midnight', accent: '#5b9bff', bg: '#0e1320', sidebar: '#070a12', elevated: '#151c2c', hover: '#1f2a40', border: '#232d44', panel: '15, 20, 33' },
    sunset:   { name: 'Sunset', accent: '#ff8a4c', bg: '#181110', sidebar: '#0b0807', elevated: '#221815', hover: '#33241f', border: '#3a2a24', panel: '30, 20, 17' },
    rose:     { name: 'Rose', accent: '#ff5d8f', bg: '#171015', sidebar: '#0a0609', elevated: '#21161d', hover: '#32212b', border: '#3a2632', panel: '28, 17, 24' },
    forest:   { name: 'Forest', accent: '#7ddc8c', bg: '#0f1611', sidebar: '#060a07', elevated: '#16201a', hover: '#213027', border: '#25352b', panel: '17, 26, 20' },
    mono:     { name: 'Mono', accent: '#f2f2f2', bg: '#0c0c0c', sidebar: '#000000', elevated: '#161616', hover: '#262626', border: '#2a2a2a', panel: '18, 18, 18' }
  };

  // Accent colour choices (Settings → Accent colour), alongside 'auto' and 'theme'.
  const accents = {
    green:  { name: 'Green',  hex: '#1ed760' },
    blue:   { name: 'Blue',   hex: '#4f8cff' },
    purple: { name: 'Purple', hex: '#a374ff' },
    pink:   { name: 'Pink',   hex: '#ff5fa2' },
    red:    { name: 'Red',    hex: '#ff5757' },
    orange: { name: 'Orange', hex: '#ff8a3d' },
    yellow: { name: 'Yellow', hex: '#ffd23f' },
    teal:   { name: 'Teal',   hex: '#2dd4bf' },
    white:  { name: 'White',  hex: '#f2f2f2' }
  };

  const VARS = { accent: '--accent', bg: '--bg', sidebar: '--bg-sidebar', elevated: '--bg-elevated', hover: '--bg-hover', border: '--border', panel: ['--panel-rgb', '--glass-rgb'] };

  function hexToRgb(hex) {
    const h = hex.replace('#', '');
    const n = parseInt(h.length === 3 ? h.split('').map((c) => c + c).join('') : h, 16);
    return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
  }
  function luminance([r, g, b]) {
    const f = (c) => { c /= 255; return c <= 0.03928 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4); };
    return 0.2126 * f(r) + 0.7152 * f(g) + 0.0722 * f(b);
  }
  const textOn = (hex) => (luminance(hexToRgb(hex)) > 0.35 ? '#000000' : '#ffffff');

  // Apply preset + optional album accent to this document.
  function apply(settings, artAccent) {
    const root = document.documentElement.style;
    const p = presets[(settings && settings.theme) || 'classic'] || presets.classic;
    for (const [k, v] of Object.entries(VARS)) {
      for (const name of [].concat(v)) { if (p[k]) root.setProperty(name, p[k]); else root.removeProperty(name); }
    }
    const mode = (settings && settings.accent) || (settings && settings.dynamicAccent === false ? 'theme' : 'auto');
    const accent = mode === 'auto' ? (artAccent || p.accent)
      : mode === 'theme' ? p.accent
      : (accents[mode] ? accents[mode].hex : p.accent);
    if (accent) {
      root.setProperty('--accent', accent);
      root.setProperty('--accent-text', textOn(accent));
    } else {
      root.removeProperty('--accent-text');
    }
  }

  // ---- Colour extraction from album art ----
  function rgbToHsl(r, g, b) {
    r /= 255; g /= 255; b /= 255;
    const max = Math.max(r, g, b), min = Math.min(r, g, b);
    let h = 0, s = 0;
    const l = (max + min) / 2;
    if (max !== min) {
      const d = max - min;
      s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
      h = max === r ? (g - b) / d + (g < b ? 6 : 0) : max === g ? (b - r) / d + 2 : (r - g) / d + 4;
      h /= 6;
    }
    return [h, s, l];
  }
  function hslToHex(h, s, l) {
    const f = (n) => {
      const k = (n + h * 12) % 12;
      const a = s * Math.min(l, 1 - l);
      const c = l - a * Math.max(-1, Math.min(k - 3, 9 - k, 1));
      return Math.round(c * 255).toString(16).padStart(2, '0');
    };
    return `#${f(0)}${f(8)}${f(4)}`;
  }

  const cache = new Map();

  // Returns { accent, base } hex colours, or null if the image can't be read.
  // accent: vivid version for buttons/progress; base: darker version for page headers.
  function extract(url) {
    if (!url) return Promise.resolve(null);
    if (cache.has(url)) return Promise.resolve(cache.get(url));
    return new Promise((resolve) => {
      const im = new Image();
      im.crossOrigin = 'anonymous';
      im.onload = () => {
        try {
          const N = 40;
          const c = document.createElement('canvas');
          c.width = N; c.height = N;
          const ctx = c.getContext('2d', { willReadFrequently: true });
          ctx.drawImage(im, 0, 0, N, N);
          const px = ctx.getImageData(0, 0, N, N).data;
          const buckets = Array.from({ length: 24 }, () => ({ w: 0, h: 0, s: 0, l: 0 }));
          let anyR = 0, anyG = 0, anyB = 0, count = 0;
          for (let i = 0; i < px.length; i += 4) {
            const [h, s, l] = rgbToHsl(px[i], px[i + 1], px[i + 2]);
            anyR += px[i]; anyG += px[i + 1]; anyB += px[i + 2]; count++;
            if (s < 0.22 || l < 0.12 || l > 0.9) continue;
            const b = buckets[Math.floor(h * 24) % 24];
            const w = s * (1 - Math.abs(l - 0.5) * 1.2);
            b.w += w; b.h += h * w; b.s += s * w; b.l += l * w;
          }
          const best = buckets.reduce((a, b) => (b.w > a.w ? b : a));
          let result;
          if (best.w > 2) {
            const h = best.h / best.w, s = best.s / best.w, l = best.l / best.w;
            result = {
              accent: hslToHex(h, Math.max(0.55, Math.min(0.9, s)), Math.max(0.58, Math.min(0.68, l + 0.1))),
              base: hslToHex(h, Math.min(0.6, s), 0.28)
            };
          } else {
            // Greyscale art: fall back to the average colour for the header only.
            const [h, s] = rgbToHsl(anyR / count, anyG / count, anyB / count);
            result = { accent: null, base: hslToHex(h, Math.min(0.25, s), 0.24) };
          }
          cache.set(url, result);
          resolve(result);
        } catch { resolve(null); } // tainted canvas (no CORS) etc.
      };
      im.onerror = () => resolve(null);
      im.src = url;
    });
  }

  return { presets, accents, apply, extract, textOn };
})();
