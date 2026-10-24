/* Unified inbox is a view of the authenticated Messenger API, never a Matrix client. */
(() => {
  'use strict';
  function backState(state) {
    if (state.overlay) return {...state, overlay: null, handled: true};
    if (state.person) return {...state, person: null, handled: true};
    if (state.search != null) return {...state, search: null, handled: true};
    return {...state, handled: false}; // Shared WizardApp owns the root guard.
  }
  if (typeof module !== 'undefined') module.exports = {backState};
  if (typeof document === 'undefined') return;
  const $ = id => document.getElementById(id);
  const s = {tab: 'people', person: null, overlay: null, search: null, ready: false, epoch: 0, busy: false, drafts: {}, people: [], login: null};
  let api, timer, lastFocus, updateHold;
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
    bell: ['M6 9a6 6 0 0 1 12 0c0 6 2.5 7.5 2.5 7.5h-17S6 15 6 9z', 'M10 20a2 2 0 0 0 4 0'],
    belloff: ['M6 9a6 6 0 0 1 9.4-4.9', 'M18 9c0 6 2.5 7.5 2.5 7.5H8', 'M10 20a2 2 0 0 0 4 0', 'M3 3l18 18'],
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
  // Hold off a Wizard update reload only for work a reload would really lose: a send still going out or a recording.
  // Drafts are kept in sessionStorage and come back after the reload, and an open sheet loses nothing, so neither holds.
  function hold() {
    const reason = view.recording ? 'Recording' : store.pending > 0 ? 'Sending' : s.busy ? 'Saving' : '';
    if (updateHold && updateHold.reason !== reason) { updateHold.h.release(); updateHold = null; }
    if (reason && !updateHold) updateHold = {reason, h: window.WizardApp.update.hold(reason)};
  }
  function inChat(on) { if (on) document.documentElement.dataset.inChat = ''; else delete document.documentElement.dataset.inChat; }
  function closeOverlay() {
    const answered = s.answer; s.answer = null; answered?.(false);
    s.login = null; s.overlay = null; $('u-overlay')?.remove(); view.lifted?.classList.remove('lifted'); view.lifted = null; lastFocus?.focus(); hold();
  }
  function back() {
    if (!s.overlay && view.selection?.active) { view.selection.clear(); return true; }
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
      field.oninput = () => { s.search = field.value; root.querySelector('.u-list')?.dispatchEvent(new Event('filter')); };
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
  async function newChat(shareText) {
    // The full A-Z contact list lives only here. From Wizard's share sheet it picks who gets the shared text.
    const title = shareText ? 'Send to…' : 'New chat';
    const sheet = overlay(title); sheet.classList.add('tall');
    // Sharing: settles true once the owner picks someone (text placed) or closes the picker (declined).
    const settled = shareText ? new Promise(resolve => { s.answer = () => resolve(true); }) : null;
    const search = node('input', 'u-search'); search.type = 'search'; search.placeholder = 'Search people and groups'; search.setAttribute('aria-label', 'Search people and groups');
    const list = node('div', 'u-directory'); sheet.append(search, list);
    try {
      const d = await call('directory'); if (s.overlay !== title) return settled;
      const all = [...d.people, ...d.groups.map(g => ({...g, group: true}))].sort((a, b) => a.display_name.localeCompare(b.display_name));
      const draw = () => {
        const q = search.value.trim().toLowerCase(); list.replaceChildren(); let letter = '';
        for (const p of all.filter(p => !q || p.display_name.toLowerCase().includes(q)).slice(0, 200)) {
          const first = ([...p.display_name.trim()][0] || '#').toUpperCase();
          if (!q && first !== letter) { letter = first; list.append(node('p', 'u-letter', /\p{L}/u.test(first) ? first : '#')); }
          const row = button('', () => { if (shareText) placeShared(p.id, shareText); closeOverlay(); openPerson(p.id); }, 'u-directory-row');
          const text = node('span', 'u-who-text'); text.append(node('strong', '', p.display_name), node('span', '', p.group ? 'Group' : networksOf(p).map(cap).join(' · ')));
          row.append(avatar(p.display_name, 'small'), text); list.append(row);
        }
        if (!list.children.length) list.append(node('p', 'u-empty', 'No one matches'));
      };
      search.oninput = draw; draw(); requestAnimationFrame(() => search.focus());
    } catch (e) { error(e); }
    return settled;
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
    syncBadge(); shareTargets(); clearTimeout(saveTimer);
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
  // App badge: the total unread across chats and groups goes on Messenger's desk mark, like the phone's app badge.
  const unreadById = {}, kindById = {}, mutedById = {}; let nativeUnread = 0;
  let badgeShown = -1;
  function noteUnread(rows) { for (const p of rows || []) { unreadById[p.id] = Math.max(0, p.unread | 0); kindById[p.id] = listKey(p); mutedById[p.id] = !!p.muted; } }
  // Each bottom tab carries its own unread count (Chats, Groups, Messenger), like Signal's tab badges.
  function paintTabBadges(counts) {
    for (const [tab, n] of Object.entries(counts)) {
      const b = document.querySelector(`#inbox-tabs [data-tab="${tab}"]`); if (!b) continue;
      let dot = b.querySelector('.tab-badge');
      if (!n) { dot?.remove(); b.setAttribute('aria-label', b.textContent.trim()); continue; }
      if (!dot) { dot = node('b', 'tab-badge'); b.append(dot); }
      dot.textContent = n > 99 ? '99+' : String(n); b.setAttribute('aria-label', `${b.querySelector('span')?.textContent || tab}, ${n} unread`);
    }
  }
  function syncBadge() {
    noteUnread(store.lists.people); noteUnread(store.lists.groups);
    const counts = {people: 0, groups: 0, messenger: nativeUnread};
    for (const [id, n] of Object.entries(unreadById)) if (!mutedById[id]) counts[kindById[id] === 'groups' ? 'groups' : 'people'] += n;
    paintTabBadges(counts);
    const n = counts.people + counts.groups + counts.messenger;
    if (n === badgeShown) return; badgeShown = n;
    try { Promise.resolve(window.WizardApp?.badge?.set?.(n)).catch(() => {}); } catch { /* standalone: no shell badge */ }
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
    if (r.reset) { for (const k in unreadById) delete unreadById[k]; store.seq = r.seq; store.lists = {people: null, groups: null}; store.threads = {}; if (s.person) openPerson(s.person); else renderList(); return; }
    store.seq = Math.max(store.seq, r.seq);
    if (r.people?.length) { noteUnread(r.people); mergeList(r.people); }
    for (const p of r.people || []) store.typing[p.id] = (r.typing || {})[p.id] || [];
    for (const [pid, rows] of Object.entries(r.messages || {})) mergeMessages(pid, rows);
    if (s.person && store.threads[s.person]) { paintHead(); paintThread(); }
    else if (!s.person && s.tab !== 'messenger') drawList();
    persist();
  }
  async function feed() {
    feedCtl?.abort(); const ctl = feedCtl = new AbortController();
    while (s.ready && !ctl.signal.aborted) {
      // Hidden (another desk in front, or the phone asleep) still listens, just less often: the unread badge on
      // Messenger's desk mark must move while you are elsewhere. markRead never runs while hidden.
      if (document.hidden) await sleep(4000);
      if (!s.ready || ctl.signal.aborted) return;
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
  function drawList() {
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
      const card = button('', () => { if (card.dataset.held) { delete card.dataset.held; return; } openPerson(p.id, p); }, 'u-person' + (p.unread ? ' unread' : '') + (p.muted ? ' muted' : ''));
      holdToMenu(card, () => chatMenu(p, card));
      card.append(avatar(p.display_name));
      const info = node('span', 'u-person-info');
      const top = node('span', 'u-chat-top'); const name = node('strong', '', p.display_name);
      if (p.muted) { const m = icon('belloff'); m.classList.add('u-muted-mark'); m.setAttribute('aria-label', 'Muted'); m.removeAttribute('aria-hidden'); name.append(m); }
      top.append(name);
      if (p.last) top.append(node('time', 'u-when', when(p.last.timestamp)));
      const bottom = node('span', 'u-chat-bottom');
      const typing = (store.typing[p.id] || []).length;
      if (typing) bottom.append(node('span', 'u-snippet typing', 'typing…'));
      else if (p.last) {
        const who = p.last.outgoing ? 'You: ' : groups && p.last.sender ? nameOf(p.last.sender).split(' ')[0] + ': ' : '';
        bottom.append(node('span', 'u-snippet', who + snippet(p.last)));
      }
      if (p.unread) bottom.append(node('span', 'u-badge' + (p.muted ? ' muted' : ''), p.unread > 99 ? '99+' : String(p.unread)));
      else if (p.last?.outgoing) bottom.append(node('span', 'u-ticks' + (p.peer_read_ts >= p.last.timestamp ? ' read' : ''), p.peer_read_ts >= p.last.timestamp ? '✓✓' : '✓'));
      info.append(top, bottom);
      const extra = [...(networksOf(p).length > 1 ? networksOf(p).map(cap) : []), ...(p.labels || [])];
      if (extra.length) info.append(node('span', 'u-tags', extra.join(' · ')));
      card.append(info); frag.append(card);
    }
    if (!frag.children.length) frag.append(node('p', 'u-empty', q ? 'No matches' : label ? 'No groups with this label' : groups ? 'Group chats appear here once an account is connected.' : 'No chats yet. Connect Telegram in Settings, or start a new chat.'));
    list.replaceChildren(frag);
  }

  // Long-press (or right-click) a chat row: Mute / Unmute. A held press never also opens the chat.
  // A phone turns the finger lifting off a long-press into a click, which lands on the menu's backdrop and closes
  // it at once. Swallow exactly that click.
  function swallowRelease() {
    const eat = e => { e.stopPropagation(); e.preventDefault(); window.removeEventListener('click', eat, true); };
    window.addEventListener('click', eat, true);
    const off = () => setTimeout(() => window.removeEventListener('click', eat, true), 400);
    window.addEventListener('pointerup', off, {once: true, capture: true}); window.addEventListener('pointercancel', off, {once: true, capture: true});
  }
  function holdToMenu(el, open) {
    let timer = null, x0 = 0, y0 = 0;
    const cancel = () => { if (timer) { clearTimeout(timer); timer = null; } };
    el.addEventListener('pointerdown', e => { if (e.button > 0) return; delete el.dataset.held; x0 = e.clientX; y0 = e.clientY; cancel();
      timer = setTimeout(() => { timer = null; el.dataset.held = '1'; navigator.vibrate?.(10); swallowRelease(); open(); }, 450); });
    el.addEventListener('selectstart', e => e.preventDefault());
    el.addEventListener('pointermove', e => { if (timer && Math.hypot(e.clientX - x0, e.clientY - y0) > 8) cancel(); });
    el.addEventListener('pointerup', cancel); el.addEventListener('pointercancel', cancel); el.addEventListener('pointerleave', cancel);
    // Android fires contextmenu during a touch long-press too: the timer has already opened the menu then.
    el.addEventListener('contextmenu', e => { e.preventDefault(); if (el.dataset.held) return; cancel(); open(); });
  }
  // One small action menu under a held row; used by Chats/Groups rows here and the Messenger tab's rows (app.js).
  function actionMenu(card, title, actions) {
    closeOverlay(); lastFocus = document.activeElement; s.overlay = 'Chat';
    const layer = node('div', 'u-overlay u-menu-layer'); layer.id = 'u-overlay';
    const panel = node('div', 'u-menu left'); panel.setAttribute('role', 'menu'); panel.setAttribute('aria-label', title);
    const list = node('div', 'u-actions');
    for (const a of actions) { const it = button('', () => { closeOverlay(); a.run(); }, 'u-act'); it.setAttribute('role', 'menuitem'); it.append(icon(a.icon), node('span', '', a.label)); list.append(it); }
    panel.append(list); layer.append(panel);
    layer.onclick = e => { if (e.target === layer) closeOverlay(); };
    $('messenger').append(layer);
    const r = card.getBoundingClientRect(), H = $('messenger').clientHeight;
    panel.style.top = Math.max(12, Math.min(r.bottom + 4, H - 40 - 50 * actions.length)) + 'px';
    list.firstChild?.focus(); hold();
  }
  const muteAction = (muted, run) => ({label: muted ? 'Unmute' : 'Mute', icon: muted ? 'bell' : 'belloff', run});
  function chatMenu(p, card) { actionMenu(card, p.display_name, [muteAction(p.muted, () => setMuted(p, !p.muted))]); }
  async function setMuted(p, muted) {
    const flip = v => { for (const k of ['people', 'groups']) for (const x of store.lists[k] || []) if (x.id === p.id) x.muted = v; p.muted = v; drawList(); syncBadge(); };
    flip(muted);
    try { await call('people/' + encodeURIComponent(p.id), {muted}); toast(muted ? 'Muted' : 'Unmuted'); persist(); }
    catch (e) { flip(!muted); toast(e.message || 'Could not change mute', 3000); }
  }

  // ---------- conversation ----------
  const view = {};  // live DOM handles for the open thread
  const els = new Map(); // message key -> bubble element (keyed render)
  // Voice playback goes through Web Audio, not an <audio> element: media elements take the phone's audio focus
  // and pause the owner's music; Web Audio plays alongside it, like a notification sound.
  const localAudio = new Map(); // blob: URL -> Blob for notes recorded on this device
  // Pitch-preserving speed-up for voice notes (WSOLA): overlap-add 40 ms Hann frames read RATE times faster,
  // each nudged up to ±6 ms to line up with the previous one, so 1.5x/2x sound like faster talking, not chipmunks.
  function stretchChannels(chs, sr, rate) {
    const x = chs[0], len = x.length, N = Math.max(64, Math.round(sr * 0.04) & ~1), Hs = N >> 1, Ha = Hs * rate, tol = Math.round(sr * 0.006);
    if (rate === 1 || len < N * 2) return chs;
    const frames = Math.max(1, Math.floor((len - N) / Ha) + 1), outLen = (frames - 1) * Hs + N;
    const win = new Float32Array(N); for (let i = 0; i < N; i++) win[i] = 0.5 - 0.5 * Math.cos(2 * Math.PI * i / N);
    const out = chs.map(() => new Float32Array(outLen));
    let prev = 0;
    for (let k = 0; k < frames; k++) {
      const nominal = Math.round(k * Ha); let best = Math.min(nominal, len - N);
      if (k > 0) {
        const target = prev + Hs; let score = -Infinity;
        for (let d = -tol; d <= tol; d += 2) {
          const p = nominal + d; if (p < 0 || p + N > len) continue;
          let s = 0; for (let i = 0; i < Hs; i += 4) s += x[p + i] * x[target + i];
          if (s > score) { score = s; best = p; }
        }
      }
      const o = k * Hs;
      for (let c = 0; c < chs.length; c++) { const src = chs[c], dst = out[c]; for (let i = 0; i < N; i++) dst[o + i] += src[best + i] * win[i]; }
      prev = best;
    }
    return out;
  }
  const player = (() => {
    let ctx = null, src = null, box = null, key = null, buf = null, startedAt = 0, offset = 0, timer = 0;
    // Speed, like Telegram's 1x / 1.5x / 2x: one choice for every note, remembered on this device.
    const RATES = [1, 1.5, 2]; let rate = RATES.includes(+localStorage.getItem('messenger.voice.rate')) ? +localStorage.getItem('messenger.voice.rate') : 1;
    const fast = new WeakMap(); // AudioBuffer -> Map(rate -> stretched AudioBuffer)
    const playable = () => {
      if (rate === 1) return buf;
      let m = fast.get(buf); if (!m) fast.set(buf, m = new Map());
      if (!m.has(rate)) {
        const chs = Array.from({length: buf.numberOfChannels}, (_, c) => buf.getChannelData(c)), out = stretchChannels(chs, buf.sampleRate, rate);
        const b = ctx.createBuffer(out.length, out[0].length, buf.sampleRate); out.forEach((d, c) => b.copyToChannel(d, c)); m.set(rate, b);
      }
      return m.get(rate);
    };
    const pos = () => src ? offset + (ctx.currentTime - startedAt) * rate : offset;
    const rateLabel = () => (rate === 1.5 ? '1.5' : String(rate)) + '×';
    const decoded = new Map(); // url -> Promise<AudioBuffer>, newest few only
    const noteTypes = new Map();
    const fetched = new Map(); // url -> Promise<ArrayBuffer>: voice notes downloaded ahead, before anyone taps Play
    // Wizard lowers Wizard Music while a note plays (shell-owned ducking) and brings it back after a short beat,
    // so pause/seek/next note doesn't pump the volume.
    let ducked = false, undock = 0;
    const music = on => {
      clearTimeout(undock);
      if (on) { if (!ducked) { ducked = true; window.WizardApp?.audio?.duck(true); } return; }
      undock = setTimeout(() => { if (ducked && !src) { ducked = false; window.WizardApp?.audio?.duck(false); } }, 600);
    };
    const paint = () => {
      if (!box || !buf) return; const at = pos(), f = Math.min(1, at / buf.duration);
      for (const i of box.querySelectorAll('.u-wave i')) i.classList.toggle('on', f > 0 && +i.dataset.at < f);
      const t = box.querySelector('.u-dur'); if (t) t.textContent = fmtDur((src || offset ? buf.duration - at : buf.duration) * 1000);
    };
    const halt = () => { if (src) { src.onended = null; try { src.stop(); } catch { /* already stopped */ } src.disconnect(); src = null; } clearInterval(timer); music(false); };
    const fetchNote = url => {
      if (!fetched.has(url)) {
        fetched.set(url, fetch(url, {credentials: 'same-origin'}).then(r => { if (!r.ok) throw new Error('media ' + r.status); noteTypes.set(url, r.headers.get('Content-Type')); return r.arrayBuffer(); }));
        fetched.get(url).catch(() => fetched.delete(url));
        while (fetched.size > 16) fetched.delete(fetched.keys().next().value);
      }
      return fetched.get(url);
    };
    const load = url => {
      if (!decoded.has(url)) {
        // Notes recorded here decode from the Blob itself: the CSP keeps fetch() off blob: URLs.
        const bytes = localAudio.has(url) ? localAudio.get(url).arrayBuffer() : fetchNote(url).then(b => b.slice(0));
        decoded.set(url, bytes.then(b => ctx.decodeAudioData(b)));
        decoded.get(url).catch(() => decoded.delete(url));
        while (decoded.size > 8) decoded.delete(decoded.keys().next().value);
      }
      return decoded.get(url);
    };
    const start = () => {
      halt(); src = ctx.createBufferSource(); src.buffer = playable(); src.connect(ctx.destination);
      if (offset >= buf.duration - 0.05) offset = 0;
      startedAt = ctx.currentTime; src.start(0, Math.min(offset / rate, src.buffer.duration)); box.classList.add('playing'); music(true);
      src.onended = () => { src = null; clearInterval(timer); offset = 0; box?.classList.remove('playing'); paint(); music(false); };
      timer = setInterval(paint, 100); paint();
    };
    return {
      rateLabel,
      async blob(url, type) { if (localAudio.has(url)) return localAudio.get(url); const bytes = await fetchNote(url); return new Blob([bytes], {type: type || noteTypes.get(url) || 'application/octet-stream'}); },
      // Tap the speed pill: 1x -> 1.5x -> 2x -> 1x, applied mid-note from the same spot.
      cycleRate() {
        const at = pos(); rate = RATES[(RATES.indexOf(rate) + 1) % RATES.length];
        try { localStorage.setItem('messenger.voice.rate', String(rate)); } catch { /* private mode */ }
        for (const el of document.querySelectorAll('.u-speed')) el.textContent = rateLabel();
        if (src) { offset = at; start(); }
      },
      preload(url) { if (!localAudio.has(url)) fetchNote(url).catch(() => {}); },
      playing: b => b === box && !!src,
      busy: () => !!src || !!view.recording,
      // A re-rendered bubble (older page loaded, server copy replaced the saved one) picks the playback back up.
      adopt(b, k) { if (k !== key || b === box) return; box = b; if (src) b.classList.add('playing'); paint(); },
      async toggle(b, url, k) {
        ctx ||= new (window.AudioContext || window.webkitAudioContext)();
        if (ctx.state === 'suspended') ctx.resume().catch(() => {});
        if (b === box && src) { offset = pos(); halt(); b.classList.remove('playing'); paint(); return; }
        if (b !== box) { halt(); if (box) { box.classList.remove('playing'); const old = box; box = null; for (const i of old.querySelectorAll('.u-wave i')) i.classList.remove('on'); } box = b; key = k; buf = null; offset = 0; }
        b.classList.add('playing');
        try { const got = await load(url); if (key !== k) return; buf = got; start(); }
        catch { if (key === k) { box.classList.remove('playing'); box = null; key = null; } error(new Error('Could not play this voice message')); }
      },
      seek(b, f) { if (b !== box || !buf) return; offset = buf.duration * f; if (src) start(); else paint(); },
      stop() { halt(); box?.classList.remove('playing'); box = key = buf = null; offset = 0; },
    };
  })();

  async function openPerson(id, hint) {
    view.selection?.clear(); s.person = id; const epoch = ++s.epoch; inChat(true); els.clear(); view.reply = view.edit = view.attach = null;
    const cached = store.threads[id];
    buildThread(id, cached?.person || hint || {display_name: '', identities: []});
    savedOrder = [id, ...savedOrder.filter(x => x !== id)];
    if (cached) { paintThread(true); if (!cached.stale) { markRead(); persist(); return; } }
    else view.scroll.append(skeleton(6, 'bubbles'));
    if (!s.ready) return;
    try {
      const r = await call('people/' + id + '?limit=60');
      store.threads[id] = {person: r.person, messages: r.messages, has_more: r.has_more, warning: r.history_warning};
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
    view.selection = messageSelection(root, () => (store.threads[id]?.messages || []).map(message => ({message, node: els.get(message.client_id || message.id)})));
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
      const sig = JSON.stringify([m.id, m.original, m.translated, m.transcript, m.translation_error, m.edited, m.deleted, m.reactions, m.pending, m.failed, pos, read, shown[m.id], m.reply?.text, auto, multi, group]);
      let el = els.get(key);
      if (!el || el.dataset.sig !== sig) { el = bubble(m, pos, {auto, multi, group, read}); el.dataset.sig = sig; els.set(key, el); }
      kids.push(el);
    });
    if (!t.messages.length) kids.push(node('p', 'u-empty', 'No messages yet. Say hi 👋'));
    // Download the newest few voice notes from others now, so Play starts at once.
    t.messages.filter(m => m.media?.voice && !m.outgoing && !m.deleted && !m.local).slice(-6).forEach(m => player.preload(mediaURL(m.id)));
    const before = scroll.scrollHeight - scroll.scrollTop;
    const same = kids.length === scroll.children.length && kids.every((k, i) => k === scroll.children[i] || (i === 0 && scroll.children[0].className === 'u-spacer') || (k.className === 'u-day' && scroll.children[i].className === 'u-day' && k.textContent === scroll.children[i].textContent) || (k.className === 'u-older' && scroll.children[i].className === 'u-older'));
    if (!same) scroll.replaceChildren(...kids);
    if (follow) scroll.scrollTop = scroll.scrollHeight;
    else if (view.anchor) { scroll.scrollTop = scroll.scrollHeight - before; }
    view.anchor = false;
    view.selection?.paint();
    if (follow) markRead();
  }
  async function older() {
    const t = store.threads[view.id]; if (!t || !t.has_more || view.loadingOlder) return;
    const first = t.messages.find(m => !m.pending); if (!first) return;
    view.loadingOlder = true; const id = view.id;
    try {
      const r = await call('people/' + id + '?limit=60&before=' + first.timestamp);
      const known = new Set(t.messages.map(m => m.id));
      t.messages = [...r.messages.filter(m => !known.has(m.id)), ...t.messages]; t.has_more = r.has_more;
      if (view.id === id) { view.anchor = true; paintThread(); }
    } catch (e) { error(e); } finally { view.loadingOlder = false; }
  }
  function markRead() {
    const t = store.threads[view.id]; if (!t || document.hidden || !view.scroll || !nearBottom()) return;
    const last = [...t.messages].reverse().find(m => !m.outgoing && !m.pending);
    if (!last || last.timestamp <= (t.person.last_read_ts || 0) || view.reading === last.timestamp) return;
    view.reading = last.timestamp; t.person.last_read_ts = last.timestamp;
    const row = store.lists[listKey(t.person)]?.find(x => x.id === view.id); if (row) row.unread = 0;
    unreadById[view.id] = 0; syncBadge();
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
  // One selection/forward controller for unified media threads and the text-only Marmot tab.
  // Selection is disposable UI, never an update hold. Sharing is OUT through Wizard's existing share service:
  // on Android choose Wizard in the OS sheet, then its existing new-chat/recent-thread picker.
  function messageSelection(root, entries) {
    const ids = new Set(), head = root.querySelector('.u-thread-head,.chat-header');
    const bar = node('header', 'u-selection'); bar.hidden = true; bar.setAttribute('aria-label', 'Selected messages');
    const count = node('strong', '', '0 selected'), cancel = button('Cancel', () => clear(), 'secondary');
    const forward = button('Forward to Wizard', () => send(), 'primary'); bar.append(cancel, count, forward); head.after(bar);
    let active = false, sending = false, queue = null, cursor = 0;
    function paint() {
      bar.hidden = !active; head.hidden = active; count.textContent = ids.size + ' selected';
      forward.disabled = !ids.size || sending; cancel.disabled = sending;
      forward.textContent = sending ? 'Forwarding…' : 'Forward to Wizard';
      for (const {message: m, node: row} of entries()) if (row) {
        row.classList.toggle('u-selecting', active); row.classList.toggle('u-selected', ids.has(m.id));
        row.setAttribute('aria-selected', String(ids.has(m.id)));
        let check = row.querySelector(':scope > .u-selection-check');
        if (active && !check) { check = node('span', 'u-selection-check'); check.setAttribute('aria-hidden', 'true'); row.append(check); }
        if (check) { check.hidden = !active; check.textContent = ids.has(m.id) ? '✓' : '○'; }
      }
    }
    function clear() { if (sending) return; active = false; ids.clear(); queue = null; cursor = 0; paint(); }
    root.addEventListener('click', e => {
      if (!active || !e.target.closest('.u-row,.message')) return;
      e.preventDefault(); e.stopImmediatePropagation(); if (sending) return;
      const found = entries().find(x => x.node?.contains(e.target)); if (!found || found.message.deleted || found.message.pending) return;
      const id = found.message.id; if (ids.has(id)) ids.delete(id); else ids.add(id); queue = null; cursor = 0; paint();
    }, true);
    const line = m => (m.outgoing ? 'You' : nameOf(m.sender) || 'Sender') + ' (' + new Date(m.timestamp).toLocaleString() + '): ' + (m.original || '') + (m.transcript ? '\nTranscript: ' + m.transcript : '');
    async function send() {
      if (sending || !ids.size) return; sending = true; paint();
      try {
        if (!queue) {
          queue = []; let texts = [];
          const flush = () => { if (texts.length) queue.push({text: texts.join('\n\n')}); texts = []; };
          for (const {message: m} of entries().filter(x => ids.has(x.message.id))) {
            if (m.media && ['m.audio','m.image','m.video','m.file','m.sticker'].includes(m.msgtype)) { flush(); queue.push({message: m}); if (m.original || m.transcript) texts.push(line(m)); }
            else texts.push(line(m));
          }
          flush(); cursor = 0;
        }
        const receipts = [];
        while (cursor < queue.length) {
          const op = queue[cursor]; let receipt;
          if (op.message) {
            const m = op.message, blob = m.msgtype === 'm.audio' ? await player.blob(m.local || mediaURL(m.id), m.media?.mime || m.media?.mimetype) : await fetch(m.local || mediaURL(m.id), {credentials: 'same-origin'}).then(r => { if (!r.ok) throw new Error('Could not download attachment'); return r.blob(); });
            const sender = (m.outgoing ? 'You' : nameOf(m.sender) || 'Sender').replace(/[\/:*?"<>|\x00-\x1f]/g, '_');
            const d = new Date(m.timestamp), pad = n => String(n).padStart(2, '0');
            const date = d.getFullYear() + '-' + pad(d.getMonth()+1) + '-' + pad(d.getDate()) + ' ' + pad(d.getHours()) + '-' + pad(d.getMinutes());
            const type = blob.type.split(';')[0], ext = {'audio/ogg':'ogg','audio/wav':'wav','audio/webm':'webm','audio/mp4':'m4a','audio/mpeg':'mp3','image/jpeg':'jpg','image/png':'png','image/webp':'webp','video/mp4':'mp4'}[type] || 'bin';
            const filename = (m.media.filename || sender + (m.msgtype === 'm.audio' ? ' voice note ' : ' attachment ') + date + '.' + ext).replace(/[\/:*?"<>|\x00-\x1f]/g, '_');
            receipt = await WizardApp.share.file(new File([blob], filename, {type: blob.type}), {title: 'Forwarded from ' + sender});
          } else receipt = await WizardApp.share.text({text: op.text, title: 'Forwarded from Messenger'});
          if (receipt !== 'shared' && receipt !== 'copied') { toast(receipt === 'cancelled' ? 'Share cancelled · selection kept; retry resumes' : 'Sharing unavailable · selection kept; retry resumes', 4500); return; }
          receipts.push(receipt); cursor++;
        }
        toast('Share result: ' + [...new Set(receipts)].join(', ') + ' · choose Wizard in the share sheet', 4500);
        sending = false; clear();
      } catch (e) { toast((e.message || 'Could not forward') + ' · Try Forward again', 4500); }
      finally { sending = false; paint(); }
    }
    return {get active() { return active; }, begin(id) { active = true; ids.add(id); queue = null; cursor = 0; paint(); }, paint, clear};
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
      player.toggle(box, m.local || mediaURL(m.id), m.client_id || m.id);
    }, 'u-vplay');
    const bars = node('div', 'u-wave'); const wave = m.media?.waveform?.length ? m.media.waveform : Array.from({length: 40}, (_, i) => 30 + 25 * Math.sin(i * 1.7 + (m.id.length % 5)));
    const n = Math.min(40, wave.length); for (let i = 0; i < n; i++) { const bar = node('i'); bar.style.height = Math.max(12, wave[Math.floor(i * wave.length / n)]) + '%'; bar.dataset.at = String(i / n); bars.append(bar); }
    bars.onclick = e => { const r = bars.getBoundingClientRect(); player.seek(box, Math.min(1, Math.max(0, (e.clientX - r.left) / r.width))); };
    const speed = button(player.rateLabel(), () => player.cycleRate(), 'u-speed'); speed.setAttribute('aria-label', 'Playback speed');
    box.append(play, bars, node('span', 'u-dur', fmtDur(m.media?.duration)), speed);
    player.adopt(box, m.client_id || m.id);
    if (!m.media?.voice && m.media?.filename) box.append(node('span', 'u-file-name', m.media.filename));
    const wrap = node('div', 'u-voice-note'); wrap.append(box);
    const transcript = node('p', 'u-transcript', m.transcript || ''); transcript.hidden = !m.transcript; wrap.append(transcript);
    if (!m.transcript && !m.pending && window.WizardApp?.voice?.transcribe) {
      const transcribe = button('Transcribe', async () => {
        if (transcribe.disabled) return; transcribe.disabled = true; transcribe.textContent = 'Transcribing…';
        try {
          let text = transcriptionText.get(m.id);
          if (!text) {
            const blob = await player.blob(m.local || mediaURL(m.id), m.media?.mime || m.media?.mimetype);
            if (blob.size > 25 * 1048576) throw new Error('Voice note is larger than 25 MB');
            const result = await WizardApp.voice.transcribe(blob);
            if (result.unavailable) throw new Error('Transcription is not set up on this Wizard');
            text = String(result.text || '').trim(); if (!text) throw new Error('No speech found');
            transcriptionText.set(m.id, text);
          }
          const saved = await call('messages/' + encodeURIComponent(m.id) + '/transcript', {text});
          m.transcript = saved.text; transcriptionText.delete(m.id); persist();
          transcript.textContent = m.transcript; transcript.hidden = false; transcribe.remove();
        } catch (e) { transcribe.disabled = false; transcribe.textContent = 'Retry transcription'; toast((e.message || 'Could not transcribe') + ' · Tap Retry transcription', 4500); }
      }, 'u-transcribe link'); wrap.append(transcribe);
    }
    return wrap;
  }
  const transcriptionText = new Map(); // retain a successful result if saving failed: Retry only saves, never bills twice
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
      if (view.selection?.active || e.button > 0 || e.target.closest('a,.u-vplay,.u-translate,.u-speed,.u-transcribe,.u-transcript')) return;
      delete b.dataset.held;
      x0 = e.clientX; y0 = e.clientY; dx = 0; swiping = false;
      timer = setTimeout(() => { timer = null; navigator.vibrate?.(10); b.dataset.held = '1'; swallowRelease(); menu(m, b); }, 450);
    });
    b.addEventListener('pointermove', e => {
      const mx = e.clientX - x0, my = e.clientY - y0;
      if (timer && Math.hypot(mx, my) > 8) { clearTimeout(timer); timer = null; }
      if (e.pointerType === 'touch' && (swiping || (mx > 12 && Math.abs(my) < 10))) { swiping = true; dx = Math.max(0, Math.min(72, mx)); row.style.transform = 'translateX(' + dx + 'px)'; row.classList.toggle('arm', dx > 56); }
    });
    const end = () => { if (timer) { clearTimeout(timer); timer = null; } if (swiping) { row.style.transform = ''; row.classList.remove('arm'); if (dx > 56) startReply(m); swiping = false; } };
    b.addEventListener('pointerup', end); b.addEventListener('pointercancel', end); b.addEventListener('pointerleave', end);
    b.addEventListener('contextmenu', e => { e.preventDefault(); if (b.dataset.held || view.selection?.active) return; if (timer) clearTimeout(timer); timer = null; menu(m, b); });
  }
  function menu(m, b) {
    const t = store.threads[view.id]; if (!t) return;
    closeOverlay(); lastFocus = document.activeElement; s.overlay = 'Message';
    const layer = node('div', 'u-overlay u-menu-layer'); layer.id = 'u-overlay';
    const panel = node('div', 'u-menu'); panel.setAttribute('role', 'menu');
    const telegram = m.network === 'telegram';
    if (telegram) {
      const strip = node('div', 'u-quick');
      const mine = m.reactions?.find(r => r.mine)?.key;
      for (const k of [...new Set([...recent.slice(0, 2), ...QUICK])].slice(0, 6)) strip.append(button(k, () => { closeOverlay(); react(m, k); }, 'u-qr-btn' + (mine === k ? ' mine' : '')));
      strip.append(button('＋', () => { panel.replaceChildren(grid(m)); }, 'u-qr-btn more'));
      panel.append(strip);
    }
    const list = node('div', 'u-actions');
    const item = (label, ic, fn, cls = '') => { const it = button('', () => { closeOverlay(); fn(); }, 'u-act ' + cls); it.setAttribute('role', 'menuitem'); it.append(icon(ic), node('span', '', label)); list.append(it); };
    if (!m.deleted) item('Select', 'copy', () => view.selection.begin(m.id));
    if (!m.deleted) item('Reply', 'reply', () => startReply(m));
    if (m.original && !m.deleted) item('Copy', 'copy', () => navigator.clipboard?.writeText(m.translated && shown[m.id] === 'translated' ? m.translated : m.original)?.then(() => toast('Copied')).catch(() => toast('Copy is not available here')));
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
  function toast(text, ms = 1600) { const el = node('p', 'u-toast', text); $('messenger').append(el); setTimeout(() => el.remove(), ms); }
  // A yes/no question in the usual bottom sheet; closing it any other way (X, backdrop, Back) counts as no.
  function ask({title, body, yes, no}) {
    return new Promise(resolve => {
      const panel = overlay(title); s.answer = resolve;
      const pick = v => { s.answer = null; resolve(v); closeOverlay(); };
      const pair = node('div', 'u-pair'); pair.append(button(no, () => pick(false), 'secondary'), button(yes, () => pick(true), 'primary'));
      panel.append(node('p', 'helper', body), pair); pair.lastChild.focus();
    });
  }
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
    const reviewed = reviewedOf(p), telegramOnly = (p.identities || []).some(i => i.network === 'telegram');
    const draft = node('textarea'); draft.rows = 1; draft.placeholder = reviewed ? 'Message in English' : 'Message'; draft.setAttribute('aria-label', 'Message'); draft.maxLength = 16384; draft.value = s.drafts[id] || '';
    const file = node('input'); file.type = 'file'; file.accept = 'image/jpeg,image/png,image/gif,image/webp'; file.multiple = true; file.hidden = true;
    const attach = iconButton('plus', 'Attach photos', () => file.click(), 'u-attach'); attach.hidden = !telegramOnly;
    const send = iconButton('send', reviewed ? 'Preview send' : 'Send', () => submit(), 'u-send');
    const mic = iconButton('mic', 'Record voice message', () => record(), 'u-mic'); mic.hidden = !telegramOnly;
    const field = node('div', 'u-field'); field.append(draft);
    const row = node('div', 'u-compose-row'); row.append(attach, field, send, mic, file);
    const paintBar = () => {
      bar.replaceChildren(); const target = view.edit || view.reply; const a = view.attach || [];
      bar.hidden = !target && !a.length;
      if (target) {
        const q = node('div', 'u-quote in-bar'); q.append(node('strong', '', view.edit ? 'Edit message' : target.outgoing ? 'Reply to yourself' : 'Reply to ' + (nameOf(target.sender) || p.display_name)), node('span', '', target.original || snippet({msgtype: target.msgtype, voice: target.media?.voice, text: ''})));
        bar.append(q, iconButton('close', 'Cancel', () => { if (view.edit) { draft.value = s.drafts[id] || ''; grow(); } view.reply = view.edit = null; paintBar(); }));
      }
      if (a.length) { const strip = node('div', 'u-attach-strip'); for (const ph of a) { const chip = node('div', 'u-attach-chip'); const img = node('img'); img.src = ph.url; img.alt = 'Photo to send'; chip.append(img, iconButton('close', 'Remove photo', () => { URL.revokeObjectURL(ph.url); view.attach = a.filter(x => x !== ph); if (!view.attach.length) view.attach = null; paintBar(); grow(); })); strip.append(chip); } bar.append(strip); }
    };
    const grow = () => { draft.style.height = 'auto'; draft.style.height = Math.min(draft.scrollHeight, 140) + 'px'; const has = !!draft.value.trim() || !!view.attach?.length; send.hidden = !has && telegramOnly && !view.edit; mic.hidden = !telegramOnly || !send.hidden; send.disabled = !has; };
    let typingAt = 0, idle = null;
    const typing = on => { if (!telegramOnly) return; call('people/' + id + '/typing', {typing: on}).catch(() => {}); };
    draft.oninput = () => {
      s.drafts[id] = view.edit ? s.drafts[id] : draft.value; grow(); saveDrafts(); hold();
      if (draft.value && Date.now() - typingAt > 4000) { typingAt = Date.now(); typing(true); }
      clearTimeout(idle); idle = setTimeout(() => { if (typingAt) { typingAt = 0; typing(false); } }, 5000);
    };
    draft.onkeydown = e => { if (e.key === 'Enter' && !e.shiftKey && !e.isComposing && matchMedia('(pointer: fine)').matches) { e.preventDefault(); submit(); } };
    // Several photos at once, like Wizard chats (up to 10, Telegram's album size); each goes as its own photo, the caption on the first.
    file.onchange = async () => { const picked = [...file.files]; file.value = ''; if (!picked.length) return; const room = 10 - (view.attach?.length || 0); if (picked.length > room) toast('Up to 10 photos at a time'); try { const ready = []; for (const f of picked.slice(0, Math.max(0, room))) ready.push(await preparePhoto(f)); view.attach = [...(view.attach || []), ...ready]; paintBar(); grow(); draft.focus(); } catch (e) { error(e); } };
    form.onsubmit = e => { e.preventDefault(); submit(); };
    function submit() {
      const text = draft.value.trim(), a = view.attach || [];
      if (!text && !a.length) return;
      if (view.edit) { const m = view.edit; view.edit = null; draft.value = s.drafts[id] || ''; grow(); paintBar(); if (text && text !== m.original) editMsg(m, text); return; }
      if (reviewed && !a.length) return reviewSend(id, p, text, channel.value);
      if (typingAt) { typingAt = 0; typing(false); }
      draft.value = ''; s.drafts[id] = ''; saveDrafts(); view.attach = null; const reply = view.reply; view.reply = null; paintBar(); grow(); hold();
      if (!a.length) queueSend(id, {text, photo: null, reply, identity_id: channel.value});
      else a.forEach((ph, i) => queueSend(id, {text: i ? '' : text, photo: ph, reply: i ? null : reply, identity_id: channel.value}));
    }
    // Voice notes record through Wizard's shared capture service (WizardApp.capture): on the Android app that is the
    // native recorder pinned to the phone's own mic with no audio focus, so Bluetooth speakers keep playing music;
    // elsewhere it is the shared browser recorder with the same external-mic guard. Messenger never opens the mic itself.
    async function record() {
      if (!window.WizardApp?.capture) return error(new Error('Voice notes need Wizard. Open Messenger from Wizard and try again.'));
      let session;
      try { session = await WizardApp.capture.start({kind: 'audio', meta: {purpose: 'messenger-voice', person: id}, maxMs: 15 * 60e3, maxBytes: 24 * 1048576}); }
      catch (e) { return error(new Error(e?.code === 'busy' ? 'The microphone is busy with another Wizard recording.' : e?.message || 'Could not start recording.')); }
      const levels = [], started = Date.now(); let done = false;
      const panel = node('div', 'u-recording'); const clock = node('span', 'u-rec-time', '0:00'); const live = node('div', 'u-wave live');
      const close = () => { done = true; clearInterval(tick); offLevel?.(); panel.remove(); row.hidden = false; view.recording = null; hold(); };
      let last = 0; const offLevel = session.onLevel?.(v => { last = v; });
      const tick = setInterval(() => {
        const level = Math.round(Math.min(1, last * 1.6) * 1024); levels.push(level); clock.textContent = fmtDur(Date.now() - started);
        const i = node('i'); i.style.height = Math.max(10, level / 10.24) + '%'; live.append(i); while (live.children.length > 40) live.firstChild.remove();
      }, 100);
      const cancel = async () => { if (done) return; close(); try { await session.cancel(); } catch (e) { error(new Error('Could not discard the recording: ' + (e.message || e))); } };
      const finish = async () => {
        if (done) return; close();
        let take; try { take = await session.stop(); } catch (e) { return error(new Error('Recording kept on this device; try again. ' + (e.message || ''))); }
        const duration = take.durationMs || Date.now() - started;
        if (duration < 600 || !take.blob?.size) { toast('Hold on a little longer to record'); WizardApp.capture.ack(take.id).catch(() => {}); return; }
        const step = Math.max(1, levels.length / 64); const waveform = Array.from({length: Math.min(64, levels.length)}, (_, i) => levels[Math.floor(i * step)]);
        const url = URL.createObjectURL(take.blob); localAudio.set(url, take.blob);
        const reply = view.reply; view.reply = null; paintBar();
        queueSend(id, {voice: {blob: take.blob, take: take.id, duration, waveform, url}, reply, identity_id: channel.value});
      };
      panel.append(iconButton('trash', 'Cancel recording', cancel, 'u-rec-cancel'), node('span', 'u-rec-dot'), clock, live, iconButton('send', 'Send voice message', finish, 'u-send'));
      row.hidden = true; form.append(panel); view.recording = {stop: finish, cancel}; hold();
    }
    Object.assign(view, {draft, grow, paintBar});
    form.append(bar, channel, row); grow(); paintBar();
    return form;
  }
  // WebM (Matroska) Opus -> Ogg Opus, packet for packet (RFC 7845). Throws on anything it does not understand.
  function webmToOgg(b) {
    let at = 0, head = null, channels = 1, codec = '';
    const packets = [];
    const vint = keep => { const f = b[at]; let n = 1; while (n <= 8 && !(f & (0x80 >> (n - 1)))) n++; if (n > 8 || at + n > b.length) throw new Error('bad vint');
      let v = keep ? f : f & (0xff >> n), all = (f & (0xff >> n)) === (0xff >> n); for (let i = 1; i < n; i++) { v = v * 256 + b[at + i]; if (b[at + i] !== 0xff) all = false; } at += n; return keep ? v : (all ? -1 : v); };
    const MASTER = new Set([0x18538067, 0x1654AE6B, 0xAE, 0xE1, 0x1F43B675, 0xA0]);
    while (at < b.length) {
      const id = vint(true), size = vint(false);
      if (MASTER.has(id)) continue;
      if (size < 0 || at + size > b.length) { if (id === 0xA3 || id === 0xA1) break; throw new Error('bad size'); }
      const body = b.subarray(at, at + size); at += size;
      if (id === 0x86) codec = new TextDecoder().decode(body);
      else if (id === 0x63A2) head = body;
      else if (id === 0x9F) channels = body[0] || 1;
      else if (id === 0xA3 || id === 0xA1) {
        let i = 0; const f = body[0]; let n = 1; while (n <= 8 && !(f & (0x80 >> (n - 1)))) n++; i = n + 2;
        if ((body[i] >> 1) & 3) throw new Error('laced block'); packets.push(body.subarray(i + 1));
      }
    }
    if (codec && codec !== 'A_OPUS') throw new Error('not opus'); if (!packets.length) throw new Error('empty');
    return oggFromOpus(packets, channels, head);
  }
  // Opus packets -> Ogg Opus file (RFC 7845).
  function oggFromOpus(packets, channels, head) {
    const ascii = t => Uint8Array.from(t, c => c.charCodeAt(0));
    if (!head || String.fromCharCode(...head.subarray(0, 8)) !== 'OpusHead') {
      head = new Uint8Array(19); head.set(ascii('OpusHead')); const d = new DataView(head.buffer); head[8] = 1; head[9] = channels; d.setUint16(10, 312, true); d.setUint32(12, 48000, true);
    }
    const tags = new Uint8Array(8 + 4 + 6 + 4); tags.set(ascii('OpusTags')); new DataView(tags.buffer).setUint32(8, 6, true); tags.set(ascii('Wizard'), 12);
    const samples = p => { const c = p[0] >> 3, fs = c < 12 ? [480, 960, 1920, 2880][c & 3] : c < 16 ? [480, 960][c & 1] : [120, 240, 480, 960][c & 3], k = p[0] & 3; return fs * (k === 0 ? 1 : k === 3 ? (p[1] & 63) : 2); };
    const crcT = webmToOgg.crc ||= Array.from({length: 256}, (_, i) => { let r = i << 24; for (let k = 0; k < 8; k++) r = r & 0x80000000 ? (r << 1) ^ 0x04c11db7 : r << 1; return r >>> 0; });
    const serial = (Math.random() * 2 ** 32) >>> 0, pages = []; let seq = 0;
    const page = (list, granule, flag) => {
      const lace = []; for (const p of list) { let n = p.length; while (n >= 255) { lace.push(255); n -= 255; } lace.push(n); }
      const len = 27 + lace.length + list.reduce((a, p) => a + p.length, 0), out = new Uint8Array(len), d = new DataView(out.buffer);
      out.set(ascii('OggS')); out[5] = flag; d.setUint32(6, granule % 2 ** 32, true); d.setUint32(10, Math.floor(granule / 2 ** 32), true);
      d.setUint32(14, serial, true); d.setUint32(18, seq++, true); out[26] = lace.length; out.set(lace, 27);
      let o = 27 + lace.length; for (const p of list) { out.set(p, o); o += p.length; }
      let crc = 0; for (let i = 0; i < len; i++) crc = ((crc << 8) ^ crcT[((crc >>> 24) ^ out[i]) & 0xff]) >>> 0; d.setUint32(22, crc, true);
      pages.push(out);
    };
    page([head], 0, 2); page([tags], 0, 0);
    let granule = 0, batch = [], segs = 0;
    packets.forEach((p, n) => {
      const need = Math.floor(p.length / 255) + 1;
      if (batch.length && segs + need > 255) { page(batch, granule, 0); batch = []; segs = 0; }
      batch.push(p); segs += need; granule += samples(p);
      if (n === packets.length - 1) page(batch, granule, 4); else if (batch.length >= 50) { page(batch, granule, 0); batch = []; segs = 0; }
    });
    const total = new Uint8Array(pages.reduce((a, p) => a + p.length, 0)); let o = 0; for (const p of pages) { total.set(p, o); o += p.length; }
    return total;
  }
  window.MessengerUnified_webmToOgg = webmToOgg; window.MessengerUnified_toOggOpus = b => toOggOpus(b); // test hooks
  // Any recording -> Ogg Opus. WebM Opus (shared browser recorder) is rewrapped as is; anything else (the Android
  // recorder's AAC) is decoded and re-encoded with WebCodecs at 32 kbit/s mono, like Telegram's own voice notes.
  async function toOggOpus(blob) {
    const bytes = new Uint8Array(await blob.arrayBuffer());
    if (bytes[0] === 0x4f && bytes[1] === 0x67 && bytes[2] === 0x67 && bytes[3] === 0x53) return new Blob([bytes], {type: 'audio/ogg'});
    if (bytes[0] === 0x1a && bytes[1] === 0x45) { try { return new Blob([webmToOgg(bytes)], {type: 'audio/ogg'}); } catch { /* re-encode below */ } }
    if (!window.AudioEncoder) throw new Error('This device cannot prepare voice notes for Telegram yet');
    const AC = window.OfflineAudioContext || window.webkitOfflineAudioContext;
    const decoded = await new AC(1, 48000, 48000).decodeAudioData(bytes.buffer.slice(0));
    // Mix to mono at 48 kHz.
    const off = new AC(1, Math.max(1, Math.ceil(decoded.duration * 48000)), 48000), src = off.createBufferSource();
    src.buffer = decoded; src.connect(off.destination); src.start(); const pcm = (await off.startRendering()).getChannelData(0);
    const packets = []; let err = null;
    const enc = new AudioEncoder({output: c => { const p = new Uint8Array(c.byteLength); c.copyTo(p); packets.push(p); }, error: e => { err = e; }});
    enc.configure({codec: 'opus', sampleRate: 48000, numberOfChannels: 1, bitrate: 32000});
    for (let at = 0; at < pcm.length; at += 960) {
      const frame = pcm.slice(at, at + 960);
      enc.encode(new AudioData({format: 'f32', sampleRate: 48000, numberOfFrames: frame.length, numberOfChannels: 1, timestamp: Math.round(at / 48), data: frame}));
    }
    await enc.flush(); enc.close(); if (err) throw err; if (!packets.length) throw new Error('Voice note was empty');
    return new Blob([oggFromOpus(packets, 1)], {type: 'audio/ogg'});
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
    // Telegram takes voice notes only as Ogg Opus. Retries convert again from the kept original.
    if (kind === 'voice') blob = await toOggOpus(blob);
    const response = await fetch('api/unified/people/' + encodeURIComponent(id) + '/upload?kind=' + kind, {method: 'PUT', credentials: 'same-origin', cache: 'no-store',
      headers: {'Content-Type': blob.type || 'application/octet-stream', 'X-Messenger-CSRF': csrf(), Accept: 'application/json'}, body: blob});
    let env = {}; try { env = await response.json(); } catch { /* gateway errors are not JSON */ }
    if (!response.ok || !env.ok) throw new Error(env.error?.message || 'Upload failed. Tap to retry.');
    return env.result;
  }
  const queues = {};
  const offline = e => e?.code === 'server_restarting' || (e instanceof TypeError && /fetch|network|load failed/i.test(e.message || ''));
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
        if (job.voice?.take) WizardApp.capture.ack(job.voice.take).catch(() => {}); // sent: release the shared recorder's kept copy
        if (r.state === 'queued') toast('Queued in Messenger, not yet published');
        store.pending--; hold();
      } catch (e) {
        // Messenger restarting (release, update) or the network dropped: the send is idempotent on client_id,
        // so wait for the app to answer again and resend once per tick, for up to two minutes, before showing Retry.
        // The update hold stays on while waiting: the send is still in flight.
        if (offline(e) && (m.waited || 0) < 24) {
          m.waited = (m.waited || 0) + 1;
          await new Promise(resolve => setTimeout(resolve, 5000));
          return run();
        }
        m.waited = 0;
        m.pending = false; m.failed = offline(e) ? 'Messenger was restarting' : e.message && e.message.length < 80 ? e.message : true; m.retry = () => { store.pending++; hold(); queues[id] = (queues[id] || Promise.resolve()).then(run); };
        store.pending--; hold(); // failed: shown with Retry; no longer blocks updates
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
    const sheet = overlay('Settings'); sheet.append(node('h3', '', 'Telegram'));
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
      box.append(node('p', 'u-status ' + (st.enabled ? 'warn' : 'on'), st.enabled
        ? 'Agents can read and send your messages until ' + new Date(st.until).toLocaleTimeString([], {hour: 'numeric', minute: '2-digit'}) + '.'
        : 'Off. Agents see Messenger status only, never your messages.'));
      const set = minutes => action(async () => paint(await api('api/view/agent-access', {method: 'POST', body: {minutes}})));
      if (st.enabled) box.append(button('Turn off now', () => set(0), 'primary wide'));
      else { const pair = node('div', 'u-pair'); pair.append(button('Allow 1 hour', () => set(60), 'secondary'), button('Allow 24 hours', () => set(1440), 'secondary')); box.append(pair); }
      if (st.log.length) {
        const details = node('details', 'u-log'); details.append(node('summary', '', 'Recent agent requests'));
        const list = node('ul', 'u-access-log');
        for (const e of st.log.slice(0, 20)) list.append(node('li', e.outcome === 'blocked' ? 'blocked' : '', new Date(e.t).toLocaleString([], {month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit'}) + ' · ' + e.outcome + ' · ' + e.method + ' ' + e.route));
        details.append(list); box.append(details);
      }
    };
    try { const st = await api('api/view/agent-access'); if (s.overlay === 'Settings') paint(st); } catch (e) { error(e); }
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
  function switchTab(tab) { view.selection?.clear(); if (s.overlay) closeOverlay(); s.tab = tab; s.person = null; view.id = null; s.search = null; s.epoch++; inChat(false); document.documentElement.dataset.inboxTab = tab; $('unified-inbox').hidden = tab === 'messenger'; delete $('unified-inbox').dataset.label; for (const el of $('inbox-tabs').querySelectorAll('[data-tab]')) el.setAttribute('aria-selected', String(el.dataset.tab === tab)); if (tab !== 'messenger') renderList(); }
  function refresh() { store.lists = {people: null, groups: null}; if (!s.person && s.tab !== 'messenger') renderList(); }
  document.addEventListener('visibilitychange', () => { if (!document.hidden) { resumeLogin(); markRead(); } });
  // Keyboard open/close: keep the newest message glued above the composer.
  window.visualViewport?.addEventListener('resize', () => { if (s.person && view.scroll && view.bottom !== false) view.scroll.scrollTop = view.scroll.scrollHeight; });
  // After a reload, come back to the same tab and chat (saved on pagehide).
  // Any reload (a Wizard update, the Reload strip) comes back on the same tab and chat.
  window.addEventListener('pagehide', () => { try { if (s.ready || s.tab) sessionStorage.setItem('messenger.resume', JSON.stringify({tab: s.tab, person: s.person})); } catch { /* fresh start */ } });
  function resume() {
    let at = null; try { at = JSON.parse(sessionStorage.getItem('messenger.resume') || 'null'); sessionStorage.removeItem('messenger.resume'); } catch { /* none */ }
    switchTab(['groups', 'messenger'].includes(at?.tab) ? at.tab : 'people');
    if (at?.person && at.tab !== 'messenger') openPerson(at.person);
  }
  // ---------- Wizard share sheet: recent chats are direct targets; a share lands in the composer, never auto-sent ----------
  const SHARE_TARGETS = 12;
  let sharedTargetsKey = '';
  function shareTargetRows() {
    return [...(store.lists.people || []), ...(store.lists.groups || []).map(g => ({...g, group: true}))]
      .filter(p => p.id && p.display_name).sort((a, b) => (b.last?.timestamp || 0) - (a.last?.timestamp || 0)).slice(0, SHARE_TARGETS)
      .map(p => ({id: p.id, name: p.display_name, detail: p.group || listKey(p) === 'groups' ? 'Group' : networksOf(p).map(cap).join(' · ')}));
  }
  function shareTargets() {
    const share = window.WizardApp?.share; if (!share?.targets) return;
    const rows = shareTargetRows();
    const key = JSON.stringify(rows); if (key === sharedTargetsKey) return; sharedTargetsKey = key;
    Promise.resolve(share.targets(rows)).catch(() => {});
  }
  function sharedText(item) { return [item.text, item.url].filter(Boolean).join('\n').slice(0, 16000); }
  function placeShared(id, text) {
    const had = (s.drafts[id] || '').trim();
    s.drafts[id] = had ? had + '\n\n' + text : text; saveDrafts(); hold();
  }
  function receiveShare(item) {
    const text = sharedText(item);
    if (!s.ready || !text) return false; // stays pending in Wizard; check() runs again once unlocked
    if (s.overlay) closeOverlay();
    if (s.tab === 'messenger' || s.search != null) switchTab('people');
    if (item.target) { placeShared(item.target, text); openPerson(item.target); return true; }
    if (s.person) { s.person = null; view.id = null; inChat(false); renderList(); }
    return newChat(text); // settles once the owner picks someone (text in that composer) or closes the picker
  }
  function listenForShares() {
    try { window.WizardApp?.share?.receive?.({accepts: ['text', 'url'], receive: receiveShare}); } catch { /* standalone or an older Wizard: no share sheet */ }
  }
  window.MessengerUnified = {
    receiveShare, shareTargetRows,
    ask, toast, holdToMenu, actionMenu, muteAction, icon, messageSelection,
    // The Messenger tab's own conversations (invites + unread chats) count on its tab and the desk badge.
    setNativeUnread(n) { n = Math.max(0, n | 0); if (n !== nativeUnread) { nativeUnread = n; syncBadge(); } },
    mount(options) { api = options.api; if (options.csrf) csrf = options.csrf; try { s.drafts = JSON.parse(sessionStorage.getItem('messenger-unified-drafts') || '{}'); } catch { s.drafts = {}; } for (const el of $('inbox-tabs').querySelectorAll('[data-tab]')) el.onclick = () => (el.getAttribute('aria-selected') === 'true' && !s.person && s.search == null && !s.overlay) ? null : switchTab(el.dataset.tab); listenForShares(); },
    // Saved chats paint at once; the session handshake and the server's copy follow behind.
    paintSaved() {
      if (s.ready || !restore()) return false; $('inbox-tabs').hidden = false;
      resume(); return true;
    },
    authenticated() {
      if (s.ready) return; s.ready = true; $('inbox-tabs').hidden = false;
      const painted = document.documentElement.dataset.inboxTab;
      if (!painted) resume();
      else if (s.tab !== 'messenger') { if (s.person) openPerson(s.person); else freshen(s.tab === 'groups' ? 'groups' : 'people', s.epoch); }
      resumeLogin(); if (store.seq) feed();
      shareTargets(); Promise.resolve(window.WizardApp?.share?.check?.()).catch(() => {}); // a share that waited for unlock
      // Groups count toward the badge before the Groups tab is ever opened.
      if (!store.lists.groups) call('groups').then(r => { if (s.ready && !store.lists.groups) { store.lists.groups = r.groups || []; persist(); } }).catch(() => {});
    },
    active: () => s.ready && (s.tab !== 'messenger' || !!s.overlay), canGoBack: () => !!(s.overlay || s.person || s.search != null), back,
    signout(wipe = false) { nativeUnread = 0; if (wipe) wipeCache(); sharedTargetsKey = ''; Promise.resolve(window.WizardApp?.share?.targets?.([])).catch(() => {}); feedCtl?.abort(); closeOverlay(); s.ready = false; s.epoch++; inChat(false); Object.assign(store, {seq: 0, lists: {people: null, groups: null}, threads: {}, typing: {}}); for (const k in unreadById) delete unreadById[k]; syncBadge(); $('inbox-tabs').hidden = true; $('unified-inbox').hidden = true; $('unified-inbox').replaceChildren(); delete document.documentElement.dataset.inboxTab; }
  };
})();
