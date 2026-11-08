/* WosMorph: repaint a live view by patching only what changed.
 *
 * Chats rebuilt its whole list (80+ rows) or open thread with innerHTML on every live tick: a "1m 30s" helper timer,
 * a relative time ("11m" -> "12m") or one Working row's preview. Each rebuild threw away every node, so every spinner
 * and status pip restarted, entry animations replayed, loaded media re-decoded and a scrolled list or thread was put
 * back by hand. On a phone that reads as constant flicker (James, 23 Oct 2026). WosMorph keeps every node whose tag
 * and key still match and only edits the text and attributes that differ, so an unchanged row is never touched.
 *
 * morph(oldRoot, html, opts) -> true when it patched oldRoot in place (false: caller should fall back to innerHTML).
 *   html's first element must be the same tag and data-part as oldRoot.
 *   opts.keep(node, fresh) -> true leaves that live node and its subtree exactly as is (e.g. a focused composer field).
 * Keys: data-chopen, data-sec, data-morph-key, id. Keyed children are matched by key (rows can reorder);
 * unkeyed ones by position and tag. Form fields keep their live value. Every agent kind's Chats uses the same path.
 */
(() => {
  'use strict';
  const KEYS = ['data-chopen', 'data-sec', 'data-morph-key', 'id'];
  const keyOf = n => { if (n.nodeType !== 1) return null; for (const k of KEYS) { const v = n.getAttribute(k); if (v !== null && v !== '') return k + '=' + v; } return null; };
  const alike = (a, b) => a.nodeType === b.nodeType && a.nodeName === b.nodeName && keyOf(a) === keyOf(b);

  function syncAttrs(o, f) {
    for (const a of [...o.attributes]) if (!f.hasAttribute(a.name)) o.removeAttribute(a.name);
    for (const a of f.attributes) if (o.getAttribute(a.name) !== a.value) o.setAttribute(a.name, a.value);
  }
  function patch(o, f, opts) {
    if (o.nodeType !== 1) { if (o.nodeValue !== f.nodeValue) o.nodeValue = f.nodeValue; return; }
    if (opts.keep && opts.keep(o, f)) return;
    syncAttrs(o, f);
    // A field's live value is the owner's: the attribute/default text is only the first paint's value.
    if (o.nodeName === 'TEXTAREA' || o.nodeName === 'INPUT' || o.nodeName === 'SELECT') return;
    kids(o, f, opts);
  }
  function kids(op, fp, opts) {
    const byKey = new Map();
    for (let c = op.firstChild; c; c = c.nextSibling) { const k = keyOf(c); if (k && !byKey.has(k)) byKey.set(k, c); }
    let cur = op.firstChild;
    for (let f = fp.firstChild; f; f = f.nextSibling) {
      const k = keyOf(f);
      let m = null;
      if (k) { const c = byKey.get(k); if (c && c.nodeName === f.nodeName) { m = c; byKey.delete(k); } }
      else if (cur && alike(cur, f)) m = cur;
      else {
        // A removed unkeyed node (a day divider, a sync bar) must not shift every later node onto the wrong partner.
        let n = cur && cur.nextSibling, i = 0;
        while (n && i < 4 && !keyOf(n)) { if (alike(n, f)) { m = n; break; } n = n.nextSibling; i++; }
        if (m) while (cur !== m) { const nx = cur.nextSibling; if (!keyOf(cur)) cur.remove(); cur = nx; }
      }
      if (m) {
        if (m === cur) cur = cur.nextSibling; else op.insertBefore(m, cur);
        patch(m, f, opts);
      } else op.insertBefore(document.importNode(f, true), cur); // inert template node -> live (only new nodes load media)
    }
    while (cur) { const nx = cur.nextSibling; cur.remove(); cur = nx; }
    // A keyed node no fresh child claimed is gone, wherever it sits: the unkeyed look-ahead above steps over keyed
    // nodes, so one can be left before cur (a stale row kept beside its replacement, out of order; 23 Oct 2026).
    for (const c of byKey.values()) if (c.parentNode === op) c.remove();
  }
  function morph(oldRoot, html, opts = {}) {
    if (!oldRoot || !oldRoot.isConnected) return false;
    const tpl = document.createElement('template'); tpl.innerHTML = html;
    const fresh = tpl.content.firstElementChild;
    if (!fresh || fresh.nodeName !== oldRoot.nodeName || fresh.getAttribute('data-part') !== oldRoot.getAttribute('data-part')) return false;
    patch(oldRoot, fresh, opts);
    return true;
  }
  window.WosMorph = Object.freeze({ morph });
})();
