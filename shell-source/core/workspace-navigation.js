/* Workspace identity shared by phone dock and desktop bar.
 * Shells own layout/window state; this module owns the focused-app glyph, colour,
 * count badge and desktop keyboard slots (Home on ⌥`, desktops 1–9). Keep those rules identical. */
(() => {
  'use strict';
  const C = window.WizCore = window.WizCore || {};
  /* Per-app counts (Chats = visible unread threads, Notifications = unread, later any app). The badge belongs to the
   * app: each desk mark carries the count of the apps it holds, and the orb shows the desk in view. */
  /* An item counts in one place (Settings › Notifications): an app set to Chats shows no badge of its own, its items
   * wait in Chats and count in Chats' badge instead. `raw` keeps what the app reported, `counts` what is shown. */
  // `more`: an app that lists only its newest items says there are more; its count shows as "50+".
  const counts = {}, raw = {}, more = new Set();
  // A quiet choice (the routing part's Off, say) shows no badge at all.
  const shown = (id, n) => id !== 'wizard' && (window.WosBell?.inChats?.(id) || window.WosBell?.isOff?.(id)) ? 0 : n;
  /* Notifications' items about an app that wait outside Chats (WosBell.carry, its own routing already applied) add to
   * that app's badge, beside what the app itself reported. */
  const carried = {};
  function apply(id) {
    const n = shown(id, raw[id] || 0) + (carried[id] || 0); if ((counts[id] || 0) === n) return;
    counts[id] = n; window.dispatchEvent(new CustomEvent('wizard:app-counts', { detail: { id, n } }));
  }
  function setCount(id, n, plus) {
    const was = more.has(id); if (plus) more.add(id); else more.delete(id);
    raw[id] = Math.max(0, n | 0);
    if (was !== !!plus) { counts[id] = -1; } apply(id);
  }
  // One projection for every Chats/Ready pill; list membership remains a separate workflow concern.
  // Reuse the loaded unified list and canonical visibility/read rules: no reads, receipts or migration here.
  function chatsCount(live) {
    const threads = live?.ok ? live.visibleUnread(live.unified()).length : 0;
    // Preserve app notification routing, but never badge read/snoozed inbox items as Ready did.
    const inbox = window.WosBell?.unreadCount?.() || 0;
    return threads + inbox;
  }
  function refreshChats(live, id = 'wizard') {
    setCount(id, chatsCount(live), !!window.WosBell?.unreadCount?.() && !!window.WosBell?.readyMore?.());
  }
  function carry(map) {
    const next = map && typeof map === 'object' ? map : {};
    for (const id of new Set([...Object.keys(carried), ...Object.keys(next)])) { const n = Math.max(0, Math.min(999, next[id] | 0)); if ((carried[id] || 0) !== n) { if (n) carried[id] = n; else delete carried[id]; apply(id); } }
  }
  // A routing choice changed: show every reported count again through it.
  function rerouted() { for (const id of new Set([...Object.keys(raw), ...Object.keys(carried)])) apply(id); }
  function deskCount(desk, wins, appOf) {
    if (!desk || desk.home) return 0;
    const seen = new Set(); let n = 0;
    for (const id of desk.wins || []) { const a = wins[id] && appOf(wins[id]); const k = a && a.id; if (k && !seen.has(k)) { seen.add(k); n += counts[k] || 0; } }
    return n;
  }
  function deskMore(desk, wins, appOf) {
    if (!desk || desk.home) return false;
    return (desk.wins || []).some(id => { const a = wins[id] && appOf(wins[id]); return !!(a && more.has(a.id) && counts[a.id] > 0); });
  }
  const fmt = (n, plus) => n > 99 ? '99+' : plus ? n + '+' : String(n);
  // One app's badge as shown: '' when none, '50+' when the app lists only its newest items.
  const label = id => { const n = counts[id] || 0; return n > 0 ? fmt(n, more.has(id)) : ''; };
  function icon(desk, wins, appOf) {
    const S = window.WizSigil;
    if (!S) return '';
    if (desk.home) return '<span class="dsg" style="--c:#C9BEFF"><i class="sgi sg-home" aria-hidden="true"></i></span>';
    const ids = desk.wins || [], focused = wins[desk.focus] || wins[ids[0]];
    if (!focused) return '<span class="dsg empty" aria-hidden="true"></span>';
    const a = appOf(focused) || {}, sigil = a.sigil || a, s = S.of(sigil);
    return `<span class="dsg" style="--c:${a.sgc || s.color}">${a.sgh || S.html(sigil)}${ids.length > 1 ? `<b class="dn">${ids.length}</b>` : ''}${(() => { const n = deskCount(desk, wins, appOf); return n ? `<b class="dbg">${fmt(n, deskMore(desk, wins, appOf))}</b>` : ''; })()}</span>`;
  }
  // Desktop keys (Miguel, 27 Oct 2026): Home lives on ⌥` (left of 1), so desktops are numbered from 1.
  const slot = (index, homeIncluded = false) => index + (homeIncluded ? 0 : 1);
  function digitTarget(digit, count) {
    if (!Number.isInteger(digit) || digit < 1 || digit > 9) return null;
    const index = digit - 1;
    return index < count ? { kind: 'desktop', index } : index === count ? { kind: 'new', index } : null;
  }
  C.workspaceNav = Object.freeze({ icon, slot, digitTarget, setCount, chatsCount, refreshChats, carry, rerouted, deskCount, deskMore, fmt, label, counts });
})();
