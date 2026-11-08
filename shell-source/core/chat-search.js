/* Wizard UX core: search inside message bodies, not just titles (feature/chat-polish). Both shells.
 *
 * Titles/previews filter instantly (core/chats.js); indexed server snippets arrive in the background.
 * On older servers this reads recent threads' messages lazily to find body hits:
 *   - newest threads first, a page of their latest messages each (LIMIT), BATCH threads per round,
 *     at most CONC requests at once; "Search older threads" extends the round by another BATCH
 *   - a thread's text is cached until its message count / activity changes (LRU, CACHE_N threads)
 *   - typing a new query cancels the in-flight round (AbortController); clearing the box cancels it too
 *   - every hit carries a snippet around the first match, highlighted with <mark>
 * API (per Chats list window id):
 *   WizCore.chatSearch.query(wid, q, onUpdate) → { hits: Map(id → {snippet, html}), state }   (starts / reuses a scan)
 *   WizCore.chatSearch.more(wid)    search another BATCH of older threads
 *   WizCore.chatSearch.cancel(wid)
 */
(() => {
  'use strict';
  const C = window.WizCore = window.WizCore || {};
  const BATCH = 30, LIMIT = 200, CONC = 2, CACHE_N = 150, MAX_SCAN = 300, STALE = 5 * 60 * 1000;
  const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const cache = new Map(); // id → { sig, texts: [string] }
  const runs = {};         // wid → { q, want, scanned, hits, ctrl, done, busy, onUpdate, stats }
  const stats = { fetches: 0, aborted: 0 };
  const base = () => { try { return (window.WizConfig?.endpoint('sessions')) || '/wizard/hermes/api/sessions'; } catch (e) { return '/wizard/hermes/api/sessions'; } };
  const sigOf = s => [s.messageCount ?? '', s.activityAt || '', s.lastAssistantAt || '', s.updatedAt || ''].join('|');
  const words = q => String(q || '').toLowerCase().replace(/\s+/g, ' ').trim().split(' ').filter(Boolean);

  async function textsOf(s, signal) {
    const key = `${s.agent || 'hermes'}:${s.id}`, sig = sigOf(s), hit = cache.get(key);
    if (hit && hit.sig === sig) { cache.delete(key); cache.set(key, hit); return hit.texts; }
    stats.fetches++;
    const r = await fetch(`${base()}/${encodeURIComponent(s.id)}/messages?order=latest&limit=${LIMIT}&view=wizard${s.agent && s.agent !== 'hermes' ? `&agent=${encodeURIComponent(s.agent)}` : ''}`, { credentials: 'same-origin', cache: 'no-store', signal });
    if (!r.ok) throw Object.assign(new Error('HTTP ' + r.status), { status: r.status });
    const p = await r.json();
    const rows = p.data || p.messages || p.items || [];
    const KIT = window.WosChat;
    const texts = [];
    try {
      for (const t of KIT.parseRows(rows)) { if (t.u?.text) texts.push(t.u.text); for (const n of t.notes || []) texts.push(n); if (t.a?.text) texts.push(t.a.text); }
    } catch (e) {}
    cache.set(key, { sig, texts });
    while (cache.size > CACHE_N) cache.delete(cache.keys().next().value);
    return texts;
  }
  // Keep the highlighted excerpt; prefer the message with most query words, newest on ties.
  function match(texts, ws) {
    const ordered = texts.map((text, index) => ({ text, index, coverage: ws.filter(w => String(text || '').toLowerCase().includes(w)).length })).filter(x => x.coverage).sort((a,b) => b.coverage - a.coverage || b.index - a.index);
    for (const { text } of ordered) {
      const raw = String(text || '').replace(/\s+/g, ' '), low = raw.toLowerCase();
      const at = Math.min(...ws.filter(w => low.includes(w)).map(w => low.indexOf(w)));
      const from = Math.max(0, at - 40), to = Math.min(raw.length, at + ws[0].length + 60);
      const piece = raw.slice(from, to);
      const re = new RegExp(ws.map(w => w.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|'), 'gi');
      let html = '', last = 0, m;
      while ((m = re.exec(piece))) { html += esc(piece.slice(last, m.index)) + '<mark>' + esc(m[0]) + '</mark>'; last = m.index + m[0].length; if (!m[0]) re.lastIndex++; }
      html += esc(piece.slice(last));
      return { query: ws.join(' '), body: bodyEvidence(texts, ws.join(' ')), snippet: (from > 0 ? '…' : '') + piece + (to < raw.length ? '…' : ''), html: (from > 0 ? '…' : '') + html + (to < raw.length ? '…' : '') };
    }
    return null;
  }
  function candidates(agent = '') {
    const L = window.WizLive; if (!L?.ok) return [];
    const at = s => Date.parse(L.cardAt ? L.cardAt(s) : s.updatedAt) || 0;
    return (L.searchRows ? L.searchRows(agent) : L.sessionsFor ? L.sessionsFor(agent) : L.sessions).filter(s => !s.hidden && !s.optimistic && s.id && !String(s.id).startsWith('wizard_pending_')).sort((a, b) => at(b) - at(a));
  }
  async function pump(wid, r) {
    if (r.busy) return; r.busy = true;
    const ws = words(r.q);
    let list = candidates(r.agent);
    if(!ws.some(w=>w.length>=3) || ws.some(w=>!/^[\x00-\x7f]+$/.test(w))) { r.titlesOnly=true; r.serverDone=true; r.total=list.length; r.scanned=list.length; r.busy=false; r.onUpdate?.(); return; }
    try {
      if (!r.serverDone && window.WizLive?.searchSessions) {
        try {
          const publish = rows => {
            if (r.ctrl.signal.aborted || runs[wid] !== r) return;
            for (const s of rows || []) {
              r.rows.set(s.id,s); window.WizLive.rememberSearch?.(s);
              r.hits.set(s.id,match([s.searchSnippet || s.preview || s.title],ws) || {snippet:s.searchSnippet || s.preview || '',html:esc(s.searchSnippet || s.preview || '')});
            }
            r.onUpdate?.();
          };
          const rows = await window.WizLive.searchSessions(r.q, r.agent, r.ctrl.signal, publish);
          if (r.ctrl.signal.aborted || runs[wid] !== r) return;
          r.serverDone = true; r.server = rows !== null && !rows?.fallbackScopes?.length; r.partial = !!rows?.partial; r.capped = !!rows?.capped;
          r.fallbackScopes=rows===null ? null : rows?.fallbackScopes||[];
          publish(rows);
        } catch(e) { if(e.name==='AbortError') throw e; r.errors++; r.serverError=true; r.serverDone=true; r.fallbackScopes=[]; }
      }
      if(r.serverDone && Array.isArray(r.fallbackScopes)) list=list.filter(s=>r.fallbackScopes.includes((s.agent||'hermes')==='hermes'?'':s.agent));
      while (!r.ctrl.signal.aborted && !r.paused && r.scanned < Math.min(r.want, list.length)) {
        const slice = list.slice(r.scanned, Math.min(r.want, list.length, r.scanned + CONC));
        await Promise.all(slice.map(async s => {
          try { const m = match(await textsOf(s, r.ctrl.signal), ws); if (m && !r.ctrl.signal.aborted && runs[wid] === r) r.hits.set(s.id, m); }
          catch (e) { if (e.name === 'AbortError') throw e; r.errors++; }
        }));
        r.scanned += slice.length;
        if (!r.ctrl.signal.aborted) r.onUpdate?.();
      }
    } catch (e) { if (e.name === 'AbortError') stats.aborted++; }
    finally { r.busy = false; }
    r.total = list.length;
    if (!r.paused && r.scanned >= Math.min(r.want, list.length)) r.doneAt = Date.now();
    if (!r.ctrl.signal.aborted) r.onUpdate?.();
  }
  function cancel(wid) { const r = runs[wid]; if (r) { r.ctrl.abort(); delete runs[wid]; } }
  const scanning = r => !!r && (r.busy || (!r.paused && r.scanned < Math.min(r.want, r.total || 0)));
  /* Instant answers before any read: rows the previous (shorter) query already found that still match, and
   * every message body this phone has cached. The server/background rounds then only add to them. */
  function seed(r, prev) {
    const ws = words(r.q);
    if (prev && prev.agent === r.agent && r.q.includes(prev.q)) for (const [id, s] of prev.rows) {
      const m = match([s.title, s.preview, s.searchSnippet].filter(Boolean), ws);
      if (m) { m.body = bodyEvidence([s.searchSnippet], r.q); r.rows.set(id, s); r.hits.set(id, m); }
    }
    for (const s of candidates(r.agent)) {
      const title=match([s.title,s.preview].filter(Boolean),ws);
      if (title) title.body = bodyEvidence([], r.q);
      if(title) { r.rows.set(s.id,s); r.hits.set(s.id,title); }
      const hit = cache.get(`${s.agent || 'hermes'}:${s.id}`);
      if (hit && hit.sig === sigOf(s)) { const m = match(hit.texts, ws); if (m) { r.rows.set(s.id,s); r.hits.set(s.id, m); } }
    }
  }
  // EXTEND WizCore.chatSearch: one relevance policy for instant, indexed and fetched-body hits.
  // Coverage is lexicographic; recency can only scale relevance within a coverage/strength tier.
  const SEARCH_RELEVANCE = Object.freeze({ titlePrefix: 8, titleSubstring: 5, preview: 3, body: 1,
    density: 1.5, densityCap: 20, phrase: 4, singleBodyLocations: 2, halfLifeDays: 4, recencyFloor: 0.5 });
  const low = s => String(s ?? '').toLowerCase().replace(/\s+/g, ' ').trim();
  function bodyEvidence(texts, query) {
    const ws = [...new Set(words(query))], counts = Object.create(null);
    for (const w of ws) counts[w] = 0;
    for (const text of Array.isArray(texts) ? texts : []) {
      const t = low(text);
      for (const w of ws) { let at = 0, n = 0; while ((at = t.indexOf(w, at)) !== -1) { n++; at += w.length; } counts[w] += n; }
    }
    return { counts };
  }
  function relevance(row, query, hit) {
    const ws = [...new Set(words(query))], title = low(row?.title), preview = low(row?.preview);
    const titleWords = title.split(/[^\p{L}\p{N}_]+/u).filter(Boolean);
    // The server returns ONE clipped snippet, not a match count. Never invent density from messageCount.
    // Fetched messages carry query-bound counts; otherwise only distinct snippet locations are known.
    const body = hit?.query === ws.join(' ') && hit?.body ? hit.body : bodyEvidence([row?.searchSnippet || hit?.snippet || ''], query);
    const fields = ws.map(word => {
      const titleWeight = titleWords.some(t => t.startsWith(word)) ? SEARCH_RELEVANCE.titlePrefix : title.includes(word) ? SEARCH_RELEVANCE.titleSubstring : 0;
      const inPreview = preview.includes(word), count = Math.max(0, Number(body.counts?.[word]) || 0);
      return { word, count, titleWeight, inPreview, matched: !!(titleWeight || inPreview || count),
        weight: titleWeight + (inPreview ? SEARCH_RELEVANCE.preview : 0) + (count ? SEARCH_RELEVANCE.body + SEARCH_RELEVANCE.density * Math.log1p(Math.min(SEARCH_RELEVANCE.densityCap, count)) : 0) };
    });
    const coverage = fields.filter(f => f.matched).length;
    const strong = ws.length !== 1 || fields.some(f => f.titleWeight || f.inPreview || f.count >= SEARCH_RELEVANCE.singleBodyLocations);
    const phrase = ws.length > 1 && [title, low(row?.searchSnippet || hit?.snippet)].some(t => t.includes(ws.join(' ')));
    return { fields, coverage, strong, phrase };
  }
  function rankDetails(rows, query, cardAt, hits, now = Date.now()) {
    const list = Array.isArray(rows) ? rows.filter(r => r && typeof r === 'object') : [];
    const ws = [...new Set(words(query))];
    const entries = list.map((row, index) => ({ row, index, ...relevance(row, query, hits?.get(row.id)) }));
    const idf = Object.fromEntries(ws.map(w => [w, Math.log(1 + list.length / (1 + entries.filter(e => e.fields.some(f => f.word === w && f.matched)).length))]));
    return entries.map(e => {
      // Use live.js's exact card clock, including its request clock for active/error rows.
      const parsed = Date.parse(typeof cardAt === 'function' ? cardAt(e.row) : e.row.activityAt || e.row.updatedAt), at = Number.isFinite(parsed) ? parsed : 0;
      const ageDays = Math.max(0, (now - at) / 86400000);
      const multiplier = SEARCH_RELEVANCE.recencyFloor + (1 - SEARCH_RELEVANCE.recencyFloor) * Math.pow(0.5, ageDays / SEARCH_RELEVANCE.halfLifeDays);
      const raw = e.fields.reduce((sum, f) => sum + idf[f.word] * f.weight, 0) + (e.phrase ? SEARCH_RELEVANCE.phrase * ws.reduce((sum, w) => sum + idf[w], 0) : 0);
      return { ...e, at, raw, multiplier, score: raw * multiplier, idf };
    }).sort((a, b) => b.coverage - a.coverage || Number(b.strong) - Number(a.strong) || b.score - a.score || b.at - a.at || a.index - b.index);
  }
  function rank(rows, query, cardAt, hits, now) { return rankDetails(rows, query, cardAt, hits, now).map(e => e.row); }
  C.chatSearch = {
    rank, rankDetails, relevance, bodyEvidence, words, SEARCH_RELEVANCE,
    query(wid, q, onUpdate, agent = '') {
      const ws = words(q);
      if (!ws.length || ws.join(' ').length < 1) { cancel(wid); return null; }
      let r = runs[wid];
      const fresh = r && r.q === ws.join(' ') && r.agent === agent && !(r.doneAt && Date.now() - r.doneAt > STALE);
      if (!fresh) {
        const prev = r; cancel(wid);
        r = runs[wid] = { q: ws.join(' '), agent, rows:new Map(), want: BATCH, scanned: 0, total: candidates(agent).length, hits: new Map(), ctrl: new AbortController(), busy: false, errors: 0, onUpdate };
        seed(r, prev);
        // Wait for the typing to settle before reading anything.
        setTimeout(() => { if (runs[wid] === r) pump(wid, r); }, 250);
      } else {
        r.onUpdate = onUpdate; seed(r);
        // Back from a thread opened out of these results: the same answers, at once; finish a paused round.
        if (r.paused) { r.paused = false; if (!r.busy) pump(wid, r); }
      }
      return r;
    },
    /* Opening a thread from the results keeps them for Back (James, 25 Oct 2026: Back re-ran the whole search).
     * The server answer may finish in the background; the per-thread message reads pause so the thread loads first. */
    park(wid) { const r = runs[wid]; if (r) r.paused = true; },
    scanning,
    more(wid) { const r = runs[wid]; if (!r) return; r.want = Math.min(MAX_SCAN, r.want + BATCH); pump(wid, r); },
    cancel,
    reset() { for(const id of Object.keys(runs)) cancel(id); cache.clear(); },
    /* One line under the results: progress, the cap, and the button for older threads. */
    footer(r) {
      if (!r) return '';
      const total = Math.min(r.total ?? candidates().length, MAX_SCAN), upto = Math.min(r.want, total);
      if (scanning(r) || (!r.paused && r.scanned < upto)) return `<div class="ch-bodysearch busy" data-chbs="busy"><span class="wx-spin" aria-hidden="true"></span>${r.serverDone ? `Searching messages · ${r.scanned} of ${upto} recent threads` : 'Searching messages…'}</div>`;
      const n = r.hits.size, more = upto < total;
      if (r.serverError) return '<div class="ch-bodysearch">Couldn’t search older threads · check your connection and try again</div>';
      if (r.partial) return `<div class="ch-bodysearch" data-chbs="done">Searched available agents · ${n} with matches · some agents could not be searched</div>`;
      if (r.titlesOnly) return '<div class="ch-bodysearch">Type 3 letters to search messages</div>';
      if (r.server) return `<div class="ch-bodysearch" data-chbs="done">Searched titles and messages · ${n} with matches${r.capped ? ' · newest message matches shown' : ''}</div>`;
      return `<div class="ch-bodysearch" data-chbs="done">Searched messages in the ${r.scanned} most recent threads${n ? ` · ${n} with matches` : ''}${more ? ` <button type="button" data-chbsmore>Search older threads</button>` : ''}</div>`;
    },
    get stats() { return { ...stats, cached: cache.size, runs: Object.fromEntries(Object.entries(runs).map(([k, r]) => [k, { q: r.q, scanned: r.scanned, want: r.want, hits: [...r.hits.keys()], busy: r.busy }])) }; },
  };
})();
