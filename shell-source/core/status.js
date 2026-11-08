/* Wizard UX core: banners that sit above every screen, in both shells (feature/chat-polish).
 *
 *   Connection  "Offline — …" / "Reconnecting…" / "Back online" (2 s), from the browser's online state and
 *               from whether the last Wizard read worked (WizLive.error === 'offline').
 *   Critical    "N critical issues need attention · View" (opens Chats on the phone) for threads Wizard marked critical
 *               (attention_level === 'critical'), except ones already shown as errors and the thread in front.
 *   Fatal       "Wizard needs attention · <message> · Reload": the shell failed to start (an uncaught error and
 *               no shell API a few seconds after load), or a caller hands one over with WizCore.status.fatal().
 *
 * Loaded right after core/config.js so it can see boot errors. A shell plugs in with
 *   WizCore.status.attach({ openChats(), inboxOpen(), current() })     current() = the thread in front, or ''
 * Back: WizCore.status.back() closes the fatal card (Chats' closeOverlay asks it first), returns a step name or ''.
 */
(() => {
  'use strict';
  const C = window.WizCore = window.WizCore || {};
  const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const agent = () => { try { return window.WizConfig?.agent() || 'Wizard'; } catch (e) { return 'Wizard'; } };
  let netOpen = false;
  /* Connection trouble is only ever a small pill at the top, after a grace so a momentary blip shows nothing. The
   * checks open only when the owner taps the pill (or Troubleshoot); they never open by themselves, and a voice or
   * capture starting tucks them away again. (James, 1 Nov: an automatic pop-up for a short outage is too much.) */
  function captureBusy() {
    const shared = window.WizAppCapture?.getState?.();
    const voice = window.__wos?.voice || window.__wux?.voice;
    return !!(shared?.active || shared?.recording || shared?.hold || (voice && voice !== 'idle'));
  }
  function captureChanged(e) {
    if ((captureBusy() || (e?.detail?.state && e.detail.state !== 'idle')) && offOpen) dismissOffline(false);
  }
  addEventListener('click', e => {
    if (offOpen && !e.target?.closest?.('#wxOffline .wx-off-card')) dismissOffline();
  }, true);
  addEventListener('wizard-app-capture-state', captureChanged);
  addEventListener('wizard-voice-state', captureChanged);
  // A slow server flaps for a few seconds at a time and heals itself: wait longer before saying anything. A device
  // that reports itself offline is certain, so it keeps the short wait.
  const graceMs = () => (navigator.onLine === false ? 3000 : 8000);
  let netAlerted = false; // An online hint cannot retract feedback already shown in this outage.
  let offReturn = null, downSince = 0, graceT = 0, offDismissed = false, offOpen = false, offChecks = null, offBusy = false, offT = 0, offN = 0, offHappy = 0;
  let H = {}, net = navigator.onLine === false ? 'offline' : 'online', restoredT = 0, critHidden = '', fatalMsg = '', fatalOpen = false;
  if (net === 'offline') downSince = Date.now(); // the device said offline at boot: the grace runs from now (render re-checks)
  const log = s => { window.__statusLog = (window.__statusLog || []).concat(s).slice(-40); };

  /* ---------- boot errors → fatal card ---------- */
  const bootErrors = [];
  addEventListener('error', e => { if (!shellUp()) bootErrors.push(String(e.message || e.error || 'Script error')); }, true);
  addEventListener('unhandledrejection', e => { if (!shellUp()) bootErrors.push(String(e.reason?.message || e.reason || 'Promise rejected')); });
  let bootAttached = false, bootFatal = false, bootTimer = 0, bootLimit = 0;
  function shellUp() { return bootAttached || !!(window.__wos || window.__wux); }
  function checkBoot(expired = false) {
    if (shellUp() || document.documentElement.dataset.leaving) return;
    // Slow bootstrap/preferences are not a device failure. Only a real script
    // error uses the short watchdog; a missing shell gets a full 15 seconds.
    if (!expired && !bootErrors.length) return;
    // A boot error is most often a phone mixing cached files from two releases: reload once to fetch one matching
    // set before showing the card (Robert's iPhone, 24 Oct 2026). Once per minute per tab, so a real bug can't loop.
    if (bootErrors.length) try {
      const k = 'wos.bootReloadAt', t = +sessionStorage.getItem(k) || 0;
      if (Date.now() - t > 60e3) { sessionStorage.setItem(k, String(Date.now())); log('fatal:auto-reload'); location.reload(); return; }
    } catch (e) {}
    bootFatal = true;
    fatal(bootErrors.length ? `${agent()} couldn’t start on this device: ${bootErrors[0].replace(/^Uncaught\s+/, '').slice(0, 160)}` : `${agent()} is taking longer to open. Reload if it stays here.`);
  }
  addEventListener('load', () => {
    bootTimer = setTimeout(() => checkBoot(), 2500);
    bootLimit = setTimeout(() => checkBoot(true), 15000);
  });

  /* ---------- DOM ---------- */
  function host() { return document.getElementById('device') || document.body; }
  function box() {
    let el = document.getElementById('wxBanners');
    if (!el) { el = document.createElement('div'); el.id = 'wxBanners'; el.className = 'wx-banners'; host().appendChild(el); el.addEventListener('click', onClick); }
    return el;
  }
  function onClick(e) {
    if (e.target.closest('[data-wxoffopen]')) { openOffline(); return; }
    if (e.target.closest('[data-wxtroubleshoot]')) { window.WizReach?.open(); return; }
    if (e.target.closest('[data-wxmore]')) { netOpen = !netOpen; log('net:' + (netOpen ? 'open' : 'fold')); unfold(); return; }
    if (e.target.closest('[data-wxretry]')) { window.WosOutbox?.retryAll(); verifyWizard(true); LIVE()?.refresh(); return; }
    if (e.target.closest('[data-wxcrit-x]')) { critHidden = critSig(); log('critical:dismiss'); render(); return; }
    if (e.target.closest('[data-wxcrit]')) { log('critical:open'); H.openChats?.(); render(); }
  }
  function unfold() {
    const b = document.querySelector?.('#wxBanners .wx-banner.net'); if (!b?.classList) return;
    b.classList.toggle('open', netOpen); b.querySelector('[data-wxmore]')?.setAttribute('aria-expanded', String(netOpen));
  }
  const LIVE = () => window.WizLive || null;

  /* ---------- connection state ---------- */
  function setNet(n) {
    if (n === net || (n === 'online' && net === 'restored')) return;
    const was = net; clearTimeout(restoredT);
    // Coming back from offline/reconnecting says so for 2 s, then the banner goes; a blip nobody was told about
    // (shorter than the grace) comes back silently.
    if (n === 'online' && (was === 'offline' || was === 'reconnecting') && alerted()) {
      n = 'restored';
      restoredT = setTimeout(() => { if (net === 'restored') { net = 'online'; log('net:online'); render(); } }, 2000);
    }
    net = n; log('net:' + n);
    const down = n === 'offline' || n === 'reconnecting';
    if (down && !downSince) { downSince = Date.now(); clearTimeout(graceT); graceT = setTimeout(() => { graceT = 0; render(); }, graceMs() + 50); }
    if (!down) { downSince = 0; netAlerted = false; clearTimeout(graceT); graceT = 0; offDismissed = false; if (offOpen) recovered(); }
    render();
  }
  const alerted = () => downSince && (netAlerted || (netAlerted = Date.now() - downSince >= graceMs()));
  // Browser connectivity is a hint: Android/VPN networks can report offline while
  // Wizard is reachable. Only fresh evidence may overrule an offline event:
  // a new successful live read, or a healthy same-origin Wizard status probe.
  let offlineReadAt = 0, evidenceGeneration = 0, liveEvidenceAt = 0, verifying = null, verifyAgain = false, verifiedAt = 0, probedGeneration = -1;
  function verifyWizard(force = false) {
    if (verifying) { if (force) verifyAgain = true; return verifying; }
    verifiedAt = Date.now();
    const generation = evidenceGeneration;
    verifying = (async () => {
      // AbortController + timer, not AbortSignal.timeout: iOS 16.0-16.3 WebViews lack it.
      const ctl = typeof AbortController === 'function' ? new AbortController() : null;
      const timer = ctl ? setTimeout(() => ctl.abort(), 5000) : 0;
      try {
        const r = await fetch('/troubleshoot/api/status?source=connection-banner', { cache: 'no-store', credentials: 'same-origin', signal: ctl?.signal });
        const body = r.ok ? await r.json() : null;
        // Remember which evidence this probe beat, so later non-network emits keep it.
        if (body?.overall === 'ok' && generation === evidenceGeneration) { probedGeneration = generation; log('net:verified'); setNet('online'); return true; }
      } catch (e) {} finally { if (timer) clearTimeout(timer); }
      return false;
    })().finally(() => {
      verifying = null;
      if (verifyAgain) { verifyAgain = false; verifyWizard(); }
    });
    return verifying;
  }
  function fromLive() {
    const L = LIVE(); if (!L) return;
    // A failed read leaves L.at alone, so failures carry their own errorAt: any new live
    // result (success or failure) invalidates a Wizard probe that started before it.
    const liveAt = Math.max(L.at || 0, L.errorAt || 0);
    if (liveAt && liveAt !== liveEvidenceAt) { liveEvidenceAt = liveAt; evidenceGeneration++; }
    if (L.ok && !L.error && L.at > offlineReadAt) return setNet('online');
    // A healthy probe stands until a newer offline event or live result moves the generation.
    if (probedGeneration === evidenceGeneration) return setNet('online');
    if (navigator.onLine === false) return setNet('offline');
    if (L.error) { if (net !== 'offline' || navigator.onLine) setNet('reconnecting'); return; }
  }
  addEventListener('offline', () => {
    const L = LIVE(); offlineReadAt = L?.at || 0; evidenceGeneration++;
    setNet('offline');
    // Verify against Wizard itself, even if the browser never emits 'online'.
    verifyWizard(); L?.refresh();
  });
  addEventListener('online', () => { setNet('reconnecting'); const L = LIVE(); if (L) L.refresh(); else setNet('online'); });

  /* ---------- critical issues (legacy attention.ts) ---------- */
  const ERR = new Set(['failed', 'interrupted']);
  function criticals() {
    const L = LIVE(); if (!L?.ok) return [];
    const cur = H.current?.() || '';
    return L.sessions.filter(s => s.critical && !s.hidden && !s.archived && !ERR.has(s.status) && s.id !== cur);
  }
  const critSig = () => criticals().map(s => s.id).sort().join(',');

  /* ---------- render ---------- */
  let lastHtml = '';
  function render() {
    const parts = [];
    // This is connection feedback, not a second outbox. A saved message may wait on
    // upload, device storage or admission while chat reads work. Chats keeps its
    // delivery card and Retry; only failed connection evidence raises this banner.
    if (!(net === 'offline' || net === 'reconnecting')) netOpen = false;
    if ((net === 'offline' || net === 'reconnecting') && alerted()) {
      if (captureBusy()) captureChanged();
      // Tucked away: one small pill that says what still works. Tapping it brings the checks back.
      if (!offOpen) {
        const kind = net === 'offline' ? 'offline' : 'reconnecting';
        const diagnosis = window.WizReach?.failure();
        const full = diagnosis?.message || 'Checking the connection to Wizard. Messages are kept on this device while we retry.';
        // The same request-neutral words every read surface uses (WizReach.label); a device that is simply offline
        // also says what still happens to what you write.
        const short = String(window.WizReach?.label?.('read', { diagnosis }) || diagnosis?.short || 'Reconnecting…').replace(/ · retrying$/, '');
        parts.push(`<div class="wx-banner net ${kind}" role="status" title="${esc(full)}" data-wxnet="${kind}"><span class="wx-row"><span class="wx-spin" aria-hidden="true"></span><button type="button" class="wx-s" data-wxoffopen aria-label="${esc(short)}. Show connection checks">${esc(short)}</button></span></div>`);
      }
    }
    else if (net === 'restored' && !offHappy) parts.push(`<div class="wx-banner net restored" role="status" data-wxnet="restored"><span class="wx-i">✓</span><span class="wx-m">Back online</span></div>`);
    const crit = criticals(), sig = crit.map(s => s.id).sort().join(',');
    if (crit.length && sig !== critHidden && !H.inboxOpen?.()) {
      const n = crit.length;
      const detail = `Tap to see ${n === 1 ? 'the critical issue' : 'the critical issues'}.`;
      parts.push(`<div class="wx-banner crit" role="alert" data-wxcritbox><button class="wx-crit" data-wxcrit title="${esc(detail)}" aria-label="${n} critical ${n === 1 ? 'issue needs' : 'issues need'} attention. ${esc(detail)}"><span class="wx-i">!</span><span class="wx-m">${n} critical ${n === 1 ? 'issue needs' : 'issues need'} attention<small> · ${esc(detail)}</small></span><span class="wx-go" aria-hidden="true">View ›</span></button><button class="wx-x" data-wxcrit-x aria-label="Hide until something changes">×</button></div>`);
    }
    const html = parts.join('');
    if (html === lastHtml && document.getElementById('wxBanners')) return;
    lastHtml = html;
    const el = box(); el.innerHTML = html; el.hidden = !html; unfold();
    // The unfolded diagnosis floats over the screen; only the one-line pill makes room.
    document.documentElement.style?.setProperty('--wx-banner-height', `${Math.ceil((el.getBoundingClientRect?.().height || 28) - (el.querySelector?.('.wx-banner.net.open .wx-m')?.getBoundingClientRect?.().height || 0)) + 10}px`);
    document.getElementById('device')?.classList.toggle('wx-on', !!html);
    document.documentElement.classList.toggle('wx-banner-on', !!html);
  }

  /* ---------- offline pop-up ---------- */
  const ROWS = [['internet', 'Internet'], ['tailscale', 'Tailscale'], ['wizard', 'Wizard']];
  const STATE_WORD = { ok: 'OK', slow: 'Slow', bad: 'Problem', wait: 'Waiting', skip: 'Skipped', run: 'Checking' };
  function offEl() {
    let el = document.getElementById('wxOffline');
    if (!el) {
      el = document.createElement('div'); el.id = 'wxOffline'; el.className = 'wx-off'; el.hidden = true;
      el.setAttribute('role', 'dialog'); el.setAttribute('aria-modal', 'false'); el.setAttribute('aria-labelledby', 'wxOffT');
      (document.body || document.documentElement).appendChild(el);
      el.addEventListener('click', e => {
        if (e.target.closest?.('[data-wxoffx]')) { dismissOffline(); return; }
        if (e.target.closest?.('[data-wxoffcheck]')) { offN = 0; window.WosOutbox?.retryAll?.(); verifyWizard(true); LIVE()?.refresh(); runChecks(); return; }
        if (e.target.closest?.('[data-wxoffhelp]')) { dismissOffline(); window.WizReach?.open(); }
      });
      el.addEventListener('keydown', e => { if (e.key === 'Escape') { e.stopPropagation?.(); dismissOffline(); } });
    }
    return el;
  }
  // The first check that failed decides the one next step; the rest wait behind it.
  function fixFor(c) {
    if (!c) return '';
    if (c.internet?.state === 'bad') return 'Turn off airplane mode, or join Wi‑Fi or mobile data.';
    if (c.tailscale?.state === 'bad') return c.tailnet
      ? 'Open the Tailscale app and turn it on, signed in to the same account as your Wizard. If it’s already on, the computer running your Wizard may be off or asleep.'
      : 'Check this device can reach your Wizard’s address, and that the computer running it is on.';
    if (c.wizard?.state === 'slow') return 'Your Wizard is busy and answering slowly. Messages are kept on this device and send by themselves.';
    if (c.wizard?.state === 'bad') return 'Your Wizard is reachable but not answering properly. It usually recovers on its own within a minute.';
    if (c.internet?.state === 'slow' || c.tailscale?.state === 'slow') return 'The connection is working, just slow. Things will take longer to load.';
    return '';
  }
  // Built only from the shared kit (kit/controls.css): .wz-card panel, .wz-list/.wz-row rows, .wz-pill states,
  // .wz-actions/.wz-button, .wz-icon-button. The skin colours and shapes all of it; polish.css only positions it.
  const PILL = { ok: 'ok', slow: 'warn', bad: 'error', wait: 'off', skip: 'off', run: 'off' };
  // Calm card (off by default; tweak miguel/calm-offline sets --wos-calm-offline: on): one dotted path instead of
  // rows and pills, one short next step with its detail muted, a small Check again with the automatic re-check time.
  const calmOn = () => { try { return getComputedStyle(document.documentElement).getPropertyValue('--wos-calm-offline').trim() === 'on'; } catch (_) { return false; } };
  function calmFix(c) {
    if (!c) return ['', ''];
    if (c.internet?.state === 'bad') return ['Turn on Wi‑Fi or mobile data.', 'Or turn off airplane mode.'];
    if (c.tailscale?.state === 'bad') return c.tailnet
      ? ['Turn on Tailscale on this device.', 'If it’s already on, your Wizard’s computer may be off or asleep.']
      : ['Check this device can reach your Wizard’s address.', 'The computer running it may be off or asleep.'];
    if (c.wizard?.state === 'slow') return ['Your Wizard is busy.', 'Messages send by themselves.'];
    if (c.wizard?.state === 'bad') return ['Your Wizard isn’t answering properly.', 'It usually recovers within a minute.'];
    if (c.internet?.state === 'slow' || c.tailscale?.state === 'slow') return ['Connected, just slow.', ''];
    return ['', ''];
  }
  let offNextAt = 0, offTick = 0;
  const nextText = () => { const s = Math.max(0, Math.ceil((offNextAt - Date.now()) / 1000)); return offBusy ? 'Checking…' : offNextAt && s ? `Checking again in ${s} s` : ''; };
  function tickNext() {
    clearInterval(offTick); offTick = 0;
    if (!offOpen || offHappy || !calmOn()) return;
    offTick = setInterval(() => { const n = document.querySelector?.('#wxOffline [data-wxoffnext]'); if (!offOpen || !n) { clearInterval(offTick); offTick = 0; return; } n.textContent = nextText(); }, 1000);
  }
  function calmCard(c, happy) {
    const offlineDevice = navigator.onLine === false || c?.internet?.state === 'bad';
    const title = happy ? 'Back online' : offlineDevice ? 'You’re offline' : 'Can’t reach your Wizard';
    const step = ([key, label]) => {
      const st = happy ? 'ok' : c?.[key]?.state || 'run';
      const name = key === 'tailscale' && c && !c.tailnet ? 'Network' : label;
      const word = STATE_WORD[st] || '';
      return `<li class="wx-step ${st}" data-wxck="${key}" title="${esc(happy ? 'Working' : c?.[key]?.detail || word)}"><i aria-hidden="true"></i><span>${esc(name)}</span><span class="wx-sr"> · ${esc(word)}</span></li>`;
    };
    const [fix, more] = happy ? ['', ''] : calmFix(c);
    const canHelp = !happy && c && c.tailscale?.state !== 'bad' && c.internet?.state !== 'bad' && c.tailscale?.state !== 'wait';
    return `<div class="wz-card wx-off-card wx-calm" tabindex="-1"><button type="button" class="wz-icon-button ghost wx-off-x" data-wxoffx aria-label="Hide. Keep using saved chats">×</button>`
      + `<h2 id="wxOffT">${esc(title)}</h2>`
      + `<ol class="wx-path" aria-label="Connection checks">${ROWS.map(step).join('')}</ol>`
      + (fix ? `<p class="wx-fix" role="status">${esc(fix)}${more ? `<small>${esc(more)}</small>` : ''}</p>` : '')
      + (happy ? '' : `<div class="wx-calm-act"><button type="button" class="wx-link" data-wxoffcheck${offBusy ? ' disabled' : ''}>Check again</button>${canHelp ? '<button type="button" class="wx-link" data-wxoffhelp>More help</button>' : ''}<span class="wx-next" data-wxoffnext aria-live="off">${esc(nextText())}</span></div>`)
      + (happy ? '' : `<p class="wx-calm-note">Messages wait here and send when you’re back.</p>`)
      + `</div>`;
  }
  function renderOffline() {
    const el = offEl(); if (!offOpen) { el.hidden = true; return; }
    if (calmOn()) {
      const inside = el.contains?.(document.activeElement);
      const cardFocused = inside && document.activeElement?.classList?.contains?.('wx-calm');
      const had = inside ? [...(document.activeElement?.attributes || [])].map(a => a.name).find(n => n.startsWith('data-wxoff')) : '';
      el.innerHTML = calmCard(offChecks, !!offHappy); el.hidden = false;
      if (cardFocused || had) ((had && el.querySelector?.(`[${had}]:not([disabled])`)) || el.querySelector?.('.wx-calm'))?.focus?.();
      tickNext(); return;
    }
    const c = offChecks, happy = !!offHappy;
    const row = (key, label) => {
      const r = happy ? { state: 'ok', detail: 'Working' } : c?.[key] || { state: 'run', detail: 'Checking…' };
      const name = key === 'tailscale' && c && !c.tailnet ? 'Your Wizard’s network' : label;
      return `<li class="wz-row wx-ck ${r.state}" data-wxck="${key}"><span class="wz-main"><b>${esc(name)}</b><small>${esc(r.detail)}</small></span><span class="wz-pill ${PILL[r.state] || 'off'}">${STATE_WORD[r.state] || ''}</span></li>`;
    };
    const title = happy ? 'Back online' : 'Can’t reach your Wizard';
    const fix = happy ? '' : c?.help || fixFor(c);
    const canHelp = !happy;
    const had = el.contains?.(document.activeElement) ? [...(document.activeElement?.attributes || [])].map(a => a.name).find(n => n.startsWith('data-wxoff')) : '';
    el.innerHTML = `<div class="wz-card wx-off-card"><button type="button" class="wz-icon-button ghost wx-off-x" data-wxoffx aria-label="Hide. Keep using saved chats">×</button>`
      + `<h2 id="wxOffT">${esc(title)}</h2>`
      + `<p class="wx-off-sub">${happy ? 'Everything is connected again.' : 'Chats saved on this device still open. New messages wait here and send by themselves when you’re back.'}</p>`
      + `<ul class="wz-list">${ROWS.map(([k, l]) => row(k, l)).join('')}</ul>`
      + (fix ? `<p class="wx-off-sub" role="status">${esc(fix)}</p>` : '')
      + (happy ? '' : `<div class="wz-actions"><button type="button" class="wz-button" data-wxoffcheck${offBusy ? ' disabled' : ''}>${offBusy ? 'Checking…' : 'Check again'}</button>${canHelp ? '<button type="button" class="wz-button secondary" data-wxoffhelp>Open Troubleshooter</button>' : ''}</div>`)
      + `</div>`;
    el.hidden = false;
    // A re-check re-renders the card: keep keyboard focus on the same control (or the close button if it went).
    if (had) (el.querySelector?.(`[${had}]:not([disabled])`) || el.querySelector?.('[data-wxoffx]'))?.focus?.();
  }
  async function runChecks() {
    if (offBusy || !offOpen || !window.WizReach?.checks) return;
    offBusy = true; clearTimeout(offT); renderOffline();
    try { const c = await window.WizReach.checks(); if (!c.stale) offChecks = c; log('off:checked'); } catch (_) {}
    offBusy = false;
    if (!offOpen) return;
    const ok = offChecks && ['internet', 'tailscale', 'wizard'].every(k => ['ok', 'slow', 'skip'].includes(offChecks[k]?.state));
    if (ok) { verifyWizard(true); LIVE()?.refresh(); }
    renderOffline();
    // Re-check while it stays open and in front, backing off: 5 s, 8 s, 13 s … up to 30 s.
    const wait = Math.min(30000, 5000 * 1.6 ** offN++); offNextAt = Date.now() + wait;
    offT = setTimeout(() => { if (!document.hidden) runChecks(); else offT = setTimeout(runChecks, 5000); }, wait);
    if (calmOn()) renderOffline();
  }
  function openOffline() {
    if (captureBusy()) { captureChanged(); return; }
    offDismissed = false;
    if (offOpen) return;
    offOpen = true; offN = 0; offHappy = 0; log('off:open');
    renderOffline(); runChecks(); render();
    // Focus moves into the dialog on a control that is always enabled ("Check again" is busy while checks run).
    offReturn = document.activeElement || null;
    setTimeout(() => { if (offOpen && !captureBusy()) (calmOn() && document.querySelector?.('#wxOffline .wx-calm') || document.querySelector?.('#wxOffline [data-wxoffx]'))?.focus?.(); }, 0);
  }
  function dismissOffline(restoreFocus = true) {
    if (!offOpen) return false;
    offOpen = false; offDismissed = !!downSince; clearTimeout(offT); log('off:hide');
    renderOffline(); render();
    try { if (restoreFocus) offReturn?.focus?.(); } catch (_) {} offReturn = null; // back to where the owner was
    return true;
  }
  // Recovery: every row turns green for a moment, then the pop-up goes by itself.
  function recovered() {
    if (!offOpen || offHappy) return;
    offHappy = setTimeout(() => { offHappy = 0; offOpen = false; offChecks = null; clearTimeout(offT); renderOffline(); }, 1200);
    clearTimeout(offT); renderOffline();
  }

  /* ---------- fatal card ---------- */
  function fatal(message) {
    fatalMsg = String(message || 'Something went wrong.'); fatalOpen = true; log('fatal');
    let el = document.getElementById('wxFatal');
    if (!el) {
      el = document.createElement('div'); el.id = 'wxFatal'; el.className = 'wx-fatal'; el.setAttribute('role', 'alertdialog'); el.setAttribute('aria-modal', 'true'); el.setAttribute('aria-labelledby', 'wxFatalT');
      (document.body || document.documentElement).appendChild(el);
      el.addEventListener('click', e => {
        if (e.target.closest('[data-wxreload]')) { log('fatal:reload'); location.reload(); }
        if (e.target.closest('[data-wxfatal-x]')) closeFatal();
      });
    }
    el.innerHTML = `<div class="wx-fcard"><div class="wx-fi" aria-hidden="true">!</div><b id="wxFatalT">${esc(agent())} needs attention</b><p>${esc(fatalMsg)}</p><p class="wx-fnote">Your drafts and unsent messages are saved on this device.</p><button class="wx-reload" data-wxreload>Reload</button><button class="wx-fx" data-wxfatal-x>Not now</button></div>`;
    el.hidden = false; setTimeout(() => el.querySelector('[data-wxreload]')?.focus(), 0);
  }
  function closeFatal() { const el = document.getElementById('wxFatal'); if (!el || el.hidden) return false; el.hidden = true; fatalOpen = false; log('fatal:close'); return true; }

  C.status = {
    attach(h) { bootAttached = true; clearTimeout(bootTimer); clearTimeout(bootLimit); if (bootFatal) { closeFatal(); bootFatal = false; } H = Object.assign({}, H, h || {}); fromLive(); render(); if (net === 'offline' || net === 'reconnecting') verifyWizard(); const L = LIVE(); if (L && !L.__wxStatus) { L.__wxStatus = true; L.onChange(() => { fromLive(); render(); }); } const O = window.WosOutbox; if (O && !O.__wxStatus) { O.__wxStatus = true; O.onChange(render); } },
    refresh() { fromLive(); render(); },
    fatal, back: () => (closeFatal() ? 'fatal' : dismissOffline() ? 'offline' : ''),
    get state() { return { net, offline: offOpen ? 'open' : alerted() ? 'pill' : '', critical: criticals().map(s => s.id), fatal: fatalOpen ? fatalMsg : '' }; },
  };
  // Cheap catch-all for things with no event (the thread in front changed, the inbox opened or closed).
  addEventListener('wizreachchange', render);
  // Troubleshoot from any button while nothing of the Wizard answers (outside the phone app): unfold what to check.
  addEventListener('wizreachexplain', () => window.WizReach?.open());
  addEventListener('resize', () => { lastHtml = ''; render(); });
  setInterval(() => {
    if (document.hidden || !document.getElementById('wxBanners')) return;
    render();
    if ((net === 'offline' || net === 'reconnecting') && Date.now() - verifiedAt >= 5000) verifyWizard();
  }, 1200);
})();
