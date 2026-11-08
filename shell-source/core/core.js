/* Wizard UX core: small helpers every shell uses.
 *
 * Layout of the code (see docs/ARCHITECTURE.md):
 *   web/core/*        shared by every shell: helpers, app registry, commands, review, native bridge
 *   web/live.js       shared: live Wizard data (threads, read state, sends)
 *   web/outbox.js     shared: durable outbox (nothing said or typed is lost)
 *   web/index.html    mobile shell entry (orb, desks, gestures)   → app.js, orb.js, styles.css
 *   web/desktop.html  desktop shell entry (tiling, keys, palette) → desktop/*
 * A shell never loads the other shell's code: shell-select.js picks one before anything else loads. */
((root) => {
  'use strict';
  // Classic boot and ES layout imports can both evaluate this file; preserve the original helper instances.
  if (root.WizCore?.ago && root.WizCore?.store && root.WizCore?.emoOf) return;
  const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const clip = (s, n) => { s = String(s || '').replace(/\s+/g, ' ').trim(); return s.length > n ? s.slice(0, n - 1).trimEnd() + '…' : s; };
  const norm = s => String(s || '').toLowerCase().replace(/[^a-z0-9ก-๙ ]+/g, ' ').replace(/\s+/g, ' ').trim();
  // Per-shell storage: the phone and the desktop keep their own layouts, everything else is shared server state.
  const store = prefix => ({
    get(k, d) { try { const v = localStorage.getItem(prefix + k); return v ? JSON.parse(v) : d; } catch (e) { return d; } },
    set(k, v) { try { localStorage.setItem(prefix + k, JSON.stringify(v)); } catch (e) {} },
  });
  const DOW = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
  // Shared Chats labels: relative hours for a full 24h, even across midnight; then the owner's calendar day.
  // `now` is injectable for fixed-clock consumers/tests. AI apps' shortTime is an alias of this same function.
  const ago = (at, now = Date.now()) => {
    const t = typeof at === 'number' ? at : Date.parse(at || ''); if (!isFinite(t)) return '';
    const elapsed = now - t, m = Math.round(elapsed / 6e4);
    if (m < 1) return 'now'; if (m < 60) return m + 'm'; if (elapsed < 864e5) return Math.round(m / 60) + 'h';
    const d = root.WizConfig ? root.WizConfig.dayParts(t) : { dow: new Date(t).getDay(), d: new Date(t).getDate() }; return `${DOW[d.dow]} ${d.d}`;
  };
  const emoOf = (() => {
    let EMO = {}, at = 0;
    return id => { if (Date.now() - at > 2000) { try { EMO = JSON.parse(localStorage.getItem('wizard.thread-emojis.v1') || '{}'); } catch (e) {} at = Date.now(); } return EMO[`direct:${id}`] || root.WizBrand.html; };
  })();
  root.WizCore = Object.assign(root.WizCore || {}, { esc, clip, norm, store, ago, emoOf, DOW });
})(typeof window === 'object' ? window : globalThis);
