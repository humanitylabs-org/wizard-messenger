/* One Send to <agent> sheet for Android imports and installed apps, on both shells.
 * REUSE: WizAttachChip, WosAgents, Chats/outbox, Android ShareService and WizSheetBack (double-Back guard). EXTEND: share-wizard.js. */
(() => {
  'use strict';
  if (window.WizShareWizard) return;
  const host = () => window.__wos || window.__wux;
  const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
  const blob = x => x && ['[object Blob]', '[object File]'].includes(Object.prototype.toString.call(x));
  let active = null, jobs = 0, lane = Promise.resolve(); const retries = [];
  // One delivery at a time borrows a Chats window: two jobs sharing a temporary window would let the first close it
  // under the second. Uploads still run in parallel; only open + send + close is serialised.
  const inLane = fn => { const p = lane.then(fn, fn); lane = p.catch(() => {}); return p; };
  function valid(data) {
    const files = data?.files ?? [];
    if (!Array.isArray(files) || files.length > 10 || files.some(f => !blob(f)) || files.reduce((n,f) => n + f.size, 0) > 100 * 1048576) throw new Error('Use up to 10 files / 100 MB');
    if (data?.text != null && (typeof data.text !== 'string' || data.text.length > 100000)) throw new Error('Use up to 100000 characters');
    if (data?.title != null && (typeof data.title !== 'string' || data.title.length > 200)) throw new Error('Invalid share title');
    if (!files.length && !data?.text?.trim()) throw new Error('Nothing to share');
    return {files, text: data?.text || '', title: data?.title || ''};
  }
  // Match WosAgents' routing-ID contract. Never repair malformed/ambiguous identities.
  function shareAgents(rows) {
    if (!Array.isArray(rows)) throw new Error('Agents unavailable');
    const seen = new Set(), agents = rows.filter(Boolean);
    for (const a of agents) {
      if (typeof a.id !== 'string' || !/^[a-z0-9][a-z0-9-]{0,40}$/.test(a.id) || seen.has(a.id) || (a.is_default !== undefined && typeof a.is_default !== 'boolean')) throw new Error('Agents unavailable');
      seen.add(a.id);
    }
    if (!agents.length || agents.filter(a => a.is_default === true).length > 1) throw new Error('Agents unavailable');
    return agents;
  }
  function initialAgent(agents, options) {
    const explicit = Object.hasOwn(options, 'agent');
    if (explicit && typeof options.agent !== 'string') throw new Error('Selected agent is unavailable');
    const selected = explicit ? agents.find(a => options.agent === '' ? a.is_default === true : a.id === options.agent) : agents.find(a => a.is_default === true) || agents[0];
    if (!selected) throw new Error('Selected agent is unavailable');
    return selected;
  }
  // Android's filename-only subject / "Emailing file.pdf" is metadata, never the owner's comment.
  // Match the WHOLE value, not a substring: a real note mentioning a filename must survive.
  function sharedText({text = '', subject = '', items = []} = {}) {
    const names = items.map(f => String(f.name || '').trim().toLowerCase()).filter(Boolean);
    const boilerplate = s => names.includes(s.toLowerCase()) || (/^emailing\s+/i.test(s) && names.includes(s.replace(/^emailing\s+/i, '').toLowerCase()));
    return [...new Set([subject, text].map(s => String(s || '').trim()).filter(s => s && !boilerplate(s)))].join('\n');
  }
  function finish(result, pending) {
    const a = active; if (!a) return;
    active = null; clearTimeout(a.hintTimer); a.abort.abort(); a.el.remove(); a.mount.classList.remove('dv-share-open');
    a.urls.forEach(u => URL.revokeObjectURL(u)); if (result === 'cancelled') a.onCancelled?.(); if (!pending) a.resolve(result); a.focus?.focus?.();
    const next = retries.shift(); if (next) setTimeout(() => open(...next.args).then(next.resolve), 0); // a failed send waiting its turn
  }
  // Hardware/system Back and Escape only (core/sheetback.js, ported from the live Android SheetBack): a chooser closes
  // first; a sheet holding a comment or shared items warns once and cancels on a second Back inside the window.
  // Cancel, the X and the scrim call finish() directly: explicit closes stay immediate.
  const clock = () => window.performance?.now?.() ?? Date.now();
  function back() {
    if (!active) return false;
    const a = active, SB = window.WizSheetBack;
    if (!a.sb || !SB) { if (a.picker) a.closePicker(); else finish('cancelled'); return true; } // policy module absent: plain Back
    const act = a.sb.back(clock(), a.hasContent());
    if (act === SB.Action.CLOSE_CHOOSER) a.closePicker();
    else if (act === SB.Action.WARN) a.warn();
    else finish('cancelled');
    return true;
  }
  // durable (native shares sent by the web upload): resolve 'sent' only once the message has a receipt, so the caller
  // keeps its staged copy until then; a failed send resolves with whatever the owner does with the retry sheet.
  function open(options = {}, authorize = () => true) {
    const {items = [], title = '', from = '', skipped = 0, stay = false, comment = '', error = '', dest = '__new__', agent = '', nativeQueue, onPresented, onCancelled, durable = false} = options;
    const text = options.android ? sharedText(options) : String(options.text || '').trim(), w = host(), chats = w?.chats;
    if (!w || !chats?.uploadFile || !chats?.sendChat || !(w.openWizardThread || w.openThread) || active) return Promise.resolve('unsupported');
    const mount = document.querySelector('#device') || document.body;
    const el = document.createElement('div'); el.className = 'wz-share dv-wrap open'; el.dataset.dv = 'share';
    const kind = f => /^image\//.test(f.mime) ? 'image' : 'file';
    const kept = items.map(() => true), urls = [];
    // Never read an Android file for a thumbnail: URI staging/upload stays native, without base64 on the UI thread.
    const preview = items.map(f => { if (kind(f) !== 'image' || !f.blob || f.bytes >= 6e6) return ''; const u = URL.createObjectURL(f.blob); urls.push(u); return u; });
    const chip = (f, n) => window.WizAttachChip ? window.WizAttachChip.html({key: String(n), name: f.name, bytes: f.bytes, kind: kind(f), preview: preview[n] || ''})
      : `<span class="ch-att" data-attkey="${n}"><span class="nm">${esc(f.name)}</span><button type="button" class="ch-attrm" data-attrm="${n}" aria-label="Remove ${esc(f.name)}">×</button></span>`;
    const origin = from ? `From ${from}` : title ? (/^forwarded from /i.test(title) ? title : `Forwarded from ${title}`) : '';
    el.innerHTML = `<div class="dv-scrim" data-dvclose></div><section class="dv-sheet" role="dialog" aria-modal="true" aria-label="Send to agent" tabindex="-1">
      <div class="dv-grab" aria-hidden="true"></div>
      <div class="dv-head"><div><b class="dv-title">Send to ${esc(window.WizConfig?.agent?.() || 'Wizard')}</b><small>${esc(origin)}${skipped ? ` · ${skipped} unreadable items skipped` : ''}</small></div><button class="dv-cancel" data-dvclose aria-label="Cancel share"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M6 6l12 12M18 6L6 18"/></svg></button></div>
      <div class="dv-compose"><textarea class="dv-text" rows="2" aria-label="Your comment" placeholder="Add a comment (optional)">${esc(comment)}</textarea>
        <div class="dv-sharing"><h4>Sharing</h4><div class="dv-items">${items.map(chip).join('')}</div>${text ? `<blockquote class="dv-quote" aria-label="Shared content (not editable)" tabindex="0">${esc(text)}</blockquote>` : ''}</div></div>
      <div class="dv-dest">
        <button type="button" class="dv-row dv-agent" aria-haspopup="listbox" aria-expanded="false"><span>Agent</span><strong>Loading…</strong><span aria-hidden="true">⌄</span></button>
        <button type="button" class="dv-row dv-chat" aria-haspopup="listbox" aria-expanded="false"><span>Chat</span><strong>New chat</strong><span aria-hidden="true">⌄</span></button>
      </div>
      <button class="dv-btn primary wide dv-send" data-sharesend disabled><span>Send</span><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M5 12h13M13 6l6 6-6 6"/></svg></button>
      <div class="dv-status" aria-live="polite">${esc(error)}</div>
      <div class="dv-backhint" role="status" aria-live="polite"></div></section>`;
    return new Promise(resolve => {
      const a = active = {el, mount, resolve, urls, focus: document.activeElement, abort: new AbortController(), picker: '', onCancelled, sb: window.WizSheetBack?.create(), hintTimer: 0};
      const $ = q => el.querySelector(q), status = $('.dv-status');
      let agents = [], chosenAgent = null, target = dest, threads = [], loadSeq = 0, loading = true;
      const route = () => chosenAgent?.is_default === true ? '' : chosenAgent?.id || '';
      const label = () => chosenAgent?.label || window.WizConfig?.agent?.() || 'Wizard';
      a.hasContent = () => !!$('.dv-text').value.trim() || !!text.trim() || kept.some(Boolean); // anything the owner could lose
      a.clearHint = () => { clearTimeout(a.hintTimer); const h = $('.dv-backhint'); if (h) h.textContent = ''; };
      a.warn = () => { clearTimeout(a.hintTimer); $('.dv-backhint').textContent = window.WizSheetBack.HINT; a.hintTimer = setTimeout(a.clearHint, window.WizSheetBack.WINDOW_MS); };
      a.closePicker = () => { const was = a.picker; a.picker = ''; if (was) { a.sb?.closeChooser(); $(`.dv-${was}`)?.focus({preventScroll:true}); } $('.dv-picker-wrap')?.remove(); el.querySelectorAll('[aria-expanded]').forEach(b => b.setAttribute('aria-expanded', 'false')); };
      const paint = () => {
        $('.dv-title').textContent = `Send to ${label()}`; $('[role=dialog]').setAttribute('aria-label', `Send to ${label()}`);
        $('.dv-agent strong').textContent = chosenAgent ? label() : 'Unavailable';
        $('.dv-chat strong').textContent = target === '__new__' ? 'New chat' : threads.find(s => s.id === target)?.title || options.destLabel || 'Selected chat';
        $('[data-sharesend]').disabled = !chosenAgent || chosenAgent.status !== 'running' || loading;
      };
      const showPicker = which => {
        a.closePicker(); a.picker = which; a.sb?.openChooser(); a.clearHint();
        const wrap = document.createElement('div'); wrap.className = 'dv-picker-wrap';
        const rows = which === 'agent' ? agents.map(g => ({id:g.id, title:g.label, disabled:g.status !== 'running', on:g.id === chosenAgent?.id}))
          : [{id:'__new__', title:'+ New chat', on:target === '__new__'}, ...threads.map(s => ({id:s.id, title:s.title || 'Untitled chat', on:s.id === target}))];
        wrap.innerHTML = `<div class="dv-picker-scrim"></div><div class="dv-picker" role="listbox" aria-label="${which === 'agent' ? 'Agent' : 'Chat'}"><h4>${which === 'agent' ? 'Agent' : 'Chat'}</h4>${rows.map((r,i) => `${which === 'chat' && i === 1 ? `<small>Recent chats with ${esc(label())}</small>` : ''}<button type="button" role="option" aria-selected="${!!r.on}" data-dvpick="${esc(r.id)}"${r.disabled ? ' disabled' : ''}><span>${esc(r.title)}${r.disabled ? ' · Stopped' : ''}</span>${r.on ? '<span aria-hidden="true">✓</span>' : ''}</button>`).join('')}</div>`;
        $('.dv-sheet').append(wrap); $(`.dv-${which}`).setAttribute('aria-expanded', 'true');
        wrap.querySelector('[aria-selected=true]:not(:disabled)')?.focus({preventScroll:true});
      };
      const loadThreads = async (initial = false) => {
        const seq = ++loadSeq, agentId = route(); target = initial ? dest : '__new__'; threads = []; loading = true; a.closePicker(); paint();
        try {
          const r = await fetch(`/wizard/hermes/api/sessions?limit=40&offset=0&include_children=false${agentId ? `&agent=${encodeURIComponent(agentId)}` : ''}`, {credentials:'same-origin', cache:'no-store', signal:a.abort.signal});
          if (!r.ok) throw new Error('Chats unavailable');
          const j = await r.json(); if (active !== a || seq !== loadSeq) return;
          threads = (Array.isArray(j.data) ? j.data : Array.isArray(j.sessions) ? j.sessions : Array.isArray(j.items) ? j.items : [])
            .map(s => ({...s,id:s.id || s.session_id})).filter(s => s.id && !s.archived && !s.hidden).slice(0,40);
          // Keep an explicit retry destination even when it is outside this first page.
        } catch (e) {
          if (active !== a || seq !== loadSeq) return;
          if (e.name !== 'AbortError') status.textContent = 'Recent chats unavailable · you can still start a new chat';
        } finally { if (active === a && seq === loadSeq) { loading = false; paint(); } }
      };
      mount.append(el); mount.classList.add('dv-share-open'); $('[role=dialog]').focus({preventScroll:true});
      // Native cold start reveals the WebView only once this exact sheet has mounted.
      onPresented?.();
      (async () => {
        try {
          if (window.WosAgents) { agents = await window.WosAgents.load(true); if (window.WosAgents.error) throw new Error('Agents unavailable'); }
          else {
            const r = await fetch('/wizard/v1/agents', {credentials:'same-origin', signal:a.abort.signal});
            if (r.status !== 404 && !r.ok) throw new Error('Agents unavailable');
            agents = r.status === 404 ? [{id:'hermes', label:window.WizConfig?.agent?.() || 'Wizard', is_default:true, status:'running'}] : (await r.json()).agents || [];
          }
          if (active !== a) return;
          agents = shareAgents(agents);
          chosenAgent = initialAgent(agents, options);
          await loadThreads(true);
        } catch (e) { if (active === a && e.name !== 'AbortError') { loading = false; status.textContent = 'Couldn’t load agents · close and try again'; paint(); } }
      })();
      el.addEventListener('click', e => {
        if (e.target.closest('.dv-picker-scrim')) return a.closePicker();
        const opt = e.target.closest('[data-dvpick]');
        if (opt) {
          if (a.picker === 'agent') {
            const g = agents.find(g => g.id === opt.dataset.dvpick); if (!g || g.status !== 'running') return;
            chosenAgent = g; status.textContent = ''; loadThreads();
          } else { target = opt.dataset.dvpick; a.closePicker(); paint(); }
          return;
        }
        if (e.target.closest('[data-dvclose]')) return a.picker ? a.closePicker() : finish('cancelled'); // explicit close: immediate
        if (e.target.closest('.dv-agent')) return showPicker('agent');
        if (e.target.closest('.dv-chat')) return showPicker('chat');
        const rm = e.target.closest('[data-attrm]');
        if (rm) { kept[Number(rm.dataset.attrm)] = false; rm.closest('[data-attkey]')?.remove(); return; }
        if (!e.target.closest('[data-sharesend]') || $('[data-sharesend]').disabled) return;
        if (!authorize()) return finish('unsupported');
        const note = [$('.dv-text').value.trim(), text.trim()].filter(Boolean).join('\n\n'), chosen = items.filter((_, n) => kept[n]);
        if (!note && !chosen.length) { status.textContent = 'Add a comment first'; return; }
        let files = [];
        try { if (!nativeQueue || !chosen.length) files = chosen.map(f => f.blob ? new File([f.blob], f.name, {type:f.mime}) : {name:f.name,type:f.mime,read:f.read}); }
        catch (_) { status.textContent = 'Couldn’t read a shared item · remove it and try again'; return; }
        const job = {files, note, target, targetLabel:$('.dv-chat strong').textContent, agent:route(), agentLabel:label(), stay, title, text, from, comment:$('.dv-text').value, authorize, durable,
          nativeQueue: chosen.length ? nativeQueue : null, keptItemIndexes:items.flatMap((f,n) => kept[n] ? [f.n ?? n] : []), items:chosen, onPresented, onCancelled};
        const done = a.resolve;
        finish('sent', durable);
        const p = deliver(w, chats, job);
        if (durable) p.then(done, () => done('failed'));
      });
    });
  }
  async function deliver(w, chats, job) {
    jobs++;
    try {
      if (!job.authorize()) return 'unsupported';
      if (job.nativeQueue) { await job.nativeQueue(job); return 'sent'; }
      const uploaded = [];
      for (let n = 0; n < job.files.length; n++) {
        let f = job.files[n];
        if (!blob(f)) { const data = await f.read(); if (!blob(data)) throw new Error('Shared file is unavailable'); f = job.files[n] = new File([data], f.name, {type:f.type}); }
        if (!job.authorize()) return 'unsupported'; // permission may change while reading native bytes
        uploaded.push(await chats.uploadFile(f));
      }
      if (!job.authorize()) return 'unsupported'; // the app lost its share permission while uploading
      return await inLane(() => job.authorize() ? carry(w, chats, job, uploaded) : 'unsupported');
    } catch (_) {
      w.toast?.('!', 'Couldn’t send · try again', 3200);
      const args = [{items:job.items, text:job.text, title:job.title, from:job.from,
        nativeQueue:job.nativeQueue, onPresented:job.onPresented, onCancelled:job.onCancelled, agent:job.agent, stay:job.stay, durable:job.durable, comment:job.comment, dest:job.target, destLabel:job.targetLabel, error:'Couldn’t send · check the connection and try again'}, job.authorize];
      return new Promise(resolve => { if (active) retries.push({args, resolve}); else open(...args).then(resolve); });
    } finally { jobs--; }
  }
  async function carry(w, chats, job, uploaded) {
    {
      const before = new Set(Object.keys(w.wins || {})), deskWas = w.idx, focusWas = w.cur ?? w.desks?.[w.idx]?.focus;
      let wid = Object.keys(w.wins || {}).find(k => w.wins[k].app === 'chats' && !w.wins[k].agent), opened = false;
      if (!wid) {
        (w.openWizardThread || w.openThread)(job.target);
        wid = Object.keys(w.wins).find(k => w.wins[k].app === 'chats' && w.wins[k].thread === job.target);
        opened = !!wid && !before.has(wid);
        if (deskWas != null && w.idx !== deskWas) w.goDesk?.(deskWas, true);
        if (focusWas != null && w.wins?.[focusWas]) w.focusWin?.(focusWas);
      }
      if (!wid) throw new Error('No chat window');
      let receipt;
      try { receipt = await chats.sendChat(wid, job.note, 'shared to Wizard', null, {sid:job.target, files:uploaded, agent:job.agent, seal:false, away:true}); }
      finally { if (opened && w.wins?.[wid]) w.closeWin?.(wid, true); }
      if (!receipt) throw new Error('Could not save the message');
      if (!job.stay) w.toast?.('✦', `Sent to ${job.agentLabel}`, 1800);
      return 'sent';
    }
  }
  function wizard(data, authorize) {
    const p = valid(data);
    return open({stay:true,text:p.text,title:p.title,items:p.files.map((f,n) => ({name:f.name || `attachment-${n+1}`,mime:f.type,bytes:f.size,blob:f}))}, authorize);
  }
  document.addEventListener('keydown', e => {
    if (!active) return;
    if (e.key === 'Escape') { e.preventDefault(); e.stopImmediatePropagation(); if (!e.repeat) back(); return; } // a held key is one press
    if (active.picker && ['ArrowDown','ArrowUp','Home','End'].includes(e.key)) {
      const opts = [...active.el.querySelectorAll('.dv-picker button:not(:disabled)')];
      const at = opts.indexOf(document.activeElement), next = e.key === 'Home' ? 0 : e.key === 'End' ? opts.length - 1 : (at + (e.key === 'ArrowDown' ? 1 : -1) + opts.length) % opts.length;
      e.preventDefault(); opts[next]?.focus({preventScroll:true}); opts[next]?.scrollIntoView({block:'nearest'}); return;
    }
    if (active.picker && e.key === 'Tab') active.closePicker();
    if (e.key === 'Tab') {
      const xs = [...active.el.querySelectorAll('button:not(:disabled),textarea,[tabindex="0"]')], first = xs[0], last = xs.at(-1);
      if (e.shiftKey && (document.activeElement === first || !xs.includes(document.activeElement))) {e.preventDefault();last?.focus();}
      else if (!e.shiftKey && (document.activeElement === last || !xs.includes(document.activeElement))) {e.preventDefault();first?.focus();}
    }
  }, true);
  window.WizShareWizard = Object.freeze({open,wizard,valid,sharedText,back,get isOpen() {return !!active;},get busy() {return !!active || jobs > 0;}});
})();
