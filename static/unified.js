/* Unified inbox is a view of the authenticated Messenger API, never a Matrix client. */
(() => {
  'use strict';
  function backState(state) {
    if (state.overlay) return {...state, overlay: null, handled: true};
    if (state.person) return {...state, person: null, handled: true};
    if (state.search != null) return {...state, search: null, handled: true};
    return {...state, handled: false}; // Shared WizardApp owns the root guard.
  }
  async function fetchOlder(t, id, call) {
    if (!t.has_more || !t.next_cursor) return false;
    const r = await call('people/' + encodeURIComponent(id) + '?limit=60&cursor=' + encodeURIComponent(t.next_cursor));
    const known = new Set(t.messages.map(m => m.id));
    t.messages = [...r.messages.filter(m => !known.has(m.id)), ...t.messages];
    t.has_more = r.has_more; t.next_cursor = r.next_cursor;
    return true;
  }
  if (typeof module !== 'undefined') module.exports = {backState, fetchOlder};
  if (typeof document === 'undefined') return;
  const $ = id => document.getElementById(id);
  const s = {tab: 'people', person: null, overlay: null, search: null, ready: false, epoch: 0, busy: false, drafts: {}, people: [], login: null};
  let api, timer, lastFocus, updateHold, connectorController;
  // A letter outside the Latin script (Thai, Cyrillic, CJK…) offers Translate; English never does.
  const foreignScript = t => /(?![\p{Script=Latin}])\p{L}/u.test(t || '');
  const shown = {}; // message id -> 'translated' | 'original' for on-tap translation
  const node = (tag, cls, content) => { const el = document.createElement(tag); if (cls) el.className = cls; if (content != null) el.textContent = content; return el; };
  const button = (label, fn, cls = 'secondary') => { const el = node('button', cls, label); el.type = 'button'; el.onclick = fn; return el; };
  // Line icons are built as SVG nodes: no markup strings reach the DOM.
  const ICONS = {
    back: ['M20 12H5', 'M11 5l-7 7 7 7'], close: ['M18 6 6 18', 'M6 6l12 12'],
    search: ['M10.5 18a7.5 7.5 0 1 0 0-15 7.5 7.5 0 0 0 0 15z', 'M16 16l5 5'],
    settings: ['M12 15a3 3 0 1 0 0-6 3 3 0 0 0 0 6z', 'M19.4 15a1.7 1.7 0 0 0 .3 1.8l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.7 1.7 0 0 0-1.8-.3 1.7 1.7 0 0 0-1 1.5V21a2 2 0 1 1-4 0v-.1a1.7 1.7 0 0 0-1.1-1.5 1.7 1.7 0 0 0-1.8.3l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1a1.7 1.7 0 0 0 .3-1.8 1.7 1.7 0 0 0-1.5-1H3a2 2 0 1 1 0-4h.1a1.7 1.7 0 0 0 1.5-1.1 1.7 1.7 0 0 0-.3-1.8l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1a1.7 1.7 0 0 0 1.8.3H9a1.7 1.7 0 0 0 1-1.5V3a2 2 0 1 1 4 0v.1a1.7 1.7 0 0 0 1 1.5 1.7 1.7 0 0 0 1.8-.3l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.7 1.7 0 0 0-.3 1.8V9a1.7 1.7 0 0 0 1.5 1H21a2 2 0 1 1 0 4h-.1a1.7 1.7 0 0 0-1.5 1z'],
    compose: ['M17 3a2.8 2.8 0 1 1 4 4L7.5 20.5 2 22l1.5-5.5z', 'M15 5l4 4'],
    more: ['M12 5.5v.01', 'M12 12v.01', 'M12 18.5v.01'],
    send: ['M4 12 20 4l-4 16-4-6.5L4 12z', 'm12 13.5 8-9.5'],
    down: ['M12 5v14', 'm5 12 7 7 7-7'], plus: ['M12 5v14', 'M5 12h14'],
    mic: ['M12 3a3 3 0 0 0-3 3v6a3 3 0 0 0 6 0V6a3 3 0 0 0-3-3z', 'M19 11a7 7 0 0 1-14 0', 'M12 18v3'],
    play: ['M7 4.5v15l12-7.5z'], reply: ['M9 14 4 9l5-5', 'M4 9h10a6 6 0 0 1 6 6v4'],
    copy: ['M9 9h11v11H9z', 'M5 15H4V4h11v1'], trash: ['M4 7h16', 'M10 11v6', 'M14 11v6', 'M6 7l1 13h10l1-13', 'M9 7V4h6v3'],
    download: ['M12 4v11', 'm7 10 5 5 5-5', 'M5 20h14'],
  };
  function icon(name) {
    const ns = 'http://www.w3.org/2000/svg', svg = document.createElementNS(ns, 'svg');
    svg.setAttribute('viewBox', '0 0 24 24'); svg.setAttribute('aria-hidden', 'true'); svg.setAttribute('focusable', 'false');
    for (const d of ICONS[name]) { const path = document.createElementNS(ns, 'path'); path.setAttribute('d', d); svg.append(path); }
    if (name === 'more') svg.classList.add('dots');
    return svg;
  }
  const iconButton = (name, label, fn, cls = '') => { const el = button('', fn, 'icon-button ' + cls); el.append(icon(name)); el.setAttribute('aria-label', label); el.title = label; return el; };
  // Stable per-name avatar colour, like Signal's contact colours.
  const TONES = 12;
  function avatar(name, cls = '') {
    const text = (name || '?').trim();
    let h = 0; for (const ch of text) h = (h * 31 + ch.codePointAt(0)) >>> 0;
    const initials = text.split(/\s+/).filter(Boolean).slice(0, 2).map(w => [...w][0]).join('').toUpperCase() || '?';
    const el = node('span', 'u-avatar tone-' + (h % TONES) + (cls ? ' ' + cls : ''), initials); el.setAttribute('aria-hidden', 'true'); return el;
  }
  const networksOf = p => [...new Set((p.identities || []).map(i => i.network))];
  const cap = t => t ? t[0].toUpperCase() + t.slice(1) : '';
  const call = (path, body) => api('api/unified/' + path, body === undefined ? {} : {method: 'POST', body});
  const error = e => { const el = $('u-error'); if (el) el.textContent = e.message || 'Request failed. Please try again.'; };
  async function action(fn) { if (s.busy) return; s.busy = true; try { await fn(); } catch (e) { error(e); } finally { s.busy = false; } }
  function hold() { const pending = Object.values(s.drafts).some(Boolean) || !!s.overlay || s.busy || store.pending > 0 || !!view.recording; if (pending && !updateHold) updateHold = window.WizardApp.update.hold('Unified inbox unsent work'); else if (!pending && updateHold) { updateHold.release(); updateHold = null; } }
  function inChat(on) { if (on) document.documentElement.dataset.inChat = ''; else delete document.documentElement.dataset.inChat; }
  function closeOverlay() {
    connectorController?.close().catch(() => {}); connectorController = null;
    s.login = null; s.overlay = null; $('u-overlay')?.remove(); view.lifted?.classList.remove('lifted'); view.lifted = null; lastFocus?.focus(); hold();
  }
  function back() {
    const next = backState(s);
    if (!next.handled) return false;
    if (s.overlay) closeOverlay();
    else if (s.person) { s.person = null; view.id = null; s.epoch++; inChat(false); renderList(); }
    else { s.search = null; s.epoch++; renderList(); }
    return true;
  }
  function overlay(title) {
    closeOverlay(); lastFocus = document.activeElement; s.overlay = title;
    const layer = node('div', 'u-overlay'); layer.id = 'u-overlay';
    const panel = node('section', 'u-sheet'); panel.setAttribute('role', 'dialog'); panel.setAttribute('aria-modal', 'true'); panel.setAttribute('aria-label', title); panel.tabIndex = -1;
    const head = node('header'); head.append(node('h2', '', title), iconButton('close', 'Close', closeOverlay)); panel.append(node('span', 'grabber'), head);
    layer.append(panel); $('messenger').append(layer);
    layer.onclick = e => { if (e.target === layer) closeOverlay(); };
    panel.onkeydown = e => {
      if (e.key !== 'Tab') return;
      const focusable = [...panel.querySelectorAll('button,input,select,textarea')].filter(x => !x.disabled);
      const first = focusable[0], last = focusable.at(-1);
      if (e.shiftKey && (document.activeElement === first || document.activeElement === panel)) { e.preventDefault(); last?.focus(); }
      else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first?.focus(); }
    };
    const notice = node('p', 'error'); notice.id = 'u-error'; notice.setAttribute('role', 'alert'); panel.append(notice);
    panel.focus(); hold(); return panel;
  }
  function listBase(title) {
    const root = $('unified-inbox'); root.replaceChildren();
    const head = node('header', 'u-header');
    if (s.search != null) {
      const field = node('input', 'u-search'); field.type = 'search'; field.placeholder = 'Search'; field.setAttribute('aria-label', 'Search ' + title.toLowerCase()); field.value = s.search;
      field.oninput = () => { s.search = field.value; scheduleSearch(); };
      head.append(iconButton('back', 'Close search', back), field);
      requestAnimationFrame(() => field.focus());
    } else {
      head.append(node('h1', '', title), iconButton('search', 'Search', () => { s.search = ''; renderList(); }), iconButton('settings', 'Settings', accounts));
    }
    root.append(head); const notice = node('p', 'error'); notice.id = 'u-error'; notice.setAttribute('role', 'status'); root.append(notice); return root;
  }
  function threadBase(name, subtitle, onInfo) {
    const root = $('unified-inbox'); root.replaceChildren();
    const head = node('header', 'u-header u-thread-head');
    head.append(iconButton('back', 'Back', back));
    const who = button('', onInfo || null, 'u-who'); who.disabled = !onInfo;
    const text = node('span', 'u-who-text'); text.append(node('strong', '', name)); if (subtitle) text.append(node('span', '', subtitle));
    who.append(avatar(name, 'small'), text); head.append(who);
    if (onInfo) head.append(iconButton('more', 'Edit', onInfo));
    root.append(head); const notice = node('p', 'error'); notice.id = 'u-error'; notice.setAttribute('role', 'status'); root.append(notice); return root;
  }
  function when(ms) {
    const d = new Date(ms), now = new Date();
    if (d.toDateString() === now.toDateString()) return d.toLocaleTimeString([], {hour: 'numeric', minute: '2-digit'});
    if (now - d < 6 * 864e5) return d.toLocaleDateString([], {weekday: 'short'});
    return d.toLocaleDateString([], {month: 'short', day: 'numeric'});
  }
  function dayLabel(ms) {
    const d = new Date(ms), now = new Date(), y = new Date(now); y.setDate(now.getDate() - 1);
    if (d.toDateString() === now.toDateString()) return 'Today';
    if (d.toDateString() === y.toDateString()) return 'Yesterday';
    if (now - d < 6 * 864e5) return d.toLocaleDateString([], {weekday: 'long'});
    return d.toLocaleDateString([], {weekday: 'short', month: 'short', day: 'numeric', ...(d.getFullYear() !== now.getFullYear() ? {year: 'numeric'} : {})});
  }
  async function newChat() {
    // The full A-Z contact list lives only here.
    const sheet = overlay('New chat'); sheet.classList.add('tall');
    const search = node('input', 'u-search'); search.type = 'search'; search.placeholder = 'Search people and groups'; search.setAttribute('aria-label', 'Search people and groups');
    const list = node('div', 'u-directory'); sheet.append(search, list);
    try {
      const d = await call('directory'); if (s.overlay !== 'New chat') return;
      const all = [...d.people, ...d.groups.map(g => ({...g, group: true}))].sort((a, b) => a.display_name.localeCompare(b.display_name));
      const draw = () => {
        const q = search.value.trim().toLowerCase(); list.replaceChildren(); let letter = '';
        for (const p of all.filter(p => !q || p.display_name.toLowerCase().includes(q)).slice(0, 200)) {
          const first = ([...p.display_name.trim()][0] || '#').toUpperCase();
          if (!q && first !== letter) { letter = first; list.append(node('p', 'u-letter', /\p{L}/u.test(first) ? first : '#')); }
          const row = button('', () => { closeOverlay(); openPerson(p.id); }, 'u-directory-row');
          const text = node('span', 'u-who-text'); text.append(node('strong', '', p.display_name), node('span', '', p.group ? 'Group' : networksOf(p).map(cap).join(' · ')));
          row.append(avatar(p.display_name, 'small'), text); list.append(row);
        }
        if (!list.children.length) list.append(node('p', 'u-empty', 'No one matches'));
      };
      search.oninput = draw; draw(); requestAnimationFrame(() => search.focus());
    } catch (e) { error(e); }
  }
  // ---------- live store: lists and open threads stay in memory and follow the change feed ----------
  const store = {seq: 0, lists: {people: null, groups: null}, threads: {}, typing: {}, pending: 0};
  const sleep = ms => new Promise(r => setTimeout(r, ms));
  const uid = () => (crypto.randomUUID ? crypto.randomUUID().replace(/-/g, '') : Math.random().toString(36).slice(2) + Date.now().toString(36)).slice(0, 32);
  const listKey = p => (p.identities || []).some(i => i.kind === 'group') ? 'groups' : 'people';
  const mediaURL = (id, kind) => 'api/unified/media/' + encodeURIComponent(id) + (kind ? '?kind=' + kind : '');
  const nameOf = sender => !sender ? '' : sender.startsWith('@') ? sender.slice(1).split(':')[0] : sender;
  const fmtDur = ms => { const t = Math.max(0, Math.round((ms || 0) / 1000)); return Math.floor(t / 60) + ':' + String(t % 60).padStart(2, '0'); };
  const fmtSize = b => !b ? '' : b < 1024 * 1024 ? Math.max(1, Math.round(b / 1024)) + ' KB' : (b / 1048576).toFixed(1) + ' MB';
  const QUICK = ['❤️', '👍', '👎', '😂', '😮', '😢'];
  const MORE = ['🙏', '🔥', '🎉', '👏', '😍', '🤔', '😅', '🙌', '💯', '😎', '🥲', '😡', '🤯', '🤝', '👀', '✅', '😘', '🥰', '😆', '😬', '🤣', '😭', '🤗', '😴', '💪', '👌', '🙃', '😇', '🤩', '😱', '💔', '⭐', '🌹', '☕', '🍻', '🎂', '🚀', '💡', '📌', '❓', '❗', '👋'];
  // Saved copy on this device: the list and recent threads paint before the session handshake; Lock erases it.
  const CACHE_KEY = 'messenger-unified-cache-v2', THREADS_KEPT = 40, MESSAGES_KEPT = 80;
  let saveTimer = null, savedOrder = [];
  function persist() {
    clearTimeout(saveTimer);
    saveTimer = setTimeout(() => {
      const threads = {};
      for (const id of savedOrder.slice(0, THREADS_KEPT)) { const t = store.threads[id]; if (t) threads[id] = {person: t.person, has_more: true, messages: t.messages.filter(m => !m.pending && !m.failed).slice(-MESSAGES_KEPT).map(({retry, local, ...m}) => m)}; }
      try { localStorage.setItem(CACHE_KEY, JSON.stringify({lists: store.lists, threads, order: savedOrder.slice(0, THREADS_KEPT)})); } catch { /* storage full or blocked: still works online */ }
    }, 400);
  }
  function restore() {
    try {
      const c = JSON.parse(localStorage.getItem(CACHE_KEY) || 'null'); if (!c?.lists?.people) return false;
      store.lists = {people: c.lists.people, groups: c.lists.groups || null}; savedOrder = c.order || [];
      for (const [id, t] of Object.entries(c.threads || {})) store.threads[id] = {...t, stale: true};
      return true;
    } catch { return false; }
  }
  function wipeCache() { clearTimeout(saveTimer); savedOrder = []; try { localStorage.removeItem(CACHE_KEY); localStorage.removeItem('messenger-unified-cache-v1'); } catch { /* nothing stored */ } }
  let recent = [];
  let csrf = () => '';
  let feedCtl = null;

  function snippet(last) {
    if (!last) return '';
    if (last.deleted) return 'This message was deleted';
    const label = last.voice ? '🎤 Voice message' : {'m.image': '📷 Photo', 'm.video': '🎬 Video', 'm.audio': '🎵 Audio', 'm.file': '📎 File', 'm.sticker': 'Sticker', 'm.location': '📍 Location'}[last.msgtype];
    return label ? label + (last.text ? ' · ' + last.text : '') : last.text;
  }
  function mergeList(people) {
    for (const p of people) {
      const list = store.lists[listKey(p)]; if (!list) continue;
      const i = list.findIndex(x => x.id === p.id); if (i >= 0) list[i] = p; else list.push(p);
      list.sort((a, b) => (b.last?.timestamp || 0) - (a.last?.timestamp || 0));
      const t = store.threads[p.id]; if (t) Object.assign(t.person, {peer_read_ts: p.peer_read_ts, last_read_ts: p.last_read_ts, display_name: p.display_name});
    }
  }
  function mergeMessages(pid, rows) {
    const t = store.threads[pid]; if (!t) return;
    const oldest = t.messages.find(m => !m.pending)?.timestamp ?? 0;
    for (const m of rows) {
      const i = t.messages.findIndex(x => x.id === m.id || (m.client_id && x.client_id === m.client_id));
      if (i >= 0) { const local = t.messages[i].local; t.messages[i] = m; if (local) m.local = local; }
      else if (!t.has_more || m.timestamp >= oldest) t.messages.push(m);
    }
    t.messages.sort((a, b) => (a.pending ? 1 : 0) - (b.pending ? 1 : 0) || a.timestamp - b.timestamp || (a.id < b.id ? -1 : 1));
  }
  function apply(r) {
    if (r.reset) { store.seq = r.seq; store.lists = {people: null, groups: null}; store.threads = {}; if (s.person) openPerson(s.person); else renderList(); return; }
    store.seq = Math.max(store.seq, r.seq);
    if (r.people?.length) mergeList(r.people);
    for (const p of r.people || []) store.typing[p.id] = (r.typing || {})[p.id] || [];
    for (const [pid, rows] of Object.entries(r.messages || {})) mergeMessages(pid, rows);
    if (s.person && store.threads[s.person]) { paintHead(); paintThread(); }
    else if (!s.person && s.tab !== 'messenger') drawList();
    persist();
  }
  async function feed() {
    feedCtl?.abort(); const ctl = feedCtl = new AbortController();
    while (s.ready && !ctl.signal.aborted) {
      if (document.hidden) { await sleep(800); continue; }
      try {
        // Long-poll: answers the moment anything changes; jitter keeps two views from syncing up.
        apply(await api('api/unified/updates?since=' + store.seq + '&hold=' + (20 + Math.random() * 3).toFixed(1), {signal: ctl.signal}));
      } catch (e) { if (ctl.signal.aborted) return; await sleep(3000); }
    }
  }

  // ---------- chat list ----------
  function skeleton(rows, cls) { const box = node('div', 'u-skeleton ' + cls); for (let i = 0; i < rows; i++) { const r = node('div', 'u-sk-row'); r.append(node('span', 'u-sk-av'), node('span', 'u-sk-lines')); box.append(r); } return box; }
  async function renderList() {
    const epoch = ++s.epoch, key = s.tab === 'groups' ? 'groups' : 'people';
    const root = listBase(key === 'groups' ? 'Groups' : 'Chats');
    const list = node('div', 'u-list'); list.addEventListener('filter', drawList); root.append(list);
    if (key === 'people' && s.search == null) root.append(iconButton('compose', 'New chat', () => newChat(), 'u-fab'));
    if (store.lists[key]) { drawList(); if (!store.seq && s.ready) freshen(key, epoch); return; }
    list.append(skeleton(8, 'list'));
    if (!s.ready) return;
    try {
      const r = await call(key);
      if (!store.lists[key]) store.lists[key] = r[key] || [];
      if (!store.seq) { store.seq = r.seq || 0; feed(); }
      if (s.epoch === epoch && !s.person) drawList();
      persist();
    } catch (e) { error(e); }
  }
  // A saved list painted first; the server's copy replaces it, then the change feed keeps it current.
  async function freshen(key, epoch) {
    try {
      const r = await call(key); store.lists[key] = r[key] || [];
      if (!store.seq) { store.seq = r.seq || 0; feed(); }
      if (s.epoch === epoch && !s.person) drawList();
      persist();
    } catch (e) { error(e); }
  }
  let searchTimer, searchGeneration = 0;
  const searchView = {query: null, rows: [], cursor: null, loading: false};
  function scheduleSearch() {
    clearTimeout(searchTimer); const generation = ++searchGeneration;
    Object.assign(searchView, {query: s.search, rows: [], cursor: null, loading: !!s.search.trim()});
    drawSearch();
    if (s.search.trim()) searchTimer = setTimeout(() => loadSearch(generation), 200);
  }
  async function loadSearch(generation = searchGeneration, cursor = null) {
    const query = s.search, epoch = s.epoch;
    if (!s.ready || s.person || query == null || !query.trim() || generation !== searchGeneration) return;
    try {
      const r = await call('search?' + new URLSearchParams({q: query, limit: '50', ...(cursor ? {cursor} : {})}));
      if (generation !== searchGeneration || epoch !== s.epoch || s.person || query !== s.search || !s.ready) return;
      searchView.rows.push(...r.messages); searchView.cursor = r.next_cursor; searchView.loading = false; drawSearch();
    } catch (e) {
      if (generation !== searchGeneration || epoch !== s.epoch || query !== s.search) return;
      searchView.loading = false; drawSearch(); error(e);
    }
  }
  function drawSearch() {
    const list = $('unified-inbox').querySelector('.u-list'); if (!list || s.person || s.search == null) return;
    list.replaceChildren();
    for (const m of searchView.rows) {
      const row = button('', () => action(async () => {
        await openPerson(m.person_id);
        const t = store.threads[m.person_id];
        while (s.person === m.person_id && t && !t.messages.some(x => x.id === m.message_id) && t.has_more && t.next_cursor) await fetchOlder(t, m.person_id, call);
        if (s.person === m.person_id) { paintThread(); jumpTo(m.message_id); }
      }), 'u-person');
      const info = node('span', 'u-person-info');
      info.append(node('strong', '', m.display_name + ' · ' + cap(m.network)), node('span', 'u-snippet', m.original), node('time', 'u-when', when(m.timestamp)));
      if (m.translated && m.translated !== m.original) info.append(node('span', 'u-snippet', m.translated));
      row.append(info); list.append(row);
    }
    if (searchView.loading) list.append(node('p', 'u-empty', 'Searching stored messages…'));
    else if (!searchView.rows.length) list.append(node('p', 'u-empty', s.search.trim() ? 'No stored messages match' : 'Search all stored message text'));
    if (searchView.cursor) {
      const more = button('More results', () => { more.disabled = true; loadSearch(searchGeneration, searchView.cursor); }); list.append(more);
    }
  }
  function drawList() {
    if (s.search != null) {
      if (searchView.query !== s.search) scheduleSearch(); else drawSearch();
      return;
    }
    const root = $('unified-inbox'), list = root.querySelector('.u-list'); if (!list || s.person) return;
    const groups = s.tab === 'groups', people = store.lists[groups ? 'groups' : 'people']; if (!people) return;
    let label = root.dataset.label || '';
    if (groups && !root.querySelector('.u-chips')) {
      const labels = [...new Set(people.flatMap(p => p.labels || []))];
      if (labels.length) {
        const chips = node('div', 'u-chips'); chips.setAttribute('role', 'group'); chips.setAttribute('aria-label', 'Filter groups by label');
        const paintChips = () => { for (const c of chips.children) c.setAttribute('aria-pressed', String(c.dataset.label === (root.dataset.label || ''))); };
        for (const l of ['', ...labels]) { const chip = button(l || 'All', () => { root.dataset.label = l; paintChips(); drawList(); }, 'u-chip'); chip.dataset.label = l; chips.append(chip); }
        paintChips(); root.insertBefore(chips, list);
      }
    }
    const q = (s.search || '').trim().toLowerCase(), frag = document.createDocumentFragment();
    for (const p of people.filter(p => (!label || (p.labels || []).includes(label)) && (!q || p.display_name.toLowerCase().includes(q) || (p.last?.text || '').toLowerCase().includes(q)))) {
      const card = button('', () => openPerson(p.id, p), 'u-person' + (p.unread ? ' unread' : ''));
      card.append(avatar(p.display_name));
      const info = node('span', 'u-person-info');
      const top = node('span', 'u-chat-top'); top.append(node('strong', '', p.display_name));
      if (p.last) top.append(node('time', 'u-when', when(p.last.timestamp)));
      const bottom = node('span', 'u-chat-bottom');
      const typing = (store.typing[p.id] || []).length;
      if (typing) bottom.append(node('span', 'u-snippet typing', 'typing…'));
      else if (p.last) {
        const who = p.last.outgoing ? 'You: ' : groups && p.last.sender ? nameOf(p.last.sender).split(' ')[0] + ': ' : '';
        bottom.append(node('span', 'u-snippet', who + snippet(p.last)));
      }
      if (p.unread) bottom.append(node('span', 'u-badge', p.unread > 99 ? '99+' : String(p.unread)));
      else if (p.last?.outgoing) bottom.append(node('span', 'u-ticks' + (p.peer_read_ts >= p.last.timestamp ? ' read' : ''), p.peer_read_ts >= p.last.timestamp ? '✓✓' : '✓'));
      info.append(top, bottom);
      const extra = [...(networksOf(p).length > 1 ? networksOf(p).map(cap) : []), ...(p.labels || [])];
      if (extra.length) info.append(node('span', 'u-tags', extra.join(' · ')));
      card.append(info); frag.append(card);
    }
    if (!frag.children.length) frag.append(node('p', 'u-empty', q ? 'No matches' : label ? 'No groups with this label' : groups ? 'Group chats appear here once an account is connected.' : 'No chats yet. Connect Telegram in Settings, or start a new chat.'));
    list.replaceChildren(frag);
  }

  // ---------- conversation ----------
  const view = {};  // live DOM handles for the open thread
  const els = new Map(); // message key -> bubble element (keyed render)
  const player = new Audio(); let playing = null;
  player.onended = player.onpause = () => { playing?.classList.remove('playing'); if (player.ended) for (const i of playing?.querySelectorAll('.u-wave i') || []) i.classList.remove('on'); };
  player.ontimeupdate = () => { if (playing) { const f = player.duration ? player.currentTime / player.duration : 0; for (const i of playing.querySelectorAll('.u-wave i')) i.classList.toggle('on', +i.dataset.at < f); } const t = playing?.querySelector('.u-dur'); if (t) t.textContent = fmtDur((player.duration - player.currentTime) * 1000); };

  async function openPerson(id, hint) {
    s.person = id; const epoch = ++s.epoch; inChat(true); els.clear(); view.reply = view.edit = view.attach = null;
    const cached = store.threads[id];
    buildThread(id, cached?.person || hint || {display_name: '', identities: []});
    savedOrder = [id, ...savedOrder.filter(x => x !== id)];
    if (cached) { paintThread(true); if (!cached.stale) { markRead(); persist(); return; } }
    else view.scroll.append(skeleton(6, 'bubbles'));
    if (!s.ready) return;
    try {
      const r = await call('people/' + id + '?limit=60');
      store.threads[id] = {person: r.person, messages: r.messages, has_more: r.has_more, next_cursor: r.next_cursor, warning: r.history_warning};
      store.typing[id] = r.typing || [];
      if (!store.seq) { store.seq = r.seq || 0; feed(); }
      persist();
      if (s.epoch !== epoch) return;
      if (cached) { paintHead(); paintThread(); } else { buildThread(id, r.person); paintThread(true); }
      markRead();
    } catch (e) { error(e); }
  }
  function reviewedOf(p) { return !!p.language && p.language !== 'en'; }
  function subtitle(p) {
    if ((store.typing[p.id] || []).length) return 'typing…';
    const langName = {th: 'Thai', ja: 'Japanese', zh: 'Chinese', es: 'Spanish', fr: 'French', de: 'German'}[p.language] || p.language;
    return reviewedOf(p) ? 'Auto-translate · ' + langName : networksOf(p).map(cap).join(' · ');
  }
  function paintHead() {
    const t = store.threads[s.person]; if (!t || !view.sub) return;
    view.sub.textContent = subtitle(t.person); view.sub.classList.toggle('typing', (store.typing[s.person] || []).length > 0);
  }
  function buildThread(id, p) {
    const root = threadBase(p.display_name || ' ', subtitle(p), p.id ? () => editPerson(store.threads[id]?.person || p) : null);
    view.sub = root.querySelector('.u-who-text span') || node('span'); if (!view.sub.parentNode) root.querySelector('.u-who-text').append(view.sub);
    const t = store.threads[id];
    const scroll = node('div', 'u-timeline'); scroll.setAttribute('role', 'log'); scroll.tabIndex = 0;
    scroll.oncontextmenu = e => { if (e.target.closest('.u-message')) e.preventDefault(); };
    scroll.onscroll = () => { const near = scroll.scrollHeight - scroll.scrollTop - scroll.clientHeight < 80; view.bottom = near; view.pill.hidden = near; if (near) markRead(); if (scroll.scrollTop < 400) older(); };
    const pill = iconButton('down', 'Scroll to newest', () => scroll.scrollTo({top: scroll.scrollHeight, behavior: 'smooth'}), 'u-down'); pill.hidden = true;
    const wrap = node('div', 'u-thread-body'); wrap.append(scroll, pill); root.append(wrap);
    Object.assign(view, {root, scroll, pill, id});
    root.append(composer(id, p));
  }
  function nearBottom() { const sc = view.scroll; return sc.scrollHeight - sc.scrollTop - sc.clientHeight < 80; }
  function paintThread(toBottom = false) {
    const t = store.threads[view.id], scroll = view.scroll; if (!t || !scroll) return;
    const follow = toBottom || nearBottom(), p = t.person, auto = reviewedOf(p), multi = networksOf(p).length > 1, group = (p.identities || []).some(i => i.kind === 'group');
    const kids = [node('div', 'u-spacer')];
    if (t.has_more) kids.push(node('p', 'u-older', 'Loading earlier messages…'));
    let day = '';
    const side = m => (m.outgoing ? 'o' : 'i' + (m.sender || ''));
    t.messages.forEach((m, i) => {
      const label = dayLabel(m.timestamp);
      if (label !== day) { day = label; kids.push(node('p', 'u-day', label)); }
      const prev = t.messages[i - 1], next = t.messages[i + 1];
      const jp = prev && dayLabel(prev.timestamp) === day && side(prev) === side(m) && m.timestamp - prev.timestamp < 3e5;
      const jn = next && dayLabel(next.timestamp) === day && side(next) === side(m) && next.timestamp - m.timestamp < 3e5;
      const pos = jp && jn ? 'mid' : jp ? 'last' : jn ? 'first' : 'single';
      const read = m.outgoing && p.peer_read_ts >= m.timestamp;
      const key = m.client_id || m.id;
      const sig = JSON.stringify([m.id, m.original, m.translated, m.translation_error, m.edited, m.deleted, m.reactions, m.pending, m.failed, pos, read, shown[m.id], m.reply?.text, auto, multi, group]);
      let el = els.get(key);
      if (!el || el.dataset.sig !== sig) { el = bubble(m, pos, {auto, multi, group, read}); el.dataset.sig = sig; els.set(key, el); }
      kids.push(el);
    });
    if (!t.messages.length) kids.push(node('p', 'u-empty', 'No messages yet. Say hi 👋'));
    const before = scroll.scrollHeight - scroll.scrollTop;
    const same = kids.length === scroll.children.length && kids.every((k, i) => k === scroll.children[i] || (i === 0 && scroll.children[0].className === 'u-spacer') || (k.className === 'u-day' && scroll.children[i].className === 'u-day' && k.textContent === scroll.children[i].textContent) || (k.className === 'u-older' && scroll.children[i].className === 'u-older'));
    if (!same) scroll.replaceChildren(...kids);
    if (follow) scroll.scrollTop = scroll.scrollHeight;
    else if (view.anchor) { scroll.scrollTop = scroll.scrollHeight - before; }
    view.anchor = false;
    if (follow) markRead();
  }
  async function older() {
    const t = store.threads[view.id]; if (!t || !t.has_more || view.loadingOlder) return;
    view.loadingOlder = true; const id = view.id;
    try {
      await fetchOlder(t, id, call);
      if (view.id === id) { view.anchor = true; paintThread(); }
    } catch (e) { error(e); } finally { view.loadingOlder = false; }
  }
  function markRead() {
    const t = store.threads[view.id]; if (!t || document.hidden || !view.scroll || !nearBottom()) return;
    const last = [...t.messages].reverse().find(m => !m.outgoing && !m.pending);
    if (!last || last.timestamp <= (t.person.last_read_ts || 0) || view.reading === last.timestamp) return;
    view.reading = last.timestamp; t.person.last_read_ts = last.timestamp;
    const row = store.lists[listKey(t.person)]?.find(x => x.id === view.id); if (row) row.unread = 0;
    call('people/' + view.id + '/read', {timestamp: last.timestamp}).catch(() => {});
  }
  const URL_RE = /\bhttps?:\/\/[^\s<>"']+[^\s<>"'.,;:!?)\]]/g;
  function richText(cls, text) {
    const p = node('p', cls); let at = 0;
    for (const m of text.matchAll(URL_RE)) { p.append(text.slice(at, m.index)); const a = node('a', '', m[0]); a.href = m[0]; a.target = '_blank'; a.rel = 'noopener noreferrer'; p.append(a); at = m.index + m[0].length; }
    p.append(text.slice(at)); return p;
  }
  function bubble(m, pos, ctx) {
    const row = node('div', 'u-row' + (m.outgoing ? ' outgoing' : '') + ' pos-' + pos); row.dataset.id = m.id;
    const b = node('article', 'u-message' + (m.outgoing ? ' outgoing' : '') + (m.deleted ? ' deleted' : '') + (m.pending ? ' pending' : '') + (m.failed ? ' failed' : ''));
    const visual = !m.deleted && ['m.image', 'm.sticker', 'm.video'].includes(m.msgtype);
    if (visual && !m.original) b.classList.add('bare');
    if (ctx.group && !m.outgoing && m.sender && (pos === 'first' || pos === 'single')) b.append(node('p', 'u-sender tone-text-' + toneOf(m.sender), nameOf(m.sender)));
    if (m.reply) {
      const q = button('', () => jumpTo(m.reply.id), 'u-quote');
      q.append(node('strong', '', m.reply.outgoing ? 'You' : nameOf(m.reply.sender) || 'Them'), node('span', '', m.reply.deleted ? 'Deleted message' : m.reply.voice ? '🎤 Voice message' : m.reply.text || {'m.image': '📷 Photo', 'm.video': '🎬 Video', 'm.file': '📎 File', 'm.sticker': 'Sticker'}[m.reply.msgtype] || ''));
      b.append(q);
    }
    if (m.deleted) b.append(node('p', 'u-deleted', m.outgoing ? 'You deleted this message' : 'This message was deleted'));
    else if (visual) b.append(visualMedia(m));
    else if (m.msgtype === 'm.audio') b.append(voice(m));
    else if (m.msgtype === 'm.file') { const a = node('a', 'u-file'); a.href = mediaURL(m.id); a.download = m.media?.filename || 'file'; a.append(node('span', 'u-file-icon', '📎'), node('span', 'u-file-name', m.media?.filename || 'File'), node('span', 'u-file-size', fmtSize(m.media?.size))); b.append(a); }
    else if (m.msgtype === 'm.location') { const geo = /^geo:([-\d.]+),([-\d.]+)/.exec(m.media?.geo || ''); const a = node('a', 'u-file', '📍 ' + (m.original || 'Location')); if (geo) { a.href = 'https://www.openstreetmap.org/?mlat=' + geo[1] + '&mlon=' + geo[2] + '#map=16/' + geo[1] + '/' + geo[2]; a.target = '_blank'; a.rel = 'noopener noreferrer'; } b.append(a); }
    if (!m.deleted && m.original && m.msgtype !== 'm.location') {
      if (ctx.auto || m.outgoing) {
        b.append(richText('u-text', m.translated || m.original));
        if (m.translated && m.translated !== m.original) b.append(node('p', 'u-original', m.original));
        if (m.translation_error) b.append(node('p', 'u-original error', m.translation_error));
      } else {
        const translated = shown[m.id] === 'translated' && m.translated;
        b.append(richText('u-text', translated ? m.translated : m.original));
        if (foreignScript(m.original)) b.append(button(translated ? 'Show original' : 'Translate', () => translate(m), 'u-translate link'));
      }
    }
    const meta = node('footer');
    if (ctx.multi) meta.append(node('span', 'u-net', cap(m.network)));
    if (m.edited && !m.deleted) meta.append(node('span', 'u-edited', 'edited'));
    meta.append(node('time', '', new Date(m.timestamp).toLocaleTimeString([], {hour: 'numeric', minute: '2-digit'})));
    if (m.outgoing) meta.append(m.failed ? node('span', 'u-status-ic fail', '!') : m.pending ? node('span', 'u-status-ic clock', '◷') : node('span', 'u-status-ic' + (ctx.read ? ' read' : ''), ctx.read ? '✓✓' : '✓'));
    b.append(meta);
    row.append(b);
    if (m.failed) row.append(button(m.failed === true ? 'Not sent · Tap to retry' : 'Not sent · ' + m.failed + ' · Retry', () => m.retry ? m.retry() : null, 'u-retry link'));
    if (m.reactions?.length) {
      const strip = node('div', 'u-reactions');
      for (const r of m.reactions) strip.append(button(r.key + (r.count > 1 ? ' ' + r.count : ''), () => react(m, r.key), 'u-react' + (r.mine ? ' mine' : '')));
      row.append(strip);
    }
    if (!m.pending && !m.deleted) gestures(row, b, m);
    return row;
  }
  function toneOf(name) { let h = 0; for (const ch of name || '?') h = (h * 31 + ch.codePointAt(0)) >>> 0; return h % TONES; }
  function visualMedia(m) {
    const box = node('button', 'u-media'); box.type = 'button'; box.setAttribute('aria-label', m.msgtype === 'm.video' ? 'Play video' : 'Open photo');
    const w = m.media?.w, h = m.media?.h;
    if (w && h) box.style.aspectRatio = w + ' / ' + h; else box.classList.add('unsized');
    if (m.msgtype === 'm.video') {
      const v = node('video'); v.preload = 'metadata'; v.playsInline = true; v.src = m.local || mediaURL(m.id); v.muted = true; box.append(v, node('span', 'u-play', '▶'));
      if (m.media?.duration) box.append(node('span', 'u-vdur', fmtDur(m.media.duration)));
    } else {
      const img = node('img'); img.alt = m.original || 'Photo'; img.decoding = 'async'; img.loading = 'lazy';
      img.onload = () => { img.classList.add('in'); if (!w && view.scroll && nearBottom()) view.scroll.scrollTop = view.scroll.scrollHeight; };
      img.onerror = () => { box.classList.add('broken'); box.append(node('span', 'u-broken', 'Photo unavailable')); };
      img.src = m.local || mediaURL(m.id, 'thumb'); box.append(img);
      if (m.msgtype === 'm.sticker') box.classList.add('sticker');
    }
    if (!m.pending) box.onclick = () => viewer(m); else box.append(node('span', 'u-spin'));
    return box;
  }
  function viewer(m) {
    closeOverlay(); lastFocus = document.activeElement; s.overlay = 'Photo';
    const layer = node('div', 'u-overlay u-viewer'); layer.id = 'u-overlay'; layer.setAttribute('role', 'dialog'); layer.setAttribute('aria-label', 'Photo');
    const bar = node('header'); const save = node('a', 'icon-button u-save'); save.href = mediaURL(m.id); save.download = ''; save.setAttribute('aria-label', 'Save'); save.append(icon('download'));
    bar.append(iconButton('close', 'Close', closeOverlay), node('span', 'u-viewer-who', m.outgoing ? 'You' : nameOf(m.sender)), save);
    let media;
    if (m.msgtype === 'm.video') { media = node('video'); media.controls = true; media.autoplay = true; media.playsInline = true; media.src = mediaURL(m.id); }
    else { media = node('img'); media.alt = m.original || 'Photo'; media.src = mediaURL(m.id); }
    layer.append(bar, media); if (m.original) layer.append(node('p', 'u-viewer-cap', m.original));
    layer.onclick = e => { if (e.target === layer || e.target === media && media.tagName === 'IMG') closeOverlay(); };
    $('messenger').append(layer); hold();
  }
  function voice(m) {
    const box = node('div', 'u-voice'); box.style.setProperty('--p', '0');
    const play = iconButton('play', 'Play voice message', () => {
      if (m.pending && !m.local) return;
      if (playing === box && !player.paused) { player.pause(); return; }
      if (playing !== box) { playing?.classList.remove('playing'); playing = box; player.src = m.local || mediaURL(m.id); }
      box.classList.add('playing'); player.play().catch(e => { box.classList.remove('playing'); error(new Error('Could not play this voice message')); });
    }, 'u-vplay');
    const bars = node('div', 'u-wave'); const wave = m.media?.waveform?.length ? m.media.waveform : Array.from({length: 40}, (_, i) => 30 + 25 * Math.sin(i * 1.7 + (m.id.length % 5)));
    const n = Math.min(40, wave.length); for (let i = 0; i < n; i++) { const bar = node('i'); bar.style.height = Math.max(12, wave[Math.floor(i * wave.length / n)]) + '%'; bar.dataset.at = String(i / n); bars.append(bar); }
    bars.onclick = e => { if (playing === box && player.duration) { const r = bars.getBoundingClientRect(); player.currentTime = player.duration * Math.min(1, Math.max(0, (e.clientX - r.left) / r.width)); } };
    box.append(play, bars, node('span', 'u-dur', fmtDur(m.media?.duration)));
    if (!m.media?.voice && m.media?.filename) box.append(node('span', 'u-file-name', m.media.filename));
    return box;
  }
  function jumpTo(id) { const el = view.scroll?.querySelector('[data-id="' + CSS.escape(id) + '"]'); if (el) { el.scrollIntoView({block: 'center', behavior: 'smooth'}); el.classList.add('flash'); setTimeout(() => el.classList.remove('flash'), 1200); } }
  function translate(m) {
    action(async () => {
      if (shown[m.id] !== 'translated' && !m.translated) { const r = await call('messages/' + encodeURIComponent(m.id) + '/translate', {}); if (r.error) throw new Error(r.error); m.translated = r.translated; }
      shown[m.id] = shown[m.id] === 'translated' ? 'original' : 'translated'; paintThread();
    });
  }

  // Long-press (or right-click) opens the menu; a short swipe right replies, like Signal.
  function gestures(row, b, m) {
    let timer = null, x0 = 0, y0 = 0, dx = 0, swiping = false;
    b.addEventListener('pointerdown', e => {
      if (e.button > 0 || e.target.closest('a,.u-vplay,.u-wave,.u-translate')) return;
      x0 = e.clientX; y0 = e.clientY; dx = 0; swiping = false;
      timer = setTimeout(() => { timer = null; navigator.vibrate?.(10); menu(m, b); }, 450);
    });
    b.addEventListener('pointermove', e => {
      const mx = e.clientX - x0, my = e.clientY - y0;
      if (timer && Math.hypot(mx, my) > 8) { clearTimeout(timer); timer = null; }
      if (e.pointerType === 'touch' && (swiping || (mx > 12 && Math.abs(my) < 10))) { swiping = true; dx = Math.max(0, Math.min(72, mx)); row.style.transform = 'translateX(' + dx + 'px)'; row.classList.toggle('arm', dx > 56); }
    });
    const end = () => { if (timer) { clearTimeout(timer); timer = null; } if (swiping) { row.style.transform = ''; row.classList.remove('arm'); if (dx > 56) startReply(m); swiping = false; } };
    b.addEventListener('pointerup', end); b.addEventListener('pointercancel', end); b.addEventListener('pointerleave', end);
    b.addEventListener('contextmenu', e => { e.preventDefault(); if (timer) clearTimeout(timer); timer = null; menu(m, b); });
  }
  function menu(m, b) {
    const t = store.threads[view.id]; if (!t) return;
    closeOverlay(); lastFocus = document.activeElement; s.overlay = 'Message';
    const layer = node('div', 'u-overlay u-menu-layer'); layer.id = 'u-overlay';
    const panel = node('div', 'u-menu'); panel.setAttribute('role', 'menu');
    const telegram = ['telegram', 'whatsapp', 'signal', 'slack'].includes(m.network);
    if (telegram) {
      const strip = node('div', 'u-quick');
      const mine = m.reactions?.find(r => r.mine)?.key;
      for (const k of [...new Set([...recent.slice(0, 2), ...QUICK])].slice(0, 6)) strip.append(button(k, () => { closeOverlay(); react(m, k); }, 'u-qr-btn' + (mine === k ? ' mine' : '')));
      strip.append(button('＋', () => { panel.replaceChildren(grid(m)); }, 'u-qr-btn more'));
      panel.append(strip);
    }
    const list = node('div', 'u-actions');
    const item = (label, ic, fn, cls = '') => { const it = button('', () => { closeOverlay(); fn(); }, 'u-act ' + cls); it.setAttribute('role', 'menuitem'); it.append(icon(ic), node('span', '', label)); list.append(it); };
    if (!m.deleted) item('Reply', 'reply', () => startReply(m));
    if (m.original && !m.deleted) item('Copy', 'copy', () => navigator.clipboard?.writeText(m.translated && shown[m.id] === 'translated' ? m.translated : m.original).then(() => toast('Copied')).catch(() => toast('Copy is not available here')));
    if (m.media && !m.deleted) item('Save', 'download', () => { const a = node('a'); a.href = mediaURL(m.id); a.download = m.media.filename || ''; a.click(); });
    if (m.outgoing && telegram && m.msgtype === 'm.text' && !m.deleted) item('Edit', 'compose', () => startEdit(m));
    item('Delete for me', 'trash', () => del(m, false), 'danger');
    if (m.outgoing && telegram && !m.deleted) item('Delete for everyone', 'trash', () => del(m, true), 'danger');
    panel.append(list); layer.append(panel);
    layer.onclick = e => { if (e.target === layer) closeOverlay(); };
    $('messenger').append(layer);
    const r = b.getBoundingClientRect(), H = $('messenger').clientHeight;
    panel.style.top = Math.max(12, Math.min(r.bottom + 8, H - 16 - (telegram ? 380 : 320))) + 'px';
    panel.classList.add(m.outgoing ? 'right' : 'left');
    b.closest('.u-row')?.classList.add('lifted'); layer.addEventListener('remove', () => {}); view.lifted = b.closest('.u-row');
    panel.querySelector('button')?.focus(); hold();
  }
  function grid(m) {
    const box = node('div', 'u-grid');
    for (const k of [...QUICK, ...MORE]) box.append(button(k, () => { closeOverlay(); react(m, k); }, 'u-qr-btn'));
    return box;
  }
  function toast(text) { const el = node('p', 'u-toast', text); $('messenger').append(el); setTimeout(() => el.remove(), 1600); }
  async function react(m, key) {
    recent = [key, ...recent.filter(k => k !== key)].slice(0, 8);
    const t = store.threads[view.id]; const before = m.reactions;
    // Optimistic: one reaction per person, tapping your own again removes it.
    const others = (m.reactions || []).map(r => r.mine ? {...r, count: r.count - 1, mine: false} : r).filter(r => r.count > 0);
    const had = (m.reactions || []).some(r => r.mine && r.key === key);
    if (!had) { const e = others.find(r => r.key === key); if (e) { e.count++; e.mine = true; } else others.push({key, count: 1, mine: true}); }
    m.reactions = others; paintThread();
    try { const r = await call('messages/' + encodeURIComponent(m.id) + '/react', {key}); mergeMessages(view.id, [r.message]); paintThread(); }
    catch (e) { m.reactions = before; paintThread(); error(e); }
  }
  async function del(m, everyone) {
    if (everyone && !confirm('Delete this message for everyone?')) return;
    try { const r = await call('messages/' + encodeURIComponent(m.id) + '/delete', {everyone}); mergeMessages(view.id, [r.message]); paintThread(); } catch (e) { error(e); }
  }
  function startReply(m) { view.edit = null; view.reply = m; view.paintBar?.(); view.draft?.focus(); }
  function startEdit(m) { view.reply = null; view.edit = m; view.draft.value = m.original; view.grow?.(); view.paintBar?.(); view.draft.focus(); }

  // ---------- composer: text, photo, voice; optimistic and idempotent ----------
  function composer(id, p) {
    const form = node('form', 'u-composer');
    const bar = node('div', 'u-bar'); bar.hidden = true;
    const channel = node('select', 'u-channel'); channel.setAttribute('aria-label', 'Send using channel');
    for (const i of p.identities || []) { const opt = node('option', '', 'via ' + cap(i.network) + ' · ' + i.label); opt.value = i.id; channel.append(opt); }
    channel.value = p.preferred_identity || p.identities?.[0]?.id || ''; channel.hidden = (p.identities || []).length < 2;
    const reviewed = reviewedOf(p), telegramOnly = (p.identities || []).some(i => ['telegram', 'whatsapp', 'signal', 'slack'].includes(i.network));
    const draft = node('textarea'); draft.rows = 1; draft.placeholder = reviewed ? 'Message in English' : 'Message'; draft.setAttribute('aria-label', 'Message'); draft.maxLength = 16384; draft.value = s.drafts[id] || '';
    const file = node('input'); file.type = 'file'; file.accept = 'image/jpeg,image/png,image/gif,image/webp'; file.hidden = true;
    const attach = iconButton('plus', 'Attach photo', () => file.click(), 'u-attach'); attach.hidden = !telegramOnly;
    const send = iconButton('send', reviewed ? 'Preview send' : 'Send', () => submit(), 'u-send');
    const mic = iconButton('mic', 'Record voice message', () => record(), 'u-mic'); mic.hidden = !telegramOnly;
    const field = node('div', 'u-field'); field.append(draft);
    const row = node('div', 'u-compose-row'); row.append(attach, field, send, mic, file);
    const paintBar = () => {
      bar.replaceChildren(); const target = view.edit || view.reply; const a = view.attach;
      bar.hidden = !target && !a;
      if (target) {
        const q = node('div', 'u-quote in-bar'); q.append(node('strong', '', view.edit ? 'Edit message' : target.outgoing ? 'Reply to yourself' : 'Reply to ' + (nameOf(target.sender) || p.display_name)), node('span', '', target.original || snippet({msgtype: target.msgtype, voice: target.media?.voice, text: ''})));
        bar.append(q, iconButton('close', 'Cancel', () => { if (view.edit) { draft.value = s.drafts[id] || ''; grow(); } view.reply = view.edit = null; paintBar(); }));
      }
      if (a) { const chip = node('div', 'u-attach-chip'); const img = node('img'); img.src = a.url; img.alt = 'Photo to send'; chip.append(img, iconButton('close', 'Remove photo', () => { URL.revokeObjectURL(a.url); view.attach = null; paintBar(); grow(); })); bar.append(chip); }
    };
    const grow = () => { draft.style.height = 'auto'; draft.style.height = Math.min(draft.scrollHeight, 140) + 'px'; const has = !!draft.value.trim() || !!view.attach; send.hidden = !has && telegramOnly && !view.edit; mic.hidden = !telegramOnly || !send.hidden; send.disabled = !has; };
    let typingAt = 0, idle = null;
    const typing = on => { if (!telegramOnly) return; call('people/' + id + '/typing', {typing: on}).catch(() => {}); };
    draft.oninput = () => {
      s.drafts[id] = view.edit ? s.drafts[id] : draft.value; grow(); saveDrafts(); hold();
      if (draft.value && Date.now() - typingAt > 4000) { typingAt = Date.now(); typing(true); }
      clearTimeout(idle); idle = setTimeout(() => { if (typingAt) { typingAt = 0; typing(false); } }, 5000);
    };
    draft.onkeydown = e => { if (e.key === 'Enter' && !e.shiftKey && !e.isComposing && matchMedia('(pointer: fine)').matches) { e.preventDefault(); submit(); } };
    file.onchange = async () => { const f = file.files[0]; file.value = ''; if (!f) return; try { view.attach = await preparePhoto(f); paintBar(); grow(); draft.focus(); } catch (e) { error(e); } };
    form.onsubmit = e => { e.preventDefault(); submit(); };
    function submit() {
      const text = draft.value.trim(), a = view.attach;
      if (!text && !a) return;
      if (view.edit) { const m = view.edit; view.edit = null; draft.value = s.drafts[id] || ''; grow(); paintBar(); if (text && text !== m.original) editMsg(m, text); return; }
      if (reviewed && !a) return reviewSend(id, p, text, channel.value);
      if (typingAt) { typingAt = 0; typing(false); }
      draft.value = ''; s.drafts[id] = ''; saveDrafts(); view.attach = null; const reply = view.reply; view.reply = null; paintBar(); grow(); hold();
      queueSend(id, {text, photo: a, reply, identity_id: channel.value});
    }
    async function record() {
      if (!navigator.mediaDevices?.getUserMedia || !window.MediaRecorder) return error(new Error('Voice recording is not available in this browser.'));
      let stream;
      try { stream = await navigator.mediaDevices.getUserMedia({audio: {echoCancellation: true, noiseSuppression: true}}); }
      catch { return error(new Error('Microphone access was blocked. Allow the microphone for Wizard and try again.')); }
      const type = ['audio/ogg;codecs=opus', 'audio/webm;codecs=opus', 'audio/mp4', 'audio/webm'].find(t => MediaRecorder.isTypeSupported(t)) || '';
      const rec = new MediaRecorder(stream, type ? {mimeType: type, audioBitsPerSecond: 32000} : {});
      const chunks = [], levels = []; const ctx = new (window.AudioContext || window.webkitAudioContext)();
      const an = ctx.createAnalyser(); an.fftSize = 512; ctx.createMediaStreamSource(stream).connect(an); const buf = new Uint8Array(an.fftSize);
      const started = Date.now(); let cancelled = false;
      const panel = node('div', 'u-recording'); const clock = node('span', 'u-rec-time', '0:00'); const live = node('div', 'u-wave live');
      const stopAll = () => { clearInterval(tick); stream.getTracks().forEach(t => t.stop()); ctx.close().catch(() => {}); panel.remove(); row.hidden = false; view.recording = null; hold(); };
      panel.append(iconButton('trash', 'Cancel recording', () => { cancelled = true; rec.stop(); }, 'u-rec-cancel'), node('span', 'u-rec-dot'), clock, live, iconButton('send', 'Send voice message', () => rec.stop(), 'u-send'));
      row.hidden = true; form.append(panel); view.recording = rec; hold();
      const tick = setInterval(() => {
        an.getByteTimeDomainData(buf); let sum = 0; for (const v of buf) sum += (v - 128) ** 2;
        const level = Math.min(1024, Math.round(Math.sqrt(sum / buf.length) * 40)); levels.push(level);
        clock.textContent = fmtDur(Date.now() - started);
        const i = node('i'); i.style.height = Math.max(10, level / 10.24) + '%'; live.append(i); while (live.children.length > 40) live.firstChild.remove();
        if (Date.now() - started > 15 * 60e3) rec.stop();
      }, 100);
      rec.ondataavailable = e => { if (e.data.size) chunks.push(e.data); };
      rec.onstop = () => {
        stopAll(); const duration = Date.now() - started;
        if (cancelled || duration < 600) { if (!cancelled) toast('Hold on a little longer to record'); return; }
        const blob = new Blob(chunks, {type: (rec.mimeType || type || 'audio/webm').split(';')[0]});
        const step = Math.max(1, levels.length / 64); const waveform = Array.from({length: Math.min(64, levels.length)}, (_, i) => levels[Math.floor(i * step)]);
        const reply = view.reply; view.reply = null; paintBar();
        queueSend(id, {voice: {blob, duration, waveform, url: URL.createObjectURL(blob)}, reply, identity_id: channel.value});
      };
      rec.start(250);
    }
    Object.assign(view, {draft, grow, paintBar});
    form.append(bar, channel, row); grow(); paintBar();
    return form;
  }
  function saveDrafts() { try { sessionStorage.setItem('messenger-unified-drafts', JSON.stringify(s.drafts)); } catch { /* drafts stay in memory */ } }
  async function preparePhoto(f) {
    if (f.size > 25 * 1048576) throw new Error('Photos up to 25 MB can be sent');
    if (f.type === 'image/gif') { const bmp = await createImageBitmap(f); return {blob: f, url: URL.createObjectURL(f), w: bmp.width, h: bmp.height}; }
    // Downscale like Signal's "standard" quality: long edge 2048, JPEG.
    const bmp = await createImageBitmap(f, {imageOrientation: 'from-image'});
    const scale = Math.min(1, 2048 / Math.max(bmp.width, bmp.height)), w = Math.round(bmp.width * scale), h = Math.round(bmp.height * scale);
    const canvas = node('canvas'); canvas.width = w; canvas.height = h; canvas.getContext('2d').drawImage(bmp, 0, 0, w, h);
    const blob = await new Promise(r => canvas.toBlob(r, 'image/jpeg', 0.85));
    return {blob, url: URL.createObjectURL(blob), w, h};
  }
  async function upload(id, kind, blob) {
    const response = await fetch('api/unified/people/' + encodeURIComponent(id) + '/upload?kind=' + kind, {method: 'PUT', credentials: 'same-origin', cache: 'no-store',
      headers: {'Content-Type': blob.type || 'application/octet-stream', 'X-Messenger-CSRF': csrf(), Accept: 'application/json'}, body: blob});
    let env = {}; try { env = await response.json(); } catch { /* gateway errors are not JSON */ }
    if (!response.ok || !env.ok) throw new Error(env.error?.message || 'Upload failed. Tap to retry.');
    return env.result;
  }
  const queues = {};
  function queueSend(id, job) {
    const t = store.threads[id]; if (!t) return;
    const client_id = 'w' + uid();
    const m = {id: 'pending:' + client_id, client_id, outgoing: true, pending: true, original: job.text || '', timestamp: Date.now(), network: t.person.identities?.[0]?.network || 'telegram',
      msgtype: job.photo ? 'm.image' : job.voice ? 'm.audio' : 'm.text', reactions: [], reply_to: job.reply?.id || null,
      reply: job.reply ? {id: job.reply.id, sender: job.reply.sender, outgoing: job.reply.outgoing, text: job.reply.original, msgtype: job.reply.msgtype, voice: job.reply.media?.voice} : null};
    if (job.photo) { m.local = job.photo.url; m.media = {w: job.photo.w, h: job.photo.h, mime: 'image/jpeg'}; }
    if (job.voice) { m.local = job.voice.url; m.media = {voice: true, duration: job.voice.duration, waveform: job.voice.waveform.map(v => Math.round(v / 10.24))}; }
    t.messages.push(m); store.pending++; hold();
    if (s.person === id) paintThread(true);
    const run = async () => {
      m.pending = true; m.failed = false; if (s.person === id) paintThread();
      try {
        let upload_id, media;
        if (job.photo) { upload_id = (await upload(id, 'image', job.photo.blob)).upload_id; media = {w: job.photo.w, h: job.photo.h}; }
        if (job.voice) { upload_id = (await upload(id, 'voice', job.voice.blob)).upload_id; media = {duration: job.voice.duration, waveform: job.voice.waveform}; }
        const r = await call('people/' + id + '/send', {text: job.text || '', client_id, reply_to: job.reply?.id || null, identity_id: job.identity_id || null, upload_id, media});
        if (r.message) mergeMessages(id, [r.message]);
        if (r.state === 'queued') toast('Queued in Messenger, not yet published');
        store.pending--; hold();
      } catch (e) {
        m.pending = false; m.failed = e.message && e.message.length < 80 ? e.message : true; m.retry = () => { queues[id] = (queues[id] || Promise.resolve()).then(run); };
        // still owed: the update hold stays until it is sent
      }
      if (s.person === id) paintThread();
    };
    queues[id] = (queues[id] || Promise.resolve()).then(run);
  }
  async function editMsg(m, text) {
    const before = m.original; m.original = text; m.edited = true; paintThread();
    try { const r = await call('messages/' + encodeURIComponent(m.id) + '/edit', {text}); mergeMessages(view.id, [r.message]); paintThread(); }
    catch (e) { m.original = before; paintThread(); error(e); }
  }
  function reviewSend(id, p, text, identity_id) {
    action(async () => {
      const preview = await call('people/' + id + '/preview', {text, identity_id});
      if (s.person !== id) return;
      const sheet = overlay('Review before sending');
      sheet.append(node('p', 'helper', cap(p.identities.find(i => i.id === preview.identity_id).network) + ' → ' + p.display_name), node('p', 'u-preview', preview.translated), node('p', 'u-original', preview.original));
      if (preview.error) sheet.append(node('p', 'error', preview.error));
      const reply = view.reply;
      const confirmSend = original => action(async () => {
        const r = await call('people/' + id + '/send', {preview_id: preview.id, send_original: original, reply_to: reply?.id || null, client_id: 'w' + uid()});
        if (s.drafts[id] === preview.original || (s.drafts[id] || '').trim() === preview.original) { s.drafts[id] = ''; saveDrafts(); if (view.draft) { view.draft.value = ''; view.grow(); } }
        view.reply = null; view.paintBar?.(); closeOverlay();
        if (r.message) { mergeMessages(id, [r.message]); paintThread(true); }
        if (r.state === 'queued') toast('Queued in Messenger, not yet published');
      });
      if (!preview.error) sheet.append(button('Send', () => confirmSend(false), 'primary wide'));
      if (preview.error || preview.translated !== preview.original) sheet.append(button('Send English original instead', () => confirmSend(true), 'secondary wide'));
    });
  }
  function editPerson(p) {
    const sheet = overlay(p.identities.every(i => i.kind === 'person') ? 'Contact' : 'Group'); const form = node('form');
    const hero = node('div', 'u-hero'); hero.append(avatar(p.display_name, 'large'), node('strong', '', p.display_name), node('span', '', networksOf(p).map(cap).join(' · '))); sheet.append(hero);
    const name = node('input'); name.value = p.display_name; name.maxLength = 160;
    const nameLabel = node('label', '', 'Name'); nameLabel.append(name);
    const lang = node('select'); for (const [value, label] of [['','Off'],['th','Thai'],['en','English'],['ja','Japanese'],['zh','Chinese'],['es','Spanish'],['fr','French'],['de','German']]) { const o = node('option', '', label); o.value = value; lang.append(o); } lang.value = p.language;
    const langLabel = node('label', '', 'Auto-translate'); langLabel.append(lang);
    const preferred = node('select'); const auto = node('option', '', 'Their last-used channel'); auto.value = ''; preferred.append(auto);
    for (const i of p.identities) { const o = node('option', '', cap(i.network) + ' · ' + i.label); o.value = i.id; preferred.append(o); } preferred.value = p.preferred_identity || '';
    const preferredLabel = node('label', '', 'Reply on'); preferredLabel.append(preferred);
    form.append(nameLabel, langLabel); if (p.identities.length > 1) form.append(preferredLabel);
    const save = () => action(async () => { await call('people/' + p.id, {display_name: name.value, language: lang.value, preferred_identity: preferred.value}); closeOverlay(); delete store.threads[p.id]; store.lists = {people: null, groups: null}; await openPerson(p.id); });
    form.append(button('Save', save, 'primary wide'));
    form.onsubmit = e => { e.preventDefault(); save(); }; sheet.append(form);
    if (p.identities.every(i => i.kind === 'person')) {
      const others = s.people.filter(x => x.id !== p.id);
      if (others.length) {
        const select = node('select'); select.setAttribute('aria-label', 'Merge another person'); for (const x of others) { const o = node('option', '', x.display_name); o.value = x.id; select.append(o); }
        const mergeLabel = node('label', '', 'Same person on another network'); mergeLabel.append(select);
        sheet.append(node('h3', '', 'Merge'), mergeLabel, button('Merge', () => action(async () => { await call('people/' + p.id + '/merge', {source_id: select.value}); closeOverlay(); delete store.threads[p.id]; store.lists = {people: null, groups: null}; await openPerson(p.id); }), 'secondary wide'));
      }
      if (p.identities.length > 1) for (const i of p.identities) sheet.append(button('Separate ' + cap(i.network) + ' · ' + i.label, () => action(async () => { await call('people/' + p.id + '/unmerge', {identity_id: i.id}); closeOverlay(); delete store.threads[p.id]; store.lists = {people: null, groups: null}; await openPerson(p.id); }), 'secondary wide'));
    } else {
      const labels = node('input'); labels.placeholder = 'Family, Friends'; labels.value = (p.labels || []).join(', ');
      const labelsLabel = node('label', '', 'Labels'); labelsLabel.append(labels);
      sheet.append(labelsLabel, button('Save labels', () => action(async () => { await call('groups/' + p.identities[0].id + '/labels', {labels: labels.value.split(',').map(x => x.trim()).filter(Boolean)}); closeOverlay(); }), 'secondary wide'));
    }
  }
  async function accounts() {
    const sheet = overlay('Settings');
    if (window.MessengerConnectors) {
      const networks = node('section', 'u-connected-networks'); sheet.append(networks);
      connectorController = window.MessengerConnectors(networks, (path, method, body) => api(path.replace(/^\//, ''), {method, body}));
      try {
        await connectorController.show();
        await agentAccess(sheet);
        return;
      } catch (e) {
        // Older/dormant installations retain the existing Telegram settings.
        networks.remove(); connectorController = null;
        if (!['not_found', 'unified_not_found'].includes(e.code)) {
          error(e); await agentAccess(sheet); return;
        }
      }
    }
    sheet.append(node('h3', '', 'Telegram'));
    try {
      const status = await call('telegram/status'); if (s.overlay !== 'Settings') return;
      if (status.pending_login) { localStorage.setItem(LOGIN_FLAG, '1'); return loginStep(status.pending_login, true); }
      const line = node('p', 'u-status ' + (status.logins?.length ? 'on' : 'off'), status.message + (status.state === 'disconnected' ? ' · Not connected' : '')); sheet.append(line);
      if (status.state === 'not_configured') sheet.append(node('p', 'helper', 'Add TELEGRAM_API_ID and TELEGRAM_API_HASH in the app’s installation settings. Your phone number and login code stay inside this private Messenger.'));
      if (!status.logins?.length) for (const [flow, label] of [['qr','Connect with QR'],['phone','Connect with phone']]) { const b = button(label, () => action(async () => loginStep(await call('telegram/start', {flow}))), flow === 'qr' ? 'primary wide' : 'secondary wide'); b.disabled = status.state === 'not_configured' || status.state === 'unavailable'; sheet.append(b); }
      if (status.logins?.length) sheet.append(button('Disconnect Telegram', () => action(async () => { await call('telegram/disconnect', {}); await accounts(); }), 'secondary wide danger'));
    } catch (e) { error(e); }
    agentAccess(sheet);
  }
  async function agentAccess(sheet) {
    const box = node('section', 'u-agent-access'); sheet.append(box);
    const paint = st => {
      box.replaceChildren(node('h3', '', 'Agent access'));
      const descriptions = {no_access: 'Status only. Agents cannot read your conversations.', read_only: 'Agents can read conversations, but cannot draft or change anything.', draft_only: 'Agents can read and save drafts. Only you can click Send.', full_access: 'Agents can read and send messages, react, edit and delete. Account linking and access settings stay owner-only.'};
      box.append(node('p', 'u-status ' + (st.enabled ? 'warn' : 'on'), descriptions[st.mode] || descriptions.no_access));
      const choice = node('select', 'u-channel'); choice.setAttribute('aria-label', 'Agent access level');
      for (const [value, label] of [['no_access', 'No access'], ['read_only', 'Read-only'], ['draft_only', 'Draft-only'], ['full_access', 'Full access']]) { const opt = node('option', '', label); opt.value = value; choice.append(opt); }
      choice.value = st.mode || 'no_access';
      const expiry = node('select', 'u-channel'); expiry.setAttribute('aria-label', 'Agent access duration');
      for (const [value, label] of [['', 'Until I change it'], ['60', '1 hour'], ['1440', '24 hours']]) { const opt = node('option', '', label); opt.value = value; expiry.append(opt); }
      box.append(choice, expiry, button('Save agent access', () => action(async () => {
        if (choice.value === 'full_access' && !confirm('Allow agents to send, edit and delete messages without your review?')) return;
        const body = {mode: choice.value}; if (expiry.value) body.minutes = Number(expiry.value);
        paint(await api('api/view/agent-access', {method: 'POST', body}));
      }), 'primary wide'));
      if (st.until) box.append(node('p', 'helper', 'Expires ' + new Date(st.until).toLocaleString()));
      box.append(node('p', 'helper', 'Application defense in depth, not protection against host root. Strong sender isolation requires a separately administered service.'), button('Review agent drafts', agentDrafts, 'secondary wide'));
      if (st.log.length) {
        const details = node('details', 'u-log'); details.append(node('summary', '', 'Recent agent requests'));
        const list = node('ul', 'u-access-log');
        for (const e of st.log.slice(0, 20)) list.append(node('li', e.outcome === 'blocked' ? 'blocked' : '', new Date(e.t).toLocaleString([], {month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit'}) + ' · ' + e.outcome + ' · ' + e.method + ' ' + e.route));
        details.append(list); box.append(details);
      }
    };
    try { const st = await api('api/view/agent-access'); if (s.overlay === 'Settings') paint(st); } catch (e) { error(e); }
  }
  async function agentDrafts() {
    const sheet = overlay('Agent drafts');
    try {
      const result = await api('api/drafts');
      if (s.overlay !== 'Agent drafts') return;
      if (!result.drafts.length) sheet.append(node('p', 'helper', 'No agent drafts yet. Nothing has been sent.'));
      for (const draft of result.drafts) {
        const row = node('div', 'u-account');
        row.append(node('p', '', draft.text), node('p', 'helper', draft.state + ' · revision ' + draft.revision), button('Review draft', () => reviewAgentDraft(draft), 'secondary'));
        sheet.append(row);
      }
    } catch (e) { sheet.append(node('p', 'error', e.message)); }
  }
  async function reviewAgentDraft(initial) {
    const sheet = overlay('Review agent draft'); let draft = initial;
    const problem = node('p', 'error'); problem.setAttribute('role', 'status');
    const recipient = node('select', 'u-channel'); recipient.setAttribute('aria-label', 'Draft recipient and channel');
    const body = node('textarea'); body.rows = 5; body.maxLength = 16384; body.value = draft.text; body.setAttribute('aria-label', 'Draft message');
    const preview = node('div', 'u-preview');
    let generation = 0;
    const invalidate = () => { generation++; preview.replaceChildren(); };
    recipient.onchange = body.oninput = invalidate;
    sheet.append(node('p', 'helper', 'Nothing is sent until you review this revision and click Send.'), recipient, body, problem, preview);
    try {
      const directory = await call('directory');
      if (s.overlay !== 'Review agent draft') return;
      for (const person of [...directory.people, ...directory.groups]) for (const identity of person.identities || []) {
        const opt = node('option', '', person.display_name + ' · ' + cap(identity.network) + ' · ' + identity.label);
        opt.value = JSON.stringify([person.id, identity.id]); recipient.append(opt);
      }
      recipient.value = JSON.stringify([draft.person_id, draft.identity_id]);
      const review = button('Save and review', () => action(async () => {
        problem.textContent = ''; invalidate(); const current = generation;
        try {
          const [person_id, identity_id] = JSON.parse(recipient.value);
          draft = (await api('api/drafts/' + draft.id, {method: 'POST', body: {revision: draft.revision, person_id, identity_id, text: body.value}})).draft;
          draft = (await api('api/drafts/' + draft.id + '/preview', {method: 'POST', body: {revision: draft.revision}})).draft;
          if (generation !== current || s.overlay !== 'Review agent draft') return;
          const reviewed = draft; const p = draft.preview;
          preview.append(node('p', '', 'Original: ' + p.original), node('p', '', p.error ? 'Translation failed. You may explicitly send the original.' : 'To send: ' + p.translated));
          const send = original => action(async () => {
            if (!confirm('Send this reviewed draft now?')) return;
            try { await api('api/drafts/' + reviewed.id + '/send', {method: 'POST', body: {revision: reviewed.revision, send_original: original}}); await agentDrafts(); }
            catch (e) { problem.textContent = e.message; invalidate(); }
          });
          if (!p.error) preview.append(button('Send', () => send(false), 'primary wide'));
          else preview.append(button('Send original', () => send(true), 'primary wide'));
        } catch (e) { problem.textContent = e.message || 'Choose a valid recipient and try again.'; }
      }), 'primary wide');
      review.disabled = draft.state !== 'draft'; body.disabled = recipient.disabled = review.disabled;
      if (draft.state === 'sending') sheet.append(node('p', 'helper', 'Delivery outcome is not yet confirmed. Check the conversation before taking any further action; do not create a replacement draft.'));
      if (draft.state !== 'sending') sheet.append(button('Delete draft', () => action(async () => {
        if (!confirm('Delete this local draft?')) return;
        try { await api('api/drafts/' + draft.id, {method: 'DELETE', body: {revision: draft.revision}}); await agentDrafts(); }
        catch (e) { problem.textContent = e.message; }
      }), 'secondary wide'));
      sheet.append(review, button('Back to drafts', agentDrafts, 'secondary wide'));
    } catch (e) { problem.textContent = e.message; }
  }
  const LOGIN_FLAG = 'messenger-telegram-login';
  // Region code, dialling code, name. Built from libphonenumber + ISO 3166 names.
  const COUNTRIES = 'AF93,Afghanistan|AL355,Albania|DZ213,Algeria|AD376,Andorra|AO244,Angola|AI1,Anguilla|AG1,Antigua & Barbuda|AR54,Argentina|AM374,Armenia|AW297,Aruba|AU61,Australia|AT43,Austria|AZ994,Azerbaijan|BS1,Bahamas|BH973,Bahrain|BD880,Bangladesh|BB1,Barbados|BY375,Belarus|BE32,Belgium|BZ501,Belize|BJ229,Benin|BM1,Bermuda|BT975,Bhutan|BO591,Bolivia|BA387,Bosnia & Herzegovina|BW267,Botswana|BR55,Brazil|GB44,Britain (UK)|IO246,British Indian Ocean Territory|BN673,Brunei|BG359,Bulgaria|BF226,Burkina Faso|BI257,Burundi|KH855,Cambodia|CM237,Cameroon|CA1,Canada|CV238,Cape Verde|BQ599,Caribbean NL|KY1,Cayman Islands|CF236,Central African Rep.|TD235,Chad|CL56,Chile|CN86,China|CX61,Christmas Island|CC61,Cocos (Keeling) Islands|CO57,Colombia|KM269,Comoros|CD243,Congo (Dem. Rep.)|CG242,Congo (Rep.)|CK682,Cook Islands|CR506,Costa Rica|HR385,Croatia|CU53,Cuba|CW599,Curaçao|CY357,Cyprus|CZ420,Czech Republic|CI225,Côte d’Ivoire|DK45,Denmark|DJ253,Djibouti|DM1,Dominica|DO1,Dominican Republic|TL670,East Timor|EC593,Ecuador|EG20,Egypt|SV503,El Salvador|GQ240,Equatorial Guinea|ER291,Eritrea|EE372,Estonia|SZ268,Eswatini (Swaziland)|ET251,Ethiopia|FK500,Falkland Islands|FO298,Faroe Islands|FJ679,Fiji|FI358,Finland|FR33,France|GF594,French Guiana|PF689,French Polynesia|GA241,Gabon|GM220,Gambia|GE995,Georgia|DE49,Germany|GH233,Ghana|GI350,Gibraltar|GR30,Greece|GL299,Greenland|GD1,Grenada|GP590,Guadeloupe|GU1,Guam|GT502,Guatemala|GG44,Guernsey|GN224,Guinea|GW245,Guinea-Bissau|GY592,Guyana|HT509,Haiti|HN504,Honduras|HK852,Hong Kong|HU36,Hungary|IS354,Iceland|IN91,India|ID62,Indonesia|IR98,Iran|IQ964,Iraq|IE353,Ireland|IM44,Isle of Man|IL972,Israel|IT39,Italy|JM1,Jamaica|JP81,Japan|JE44,Jersey|JO962,Jordan|KZ7,Kazakhstan|KE254,Kenya|KI686,Kiribati|KP850,Korea (North)|KR82,Korea (South)|KW965,Kuwait|KG996,Kyrgyzstan|LA856,Laos|LV371,Latvia|LB961,Lebanon|LS266,Lesotho|LR231,Liberia|LY218,Libya|LI423,Liechtenstein|LT370,Lithuania|LU352,Luxembourg|MO853,Macau|MG261,Madagascar|MW265,Malawi|MY60,Malaysia|MV960,Maldives|ML223,Mali|MT356,Malta|MH692,Marshall Islands|MQ596,Martinique|MR222,Mauritania|MU230,Mauritius|YT262,Mayotte|MX52,Mexico|FM691,Micronesia|MD373,Moldova|MC377,Monaco|MN976,Mongolia|ME382,Montenegro|MS1,Montserrat|MA212,Morocco|MZ258,Mozambique|MM95,Myanmar (Burma)|NA264,Namibia|NR674,Nauru|NP977,Nepal|NL31,Netherlands|NC687,New Caledonia|NZ64,New Zealand|NI505,Nicaragua|NE227,Niger|NG234,Nigeria|NU683,Niue|NF672,Norfolk Island|MK389,North Macedonia|MP1,Northern Mariana Islands|NO47,Norway|OM968,Oman|PK92,Pakistan|PW680,Palau|PS970,Palestine|PA507,Panama|PG675,Papua New Guinea|PY595,Paraguay|PE51,Peru|PH63,Philippines|PL48,Poland|PT351,Portugal|PR1,Puerto Rico|QA974,Qatar|RO40,Romania|RU7,Russia|RW250,Rwanda|RE262,Réunion|AS1,Samoa (American)|WS685,Samoa (western)|SM378,San Marino|ST239,Sao Tome & Principe|SA966,Saudi Arabia|SN221,Senegal|RS381,Serbia|SC248,Seychelles|SL232,Sierra Leone|SG65,Singapore|SK421,Slovakia|SI386,Slovenia|SB677,Solomon Islands|SO252,Somalia|ZA27,South Africa|SS211,South Sudan|ES34,Spain|LK94,Sri Lanka|BL590,St Barthelemy|SH290,St Helena|KN1,St Kitts & Nevis|LC1,St Lucia|SX1,St Maarten (Dutch)|MF590,St Martin (French)|PM508,St Pierre & Miquelon|VC1,St Vincent|SD249,Sudan|SR597,Suriname|SJ47,Svalbard & Jan Mayen|SE46,Sweden|CH41,Switzerland|SY963,Syria|TW886,Taiwan|TJ992,Tajikistan|TZ255,Tanzania|TH66,Thailand|TG228,Togo|TK690,Tokelau|TO676,Tonga|TT1,Trinidad & Tobago|TN216,Tunisia|TR90,Turkey|TM993,Turkmenistan|TC1,Turks & Caicos Is|TV688,Tuvalu|UG256,Uganda|UA380,Ukraine|AE971,United Arab Emirates|US1,United States|UY598,Uruguay|UZ998,Uzbekistan|VU678,Vanuatu|VA39,Vatican City|VE58,Venezuela|VN84,Vietnam|VG1,Virgin Islands (UK)|VI1,Virgin Islands (US)|WF681,Wallis & Futuna|EH212,Western Sahara|YE967,Yemen|ZM260,Zambia|ZW263,Zimbabwe|AX358,Åland Islands'.split('|').map(x => { const [, r, c, n] = x.match(/^([A-Z]{2})(\d+),(.*)$/); return {r, c, n}; });
  const flag = r => String.fromCodePoint(...[...r].map(ch => 0x1f1e6 + ch.charCodeAt(0) - 65));
  function phoneField(form) {
    // Country picker + national number, like Telegram's own login; the bridge still receives one +E.164 value.
    const pick = node('select', 'u-country'); pick.setAttribute('aria-label', 'Country');
    for (const k of COUNTRIES) { const o = node('option', '', flag(k.r) + '  ' + k.n + '  +' + k.c); o.value = k.r; pick.append(o); }
    const guess = (navigator.language || '').split('-')[1];
    const start = localStorage.getItem('messenger-phone-region') || (COUNTRIES.some(k => k.r === guess) ? guess : 'US');
    pick.value = COUNTRIES.some(k => k.r === start) ? start : 'US';
    const prefix = node('span', 'u-prefix'); const number = node('input');
    number.type = 'tel'; number.inputMode = 'tel'; number.autocomplete = 'tel-national'; number.required = true; number.placeholder = 'Phone number';
    number.setAttribute('aria-label', 'Phone number');
    const code = () => COUNTRIES.find(k => k.r === pick.value).c;
    const paint = () => { prefix.textContent = '+' + code(); localStorage.setItem('messenger-phone-region', pick.value); };
    pick.onchange = () => { paint(); number.focus(); };
    number.oninput = () => {
      // A pasted "+66 81…" picks the matching country for the owner.
      const digits = number.value.trim().startsWith('+') ? number.value.replace(/\D/g, '') : '';
      if (!digits) return;
      const match = COUNTRIES.filter(k => digits.startsWith(k.c)).sort((a, b) => b.c.length - a.c.length)[0];
      if (match && code() !== match.c) { pick.value = match.r; paint(); }
    };
    paint();
    const countryLabel = node('label', '', 'Country'); countryLabel.append(pick);
    const numberLabel = node('label', '', 'Phone number'); const row = node('div', 'u-phone'); row.append(prefix, number); numberLabel.append(row);
    form.append(countryLabel, numberLabel);
    return {
      get value() {
        const raw = number.value.trim(); let digits = raw.replace(/\D/g, '');
        if (raw.startsWith('+')) return '+' + digits;
        if (pick.value !== 'IT') digits = digits.replace(/^0+/, ''); // drop the national trunk 0 (Thai 08… → +66 8…)
        return '+' + code() + digits;
      },
      focus: () => number.focus(),
    };
  }
  async function resumeLogin() {
    // The owner leaves the app to read the Telegram code; bring the waiting step back on return.
    if (!s.ready || s.overlay || s.busy || !localStorage.getItem(LOGIN_FLAG)) return;
    try {
      const status = await call('telegram/status');
      if (status.pending_login && !s.overlay) loginStep(status.pending_login, true);
      else if (!status.pending_login) localStorage.removeItem(LOGIN_FLAG);
    } catch { /* status is retried on the next return */ }
  }
  function loginStep(result, resumed = false) {
    // bridgev2 embeds the LoginStep fields alongside login_id.
    s.login = null; const sheet = overlay('Connect Telegram'); s.login = result;
    const step = result.step || result;
    if (step.type === 'complete') localStorage.removeItem(LOGIN_FLAG); else localStorage.setItem(LOGIN_FLAG, '1');
    if (resumed) sheet.append(node('p', 'helper', 'Picking up where you left off.'));
    sheet.append(node('p', 'helper', step.instructions || 'Continue on Telegram'));
    const problem = node('p', 'error'); problem.setAttribute('role', 'alert');
    const advance = fields => action(async () => {
      const current = s.login; problem.textContent = '';
      try {
        const next = await call('telegram/step', {login_id: result.login_id, step_id: step.step_id, type: step.type, fields});
        if (s.login === current) loginStep(next);
      } catch (e) { problem.textContent = e.message || 'Telegram did not accept that. Try again.'; }
    });
    if (step.type === 'user_input') {
      const form = node('form'); form.autocomplete = 'off'; const inputs = {};
      for (const field of step.user_input.fields) {
        if (/phone/.test(field.type) || field.id === 'phone_number') { inputs[field.id] = phoneField(form); continue; }
        const label = node('label', '', field.name); const input = node('input');
        input.type = /password/.test(field.type) ? 'password' : /phone/.test(field.type) ? 'tel' : 'text';
        if (/code/.test(field.type) || /code/i.test(field.id)) { input.inputMode = 'numeric'; input.autocomplete = 'one-time-code'; }
        else input.autocomplete = /password/.test(field.type) ? 'current-password' : 'off';
        if (field.description) label.append(node('span', 'helper', field.description));
        input.required = !field.optional; label.append(input); form.append(label); inputs[field.id] = input;
      }
      form.append(problem, button('Continue', () => form.requestSubmit(), 'primary wide'));
      form.onsubmit = e => { e.preventDefault(); const fields = Object.fromEntries(Object.entries(inputs).map(([id, input]) => [id, input.value])); advance(fields); };
      sheet.append(form);
      requestAnimationFrame(() => Object.values(inputs)[0]?.focus());
    } else if (step.type === 'display_and_wait') {
      const display = step.display_and_wait;
      if (display.type === 'qr' && window.qrcode) {
        const qr = window.qrcode(0, 'M'); qr.addData(display.data); qr.make();
        const canvas = node('canvas', 'u-qr'); const count = qr.getModuleCount(), scale = 6; canvas.width = canvas.height = (count + 8) * scale;
        const ctx = canvas.getContext('2d'); ctx.fillStyle = '#fff'; ctx.fillRect(0, 0, canvas.width, canvas.height); ctx.fillStyle = '#000';
        for (let y=0;y<count;y++) for (let x=0;x<count;x++) if (qr.isDark(y,x)) ctx.fillRect((x+4)*scale,(y+4)*scale,scale,scale); sheet.append(canvas);
      } else sheet.append(node('p', 'u-preview', display.data || 'Waiting for Telegram approval'));
      sheet.append(problem, button('I scanned it', () => advance({}), 'primary wide'));
    } else if (step.type === 'complete') { s.login = null; sheet.append(node('p', '', 'Telegram connected. Your chats appear in Chats and Groups shortly.'), button('Done', () => { closeOverlay(); refresh(); }, 'primary wide')); return; }
    else sheet.append(node('p', 'error', 'This Telegram login step is not supported yet. Cancel and try again.'));
    sheet.append(button('Cancel', () => action(async () => {
      localStorage.removeItem(LOGIN_FLAG);
      await call('telegram/cancel', {login_id: result.login_id}).catch(() => {});
      closeOverlay();
    }), 'secondary wide'));
  }
  function switchTab(tab) { if (s.overlay) closeOverlay(); s.tab = tab; s.person = null; view.id = null; s.search = null; s.epoch++; inChat(false); document.documentElement.dataset.inboxTab = tab; $('unified-inbox').hidden = tab === 'messenger'; delete $('unified-inbox').dataset.label; for (const el of $('inbox-tabs').querySelectorAll('[data-tab]')) el.setAttribute('aria-selected', String(el.dataset.tab === tab)); if (tab !== 'messenger') renderList(); }
  function refresh() { store.lists = {people: null, groups: null}; if (!s.person && s.tab !== 'messenger') renderList(); }
  document.addEventListener('visibilitychange', () => { if (!document.hidden) { resumeLogin(); markRead(); } });
  // Keyboard open/close: keep the newest message glued above the composer.
  window.visualViewport?.addEventListener('resize', () => { if (s.person && view.scroll && view.bottom !== false) view.scroll.scrollTop = view.scroll.scrollHeight; });
  window.MessengerUnified = {
    settings: accounts,
    mount(options) { api = options.api; if (options.csrf) csrf = options.csrf; try { s.drafts = JSON.parse(sessionStorage.getItem('messenger-unified-drafts') || '{}'); } catch { s.drafts = {}; } for (const el of $('inbox-tabs').querySelectorAll('[data-tab]')) el.onclick = () => (el.getAttribute('aria-selected') === 'true' && !s.person && s.search == null && !s.overlay) ? null : switchTab(el.dataset.tab); },
    // Saved chats paint at once; the session handshake and the server's copy follow behind.
    paintSaved() { if (s.ready || !restore()) return false; $('inbox-tabs').hidden = false; switchTab('people'); return true; },
    authenticated() {
      if (s.ready) return; s.ready = true; $('inbox-tabs').hidden = false;
      const painted = document.documentElement.dataset.inboxTab;
      if (!painted) switchTab('people');
      else if (s.tab !== 'messenger') { if (s.person) openPerson(s.person); else freshen(s.tab === 'groups' ? 'groups' : 'people', s.epoch); }
      resumeLogin(); if (store.seq) feed();
    },
    active: () => s.ready && (s.tab !== 'messenger' || !!s.overlay), canGoBack: () => !!(s.overlay || s.person || s.search != null), back,
    signout(wipe = false) { clearTimeout(searchTimer); searchGeneration++; s.search = null; Object.assign(searchView, {query: null, rows: [], cursor: null, loading: false}); if (wipe) wipeCache(); feedCtl?.abort(); closeOverlay(); s.ready = false; s.epoch++; inChat(false); Object.assign(store, {seq: 0, lists: {people: null, groups: null}, threads: {}, typing: {}}); $('inbox-tabs').hidden = true; $('unified-inbox').hidden = true; $('unified-inbox').replaceChildren(); delete document.documentElement.dataset.inboxTab; }
  };
})();
