/* Edge peek (Miguel's gesture, proposed for every skin): when a view is bound beside a chat thread (bound views,
 * app.js syncPeek), the edge where it leans in is a handle. Tap it, or swipe it toward the middle, to move to the
 * view; on the view, the thread's edge on the left goes back. The handle glows on its first three appearances
 * only (persisted by the host's localStorage API, across skins and reloads; none with reduced motion).
 * The bottom-bar swipe keeps working as before.
 * Gestures: swipes use the shell's one threshold (swipe-intent.js via api.gesture.intent); a tap (<10 px) moves;
 * short, outward and vertical drags do nothing. The handle never prevents a default and ignores pointercancel, so
 * the OS's own edge gestures (the iOS left-edge back swipe) win as before. It sits outside the chats container,
 * so thread swipe-back never sees it. Phone shell only (the desktop shell has no bound peek).
 * Runs as a WosSkinHost built-in: the host's guards, listeners and teardown. API: none (registers itself). */
{
  function setup(api) {
    if (api.env.shell === 'desktop') return () => {};
    const el = document.createElement('button');
    el.type = 'button'; el.className = 'bound-grab'; el.hidden = true;
    let side = 0, g = null;
    const saved = Number(api.storage.get('glowAppearances'));
    let glowAppearances = Number.isInteger(saved) && saved >= 0 ? Math.min(saved, 3) : 0;
    const go = () => { const s = side; if (s) api.nav.goDesk(api.route().desk + s); };
    api.listen(el, 'pointerdown', e => {
      g = { x: e.clientX, y: e.clientY, at: performance.now(), id: e.pointerId, moved: false };
      try { el.setPointerCapture(e.pointerId); } catch (_) {}
    });
    api.listen(el, 'pointermove', e => { if (g && e.pointerId === g.id && Math.hypot(e.clientX - g.x, e.clientY - g.y) > 10) g.moved = true; });
    const end = e => {
      if (!g || e.pointerId !== g.id) return; const s = g; g = null;
      if (e.type === 'pointercancel') return;
      const dx = e.clientX - s.x, dy = e.clientY - s.y;
      const inward = side > 0 ? dx < 0 : dx > 0;
      if (!s.moved || (inward && api.gesture.intent(dx, dy, performance.now() - s.at))) go();
    };
    api.listen(el, 'pointerup', end); api.listen(el, 'pointercancel', end);
    api.listen(el, 'click', e => { if (e.detail === 0) go(); }); // keyboard and switch access
    api.listen(el, 'animationend', () => el.classList.remove('glow'));
    const paint = next => {
      if (next === side) return;
      side = next; g = null;
      el.hidden = !side;
      el.classList.toggle('right', side > 0); el.classList.toggle('left', side < 0);
      el.setAttribute('aria-label', side > 0 ? 'Show the view beside this thread' : 'Back to the thread');
      el.classList.remove('glow');
      if (side && glowAppearances < 3) {
        api.storage.set('glowAppearances', ++glowAppearances);
        void el.offsetWidth; el.classList.add('glow');
      }
    };
    api.mount(el);
    paint(api.route().beside | 0);
    api.on('beside', b => paint(b.side | 0));
    return () => { g = null; };
  }
  window.WosSkinHost?.builtin('edge-peek', setup, { when: 'always', label: 'Edge peek' });
}
