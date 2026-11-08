/* Shared pointer/keyboard action menu. Shells call back() first in their Back stack.
 * open({ anchor, x?, y?, label?, items: [{ label, action }] })
 * The selection/link menus own specialized selection/download gestures and are not
 * general action menus. Keep this primitive independent of desktop state. */
(() => {
  'use strict';
  let current = null;
  function close(restoreFocus = true) {
    if (!current) return false;
    const { panel, anchor, abort } = current; current = null;
    abort.abort(); panel.remove();
    // paintBar may replace the trigger while the menu is open.
    if (restoreFocus && anchor?.isConnected) anchor.focus({ preventScroll: true });
    return true;
  }
  function open({ anchor, x, y, label = 'Actions', items }) {
    close(false);
    const doc = anchor?.ownerDocument || document, win = doc.defaultView;
    const abort = new AbortController(), signal = abort.signal;
    const panel = doc.createElement('div'); panel.className = 'wos-context-menu';
    panel.setAttribute('role', 'menu'); panel.setAttribute('aria-label', label);
    for (const item of items) {
      const button = doc.createElement('button'); button.type = 'button';
      button.setAttribute('role', 'menuitem'); button.textContent = item.label;
      button.addEventListener('click', e => { e.preventDefault(); e.stopPropagation(); close(false); item.action(); });
      panel.appendChild(button);
    }
    doc.body.appendChild(panel); current = { panel, anchor, abort };
    const a = anchor?.getBoundingClientRect(), r = panel.getBoundingClientRect();
    if (!Number.isFinite(x) || !Number.isFinite(y)) { x = a?.left || 8; y = (a?.bottom || 8) + 6; }
    panel.style.left = Math.max(8, Math.min(x, win.innerWidth - r.width - 8)) + 'px';
    panel.style.top = Math.max(8, Math.min(y, win.innerHeight - r.height - 8)) + 'px';
    const buttons = [...panel.querySelectorAll('button')];
    panel.addEventListener('keydown', e => {
      // Escape belongs to the shell's existing Back stack, not a second handler.
      if (!['ArrowDown', 'ArrowUp', 'Home', 'End', 'Tab'].includes(e.key)) return;
      e.preventDefault(); e.stopPropagation();
      if (e.key === 'Tab') return close();
      const at = buttons.indexOf(doc.activeElement), n = buttons.length;
      const next = e.key === 'Home' ? 0 : e.key === 'End' ? n - 1 : (at + (e.key === 'ArrowUp' ? -1 : 1) + n) % n;
      buttons[next]?.focus({ preventScroll: true });
    }, { signal });
    doc.addEventListener('pointerdown', e => { if (!panel.contains(e.target)) close(false); }, { capture: true, signal });
    // A press inside a hosted frame blurs its parent window.
    win.addEventListener('blur', () => close(false), { signal });
    win.addEventListener('scroll', () => close(false), { capture: true, signal });
    win.addEventListener('resize', () => close(false), { signal });
    win.addEventListener('pagehide', () => close(false), { signal });
    buttons[0]?.focus({ preventScroll: true });
  }
  window.WosContextMenu = { open, back: () => close(), get isOpen() { return !!current; } };
})();
