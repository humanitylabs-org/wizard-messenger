/* Desktop Escape-as-back: one press, one owner. No navigation at an empty root.
 * Owners push on open and release on close; watched legacy owners join the same
 * recency order. Recording is always first; a focused surface is always last. */
(() => {
  'use strict';
  function create() {
    let clock = 0;
    const entries = new Set();
    function push(back, { active = () => true, name = 'overlay' } = {}) {
      sync(); // an older legacy owner may have opened in this same event frame
      const entry = { back, active, name, at: ++clock, token: true };
      entries.add(entry);
      return () => entries.delete(entry);
    }
    function watch(active, back, name) {
      const entry = { active, back, name, at: 0, token: null, watched: true };
      entries.add(entry);
      return () => entries.delete(entry);
    }
    function sync() {
      for (const e of entries) if (e.watched) {
        const token = e.active() || null;
        if (token && token !== e.token) e.at = ++clock;
        e.token = token;
      }
    }
    function run({ recording, surface, fallback, event, outside = false } = {}) {
      if (event?.isComposing || event?.keyCode === 229 || event?.repeat) return 'held';
      const take = recording?.(); if (take) return typeof take === 'string' ? take : 'voice-cancel';
      sync();
      const top = [...entries].filter(e => e.watched ? e.token : e.active()).sort((a, b) => b.at - a.at)[0];
      // A layer may be waiting for an asynchronous stop/close. Never fall through
      // to a second owner just because its callback returned false or a promise.
      if (top) { if (!top.watched) entries.delete(top); const did = top.back({ outside }); return typeof did === 'string' && did ? did : top.name; }
      if (surface?.()) return 'surface';
      return fallback?.() || '';
    }
    return Object.freeze({ push, watch, sync, run, names: () => [...entries].map(e => e.name) });
  }
  // ONE catalog for phone history/CloseWatcher/native Back and desktop Escape.
  // Modules own their state and action; shells supply only mounted adapters.
  function installOwners(stack, h) {
    const W = window, add = (name, active, back) => stack.watch(active, back, name);
    add('welcome', () => W.WosWelcome?.active, () => W.WosWelcome.back());
    add('orb-picker', () => W.WosOrbSwitcher?.sheetOpen || W.WosOrbSwitcher?.isOpen, () => { const r=W.WosOrbSwitcher.back(); return r ? 'orb-'+r : ''; });
    add('share-wizard', () => W.WizShareWizard?.isOpen, () => W.WizShareWizard.back());
    add('pin-sheet', () => W.WizHomeScreenApps?.state?.open, () => W.WizHomeScreenApps.back());
    add('tour', () => W.WosTour?.helpOpen || W.WosTour?.desk?.active || (W.WosTour?.active && W.WosTour.step !== W.WosTour.REPLY), () => { const t=W.WosTour, r=t.desk?.active ? (t.desk.finish('skip'), 'tour') : t.back(); h.afterTour?.(); return r; });
    add('share', () => W.WosShareSheet?.isOpen?.(), () => W.WosShareSheet.back());
    add('selection', () => W.WosSelMenu?.state?.open, () => W.WosSelMenu.back());
    add('context', () => W.WosContextMenu?.isOpen, () => W.WosContextMenu.back());
    add('route', () => W.WosAppRoute?.isOpen?.(), () => W.WosAppRoute.back());
    add('setup', () => W.WosAppSetup?.isOpen?.(), () => W.WosAppSetup.back());
    add('reminder', () => W.WosBoomerang?.isOpen?.(), () => W.WosBoomerang.back());
    add('viewer', () => h.chats().KIT?.viewer?.isOpen(), () => h.chats().KIT.viewer.close());
    add('viewer-menu', () => h.chats().KIT?.viewer?.state?.menu, () => h.chats().KIT.viewer.close());
    add('link-menu', () => W.WizLinks?.isMenuOpen?.(), () => W.WizLinks.backMenu());
    add('links', () => h.links()?.isOpen(), () => h.links().back());
    h.chats().registerBack?.(stack, h.afterChat);
    add('status', () => W.WizCore?.status?.state?.fatal || W.WizCore?.status?.state?.offline === 'open', () => W.WizCore.status.back());
    add('device', () => W.WosDevice?.sheet, () => W.WosDevice.back());
    add('update-list', () => W.WizWebUpdate?._state?.()?.listOpen, () => W.WizWebUpdate.back());
    add('resources', () => W.WosResources?.state?.panel, () => W.WosResources.back());
    // Layout api.back.push is registered into this same stack by both shells.
    // One observer sees openings, never a polling timer or delayed click action.
    const observer = new MutationObserver(() => stack.sync());
    observer.observe(document.documentElement, { subtree:true, childList:true, attributes:true, attributeFilter:['hidden','class','style','open'] });
    queueMicrotask(() => stack.sync()); // shell mount finishes before reading adapters
    return () => observer.disconnect();
  }
  window.WizEscapeBack = Object.freeze({ create, installOwners });
})();
