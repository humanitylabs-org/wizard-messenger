/* Wizard OS appearance host: Appearance v1 (wizard-os spec/APPEARANCE.md, decisions #50–#53). APPEARANCE_HOST_V1
 * Shared by both shells. The shell owns the backdrop: an app that adopted the appearance client paints a transparent
 * canvas and sits on the same window material as Chats. Theme content only: this grants no data, API, mic or agent rights.
 *
 * Contract (shell side):
 *  - Only same-origin frames inside a shell window whose current path starts with a registered app URL (the shell's app
 *    registry: web/core/apps.js + GET /wizard/v1/apps) get a context, and only after they ask (wizard:appearance:ready).
 *    Exact target origin, exact e.source match, no query-string trust.
 *  - A window is marked .wz-themed (drops the legacy opaque #0f1014 frame fill) only after that document acknowledged an
 *    applied revision. Apps that never adopted the client (Files, Calendar, Mizel, …) look exactly as before.
 *  - Changes (skin, colour scheme, full screen) are pushed, never polled, and never reload the app. */
(() => {
  'use strict';
  if (window.WizAppearance) return;
  const VERSION = 1;
  const ORIGIN = location.origin;
  const frames = new Map();          // iframe -> { doc, sent, acked, sig }
  let revision = 0, scheduled = false, tokensCache = null;
  const isColor = v => typeof v === 'string' && v.length > 0 && v.length < 96 && !/[;{}]|url\(/i.test(v) && (!window.CSS?.supports || CSS.supports('color', v));
  const read = (s, k, f) => { const v = s.getPropertyValue('--' + k).trim(); return isColor(v) ? v : f; };

  // Registered app paths (same-origin only). One registry per shell kind, created once.
  let regs = null;
  function appPrefixes() {
    if (!regs) { try { regs = ['mobile', 'desktop'].map(k => window.WizCore.apps(k)); } catch (e) { regs = []; } }
    const out = [];
    for (const r of regs) for (const a of (r.APPS || [])) {
      if (!a || !a.url || a.kind === 'native') continue;
      try { const u = new URL(a.url, ORIGIN); if (u.origin === ORIGIN && u.pathname.length > 1) out.push(u.pathname); } catch (e) {}
    }
    return out;
  }
  function allowed(f) {
    let loc; try { loc = f.contentWindow.location; } catch (e) { return false; }   // cross-origin: never
    if (!loc || loc.origin !== ORIGIN) return false;
    if (f.closest('.st-embed')) return true;   // a page Settings itself embeds (Settings › Connections)
    const p = loc.pathname;
    return appPrefixes().some(pre => pre.endsWith('/') ? p.startsWith(pre) : (p === pre || p.startsWith(pre + '/')));
  }
  // Registered apps opened in the shared link sheet (including provider setup)
  // receive the same Appearance contract as normal app windows. allowed() still
  // excludes cross-origin and unregistered pages.
  // Settings embeds (.st-embed, e.g. Settings › Connections) take the theme too, so they follow the skin like the page
  // around them; they never mark the Settings window .wz-themed (that window is the shell's own).
  // The Welcome's Bring your AI step (.wl-embed) shows the Importer app's own screen: it takes the theme too.
  const winFrames = () => [...document.querySelectorAll('.win iframe, .linksheet iframe, .st-embed iframe, .wl-embed iframe')];
  const themedWin = f => f.closest('.st-embed') || f.closest('.wl-embed') ? null : f.closest('.win');
  const frameOf = src => src ? winFrames().find(f => f.contentWindow === src) || null : null;

  function tokens() {
    if (tokensCache) return tokensCache;
    const root = document.documentElement, s = getComputedStyle(root);
    const scheme = (s.colorScheme || '').trim();
    const light = /\blight\b/.test(scheme) && !/\bdark\b/.test(scheme);
    const bg = read(s, 'bg', light ? '#f6f3ec' : '#05030c'), ink = read(s, 'ink', light ? '#1d1b17' : '#f3efff');
    const accent = read(s, 'violet-2', '#b99bff');
    const skin = /^[a-z0-9-]{1,40}$/.test(root.dataset.skin || '') ? root.dataset.skin : 'nebula';
    tokensCache = { skin, colorScheme: light ? 'light' : 'dark', tokens: {
      canvas: 'transparent', base: bg,
      chrome: read(s, 'sk-win', 'rgba(12,8,26,.82)'),          // the window material (.win in styles.css; skins set --sk-win)
      overlay: read(s, 'glass-2', 'rgba(28,19,58,.72)'),       // the shell's sheet material
      surface: `color-mix(in srgb, ${ink} 6%, transparent)`,
      'surface-raised': `color-mix(in srgb, ${ink} 10%, transparent)`,
      text: ink, 'text-secondary': read(s, 'ink-2', '#b9b0d8'), 'text-muted': read(s, 'ink-3', '#7d74a3'),
      border: read(s, 'line-2', 'rgba(205,190,255,.24)'),
      accent, 'accent-soft': `color-mix(in srgb, ${accent} 16%, transparent)`, 'on-accent': light ? '#fffdf8' : bg,
      'reader-surface': 'transparent',
    } };
    return tokensCache;
  }
  // Distraction-free (swipe down on the orb) hides the title bar of a sole or full-screen window, so the host presents
  // that window edge to edge too: apps hide their own in-app headers the same way they do in full screen (James, 20 Oct).
  const IMMERSIVE = '.device.immersive .win.full, .wsp .win.full, .device.zen .tiles[data-n="1"] .win, .device.zen .tiles.has-full .win.full';
  const presentation = f => f.closest(IMMERSIVE) ? 'immersive' : 'window';
  function context(f) { const t = tokens(); return { version: VERSION, revision, skin: t.skin, family: window.WosSkin?.familyOf?.(t.skin) || 'wizard', colorScheme: t.colorScheme, presentation: presentation(f), tokens: t.tokens }; }

  function send(f, force) {
    const st = frames.get(f); if (!st || !f.contentWindow) return;
    const a = context(f), sig = JSON.stringify({ ...a, revision: 0 });
    if (!force && st.sig === sig) return;
    a.revision = ++revision; st.sig = sig; st.sent = a;
    try { f.contentWindow.postMessage({ type: 'wizard:appearance', appearance: a }, ORIGIN); } catch (e) {}
  }
  function forget(f) { frames.delete(f); themedWin(f)?.classList.remove('wz-themed'); }
  function sync() {
    for (const f of [...frames.keys()]) {
      if (!f.isConnected) { frames.delete(f); continue; }
      let doc = null; try { doc = f.contentDocument; } catch (e) {}
      if (doc !== frames.get(f).doc) { forget(f); continue; }
      send(f, false);
    }
  }
  function queue(resetTokens) {
    if (resetTokens) tokensCache = null;
    if (scheduled || !frames.size) return; scheduled = true;
    queueMicrotask(() => { scheduled = false; sync(); });
  }

  addEventListener('message', e => {
    const d = e.data;
    if (e.origin !== ORIGIN || !d || typeof d.type !== 'string' || !d.type.startsWith('wizard:appearance') || d.version !== VERSION) return;
    const f = frameOf(e.source); if (!f) return;
    if (d.type === 'wizard:appearance:ready') {
      if (!allowed(f)) return;
      let doc = null; try { doc = f.contentDocument; } catch (e2) { return; }
      const prev = frames.get(f);
      frames.set(f, { doc, sent: null, acked: prev && prev.doc === doc ? prev.acked : false, sig: '' });
      send(f, true);
    } else if (d.type === 'wizard:appearance:ack') {
      const st = frames.get(f); if (!st || !st.sent || d.revision !== st.sent.revision) return;
      let doc = null; try { doc = f.contentDocument; } catch (e2) {}
      if (doc !== st.doc) return;
      st.acked = true; themedWin(f)?.classList.add('wz-themed');
    }
  });
  // A frame that navigated to a document that did not (re)announce itself loses the theme marker.
  document.addEventListener('load', e => {
    const f = e.target;
    // Skin package CSS may arrive after data-skin changed. Its color-scheme must
    // invalidate the cached context too, or light apps receive dark UA canvases.
    if (f?.tagName === 'LINK' && f.rel === 'stylesheet') { queue(true); return; }
    if (f && f.tagName === 'IFRAME' && frames.has(f)) { let doc = null; try { doc = f.contentDocument; } catch (er) {} if (doc !== frames.get(f).doc) forget(f); }
  }, true);

  function mount() {
    const root = document.documentElement;
    new MutationObserver(() => queue(true)).observe(root, { attributes: true, attributeFilter: ['style', 'class', 'data-skin'] });
    // Full screen / immersive changes the presentation: watch window classes only while themed frames exist.
    new MutationObserver(() => queue(false)).observe(document.body, { subtree: true, attributes: true, attributeFilter: ['class', 'data-n'] });
    try { matchMedia('(prefers-color-scheme: light)').addEventListener('change', () => queue(true)); } catch (e) {}
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', mount); else mount();

  window.WizAppearance = {
    version: VERSION,
    get: f => f && allowed(f) ? context(f) : null,
    sync: () => queue(true),
    inspect: () => [...frames].map(([f, st]) => ({ src: f.getAttribute('src'), acked: st.acked, revision: st.sent && st.sent.revision, presentation: st.sent && st.sent.presentation, themed: !!f.closest('.win.wz-themed') })),
  };
})();
