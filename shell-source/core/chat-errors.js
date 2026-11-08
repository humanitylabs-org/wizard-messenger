/* Wizard UX core: the Errors section's ways out (#12) and the failed-thread recovery (#11). Shared by every shell.
 *
 * Legacy endpoints (wizard-mobile ff86db8c api.ts / controller.ts):
 *   GET  /wizard/attention                         → { attention: [{ id, kind, thread_id, session_id, title, detail, failed_at, can_retry }] }
 *   POST /wizard/attention/:id/retry               → recovery of a failed background activity (only when can_retry)
 *   POST /wizard/attention/:id/dismiss             → remove it from the Errors list
 *   POST /wizard/session-failure/:id/dismiss       → clear a failed/interrupted thread's “Needs retry” (history kept)
 * Retrying a failed thread re-sends its last request through the durable outbox (retryServerFailedSession):
 * same thread, same model unless another one was picked.
 *
 *   WosErrors.load(force)     → Promise<items[]>  (cached 30 s)
 *   WosErrors.items           → attention items still shown
 *   WosErrors.retryAttention(id) / dismissAttention(id) → Promise<boolean>
 *   WosErrors.dismissFailure(sessionId)                 → Promise<boolean>
 *   WosErrors.dismissed(sessionId)                      → true while a dismissal is applied locally
 */
(() => {
  'use strict';
  const J = { 'Content-Type': 'application/json' };
  const post = async path => {
    const r = await fetch(path, { method: 'POST', cache: 'no-store', credentials: 'same-origin', headers: J, body: '{}' });
    if (!r.ok) throw Object.assign(new Error(`HTTP ${r.status}`), { status: r.status });
    return true;
  };
  function normalize(j) {
    return (Array.isArray(j?.attention) ? j.attention : []).map(v => {
      if (!v || typeof v !== 'object' || typeof v.id !== 'string' || !v.id) return null;
      const t = typeof v.failed_at === 'number' ? v.failed_at * 1000 : Date.parse(String(v.failed_at ?? ''));
      return { id: v.id, kind: String(v.kind || 'failed_activity'), sessionId: typeof v.session_id === 'string' ? v.session_id : '', threadId: typeof v.thread_id === 'string' ? v.thread_id : '',
        title: String(v.title || 'Wizard work needs attention'), detail: String(v.detail || ''), failedAt: isFinite(t) ? t : NaN, canRetry: v.can_retry === true };
    }).filter(Boolean);
  }
  const E = {
    items: [], ready: false, at: 0, loading: null, busy: new Map(), gone: new Set(), cleared: new Map(), listeners: new Set(),
    onChange(fn) { E.listeners.add(fn); return () => E.listeners.delete(fn); },
    emit() { for (const fn of E.listeners) { try { fn(); } catch (e) { console.error(e); } } },
    load(force) {
      if (E.loading) return E.loading;
      if (!force && E.ready && Date.now() - E.at < 30e3) return Promise.resolve(E.items);
      E.loading = fetch('/wizard/attention', { cache: 'no-store', credentials: 'same-origin' })
        .then(r => (r.ok ? r.json() : Promise.reject(new Error('HTTP ' + r.status))))
        .then(j => { const prev = JSON.stringify(E.items); E.items = normalize(j).filter(x => !E.gone.has(x.id)); E.ready = true; E.at = Date.now(); if (JSON.stringify(E.items) !== prev) E.emit(); return E.items; })
        .catch(() => E.items)
        .finally(() => { E.loading = null; });
      return E.loading;
    },
    normalize,
    async _attention(id, action) {
      const it = E.items.find(x => x.id === id); if (!it || E.busy.has(id)) return false;
      if (action === 'retry' && !it.canRetry) return false;
      E.busy.set(id, action); E.emit();
      try { await post(`/wizard/attention/${encodeURIComponent(id)}/${action}`); E.gone.add(id); E.items = E.items.filter(x => x.id !== id); return true; }
      catch (e) { return false; }
      finally { E.busy.delete(id); E.emit(); }
    },
    retryAttention(id) { return E._attention(id, 'retry'); },
    dismissAttention(id) { return E._attention(id, 'dismiss'); },
    async dismissFailure(sid) {
      if (!sid || E.busy.has(sid)) return false;
      E.busy.set(sid, 'dismiss'); E.emit();
      try { await post(`/wizard/session-failure/${encodeURIComponent(sid)}/dismiss`); E.cleared.set(sid, Date.now()); return true; }
      catch (e) { return false; }
      finally { E.busy.delete(sid); E.emit(); }
    },
    // A dismissed failure stays out of Errors until Wizard's list catches up (or two minutes pass).
    dismissed(sid) { const t = E.cleared.get(sid); if (!t) return false; if (Date.now() - t > 120e3) { E.cleared.delete(sid); return false; } return true; },
  };
  window.WosErrors = E;
})();
