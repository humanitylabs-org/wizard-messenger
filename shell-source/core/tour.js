/* Wizard OS first run: a two-beat tour on the live shell with the real microphone, plus the Help sheet.
 * James, 11 Oct 2026: practise the real thing. The tour never fakes what the user said; it tells them what
 * to do, the real shell does it, and the tour watches the shell's events (app.js tourEv) to move on.
 *
 *   1 Talk     tap the orb, say hello, tap again: a real message to the Wizard (a real first thread)
 *   2 Reply    open Chats, read the Wizard's answer, type a reply: moves on only when a typed reply really sends
 *   3 Done     what this server is and what apps add (Miguel's approved end card)
 * Every beat shows "Step N of 3". Miguel, 26 Oct 2026: the Hide (swipe the orb down) and Install (Add to Home
 * Screen) beats are gone; installing is explained in the chat message that hands over the link.
 *
 * Miguel, 24 Oct 2026: the old beat 2 (hold the orb and say "Open Calendar") is gone: it didn't work reliably and
 * a first run doesn't need it. Commands stay in the Help sheet. Each beat has "Skip this step" (moves to the next
 * beat) beside the top-right "Skip tour" (ends the whole tour), so skipping is no longer all or nothing.
 *
 * No mic (denied, or none here): the shell's own "tap a line" chips appear and count. Two empty takes in a row:
 * a "Type instead" path appears (beat 1: a text box that sends for real). Wrong gesture (a hold, swipe up, desk
 * swipe): the shell's result is undone and the tour nudges. Back steps back (at beat 1 it skips the tour).
 * Re-entry: say "help", or Settings → Gestures & help → Practice again.
 * Desktop (WosTour.desk, below): the Talk beat only, as a card on a New chat's composer; Keys sheet → Practice.
 * Spec settled with Claude Fable: context/sources/projects/wizard-os/claude-transcripts/2026-10-11-tour-v2-*.
 */
(() => {
  'use strict';
  const KEY = 'wos.tour.v1';
  let H = null, el = null, step = 0, helpEl = null, timers = [];
  let misses = 0, typed = false, inbox = false, busy = false;
  const $ = (s, r = document) => r.querySelector(s);
  const esc = s => String(s == null ? '' : s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const later = (fn, ms) => { const t = setTimeout(fn, ms); timers.push(t); return t; };
  const clearTimers = () => { timers.forEach(clearTimeout); timers = []; };
  const done = () => { try { return JSON.parse(localStorage.getItem(KEY) || 'false'); } catch (e) { return false; } };
  const mark = () => { try { localStorage.setItem(KEY, 'true'); localStorage.setItem('wos.coached', 'true'); } catch (e) {} };
  const log = s => { window.__tourLog = (window.__tourLog || []).concat(s).slice(-40); };
  const cmd = () => (H && H.cmdExample ? H.cmdExample() : 'Open Calendar');

  // The end card's words are the owner's, verbatim (Miguel, 26 Oct 2026); the desktop guide ends with the same card.
  const DONE_COPY = 'You’re set. This is your own server, and your Wizard can do a lot on it. Apps add new skills, like Files, a web Browser, Calendar, Music or video editing. Ask your Wizard what apps you have, or what’s in the App Store.';
  const BEATS = [
    null,
    { title: 'Talk', copy: () => typed ? 'Type “hello” and send it to your Wizard.' : 'Tap the orb and say hello. Tap again to send.' },
    { title: 'Reply', copy: () => 'Open Chats to see your Wizard’s answer, then type a reply.' },
    { title: 'Done', copy: () => DONE_COPY },
  ];
  const DONE = BEATS.length - 1; // the end card; every beat before it can be skipped on its own
  const REPLY = 2;
  const count = () => DONE;

  /* Reply beat: only a reply the person typed into a chat thread, and only once it has really been delivered,
   * moves it on (the outbox's onSent). A voice take, a new chat or a message still waiting in the outbox does not. */
  let replyOff = null, replyT0 = 0;
  // (A delivered voice note has already dropped its audio bytes; its server copy, capture or native take still show.)
  const typedReply = it => !!it && it.kind === 'reply' && it.source === 'chat' && !!it.sessionId
    && !it.audio && !it.audioFile && !it.nativeId && !it.captureId
    && !!String(it.text || '').trim() && (it.createdAt || 0) >= replyT0;
  /* Once they leave Home for Chats, the card steps out of the way entirely (it would cover the list and the thread);
   * back on Home it returns with its skip links. */
  function awayTick() {
    if (!active() || step !== REPLY) return;
    el.classList.toggle('tr-away', H.atHome ? !H.atHome() : false);
    later(awayTick, 400);
  }
  function watchReply(on) {
    try { replyOff?.(); } catch (e) {}
    replyOff = null;
    if (!on) return;
    replyT0 = Date.now();
    replyOff = window.WosOutbox?.onSent?.(it => { if (active() && step === REPLY && typedReply(it)) { log('reply:sent'); go(DONE); } }) || null;
  }

  function build() {
    el = document.createElement('div'); el.id = 'tour'; el.className = 'tour'; el.setAttribute('role', 'dialog'); el.setAttribute('aria-label', 'Learn Wizard OS');
    el.innerHTML = `<div class="tr-spot"></div>
      <button type="button" class="tr-skip" data-tskip>Skip tour</button>
      <div class="tr-steps" aria-hidden="true">${'<i></i>'.repeat(count())}</div>
      <div class="tr-stage"></div>
      <div class="tr-copy" aria-live="polite"><small></small><b></b><span class="tr-alt"></span><span class="tr-nx"></span></div>`;
    el.addEventListener('click', e => {
      if (e.target === el || e.target.classList?.contains('tr-spot') || e.target.classList?.contains('tr-stage')) return back();
      if (e.target.closest('[data-tskip]')) return finish('skip');
      if (e.target.closest('[data-tnext]')) return skipStep();
      if (e.target.closest('[data-tchats]')) return H.openChats?.();
      if (e.target.closest('[data-ttype]')) { typed = true; return go(step); }
      const say = e.target.closest('[data-tsay]'); if (say) { busy = true; H.say(say.dataset.tsay, say.dataset.tkind || 'auto'); return; }
      if (step === DONE) return finish('done');
    });
    el.addEventListener('submit', e => {
      e.preventDefault(); const inp = e.target.querySelector('input'); const t = (inp?.value || '').trim(); if (!t) return;
      busy = true; inp.blur(); H.say(t, 'auto');
    });
    H.device.appendChild(el);
  }
  function setCopy(text, sub, alt) {
    const c = $('.tr-copy', el); c.classList.remove('in'); void c.offsetWidth;
    $('b', c).textContent = text; $('small', c).textContent = sub || ''; $('.tr-alt', c).innerHTML = alt || '';
    $('.tr-nx', c).innerHTML = step > 0 && step < DONE ? '<button type="button" class="tr-link tr-next" data-tnext>Skip this step</button>' : '';
    c.classList.add('in');
  }
  const sub = n => (BEATS[n] ? `Step ${n} of ${count()} · ${BEATS[n].title}` : '');
  /* The spotlight hole: around the orb while a beat waits on it; wide open while the shell is showing a result. */
  function spot(mode) {
    const s = $('.tr-spot', el); if (!s) return;
    if (mode === 'open') { s.style.cssText = 'left:0;top:0;width:100%;height:100%;border-radius:0'; el.classList.add('tr-open'); return; }
    el.classList.remove('tr-open');
    const dev = H.device.getBoundingClientRect(), o = H.orbWrap.getBoundingClientRect();
    if (mode === 'closed') { s.style.cssText = `left:${o.left - dev.left + o.width / 2}px;top:${o.top - dev.top + o.height / 2}px;width:0;height:0;border-radius:999px`; return; }
    const pad = 12; s.style.cssText = `left:${o.left - dev.left - pad}px;top:${o.top - dev.top - pad}px;width:${o.width + pad * 2}px;height:${o.height + pad * 2}px;border-radius:999px`;
  }
  function fallback(n) {
    if (n === 1 && typed) return `<form class="tr-type"><input type="text" placeholder="Type hello here" enterkeyhint="send" aria-label="Message to your Wizard" autocomplete="off"><button type="submit">Send</button></form>`;
    if (n === 1 && misses >= 2) return `<button type="button" class="tr-link" data-ttype>Type instead</button>`;
    if (n === REPLY) return '<button type="button" class="tr-go" data-tchats>Open Chats</button>';
    return '';
  }
  function go(n) {
    clearTimers(); step = n; busy = false; inbox = false; log('beat:' + n);
    if (n !== 1) misses = 0;
    el.dataset.step = String(n);
    el.classList.toggle('tr-free', n === REPLY); // Reply: no dim and no tap guard, the whole shell is theirs
    if (n !== REPLY) el.classList.remove('tr-away');
    el.classList.remove('tr-live', 'tr-open');
    watchReply(n === REPLY);
    [...el.querySelectorAll('.tr-steps i')].forEach((d, i) => d.classList.toggle('on', i < n));
    H.orbWrap.classList.toggle('tr-pulse', n === 1 && !typed);
    if (n < DONE) H.goHome(); // each practice beat starts from Home; the end card leaves them where they are
    if (n < DONE) $('.tr-copy', el).style.top = '';
    setCopy(BEATS[n].copy(), sub(n), fallback(n));
    $('.tr-stage', el).innerHTML = '';
    if (n === 1) requestAnimationFrame(() => { if (step === n) spot('orb'); });
    if (n === REPLY) { spot('open'); awayTick(); }
    if (n === DONE) {
      spot('closed');
      $('.tr-stage', el).innerHTML = `${typed ? '<div class="tr-mic">Turn on the microphone in your phone’s settings to talk instead of type.</div>' : ''}<div class="tr-tapon">Tap anywhere to start</div>`;
    }
    if (n === 1 && typed) later(() => el.querySelector('.tr-type input')?.focus(), 120);
    if (n === DONE) { requestAnimationFrame(endLayout); later(endLayout, 420); } // after the copy's entrance settles
  }
  /* End card: stack copy → glyphs → mic note → "Tap anywhere" from measured heights, so a three-line headline on a
   * narrow or short screen (iPhone in Telegram) never runs the rows into each other. */
  function endLayout() {
    if (!el || step !== DONE) return;
    const copy = $('.tr-copy', el), box = H.device.getBoundingClientRect();
    if (!copy) return;
    const rows = ['.tr-mic', '.tr-tapon'].map(sel => $(sel, el)).filter(Boolean);
    const gap = box.height < 500 ? 8 : 22;
    const style = getComputedStyle(el);
    const topBound = Math.max(64, parseFloat(style.paddingTop) || 0);
    const bottomBound = Math.max(16, parseFloat(style.paddingBottom) || 0);
    const height = copy.getBoundingClientRect().height + rows.reduce((n, x) => n + x.getBoundingClientRect().height + gap, 0);
    // Resolved CSS padding includes the native safe areas. If the stack cannot fit, the padded tour scrolls
    // far enough to clear the home indicator, without placing the copy under the top controls.
    let y = Math.max(topBound, Math.min(box.height * .28, box.height - bottomBound - height));
    copy.style.top = Math.round(y) + 'px';
    y += copy.getBoundingClientRect().height + gap;
    for (const x of rows) { x.style.top = Math.round(y) + 'px'; y += x.getBoundingClientRect().height + gap; }
    // Absolute rows do not extend a scroll container's padding in WebKit. A real flow spacer reserves
    // the complete measured stack, so the last row can scroll above the native bottom inset.
    el.style.setProperty('--tr-scroll-height', Math.ceil(Math.max(0, y - gap - topBound)) + 'px');
  }
  window.addEventListener('resize', endLayout);
  function nudge(t, ms = 2200) { if (!active()) return; const n = step; setCopy(t, sub(n), fallback(n)); H.vib(6); later(() => { if (active() && step === n && !busy && !inbox) setCopy(BEATS[n].copy(), sub(n), fallback(n)); }, ms); }

  /* ---- the shell tells the tour what really happened (app.js tourEv) ---- */
  function event(type, d = {}) {
    if (!active()) return;
    log('ev:' + type + (d.which ? ':' + d.which : ''));
    if (type === 'voice') { el.classList.toggle('tr-live', d.state !== 'idle'); return; }
    // Settings opened mid-tour (a deeplink, a notification, a voice command): the owner went somewhere on purpose.
    // Step aside; the tour's tap guard would otherwise swallow every tap in Settings under its scrim.
    if (type === 'sheet' && d.which === 'settings') return finish('handoff');
    // The shell could not start or finish a take (the microphone never opened, ...): say so in the tour's own copy,
    // because toasts are hidden while the tour runs. Never leave the orb looking frozen.
    if (type === 'voicefail') { if (step === 1) { busy = false; el.classList.remove('tr-live'); nudge(d.text || 'The microphone didn’t start. Tap the orb to try again.', 5200); } return; }
    if (type === 'nomic') { if (!typed) { typed = true; log('typed'); later(() => { if (!active()) return; H.prepare(); el.classList.remove('tr-live'); go(step); }, 700); } return; }
    if (step === 1) {
      // Only a real message moves Talk on. A hold is a wrong gesture (below), whether or not it ran as a command.
      if (type === 'sent') {
        busy = true; misses = 0; spot('open');
        setCopy('Sent. Your Wizard is working on it.', sub(1));
        return later(() => go(2), 2200);
      }
      if (type === 'nospeech') { misses++; busy = false; return nudge('Didn’t hear anything. Tap, speak, then tap again.', 3200); }
    }
    // Reply: they are using the real shell (Chats, the launcher, desks, voice). Nothing they do is a wrong gesture.
    if (step === REPLY) return;
    // Wrong gesture: undo what the shell did and steer back to the beat.
    // A hold (the tour no longer teaches commands): drop the take, close whatever a command opened, back to Home.
    if ((type === 'command' || type === 'nomatch') && step < DONE) {
      busy = false; H.dismissVoice(); H.closeSheets(); H.goHome();
      return nudge('That was a hold. For this one, just tap.');
    }
    if (type === 'sheet' && d.which === 'launcher') { H.closeSheets(); return nudge('That’s every app. We’ll come back to it.'); }
    if (type === 'desk' && step < DONE && !busy && !d.home) { H.goHome(); return nudge('That moves between desks. Try the beat above.'); }
  }

  const active = () => !!(el && step > 0);
  // While the tour runs, only the orb, the voice controls and the tour itself take taps (Reply leaves the shell free).
  const allowed = t => !!(t.closest && t.closest('.tour, #orbWrap, #voice, .arc, #txChips, .help-sheet, #dock, #inbox, #zenEdge'));
  const guarded = t => active() && step !== REPLY && !allowed(t);
  window.addEventListener('pointerdown', e => { if (guarded(e.target)) { e.stopImmediatePropagation(); e.preventDefault(); } }, true);
  window.addEventListener('click', e => { if (guarded(e.target)) { e.stopImmediatePropagation(); e.preventDefault(); back(); } }, true);

  function start(why) {
    if (!H) return false;
    closeHelp(); H.prepare();
    if (!el) build();
    typed = !!(H.noMic && H.noMic()); misses = 0;
    el.hidden = false; el.classList.add('on'); H.device.classList.add('touring'); log('start:' + (why || ''));
    window.WizardPwaInstall?.hold?.(true); // no install banner over the tour's own controls while it runs
    go(1); return true;
  }
  function finish(how) {
    if (!el) return;
    clearTimers(); log('finish:' + how); watchReply(false);
    step = 0; inbox = false; busy = false; mark();
    H.orbWrap.classList.remove('tr-pulse');
    el.classList.remove('on'); H.device.classList.remove('touring');
    window.WizardPwaInstall?.hold?.(false);
    const e0 = el; el = null; setTimeout(() => e0.remove(), 300);
    if (how === 'skip') H.toast('?', 'Say “help” any time to see the gestures', 2600);
  }
  /* Skip this step: leave the current beat (stopping a take in progress, bringing hidden bars back) and show the next. */
  function skipStep() {
    if (!active() || step >= DONE) return false;
    const n = step + 1; log('skip-step:' + step);
    if (step === 1) H.prepare(); // stop a take in progress; in Reply the shell is theirs and stays where it is
    el.classList.remove('tr-live', 'tr-open');
    go(n); return true;
  }
  /* Back: at Talk it skips the tour. In Reply, Back is the shell's own (out of a thread, out of Chats): the beat stays. */
  function back() {
    if (helpEl) { closeHelp(); return 'help'; }
    if (!active()) return '';
    if (el.classList.contains('tr-live')) return ''; // recording: Back navigates as always, the tour stays
    if (step === 1) { finish('skip'); return 'tour-skip'; }
    if (step === REPLY) return '';
    finish('done'); return 'tour-done';
  }

  /* ---------------- Help sheet (re-entry) ---------------- */
  const HELP = [
    { k: 'tap', a: 'Tap the orb', b: 'Talk to your Wizard. Tap again to send.', say: ['What did we ship this week?'] },
    { k: 'hold', a: 'Hold the orb', b: 'A command for the phone. It opens on the desk next door.', say: () => [cmd(), 'Show me last week', 'Next desk'] },
    { k: 'down', a: 'Swipe the orb', b: '↓ hide the bars (swipe up from the bottom to bring them back) · ↑ every app · ← → between desks.' },
    { k: 'filter', a: 'In Chats', b: 'Tap the filter button in search, or hold the orb and say “filter by unread” or “search budget”.' },
    { k: 'dots', a: 'Dots under the orb', b: 'Tap to jump to a desk. Long-press to see them all.' },
    { k: 'back', a: 'Back', b: 'Always one step back. It never closes Wizard.' },
    { k: 'skin', a: 'Make it yours', b: 'Everything you see is customizable. Ask your Wizard for one change, and it becomes My skin.', say: ['Make my chat text a little bigger'] },
  ];
  function openHelp() {
    if (!H || helpEl) return;
    H.prepare();
    helpEl = document.createElement('div'); helpEl.className = 'help-sheet'; helpEl.setAttribute('role', 'dialog'); helpEl.setAttribute('aria-label', 'Gestures and help');
    helpEl.innerHTML = `<div class="hs-card"><div class="hs-h"><b>How Wizard works</b><button type="button" class="hs-x" data-hsx aria-label="Close">✕</button></div>
      ${HELP.map(r => { const say = typeof r.say === 'function' ? r.say() : r.say; return `<div class="hs-row"><span class="tr-gi ${r.k}"><i></i></span><span class="hs-tx"><b>${r.a}</b><small>${r.b}</small>${say ? `<span class="hs-say">${say.map(s => `<button type="button" data-hsay="${esc(s)}" data-hkind="${r.k === 'hold' ? 'command' : 'auto'}">${esc(s)}</button>`).join('')}</span>` : ''}</span></div>`; }).join('')}
      <button type="button" class="hs-go" data-hsgo>Practice again</button></div>`;
    helpEl.addEventListener('click', e => {
      if (e.target.closest('[data-hsx]') || e.target === helpEl) return closeHelp();
      if (e.target.closest('[data-hsgo]')) { closeHelp(); return start('help'); }
      const s = e.target.closest('[data-hsay]'); if (s) { closeHelp(); H.say(s.dataset.hsay, s.dataset.hkind); }
    });
    H.device.appendChild(helpEl); void helpEl.offsetWidth; helpEl.classList.add('open'); log('help:open');
  }
  function closeHelp() { if (!helpEl) return false; const h = helpEl; helpEl = null; h.classList.remove('open'); setTimeout(() => h.remove(), 260); log('help:close'); return true; }
  const HELP_RE = /^(help|help me|show (me )?(the )?help|gestures|show (me )?(the )?gestures|how does (this|wizard) work|how do i use (this|wizard)|tutorial|show (me )?the tutorial|practice again)[.!?]*$/i;

  /* ---------------- Desktop: one first-message guide on the real composer ----------------
   * The desktop shell has no orb, gestures or desks to teach, so its first run is the phone's Talk beat only:
   * a small card beside a New chat's composer ("Type hello and press Enter"), nothing dimmed and no tap guard, so
   * chatting is never blocked. Any real message (typed or the mic) moves it to a short end card. Same storage key
   * as the phone tour: finished or skipped once, it never starts by itself again. The desktop adapter (desktop.js)
   * attaches { newChat, composer, toast, keys }. */
  const D = { H: null, el: null, step: 0, t0: 0, off: null, tick: 0, ring: null };
  const dActive = () => !!(D.el && D.step > 0);
  function dPlace() {
    if (!D.el) return;
    const f = D.H.composer?.() || null, card = D.el;
    // Centred over the composer it points at; with no composer in view (after a send the pane may show the list),
    // centred low in the Chats pane, or the window, so it never covers the top bar or a sidebar edge.
    const shown = x => !!(x && x.getClientRects().length);
    const r = shown(f) ? f.getBoundingClientRect() : null, pane = !r && D.H.pane?.(), pr = shown(pane) ? pane.getBoundingClientRect() : null;
    const box = r || pr || { left: 0, right: innerWidth, bottom: innerHeight, width: innerWidth };
    const w = Math.min(440, Math.max(280, box.width - 32));
    const left = Math.max(8, Math.min(innerWidth - w - 8, box.left + (box.width - w) / 2));
    const bottom = r ? Math.max(8, innerHeight - r.top + 14) : Math.max(16, innerHeight - box.bottom + 24);
    card.style.cssText = `left:${Math.round(left)}px;bottom:${Math.round(bottom)}px;width:${Math.round(w)}px`;
    // The ring is its own element over the message box: Chats re-renders the composer and would drop a class on it.
    if (D.ring) D.ring.style.cssText = r && D.step === 1 ? `left:${r.left - 4}px;top:${r.top - 4}px;width:${r.width + 8}px;height:${r.height + 8}px` : 'display:none';
  }
  function dPaint() {
    const n = D.step, mod = D.H.mod || 'Alt+';
    D.el.dataset.step = String(n);
    D.el.innerHTML = n === 1
      ? `<small>Step 1 of 2</small><b>Type “hello” below and press Enter to send it to your Wizard.</b>
         <span class="dtr-sub">Prefer to talk? Click the mic next to the box.</span>
         <span class="dtr-acts"><button type="button" class="dtr-link" data-dnext>Skip this step</button><button type="button" class="dtr-link" data-dskip>Skip tour</button></span>`
      : `<small>Step 2 of 2</small><b>${DONE_COPY}</b>
         <span class="dtr-sub">Setup and your apps: <kbd>${mod}O</kbd> · every key: <kbd>${mod}/</kbd></span>
         <span class="dtr-acts"><button type="button" class="dtr-go" data-ddone>Done</button></span>`;
    dPlace(); log('desk:beat:' + n);
  }
  // Desktop's nonblocking tour card has no scrim. Its surroundings still mean
  // Back, while the underlying composer/navigation click remains usable.
  window.addEventListener('click', e => { if (dActive() && !D.el.contains(e.target)) dFinish('back'); }, true);
  function dStart(why) {
    if (!D.H) return false;
    if (dActive()) return true;
    D.H.newChat?.(); // a New chat in the main Chats window, composer focused
    D.el = document.createElement('div'); D.el.className = 'dtr'; D.el.setAttribute('role', 'dialog'); D.el.setAttribute('aria-label', 'Send your first message');
    D.el.addEventListener('click', e => {
      if (e.target.closest('[data-dskip]')) return dFinish('skip');
      if (e.target.closest('[data-dnext]')) { D.sent = false; D.step = 2; return dPaint(); }
      if (e.target.closest('[data-ddone]')) return dFinish('done');
    });
    D.ring = document.createElement('div'); D.ring.className = 'dtr-ring'; D.ring.setAttribute('aria-hidden', 'true');
    document.body.append(D.ring, D.el);
    D.step = 1; D.sent = false; D.t0 = Date.now(); log('desk:start:' + (why || ''));
    // Any real message after the guide started (typed, the composer mic or a voice take) moves it on.
    const OB = window.WosOutbox;
    D.off = OB?.onChange?.(api => {
      if (D.step !== 1) return;
      if (api.unsent().some(it => it.createdAt >= D.t0 && api.isMessage(it))) { D.sent = true; D.step = 2; dPaint(); }
    }) || null;
    D.tick = setInterval(dPlace, 400); addEventListener('resize', dPlace);
    dPaint(); return true;
  }
  function dFinish(how) {
    if (!D.el) return false;
    log('desk:finish:' + how); mark();
    clearInterval(D.tick); removeEventListener('resize', dPlace); try { D.off?.(); } catch (e) {}
    D.ring?.remove(); D.ring = null;
    D.el.remove(); D.el = null; D.step = 0; D.off = null;
    if (how === 'skip') D.H?.toast?.('?', 'Keys and help any time: ' + (D.H.mod || 'Alt+') + '/', 2600);
    return true;
  }
  const desk = {
    attach(host) { D.H = host; }, start: dStart, finish: dFinish,
    skipStep: () => { if (D.step !== 1) return false; D.sent = false; D.step = 2; dPaint(); return true; },
    get active() { return dActive(); }, get step() { return D.step; },
  };

  window.WosTour = {
    desk,
    attach(host) { H = host; },
    start, finish, back, event, skipStep, openHelp, closeHelp, _go: n => active() && go(n),
    beats: BEATS.slice(1).map(b => b.title), DONE, REPLY, DONE_COPY,
    isHelp: t => HELP_RE.test(String(t || '').trim()),
    get active() { return active(); }, get step() { return step; }, get helpOpen() { return !!helpEl; }, get typed() { return typed; },
    done, mark,
  };
})();
