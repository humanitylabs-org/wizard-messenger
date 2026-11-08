/* Thread swipe-back (Miguel's gesture, every skin since James, 23 Oct 2026): inside an open chat thread, swipe right
 * from anywhere (not the OS edge strip) to go back one step. The thread follows the finger a little and fades;
 * an intentional swipe (swipe-intent.js: long drag or deliberate level flick) runs the shell's own Back step (linked thread -> parent, thread -> list).
 * It never leaves or exits the app. Code blocks, tables, the composer, sliders, inputs and selected text keep their
 * own horizontal gestures. Runs as a WosSkinHost built-in, so it gets the skin hook API's guards and cleanup.
 * API: none (registers itself). */
import { engages, commits } from './swipe-intent.js';
{
  function setup(api) {
    let sw = null;
    const thread = () => { const r = api.part('thread'); return r && r.querySelector('[data-part="thread"]'); };
    const skip = t => !t || !t.closest || t.closest('pre, table, [data-part="composer"], .ms-track, input, textarea, [contenteditable="true"]');
    const reset = th => { if (!th) return; th.style.transition = 'transform .18s ease-out, opacity .18s ease-out'; th.style.transform = ''; th.style.opacity = ''; };
    const bind = root => {
      api.listen(root, 'touchstart', e => {
        sw = null;
        if (api.route().view !== 'thread' || e.touches.length !== 1) return;
        const t0 = e.touches[0];
        if (t0.clientX < api.env.edgeInset || skip(e.target) || String(window.getSelection ? window.getSelection() : '')) return;
        const th = thread(); if (!th) return;
        sw = { x: t0.clientX, y: t0.clientY, t: performance.now(), th, on: false, dx: 0 };
      }, { passive: true });
      api.listen(root, 'touchmove', e => {
        if (!sw) return;
        const t = e.touches[0], dx = t.clientX - sw.x, dy = Math.abs(t.clientY - sw.y);
        if (!sw.on) {
          if (dy > 36 && dy > dx) { sw = null; return; }
          if (engages(dx, dy)) { sw.on = true; sw.th.style.transition = 'none'; } else return;
        }
        sw.dx = dx;
        const s = sw;
        api.frame(() => { if (!s.on || s.done) return; s.th.style.transform = `translateX(${Math.max(0, Math.min(s.dx, 140)) * .5}px)`; s.th.style.opacity = String(1 - Math.max(0, Math.min(s.dx, 160)) / 500); });
      }, { passive: true });
      const end = e => {
        if (!sw) return; const s = sw; sw = null; s.done = true;
        // Snap back on every release: a drag frame queued by the last move must not re-indent the thread after it.
        if (s.on) { reset(s.th); api.frame(() => reset(s.th)); }
        s.on = s.on && e.type !== 'touchcancel';
        const t1 = e.changedTouches && e.changedTouches[0]; if (!t1 || !s.on) return;
        const dx = t1.clientX - s.x, dy = Math.abs(t1.clientY - s.y);
        if (commits(dx, dy, performance.now() - s.t)) api.nav.back();
      };
      api.listen(root, 'touchend', end, { passive: true });
      api.listen(root, 'touchcancel', end, { passive: true });
    };
    // The chats container is stable across repaints; bind once per container (desks can hold several chats windows).
    const bound = new WeakSet();
    const ensure = () => { const r = api.part('thread') || api.part('list'); if (r && !bound.has(r)) { bound.add(r); bind(r); } };
    ensure();
    api.on('render', ensure);
    api.on('route', ensure);
    return () => { if (sw) reset(sw.th); sw = null; };
  }
  window.WosSkinHost?.builtin('thread-swipe-back', setup, { when: 'touch', label: 'Swipe back' });
}
