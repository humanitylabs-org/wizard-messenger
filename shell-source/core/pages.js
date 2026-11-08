/* Pages: shared owner UI. Agent-authored frames are opaque, never hosted-app clients. */
(() => {
  'use strict';
  const API = '/wizard/v1/pages', SANDBOX = 'allow-scripts allow-forms allow-popups allow-downloads';
  const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
  const slugValid = s => typeof s === 'string' && /^[a-z0-9][a-z0-9._-]{0,79}$/.test(s) && !s.includes('..');
  const fileValid = f => typeof f === 'string' && !f.includes('..') && !/[\\\0]/.test(f) && !f.split('/').includes('page.json') && f.split('/').length <= 8 && f.split('/').every(p => /^[A-Za-z0-9][A-Za-z0-9 ._()+-]{0,127}$/.test(p));
  const sorted = pages => (pages || []).filter(p => slugValid(p.slug) && p.status !== 'archived').slice().sort((a,b) => String(b.updated || '').localeCompare(String(a.updated || '')) || a.slug.localeCompare(b.slug));
  const stamp = value => window.WosChat?.time?.stamp(Date.parse(value)) || '';
  function listHtml(pages) {
    const rows = sorted(pages);
    return rows.length ? rows.map(p => `<button class="pg-row" data-pg-open="${esc(p.slug)}"><b>${esc(p.title)}</b><small>${esc([p.kind, p.project, stamp(p.updated)].filter(Boolean).join(' · '))}</small></button>`).join('') : '<p class="pg-empty">Pages your agent makes appear here. Reports, documents and dashboards — no installation needed.</p>';
  }
  async function request(path = '', method = 'GET', body) {
    const r = await fetch(API + path, {method, credentials:'same-origin', cache:'no-store', signal: AbortSignal.timeout(15000), ...(body === undefined ? {} : {headers:{'Content-Type':'application/json'}, body:JSON.stringify(body)})});
    const data = await r.json().catch(() => ({}));
    if (!r.ok) throw Object.assign(new Error(data.error || `Pages unavailable (${r.status})`), {status:r.status, data});
    return data;
  }
  // No cache: old/offline services must never acquire a phantom system tile.
  const listeners = new Set();
  let available = false, pages = [], pending = null;
  async function discover() {
    try { const d = await request(); pages = sorted(d.pages); available = true; }
    catch (_) { available = false; pages = []; }
    listeners.forEach(fn => fn());
    return available;
  }
  function client(slug) {
    if (!slugValid(slug)) throw new Error('invalid_page');
    const base = '/' + encodeURIComponent(slug);
    return {
      read: file => request(base + '/' + file.split('/').map(encodeURIComponent).join('/')),
      save: (file, text, version) => request(base + '/' + file.split('/').map(encodeURIComponent).join('/'), 'PUT', {text, version}),
      history: (file = 'doc.md') => request(base + '/history?file=' + encodeURIComponent(file)),
      restore: (commit, file = 'doc.md') => request(base + '/restore', 'POST', {commit, file}),
    };
  }
  const mounts = new WeakMap(), live = new Set();
  const BRIDGE_PARAM = 'wizard-bridge';
  const bytes = s => new TextEncoder().encode(s).length;
  const nonce = () => Array.from(crypto.getRandomValues(new Uint8Array(16)), b => b.toString(16).padStart(2, '0')).join('');
  function mount(root, {slug = '', close = () => {}, changed = () => {}} = {}) {
    let page = null, view = 'list', doc = null, draft = '', conflict = null, history = [], selected = null, busy = false, notice = '', error = '', frame = null, bridge = '';
    const alive = () => root.isConnected;
    const dirty = () => view === 'edit' && draft !== doc?.text;
    const safeLeave = () => !dirty() || window.confirm('Discard unsaved changes?');
    const endpoint = () => client(page.slug);
    function paint() {
      if (!alive()) return;
      const head = `<header class="pg-toolbar"><button data-pg="back" aria-label="Back">‹ Back</button><h2>${esc(page?.title || 'Pages')}</h2>${view === 'list' ? '<button data-pg="refresh">Refresh</button>' : ''}</header>`;
      const status = `<div class="pg-status" role="status">${esc(busy ? 'Working…' : error || notice)}</div>`;
      let body = '';
      if (view === 'list') body = `<div class="pg-list">${listHtml(pages)}</div>`;
      else if (view === 'page') body = `<nav class="pg-actions">${page.has_doc ? '<button data-pg="edit">Edit</button>' : ''}<button data-pg="history">History</button><button data-pg="feedback">Feedback</button></nav>${page.has_index ? `<iframe class="pg-frame" title="${esc(page.title)}" sandbox="${SANDBOX}" src="/pages/${encodeURIComponent(page.slug)}/?${BRIDGE_PARAM}=${bridge}"></iframe>` : `<article class="pg-doc">${window.WosChat.md(doc?.text || '')}</article>`}`;
      else if (view === 'edit') body = `<label class="pg-label" for="pg-edit-${esc(page.slug)}">doc.md</label><textarea id="pg-edit-${esc(page.slug)}" class="pg-editor" aria-label="Edit doc.md" spellcheck="false">${esc(draft)}</textarea><nav class="pg-actions"><button data-pg="save" ${busy ? 'disabled' : ''}>Save</button></nav>${conflict ? `<section class="pg-conflict"><h3>A newer version is on file</h3><p>Both edits are kept. Choose which text to save.</p><h4>Yours</h4><pre>${esc(draft)}</pre><h4>Theirs</h4><pre>${esc(conflict.text)}</pre><button data-pg="mine">Keep mine</button><button data-pg="theirs">Use theirs</button></section>` : ''}`;
      else if (view === 'history') body = `<div class="pg-list">${history.map((h,i) => `<button class="pg-row" data-pg-version="${i}"><b>${esc(h.message)}</b><small>${esc(h.author)} · ${esc(stamp(h.date))}${h.refused ? ' · conflicting edit kept' : ''}</small></button>`).join('') || '<p>No history yet.</p>'}</div>${selected ? `<div class="pg-restore"><p>Restore ${esc(selected.message)} as a new version?</p><button data-pg="restore">Restore</button></div>` : ''}`;
      root.innerHTML = head + status + body;
      root.classList.add('pg-root'); root.setAttribute('aria-label', 'Pages');
      frame = root.querySelector('.pg-frame');
      changed({slug:page?.slug || '', view});
    }
    async function task(fn) {
      if (busy) return;
      busy = true; error = ''; notice = '';
      try { await fn(); } catch (e) { error = e.message || 'Could not reach Pages'; }
      finally { busy = false; paint(); }
    }
    async function open(s) {
      if (!safeLeave()) return;
      if (!available && !await discover()) { error = 'Pages are unavailable'; paint(); return; }
      const p = pages.find(p => p.slug === s); if (!p) { error = 'Page not found'; paint(); return; }
      page = p; bridge = nonce(); doc = p.has_doc ? await client(s).read('doc.md') : null; draft = doc?.text || ''; conflict = null; view = 'page';
    }
    async function save(version = doc?.version) {
      const saving = draft;
      try {
        const d = await endpoint().save('doc.md', saving, version);
        doc = {text:saving, version:d.version}; conflict = null; notice = draft === saving ? 'Saved' : 'Previous edit saved · unsaved changes';
      } catch(e) {
        if (e.status !== 409) throw e;
        conflict = e.data.current; notice = 'Your edit is kept. Resolve the newer version below.';
      }
    }
    function back() {
      if (pending?.root === root) { pending.cancel(); return true; }
      if (busy) return true;
      if (view === 'edit') { if (!safeLeave()) return true; view = 'page'; conflict = null; draft = doc?.text || ''; }
      else if (view === 'history' && selected) selected = null;
      else if (view === 'history') view = 'page';
      else if (view === 'page') { view = 'list'; page = null; bridge = ''; }
      else return false;
      error = ''; notice = ''; paint(); return true;
    }
    function feedback(text, reply) {
      if (pending && !pending.root.isConnected) pending.cancel();
      if (pending) { reply?.(false, 'feedback_pending'); return; }
      const card = document.createElement('section'); card.className = 'pg-confirm'; card.setAttribute('role','dialog'); card.setAttribute('aria-label','Confirm page feedback');
      card.innerHTML = `<h3>Send page feedback?</h3><p>Machine-originated context from ${esc(page.title)}</p><p>To thread: <b>${esc(page.thread || 'New thread')}</b></p>${text === null ? '<textarea aria-label="Feedback text" placeholder="Your feedback"></textarea>' : `<pre>${esc(text)}</pre>`}<button data-pg-confirm>Send feedback</button><button data-pg-cancel>Cancel</button><p role="status"></p>`;
      root.appendChild(card);
      const meta = {...page}; let sending = false, finished = false;
      const finish = (ok, reason) => { if (finished) return; finished = true; card.remove(); pending = null; reply?.(ok, reason); };
      pending = {root, cancel:() => { if (!sending) finish(false,'cancelled'); }};
      card.querySelector('[data-pg-cancel]').onclick = () => { if (!sending) finish(false,'cancelled'); };
      card.querySelector('[data-pg-confirm]').onclick = async () => {
        if (sending) return;
        const words = text === null ? card.querySelector('textarea').value : text;
        if (!words.trim()) return;
        sending = true; card.querySelector('[data-pg-confirm]').disabled = true;
        try {
          await window.WosOutbox.enqueue({kind:meta.thread ? 'reply' : 'new', sessionId:meta.thread || '', text:`[Page feedback · ${meta.title} · /pages/${meta.slug}/]\n${words}`, source:'page-feedback'});
          finish(true); notice = 'Feedback queued'; paint();
        } catch (e) { sending = false; card.querySelector('[data-pg-confirm]').disabled = false; card.querySelector('[role="status"]').textContent = e.message || 'Could not queue feedback'; }
      };
    }
    root.addEventListener('input', e => { if (e.target.matches('.pg-editor')) draft = e.target.value; });
    root.addEventListener('click', e => {
      const openButton = e.target.closest('[data-pg-open]'); if (openButton) return void task(() => open(openButton.dataset.pgOpen));
      const h = e.target.closest('[data-pg-version]'); if (h) { selected = history[+h.dataset.pgVersion]; paint(); return; }
      const action = e.target.closest('[data-pg]')?.dataset.pg; if (!action) return;
      if (action === 'back') { if (!back()) close(); return; }
      if (busy || pending?.root === root) return;
      if (action === 'feedback') return feedback(null);
      void task(async () => {
        if (action === 'refresh') await discover();
        if (action === 'edit') { doc = await endpoint().read('doc.md'); draft = doc.text; view = 'edit'; }
        if (action === 'save') await save();
        if (action === 'mine') await save(conflict.version);
        if (action === 'theirs') { doc = conflict; draft = doc.text; conflict = null; notice = 'Using version on file'; }
        if (action === 'history') { history = (await endpoint().history(page.has_doc ? 'doc.md' : 'index.html')).versions; selected = null; view = 'history'; }
        if (action === 'restore') { await endpoint().restore(selected.commit, page.has_doc ? 'doc.md' : 'index.html'); doc = page.has_doc ? await endpoint().read('doc.md') : null; draft = doc?.text || ''; view = 'page'; notice = 'Restored'; }
      });
    });
    // A single source-bound listener; no app-client services or shell storage are exposed.
    function receive(e) {
      if (!alive()) { controller.dispose(); return; }
      if (!page || !frame || e.source !== frame.contentWindow || e.origin !== 'null') return;
      const m = e.data;
      // The frame can navigate itself anywhere; only the document we loaded knows this open's nonce.
      if (!m || typeof m !== 'object' || !bridge || m.bridge !== bridge) return;
      if (!['wizard-page:feedback','wizard-page:save'].includes(m.type) || !['string','number'].includes(typeof m.id) || String(m.id).length > 200) return;
      const source = e.source;
      const reply = (ok, error, version) => source.postMessage({type:'wizard-page:result', id:m.id, ok, ...(version ? {version} : {}), ...(error ? {error} : {})}, '*');
      if (typeof m.text !== 'string' || bytes(m.text) > 2 * 1024 * 1024) { reply(false,'invalid_text'); return; }
      if (m.type === 'wizard-page:feedback') { if (m.text.length > 16000) reply(false,'invalid_text'); else feedback(m.text, reply); return; }
      if (!fileValid(m.file) || !(m.version === null || typeof m.version === 'string')) { reply(false,'invalid_file_or_version'); return; }
      if (busy || dirty()) { reply(false,'editor_busy'); return; }
      const c = endpoint();
      busy = true;
      c.save(m.file,m.text,m.version).then(d => {
        if (m.file === 'doc.md') { doc = {text:m.text,version:d.version}; draft = m.text; }
        reply(true, null, d.version);
      }, e => reply(false,e.status === 409 ? 'stale_version' : 'save_failed')).finally(() => { busy = false; });
    }
    const controller = {back, open:s => task(() => open(s)), dirty, receive, alive, dispose:() => { window.removeEventListener('message', receive); live.delete(controller); if (pending?.root === root) pending.cancel(); }};
    // Closing a shell window removes its root. Detached viewers are released on their next message and on
    // every new mount, so no document-wide observer runs while Pages is open.
    for (const c of [...live]) if (!c.alive()) c.dispose();
    live.add(controller); mounts.set(root, controller); window.addEventListener('message', receive);
    paint(); if (slug) controller.open(slug); else void task(discover);
    return controller;
  }
  const ready = discover();
  window.WosPages = {SANDBOX, BRIDGE_PARAM, slugValid, fileValid, sorted, listHtml, client, request, mount, ready, discover,
    get available() {return available;}, onChange:fn => listeners.add(fn),
    back:root => mounts.get(root)?.back() || false,
    open:(root,slug) => mounts.get(root)?.open(slug),
    canClose:root => !mounts.get(root)?.dirty() || window.confirm('Discard unsaved changes?'),
    match(href) { try {const u = new URL(href,location.href), m = /^\/pages\/([^/]+)\/?$/.exec(u.pathname); return available && u.origin === location.origin && m && slugValid(m[1]) ? m[1] : '';} catch (_) {return '';} },
  };
})();
