/* Wizard OS · "Interface update" banner, shared by both shells (James, 14 Oct: "if I ask for a change on mobile,
 * the same change should reflect on desktop in a way that fits that form factor").
 *
 * Words (Miguel, 27 Oct 2026): this is the Interface, never "Wizard OS" (that name means the box's own 10–20 minute
 * update, core/os-updates.js). An interface update is already here; Reload is all it takes.
 * Owns everything about a web/ update: noticing it (ux-version.txt, the git tree id of web/), naming the
 * thread(s) that made it (ux-changes.json), the banner with Thread / Threads ▾ beside Reload, Back/Esc folding
 * the list, and the guarded reload. A shell supplies only the host: where the banner mounts, how to open a
 * thread, when a reload is unsafe, what to save first. Layout lives in each shell's CSS (#dvWeb):
 * phone = glass strip under the status bar, desktop = pill in the top bar. Reloads only when tapped; a tap
 * made while a recording would be lost waits for that recording to end (see reload()). */
(() => {
  'use strict';
  const BASE = new URL('../', document.currentScript.src);
  const url = p => new URL(p, BASE).href;
  const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  let H = null; // host
  function burst() {
    if (document.querySelector('.wos-burst')) return;
    const el = document.createElement('div'); el.className = 'wos-burst'; el.setAttribute('role', 'status'); el.setAttribute('aria-live', 'polite');
    const sparks = Array.from({ length: 72 }, (_, i) => { const a = (i / 72) * 360 + (i * 7 % 5), d = 45 + (i * 37 % 40), w = 2 + (i % 4), h = 22 + (i * 13 % 40); return `<i style="--a:${a}deg;--d:${d}vmax;--t:${(i * 53 % 9) * 18}ms;--w:${w}px;--h:${h}px"></i>`; }).join('');
    el.innerHTML = `<b class="wb-flash"></b><b class="wb-ring"></b><b class="wb-ring two"></b><b class="wb-ring three"></b><span class="wb-sparks">${sparks}</span><span class="wb-core"></span><span class="wb-text">Reloading<em>.</em><em>.</em><em>.</em></span>`;
    document.body.appendChild(el);
  }
  const log = (...a) => { try { H?.log?.(...a); } catch (_) {} };

  /* What changed is read from ux-version.txt, rewritten by the repo's commit/merge/checkout hooks
   * (tools/write-ux-version.sh), so any committed web change flips it. The Agent Service sends no
   * ETag/Last-Modified, so without the version file fall back to headers over every script and stylesheet the
   * page actually loaded (James, 11 Oct). */
  const assets = () => {
    const base = BASE.href, page = location.pathname.split('/').pop() || 'index.html', out = new Set([page]);
    document.querySelectorAll('script[src], link[rel="stylesheet"][href]').forEach(el => {
      const u = new URL(el.getAttribute('src') || el.getAttribute('href'), location.href);
      if (u.origin === location.origin && u.href.startsWith(base) && !/(^|\/)(data|summaries)\.js$/.test(u.pathname)) out.add(u.pathname.slice(BASE.pathname.length));
    });
    return [...out];
  };
  let print0 = '', printNow = '', pending = false, lastCheck = 0, changes = [], listOpen = false;
  const loadedAt = Date.now();
  async function fingerprint() {
    try {
      const r = await fetch(url('ux-version.txt'), { cache: 'no-store', credentials: 'same-origin' });
      const v = r.ok ? (await r.text()).trim() : '';
      if (/^[0-9a-f]{7,64}$/i.test(v)) return 'v:' + v;
    } catch (e) { return ''; }
    const parts = await Promise.all(assets().map(async a => {
      try {
        // GET (some proxies mishandle HEAD); only the headers are read, the body is dropped unread.
        const r = await fetch(url(a), { cache: 'no-store', credentials: 'same-origin' });
        try { r.body?.cancel(); } catch (e) {}
        if (!r.ok) return a + ':' + r.status;
        const lm = r.headers.get('last-modified') || '', et = r.headers.get('etag') || '', len = r.headers.get('content-length') || '';
        return a + ':' + (et || lm + '/' + len);
      } catch (e) { return null; }
    }));
    return parts.includes(null) ? '' : parts.join('|');
  }
  // Keeps checking while the banner is up, so a second deploy adds its thread to the banner too.
  async function check(force) {
    if ((!force && Date.now() - lastCheck < 60e3) || !navigator.onLine) return;
    lastCheck = Date.now();
    const p = await fingerprint(); if (!p) return;
    if (!print0) { print0 = printNow = p; window.WosSettings?.refresh(); return; }
    if (p === print0 || p === printNow) return;
    printNow = p;
    if (!pending) { pending = true; log('web:changed'); }
    await loadChanges(); window.WizAppServices?.update.announce({ version: p, changes }); render();
    try { window.WosUpdates?.popup?.(); } catch (_) {}
  }
  /* Which threads made the update: ux-changes.json lists every web/ change newest first with the thread that
   * committed it. Take the ones since the version this page loaded; one row per thread. */
  async function loadChanges() {
    if (!print0.startsWith('v:')) { changes = []; return; }
    try {
      const r = await fetch(url('ux-changes.json'), { cache: 'no-store', credentials: 'same-origin' });
      const d = r.ok ? await r.json() : null; const ups = Array.isArray(d?.updates) ? d.updates : [];
      const mine = print0.slice(2); let since = [];
      const k = ups.findIndex(u => u.before === mine);
      if (k >= 0) since = ups.slice(0, k + 1);
      else since = ups.filter(u => u.at * 1000 > loadedAt - 60e3).slice(0, 8);
      if (!since.length && ups[0]) since = [ups[0]];
      const out = [], seen = new Map();
      for (const u of since) for (const c of u.changes || []) {
        const key = c.thread || 'c:' + c.sha;
        if (seen.has(key)) continue;
        const row = { thread: c.thread || null, title: c.title || '', what: c.what || '' }; seen.set(key, row); out.push(row);
      }
      changes = out.slice(0, 8);
    } catch (e) { changes = []; }
  }
  // "Wizard OS · Bound views" → "Bound views": the banner already says what updated.
  const shortTitle = t => { const s = String(t || '').trim(); const i = s.indexOf(' · '); return (i > 0 && i < 24 ? s.slice(i + 3) : s) || ''; };
  const rowName = c => shortTitle(c.title) || c.what || 'A change';
  function goThread(id) {
    listOpen = false; render();
    if (!id) return;
    log('web:thread'); try { H?.openThread?.(id); } catch (_) {}
  }
  /* Reload safety (James, 18 Oct: "every time I try to reload it says please finish the recording first").
   * The host says when its own work is in flight (voice, a sheet, uploads); app services say which app holds
   * and recorders are in play. A native meeting (Android foreground service) keeps recording through a reload
   * and Mizel reattaches to it, so it no longer blocks. A recording that lives in this page (browser mic) or a
   * save in progress turns Reload into "Reload when recording ends": the reload then happens by itself, once,
   * right after the recording stops and saves. Nothing else ever reloads on its own. */
  function hostBusy() { try { return !!H?.busy?.(); } catch (_) { return true; } }
  function plan() {
    const svc = window.WizAppServices?.update;
    let p = null;
    try { p = svc?.reloadPlan?.() || null; } catch (_) { p = { ok: false, keeps: null, blocking: [{ kind: 'capture', reason: 'capture_custody_uncertain' }], recording: false }; }
    if (!p) { const b = !!svc?.busy?.(); p = { ok: !b, keeps: null, blocking: b ? [{ kind: 'work' }] : [], recording: false }; }
    return { ...p, host: hostBusy() };
  }
  function busy() { const p = plan(); return p.host || !p.ok; }
  function audioFreeReload(p) {
    // Never waive app-owned holds (including capture-labelled saves), native survival
    // preparation, or positive live-capture truth. Only durable-recovery uncertainty.
    if (p.host || p.keeps || !Array.isArray(p.blocking) || p.blocking.some(b =>
      b.source !== 'capture' || b.kind !== 'capture' ||
      !['capture_custody_uncertain', 'native_owner_uncertain'].includes(b.reason))) return false;
    try { return window.WizAppCapture?.pageAudioFree?.() === true; } catch (_) { return false; }
  }
  const reloadAllowed = p => !p.host && (p.ok || audioFreeReload(p));
  let armed = null, going = false, checking = false, armTimer = 0, notice = '', rescuing = false, discardId = '';
  let appCatalog = null;
  function appName(id) {
    // Cache before constructing registries: construction emits wizard:apps. Never recurse from a render.
    if (!appCatalog && window.WizCore?.apps) {
      appCatalog = [];
      appCatalog = ['mobile', 'desktop'].flatMap(kind => window.WizCore.apps(kind).APPS || []);
    }
    return appCatalog?.find(a => a.id === id)?.name || (id ? 'An app' : 'Recorder');
  }
  function reloadStatus() {
    const p = plan(), takes = window.WizAppCapture?.staleTakes?.() || [];
    const take = !p.ok ? takes.find(t => p.blocking?.some(b => b.kind === 'capture' && (!b.appId || b.appId === t.appId))) : null;
    let reason = notice;

    if (!reason && take) {
      const date = Number.isFinite(take.startedAt) ? new Date(take.startedAt).toLocaleDateString(undefined, { day: 'numeric', month: 'short' }) : 'an earlier session';
      reason = appName(take.appId) + ' has an unsent recording from ' + date + '.';
    }
    if (!reason && p.host) reason = 'Wizard is sending audio or saving your work.';
    if (!reason && !p.ok) {
      const b = p.blocking?.[0];
      reason = p.capture?.waitForEnd ? appName(b?.appId || p.capture?.appId) + ' is recording.' :
        /sending/i.test(b?.reason || '') ? appName(b.appId) + ' is sending.' :
        /saving|task save/i.test(b?.reason || '') ? appName(b.appId) + ' is saving.' :
        b?.kind === 'work' && !/voice|audio/i.test(b.reason || '') ? appName(b.appId) + ' has unsaved work.' :
        appName(b?.appId || p.capture?.appId) + ' has a voice note that isn’t sent yet.';
    }
    return { reason, take, rescuing, discardId, checking, going, armed: !!armed };
  }
  function rescueHtml(namespace = 'web') {
    const s = reloadStatus(); if (!s.take) return '';
    const attr = namespace === 'osu' ? 'data-osu' : 'data-web-rescue';
    const prefix = namespace === 'osu' ? 'rescue-' : '';
    return `<div class="wos-reload-rescue"><button type="button" ${attr}="${prefix}save" ${s.rescuing ? 'disabled' : ''}>Save to Files and clear</button><button type="button" ${attr}="${prefix}discard" ${s.rescuing ? 'disabled' : ''}>${s.discardId === s.take.id ? 'Confirm discard' : 'Discard'}</button></div>`;
  }
  function repaint() { render(); try { window.WosUpdates?.popup?.(); window.WosSettings?.refresh?.(); } catch (_) {} }
  function blocked(message) { notice = message || ''; repaint(); }
  async function rescue(action) {
    if (rescuing || going || checking) return;
    const take = reloadStatus().take; if (!take) return;
    if (action === 'discard' && discardId !== take.id) {
      discardId = take.id; blocked('Discard this recording permanently? Tap Confirm discard. Save to Files keeps your audio.'); return;
    }
    rescuing = true; discardId = ''; notice = action === 'save' ? 'Saving every audio part to Files… The original is kept until Files confirms it.' : 'Clearing the recording you chose to discard…'; repaint();
    try {
      await window.WizAppCapture.rescueTake(take.id, action, action === 'discard');
      notice = ''; rescuing = false; repaint(); reload('tap');
    } catch (e) {
      rescuing = false;
      log('web:rescue-failed', e?.code || 'RECOVERY_SAVE');
      blocked(e?.code === 'empty_audio' ? 'Couldn’t read this recording. Nothing was cleared.' :
        e?.code === 'capture_active' || e?.code === 'native_owner_uncertain' ? 'Recorder has audio that isn’t saved yet.' :
        'Couldn’t save this recording. Your audio is still kept.');
    }
  }
  // A wait worth arming: a recording/save that will end on its own, or app work beside a meeting that survives.
  // Never armed while the meeting's microphone is lent to the orb: that voice message ends by itself, but its
  // send follows straight after, and a reload mid-send is exactly what this guard is for.
  const loan = p => (p.blocking || []).some(b => b.reason === 'microphone_loan');
  // Otherwise arm only for a recording, or for the kept meeting app's own quick save (its notes); another app's
  // unsaved work is never a reason to reload on its own later.
  const waitForEnd = p => !loan(p) && (p.capture?.waitForEnd === true ||
    (p.capture?.safe === true && !!p.keeps && (p.blocking || []).every(b => b.appId === p.keeps.appId)));
  const armable = p => !p.host && waitForEnd(p);
  function arm(p) {
    armed = { at: Date.now(), recording: p.recording };
    log('web:reload-armed', p.recording ? 'recording' : 'saving');
    H?.toast?.('◌', p.recording ? 'Reloads when the recording ends' : 'Reloads as soon as it’s saved', 2200);
    clearInterval(armTimer); armTimer = setInterval(maybeFire, 1000); // host busy (voice, uploads) has no event
    render();
  }
  function disarm(why) { if (!armed) return; armed = null; clearInterval(armTimer); armTimer = 0; log('web:reload-disarmed', why || ''); render(); }
  function maybeFire() {
    if (!armed || going) return;
    const p = plan();
    if (Date.now() - armed.at >= 110000) { disarm('wait expired'); blocked('The update is still waiting. ' + (reloadStatus().reason || 'Save your work, then tap Reload again.')); return; }
    if (loan(p) || (p.capture?.safe !== true && p.capture?.waitForEnd !== true)) { disarm('custody changed'); return; }
    if (p.host || !p.ok) { if (!!p.recording !== armed.recording) { armed.recording = !!p.recording; render(); } return; }
    disarm('ready'); void go('deferred', p);
  }
  async function go(why, p) {
    if (going) return false; going = true; notice = '';
    try {
    // A tapped reload bursts across the screen and says "Reloading..." until the new build paints, so the
    // tap visibly worked instead of the banner looking frozen (every skin).
    if (why === 'tap') { burst(); await new Promise(r => setTimeout(r, 900)); }
    const current = plan();
    if (!reloadAllowed(current)) {
      going = false; document.querySelector('.wos-burst')?.remove(); render();
      blocked(''); H?.toast?.('◌', reloadStatus().reason || 'Couldn’t reload. Try again.', 2500); return false;
    }
    const sameKept = p => !!current.keeps === !!p.keeps && ['appId','id','meetingId'].every(k => current.keeps?.[k] === p.keeps?.[k]);
    if (current.keeps) {
      log('web:reload-keeps', current.keeps.appId);
      try { await deadline(Promise.resolve().then(() => window.WizAppServices?.update.prepareReload?.(current)), 3500); }
      catch (_) {
        going = false; document.querySelector('.wos-burst')?.remove(); render();
        log('web:reload-blocked', 'RELOAD_PREPARE');
        blocked('Recorder has audio that isn’t saved yet.'); return false;
      }
    }
    // Check after the animation AND asynchronous native backup flush, not merely at the original tap.
    const final = plan();
    if (!reloadAllowed(final) || !sameKept(final)) {
      going = false; document.querySelector('.wos-burst')?.remove(); render();
      blocked(''); H?.toast?.('◌', reloadStatus().reason || 'Couldn’t reload. Try again.', 2500); return false;
    }
    try { H?.beforeReload?.(); } catch (_) {}
    window.WizAppReadingPosition?.flush();
    // Host persistence hooks may synchronously expose work too. No frame was removed yet.
    const committed = plan();
    if (!reloadAllowed(committed) || !sameKept(committed)) {
      going = false; document.querySelector('.wos-burst')?.remove(); render();
      blocked(''); H?.toast?.('◌', reloadStatus().reason || 'Couldn’t reload. Try again.', 2500); return false;
    }
    if (audioFreeReload(committed) && window.WizAppCapture?.cancelReloadRecovery?.() !== true) {
      going = false; document.querySelector('.wos-burst')?.remove();
      blocked('Reload paused: a recorder started. Stop and save it first. Nothing was discarded.'); return false;
    }
    window.WizAppServices?.update.commitReload?.(committed);
    log('web:reload', why); window.__wosReloading = why; location.reload();
    setTimeout(() => { going = false; document.querySelector('.wos-burst')?.remove(); log('web:reload-blocked', 'RELOAD_NAVIGATION'); blocked('Couldn’t reload. Try again.'); }, 4500);
    return true;
    } catch (_) { going = false; document.querySelector('.wos-burst')?.remove(); log('web:reload-blocked', 'RELOAD_FAILED'); blocked('Couldn’t reload. Try again.'); return false; }
  }
  function deadline(work, ms) { let t; return Promise.race([work, new Promise((_, reject) => { t = setTimeout(() => reject(Error('Timed out')), ms); })]).finally(() => clearTimeout(t)); }
  function reload(why, checked = false, draftsChecked = false) {
    if (going || checking || rescuing) return false;
    notice = ''; discardId = '';
    if (armed && why === 'tap') { disarm('tap'); H?.toast?.('◌', 'Reload cancelled', 1400); return false; }
    const p = plan();
    if (!draftsChecked && why === 'tap' && p.blocking?.some(b => b.keepable) && window.WizAppServices?.update.keepDrafts) {
      checking = true; repaint();
      deadline(Promise.resolve().then(() => window.WizAppServices.update.keepDrafts()), 1700).catch(() => log('web:reload-blocked', 'DRAFT_KEEP_TIMEOUT')).finally(() => { checking = false; reload(why, checked, true); });
      return false;
    }
    // A reload cannot lose rows already in IndexedDB. Do not wait on that same
    // broken store when this page positively holds no audio and no app holds work.
    if (audioFreeReload(p)) { void go(why, p); return true; }
    // Only a user-requested reload refreshes abandoned ownership. Never stop a recorder or expire a hold.
    // Paint in the click task, then re-use capture's lock/recovery path and judge the whole plan again.
    if (!checked && why === 'tap' && !p.host && p.capture?.recheck && window.WizAppCapture?.reconcileReload) {
      checking = true; repaint();
      let timer;
      const failed = () => {
        clearTimeout(timer); checking = false;
        const current = plan();
        if (audioFreeReload(current)) { void go(why, current); return; }
        blocked(''); const reason = reloadStatus().reason;
        log('web:reload-blocked', 'RECOVERY_TIMEOUT');
        blocked(reason || 'Recorder has audio that isn’t saved yet.');
      };
      Promise.race([
        Promise.resolve().then(() => window.WizAppCapture.reconcileReload()),
        new Promise((_, reject) => { timer = setTimeout(() => reject(Error('Recorder check timed out')), 4500); })
      ]).then(check => {
        // Recovery can resolve with unknown custody instead of rejecting. That is not consent to wait
        // for some future recording to end, nor may a later native state event consume this failed tap.
        if (check?.safe !== true && check?.waitForEnd !== true) { failed(); return; }
        clearTimeout(timer); checking = false; render(); reload(why, true);
      }, failed);
      return false;
    }
    if (!p.host && p.ok) { void go(why, p); return true; }
    if (armable(p)) { arm(p); return false; }
    blocked('');
    H?.toast?.('◌', reloadStatus().reason, 2000); return false;
  }
  /* The banner says which thread the update came from and links there, so you can see what a reload brings
   * (James, 12 Oct): "Update ready / Bound views  [Thread] [Reload]". Several threads: "[Threads ▾]" opens a
   * short list; Back/Esc closes the list. Nothing known (no change list): "Interface updated". */
  function render() {
    if (!pending || !H) return;
    // The Home update pop-up (core/os-updates.js) carries this reload while it shows, and after its ×: one, not two.
    if (window.WosUpdates?.ownsReload?.()) { document.getElementById('dvWeb')?.remove(); listOpen = false; return; }
    let el = document.getElementById('dvWeb');
    if (!el) {
      el = document.createElement('div'); el.id = 'dvWeb'; el.className = 'dv-update web'; el.setAttribute('role', 'status');
      el.dataset.shell = H.shell || '';
      const at = H.mount?.() || document.body; H.prepend ? at.prepend(el) : at.appendChild(el);
      el.addEventListener('click', e => {
        const rescueButton = e.target.closest('[data-web-rescue]'); if (rescueButton) { void rescue(rescueButton.dataset.webRescue); return; }
        if (e.target.closest('[data-web="go"]')) { reload('tap'); return; }
        const t = e.target.closest('[data-web-thread]'); if (t) { goThread(t.dataset.webThread); return; }
        if (e.target.closest('[data-web="list"]')) { listOpen = !listOpen; log('web:list', listOpen ? 'open' : 'close'); render(); }
      });
    }
    const linked = changes.filter(c => c.thread), names = changes.map(rowName);
    // Desktop has no toast near the card: say it in place. Armed = Reload was tapped and waits for the end.
    const wait = armed ? (armed.recording ? 'Interface update · reloads after the recording' : 'Interface update · reloads once saved')
      : H.shell === 'desktop' && busy() ? 'Interface update · finish recording first' : '';
    const held = !!wait && (H.shell === 'desktop' || !!armed);
    const head = held ? wait : 'Interface update';
    // Two lines so the thread name gets the width: "Interface update" small, the thread it came from bold.
    const msg = !changes.length ? (held ? wait : 'Interface updated')
      : `<small>${esc(head)}</small><b>${esc(names[0])}</b>`;
    const sec = !linked.length ? '' : changes.length === 1
      ? `<button class="later dv-wt" data-web-thread="${esc(linked[0].thread)}" aria-label="Open the thread: ${esc(names[0])}" title="Open the thread that made this update">Thread</button>`
      : `<button class="later dv-wt" data-web="list" aria-expanded="${listOpen}" aria-label="Show the ${changes.length} threads in this update">Threads${listOpen ? ' ▴' : ' ▾'}</button>`;
    const list = listOpen && changes.length > 1 ? `<div class="dv-wl" role="list">${changes.map(c => c.thread
      ? `<button class="dv-wr" role="listitem" data-web-thread="${esc(c.thread)}"><b>${esc(rowName(c))}</b>${c.title && c.what ? `<small>${esc(c.what)}</small>` : ''}<span class="dv-wgo">›</span></button>`
      : `<div class="dv-wr static" role="listitem"><b>${esc(rowName(c))}</b><small>No thread</small></div>`).join('')}</div>` : '';
    el.classList.toggle('open', !!list);
    const mark = changes.length ? '' : `<span class="dv-ui">${window.WizBrand?.html || '✦'}</span>`;
    el.innerHTML = `<div class="dv-wtop">${mark}<span class="dv-um${changes.length ? ' two' : ''}">${changes.length ? msg : esc(msg)}</span>${sec}${checking ? '<button data-web="go" disabled aria-busy="true">Getting ready…</button>' : armed ? `<button data-web="go" class="armed" aria-pressed="true" title="Tap to cancel the waiting reload">${armed.recording ? 'Reload when recording ends' : 'Reload when saved'}</button>` : '<button data-web="go" title="Reload into the new interface">Reload</button>'}</div>${reloadStatus().reason ? `<div class="wos-reload-detail"><p class="wos-reload-reason">${esc(reloadStatus().reason)}</p>${rescueHtml()}</div>` : ''}${list}`;
  }
  // Back (phone) / Esc (desktop): fold an open thread list first. Returns true when it took the press.
  function back() { if (listOpen && pending) { listOpen = false; render(); return true; } return false; }

  let polling = false;
  function init(host) {
    H = host || {};
    if (pending) render();
    if (polling) return;
    polling = true;
    setTimeout(() => check(true), 1500);
    setInterval(() => { if (!document.hidden) check(false); }, 60e3); // one tiny text file a minute
    document.addEventListener('visibilitychange', () => { if (!document.hidden) check(false); });
    addEventListener('wos-native-resume', () => check(false));
    addEventListener('wizard:app-holds', () => { if (armed) maybeFire(); if (pending) render(); });
    addEventListener('wizard-app-capture-state', () => { if (armed) maybeFire(); if (pending) repaint(); });
  }
  window.WizWebUpdate = Object.freeze({
    init, check, back, reload, busy, render, plan, reloadStatus, rescue, rescueHtml,
    get armed() { return !!armed; },
    get pending() { return pending; },
    get version() { return printNow; },
    // First successful version-file observation; not a stamp of the document's loaded code.
    get firstObservedVersion() { return print0.startsWith('v:') ? print0.slice(2) : ''; },
    _state: () => ({ pending, print0: !!print0, changes, listOpen }),
  });
  // Older name used by hosted-app QA and the app services layer.
  window.WizAppUpdates = Object.freeze({ check: () => check(true), busy });
})();
