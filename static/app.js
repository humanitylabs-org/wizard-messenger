/* Messenger view. API/history is authoritative; there is no production demo data. */
(() => {
  'use strict';
  const alphabet = 'qpzry9x8gf2tvdw0s3jn54khce6mua7l';
  function polymod(words) {
    let chk = 1;
    const generators = [0x3b6a57b2, 0x26508e6d, 0x1ea119fa, 0x3d4233dd, 0x2a1462b3];
    for (const word of words) {
      const top = chk >>> 25;
      chk = ((chk & 0x1ffffff) << 5) ^ word;
      for (let i = 0; i < 5; i++) if ((top >>> i) & 1) chk ^= generators[i];
    }
    return chk >>> 0;
  }
  const expand = hrp => [...hrp].map(c => c.charCodeAt(0) >>> 5).concat(0, [...hrp].map(c => c.charCodeAt(0) & 31));
  function convertBits(values, from, to, pad) {
    let acc = 0, bits = 0;
    const result = [], mask = (1 << to) - 1;
    for (const value of values) {
      if (value < 0 || value >>> from) throw new Error('invalid_address');
      acc = ((acc << from) | value) & ((1 << (from + to - 1)) - 1);
      bits += from;
      while (bits >= to) { bits -= to; result.push((acc >>> bits) & mask); }
    }
    if (pad && bits) result.push((acc << (to - bits)) & mask);
    if (!pad && (bits >= from || ((acc << (to - bits)) & mask))) throw new Error('invalid_address');
    return result;
  }
  function encodePublic(hex) {
    if (!/^[0-9a-f]{64}$/.test(hex || '')) return '';
    const words = convertBits(hex.match(/../g).map(x => parseInt(x, 16)), 8, 5, true);
    const sum = polymod(expand('npub').concat(words, [0, 0, 0, 0, 0, 0])) ^ 1;
    return 'npub1' + words.concat(Array.from({length: 6}, (_, i) => (sum >>> (5 * (5 - i))) & 31)).map(x => alphabet[x]).join('');
  }
  function decodeAddress(value) {
    if (typeof value !== 'string') throw new Error('invalid_address');
    if (/^[0-9a-f]{64}$/.test(value)) return {pubkey: value, npub: encodePublic(value)};
    if (!/^(npub|nprofile)1[023456789acdefghjklmnpqrstuvwxyz]+$/.test(value) || value.length > 4096) throw new Error('invalid_address');
    const separator = value.lastIndexOf('1'), hrp = value.slice(0, separator);
    const words = [...value.slice(separator + 1)].map(c => alphabet.indexOf(c));
    if (words.length < 6 || polymod(expand(hrp).concat(words)) !== 1) throw new Error('invalid_address');
    const bytes = convertBits(words.slice(0, -6), 5, 8, false);
    let key = bytes;
    if (hrp === 'nprofile') {
      key = null;
      for (let i = 0; i < bytes.length;) {
        if (i + 2 > bytes.length) throw new Error('invalid_address');
        const type = bytes[i++], length = bytes[i++];
        if (i + length > bytes.length) throw new Error('invalid_address');
        if (type === 0) {
          if (key || length !== 32) throw new Error('invalid_address');
          key = bytes.slice(i, i + length);
        }
        i += length;
      }
    }
    if (!key || key.length !== 32) throw new Error('invalid_address');
    const hex = key.map(x => x.toString(16).padStart(2, '0')).join('');
    return {pubkey: hrp === 'npub' ? value : hex, npub: encodePublic(hex)};
  }
  function keyHex(value) {
    try { const key = decodeAddress(value).pubkey; return key.startsWith('npub') ? convertBits([...key.slice(5, -6)].map(c => alphabet.indexOf(c)), 5, 8, false).map(x => x.toString(16).padStart(2, '0')).join('') : key; }
    catch { return null; }
  }
  function identityKeys(identity) {
    return [identity?.account_id, identity?.member_id, identity?.npub].map(keyHex).filter(Boolean);
  }
  function peerOf(dm, own) {
    const mine = identityKeys(own);
    const members = dm?.members || [];
    if (!mine.length || !members.some(member => identityKeys(member).some(key => mine.includes(key)))) return null;
    return members.find(member => identityKeys(member).length && !identityKeys(member).some(key => mine.includes(key))) || null;
  }
  function publicAddress(identity) {
    if (identity?.nprofile) { try { decodeAddress(identity.nprofile); return identity.nprofile; } catch { /* Use another public form. */ } }
    if (identity?.npub) { try { return decodeAddress(identity.npub).npub; } catch { /* Use another public form. */ } }
    return encodePublic(identity?.member_id) || encodePublic(identity?.account_id);
  }
  function stamp(value) {
    if (typeof value === 'number' || /^\d+$/.test(String(value))) {
      const n = Number(value); return Number.isFinite(n) ? (n < 1e12 ? n * 1000 : n) : 0;
    }
    const n = Date.parse(value); return Number.isFinite(n) ? n : 0;
  }
  function mergeMessages(existing, incoming) {
    const byId = new Map(existing.map(m => [m.message_id, m]));
    for (const m of incoming) if (typeof m.message_id === 'string' && m.message_id) byId.set(m.message_id, m);
    return [...byId.values()].sort((a, b) => stamp(a.created_at) - stamp(b.created_at) || a.message_id.localeCompare(b.message_id));
  }
  const nearBottom = (top, height, viewport) => height - viewport - top <= 48;
  function backLayer(route) {
    if (route.sheet) return {...route, sheet: null, handled: true};
    if (route.group) return {...route, group: null, handled: true};
    return {...route, handled: false};
  }
  function receiptState(receipt) {
    if (!Array.isArray(receipt?.message_ids) || !receipt.message_ids.length || !receipt.message_ids.every(id => /^[0-9a-f]{64}$/.test(id))) return 'checking';
    return Number(receipt.published) > 0 ? 'sent' : 'queued';
  }
  function failedSendState(error) {
    // Any failure after the engine persisted intent can be ambiguous. Only
    // pre-send validation/auth/state rejections are proven safe to retry.
    const rejected = new Set(['invalid_input', 'invalid_request_id', 'invalid_message_id', 'not_a_dm', 'locked', 'vault_locked', 'identity_required', 'unauthorized', 'origin_forbidden', 'csrf_invalid', 'request_id_conflict']);
    return error?.code === 'send_outcome_unknown' || !rejected.has(error?.code) ? 'checking' : 'failed';
  }
  const passphraseLength = value => [...value].length;
  const logic = {encodePublic, decodeAddress, keyHex, peerOf, publicAddress, stamp, mergeMessages, nearBottom, backLayer, receiptState, failedSendState, passphraseLength};
  if (typeof module !== 'undefined' && module.exports) module.exports = logic;
  if (typeof document === 'undefined') return;

  const $ = id => document.getElementById(id);
  const state = {
    csrf: null, authenticated: false, sessionLocked: false, mode: 'opening', identity: null, contacts: [], dms: [], invites: [],
    group: null, sheet: null, cache: new Map(), records: new Map(), scroll: new Map(), nodes: new Map(),
    operation: null, timer: null, reconnecting: false, setupFailed: false, listSignature: '', focusBefore: null,
    initialChat: false, storageError: false, listLoaded: false, pendingInvite: null, olderPending: null, chatOpening: null
  };
  const storagePrefix = () => 'wizard-messenger:v1:' + state.identity?.account_id + ':';
  function readRecord(group) {
    if (!state.records.has(group)) {
      let saved = {};
      try { saved = JSON.parse(localStorage.getItem(storagePrefix() + group) || '{}'); } catch { /* A draft failure never permits an untracked send. */ }
      const record = {draft: typeof saved?.draft === 'string' ? saved.draft : '', attempts: Array.isArray(saved?.attempts) ? saved.attempts.filter(a => a && (typeof a.text === 'string' || a.message_ids?.length) && /^[a-zA-Z0-9_-]{16,128}$/.test(a.request_id)) : [], invite_sent: saved?.invite_sent === true, seen: saved?.seen || null};
      for (const attempt of record.attempts) if (attempt.state === 'sending') attempt.state = 'checking';
      state.records.set(group, record);
    }
    return state.records.get(group);
  }
  function persist(group) {
    if (!state.identity) return false;
    try {
      const value = JSON.stringify(readRecord(group));
      localStorage.setItem(storagePrefix() + group, value);
      if (localStorage.getItem(storagePrefix() + group) !== value) throw new Error('storage');
      state.storageError = false; return true;
    } catch { state.storageError = true; return false; }
  }
  function cancel() {
    clearTimeout(state.timer); state.timer = null;
    if (state.operation) { state.operation.controller.abort(); state.operation = null; }
  }
  function schedule() {
    clearTimeout(state.timer);
    if (!document.hidden && !state.operation && state.authenticated) state.timer = setTimeout(() => run(snapshot), 3000);
  }
  const isBusy = () => state.operation?.action === true;
  const act = work => run(work, true);
  async function run(work, action = false, bootstrap = false) {
    cancel();
    const op = {controller: new AbortController(), action, bootstrap}; state.operation = op; updateSetup(); renderActivity();
    try { return await work(op.controller.signal); }
    catch (error) {
      if (error.name !== 'AbortError' && state.operation === op) {
        state.reconnecting = true;
        if (state.mode === 'ready') { (state.group ? $('chat-error') : $('list-error')).textContent = friendly(error); renderHeader(); }
        else if (state.mode !== 'reconnect') { $('setup-error').textContent = friendly(error); }
      }
      return null;
    } finally {
      if (state.operation === op) {
        state.operation = null; state.chatOpening = null; schedule(); updateSetup(); updateComposer(); renderActivity();
        if (bootstrap && launchTicket) boot(); // a link arrived during the earlier bootstrap
      }
    }
  }
  class APIError extends Error {
    constructor(code, status) { super(code); this.code = code; this.status = status; }
  }
  async function api(path, {method = 'GET', body, signal, session = false} = {}) {
    if (!path.startsWith('api/')) throw new Error('invalid_route');
    const headers = {Accept: 'application/json'};
    if (method !== 'GET') {
      headers['Content-Type'] = 'application/json';
      if (!session) {
        if (!state.csrf) throw new APIError('unauthorized', 401);
        headers['X-Messenger-CSRF'] = state.csrf;
      }
    }
    const response = await fetch(path, {method, headers, credentials: 'same-origin', cache: 'no-store', signal, ...(body !== undefined ? {body: JSON.stringify(body)} : {})});
    signal?.throwIfAborted();
    if (response.status === 401) {
      let code = 'unauthorized';
      try { code = (await response.json()).error?.code || code; } catch { /* A gateway 401 may not be JSON. */ }
      signal?.throwIfAborted();
      // A wrong passphrase is a form error: keep the unlock card, never drop to reconnect.
      if (['vault_unlock_failed', 'invalid_vault_password', 'invalid_view_ticket'].includes(code)) throw new APIError(code, 401);
      const unlockRequired = code === 'session_unlock_required' || (path === 'api/view/unlock' && ['vault_unlock_failed', 'invalid_vault_password'].includes(code));
      disconnect(unlockRequired); throw new APIError(code, 401);
    }
    const envelope = await response.json();
    signal?.throwIfAborted();
    if (!response.ok || envelope.ok !== true) throw new APIError(envelope.error?.code || 'request_failed', response.status);
    return envelope.result;
  }
  function friendly(error) {
    const messages = {
      unauthorized: 'Open Messenger from Wizard to reconnect.',
      vault_unlock_failed: "That passphrase isn't right.", invalid_public_key: "That address doesn't look right.",
      login_rate_limited: 'Too many tries. Wait a minute and try again.',
      invalid_vault_password: state.mode === 'locked' ? "That passphrase isn't right." : 'Needs at least 16 characters.',
      invalid_address: "That address doesn't look right.", cannot_invite_self: 'Choose someone else’s Messenger address.',
      invalid_nip05: "That address doesn't look right.", nip05_unverified: 'This address could not be verified. Ask for their Messenger address.', nip05_not_found: 'This address could not be found. Ask for their Messenger address.',
      key_package_not_found: 'This address is not ready for chats yet.', no_key_package: 'This address is not ready for chats yet.',
      locked: 'Unlock Messenger to continue.', vault_locked: 'Unlock Messenger to continue.', request_id_conflict: 'This draft could not be retried safely.',
      send_outcome_unknown: 'Checking delivery. Your message will not be sent again automatically.',
      invalid_input: 'Check the text and try again.', csrf_invalid: 'Open Messenger from Wizard to reconnect.'
    };
    return messages[error.code || error.message] || "Couldn't connect. Try again when your Wizard is reachable.";
  }
  function eraseView() {
    state.identity = null; state.contacts = []; state.dms = []; state.invites = [];
    state.group = null; state.sheet = null; state.cache.clear(); state.records.clear(); state.nodes.clear(); state.scroll.clear();
    state.chatOpening = null; state.lastActivity = ''; state.listLoaded = false; state.listSignature = ''; $('messages').replaceChildren(); $('conversation-list').replaceChildren(); $('saved-contacts').replaceChildren();
    $('public-address').textContent = ''; $('chat-name').textContent = ''; $('chat-subline').textContent = '';
    $('draft').value = ''; $('contact-address').value = ''; $('contact-name').value = '';
    $('passphrase').value = ''; $('confirm-passphrase').value = ''; $('display-name').value = '';
    $('sheet-layer').hidden = true; $('workspace').hidden = true; $('chat').hidden = true; $('workspace').classList.remove('has-chat');
    $('workspace').inert = false;
    $('no-selection').hidden = false;
  }
  function disconnect(unlockRequired = false) {
    cancel(); eraseView(); state.csrf = null; state.authenticated = false;
    state.sessionLocked = unlockRequired; gate(unlockRequired ? 'locked' : 'reconnect');
  }
  function gate(mode) {
    const changed = state.mode !== mode;
    state.mode = mode; $('gate').hidden = false; $('workspace').hidden = true;
    const create = mode === 'setup_required', locked = mode === 'locked';
    $('gate-title').textContent = locked ? 'Unlock Messenger' : 'Messenger';
    $('gate-description').textContent = locked ? 'Enter your passphrase to open your messages.' : create ? 'Create a messaging address for this Wizard. It is separate from your Wizard ID and is used only for chats.' : mode === 'reconnect' ? 'Open Messenger from Wizard to reconnect.' : mode === 'first_open' ? 'Ask your Wizard for your Messenger setup link. It opens here once so you can create your address.' : 'Opening your messages…';
    $('setup-form').hidden = !(create || locked); $('reconnect').hidden = mode !== 'reconnect' && mode !== 'first_open';
    $('name-label').hidden = !create; $('confirm-label').hidden = !create; $('confirm-passphrase').required = create;
    $('passphrase-help').hidden = !create; $('passphrase').minLength = locked ? 1 : 16;
    if (changed) {
      $('passphrase').value = ''; $('confirm-passphrase').value = ''; $('setup-error').textContent = '';
      $('passphrase').type = 'password'; $('show-password').textContent = 'Show';
      $('show-password').setAttribute('aria-label', 'Show passphrase'); $('show-password').setAttribute('aria-pressed', 'false');
    }
    updateSetup(); renderActivity();
  }
  function renderActivity() {
    const active = !!state.operation, gateBusy = active && (state.mode === 'opening' || (isBusy() && ['locked', 'setup_required'].includes(state.mode)));
    const listBusy = active && state.mode === 'ready' && !state.listLoaded && !state.reconnecting;
    const group = state.group, older = group && state.olderPending?.group === group;
    const historyBusy = state.mode === 'ready' && group && !isIncoming(dmById(group)) && !state.reconnecting && (older || state.chatOpening === group || (active && !cacheFor(group).loaded));
    $('gate-progress').hidden = !gateBusy; $('gate').setAttribute('aria-busy', String(gateBusy));
    $('list-loading').hidden = !listBusy; $('conversation-list').setAttribute('aria-busy', String(listBusy));
    $('history-loading').hidden = !historyBusy; $('messages').setAttribute('aria-busy', String(!!historyBusy));
    $('history-loading-text').textContent = older ? 'Loading earlier messages…' : group && cacheFor(group).loaded ? 'Refreshing messages…' : 'Loading messages…';
    $('load-older').disabled = !!older;
    let message = state.pendingInvite ? (state.pendingInvite.action === 'accept' ? 'Accepting invite…' : 'Ignoring invite…') : gateBusy ? (state.mode === 'opening' ? 'Opening your messages…' : state.mode === 'locked' ? 'Unlocking Messenger…' : 'Creating your address…') : listBusy ? 'Loading conversations…' : historyBusy ? $('history-loading-text').textContent : state.lastActivity || '';
    if ($('activity-announcement').textContent !== message) $('activity-announcement').textContent = message;
  }
  function updateSetup() {
    const create = state.mode === 'setup_required', password = $('passphrase').value;
    const pending = isBusy() && ['locked', 'setup_required'].includes(state.mode);
    $('setup-submit').classList.toggle('pending', pending);
    if (pending) { $('setup-submit').disabled = true; $('setup-submit').textContent = create ? 'Creating address…' : 'Unlocking…'; return; }
    $('setup-submit').textContent = create ? (state.setupFailed ? 'Try again' : 'Create address') : 'Unlock';
    $('setup-submit').disabled = create ? passphraseLength(password) < 16 || password !== $('confirm-passphrase').value : !password.length;
  }
  function ready(identity) {
    state.identity = identity; state.mode = 'ready'; $('gate').hidden = true; $('workspace').hidden = false;
    $('own-initial').textContent = (identity.display_name || 'M').slice(0, 1).toUpperCase(); renderActivity();
  }
  function dmById(group) { return state.invites.find(dm => dm.group_id === group) || state.dms.find(dm => dm.group_id === group); }
  function isIncoming(dm) { return !!dm && (dm.pending_confirmation === true || state.invites.some(i => i.group_id === dm.group_id)); }
  function peerName(dm) {
    const peer = peerOf(dm, state.identity), keys = identityKeys(peer);
    const contact = state.contacts.find(c => keys.includes(keyHex(c.pubkey)));
    return contact?.label || peer?.display_name || peer?.profile?.display_name || peer?.profile?.name || shortAddress(publicAddress(peer)) || 'Conversation';
  }
  function shortAddress(address) { return address ? address.slice(0, 9) + '…' + address.slice(-4) : ''; }
  function cacheFor(group) {
    if (!state.cache.has(group)) state.cache.set(group, {messages: [], cursor: null, loaded: false});
    return state.cache.get(group);
  }
  async function snapshot(signal) {
    if (document.hidden || !state.authenticated) return;
    const status = await api('api/status', {signal});
    if (status.state !== 'ready') {
      if (state.mode === 'ready') eraseView();
      gate(status.state === 'locked' ? 'locked' : 'setup_required'); state.reconnecting = false; return;
    }
    const {identity} = await api('api/identity', {signal});
    if (!identity) { if (state.mode === 'ready') eraseView(); gate('setup_required'); return; }
    ready(identity);
    state.contacts = (await api('api/contacts', {signal})).contacts || [];
    state.invites = (await api('api/invites', {signal})).invites || [];
    state.dms = (await api('api/dms', {signal})).dms || [];
    // The frozen summary has no preview/unread fields. Query real latest events;
    // never manufacture list previews from names or a fixture conversation.
    for (const dm of state.dms) {
      if (dm.group_id === state.group) continue;
      const data = await api('api/dms/' + encodeURIComponent(dm.group_id) + '/messages?limit=1', {signal});
      const cache = cacheFor(dm.group_id); cache.messages = mergeMessages(cache.messages, data.messages || []);
      reconcile(dm.group_id);
    }
    if (state.group) {
      const dm = dmById(state.group);
      if (!dm) leaveChat();
      else if (!isIncoming(dm)) await refreshMessages(state.group, signal);
    }
    state.listLoaded = true; state.reconnecting = false; $('list-error').textContent = ''; renderList(); renderHeader(); updateComposer(); renderActivity();
  }
  async function refreshMessages(group, signal, older = false) {
    const cache = cacheFor(group), cursor = cache.cursor;
    let path = 'api/dms/' + encodeURIComponent(group) + '/messages?limit=100';
    if (older && cursor) path += '&before=' + encodeURIComponent(cursor.before) + '&before_message_id=' + encodeURIComponent(cursor.before_message_id);
    const marker = older ? {group} : null; if (marker) state.olderPending = marker; renderActivity();
    let data;
    try { data = await api(path, {signal}); }
    finally { if (state.olderPending === marker) state.olderPending = null; renderActivity(); }
    cache.messages = mergeMessages(cache.messages, data.messages || []);
    if (older || !cache.loaded) cache.cursor = data.next_cursor || null;
    cache.loaded = true; if (state.chatOpening === group) state.chatOpening = null; reconcile(group);
    if (group === state.group) renderMessages({older});
  }
  function reconcile(group) {
    const record = readRecord(group), cache = cacheFor(group), dm = dmById(group), peerKeys = identityKeys(peerOf(dm, state.identity));
    if (record.invite_sent && cache.messages.some(m => m.direction === 'received' && peerKeys.includes(keyHex(m.author)))) {
      record.invite_sent = false; persist(group);
    }
    // History cannot safely correlate an unknown send by matching text/time.
    // Only receipt message_ids may join a local attempt to a canonical bubble.
    for (const attempt of record.attempts) {
      if (attempt.message_ids?.length && attempt.state === 'checking' && Number(attempt.published) > 0 && cache.messages.some(m => attempt.message_ids.includes(m.message_id))) attempt.state = 'sent';
      if (['sent', 'queued'].includes(attempt.state) && attempt.message_ids?.some(id => cache.messages.some(m => m.message_id === id)) && typeof attempt.text === 'string') {
        // Keep the receipt correlation, not an unnecessary plaintext copy of
        // accepted history. Unresolved/failed draft bodies remain recoverable.
        delete attempt.text; persist(group);
      }
    }
  }
  function element(tag, className, text) {
    const el = document.createElement(tag); if (className) el.className = className;
    if (text !== undefined) el.textContent = text; return el;
  }
  function button(text, className, action) {
    const el = element('button', className, text); el.type = 'button'; el.addEventListener('click', action); return el;
  }
  function timeLabel(value) { const ms = stamp(value); return ms ? new Date(ms).toLocaleTimeString([], {hour: '2-digit', minute: '2-digit'}) : ''; }
  function row(dm, invite = false) {
    const name = peerName(dm), messages = cacheFor(dm.group_id).messages, last = messages.at(-1), record = readRecord(dm.group_id);
    const unread = !invite && last?.direction === 'received' && record.seen !== last.message_id;
    const el = button('', 'conversation-row' + (unread ? ' unread' : ''), () => openChat(dm.group_id));
    el.dataset.group = dm.group_id; el.setAttribute('aria-current', String(state.group === dm.group_id));
    el.append(element('span', 'avatar', name.slice(0, 1).toUpperCase()));
    const body = element('span', 'row-body'); body.append(element('span', 'row-name', name), element('span', 'row-preview', invite ? 'wants to chat' : last?.text || (record.invite_sent ? 'Invite sent' : 'No messages yet')));
    el.append(body, element('span', 'row-meta', invite ? '' : timeLabel(last?.created_at))); return el;
  }
  function renderList() {
    if (state.mode !== 'ready') return;
    const signature = JSON.stringify([state.group, state.listLoaded, state.pendingInvite, state.contacts, state.invites, state.dms, [...state.cache].map(([id,c]) => [id,c.messages.at(-1)]), [...state.records].map(([id,r]) => [id,r.seen,r.invite_sent])]);
    if (signature === state.listSignature) return; state.listSignature = signature;
    const list = $('conversation-list'), top = list.scrollTop, fragment = document.createDocumentFragment();
    if (state.invites.length) {
      fragment.append(element('h2', 'section-label', 'Invites'));
      for (const dm of state.invites) {
        const wrap = element('div', 'invite-row'), actions = element('div', 'invite-row-actions');
        const pending = state.pendingInvite?.group === dm.group_id ? state.pendingInvite : null;
        const accept = button(pending?.action === 'accept' ? 'Accepting…' : 'Accept', 'primary', () => inviteAction(dm.group_id, 'accept'));
        const ignore = button(pending?.action === 'decline' ? 'Ignoring…' : 'Ignore', 'secondary', () => inviteAction(dm.group_id, 'decline'));
        accept.disabled = ignore.disabled = !!state.pendingInvite;
        accept.classList.toggle('pending', pending?.action === 'accept'); ignore.classList.toggle('pending', pending?.action === 'decline');
        actions.append(accept, ignore);
        wrap.append(row(dm, true), actions); fragment.append(wrap);
      }
    }
    const dms = [...state.dms].sort((a,b) => stamp(cacheFor(b.group_id).messages.at(-1)?.created_at) - stamp(cacheFor(a.group_id).messages.at(-1)?.created_at) || a.group_id.localeCompare(b.group_id));
    for (const dm of dms) fragment.append(row(dm));
    if (state.listLoaded && !state.dms.length && !state.invites.length) {
      const empty = element('div', 'empty-state list-empty'); empty.append(element('p', '', 'No conversations yet. Add a contact to start.'), button('Add contact', 'primary', () => openSheet('contact'))); fragment.append(empty);
    }
    list.replaceChildren(fragment); list.scrollTop = top;
  }
  function renderHeader() {
    if (!state.group || state.mode !== 'ready') return;
    const dm = dmById(state.group); if (!dm) return;
    $('chat-name').textContent = peerName(dm);
    const pending = isIncoming(dm), sent = readRecord(state.group).invite_sent;
    $('chat-subline').textContent = state.reconnecting ? 'Reconnecting…' : pending ? 'Invite pending' : sent ? 'Invite sent' : '';
    $('chat-subline').classList.toggle('reconnecting', state.reconnecting);
    $('invite-actions').hidden = !pending;
    const operation = state.pendingInvite?.group === state.group ? state.pendingInvite : null;
    $('accept-invite').disabled = $('decline-invite').disabled = !!state.pendingInvite;
    $('accept-invite').textContent = operation?.action === 'accept' ? 'Accepting…' : 'Accept';
    $('decline-invite').textContent = operation?.action === 'decline' ? 'Ignoring…' : 'Ignore';
    $('accept-invite').classList.toggle('pending', operation?.action === 'accept'); $('decline-invite').classList.toggle('pending', operation?.action === 'decline');
    $('copy-peer').disabled = !publicAddress(peerOf(dm, state.identity));
    $('load-older').hidden = pending || !cacheFor(state.group).cursor;
  }
  function updateComposer() {
    const dm = dmById(state.group), disabled = state.mode !== 'ready' || !dm || isIncoming(dm);
    $('draft').disabled = disabled; $('draft').placeholder = isIncoming(dm) ? 'Accept this invite to write a message' : 'Write a message';
    $('send').disabled = disabled || isBusy() || !$('draft').value.trim();
  }
  function markSeen() {
    if (document.hidden || !state.group || state.mode !== 'ready' || !cacheFor(state.group).loaded) return;
    const scroll = $('message-scroll'); if (!nearBottom(scroll.scrollTop, scroll.scrollHeight, scroll.clientHeight)) return;
    const last = cacheFor(state.group).messages.at(-1), record = readRecord(state.group);
    if (last && record.seen !== last.message_id) { record.seen = last.message_id; persist(state.group); renderList(); }
  }
  function renderMessages({older = false} = {}) {
    if (!state.group || state.mode !== 'ready') return;
    const group = state.group, cache = cacheFor(group), record = readRecord(group), list = $('messages'), scroll = $('message-scroll');
    // The last-message preview is for the list, never a complete thread window.
    if (!cache.loaded) { list.replaceChildren(); state.nodes.clear(); $('history-empty').hidden = true; $('load-older').hidden = true; renderActivity(); return; }
    const oldTop = scroll.scrollTop, oldHeight = scroll.scrollHeight, bottom = !older && nearBottom(oldTop, oldHeight, scroll.clientHeight), oldCount = state.nodes.size;
    const anchor = [...list.children].find(n => n.getBoundingClientRect().bottom > scroll.getBoundingClientRect().top);
    const anchorTop = anchor?.getBoundingClientRect().top;
    const items = cache.messages.map(m => {
      const attempt = record.attempts.find(a => a.message_ids?.includes(m.message_id));
      return {key: attempt ? attempt.request_id + ':' + (attempt.message_ids.indexOf(m.message_id) || '') : m.message_id, message: m, attempt};
    });
    for (const attempt of record.attempts) {
      if (typeof attempt.text === 'string' && !attempt.message_ids?.some(id => cache.messages.some(m => m.message_id === id))) items.push({key: attempt.request_id + ':', attempt, message: {text: attempt.text, direction: 'sent', created_at: attempt.created_at}});
    }
    items.sort((a,b) => stamp(a.message.created_at) - stamp(b.message.created_at) || a.key.localeCompare(b.key));
    const lastOutgoing = items.findLast(x => x.message.direction === 'sent');
    const live = new Set(); let lastDay = '';
    for (const item of items) {
      const ms = stamp(item.message.created_at), day = ms ? new Date(ms).toLocaleDateString([], {month: 'short', day: 'numeric', year: 'numeric'}) : '';
      if (day && day !== lastDay) {
        const dayKey = 'day:' + day, separator = state.nodes.get(dayKey) || element('div', 'date-separator', day);
        state.nodes.set(dayKey, separator); live.add(dayKey); list.append(separator); lastDay = day;
      }
      let node = state.nodes.get(item.key);
      if (!node) { node = element('article', 'message'); node.append(element('div', 'bubble'), element('time', 'message-time'), element('div', 'message-status')); state.nodes.set(item.key, node); }
      live.add(item.key); const outgoing = item.message.direction === 'sent', delivery = item.attempt?.state;
      node.className = 'message' + (outgoing ? ' sent' : '') + (delivery === 'failed' ? ' not-sent' : '');
      node.dataset.messageId = item.message.message_id || ''; node.dataset.requestId = item.attempt?.request_id || '';
      const bubble = node.children[0]; if (bubble.textContent !== item.message.text) bubble.textContent = item.message.text;
      node.children[1].textContent = timeLabel(item.message.created_at); if (ms) node.children[1].dateTime = new Date(ms).toISOString();
      const status = node.children[2]; status.replaceChildren(); status.className = 'message-status';
      if (outgoing && delivery && (item === lastOutgoing || ['checking', 'failed', 'queued', 'sending'].includes(delivery))) {
        if (delivery === 'checking') status.append(element('span', 'spinner'), element('span', '', 'Checking delivery'));
        else if (delivery === 'failed') { status.classList.add('failed'); status.append(element('span', '', 'Not sent ·'), button('Retry', 'retry-button', () => submitAttempt(group, item.attempt))); }
        else if (delivery === 'queued') { status.append(element('span', '', 'Queued'), button('Retry', 'retry-button', () => retryEvent(group, item.attempt))); }
        else if (delivery === 'sending') status.textContent = 'Sending';
        else if (delivery === 'sent') { status.textContent = 'Sent ✓'; status.title = 'Accepted by relay'; }
      }
      list.append(node);
    }
    for (const [key,node] of state.nodes) if (!live.has(key)) { node.remove(); state.nodes.delete(key); }
    $('history-empty').hidden = items.length > 0 || !cache.loaded || isIncoming(dmById(group));
    $('load-older').hidden = !cache.cursor || isIncoming(dmById(group)); renderActivity();
    if (state.initialChat && cache.loaded) {
      state.initialChat = false; scroll.scrollTop = state.scroll.get(group) ?? scroll.scrollHeight;
    } else if (bottom) {
      if (scroll.scrollHeight !== oldHeight) scroll.scrollTo({top: scroll.scrollHeight, behavior: matchMedia('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth'});
    } else {
      if (anchor?.isConnected) scroll.scrollTop = oldTop + anchor.getBoundingClientRect().top - anchorTop;
      else scroll.scrollTop = oldTop;
      if (!older && state.nodes.size > oldCount) $('new-messages').hidden = false;
    }
    markSeen();
  }
  function resizeDraft() {
    const draft = $('draft'), top = $('message-scroll').scrollTop;
    draft.style.height = '44px'; draft.style.height = Math.min(112, Math.max(44, draft.scrollHeight)) + 'px';
    $('message-scroll').scrollTop = top;
  }
  function openChat(group) {
    if (state.group === group) { closeSheet(); return; }
    cancel(); if (state.group) state.scroll.set(state.group, $('message-scroll').scrollTop);
    state.group = group; state.chatOpening = group; state.initialChat = true; state.nodes.clear(); $('messages').replaceChildren();
    $('chat-error').textContent = ''; $('composer-error').textContent = ''; $('new-messages').hidden = true;
    $('draft').value = readRecord(group).draft; $('no-selection').hidden = true; $('chat').hidden = false;
    $('workspace').classList.add('has-chat'); renderHeader(); renderList(); renderMessages(); resizeDraft(); updateComposer(); armGuard();
    run(snapshot);
  }
  function leaveChat() {
    if (state.group) state.scroll.set(state.group, $('message-scroll').scrollTop);
    state.group = null; state.chatOpening = null; $('chat').hidden = true; $('no-selection').hidden = false;
    $('workspace').classList.remove('has-chat'); $('draft').value = ''; state.nodes.clear(); $('messages').replaceChildren();
    renderList(); updateComposer();
  }
  function openSheet(kind) {
    cancel(); state.focusBefore = document.activeElement; state.sheet = kind;
    $('sheet-title').textContent = kind === 'contact' ? 'Add contact' : 'My address';
    $('contact-form').hidden = kind !== 'contact'; $('address-panel').hidden = kind !== 'address';
    $('sheet-layer').hidden = false; $('contact-error').textContent = ''; $('copy-error').textContent = '';
    $('workspace').inert = true;
    if (kind === 'address') $('public-address').textContent = publicAddress(state.identity);
    else renderContacts();
    $('sheet').focus(); armGuard(); schedule();
  }
  function closeSheet() {
    if (!state.sheet) return;
    cancel(); state.sheet = null; $('sheet-layer').hidden = true;
    $('workspace').inert = false;
    state.focusBefore?.focus?.(); state.focusBefore = null; schedule();
  }
  function renderContacts() {
    const target = $('saved-contacts'); target.replaceChildren();
    if (state.contacts.length) target.append(element('h3', 'section-label', 'Contacts'));
    for (const contact of state.contacts) {
      const el = button(contact.label || shortAddress(publicAddress({npub: contact.pubkey, member_id: contact.pubkey})), 'saved-contact', () => { $('contact-address').value = contact.pubkey; $('contact-name').value = contact.label || ''; previewAddress(); });
      el.append(element('span', '', shortAddress(publicAddress({npub: contact.pubkey, member_id: contact.pubkey})))); target.append(el);
    }
  }
  function previewAddress() {
    $('address-preview').textContent = '';
    if (!$('contact-address').value) return;
    try { $('address-preview').textContent = decodeAddress($('contact-address').value).npub; }
    catch { /* Validate explicitly on submit; no invented resolver. */ }
  }
  function inviteAction(group, action) {
    if (isBusy() || state.pendingInvite) return;
    const pending = {group, action}; state.pendingInvite = pending; renderList(); renderHeader(); renderActivity();
    act(async signal => {
      try {
        const result = await api('api/invites/' + encodeURIComponent(group) + '/' + action, {method: 'POST', body: {}, signal});
        if (result.completed !== true) throw new APIError('request_failed', 409);
        state.lastActivity = action === 'accept' ? 'Invite accepted.' : 'Invite ignored.';
        await snapshot(signal);
        if (action === 'accept') openChat(group);
        else if (state.group === group) leaveChat();
      } catch (error) { if (error.name !== 'AbortError') (state.group === group ? $('chat-error') : $('list-error')).textContent = friendly(error); }
      finally { if (state.pendingInvite === pending) { state.pendingInvite = null; renderList(); renderHeader(); renderActivity(); } }
    });
  }
  function submitAttempt(group, attempt) {
    if (isBusy() || state.mode !== 'ready' || isIncoming(dmById(group)) || attempt.state === 'checking') return;
    if (attempt.state === 'queued' || attempt.state === 'sent') { retryEvent(group, attempt); return; }
    attempt.state = 'sending'; if (!persist(group)) { attempt.state = 'failed'; $('composer-error').textContent = 'Draft storage is unavailable. Keep this window open and try again.'; renderMessages(); return; }
    act(async signal => {
      updateComposer(); renderMessages();
      let accepted = false;
      try {
        const receipt = await api('api/dms/' + encodeURIComponent(group) + '/messages', {method: 'POST', body: {text: attempt.text, request_id: attempt.request_id}, signal});
        if (receipt.request_id !== attempt.request_id) throw new APIError('send_outcome_unknown', 409);
        attempt.message_ids = receipt.message_ids; attempt.published = receipt.published; attempt.state = receiptState(receipt);
        accepted = true;
        persist(group);
        await refreshMessages(group, signal);
      } catch (error) {
        if (!accepted) attempt.state = failedSendState(error);
        persist(group);
        if (state.group === group && state.mode === 'ready') {
          if (error.name !== 'AbortError') $('composer-error').textContent = attempt.state === 'checking' ? 'Checking delivery. This message will not be sent again automatically.' : friendly(error);
          renderMessages();
        }
      }
      if (state.group === group && state.mode === 'ready') { renderMessages(); renderList(); }
    });
  }
  function retryEvent(group, attempt) {
    if (isBusy() || !attempt.message_ids?.length || attempt.state === 'checking') return;
    act(async signal => {
      try {
        const receipt = await api('api/dms/' + encodeURIComponent(group) + '/retry', {method: 'POST', body: {message_id: attempt.message_ids[0]}, signal});
        if (Number(receipt.published) > 0 && receipt.message_ids?.some(id => attempt.message_ids.includes(id))) { attempt.state = 'sent'; attempt.published = receipt.published; }
        persist(group); await refreshMessages(group, signal);
      } catch (error) { if (error.name !== 'AbortError') $('composer-error').textContent = friendly(error); }
      if (state.group === group) renderMessages();
    });
  }
  async function copy(value, control, errorTarget) {
    if (!value) return;
    try {
      await navigator.clipboard.writeText(value);
      const old = control.textContent; control.textContent = 'Copied'; control.classList.add('copied');
      setTimeout(() => { control.textContent = old; control.classList.remove('copied'); }, 1500);
    } catch { errorTarget.textContent = 'Copy is unavailable. Select the address and copy it.'; }
  }

  // This is the exact same-origin frame hook read by Wizard's web/app.js.
  // No framed root sentinel and no guessed postMessage/Back aliases.
  function backStep() {
    const next = backLayer(state);
    if (!next.handled) return false;
    cancel();
    if (state.sheet) closeSheet(); else leaveChat();
    schedule(); return true;
  }
  window.__wizardCloseOverlay = backStep;
  const standalone = window.top === window;
  let guardOn = false, ignorePop = false, exitUntil = 0, watcher = null;
  function armWatcher() {
    if (!standalone || watcher || !('CloseWatcher' in window) || Date.now() < exitUntil) return;
    try {
      watcher = new CloseWatcher();
      watcher.onclose = () => {
        watcher = null;
        if (backStep()) { exitUntil = 0; armWatcher(); }
        else {
          warnRoot();
          if (guardOn && history.state?.messengerGuard) { ignorePop = true; guardOn = false; history.back(); }
        }
      };
    } catch { /* History supplies the browser floor. */ }
  }
  function armGuard(force = false) {
    if (!standalone || Date.now() < exitUntil) return;
    if (!guardOn && (force === true || navigator.userActivation?.isActive)) { history.pushState({messengerGuard: true}, ''); guardOn = true; }
    armWatcher();
  }
  function warnRoot() {
    exitUntil = Date.now() + 2000; $('back-warning').hidden = false;
    watcher?.destroy(); watcher = null;
    setTimeout(() => { $('back-warning').hidden = true; exitUntil = 0; armGuard(true); }, 2000);
  }
  if (standalone) {
    addEventListener('popstate', () => {
      guardOn = history.state?.messengerGuard === true;
      if (ignorePop) { ignorePop = false; return; }
      if (Date.now() < exitUntil) return;
      if (backStep()) { history.pushState({messengerGuard: true}, ''); guardOn = true; armWatcher(); }
      else warnRoot();
    });
    for (const type of ['pointerdown', 'pointerup', 'click']) addEventListener(type, armGuard, true);
  }
  document.addEventListener('keydown', event => {
    if (event.key === 'Escape' && backStep()) { event.preventDefault(); event.stopPropagation(); }
    if (event.key === 'Tab' && state.sheet) {
      const controls = [...$('sheet').querySelectorAll('button,input,[tabindex]')].filter(el => !el.disabled && el.getClientRects().length);
      const first = controls[0], last = controls.at(-1);
      if (event.shiftKey && (document.activeElement === first || document.activeElement === $('sheet'))) { event.preventDefault(); last?.focus(); }
      else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first?.focus(); }
    }
  });
  $('add-contact').onclick = () => openSheet('contact'); $('my-address').onclick = () => openSheet('address');
  $('chat-back').onclick = backStep; $('close-sheet').onclick = closeSheet;
  $('sheet-layer').onclick = event => { if (event.target === $('sheet-layer')) closeSheet(); };
  $('copy-own').onclick = () => copy(publicAddress(state.identity), $('copy-own'), $('copy-error'));
  $('copy-peer').onclick = () => copy(publicAddress(peerOf(dmById(state.group), state.identity)), $('copy-peer'), $('chat-error'));
  $('accept-invite').onclick = () => inviteAction(state.group, 'accept'); $('decline-invite').onclick = () => inviteAction(state.group, 'decline');
  $('load-older').onclick = () => { if (isBusy() || !state.group) return; run(signal => refreshMessages(state.group, signal, true)); };
  $('new-messages').onclick = () => { $('message-scroll').scrollTo({top: $('message-scroll').scrollHeight, behavior: matchMedia('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth'}); $('new-messages').hidden = true; };
  $('message-scroll').onscroll = () => {
    if (nearBottom($('message-scroll').scrollTop, $('message-scroll').scrollHeight, $('message-scroll').clientHeight)) { $('new-messages').hidden = true; markSeen(); }
  };
  $('draft').oninput = () => {
    if (!state.group) return;
    readRecord(state.group).draft = $('draft').value;
    if (!persist(state.group)) $('composer-error').textContent = 'Draft storage is unavailable. Keep this window open.';
    else $('composer-error').textContent = '';
    resizeDraft(); updateComposer();
  };
  $('draft').onkeydown = event => {
    if (event.key === 'Enter' && !event.shiftKey && !event.isComposing && matchMedia('(pointer: fine)').matches) { event.preventDefault(); if (!$('send').disabled) $('composer').requestSubmit(); }
  };
  $('composer').onsubmit = event => {
    event.preventDefault(); const group = state.group, text = $('draft').value;
    if (!group || isBusy() || !text.trim() || isIncoming(dmById(group))) return;
    if (new TextEncoder().encode(text).length > 16384 || text.includes('\0')) { $('composer-error').textContent = 'This message is too long. Shorten it and try again.'; return; }
    const record = readRecord(group), attempt = {request_id: crypto.randomUUID(), text, created_at: Date.now(), state: 'failed'};
    const previousDraft = record.draft; record.attempts.push(attempt); record.draft = '';
    if (!persist(group)) { record.attempts.pop(); record.draft = previousDraft; $('composer-error').textContent = 'Draft storage is unavailable. Keep this window open and try again.'; return; }
    $('draft').value = ''; $('composer-error').textContent = ''; resizeDraft(); submitAttempt(group, attempt);
  };
  for (const id of ['passphrase', 'confirm-passphrase']) $(id).addEventListener('input', () => { $('setup-error').textContent = ''; updateSetup(); });
  $('confirm-passphrase').onblur = () => {
    if (state.mode === 'setup_required' && $('confirm-passphrase').value) $('setup-error').textContent = passphraseLength($('passphrase').value) < 16 ? 'Needs at least 16 characters.' : $('passphrase').value !== $('confirm-passphrase').value ? "Passphrases don't match." : '';
  };
  $('show-password').onclick = () => {
    const show = $('passphrase').type === 'password'; $('passphrase').type = show ? 'text' : 'password';
    $('show-password').textContent = show ? 'Hide' : 'Show'; $('show-password').setAttribute('aria-label', show ? 'Hide passphrase' : 'Show passphrase'); $('show-password').setAttribute('aria-pressed', String(show));
  };
  $('setup-form').onsubmit = event => {
    event.preventDefault(); if ($('setup-submit').disabled || isBusy()) return;
    const creating = state.mode === 'setup_required', password = $('passphrase').value, name = $('display-name').value;
    if (creating && (passphraseLength(password) < 16 || password !== $('confirm-passphrase').value)) return;
    if (new TextEncoder().encode(password).length > 1024 || password.includes('\0')) { $('setup-error').textContent = 'Choose a shorter passphrase.'; return; }
    if (new TextEncoder().encode(name).length > 160) { $('setup-error').textContent = 'Choose a shorter name.'; return; }
    $('setup-submit').disabled = true;
    act(async signal => {
      try {
        if (state.sessionLocked) {
          const session = await api('api/view/unlock', {method: 'POST', body: {vault_password: password}, signal, session: true});
          if (typeof session?.csrf_token !== 'string' || !session.csrf_token) { disconnect(); return; }
          state.csrf = session.csrf_token; state.authenticated = true; state.sessionLocked = false;
        } else {
          await api('api/setup', {method: 'POST', body: {action: creating ? 'create' : 'unlock', vault_password: password, ...(creating && name.trim() ? {display_name: name} : {})}, signal});
        }
        $('passphrase').value = ''; $('confirm-passphrase').value = ''; state.setupFailed = false;
        await snapshot(signal); if (creating && state.mode === 'ready') openSheet('address');
      } catch (error) {
        $('passphrase').value = ''; $('confirm-passphrase').value = '';
        if (error.name !== 'AbortError') { state.setupFailed = creating; $('setup-error').textContent = friendly(error); $('passphrase').focus(); }
      } finally { updateSetup(); }
    });
  };
  $('lock').onclick = () => {
    act(async signal => {
      try { await api('api/setup', {method: 'POST', body: {action: 'lock'}, signal}); eraseView(); gate('locked'); }
      catch (error) { if (error.name !== 'AbortError') $('copy-error').textContent = friendly(error); }
    });
  };
  $('contact-address').oninput = previewAddress;
  $('contact-form').onsubmit = event => {
    event.preventDefault(); if (isBusy()) return;
    const input = $('contact-address').value;
    const nip05 = /^[a-zA-Z0-9_.-]+@(?:[a-zA-Z0-9](?:[a-zA-Z0-9-]*[a-zA-Z0-9])?\.)+[a-zA-Z]{2,}$/.test(input);
    if (!nip05) { try { decodeAddress(input); } catch { $('contact-error').textContent = "That address doesn't look right."; return; } }
    const label = $('contact-name').value;
    if (new TextEncoder().encode(label).length > 160) { $('contact-error').textContent = 'Choose a shorter name.'; return; }
    $('contact-submit').disabled = true; $('contact-submit').textContent = 'Sending invite…'; $('contact-submit').classList.add('pending'); $('contact-error').textContent = '';
    act(async signal => {
      try {
        const resolved = await api('api/resolve-contact', {method: 'POST', body: {address: input}, signal});
        if (!/^[0-9a-f]{64}$/.test(resolved?.pubkey || '')) throw new APIError('invalid_address', 400);
        if (nip05 && resolved.nip05_verified !== true) throw new APIError('nip05_unverified', 400);
        const address = {pubkey: resolved.pubkey, npub: decodeAddress(resolved.pubkey).npub};
        $('address-preview').textContent = address.npub;
        if (label.trim()) await api('api/contacts', {method: 'POST', body: {pubkey: address.pubkey, label}, signal});
        const result = await api('api/dms', {method: 'POST', body: {pubkey: address.pubkey, ...(label.trim() ? {name: label} : {})}, signal});
        if (!result.dm?.group_id) throw new APIError('request_failed', 500);
        if (result.invite_sent === true) { readRecord(result.dm.group_id).invite_sent = true; persist(result.dm.group_id); }
        state.dms = state.dms.filter(dm => dm.group_id !== result.dm.group_id).concat(result.dm);
        closeSheet(); $('contact-form').reset(); $('address-preview').textContent = ''; openChat(result.dm.group_id);
      } catch (error) { if (error.name !== 'AbortError') $('contact-error').textContent = friendly(error); }
      finally { $('contact-submit').disabled = false; $('contact-submit').textContent = 'Send invite'; $('contact-submit').classList.remove('pending'); }
    });
  };
  document.addEventListener('visibilitychange', () => {
    // Wizard preloads linked views on a parked desk. A one-use session exchange
    // must finish even while parked: aborting it can consume the ticket while
    // stranding this document on Opening. Resume ordinary reads on return.
    if (state.operation?.bootstrap) return;
    if (document.hidden) cancel();
    else if (state.authenticated) run(snapshot);
    else if (state.mode === 'opening') boot();
  });
  addEventListener('pagehide', cancel);
  function viewport() {
    const height = window.visualViewport?.height || window.innerHeight;
    $('messenger').style.setProperty('--view-height', height + 'px');
  }
  window.visualViewport?.addEventListener('resize', viewport); addEventListener('resize', viewport); viewport();
  // Remove a one-use ticket synchronously, before the first request. It is never
  // persisted, logged or put into a reusable Authorization header.
  let launchTicket = null;
  function takeLaunchTicket() {
    if (!location.hash.startsWith('#ticket=')) return false;
    const fragment = location.hash.slice(1); history.replaceState(history.state, '', location.pathname + location.search);
    launchTicket = new URLSearchParams(fragment).get('ticket'); return true;
  }
  takeLaunchTicket();
  // A link may navigate an existing app window by fragment only: no new document.
  addEventListener('hashchange', () => {
    if (!takeLaunchTicket() || state.operation?.bootstrap) return;
    if (state.authenticated) { launchTicket = null; run(snapshot); }
    else boot();
  });
  async function boot() {
    gate('opening');
    await run(async signal => {
      try {
        const ticket = launchTicket; launchTicket = null;
        let session;
        try {
          session = await api('api/view/session', ticket ? {method: 'POST', body: {ticket}, signal, session: true} : {signal, session: true});
        } catch (error) {
          if (error.code !== 'invalid_view_ticket') throw error;
          // The bound preview may already have redeemed this link. Only its
          // existing HttpOnly session can recover; the ticket is never replayed.
          session = await api('api/view/session', {session: true});
        }
        if (session?.authenticated !== true || typeof session.csrf_token !== 'string' || !session.csrf_token) { disconnect(); return; }
        state.csrf = session.csrf_token; state.authenticated = true; state.sessionLocked = false; await snapshot(signal);
      } catch (error) {
        if (error.name === 'AbortError' || error.code === 'session_unlock_required') return;
        disconnect(); if (error.code === 'setup_link_required') gate('first_open');
      }
    }, false, true);
  }
  $('reconnect').onclick = boot;
  boot();
})();
