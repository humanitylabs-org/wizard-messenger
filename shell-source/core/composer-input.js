/* WizComposerInput — the one implementation of what a person expects from any chat box's input, shared by
 * Chats (shell) and every app with its own human-messaging composer (apps reach it only as WizardApp.composer).
 * It owns: file paste (generic "image.png" renamed pasted-<time>.png), text paste inserted from the paste
 * event's own snapshot, the empty-paste hint, file drag highlight + drop, and the Enter policy.
 * It never reads the clipboard, never uploads and never stores: what to do with files is the caller's onFiles.
 *
 * Why text paste is handled here: dictation apps (Wispr Flow, Superwhisper, MacWhisper) paste with a synthetic
 * Cmd+V and restore the old clipboard straight after; Chrome's default paste re-reads the system clipboard, so
 * on a busy page a long take vanished (Novaire, 21 Oct 2026; wizard-ux #243).
 * Enter policy (one rule, everywhere): with a hardware keyboard Enter sends and Shift+Enter is a new line; touch
 * keyboards keep Enter = new line; Ctrl/Cmd+Enter always sends; IME composition is never interrupted.
 * The zone gets the class `is-file-drag` while files hover over it; each app styles that class with its tokens. */
(() => {
  'use strict';
  if (window.WizComposerInput) return;
  const files = dt => {
    const items = [...(dt?.items || [])].filter(it => it.kind === 'file').map(it => it.getAsFile()).filter(Boolean);
    return items.length ? items : [...(dt?.files || [])];
  };
  const hasFiles = dt => !!dt && ([...(dt.items || [])].some(it => it.kind === 'file') || [...(dt.types || [])].includes('Files') || (dt.files?.length || 0) > 0);
  const stamp = () => new Date().toISOString().slice(0, 19).replace(/[:T]/g, '-');
  // Screenshots arrive as "image.png" (or unnamed); give them a name a person can tell apart later.
  const named = list => list.map((f, i) => f.name && f.name !== 'image.png' ? f
    : new File([f], `pasted-${stamp()}${list.length > 1 ? '-' + (i + 1) : ''}.${(String(f.type).split('/')[1] || 'png').replace('jpeg', 'jpg')}`, { type: f.type }));
  const isMac = () => /Mac|iP(hone|ad)/.test(navigator.platform || navigator.userAgent);
  const EMPTY_PASTE = () => `Paste arrived empty · Wispr Flow: ${isMac() ? '⌃⌘V' : 'Alt+Shift+Z'} pastes your last take`;

  // Insert text at the caret as a paste would: execCommand keeps native undo; setRangeText is the fallback and
  // dispatches the same input event so draft savers and autosize listeners run on both paths.
  function insertText(field, text) {
    if (!field || text == null) return false;
    text = String(text).replace(/\r\n?/g, '\n');
    const doc = field.ownerDocument || document;
    if (doc.activeElement !== field) field.focus({ preventScroll: true });
    const before = field.value;
    let ok = false; try { ok = doc.execCommand('insertText', false, text); } catch (_) {}
    if (!ok || field.value === before) {
      const a = field.selectionStart ?? field.value.length, b = field.selectionEnd ?? a;
      field.setRangeText(text, a, b, 'end');
      field.dispatchEvent(new (doc.defaultView || window).InputEvent('input', { bubbles: true, inputType: 'insertFromPaste', data: text }));
    }
    return true;
  }

  // A Ctrl/Cmd+Enter or hardware-keyboard Enter that should send.
  function isSendKey(e) {
    return e.key === 'Enter' && !e.isComposing && e.keyCode !== 229 && !e.shiftKey
      && (e.metaKey || e.ctrlKey || !matchMedia('(pointer: coarse)').matches);
  }

  // Delegated on a stable root, so composers that re-render keep working. field/zone are selectors matched with
  // closest() (or elements). Returns unbind().
  function bind(root, opts = {}) {
    if (!root?.addEventListener) throw new TypeError('WizComposerInput.bind needs a root element');
    const match = (t, sel) => !t || !sel ? null : typeof sel === 'string' ? t.closest?.(sel) || null : sel.contains?.(t) ? sel : null;
    const fieldOf = t => { const f = match(t, opts.field || 'textarea'); return f && (f.tagName === 'TEXTAREA' || f.tagName === 'INPUT' || f.isContentEditable) ? f : null; };
    const zoneOf = t => match(t, opts.zone) || fieldOf(t)?.form || null;
    const fieldIn = zone => typeof opts.field === 'string' ? zone?.querySelector(opts.field) : opts.field || zone?.querySelector('textarea');
    const notice = typeof opts.notice === 'function' ? opts.notice : () => {};
    const submit = typeof opts.onSubmit === 'function' ? opts.onSubmit : f => f.form?.requestSubmit();
    const give = (list, field) => { if (typeof opts.onFiles === 'function') opts.onFiles(named(list), field); };

    const onPaste = e => {
      const field = fieldOf(e.target); if (!field) return;
      const got = files(e.clipboardData);
      if (got.length) { e.preventDefault(); give(got, field); return; }
      let text = ''; try { text = e.clipboardData?.getData('text/plain') || ''; } catch (_) {}
      if (text) { e.preventDefault(); insertText(field, text); return; }
      // Empty paste: the dictation app restored its clipboard before the page saw the words. Nothing on the page
      // can recover them; say how to get the take back instead of failing silently.
      const before = field.value;
      setTimeout(() => { if (field.isConnected && field.value === before && field.ownerDocument.activeElement === field) notice(EMPTY_PASTE()); }, 400);
    };
    // File drags over the zone are always claimed (otherwise the browser navigates to the dropped file); text and
    // link drags keep their normal behaviour.
    const onOver = e => {
      const zone = zoneOf(e.target); if (!zone || !hasFiles(e.dataTransfer)) return;
      e.preventDefault(); if (e.dataTransfer) e.dataTransfer.dropEffect = 'copy';
      zone.classList.add('is-file-drag');
    };
    const onLeave = e => {
      const zone = zoneOf(e.target); if (!zone || (e.relatedTarget && zone.contains(e.relatedTarget))) return;
      zone.classList.remove('is-file-drag');
    };
    const onDrop = e => {
      const zone = zoneOf(e.target); if (!zone || !hasFiles(e.dataTransfer)) return;
      e.preventDefault(); zone.classList.remove('is-file-drag');
      const got = files(e.dataTransfer); if (got.length) give(got, fieldOf(e.target) || fieldIn(zone));
    };
    const onKey = e => {
      if (e.defaultPrevented || !isSendKey(e)) return;
      const field = fieldOf(e.target); if (!field || field.tagName === 'INPUT') return;
      e.preventDefault(); submit(field, e);
    };
    const on = [['paste', onPaste], ['dragover', onOver], ['dragleave', onLeave], ['drop', onDrop], ['keydown', onKey]];
    for (const [t, fn] of on) root.addEventListener(t, fn);
    return () => { for (const [t, fn] of on) root.removeEventListener(t, fn); };
  }

  window.WizComposerInput = Object.freeze({ bind, insertText, isSendKey, emptyPasteNotice: EMPTY_PASTE });
})();
