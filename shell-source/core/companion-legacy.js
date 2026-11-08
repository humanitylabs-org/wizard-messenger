/* One-release wire adapter for the unchanged installed Video Editor.
 * No layout or lifetime implementation here: all operations use the shared host. */
(() => {
  'use strict';
  const HASH = /^#\/(?:project\/[a-z0-9-]+(?:\/clip\/[a-z0-9-]+(?:\/draft\/v\d+)?)?)?$/;
  const bindings = new WeakMap(), scopes = new WeakMap();
  function scope(source) {
    try {
      const doc = source.document, previous = scopes.get(source);
      if (previous?.doc === doc) return previous.svc;
      const svc = window.WizAppServices?.connect(source);
      if (svc) scopes.set(source, { doc, svc });
      return svc;
    } catch (_) { return null; }
  }
  addEventListener('wizard:companion-delivery', e => {
    const { frame, data } = e.detail || {};
    if (data?.type !== 'video-editor:bound') return;
    const svc = scope(frame?.contentWindow);
    if (svc?.appId === 'video-editor') frame.contentWindow.postMessage(data, location.origin);
  });
  addEventListener('message', e => {
    const d = e.data;
    if (e.origin !== location.origin || d?.type !== 'video-editor:desk' || typeof d.hash !== 'string' || !HASH.test(d.hash)) return;
    const svc = scope(e.source);
    if (svc?.appId !== 'video-editor') return;
    const time = Number.isFinite(d.time) ? Math.max(0, d.time) : 0;
    const bound = { type: 'video-editor:bound', hash: d.hash, time, focusComposer: !!d.focus };
    try {
      if (d.action === 'context') {
        if (d.clip && (!/^[a-z0-9-]{1,80}$/.test(d.project) || !/^[a-z0-9-]{1,80}$/.test(d.clip) || !/^v\d{1,4}$/.test(d.draft))) return;
        if (!d.clip) { bindings.delete(e.source); svc.shell.closeCompanion(); return; }
        svc.shell.openCompanion({ path: '/video-editor/?pane=feedback', title: 'Feedback', share: 0.26, ownerShare: 0.46, focus: !!d.focus, data: bound });
        bindings.set(e.source, bound);
      } else if (d.action === 'time') {
        const b = bindings.get(e.source); if (b) { b.time = time; b.focusComposer = false; svc.shell.postCompanion(b); }
      } else if (d.action === 'open-video') {
        if (svc.shell.focusApp()) svc.shell.postCompanion(bound);
      }
    } catch (_) { scopes.delete(e.source); /* malformed/stale legacy sender is ignored */ }
  });
})();
