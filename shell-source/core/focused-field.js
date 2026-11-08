/* Shared focused-field dictation. A seal is a DOM capability, never a selector to re-resolve.
 * Hosts admit registered, visible same-origin app documents; unregistered frames are not traversed.
 * No submit, routing or agent fallback belongs here. */
(() => {
  'use strict';
  function editable(node) {
    if (!node || node.nodeType !== 1 || !node.isConnected) return null;
    if (node.closest('[inert], [data-no-dictation], [aria-disabled="true"]')) return null;
    if (node.matches('textarea, input')) {
      // Only controls with an actual character selection API. Password/number/date/file are excluded.
      if (node.disabled || node.readOnly || (node.tagName === 'INPUT' && !['text', 'search', 'url', 'tel'].includes(node.type))) return null;
      return typeof node.selectionStart === 'number' ? node : null;
    }
    if (!node.isContentEditable) return null;
    let root = node;
    while (root.parentElement?.isContentEditable) root = root.parentElement;
    return root;
  }
  function deepActive(doc) {
    let el = doc.activeElement;
    while (el?.shadowRoot?.activeElement) el = el.shadowRoot.activeElement;
    return el;
  }
  function create({ document: topDoc = document, frames = () => [], admit = () => true, onChange = () => {}, controls = () => false } = {}) {
    const bound = new WeakSet(), versions = new WeakMap();
    let current = null;
    function context(doc) {
      if (doc === topDoc) return { doc, frame: null, href: doc.location.href, version: versions.get(doc) || 0 };
      for (const frame of frames()) {
        try { if (frame.isConnected && frame.contentDocument === doc && doc.location.origin === topDoc.location.origin) return { doc, frame, href: doc.location.href, version: versions.get(doc) || 0 }; } catch (_) {}
      }
      return null;
    }
    function validContext(c, el) {
      const now = context(c?.doc);
      return !!now && now.frame === c.frame && now.href === c.href && now.version === c.version && el?.ownerDocument === c.doc && el.isConnected && !!editable(el) && admit(c, el);
    }
    function active() {
      let el = deepActive(topDoc), doc = topDoc;
      if (el?.tagName === 'IFRAME') {
        if (!frames().includes(el)) return null;
        try { doc = el.contentDocument; el = deepActive(doc); } catch (_) { return null; }
      }
      const target = editable(el), c = target && context(doc);
      return c && validContext(c, target) ? { ...c, el: target } : null;
    }
    function refresh() {
      const a = active();
      // Keyboard activation of orb/recording controls must not lose the last focused field.
      const el = deepActive(topDoc);
      current = a || (controls(el) && current && validContext(current, current.el) ? current : null);
      onChange(current);
      return current;
    }
    function bind(doc) {
      if (!doc?.defaultView || bound.has(doc)) return;
      bound.add(doc); versions.set(doc, 0);
      doc.addEventListener('focusin', refresh, true);
      doc.addEventListener('focusout', () => queueMicrotask(refresh), true);
      // Composed paths see open shadow inputs even though document.activeElement is the host.
      doc.addEventListener('pointerup', () => queueMicrotask(refresh), true);
      const nav = () => { versions.set(doc, (versions.get(doc) || 0) + 1); refresh(); };
      doc.defaultView.addEventListener('pagehide', nav);
      doc.defaultView.addEventListener('popstate', nav);
      doc.defaultView.addEventListener('hashchange', nav);
      // Shell Back guard state changes do not navigate away from its focused field.
      // App documents still invalidate even for same-URL history changes (including ABA).
      doc.defaultView.navigation?.addEventListener('navigate', e => {
        if (doc === topDoc && e.destination?.url === doc.location.href && e.navigationType !== 'reload') return;
        nav();
      });
      new doc.defaultView.MutationObserver(() => { if (current?.doc === doc && !validContext(current, current.el)) refresh(); }).observe(doc, { childList: true, subtree: true, attributes: true, attributeFilter: ['readonly', 'disabled', 'inert', 'contenteditable'] });
    }
    function capture() {
      const a = refresh(); if (!a) return null;
      const el = a.el, seal = { ...a, value: el.matches('input, textarea') ? el.value : el.innerHTML, changed: false, released: false };
      const changed = () => { seal.changed = true; };
      el.addEventListener('input', changed);
      if (el.matches('input, textarea')) { seal.start = el.selectionStart; seal.end = el.selectionEnd; }
      else {
        const sel = a.doc.defaultView.getSelection();
        if (!sel?.rangeCount) { el.removeEventListener('input', changed); return null; }
        const range = sel.getRangeAt(0);
        if (!el.contains(range.startContainer) || !el.contains(range.endContainer)) { el.removeEventListener('input', changed); return null; }
        seal.range = range.cloneRange();
        seal.observer = new a.doc.defaultView.MutationObserver(changed);
        seal.observer.observe(el, { subtree: true, childList: true, characterData: true });
      }
      seal.release = () => { seal.released = true; seal.observer?.disconnect(); el.removeEventListener('input', changed); };
      return seal;
    }
    function insert(seal, text) {
      if (!seal || seal.released || !validContext(seal, seal.el)) return false;
      const el = seal.el, plain = el.matches('input, textarea');
      // Plain fields: the sealed node is still here, so the words always land in it. Android keyboards fire
      // input events on blur (finishing a composing word) without changing a character, so an input event
      // alone never vetoes the insert (James, 24 Oct 2026: tapped above a pasted draft, dictated, and got a
      // copy card instead of the words at the cursor). If the text really changed during the take, the words
      // go where the caret is now, like any keyboard's voice typing. Only a lost or navigated field falls back.
      if (!plain && (seal.changed || seal.observer?.takeRecords().length || el.innerHTML !== seal.value)) return false;
      if (!plain && (!el.contains(seal.range.startContainer) || !el.contains(seal.range.endContainer))) return false;
      // Release the mutation guard before our own input, and use the target document's constructors.
      seal.release();
      if (plain) {
        let start = seal.start, end = seal.end;
        if (el.value !== seal.value) { start = el.selectionStart ?? el.value.length; end = el.selectionEnd ?? start; }
        // Spoken words land as words: a space against a neighbouring character (typing at the end of a URL or word).
        const before = el.value.slice(0, start).slice(-1), after = el.value.slice(end, end + 1);
        let t = String(text);
        if (before && !/\s/.test(before) && /^[^\s.,;:!?)]/.test(t)) t = ' ' + t;
        if (after && !/\s/.test(after) && !/[\s(]$/.test(t)) t = t + ' ';
        el.setRangeText(t, start, end, 'end');
      }
      else {
        const r = seal.range; r.deleteContents();
        const node = seal.doc.createTextNode(String(text)); r.insertNode(node); r.setStartAfter(node); r.collapse(true);
        const selection = seal.doc.defaultView.getSelection(); selection.removeAllRanges(); selection.addRange(r);
      }
      el.dispatchEvent(new seal.doc.defaultView.InputEvent('input', { bubbles: true, composed: true, inputType: 'insertText', data: String(text) }));
      // Do not steal focus back from a different field while STT was running.
      refresh(); return true;
    }
    bind(topDoc);
    return { bind, refresh, capture, insert, get current() { return current; } };
  }
  window.WizCore = window.WizCore || {};
  window.WizCore.focusedField = { create, editable };
})();
