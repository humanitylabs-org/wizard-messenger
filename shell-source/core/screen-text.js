/* What is on screen, as text, for the agent.
 * When James speaks or types, the shell's [Wizard OS context] note names the window in front. This adds the
 * words actually visible in that window (headings, labels, list rows, field values), read once at send time,
 * so "this", "here" and "that step" can be resolved without a screenshot.
 *
 *   WizScreen.read(el, max?) → 'Edit usual · Name: Kra pao · Steps · 1. tap Priority · Save' (or '')
 *
 * Only what intersects both the window and the viewport is read; hidden, aria-hidden and off-screen text is
 * skipped. Same-origin iframes (Wizard apps) are read through; cross-origin frames are left out. Password and
 * hidden inputs are never read. Bounded (default 1400 chars) so the note stays small. */
(function () {
  const SKIP = new Set(['SCRIPT', 'STYLE', 'NOSCRIPT', 'TEMPLATE', 'SVG', 'CANVAS', 'VIDEO', 'AUDIO', 'IMG']);
  const BLOCK = /^(P|DIV|LI|H[1-6]|SECTION|ARTICLE|HEADER|FOOTER|BUTTON|LABEL|TR|DT|DD|SUMMARY|FIGCAPTION|BLOCKQUOTE|PRE|NAV|ASIDE|MAIN|FORM|FIELDSET|LEGEND|OPTION|TD|TH)$/;

  function rectsMeet(a, b) { return a.width > 0 && a.height > 0 && a.right > b.left && a.left < b.right && a.bottom > b.top && a.top < b.bottom; }

  function shown(el, view) {
    const win = el.ownerDocument.defaultView;
    if (el.closest('[aria-hidden="true"],[hidden],[inert]')) return false;
    const cs = win.getComputedStyle(el);
    if (cs.display === 'none' || cs.visibility === 'hidden' || +cs.opacity === 0) return false;
    return rectsMeet(el.getBoundingClientRect(), view);
  }

  function fieldText(el) {
    const t = (el.type || '').toLowerCase();
    if (el.tagName === 'INPUT' && ['password', 'hidden', 'file'].includes(t)) return '';
    if (el.tagName === 'INPUT' && ['checkbox', 'radio'].includes(t)) return el.checked ? '[x]' : '[ ]';
    // The visible <label> text is read on its own; a field only adds its own aria-label/placeholder.
    const label = el.getAttribute('aria-label') || el.placeholder || '';
    const v = (el.tagName === 'SELECT' ? (el.selectedOptions?.[0]?.textContent || '') : (el.value || '')).split(/\n+/).map(x => x.trim()).filter(Boolean).join(' / ');
    return v ? (label && label !== v ? `${label}: ${v}` : v) : (label ? `${label}: (empty)` : '(empty field)');
  }

  function walk(root, view, out, budget) {
    const doc = root.ownerDocument || root;
    const tw = doc.createTreeWalker(root, NodeFilter.SHOW_ELEMENT | NodeFilter.SHOW_TEXT, {
      acceptNode(n) {
        if (n.nodeType === 1) {
          if (SKIP.has(n.tagName.toUpperCase())) return NodeFilter.FILTER_REJECT;
          if (n.closest && n.closest('[aria-hidden="true"],[hidden],[inert]')) return NodeFilter.FILTER_REJECT;
          // A private agent's thread rows/headers (unified Chats) never enter another agent's context.
          if (n.hasAttribute && n.hasAttribute('data-wiz-private')) return NodeFilter.FILTER_REJECT;
          return NodeFilter.FILTER_ACCEPT;
        }
        return /\S/.test(n.nodeValue) ? NodeFilter.FILTER_ACCEPT : NodeFilter.FILTER_SKIP;
      },
    });
    let line = '', seen = 0;
    const flush = () => { const s = line.replace(/\s+/g, ' ').trim(); if (s && out[out.length - 1] !== s) { out.push(s); budget.left -= s.length + 3; } line = ''; };
    for (let n = tw.nextNode(); n && budget.left > 0 && seen < 4000; n = tw.nextNode()) {
      seen++;
      if (n.nodeType === 1) {
        const tag = n.tagName.toUpperCase();
        if (BLOCK.test(tag)) flush();
        if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') { if (shown(n, view)) { flush(); line = fieldText(n); flush(); } continue; }
        if (tag === 'IFRAME') {
          let d = null; try { d = n.contentDocument; } catch (e) { d = null; }
          if (d && d.body && shown(n, view)) {
            flush();
            const r = n.getBoundingClientRect(), fv = d.defaultView;
            // The frame's own viewport, clipped by where the frame sits on screen.
            const inner = { left: Math.max(0, view.left - r.left), top: Math.max(0, view.top - r.top), right: Math.min(fv.innerWidth, view.right - r.left), bottom: Math.min(fv.innerHeight, view.bottom - r.top) };
            walk(d.body, inner, out, budget);
          }
          continue;
        }
        continue;
      }
      const p = n.parentElement; if (!p || !shown(p, view)) continue;
      line += ' ' + n.nodeValue;
    }
    flush();
  }

  function read(el, max = 1400) {
    try {
      if (!el) return '';
      const win = el.ownerDocument.defaultView;
      const r = el.getBoundingClientRect();
      const view = { left: Math.max(0, r.left), top: Math.max(0, r.top), right: Math.min(win.innerWidth, r.right), bottom: Math.min(win.innerHeight, r.bottom) };
      if (view.right <= view.left || view.bottom <= view.top) return '';
      const out = [], budget = { left: max };
      walk(el, view, out, budget);
      const s = out.join(' · ');
      return s.length > max ? s.slice(0, max - 1) + '…' : s;
    } catch (e) { return ''; }
  }

  window.WizScreen = { read };
})();
