/* Wizard UX core: the power features of a Chats thread, wired into core/chats.js through small hooks.
 * Shared by every shell. Each feature's data/rendering lives in its own module; this file is the glue.
 *
 *  #11 model picker   header chip → sheet (thread: POST …/sessions/:id/model; new chat: rides with the first send)
 *                     failed thread → “Needs retry” panel: Retry · Choose another model · Dismiss      (chat-models.js)
 *  #12 Errors section failed threads, failed background work (/wizard/attention) and failed voice notes (outbox),
 *                     each with Retry / Dismiss                                                         (chat-errors.js)
 *  #13 composer mic   records a voice reply pinned to THIS thread (the shell's recorder via H.recordReply),
 *                     delivered by the durable outbox with the recording attached                        (sendVoiceTo)
 *  #17 work receipt   one collapsible row per turn: Worked for 3m · 2 of 4 done · named steps         (chat-work.js)
 *  #18 reading place  opens at the start of the latest reply, remembers where you were for an hour,
 *                     “↓ Latest” jump; a Working thread follows the bottom until you scroll up
 *  #23 Files          browse Wizard Files, preview in the media viewer, attach to a chat              (files.js)
 *
 *   const PW = window.WosChatPower(api)   (api: the Chats instance's internals, see chats.js)
 */
window.WosChatPower = function chatPower(A) {
  'use strict';
  const { esc, clip } = window.WizCore;
  const LIVE = window.WizLive, OUTBOX = window.WosOutbox || null;
  const M = window.WosModels || null, WK = window.WosWork || null, E = window.WosErrors || null, F = window.WosFiles || null;
  const { ch, toast, H } = A;
  const scrollBox = A.scrollBox || (nb => nb);
  const agent = () => window.WizConfig.agent();
  const FAILED = new Set(['failed', 'interrupted']);
  const FOLDER_SVG = '<svg viewBox="0 0 24 24"><path d="M3.5 7.5a2 2 0 0 1 2-2h4l2 2.2h7a2 2 0 0 1 2 2v7.8a2 2 0 0 1-2 2h-13a2 2 0 0 1-2-2Z"/></svg>';

  /* ================= #18 reading position ================= */
  // wizard-mobile ff86db8c readingPosition.ts: same key, one hour, newest 32 threads.
  const RP_KEY = 'wizard.mobile.reading-positions.v1', RP_TTL = 60 * 60 * 1000, RP_MAX = 32;
  let places = null, saveT = 0;
  const RP = {
    all(now = Date.now()) {
      if (!places) {
        try { places = JSON.parse(localStorage.getItem(RP_KEY) || '{}'); } catch (_) {}
        if (!places || typeof places !== 'object' || Array.isArray(places)) places = {};
      }
      for (const [k, v] of Object.entries(places)) {
        if (!v || v.sessionId !== k || typeof v.messageId !== 'string' || !isFinite(v.savedAt)
          || !isFinite(v.scrollTop) || now - v.savedAt >= RP_TTL || v.savedAt > now + RP_TTL) delete places[k];
      }
      return places;
    },
    read(sid) { return sid ? RP.all()[sid] || null : null; },
    save(p) {
      const all = RP.all(p.savedAt); all[p.sessionId] = p;
      places = Object.fromEntries(Object.entries(all).sort((a, b) => b[1].savedAt - a[1].savedAt).slice(0, RP_MAX));
      clearTimeout(saveT); saveT = setTimeout(flushPlace, 200);
    },
  };
  function mergePlaces(text) {
    try {
      const other = JSON.parse(text || '{}'); if (!other || typeof other !== 'object' || Array.isArray(other)) return;
      const all = RP.all();
      for (const [sid, p] of Object.entries(other)) if (p?.savedAt > (all[sid]?.savedAt || 0)) all[sid] = p;
      places = Object.fromEntries(Object.entries(RP.all()).sort((a, b) => b[1].savedAt - a[1].savedAt).slice(0, RP_MAX));
    } catch (_) {}
  }
  const flushPlace = () => { clearTimeout(saveT); if (places) try { mergePlaces(localStorage.getItem(RP_KEY)); localStorage.setItem(RP_KEY, JSON.stringify(RP.all())); } catch (_) {} };
  addEventListener('storage', e => { if (e.key === RP_KEY) mergePlaces(e.newValue); });
  addEventListener('pagehide', flushPlace);
  addEventListener('beforeunload', flushPlace);
  document.addEventListener('visibilitychange', () => { if (document.hidden) flushPlace(); });
  const latestId = turns => { for (let i = turns.length - 1; i >= 0; i--) if (turns[i].a) return `${i}:${turns[i].a.at ?? ''}`; return ''; };
  const lastReply = nb => { const a = nb.querySelectorAll('.msg.a'); return a.length ? a[a.length - 1] : null; };
  const onScreen = A.threadOnScreen;
  const relTop = (nb, el) => {
    const base = scrollBox(nb) === nb ? nb.getBoundingClientRect().top : nb.closest('.ch-thread').querySelector('.ch-head').getBoundingClientRect().bottom;
    return el.getBoundingClientRect().top - (A.threadViewportTop ? A.threadViewportTop(nb, base) : base);
  };
  const bottomGap = nb => { const s = scrollBox(nb); return s.scrollHeight - s.scrollTop - s.clientHeight; };
  function anchorOf(nb) {
    if (!onScreen(nb)) return null;
    const seen = {};
    for (const m of nb.querySelectorAll('[data-morph-key]')) {
      const k = m.dataset.morphKey; seen[k] = (seen[k] || 0) + 1;
      if (m.getBoundingClientRect().height && relTop(nb, m) + m.getBoundingClientRect().height > 1)
        return { key: k, nth: seen[k] - 1, off: relTop(nb, m) };
    }
    return null;
  }
  const placed = new WeakMap(); // pending browser scroll acknowledgements, never a saved reading spot
  function moveTo(nb, top) {
    const s = scrollBox(nb), to = Math.max(0, Math.min(s.scrollHeight - s.clientHeight, top));
    // Even an unchanged assignment kills a handset's momentum fling.
    if (Math.abs(s.scrollTop - to) >= 1) { placed.set(s, to); s.scrollTop = to; }
  }
  // The only restore / stick-to-bottom rule, for open, repaint, app/desk return and layout changes.
  function restore(nb, place) {
    if (!onScreen(nb) || !place) return false;
    if (place.atBottom) moveTo(nb, scrollBox(nb).scrollHeight);
    else {
      let n = -1, m = null;
      if (place.anchor) for (const e of nb.querySelectorAll('[data-morph-key]'))
        if (e.dataset.morphKey === place.anchor.key && ++n === place.anchor.nth) { m = e; break; }
      if (m) moveTo(nb, scrollBox(nb).scrollTop + relTop(nb, m) - place.anchor.off);
      // Migrate the previous hour's latest-reply-relative records without losing them.
      else { const r = lastReply(nb); moveTo(nb, !place.anchor && r && isFinite(place.anchorOffset)
        ? scrollBox(nb).scrollTop + relTop(nb, r) - place.anchorOffset : place.scrollTop); }
    }
    return true;
  }
  function capture(nb) {
    if (!onScreen(nb) || nb.closest('[data-incog-thread]')) return;
    const el = nb.closest('[data-chats]'), w = H.win(el.dataset.chats), c = w && ch(w.id);
    if (c?.placeOptions?.notification) { c.placeOptions.notificationScroll = scrollBox(nb).scrollTop; return; }
    if (!w?.thread || w.thread === '__new__' || !c.lid || c.posFor !== w.thread || settling(c)) return;
    RP.save({ sessionId: w.thread, messageId: c.lid, anchor: anchorOf(nb), shown: c.show,
      scrollTop: scrollBox(nb).scrollTop, savedAt: Date.now(), atBottom: bottomGap(nb) < 80,
      working: !!A.isWorking?.(LIVE.session?.(w.thread)) });
  }
  function follow(wid) {
    const w = H.win(wid); if (!w?.thread || w.thread === '__new__') return;
    RP.save({ ...RP.read(w.thread), sessionId: w.thread, messageId: ch(wid).lid || '',
      scrollTop: 0, atBottom: true, savedAt: Date.now(), working: !!A.isWorking?.(LIVE.session?.(w.thread)) });
    const nb = A.elOf?.(wid)?.querySelector('.ch-msgs'); if (nb) { endSettle(ch(wid)); restore(nb, RP.read(w.thread)); }
  }
  function paintLatest(el, nb) {
    const b = el.querySelector('[data-chlatest]'), hidden = bottomGap(nb) < 160;
    if (b && onScreen(nb) && b.hidden !== hidden) b.hidden = hidden;
  }
  function position(w, el, nb, o) {
    const c = ch(w.id), sid = w.thread;
    c.placeOptions = o;
    if (!nb) return false;
    if (c.placeWait) { c.placeWait.disconnect(); c.placeWait = null; }
    if (!onScreen(nb)) {
      if (typeof ResizeObserver === 'function') {
        const ro = c.placeWait = new ResizeObserver(() => {
          if (onScreen(nb) && nb.isConnected && w.thread === sid) position(w, el, nb, c.placeOptions);
        });
        ro.observe(nb);
      }
      return true; // never adopt the scroll of a hidden / parked thread
    }
    // A notification is a document to read, not an empty chat to bottom-stick. Reuse the same scroll-box path
    // for browser and native document scrolling, keeping its reading place through repaints and layout changes.
    if (o.notification) { restore(nb, { scrollTop: o.notificationScroll || 0 }); return true; }
    if (sid === '__new__' || !o.turns) { restore(nb, { atBottom: true }); return true; }
    c.lid = latestId(o.turns);
    if (c.posFor !== sid) {
      c.posFor = sid; c.posLid = c.lid; c.readerMoved = false;
      c.posCached = !(c.loadedFor === sid && c.loadedNav === c.readNav);
      const kept = c.unreadOpen === sid ? null : RP.read(sid);
      const saved = kept && !(kept.atBottom && kept.working) && kept.messageId === c.lid ? kept : null;
      const reply = lastReply(nb), last = o.turns[o.turns.length - 1];
      let place = saved;
      if (!place) {
        const waiting = o.working && !last?.a;
        const key = reply?.dataset.morphKey;
        const nth = reply ? [...nb.querySelectorAll('[data-morph-key]')].filter(e => e.dataset.morphKey === key).indexOf(reply) : 0;
        place = { sessionId: sid, messageId: c.lid, shown: c.show, scrollTop: 0, savedAt: Date.now(),
          atBottom: waiting || !reply, working: o.working,
          anchor: reply ? { key, nth, off: 8 } : null };
        if (saved == null && !place.atBottom) c.atStart = sid;
        RP.save(place);
      }
      restore(nb, place);
      settle(c, nb, () => restore(nb, RP.read(sid)));
      if (!c.posCached) c.unreadOpen = '';
    } else {
      if (c.posCached && c.loadedFor === sid && c.loadedNav === c.readNav) {
        c.posCached = false;
        if (c.lid === c.posLid || c.readerMoved) c.unreadOpen = '';
        if (c.lid !== c.posLid && !c.readerMoved) { endSettle(c); c.posFor = null; return position(w, el, nb, o); }
      }
      if (settling(c)) { const s = c.settle; settle(c, nb, () => restore(nb, RP.read(sid)), s.until); }
      restore(nb, RP.read(sid));
    }
    // Content or chrome can grow without a repaint. Both modes use the same restore rule.
    const nodes = [nb, ...nb.children, nb.closest('.ch-thread')?.querySelector('.ch-compose')].filter(Boolean);
    if (typeof ResizeObserver === 'function' && (!c.placeNodes || nodes.length !== c.placeNodes.length || nodes.some((n, i) => c.placeNodes[i] !== n))) {
      c.placeResize?.disconnect(); c.placeNodes = nodes;
      c.placeResize = new ResizeObserver(() => reflow(nb)); nodes.forEach(n => c.placeResize.observe(n));
    }
    nb.querySelectorAll('img').forEach(im => { if (!im.complete && !im.__placeLoad) {
      im.__placeLoad = true; im.addEventListener('load', () => reflow(nb), { once: true });
    } });
    paintLatest(el, nb);
    return true;
  }
  function resume(nb) {
    const el = nb?.closest('[data-chats]'), w = el && H.win(el.dataset.chats), c = w && ch(w.id);
    if (c?.placeOptions) position(w, el, nb, c.placeOptions);
  }
  function reflow(nb) {
    const el = nb?.closest('[data-chats]'), w = el && H.win(el.dataset.chats), c = w && ch(w.id);
    if (!c || c.placeTouching) return;
    clearTimeout(c.reflowT);
    const wait = 600 - (Date.now() - (c.placeUserAt || 0));
    if (wait > 0) { c.reflowT = setTimeout(() => reflow(nb), wait + 1); return; }
    restore(nb, RP.read(w.thread));
  }
  const SETTLE_MS = 3000;
  function settle(c, nb, apply, until) {
    endSettle(c);
    const s = c.settle = { nb, apply, until: until || Date.now() + SETTLE_MS };
    const stop = () => endSettle(c, s), again = () => { if (settling(c) && c.settle === s) apply(); else stop(); };
    const evs = ['wheel', 'touchstart', 'pointerdown', 'keydown'], host = nb.closest('[data-chats]') || nb;
    evs.forEach(e => host.addEventListener(e, stop, { passive: true }));
    nb.addEventListener('load', again, true);
    if (typeof ResizeObserver === 'function') { s.ro = new ResizeObserver(again); s.ro.observe(nb); }
    s.off = () => { evs.forEach(e => host.removeEventListener(e, stop)); nb.removeEventListener('load', again, true); s.ro?.disconnect(); };
    s.t = setTimeout(stop, Math.max(0, s.until - Date.now()));
  }
  function endSettle(c, s) { const cur = c.settle; if (!cur || (s && cur !== s)) return; c.settle = null; cur.off?.(); clearTimeout(cur.t); }
  const settling = c => !!(c.settle && Date.now() < c.settle.until);
  function onScroll(nb) {
    if (!onScreen(nb)) return;
    const el = nb.closest('[data-chats]'), w = H.win(el.dataset.chats); if (!w?.thread) return;
    const c = ch(w.id), sc = scrollBox(nb), own = placed.has(sc) && Math.abs(sc.scrollTop - placed.get(sc)) < 1;
    placed.delete(sc);
    if (!own && !settling(c)) { c.readerMoved = true; c.placeUserAt = Date.now(); }
    capture(nb); paintLatest(el, nb);
  }
  // Pick from what's already in Wizard Files (#23), next to the paperclip.
  const filesBtn = () => (F ? `<button type="button" class="ch-fromfiles" data-chfiles aria-label="Attach from Wizard Files" title="From Wizard Files">${FOLDER_SVG}</button>` : '');
  const latestBtn = () => '<button type="button" class="ch-latest" data-chlatest hidden aria-label="Jump to the latest message">↓ Latest</button>';

  /* ================= #17 work receipt ================= */
  const turnKey = tn => `${tn.u?.at ?? tn.at ?? ''}:${(tn.u?.text || '').length}`;
  function workHtml(c, tn, live, helperStatus) {
    if (!WK) return null;
    const key = turnKey(tn);
    return WK.html(tn, { live, helperStatus, streamSteps: live && !c.stream?.landed && !c.stream?.terminal ? c.stream?.steps : [], open: !!c.wkOpen?.has(key), md: A.md, esc, clip, key });
  }

  /* ================= #11 models ================= */
  function threadModel(s) {
    return M?.currentRoute(s?.id || '') || { model: '', provider: '' };
  }
  // Agents MVP: the agent a window or thread belongs to (null = the main agent).
  const agentOfWin = (w, s) => { const AG = window.WosAgents; const id = s ? (LIVE.agentOf?.(s.id) || (typeof s.agent === 'string' ? s.agent : s.agent?.id) || '') : A.winAgent(w); return AG && id && AG.isOther(id) ? AG.get(id) || { id, label: id, missing: true } : null; };
  function newModel(c, w) {
    if (c.newModel) return c.newModel;
    const ag = agentOfWin(w || H.win(Object.keys(A.CH).find(k => A.CH[k] === c) || ''), null);
    if (ag) { const r = ag.missing ? null : window.WosAgents.route(ag); return r ? { ...r, isDefault: true } : null; }
    return M?.defaultOption() ? { model: M.defaultOption().value, provider: M.defaultOption().provider, isDefault: true } : null;
  }
  // The chip in the thread header: the model this thread (or this new chat) runs on. Tap to change it.
  function modelChip(w, s) {
    if (!M) return '';
    const cur = w.thread === '__new__' ? newModel(ch(w.id), w) : s ? threadModel(s) : null;
    // A new chat in the main Chats on a Private model belongs to that private agent (unified Chats).
    const AG = window.WosAgents;
    const ag = agentOfWin(w, s) || (w.thread === '__new__' && cur?.agent && AG?.isOther(cur.agent) ? AG.get(cur.agent) || null : null);
    const priv = !!ag && AG?.isPrivate(ag);
    const full = cur?.model ? (ag ? AG.modelName(ag, cur.model) : M.name(cur.model, cur.provider)) : 'default';
    // Agents get the same short family name as the main chat (Fable, Opus, GLM 5.3), never a raw id like claude-fable-5-1.
    const label = cur?.model ? (M.short(cur.model, cur.provider || ag?.model?.provider) || full) : M.ready ? 'Default model' : 'Model';
    const secure = !ag && !!cur?.provider && !!M.ours?.() && !!M.isPrivateRoute?.(cur.provider);
    return `<button type="button" class="ch-model${ag ? ' agent' : ''}${priv || secure ? ' private' : ''}" data-chmodel aria-label="Model: ${esc(full)}${priv ? ', private' : ''}. Change model" title="${esc(cur?.model || '')}">${priv || secure ? (AG?.lock?.() || '') : ''}${esc(label)}<i aria-hidden="true">▾</i></button>`;
  }
  /* The model label inside the message box, bottom-right (James 18 Oct: just the name, small, white; no bubble).
   * Tapping it opens the compact model menu over the right side, just above it. */
  function modelLabel(w, s) {
    const chip = modelChip(w, s); if (!chip) return '';
    return chip.replace('class="ch-model', 'class="ch-mlabel ch-model').replace(/<i aria-hidden="true">▾<\/i>/, '');
  }
  /* Miguel's skins only (Dark, Light, Landscapes; M.ours()): a four-position slide switch (Opus · Astra · Sol · the
   * private Tinfoil model) above the composer, drag or tap; ⋯ opens every model. James's skins keep the model label. */
  const SW_NAMES = ['Opus', 'Astra', 'Sol', '']; // slot 4: the private model's own name (privateName), in the privacy colour
  // An empty slot means its account isn't usable right now: tapping it opens that app at the fix (Reconnect / Connect).
  const SW_FIX = ['/wizard-claude/?reconnect=1', '/wizard-chatgpt/?reconnect=1', '/wizard-chatgpt/?reconnect=1', '/wizard-tinfoil/?connect=1'];
  const SW_FIX_TITLE = ['Claude needs attention · tap to fix', 'ChatGPT needs attention · tap to fix', 'ChatGPT needs attention · tap to fix', 'Set up Tinfoil · tap to connect'];
  function openFix(path) { const app = path.split('/')[1]; if (!window.WizOpenApp?.(app, path)) H.openLink?.(path, app); }
  function switchOpts(w, s) {
    const cur = w.thread === '__new__' ? newModel(ch(w.id), w) : s ? threadModel(s) : null;
    const vis = M && M.ready ? M.visible(cur?.model || '', cur?.provider || '') : [];
    // Match by family in the model id (newest first), so e.g. gpt-6.1-sol still fills the Sol slot.
    const RX = [/opus/i, /astra/i, /-sol(-|$)/i], all = M && M.ready ? M.options.filter(o => !/-900k$/i.test(o.value)) : [];
    const newest = l => l.slice().sort((x, y) => y.value.localeCompare(x.value, 'en', { numeric: true }))[0] || null;
    const standard = o => M.family(o.value, o.provider) !== 'tinfoil';
    const opts = RX.map(rx => vis.find(o => standard(o) && rx.test(o.value)) || newest(all.filter(o => standard(o) && rx.test(o.value))));
    opts.push(M?.tinfoilReady?.() ? vis.find(o => M.family(o.value, o.provider) === 'tinfoil') || null : null);
    const at = cur?.model ? opts.findIndex(o => o && o.value === cur.model && (!cur.provider || o.provider === cur.provider)) : -1;
    return { opts, at };
  }
  // Versions come from the actual selectable id, never a display-name guess or a pinned catalogue.
  function switchVersion(id) {
    const v = String(id || '').replace(/\[.*\]$/, '');
    let m = v.match(/^claude-[a-z]+-(\d+)(?:[-.](\d{1,2}))?(?:-\d{8})?$/i);
    if (m) return m[1] + (m[2] ? '.' + m[2] : '');
    m = v.match(/^gpt-([\d.]+)-[a-z]+(?:-900k)?$/i);
    return m ? m[1] : '';
  }
  function modelSwitch(w, s) {
    if (!M || agentOfWin(w, s)) return modelChip(w, s);
    const { opts, at } = switchOpts(w, s);
    const label = at < 0 ? (s ? M.short(threadModel(s).model, threadModel(s).provider) || 'Model' : 'Default') : '';
    const pv = M.privateName ? M.privateName(opts[3]?.value) : { name: '', version: '' };
    const nameAt = i => i === 3 ? (opts[3] ? pv.name : 'Private') : SW_NAMES[i];
    const verAt = i => i === 3 ? pv.version : switchVersion(opts[i]?.value);
    return `<div class="ms${at === 3 ? ' secure-on' : ''}" data-mswid="${esc(w.id)}" style="--ms-i:${at < 0 ? 1 : at}"><div class="ms-track${at < 0 ? ' off' : ''}" role="radiogroup" aria-label="Model">${SW_NAMES.map((n, i) => `<button type="button" role="radio" class="ms-o${i === 3 ? ' secure' : ''}${i === at ? ' on' : ''}" data-msi="${i}" aria-checked="${i === at}"${opts[i] ? '' : ` aria-disabled="true" data-msfix="${SW_FIX[i]}" title="${esc(SW_FIX_TITLE[i])}"`}${i === 3 ? ` aria-label="${esc([nameAt(3), verAt(3)].filter(Boolean).join(' '))}, private"` : ''}><span class="ms-name">${esc(nameAt(i))}</span> <small class="ms-version">${i === 3 && window.WosAgents?.lock ? window.WosAgents.lock() : ''}${esc(verAt(i))}</small></button>`).join('')}<i class="ms-thumb" aria-hidden="true"></i></div><button type="button" class="ms-more" data-chmodel aria-label="All models${label ? ` · now ${esc(label)}` : ''}">${label ? `<small>${esc(label)}</small>` : ''}⋯</button></div>`;
  }
  async function switchTo(wid, i) {
    const w = H.win(wid); if (!w?.thread) return;
    const s = w.thread === '__new__' ? null : LIVE.session(w.thread);
    const o = switchOpts(w, s).opts[i]; if (!o) return;
    await pickModel(o, { wid, sid: w.thread, mode: w.thread === '__new__' ? 'new' : 'thread' });
  }
  (() => { // drag the thumb, or tap a position
    let drag = null;
    document.addEventListener('pointerdown', e => { const tr = e.target.closest?.('.ms-track'); if (!tr) return; const r = tr.getBoundingClientRect(); drag = { tr, r, wid: tr.parentElement.dataset.mswid, moved: false, x0: e.clientX }; tr.setPointerCapture?.(e.pointerId); });
    document.addEventListener('pointermove', e => { if (!drag) return; if (Math.abs(e.clientX - drag.x0) > 6) drag.moved = true; if (!drag.moved) return; const f = Math.max(0, Math.min(1, (e.clientX - drag.r.left) / drag.r.width)); drag.tr.parentElement.style.setProperty('--ms-i', (f * SW_NAMES.length - .5).toFixed(3)); drag.tr.classList.add('dragging'); });
    const end = e => { if (!drag) return; const d = drag; drag = null; d.tr.classList.remove('dragging'); const f = Math.max(0, Math.min(.999, (e.clientX - d.r.left) / d.r.width)); const i = Math.floor(f * SW_NAMES.length); const w = H.win(d.wid); if (!w?.thread) return; const state = switchOpts(w, LIVE.session(w.thread)); if (state.opts[i]) { d.tr.parentElement.style.setProperty('--ms-i', i); switchTo(d.wid, i); } else { d.tr.parentElement.style.setProperty('--ms-i', state.at < 0 ? 1 : state.at); if (!d.moved) openFix(SW_FIX[i]); } };
    document.addEventListener('pointerup', end); document.addEventListener('pointercancel', () => { if (drag) { drag.tr.classList.remove('dragging'); drag = null; } });
  })();

  let modelsAsked = false;
  function ensureModels() {
    if (!M || modelsAsked) return;
    modelsAsked = true;
    const repaint = () => { for (const id of Object.keys(A.CH)) { const w = H.win(id); if (w?.thread) (A.renderThreadLive || A.renderThreadNow)(w); } };
    M.load().then(repaint); // background: waits for a selection
    // A later background reload that changed the catalogue (e.g. ChatGPT's real list replacing Hermes' placeholder).
    window.addEventListener?.('wos:models', repaint);
  }
  async function pickModel(o, direct) {
    const sh = direct || sheet; if (!sh || (!direct && sh.type !== 'model') || (direct?.alive && !direct.alive())) return;
    if (M?.pending?.has(sh.sid) || retrying.has(sh.sid)) return;
    const c = ch(sh.wid), w = H.win(sh.wid); if (!direct) closeSheet();
    if (sh.mode === 'new') { c.newModel = { model: o.value, provider: o.provider, ...(o.agent ? { agent: o.agent } : {}) }; toast('◇', o.private ? `New private chat on ${o.name}` : `New chat on ${o.name}`, 1400); if (w) A.renderThreadNow(w); return; }
    const s = LIVE.session(sh.sid); if (!s) return;
    // A Private model picked in a standard thread: a new private chat continues this conversation (quoted context);
    // this thread is left exactly as it is. Private → standard is never offered (a private thread lists only its own).
    if (o.agent && o.private && !LIVE.agentOf?.(sh.sid)) { if (sh.mode === 'thread' && A.continueInAgent) A.continueInAgent(sh.wid, sh.sid, o); return; }
    // A model pick on a failed thread means retry, from the panel or composer.
    if (sh.mode === 'retry' || failedShown(s)) return retryThread(sh.wid, sh.sid, o, sh.retryRunId, direct?.alive);
    const cur = threadModel(s);
    const same = cur.model === o.value && (!o.provider || cur.provider === o.provider);
    if (!same) {
      let route;
      try { route = await M.setThreadModel(sh.sid, o); }
      catch (e) { toast('!', 'Couldn’t change the model · try again', 2600); return; }
      if (direct?.alive && !direct.alive()) return;
      Object.assign(s, route);
    }
    toast('◇', same ? `Already on ${o.name}` : `This thread now uses ${o.name}`, 1600);
    if (w) A.renderThreadNow(w);
  }

  /* ================= #11/#12 failure recovery ================= */
  const failedShown = s => !!s && (FAILED.has(s.status) || (s.status === 'queued' && s.queueReason === 'provider_access')) && !(E && E.dismissed(s.id));
  function failureHtml(w, s) {
    if (!M || !failedShown(s)) return '';
    const busy = retrying.has(s.id) ? 'retry' : E?.busy.get(s.id) || '';
    const req = requestOf(w, s);
    return M.failureHtml({ s: { ...s, ...threadModel(s) }, busy, retryLabel: retrying.get(s.id), canRetry: !!req });
  }
  // Retry and Choose another model stay live on every failed thread. A failed turn the owner didn't type (a
  // coordinator's follow-through note, a photo-only message, a run a watcher started) is retried with a plain
  // "Retry" from the owner, since the thread's history already holds the request. Before, such a thread had no
  // request text, so both buttons stayed grey, also after changing the model, and James typed "Retry" by hand (18 Oct 2026).
  const RETRY_WORD = 'Retry';
  // The open thread's latest turn has no typed words (a note or a later run started it). Only the turn's kind is
  // read here; the words sent are always the freshly hydrated request, never cached turn text.
  function noteTurn(w, s) {
    const c = w && ch(w.id), turns = c && c.loadedFor === s?.id ? c.turns || [] : [];
    for (let i = turns.length - 1; i >= 0; i--) {
      const tn = turns[i];
      if (tn.u?.text) return false;
      if (tn.u || tn.note || tn.later) return true;
    }
    return false;
  }
  function requestOf(w, s) {
    if (s?.status === 'queued' && s.queueReason === 'provider_access') return !!s.retryRunId;
    if (s && FAILED.has(s.status)) return true;
    return !!(s?.request || (w && !noteTurn(w, s) && (ch(w.id)?.turns || []).some(tn => tn.u?.text)));
  }
  // Retry = send the thread's last request again, through the durable outbox, on the same thread
  // (and the same model, unless one was just picked). controller.ts retryServerFailedSession.
  const retrying = new Map();
  async function retryThread(wid, sid, o, sourceId, alive) {
    let s = LIVE.session(sid); if (!s || !OUTBOX) return false;
    if (retrying.has(sid) || M?.pending?.has(sid) || OUTBOX.unsent?.().some(it => it.sessionId === sid && it.how === 'retry')) return false;
    const savedId = sourceId || s.retryRunId;
    const wasWaiting = s.status === 'queued' && s.queueReason === 'provider_access';
    retrying.set(sid, o ? `Retrying on ${o.name}…` : 'Retrying…');
    const w = H.win(wid), c = w ? ch(wid) : null; if (c) c.retrying = sid;
    // Acknowledge on the selection tap, before detail/model-save/disk can wait.
    try {
      for (const id of Object.keys(A.CH)) { const view = H.win(id); if (view?.thread === sid) A.renderThreadNow(view); }
      // A list/snapshot preview is never retry input, even after an earlier detail read.
      try { s = await LIVE.sessionInfo(sid); } catch (_) { toast('!', 'Couldn’t load the full request · retry when online', 2600); return false; }
      // Recovery may win while the picker or a model PUT is waiting. Never
      // turn that stale card into a fresh send. The server also fences savedId.
      const changed = () => !s || (savedId ? s.retryRunId !== savedId : !FAILED.has(s.status)) || (wasWaiting && !s.retryRunId);
      if (alive && !alive()) return false;
      if (changed()) {
        toast('!', 'This saved request has changed · check the latest reply before retrying', 3000); return false;
      }
      if (o) {
        const cur = threadModel(s);
        if (cur.model !== o.value || (o.provider && cur.provider !== o.provider)) {
          let route;
          try { route = await M.setThreadModel(sid, o); }
          catch (_) { toast('!', 'Couldn’t change the model · try again', 2600); return false; }
          if (alive && !alive()) return false;
          Object.assign(s, route);
          // Saving can take seconds. Hydrate again ONLY across that await; a
          // same-model retry reuses the single fresh preflight above.
          try { s = await LIVE.sessionInfo(sid); } catch (_) { toast('!', 'Couldn’t load the full request · retry when online', 2600); return false; }
          if (alive && !alive()) return false;
          if (changed()) { toast('!', 'This saved request has changed · check the latest reply before retrying', 3000); return false; }
        }
      }
      // Only the freshly hydrated input, never cached turns. A failed note-started turn (the server's request skips
      // follow-through notes, so it is empty or an older request) goes again as a plain "Retry".
      const note = noteTurn(w && w.thread === sid ? w : null, s);
      const text = s?.retryRunId ? s.request || RETRY_WORD : note ? RETRY_WORD : s?.request || (FAILED.has(s?.status) ? RETRY_WORD : '');
      if (!text) { toast('!', 'This thread has no request to send again · open it to reply', 2600); return false; }
      const cur = o ? { model: o.value, provider: o.provider } : threadModel(s);
      await OUTBOX.enqueue({ kind: 'reply', sessionId: sid, agent: s.agent || A.winAgent?.(w) || '', text, retryRunId: s.retryRunId || '', wid: w && w.thread === sid ? wid : '', how: 'retry', source: 'chat',
        instructions: `${window.WizConfig.owner() || 'The owner'} pressed Retry on this thread after the last request failed${o ? `, choosing ${o.name}` : ''}. ${text === RETRY_WORD ? 'Carry out the last request in this thread again (it may be a follow-through note rather than a typed message).' : 'This is the same request again.'}`,
        ...(cur.model ? { model: cur.model, provider: cur.provider } : {}) });
      E?.cleared.set(sid, Date.now());
      toast('↻', o ? `Retrying on ${o.name}` : 'Retrying', 1600);
      if (c) follow(wid);
      return true;
    } catch (e) { toast('!', 'Couldn’t queue the retry', 2400); return false; }
    finally { retrying.delete(sid); if (c) c.retrying = ''; rerenderAll(); }
  }
  // Regeneration is a new, idempotent turn, never a history rewrite. Hydrate the
  // authorized display history so native screenshots and file chips survive too.
  async function regenerateThread(wid, sid) {
    const w = H.win(wid), c = w ? ch(wid) : null;
    if (!w || w.thread !== sid || !OUTBOX || c.regenerating || OUTBOX.unsent?.().some(it => it.sessionId === sid && it.how === 'regenerate')) return false;
    c.regenerating = true;
    try {
      const s = await LIVE.sessionInfo(sid);
      if (!s || LIVE.busy(sid) || ['queued','running','stopping','waiting_for_approval','unknown'].includes(s.status)) return false;
      const turns = window.WosChat.parseRows(await LIVE.messages(sid));
      const u = [...turns].reverse().find(t => t.u)?.u;
      if (!u) throw new Error('No owner request');
      const files = [...u.files];
      for (const [i, url] of (u.images || []).entries()) {
        const m = /^\/wizard\/files\/([A-Za-z0-9._:-]+)\/content$/.exec(url);
        if (m && files.some(f => f.id === m[1])) continue;
        if (!/^data:image\//.test(url) && !/^\/wizard\/(files|attachments)\//.test(url)) throw new Error('Image unavailable');
        const response = await fetch(url, { credentials: 'same-origin', cache: 'no-store' });
        if (!response.ok) throw new Error('Image unavailable');
        const blob = await response.blob();
        if (!blob.size || blob.size > 32 * 1024 * 1024 || !/^image\//.test(blob.type)) throw new Error('Image unavailable');
        files.push(await window.WizUploads.upload(new File([blob], `image-${i + 1}.${blob.type === 'image/png' ? 'png' : 'jpg'}`, { type: blob.type })));
      }
      if (!u.text && !files.length && !u.reply) throw new Error('No owner request');
      const cur = threadModel(s);
      await OUTBOX.enqueue({ kind:'reply', sessionId:sid, wid, text:u.text || '', files, ...(u.reply ? { reply:u.reply } : {}),
        how:'regenerate', source:'chat', instructions:'The owner pressed Regenerate on the last response. Answer the same owner request again, using its attached files. Preserve this thread’s selected model.',
        ...(cur.model ? { model:cur.model, provider:cur.provider } : {}) });
      follow(wid); toast('↻','Regenerating',1600); return true;
    } catch (_) { toast('!', 'Couldn’t regenerate · original request kept',2600); return false; }
    finally { c.regenerating = false; rerenderAll(); }
  }
  const RECONNECT_APPS = new Set(['wizard-claude', 'wizard-chatgpt']);
  function openReconnect(appId, installed, runId = '') {
    if (!RECONNECT_APPS.has(appId)) return false;
    const provider = appId === 'wizard-claude' ? 'claude' : 'chatgpt';
    if (window.WizOpenApp?.('troubleshooter', `/troubleshoot/?provider=${provider}&run_id=${encodeURIComponent(runId)}`)) return true;
    return !!H.openLink?.(`/troubleshoot/?provider=${provider}&run_id=${encodeURIComponent(runId)}`, 'Fix Wizard');

  }
  async function dismissThread(sid) {
    const pending = E?.dismissFailure(sid); rerenderAll();
    const ok = await pending;
    toast(ok ? '✓' : '!', ok ? 'Dismissed · history kept' : 'Couldn’t dismiss · try again', ok ? 1400 : 2600);
    rerenderAll();
  }
  function rerenderAll() { for (const id of Object.keys(A.CH)) { const w = H.win(id); if (w) A.renderChats(w); } H.changed?.(); }

  /* Errors section extras: background work Wizard flagged (/wizard/attention) and voice notes that didn't send. */
  const voiceFailed = () => (OUTBOX ? OUTBOX.unsent().filter(it => it.state === 'failed' && (it.audio || it.audioFile)) : []);
  let confirmDel = { id: '', at: 0 };
  function errorsFilter(list) { return E ? list.filter(s => !E.dismissed(s.id)) : list; }
  function errorRow(s, rowHtml) {
    if (!E) return rowHtml;
    const busy = E.busy.get(s.id);
    const rc = s.reconnect ? `<button type="button" data-chreconnect="${esc(s.reconnect.appId)}" data-recovery-run="${esc(s.reconnect.runId || '')}">Sign in</button>` : '';
    if (rc) return `<div class="ch-err diagnosed" data-errsid="${esc(s.id)}">${rowHtml}</div>`;
    return `<div class="ch-err" data-errsid="${esc(s.id)}">${rowHtml}<div class="ch-err-b">${rc}<button type="button"${rc ? ' class="ghost"' : ''} data-errretry="${esc(s.id)}" ${busy ? 'disabled' : ''}>Retry</button><button type="button" class="ghost" data-errdismiss="${esc(s.id)}" ${busy ? 'disabled' : ''}>${busy === 'dismiss' ? 'Dismissing…' : 'Dismiss'}</button></div></div>`;
  }
  function errorsExtra() {
    if (!E) return { n: 0, html: '' };
    if (!E.ready && !E.loading) E.load();
    const att = E.items, vf = voiceFailed();
    const html = att.map(a => `<div class="ch-err att" data-errattn="${esc(a.id)}"><div class="ch-err-t"><b>${esc(a.title)}</b><small>${esc(clip(a.detail || 'Recovery controls are available here.', 140))}</small></div><div class="ch-err-b">`
        + `${a.canRetry ? `<button type="button" data-attretry="${esc(a.id)}" ${E.busy.has(a.id) ? 'disabled' : ''}>${E.busy.get(a.id) === 'retry' ? 'Retrying…' : 'Retry'}</button>` : ''}`
        + `${a.sessionId && LIVE.session(a.sessionId) ? `<button type="button" class="ghost" data-chopen="${esc(a.sessionId)}">Open</button>` : ''}`
        + `<button type="button" class="ghost" data-attdismiss="${esc(a.id)}" ${E.busy.has(a.id) ? 'disabled' : ''}>${E.busy.get(a.id) === 'dismiss' ? 'Dismissing…' : 'Dismiss'}</button></div></div>`).join('')
      + vf.map(it => {
        const sure = confirmDel.id === it.id && Date.now() - confirmDel.at < 4000;
        return `<div class="ch-err ch-err-vn" data-errob="${esc(it.id)}"><div class="ch-err-t"><b>${A.MIC_SVG}Voice note${it.text || it.typed ? ` · ${esc(clip(it.text || it.typed, 60))}` : ''}</b><small>Not sent · ${esc(it.error || 'Wizard didn’t take it')}</small></div><div class="ch-err-b">`
          + ` ${OUTBOX.canRetry(it) ? `<button type="button" data-obretry="${esc(it.id)}">Retry</button>` : ''}<button type="button" class="ghost${sure ? ' warn' : ''}" data-obdismiss="${esc(it.id)}">${sure ? 'Delete recording?' : 'Dismiss'}</button></div></div>`;
      }).join('');
    return { n: att.length + vf.length, html };
  }
  if (E) E.onChange(() => rerenderLists());
  function rerenderLists() { for (const id of Object.keys(A.CH)) { const w = H.win(id); if (w && !w.thread) A.renderChats(w); } }

  /* ================= #13 composer mic ================= */
  // On while a take pinned to THIS thread is recording (recordingFor() names the thread the take belongs to).
  // While its take records, the mic IS the send button (arrow, recording ring); otherwise it is the mic.
  const SEND_SVG = '<svg class="snd" viewBox="0 0 24 24"><path d="M12 19V5M5 12l7-7 7 7"/></svg>';
  const micBtn = wid => { if (!H.recordReply) return ''; const sid = H.win(wid)?.thread, on = !!sid && H.recordingFor?.() === sid; return `<button type="button" class="ch-mic${on ? ' on' : ''}" data-chmic aria-pressed="${on}" aria-label="${on ? 'Send this voice reply' : 'Record a voice reply to this thread'}" title="${on ? 'Send voice reply' : 'Voice reply to this thread'}">${A.MIC_SVG.replace('<svg ', '<svg class="mc" ')}${SEND_SVG}</button>`; };
  /* A recording made from a thread's composer: always delivered to that thread (pinned when recording started),
   * through the durable outbox, which transcribes it and keeps the recording as a voice note. */
  async function sendVoiceTo(wid, sid, blob, files = [], seal = true, route = null, custodyId = null, captureId = null, capturedRunId = undefined, transcript = '') {
    if (!OUTBOX || !blob || !sid) return null;
    const w = H.win(wid), c = ch(wid);
    const isNew = sid === '__new__';
    const s = isNew ? null : LIVE.session(sid);
    const steerRunId = capturedRunId ?? (A.isWorking(s) && s.runId ? s.runId : '');
    const nm = route || (isNew ? (c.newModel || null) : null);
    // The thread's composer rides with the recording as ONE message (legacy H4): the words typed or pasted
    // there (a link, say) go before the transcript, its photos and files with the voice note, and the composer
    // empties. seal: the composer taken at the send tap (chats.js takeComposer); true takes it now; false for the
    // later parts of an interrupted take, so nothing goes twice.
    const sealed = seal === true ? A.takeComposer(wid, sid) : seal || { text: '', files: [], done() {}, putBack() {} };
    const all = [...(files || []), ...sealed.files].filter((f, i, a) => f && f.id && a.findIndex(x => x.id === f.id) === i).slice(0, 8);
    const wasHere = !!w && w.thread === sid;
    if (isNew) c.newModel = null;
    follow(wid);
    const instructions = H.viewContext(wid, 'a voice reply recorded in this thread');
    // Send and go: a voice reply steps back one level like a typed send (chats.js), on
    // the tap, not after the recording has been written to the phone's storage (a blob commit can take seconds).
    const hold = !isNew ? LIVE.holdSend?.(sid) || null : null;
    const left = w && A.leaveAfterSend?.(wid, sid, isNew, 'voice reply in this thread');
    if (w) A.renderChats(w);
    let it;
    try {
      it = await OUTBOX.enqueue({ captureId, custodyId, sealKey: sealed.key, kind: isNew ? 'new' : 'reply', sessionId: isNew ? '' : sid, steerRunId, text: transcript ? [sealed.text, transcript].filter(Boolean).join('\n\n') : '', typed: sealed.text, audio: blob,
        instructions, files: all.map(f => ({ id: f.id, name: f.name, mime: f.mime, bytes: f.bytes })), ...(sealed.reply ? { reply: sealed.reply } : {}),
        wid: isNew ? wid : (wasHere ? wid : ''), how: 'voice reply in this thread', source: 'chat', ...(nm ? { model: nm.model, provider: nm.provider } : {}), ...(isNew && (nm?.agent || A.winAgent(w)) ? { agent: nm?.agent || A.winAgent(w) } : {}) });
    } catch (e) { // not saved anywhere: the words and attachments go back, and so does James if he is still on the list
      if (hold) LIVE.releaseSend?.(hold);
      if (isNew && nm) c.newModel = nm;
      sealed.putBack();
      if (left) left.restore();
      throw e;
    }
    sealed.done(it);
    return it;
  }
  function paintMic(on, sid) {
    H.root().querySelectorAll('[data-chmic]').forEach(b => { const id = b.closest('[data-chats]')?.dataset.chats, x = !!on && !!sid && H.win(id)?.thread === sid; b.classList.toggle('on', x); b.setAttribute('aria-pressed', String(x)); b.setAttribute('aria-label', x ? 'Send this voice reply' : 'Record a voice reply to this thread'); });
  }

  /* ================= sheets: model picker, Files ================= */
  let sheet = null; // { type: 'model'|'files', pane, wid, sid, mode, all, list, q, kind }
  let popOff = null;
  function closeSheet() {
    popOff?.(); popOff = null;
    if (!sheet) return false;
    H.root().querySelectorAll('.ch-psheet').forEach(n => n.remove());
    sheet = null; return true;
  }
  function paint(paneId, el) {
    if (!sheet || sheet.pane !== paneId || !el) return;
    popOff?.(); popOff = null;
    el.querySelectorAll('.ch-psheet').forEach(n => n.remove());
    let html = '';
    if (sheet.type === 'model') {
      const opt = { mode: sheet.mode, cur: sheet.cur, all: sheet.all, title: '', agent: sheet.agent || null, priv: sheet.priv || null };
      const r = sheet.pop && M.popHtml ? M.popHtml(opt) : M.sheetHtml(opt);
      sheet.list = r.list; html = r.html;
    } else if (sheet.type === 'files') {
      const tw = H.win(sheet.wid), c = ch(sheet.wid);
      html = F.panelHtml({ q: sheet.q, kind: sheet.kind, attach: !!tw?.thread, picked: (c.files || []).map(f => f.id).filter(Boolean), when: ms => `${A.KIT.time.day(ms)} ${A.KIT.time.clock(ms)}` });
    }
    el.insertAdjacentHTML('beforeend', html.replace('class="ch-sheet ', 'class="ch-sheet ch-psheet '));
    if (sheet.pop) {
      el.classList.add('ch-model-picking');
      placePop(el);
      const list = el.querySelector('.ch-mpop .msheet-list');
      if (list) list.scrollTop = list.scrollHeight; // current models nearest the thumb on open, not on resize
      const events = new AbortController();
      let frame = 0;
      const queue = () => { if (!frame) frame = requestAnimationFrame(() => { frame = 0; placePop(el); }); };
      const resize = new ResizeObserver(queue);
      [el, el.querySelector('.ch-compose'), el.querySelector('.ch-swrow'), el.querySelector('.ch-head')].filter(Boolean).forEach(n => resize.observe(n));
      window.addEventListener('resize', queue, { signal: events.signal });
      window.addEventListener('scroll', queue, { capture: true, passive: true, signal: events.signal });
      window.visualViewport?.addEventListener('resize', queue, { signal: events.signal });
      window.visualViewport?.addEventListener('scroll', queue, { signal: events.signal });
      popOff = () => {
        events.abort(); resize.disconnect(); cancelAnimationFrame(frame);
        el.classList.remove('ch-model-picking'); el.style.removeProperty('--mpop-input-max');
      };
    }
  }
  // Bound the card to the visible pane ABOVE the entire composer, not its bottom-right label.
  // The native document-scroller's composer is fixed; its overlay must share viewport coordinates.
  function placePop(el) {
    const pop = el.querySelector('.ch-psheet.ch-mpop'), lab = el.querySelector('.ch-mlabel'); if (!pop || !lab) return;
    const pr = pop.getBoundingClientRect(), lr = lab.getBoundingClientRect(); if (!pr.height) return;
    const vv = window.visualViewport;
    const top = Math.max(pr.top, vv?.offsetTop || 0, el.querySelector('.ch-head')?.getBoundingClientRect().bottom || 0) + 8;
    const occlusion = () => ['.ch-compose', '.ch-swrow'].map(s => el.querySelector(s)?.getBoundingClientRect()).filter(r => r?.height);
    const bottomEdge = () => Math.min(pr.bottom, (vv?.offsetTop || 0) + (vv?.height || innerHeight), lab.getBoundingClientRect().top, ...occlusion().map(r => r.top)) - 6;
    // A keyboard plus native dock can leave less than one row above a tall draft. Temporarily
    // scroll the input in a shorter box; keep its value/selection and restore its height on close.
    const ta = el.querySelector('.ch-compose textarea');
    if (ta) {
      const cap = Math.min(140, Math.max(42, Math.floor(ta.getBoundingClientRect().height + bottomEdge() - top - 112)));
      el.style.setProperty('--mpop-input-max', cap + 'px');
    }
    const bottom = bottomEdge();
    const right = Math.min(pr.right, (vv?.offsetLeft || 0) + (vv?.width || innerWidth), lr.right + 6) - 8;
    pop.style.setProperty('--mpop-b', `${Math.max(0, pr.bottom - bottom)}px`);
    pop.style.setProperty('--mpop-r', `${Math.max(8, pr.right - right)}px`);
    pop.style.setProperty('--mpop-h', `${Math.max(0, bottom - top)}px`);
  }
  function openSheet(o) {
    A.closeRowSheet(); closeSheet();
    sheet = o; const el = A.elOf(o.pane); paint(o.pane, el); H.overlay?.(true); A.vib(8);
  }
  function openModels(pane, mode, pop) {
    if (!M) return;
    const wid = A.owner(pane), w = H.win(wid); if (!w || !w.thread) return;
    const s = w.thread === '__new__' ? null : LIVE.session(w.thread);
    const cur = mode === 'new' ? newModel(ch(wid), w) : threadModel(s);
    const agent = agentOfWin(w, s);
    // The owner's main Chats also lists the private agents' models (unified Chats); an agent's own Chats does not.
    const priv = !agent && !A.winAgent(w) && mode !== 'retry' && M.privateOptions ? M.privateOptions() : null;
    openSheet({ type: 'model', pane, wid, sid: w.thread, mode, cur, retryRunId: s?.retryRunId || '', all: false, agent, priv, pop: !!pop && mode !== 'retry' });
    // Revalidate every open; repaint only if visible choices or the Claude status note changed.
    // WosModels.options is the catalogue array (never a function): compare the fields the sheet shows.
    const rows = list => (Array.isArray(list) ? list : []).map(o => [o.agent, o.provider, o.value, o.name, o.description, !!o.isGlobalDefault]);
    const key = () => JSON.stringify([rows(M.options), rows(M.privateOptions?.()), M.claudeNote?.()]);
    const opened = sheet, before = key();
    M.load(M.ready).then(() => {
      if (sheet !== opened || sheet?.type !== 'model' || H.win(wid)?.thread !== opened.sid) return;
      // A fresh default must agree with what Send will use. An explicit draft choice stays pinned.
      const cur = mode === 'new' ? newModel(ch(wid), w) : threadModel(LIVE.session(opened.sid));
      if (key() !== before || JSON.stringify(sheet.cur) !== JSON.stringify(cur)) { sheet.cur = cur; paint(sheet.pane, A.elOf(sheet.pane)); }
    });
  }
  function openFiles(pane) {
    if (!F) return;
    openSheet({ type: 'files', pane, wid: A.owner(pane), q: '', kind: 'all' });
    F.load().then(() => { if (sheet?.type === 'files') paint(sheet.pane, A.elOf(sheet.pane)); });
  }
  function attachExisting(f) {
    const sh = sheet; if (!sh) return;
    let w = H.win(sh.wid); if (!w) return;
    if (!w.thread) { A.openChat(sh.wid, '__new__'); w = H.win(sh.wid); }
    const c = ch(sh.wid); c.files = c.files || [];
    const had = c.files.findIndex(x => x.id === f.id);
    if (had >= 0) { c.files.splice(had, 1); toast('✕', 'Removed from this message', 1200); }
    else if (c.files.length >= 8) { toast('!', 'Up to 8 files per message', 2400); return; }
    else { c.files.push({ id: f.id, name: f.name, mime: f.mime, bytes: f.bytes, key: Math.random().toString(36).slice(2), preview: f.kind === 'image' ? F.media(f).url : '' }); toast('📎', `Attached · ${f.kind === 'voice' ? 'Voice note' : clip(f.name, 32)}`, 1400); }
    A.saveDraft(sh.wid); A.refreshCompose(sh.wid);
    paint(sh.pane, A.elOf(sh.pane));
  }

  /* ================= clicks, scroll, toggles ================= */
  function click(e, id) {
    const t = e.target;
    if (sheet && sheet.pane === id) {
      if (t.closest('[data-ficlose]') || (t.closest('.ch-psheet') && !t.closest('.ch-sheet-b'))) { closeSheet(); return true; }
      if (sheet.type === 'model') {
        if (t.closest('[data-mall]')) { sheet.all = true; paint(id, A.elOf(id)); if (sheet.pop) { const l = A.elOf(id)?.querySelector('.ch-mpop .msheet-list'); if (l) l.scrollTop = 0; } return true; }
        const p = t.closest('[data-mpick]'); if (p) { const o = sheet.list?.[+p.dataset.mpick]; if (o) pickModel(o); return true; }
      }
      if (sheet.type === 'files') {
        const k = t.closest('[data-fikind]'); if (k) { sheet.kind = k.dataset.fikind; paint(id, A.elOf(id)); return true; }
        const op = t.closest('[data-fiopen]'); if (op) { const f = F.get(op.dataset.fiopen); if (f) { const list = f.kind === 'image' ? F.filter(sheet.q, sheet.kind).filter(x => x.kind === 'image') : [f]; A.KIT.viewer.open(list.map(F.media), Math.max(0, list.indexOf(f))); } return true; }
        const at = t.closest('[data-fiattach]'); if (at) { const f = F.get(at.dataset.fiattach); if (f) attachExisting(f); return true; }
      }
      if (t.closest('.ch-psheet')) return true;
    }
    const w = H.win(id);
    if (t.closest('[data-chfiles]')) { openFiles(id); return true; }
    if (t.closest('[data-chmodel]')) { const ww = H.win(A.owner(id)); openModels(id, ww?.thread === '__new__' ? 'new' : 'thread', !!t.closest('.ch-mlabel')); return true; }
    if (t.closest('[data-chlatest]')) { const nb = A.elOf(id)?.querySelector('.ch-msgs'); if (nb) { follow(id); } return true; }
    if (t.closest('[data-chmic]')) {
      if (!w?.thread || !H.recordReply) return true;
      const r = H.recordReply(id, w.thread);
      Promise.resolve(r).then(st => { if (st === 'busy') toast('…', 'Finishing the last recording', 1400); });
      return true;
    }
    // Failed thread panel. Signed out: open the provider's connection app in this shell, or the Store on it.
    const rc = t.closest('[data-chreconnect]'); if (rc) { openReconnect(rc.dataset.chreconnect, rc.dataset.installed !== '0', rc.dataset.recoveryRun || ''); return true; }
    // Failed thread panel
    if (t.closest('[data-mregen]') && w?.thread) { regenerateThread(id, w.thread); return true; }
    if (t.closest('[data-chretry]') && w?.thread) { retryThread(id, w.thread); return true; }
    if (t.closest('[data-chretrymodel]') && w?.thread) { openModels(id, 'retry'); if (sheet) sheet.mode = 'retry'; paint(id, A.elOf(id)); return true; }
    if (t.closest('[data-chdismiss]') && w?.thread) { dismissThread(w.thread); return true; }
    // Errors section
    const er = t.closest('[data-errretry]'); if (er) { retryThread(A.owner(id), er.dataset.errretry); return true; }
    const ed = t.closest('[data-errdismiss]'); if (ed) { dismissThread(ed.dataset.errdismiss); return true; }
    const ar = t.closest('[data-attretry]'); if (ar) { E.retryAttention(ar.dataset.attretry).then(ok => toast(ok ? '↻' : '!', ok ? 'Retrying' : 'Couldn’t retry · try again', ok ? 1400 : 2400)); return true; }
    const ad = t.closest('[data-attdismiss]'); if (ad) { E.dismissAttention(ad.dataset.attdismiss).then(ok => toast(ok ? '✓' : '!', ok ? 'Dismissed' : 'Couldn’t dismiss · try again', ok ? 1400 : 2400)); return true; }
    const od = t.closest('[data-obdismiss]'); if (od) {
      const oid = od.dataset.obdismiss;
      if (confirmDel.id === oid && Date.now() - confirmDel.at < 4000) { if (od.disabled) return true; od.disabled = true; od.textContent = 'Deleting…'; confirmDel = { id: '', at: 0 }; OUTBOX.remove(oid).then(ok => { rerenderLists(); toast(ok ? '✕' : '!', ok ? 'Recording deleted' : 'Deletion not saved · keep Wizard open', 2400); }, () => { od.disabled = false; od.textContent = 'Delete'; toast('!', 'Deletion not saved · original kept', 2400); }); }
      else { confirmDel = { id: oid, at: Date.now() }; rerenderLists(); setTimeout(() => { if (confirmDel.id === oid) { confirmDel = { id: '', at: 0 }; rerenderLists(); } }, 4100); }
      return true;
    }
    return false;
  }
  function bind(root) {
    const contact = e => {
      const nb = e.target.closest?.('[data-chats]')?.querySelector('.ch-msgs');
      if (!onScreen(nb)) return;
      const c = ch(nb.closest('[data-chats]').dataset.chats); placed.delete(scrollBox(nb));
      c.placeTouching = e.type === 'touchstart' || e.type === 'touchmove'; c.placeUserAt = Date.now();
    };
    ['touchstart', 'touchmove', 'touchend', 'touchcancel', 'wheel'].forEach(e => root.addEventListener(e, contact, { capture: true, passive: true }));
    root.addEventListener('scroll', e => { const t = e.target; if (t && t.classList && t.classList.contains('ch-msgs')) onScroll(t); }, true);
    root.addEventListener('toggle', e => {
      const d = e.target; if (!d || !d.matches || !d.matches('details[data-wk]')) return;
      const id = d.closest('[data-chats]')?.dataset.chats; if (!id) return;
      const c = ch(id); c.wkOpen = c.wkOpen || new Set();
      if (d.open) c.wkOpen.add(d.dataset.wk); else c.wkOpen.delete(d.dataset.wk);
    }, true);
    root.addEventListener('input', e => {
      if (!e.target.matches('[data-fiq]') || !sheet || sheet.type !== 'files') return;
      sheet.q = e.target.value; const el = A.elOf(sheet.pane); paint(sheet.pane, el);
      const inp = el?.querySelector('[data-fiq]'); if (inp) { inp.focus(); inp.setSelectionRange(inp.value.length, inp.value.length); }
    });
  }
  const opened = (wid, sid) => { const c = ch(wid), s = sid && sid !== '__new__' ? LIVE.session(sid) : null; c.unreadOpen = s && LIVE.isNew(s) ? sid : ''; c.posFor = ''; if (sid !== '__new__') c.newModel = null; if (sheet && A.owner(sheet.pane) === wid && sheet.type === 'model') closeSheet(); };
  const holds = id => !!sheet && sheet.pane === id;
  async function tweakModels(wid) {
    const w = H.win(wid); if (!w) return [];
    await M.load(); const s = w.thread && w.thread !== '__new__' ? LIVE.session(w.thread) : null;
    const agent = agentOfWin(w, s), cur = s ? threadModel(s) : newModel(ch(wid), w);
    if (agent) return agent.missing ? [] : window.WosAgents.modelOptions(agent);
    return M.visible(cur?.model || '', cur?.provider || '').concat(!w.agent ? M.privateOptions() : []);
  }
  async function tweakModel(wid, choice, alive = () => true) {
    const w = H.win(wid); if (!w) return null;
    const sid = w.thread && w.thread !== '__new__' ? w.thread : '';
    if (!choice) return M.snapshot(sid, sid ? null : newModel(ch(wid), w), sid ? '' : A.winAgent(w));
    const target = w.thread, session = sid ? LIVE.session(sid) : null;
    const sameTarget = () => alive() && H.win(wid) === w && w.thread === target && (!sid || LIVE.session(sid) === session);
    const options = await tweakModels(wid);
    if (!sameTarget()) return null;
    const m = options.find(x => x.value === choice.id && x.provider === choice.provider && (x.agent || '') === (choice.agent || ''));
    if (!m) throw new Error('That model is unavailable');
    await pickModel(m, { wid, sid, alive: sameTarget, mode: sid ? 'thread' : 'new' });
    return sameTarget() ? tweakModel(wid) : null;
  }
  return { tweakModels, tweakModel, position, capture, resume, reflow, follow, restore, anchorOf, latestBtn, filesBtn, workHtml, modelChip, modelLabel, modelSwitch: (w, s) => M?.ours?.() ? modelSwitch(w, s) : '', ensureModels, failureHtml, errorsFilter, errorRow, errorsExtra, micBtn, sendVoiceTo, paintMic,
    paint, closeSheet, sheetOpen: () => !!sheet, click, bind, opened, holds, openFiles, openModels, retryThread, FOLDER_SVG, RP, newModel: c => c.newModel || null };
};
