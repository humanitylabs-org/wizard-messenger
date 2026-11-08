/* Wizard OS scenery gate (WOS_SCENERY_V1). Owns ALL decorative background motion of the phone shell:
 * the skin canvases (core/skins.js registers a layer), Nebula's star twinkle (the starfield lives here) and the
 * Nebula drift (CSS @keyframes drift, running only under .device.scenery-live).
 *
 * James, 12 Oct 2026: animated backgrounds only if they don't drain battery when not viewed. Scenery is LIVE only
 * while ALL of these hold:
 *   - the page is visible;
 *   - the Home desk is in front (host.homeInView(): idx === HOME, nothing full screen there);
 *   - no sheet / overview / link sheet / Help sheet / Live Mode ideas over it; not immersive (full screen);
 *   - prefers-reduced-motion is off;
 *   - the last pointerdown/keydown was less than IDLE_MS (45 s) ago.
 * Otherwise every timer and rAF is cancelled, CSS animations are paused (styles.css: .device:not(.scenery-live)),
 * and the canvases keep their last frame: a frozen scene still shows through the translucent windows, at no cost.
 * A still repaint (one rAF) happens only on events that change the picture: skin change, resize, desk parallax.
 *
 * Frame budget while live: each layer declares its own fps (skins ~30, stars ~20); the loop sleeps between frames
 * with a timer and only then asks for one rAF, so the page is not woken at 60 Hz for nothing.
 * API: WosScenery.attach(host), .layer(spec), .update(), .still(), .live, .setIdle(ms), .state(). */
(() => {
  'use strict';
  if (window.WosScenery) return;
  let IDLE_MS = 45000;
  const layers = [];
  let host = null, device = null, live = false, raf = 0, tmr = 0, idleT = 0, stillRaf = 0;
  let lastInput = performance.now(), lastFrame = 0;
  const RM = (() => { try { return matchMedia('(prefers-reduced-motion: reduce)'); } catch (e) { return null; } })();
  const reduced = () => !!(RM && RM.matches);
  // Anything that covers Home or replaces it: classes app.js sets on #device (sheets, overview, link sheet, full screen).
  const COVER = ['sheet-open', 'ov-open', 'link-open', 'immersive'];

  function why() {
    if (!device) return 'no-device';
    if (document.hidden) return 'hidden';
    if (reduced()) return 'reduced-motion';
    if (!host || !host.homeInView()) return 'not-home';
    for (const c of COVER) if (device.classList.contains(c)) return c;
    if (document.querySelector('.help-sheet.open, #lmIdeas.on')) return 'overlay'; // tour Help sheet, Live Mode ideas
    if (performance.now() - lastInput >= IDLE_MS) return 'idle';
    if (!layers.some(l => l.active())) return 'nothing';
    return '';
  }

  function update() {
    const w = why(), on = !w;
    clearTimeout(idleT); idleT = 0;
    if (on) { const left = IDLE_MS - (performance.now() - lastInput); idleT = setTimeout(update, Math.max(50, left + 20)); }
    if (on === live) return;
    live = on;
    if (device) device.classList.toggle('scenery-live', on);
    if (on) { lastFrame = 0; schedule(0); }
    else { cancelAnimationFrame(raf); raf = 0; clearTimeout(tmr); tmr = 0; layers.forEach(l => l.pause && l.pause()); }
  }

  function schedule(delay) {
    if (!live || raf || tmr) return;
    if (delay > 4) tmr = setTimeout(() => { tmr = 0; if (live && !raf) raf = requestAnimationFrame(wosSceneryFrame); }, delay);
    else raf = requestAnimationFrame(wosSceneryFrame);
  }
  // Named so QA can count exactly these callbacks (rAF wrapper keyed on callback name).
  function wosSceneryFrame(now) {
    raf = 0; if (!live) return;
    const dt = lastFrame ? Math.min(.1, (now - lastFrame) / 1000) : 0; lastFrame = now;
    let next = 1000;
    for (const l of layers) {
      if (!l.active()) { l.off && l.off(); continue; }
      const iv = 1000 / (l.fps || 20);
      if (!l.last || now - l.last >= iv - 4) { const ldt = l.last ? Math.min(.1, (now - l.last) / 1000) : dt; l.last = now; try { l.draw(ldt, now); } catch (e) {} }
      next = Math.min(next, iv - (now - l.last));
    }
    schedule(Math.max(0, next - 6));
  }
  // One repaint of whatever is on screen, for events that change the picture while scenery is frozen.
  // only: a layer name (desk parallax repaints just the stars); several calls in one frame merge.
  let stillOnly = null;
  function still(only) {
    if (live || document.hidden) return;
    stillOnly = stillRaf ? (stillOnly === only ? only : null) : (only || null);
    if (stillRaf) return;
    stillRaf = requestAnimationFrame(function wosSceneryStill() {
      stillRaf = 0; const o = stillOnly; stillOnly = null;
      for (const l of layers) { if (o && l.name !== o) continue; if (!l.active()) { l.off && l.off(); continue; } try { (l.still || l.draw)(0, performance.now()); } catch (e) {} }
    });
  }
  const poke = () => { lastInput = performance.now(); update(); };

  /* ---------- Nebula stars: static field, gentle twinkle only while live (moved from app.js) ---------- */
  function starLayer() {
    const c = document.getElementById('stars'); if (!c) return null;
    const x = c.getContext('2d'); let Wd = 0, H = 0, pts = [], t = 0;
    // (the page's own size only: a layout's re-tiling resize keeps the same sky; a real one stretches it, never re-rolls)
    function size() {
      const r = Math.min(devicePixelRatio || 1, 2), w = c.clientWidth * r, h = c.clientHeight * r;
      if (pts.length && w === Wd && h === H) return false;
      if (pts.length && Wd && H) { const kx = w / Wd, ky = h / H; for (const p of pts) { p.x *= kx; p.y *= ky; } }
      else pts = Array.from({ length: 170 }, () => ({ x: Math.random() * w * 1.4, y: Math.random() * h, r: Math.random() * 1.3 * r + .2, p: Math.random() * 6.28, s: .4 + Math.random() * 1.4, d: Math.random() }));
      Wd = c.width = w; H = c.height = h; return true;
    }
    function paint(tw) {
      x.clearRect(0, 0, Wd, H);
      const off = -(host ? host.deskIdx() : 0) * Wd * .05;
      const ratio = Math.min(devicePixelRatio || 1, 2);
      for (const p of pts) {
        const base = .25 + .75 * Math.abs(Math.sin(p.p));
        // WOS_NEBULA_VISIBLE_V1: visible, depth-dependent drift plus twinkle. Time advances ONLY in
        // this gated layer's draw(), so the same sky freezes exactly in place behind apps/overlays.
        const a = tw ? base * (.6 + .4 * Math.sin(t * p.s * 1.1 + p.p * 3)) : base;
        const travel = t * (2.2 + p.d * 2.8) * ratio;
        const px = ((p.x + off * (p.d + .2) + travel) % (Wd * 1.4) + Wd * 1.4) % (Wd * 1.4) - Wd * .2;
        const py = ((p.y - t * (1.2 + p.d * 1.8) * ratio) % H + H) % H;
        const edge = Math.min(1, py / (14 * ratio), (H - py) / (14 * ratio));
        x.globalAlpha = a * (.35 + p.d * .65) * edge; x.fillStyle = p.d > .85 ? '#d9c8ff' : '#ffffff';
        x.beginPath(); x.arc(px, py, p.r, 0, 6.28); x.fill();
      }
      x.globalAlpha = 1;
    }
    size();
    addEventListener('resize', () => { if (size()) still('stars'); });
    const nebula = () => { const s = document.documentElement.dataset.skin; return !s || s === 'nebula'; };
    return {
      name: 'stars', fps: 20,
      active: () => nebula() || (window.WosSkin && window.WosSkin.pos < 1),
      draw(dt) { t += dt; paint(true); },
      still() { paint(true); },
    };
  }

  function attach(h) {
    host = h; device = h.device || document.getElementById('device');
    const s = starLayer(); if (s) layers.unshift(s);
    ['pointerdown', 'keydown'].forEach(ev => document.addEventListener(ev, poke, { capture: true, passive: true }));
    document.addEventListener('visibilitychange', () => { if (!document.hidden) lastInput = performance.now(); update(); if (!document.hidden) still(); });
    try { RM && RM.addEventListener('change', update); } catch (e) {}
    // Covers (sheets, immersive, overview, link sheet) are classes on #device; the Help sheet is a child of it.
    new MutationObserver(update).observe(device, { attributes: true, attributeFilter: ['class'], childList: true });
    still(); update();
  }

  window.WosScenery = {
    attach,
    layer(spec) { layers.push(spec); still(); update(); return spec; },
    update, still, poke,
    get live() { return live; },
    get idleMs() { return IDLE_MS; },
    setIdle(ms) { IDLE_MS = Math.max(200, +ms || 45000); lastInput = performance.now(); update(); },
    state: () => ({ live, why: why(), idleMs: IDLE_MS, sinceInput: Math.round(performance.now() - lastInput), raf: !!raf, timer: !!tmr, layers: layers.map(l => ({ name: l.name, active: !!l.active() })) }),
  };
})();
