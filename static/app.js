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

  if (!window.WizardApp) throw new Error('Messenger requires the shared WizardApp client');
  window.WizardApp.ready({name: 'messenger', version: '0.2.0-unified.16.0'});

  const $ = id => document.getElementById(id);
  const state = {
    csrf: null, authenticated: false, sessionLocked: false, mode: 'opening', identity: null, contacts: [], dms: [], invites: [],
    group: null, sheet: null, cache: new Map(), records: new Map(), scroll: new Map(), nodes: new Map(),
    operation: null, timer: null, reconnecting: false, setupFailed: false, listSignature: '', focusBefore: null,
    initialChat: false, storageError: false, listLoaded: false, pendingInvite: null, olderPending: null, chatOpening: null
  };
  const storagePrefix = () => 'wizard-messenger:v1:' + state.identity?.account_id + ':';
  let updateHold = null;
  function syncUpdateHold() {
    const setupPending = ['locked', 'setup_required'].includes(state.mode) && ['display-name', 'passphrase', 'confirm-passphrase'].some(id => $(id).value);
    // Only a tap still going out holds a Wizard reload. Drafts live on the server, and a send interrupted by a reload
    // comes back as "checking" and is confirmed by request_id afterwards, so neither a draft, a "checking" bubble nor
    // a contact address left in the (closed) Add contact sheet may block reloading (Miguel, 30 Oct 2026).
    const pending = state.operation?.action || [...state.records.values()].some(record => record.attempts.some(a => a.state === 'sending')) || setupPending;
    if (pending && !updateHold) updateHold = window.WizardApp.update.hold('Messenger unsent work');
    else if (!pending && updateHold) { updateHold.release(); updateHold = null; }
  }
  // Set by boot from api/view/trusted-owner. Remembered on this device so a reload that lands mid-restart (the gateway
  // answering 502) is still treated as a trusted Wizard: never a passphrase box because one answer was missing.
  const TRUSTED_KEY = 'messenger-trusted-wizard';
  let trustedWizard = (() => { try { return localStorage.getItem(TRUSTED_KEY) === '1'; } catch { return false; } })();
  function readRecord(group) {
    if (!state.records.has(group)) {
      let saved = {};
      try { saved = JSON.parse(localStorage.getItem(storagePrefix() + group) || '{}'); } catch { /* A draft failure never permits an untracked send. */ }
      const record = {draft: typeof saved?.draft === 'string' ? saved.draft : '', attempts: Array.isArray(saved?.attempts) ? saved.attempts.filter(a => a && (typeof a.text === 'string' || a.message_ids?.length) && /^[a-zA-Z0-9_-]{16,128}$/.test(a.request_id)) : [], invite_sent: saved?.invite_sent === true, seen: saved?.seen || null, muted: saved?.muted === true, low_priority: saved?.low_priority === true};
      for (const attempt of record.attempts) if (attempt.state === 'sending') attempt.state = 'checking';
      state.records.set(group, record);
      syncUpdateHold();
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
    finally { syncUpdateHold(); }
  }
  function cancel() {
    clearTimeout(state.timer); state.timer = null;
    if (state.operation) { state.operation.controller.abort(); state.operation = null; }
  }
  function schedule() {
    clearTimeout(state.timer);
    // The Marmot engine serialises every RPC; keep unified previews current without a tight background loop.
    if (!document.hidden && !state.operation && state.authenticated) state.timer = setTimeout(() => run(snapshot), window.MessengerUnified?.active() ? 10000 : 3000);
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
    constructor(code, status, message) { super(message || code); this.code = code; this.status = status; }
  }
  // Reads ride out a restarting server or a gateway that refused part of the opening burst (502/503/504, a dropped
  // connection, an HTML error page): a few quick retries with backoff before anyone sees an error. Writes are never
  // retried here (sends have their own idempotent retry), and the change feed's long-poll retries by itself.
  const RETRY_READ_MS = [300, 800, 1600, 3000];
  const sleepFor = (ms, signal) => new Promise((resolve, reject) => { const t = setTimeout(resolve, ms); signal?.addEventListener('abort', () => { clearTimeout(t); reject(new DOMException('Aborted', 'AbortError')); }, {once: true}); });
  async function api(path, options = {}) {
    const read = (options.method || 'GET') === 'GET' && !path.startsWith('api/unified/updates');
    for (let attempt = 0; ; attempt++) {
      try { return await apiOnce(path, options); }
      catch (error) {
        if (!read || attempt >= RETRY_READ_MS.length || error.name === 'AbortError' || !transient(error) || options.signal?.aborted) throw error;
        await sleepFor(RETRY_READ_MS[attempt] * (0.75 + Math.random() / 2), options.signal);
      }
    }
  }
  async function apiOnce(path, {method = 'GET', body, signal, session = false} = {}) {
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
      if (['vault_unlock_failed', 'invalid_vault_password', 'invalid_view_ticket'].includes(code) || code.startsWith('passkey_')) throw new APIError(code, 401);
      const unlockRequired = ['session_unlock_required', 'remembered_unlock_unavailable'].includes(code) || (path === 'api/view/unlock' && ['vault_unlock_failed', 'invalid_vault_password'].includes(code));
      // A trusted Wizard has no Messenger password: any lost or refused session (restart, expiry, evicted, Lock in
      // another tab) just opens a fresh one from Wizard sign-in, with "Opening" on screen. Never a dead card.
      if ((unlockRequired || code === 'unauthorized' || code === 'csrf_invalid') && trustedWizard && state.authenticated && path !== 'api/view/session') { window.MessengerUnified?.signout(); state.csrf = null; state.authenticated = false; recoverTrusted(); throw new APIError(code, 401); }
      if (unlockRequired && trustedWizard) { window.MessengerUnified?.signout(); state.csrf = null; state.authenticated = false; recoverTrusted(); throw new APIError(code, 401); }
      disconnect(unlockRequired); throw new APIError(code, 401);
    }
    // A restarting release answers through the gateway with an empty or HTML body: say so, never surface a parser error.
    let envelope;
    try { envelope = await response.json(); } catch { signal?.throwIfAborted(); throw new APIError('server_restarting', response.status); }
    signal?.throwIfAborted();
    if (!response.ok || envelope.ok !== true) throw new APIError(envelope.error?.code || 'request_failed', response.status, envelope.error?.message);
    return envelope.result;
  }
  function friendly(error) {
    const messages = {
      unauthorized: "You were signed out of Messenger. Tap Try again.",
      owner_unlock_required: 'Use your independently issued owner enrollment link, or unlock with your existing passphrase.',
      vault_unlock_failed: "That passphrase isn't right.", invalid_public_key: "That address doesn't look right.",
      login_rate_limited: 'Too many tries. Wait a minute and try again.',
      invalid_vault_password: state.mode === 'locked' ? "That passphrase isn't right." : 'Needs at least 16 characters.',
      invalid_address: "That address doesn't look right.", cannot_invite_self: 'Choose someone else’s Messenger address.',
      invalid_nip05: "That address doesn't look right.", nip05_unverified: 'This address could not be verified. Ask for their Messenger address.', nip05_not_found: 'This address could not be found. Ask for their Messenger address.',
      key_package_not_found: 'This address is not ready for chats yet.', no_key_package: 'This address is not ready for chats yet.',
      locked: 'Unlock Messenger to continue.', vault_locked: 'Unlock Messenger to continue.', request_id_conflict: 'This draft could not be retried safely.',
      server_restarting: 'Messenger is restarting. Try again in a moment.',
      send_outcome_unknown: 'Checking delivery. Your message will not be sent again automatically.',
      invalid_input: 'Check the text and try again.', csrf_invalid: "You were signed out of Messenger. Tap Try again."
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
    window.MessengerUnified?.signout();
    cancel(); eraseView(); state.csrf = null; state.authenticated = false;
    state.sessionLocked = unlockRequired; gate(unlockRequired ? 'locked' : 'reconnect');
  }
  // On a Wizard that vouches for its owner there is no Messenger password, ever. A "locked" answer only means the
  // server is still opening its vault after a restart: keep showing "Opening" and ask again; the session call
  // unlocks it from the key Wizard holds. Never show a passphrase box here.
  // It never gives up: after about two minutes Try again shows too, but the view keeps asking by itself (every 15 s)
  // so a server that comes back later still opens with no tap (Miguel, 30 Oct 2026: "must stay signed in").
  let trustedTries = 0, trustedTimer = null;
  function recoverTrusted() {
    clearTimeout(trustedTimer); clearTimeout(bootTimer);
    trustedTries++;
    if (trustedTries > 30) { if (state.mode !== 'reconnect') gate('reconnect'); $('gate-description').textContent = "Messenger couldn't open your messages. Tap Try again."; $('reconnect').hidden = false; }
    else { gate('opening'); $('gate-description').textContent = 'Opening your messages…'; }
    trustedTimer = setTimeout(() => { if (state.operation?.bootstrap) return; boot(); }, trustedTries > 30 ? 15000 : Math.min(1000 * trustedTries, 4000));
  }
  function gate(mode) {
    if (mode === 'locked' && trustedWizard) return recoverTrusted();
    if (mode === 'ready') { trustedTries = 0; bootTries = 0; clearTimeout(trustedTimer); clearTimeout(bootTimer); }
    const changed = state.mode !== mode;
    state.mode = mode; $('gate').hidden = false; $('workspace').hidden = true;
    if (['first_open', 'enrollment_ready', 'setup_required', 'locked'].includes(mode)) window.MessengerUnified?.signout();
    const create = mode === 'setup_required', locked = mode === 'locked', enrollment = mode === 'enrollment_ready';
    $('gate-title').textContent = locked ? 'Unlock Messenger' : 'Messenger';
    // On a Wizard that vouches for its owner there is no Messenger password: Wizard sign-in is the lock.
    const keyless = trustedWizard && create;
    $('gate-description').textContent = locked ? (trustedWizard ? 'Enter your old Messenger passphrase one last time. Wizard remembers it, so you will not be asked again.' : 'Enter your passphrase to open your messages.') : keyless ? 'Create your Wizard Messenger address. Chats are end-to-end encrypted and go straight to the other person\'s Wizard.' : create ? 'Create a messaging address for this Wizard. It is separate from your Wizard ID and is used only for chats.' : enrollment ? 'Your private setup link is ready. Continue here to create your Messenger address.' : mode === 'reconnect' ? "Couldn't reach Messenger. Tap Try again." : mode === 'first_open' ? 'Finish setup using the private Messenger setup link in your Wizard chat.' : 'Opening your messages…';
    $('setup-form').hidden = !(create || locked); $('reconnect').hidden = !enrollment && mode !== 'reconnect' && mode !== 'first_open';
    $('reconnect').textContent = enrollment ? 'Continue setup' : 'Try again';
    $('name-label').hidden = !create; $('confirm-label').hidden = !create || keyless; $('confirm-passphrase').required = create && !keyless;
    $('passphrase-label').hidden = keyless; $('passphrase').required = !keyless;
    $('passphrase-help').hidden = !create || keyless; $('passphrase').minLength = locked ? 1 : keyless ? 0 : 16;
    if ($('remember-wizard-label')) $('remember-wizard-label').hidden = true;
    if (changed) {
      $('passphrase').value = ''; $('confirm-passphrase').value = ''; $('setup-error').textContent = '';
      $('passphrase').type = 'password'; $('show-password').textContent = 'Show';
      $('show-password').setAttribute('aria-label', 'Show passphrase'); $('show-password').setAttribute('aria-pressed', 'false');
    }
    if (changed && locked) { refreshPasskey(); refreshPhoneVault(); }
    updateSetup(); renderActivity(); renderPasskey();
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
    syncUpdateHold();
    const create = state.mode === 'setup_required', password = $('passphrase').value;
    const pending = isBusy() && ['locked', 'setup_required'].includes(state.mode);
    $('setup-submit').classList.toggle('pending', pending);
    if (pending) { $('setup-submit').disabled = true; $('setup-submit').textContent = create ? 'Creating address…' : 'Unlocking…'; return; }
    $('setup-submit').textContent = create ? (state.setupFailed ? 'Try again' : 'Create address') : 'Unlock';
    $('setup-submit').disabled = create ? !trustedWizard && (passphraseLength(password) < 16 || password !== $('confirm-passphrase').value) : !password.length;
  }
  function ready(identity) {
    state.identity = identity; state.mode = 'ready'; $('gate').hidden = true; $('workspace').hidden = false;
    for (const id of ['passphrase', 'confirm-passphrase']) $(id).value = ''; // unlocked: nothing typed is pending any more
    syncUpdateHold();
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
    // A setup-only browser session is not a configured messaging account.
    window.MessengerUnified?.authenticated();
    state.contacts = (await api('api/contacts', {signal})).contacts || [];
    state.invites = (await api('api/invites', {signal})).invites || [];
    state.dms = (await api('api/dms', {signal})).dms || [];
    // The frozen summary has no preview/unread fields. Query real latest events;
    // never manufacture list previews from names or a fixture conversation.
    const latest = await Promise.all(state.dms.filter(dm => dm.group_id !== state.group).map(async dm => [dm.group_id, await api('api/dms/' + encodeURIComponent(dm.group_id) + '/messages?limit=1', {signal})]));
    for (const [group, data] of latest) {
      const cache = cacheFor(group); cache.messages = mergeMessages(cache.messages, data.messages || []);
      reconcile(group);
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
  function timeLabel(value) { const ms = stamp(value); return ms ? new Date(ms).toLocaleTimeString([], {hour: 'numeric', minute: '2-digit'}) : ''; }
  function row(dm, invite = false) {
    const name = peerName(dm), messages = cacheFor(dm.group_id).messages, last = messages.at(-1), record = readRecord(dm.group_id);
    const unread = !invite && last?.direction === 'received' && record.seen !== last.message_id;
    const U = window.MessengerUnified;
    const el = button('', 'conversation-row' + (unread ? ' unread' : '') + (record.muted ? ' muted' : ''), () => { if (el.dataset.held) { delete el.dataset.held; return; } openChat(dm.group_id); });
    if (!invite && U?.holdToMenu) U.holdToMenu(el, () => U.actionMenu(el, name, [U.muteAction(record.muted, () => { record.muted = !record.muted; persist(dm.group_id); state.listSignature = ''; renderList(); U.toast(record.muted ? 'Muted' : 'Unmuted'); })]));
    el.dataset.group = dm.group_id; el.setAttribute('aria-current', String(state.group === dm.group_id));
    el.append(element('span', 'avatar', name.slice(0, 1).toUpperCase()));
    const rowName = element('span', 'row-name', name);
    if (record.muted && U?.icon) { const m = U.icon('belloff'); m.classList.add('u-muted-mark'); rowName.append(m); }
    const body = element('span', 'row-body'); body.append(rowName, element('span', 'row-preview', invite ? 'wants to chat' : last?.text || (record.invite_sent ? 'Invite sent' : 'No messages yet')));
    const meta = element('span', 'row-meta', invite ? '' : timeLabel(last?.created_at));
    if (unread) meta.append(element('span', 'row-dot' + (record.muted ? ' muted' : '')));
    el.append(body, meta); return el;
  }
  function renderList() {
    if (state.mode !== 'ready') return;
    const signature = JSON.stringify([state.group, state.listLoaded, state.pendingInvite, state.contacts, state.invites, state.dms, [...state.cache].map(([id,c]) => [id,c.messages.at(-1)]), [...state.records].map(([id,r]) => [id,r.seen,r.invite_sent,r.muted,r.low_priority])]);
    if (signature === state.listSignature) return; state.listSignature = signature;
    // Adapter rows only: native history, invite and send handling stay in this engine.
    const nativeRows = [...state.invites, ...state.dms.filter(dm => !isIncoming(dm))].map(dm => {
      const record = readRecord(dm.group_id), last = cacheFor(dm.group_id).messages.at(-1), invite = isIncoming(dm);
      return {id: 'private:' + dm.group_id, native: true, invite, group_id: dm.group_id, display_name: peerName(dm),
        identities: [{network: 'private', kind: 'person'}], muted: !!record.muted, low_priority: !!record.low_priority,
        unread: invite || (last?.direction === 'received' && record.seen !== last.message_id) ? 1 : 0,
        last: {text: invite ? 'wants to chat' : last?.text || (record.invite_sent ? 'Invite sent' : 'No messages yet'),
          timestamp: stamp(last?.created_at), outgoing: last?.direction === 'sent'},
        setMuted: () => { record.muted = !record.muted; persist(dm.group_id); state.listSignature = ''; renderList(); },
        setLowPriority: v => { record.low_priority = !!v; persist(dm.group_id); state.listSignature = ''; renderList(); }};
    });
    window.MessengerUnified?.setNativeRows?.(nativeRows);
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
    paintChatFace(peerName(dm));
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
  // Header face for a private chat: the person's initial with the Private (shield) badge, like bridged threads.
  function paintChatFace(name) {
    const face = $('chat-avatar'), initial = (name || '?').trim().slice(0, 1).toUpperCase() || '?';
    if (face.dataset.name === name) return; face.dataset.name = name; face.replaceChildren();
    face.append(element('span', 'avatar small', initial));
    const badge = window.MessengerConnectors?.badge?.('private', 'u-net'); if (badge) face.append(badge);
  }
  function updateComposer() {
    const dm = dmById(state.group), disabled = state.mode !== 'ready' || !dm || isIncoming(dm);
    $('draft').disabled = disabled; $('draft').placeholder = isIncoming(dm) ? 'Accept this invite to write a message' : 'Message';
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
    // Consecutive messages from the same side within five minutes form one run (like the bridged thread view).
    const dayOf = item => { const ms = stamp(item?.message.created_at); return ms ? new Date(ms).toLocaleDateString([], {month: 'short', day: 'numeric', year: 'numeric'}) : ''; };
    const joins = (a, b) => !!a && !!b && a.message.direction === b.message.direction && dayOf(a) === dayOf(b) && Math.abs(stamp(b.message.created_at) - stamp(a.message.created_at)) < 3e5;
    items.forEach((item, i) => { const jp = joins(items[i - 1], item), jn = joins(item, items[i + 1]); item.pos = jp && jn ? 'mid' : jp ? 'last' : jn ? 'first' : 'single'; });
    for (const item of items) {
      const ms = stamp(item.message.created_at), day = ms ? new Date(ms).toLocaleDateString([], {month: 'short', day: 'numeric', year: 'numeric'}) : '';
      if (day && day !== lastDay) {
        const dayKey = 'day:' + day, separator = state.nodes.get(dayKey) || element('div', 'date-separator', day);
        state.nodes.set(dayKey, separator); live.add(dayKey); list.append(separator); lastDay = day;
      }
      let node = state.nodes.get(item.key);
      if (!node) { node = element('article', 'message'); node.append(element('div', 'bubble'), element('time', 'message-time'), element('div', 'message-status')); state.nodes.set(item.key, node); }
      live.add(item.key); const outgoing = item.message.direction === 'sent', delivery = item.attempt?.state;
      node.className = 'message' + (outgoing ? ' sent' : ' received') + ' pos-' + item.pos + (delivery === 'failed' ? ' not-sent' : '');
      node.dataset.direction = outgoing ? 'out' : 'in';
      node.item = item;
      if (!node.dataset.selectionBound) {
        node.dataset.selectionBound = '1'; const messageId = item.message.message_id || null;
        window.MessengerUnified?.messageGestures?.(node, node.children[0], {selection: () => messageId ? state.selection : null, id: messageId,
          reply: messageId ? () => { const m = node.item?.message; if (m && !m.deleted) startReply(m); } : null,
          menu: (opts = {}) => { if (!state.selection?.active) messageMenu(group, node, opts); }});
      }
      node.dataset.messageId = item.message.message_id || ''; node.dataset.requestId = item.attempt?.request_id || '';
      paintBubble(node.children[0], item.message, outgoing);
      node.children[1].textContent = timeLabel(item.message.created_at); if (ms) node.children[1].dateTime = new Date(ms).toISOString();
      paintReactions(node, group, item.message);
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
    state.selection?.paint();
    markSeen();
  }
  // One message bubble: optional reply quote, then the text (or the delete tombstone). Text stays data, never markup.
  function paintBubble(bubble, m, outgoing) {
    const quote = m.reply && !m.deleted ? (m.reply.deleted ? 'Deleted message' : m.reply.text || (m.reply.missing ? 'Earlier message' : '')) : null;
    const text = m.deleted ? (outgoing ? 'You deleted this message' : 'This message was deleted') : m.text;
    const edited = !!m.edited && !m.deleted;
    const sig = JSON.stringify([quote, m.reply?.outgoing, text, !!m.deleted, edited]);
    if (bubble.dataset.sig === sig) return; bubble.dataset.sig = sig; bubble.replaceChildren();
    bubble.classList.toggle('deleted', !!m.deleted);
    if (quote !== null) {
      const q = element('div', 'u-quote reply-quote'); q.append(element('strong', '', m.reply.outgoing ? 'You' : peerName(dmById(state.group)) || 'Them'), element('span', '', quote));
      q.onclick = () => { const target = [...state.nodes.values()].find(n => n.dataset.messageId === m.reply.message_id); if (target) { target.scrollIntoView({block: 'center', behavior: 'smooth'}); target.classList.add('flash'); setTimeout(() => target.classList.remove('flash'), 1200); } };
      bubble.append(q);
    }
    bubble.append(element('span', 'bubble-text', text || ''));
    if (edited) bubble.append(element('span', 'bubble-edited', 'edited'));
  }
  function paintReactions(node, group, m) {
    let strip = node.reactionStrip;
    const list = m.deleted ? [] : m.reactions || [];
    if (!list.length) { if (strip) { strip.remove(); node.reactionStrip = null; } return; }
    if (!strip) { strip = node.reactionStrip = element('div', 'u-reactions'); node.children[0].after(strip); }
    strip.replaceChildren(...list.map(r => { const b = button(r.key + (r.count > 1 ? ' ' + r.count : ''), 'u-react' + (r.mine ? ' mine' : ''), () => reactTo(group, m, r.key)); b.setAttribute('aria-label', (r.mine ? 'Remove your ' : 'React ') + r.key); return b; }));
  }
  // Long-press, right-click or tap a bubble: every action this chat supports, in one menu.
  function messageMenu(group, node, opts = {}) {
    const U = window.MessengerUnified, item = node.item; if (!U?.actionMenu || !item) return;
    const m = item.message, outgoing = m.direction === 'sent', copy = text => navigator.clipboard?.writeText(text || '').then(() => U.toast?.('Copied')).catch(() => U.toast?.('Copy is not available here'));
    if (!m.message_id) {
      // A local bubble the server never confirmed (Not sent / Checking delivery). It lives only in this browser.
      const attempt = item.attempt; if (!attempt) return;
      U.actionMenu(node, 'Message', [
        {label: 'Copy', icon: 'copy', run: () => copy(attempt.text)},
        ...(attempt.state === 'failed' ? [{label: 'Try again', icon: 'send', run: () => submitAttempt(group, attempt)}] : []),
        {label: 'Edit and resend', icon: 'compose', run: () => { discardAttempt(group, attempt); $('draft').value = attempt.text || ''; readRecord(group).draft = $('draft').value; persist(group); resizeDraft(); updateComposer(); $('draft').focus(); }},
        {label: 'Discard', icon: 'trash', danger: true, run: () => discardAttempt(group, attempt)}
      ], {side: 'right'});
      return;
    }
    if (m.deleted) return;
    const busy = isIncoming(dmById(group));
    U.actionMenu(node, 'Message', [
      ...(busy ? [] : [{label: 'Reply', icon: 'reply', run: () => startReply(m)}]),
      {label: 'Copy', icon: 'copy', run: () => copy(m.text)},
      ...(opts.selectText && m.text ? [{label: 'Select text', icon: 'copy', run: opts.selectText}] : []),
      {label: 'Forward to Wizard', icon: 'reply', run: () => state.selection?.forward([m.message_id])},
      ...(outgoing && !busy ? [{label: 'Edit', icon: 'compose', run: () => startEdit(m)}] : []),
      ...(opts.select ? [{label: 'Select', icon: 'check', run: opts.select}] : []),
      ...(outgoing && !busy ? [{label: 'Delete for everyone', icon: 'trash', danger: true, run: () => deleteForEveryone(group, m)}] : [])
    ], {side: outgoing ? 'right' : 'left', quick: busy ? null : {mine: (m.reactions || []).find(r => r.mine)?.key, pick: key => reactTo(group, m, key)}});
  }
  function discardAttempt(group, attempt) {
    const record = readRecord(group); record.attempts = record.attempts.filter(a => a !== attempt);
    persist(group); if (group === state.group) { renderMessages(); renderList(); }
  }
  function startReply(m) { state.compose = {group: state.group, mode: 'reply', message: m}; paintComposeBar(); $('draft').focus(); }
  function startEdit(m) {
    state.compose = {group: state.group, mode: 'edit', message: m, saved: $('draft').value};
    $('draft').value = m.text || ''; resizeDraft(); updateComposer(); paintComposeBar(); $('draft').focus();
  }
  function endCompose() {
    const c = state.compose; state.compose = null;
    if (c?.mode === 'edit') { readRecord(c.group).draft = c.saved || ''; persist(c.group); if (c.group === state.group) { $('draft').value = c.saved || ''; resizeDraft(); updateComposer(); } }
    paintComposeBar();
  }
  function paintComposeBar() {
    const bar = $('compose-bar');
    const c = state.compose && state.compose.group === state.group ? state.compose : null;
    bar.hidden = !c; bar.replaceChildren(); if (!c) return;
    const q = element('div', 'u-quote in-bar'); q.append(element('strong', '', c.mode === 'edit' ? 'Edit message' : c.message.direction === 'sent' ? 'Reply to yourself' : 'Reply to ' + (peerName(dmById(state.group)) || 'them')), element('span', '', c.message.text || ''));
    const close = button('', 'icon-button compose-cancel', () => endCompose()); close.setAttribute('aria-label', 'Cancel'); close.title = 'Cancel';
    const glyph = window.MessengerUnified?.icon?.('close'); if (glyph) close.append(glyph); else close.textContent = '×';
    bar.append(q, close);
  }
  // Edit, delete and react publish a new encrypted event; refresh history to show what the relay accepted.
  function messageAction(group, m, action, body, done) {
    if (isBusy()) return;
    act(async signal => {
      try {
        await api('api/dms/' + encodeURIComponent(group) + '/messages/' + encodeURIComponent(m.message_id) + '/' + action, {method: 'POST', body, signal});
        done?.(); await refreshMessages(group, signal);
      } catch (error) {
        if (error.name !== 'AbortError') { $('composer-error').textContent = friendly(error); window.MessengerUnified?.toast?.(friendly(error), 3000); }
      }
      if (state.group === group) renderMessages();
    });
  }
  function reactTo(group, m, key) {
    const mine = (m.reactions || []).find(r => r.mine)?.key;
    // One reaction per person: picking your current one again removes it, a new one replaces it.
    if (mine === key) messageAction(group, m, 'react', {remove: true});
    else messageAction(group, m, 'react', {emoji: key});
  }
  async function deleteForEveryone(group, m) {
    const U = window.MessengerUnified;
    const yes = U?.ask ? await U.ask({title: 'Delete for everyone?', body: 'You and ' + (peerName(dmById(group)) || 'they') + ' will see "This message was deleted" instead. It is hidden, not securely erased.', yes: 'Delete', no: 'Cancel'}) : true;
    if (yes) messageAction(group, m, 'delete', {});
  }
  function resizeDraft() {
    const draft = $('draft'), top = $('message-scroll').scrollTop;
    draft.style.height = '44px'; draft.style.height = Math.min(112, Math.max(44, draft.scrollHeight)) + 'px';
    $('message-scroll').scrollTop = top;
  }
  function openChat(group) {
    window.MessengerUnified?.showNative?.(group);
    if (state.group === group) { closeSheet(); return; }
    state.selection?.clear();
    cancel(); if (state.group) state.scroll.set(state.group, $('message-scroll').scrollTop);
    state.compose = null; paintComposeBar();
    state.group = group; state.chatOpening = group; state.initialChat = true; state.nodes.clear(); $('messages').replaceChildren();
    $('chat-error').textContent = ''; $('composer-error').textContent = ''; $('new-messages').hidden = true;
    $('draft').value = readRecord(group).draft; $('no-selection').hidden = true; $('chat').hidden = false;
    $('workspace').classList.add('has-chat'); renderHeader(); renderList(); renderMessages(); resizeDraft(); updateComposer();
    if (!state.selection) state.selection = window.MessengerUnified?.messageSelection?.($('chat'), () => cacheFor(state.group).messages.map(m => ({message: {id: m.message_id, original: m.text || '', sender: peerName(dmById(state.group)) || 'Sender', outgoing: m.direction === 'sent', timestamp: stamp(m.created_at)}, node: [...state.nodes.values()].find(n => n.dataset.messageId === m.message_id)})));
    run(snapshot);
  }
  function leaveChat() {
    state.selection?.clear();
    if (state.group) state.scroll.set(state.group, $('message-scroll').scrollTop);
    state.group = null; state.chatOpening = null; $('chat').hidden = true; $('no-selection').hidden = false;
    $('workspace').classList.remove('has-chat'); $('draft').value = ''; state.nodes.clear(); $('messages').replaceChildren();
    renderList(); updateComposer();
    window.MessengerUnified?.returnNative?.();
  }
  function openSheet(kind) {
    window.MessengerUnified?.showNative?.();
    cancel(); state.focusBefore = document.activeElement; state.sheet = kind;
    $('sheet-title').textContent = kind === 'contact' ? 'Add contact' : 'My address';
    $('contact-form').hidden = kind !== 'contact'; $('address-panel').hidden = kind !== 'address';
    $('sheet-layer').hidden = false; $('contact-error').textContent = ''; $('copy-error').textContent = '';
    $('workspace').inert = true;
    if (kind === 'address') $('public-address').textContent = publicAddress(state.identity);
    else renderContacts();
    $('sheet').focus(); schedule();
  }
  function closeSheet() {
    if (!state.sheet) return;
    cancel(); state.sheet = null; $('sheet-layer').hidden = true;
    $('workspace').inert = false;
    state.focusBefore?.focus?.(); state.focusBefore = null; schedule();
    if (!state.group) window.MessengerUnified?.returnNative?.();
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
        const receipt = await api('api/dms/' + encodeURIComponent(group) + '/messages', {method: 'POST', body: {text: attempt.text, request_id: attempt.request_id, ...(attempt.reply_to ? {reply_to: attempt.reply_to} : {})}, signal});
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
      // Icon buttons keep their glyph; the copied state is a class plus an accessible label.
      const icon = control.classList.contains('icon-button');
      const old = icon ? control.getAttribute('aria-label') : control.textContent;
      if (icon) control.setAttribute('aria-label', 'Copied'); else control.textContent = 'Copied';
      control.classList.add('copied');
      setTimeout(() => { if (icon) control.setAttribute('aria-label', old || 'Copy'); else control.textContent = old; control.classList.remove('copied'); }, 1500);
    } catch { errorTarget.textContent = 'Copy is unavailable. Select the address and copy it.'; }
  }

  // Domain-only Back: the shared client owns platform/root behavior.
  function backStep() {
    if (window.MessengerUnified?.active()) return window.MessengerUnified.back();
    if (!state.sheet && state.selection?.active) { state.selection.clear(); return true; }
    const next = backLayer(state);
    if (!next.handled) return false;
    cancel();
    if (state.sheet) closeSheet(); else leaveChat();
    schedule(); return true;
  }
  window.__wizardCloseOverlay = backStep;
  window.WizardApp.back.register({canGoBack: () => window.MessengerUnified?.active() ? window.MessengerUnified.canGoBack() : !!(state.sheet || state.group), back: backStep});
  for (const id of ['contact-address', 'contact-name', 'display-name']) $(id).addEventListener('input', syncUpdateHold);
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
    if (event.key === 'Escape' && state.compose) { event.preventDefault(); event.stopPropagation(); endCompose(); return; }
    if (event.key === 'Enter' && !event.shiftKey && !event.isComposing && matchMedia('(pointer: fine)').matches) { event.preventDefault(); if (!$('send').disabled) $('composer').requestSubmit(); }
  };
  $('composer').onsubmit = event => {
    event.preventDefault(); const group = state.group, text = $('draft').value;
    if (!group || isBusy() || !text.trim() || isIncoming(dmById(group))) return;
    if (new TextEncoder().encode(text).length > 16384 || text.includes('\0')) { $('composer-error').textContent = 'This message is too long. Shorten it and try again.'; return; }
    const compose = state.compose?.group === group ? state.compose : null;
    if (compose?.mode === 'edit') {
      if (text === compose.message.text) { endCompose(); return; }
      messageAction(group, compose.message, 'edit', {text}, () => endCompose());
      return;
    }
    const record = readRecord(group), attempt = {request_id: crypto.randomUUID(), text, created_at: Date.now(), state: 'failed', ...(compose?.mode === 'reply' ? {reply_to: compose.message.message_id} : {})};
    if (compose) { state.compose = null; paintComposeBar(); }
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
    const creating = state.mode === 'setup_required', name = $('display-name').value;
    // Keyless setup: the vault still gets a strong random key, which only Wizard keeps (never shown, never typed).
    const password = creating && trustedWizard ? b64u(crypto.getRandomValues(new Uint8Array(32))) : $('passphrase').value;
    if (creating && !trustedWizard && (passphraseLength(password) < 16 || password !== $('confirm-passphrase').value)) return;
    if (new TextEncoder().encode(password).length > 1024 || password.includes('\0')) { $('setup-error').textContent = 'Choose a shorter passphrase.'; return; }
    if (new TextEncoder().encode(name).length > 160) { $('setup-error').textContent = 'Choose a shorter name.'; return; }
    $('setup-submit').disabled = true;
    act(async signal => {
      try {
        if (!(await unlockWith(password, signal, creating, name))) return;
        phone.typed = password;
        $('passphrase').value = ''; $('confirm-passphrase').value = ''; state.setupFailed = false;
        await snapshot(signal); if (creating && state.mode === 'ready') openSheet('address');
        if (!creating) offerPhoneFingerprint(password);
        if (!phone.available && !creating && state.passkey && !state.passkeyWrapped) rememberOnFingerprint(password).catch(e => console.warn('fingerprint seal', e?.name, e?.message));
      } catch (error) {
        $('passphrase').value = ''; $('confirm-passphrase').value = '';
        if (error.name !== 'AbortError') { state.setupFailed = creating; $('setup-error').textContent = friendly(error); $('passphrase').focus(); }
      } finally { updateSetup(); }
    });
  };
  async function unlockWith(password, signal, creating = false, name = '') {
    const rememberWizard = trustedWizard; // Wizard sign-in is the lock: always remember on a trusted Wizard.
    if (state.sessionLocked) {
      const session = await api('api/view/unlock', {method: 'POST', body: {vault_password: password, ...(rememberWizard ? {remember_wizard: true} : {})}, signal, session: true});
      if (typeof session?.csrf_token !== 'string' || !session.csrf_token) { disconnect(); return false; }
      state.csrf = session.csrf_token; state.authenticated = true; state.sessionLocked = false;
    } else {
      await api('api/setup', {method: 'POST', body: {action: creating ? 'create' : 'unlock', vault_password: password, ...(creating && name.trim() ? {display_name: name} : {})}, signal});
      // Launcher tickets are setup-only; passphrase proof opens the owner view,
      // including when a phone-vault or PRF unlock calls this shared helper.
      const session = await api('api/view/unlock', {method: 'POST', body: {vault_password: password, ...(rememberWizard ? {remember_wizard: true} : {})}, signal, session: true});
      if (typeof session?.csrf_token !== 'string' || !session.csrf_token) { disconnect(); return false; }
      state.csrf = session.csrf_token; state.authenticated = true;
    }
    return true;
  }
  // Fingerprint / face unlock (passkey on this device). With the WebAuthn PRF extension the phone's fingerprint
  // key also seals the passphrase (AES-GCM under a key only the phone can derive), so a fingerprint reopens
  // Messenger after a restart or Lock too. The server stores only the sealed copy and can never open it.
  const passkeySupported = !!(window.PublicKeyCredential && navigator.credentials?.get);
  const b64u = buffer => btoa(String.fromCharCode(...new Uint8Array(buffer))).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  const unb64u = text => Uint8Array.from(atob(text.replace(/-/g, '+').replace(/_/g, '/') + '==='.slice((text.length + 3) % 4)), c => c.charCodeAt(0));
  // In the Wizard OS Android app the phone itself keeps the passphrase behind your fingerprint (WizardApp.vault:
  // Android Keystore + fingerprint prompt). Nothing about it is stored on the server, and it survives restarts.
  const phone = {available: false, saved: false, typed: null, tried: false};
  const vault = () => window.WizardApp?.vault;
  async function refreshPhoneVault() {
    try { Object.assign(phone, await vault()?.has() || {}); } catch { phone.available = false; }
    renderPasskey();
    if (phone.saved && state.mode === 'locked' && !phone.tried) whenOnScreen(() => {
      if (phone.tried || state.mode !== 'locked') return;
      if (isBusy()) setTimeout(refreshPhoneVault, 400); else { phone.tried = true; $('fingerprint-unlock').click(); }
    });
  }
  // The fingerprint prompt waits until you can actually see Messenger. Wizard loads apps in the background
  // after a reload; a prompt for an app you never opened is noise (James, 27 Oct 2026). On screen means the tab
  // is visible and at least half the unlock card is in the real viewport (IntersectionObserver sees through the shell's frame).
  let onScreenWait = null;
  function whenOnScreen(fn) {
    onScreenWait = fn;
    if (whenOnScreen.io) return;
    const gateEl = $('gate'); let seen = false;
    // Also ask Wizard (it knows which window is in front, which an overlay or a restoring reload hides from the
    // observer), and require it to hold for a moment.
    const front = () => seen && document.visibilityState === 'visible' && window.WizardApp?.view?.isVisible?.() !== false;
    let steady = null;
    const fire = () => {
      if (!onScreenWait) return;
      if (!front()) { clearTimeout(steady); steady = null; return; }
      if (steady) return;
      steady = setTimeout(() => { steady = null; if (!onScreenWait || !front()) return; const f = onScreenWait; onScreenWait = null; stop(); f(); }, 600);
    };
    const poll = setInterval(() => { if (!whenOnScreen.io) clearInterval(poll); else fire(); }, 300);
    const stop = () => { whenOnScreen.io?.disconnect(); whenOnScreen.io = null; document.removeEventListener('visibilitychange', fire); };
    if (!window.IntersectionObserver) { seen = true; document.addEventListener('visibilitychange', fire); whenOnScreen.io = {disconnect() {}}; return fire(); }
    // Half the unlock card in view: a desk parked just past the edge still counts as "intersecting" with zero area.
    whenOnScreen.io = new IntersectionObserver(entries => { seen = entries.some(e => e.isIntersecting && e.intersectionRatio >= 0.5); fire(); }, {threshold: [0, 0.5, 1]});
    whenOnScreen.io.observe(gateEl);
    document.addEventListener('visibilitychange', fire);
  }
  async function savePhoneFingerprint(password) {
    try { await vault().seal(password, 'Unlock Messenger with your fingerprint'); phone.saved = true; localStorage.removeItem('messenger.fingerprint.declined'); return true; }
    catch (error) { if (error.code === 'cancelled') localStorage.setItem('messenger.fingerprint.declined', '1'); return false; }
    finally { renderPasskey(); }
  }
  // First time only: ask, never spring the fingerprint prompt on someone. "Not now" is remembered on this phone.
  async function offerPhoneFingerprint(password) {
    if (!phone.available || phone.saved || localStorage.getItem('messenger.fingerprint.declined')) return;
    const U = window.MessengerUnified, later = 'Not now. You can turn it on anytime from Settings.';
    const yes = await U?.ask?.({title: 'Unlock with your fingerprint?', body: 'Next time Messenger asks for your password, a fingerprint touch opens it instead. Your password stays on this phone.', yes: 'Use fingerprint', no: 'Not now'});
    if (!yes) { localStorage.setItem('messenger.fingerprint.declined', '1'); U?.toast?.(later, 4000); return; }
    if (await savePhoneFingerprint(password)) U?.toast?.('Fingerprint unlock is on', 2500);
    else U?.toast?.(later, 4000);
  }
  function renderPasskey() {
    const usePhone = phone.available;
    $('fingerprint-unlock').hidden = !(state.mode === 'locked' && (usePhone ? phone.saved : passkeySupported && state.passkey));
    $('fingerprint-toggle').hidden = trustedWizard || !(usePhone || passkeySupported);
    $('fingerprint-toggle').textContent = (usePhone ? phone.saved : state.passkey) ? 'Turn off fingerprint unlock' : usePhone ? 'Unlock with fingerprint' : 'Unlock with fingerprint next time';
  }
  async function refreshPasskey() {
    if (!passkeySupported) return;
    try { state.passkey = !!(await api('api/view/passkey', {session: true}))?.enabled; } catch { state.passkey = false; }
    renderPasskey();
  }
  const sealKey = async (prf, use) => crypto.subtle.deriveKey({name: 'HKDF', hash: 'SHA-256', salt: new Uint8Array(32), info: new TextEncoder().encode('wizard-messenger passphrase v1')},
    await crypto.subtle.importKey('raw', prf, 'HKDF', false, ['deriveKey']), {name: 'AES-GCM', length: 256}, false, [use]);
  async function fingerprint(options, signal) {
    const salt = options.prf?.salt ? unb64u(options.prf.salt) : null;
    const credential = await navigator.credentials.get({signal, publicKey: {...options, prf: undefined, challenge: unb64u(options.challenge),
      allowCredentials: options.allowCredentials.map(c => ({...c, id: unb64u(c.id)})), ...(salt ? {extensions: {prf: {eval: {first: salt}}}} : {})}});
    const prf = credential.getClientExtensionResults?.().prf?.results?.first;
    return {credential, prf: prf ? new Uint8Array(prf) : null};
  }
  async function openSealed(prf, wrap) {
    const raw = unb64u(wrap);
    const plain = await crypto.subtle.decrypt({name: 'AES-GCM', iv: raw.subarray(0, 12)}, await sealKey(prf, 'decrypt'), raw.subarray(12));
    return new TextDecoder().decode(plain);
  }
  // After the owner types the passphrase, one fingerprint touch seals it so restarts need only the fingerprint.
  async function rememberOnFingerprint(password) {
    const options = await api('api/view/passkey/unlock-options', {method: 'POST', body: {}, session: true});
    if (!options.prf?.salt) return;
    const {credential, prf} = await fingerprint(options);
    if (!prf) { state.passkeyWrapped = true; console.warn('fingerprint seal: this passkey has no PRF; it opens the view only'); return; }
    const iv = crypto.getRandomValues(new Uint8Array(12));
    const ct = new Uint8Array(await crypto.subtle.encrypt({name: 'AES-GCM', iv}, await sealKey(prf, 'encrypt'), new TextEncoder().encode(password)));
    const wrap = new Uint8Array(12 + ct.length); wrap.set(iv); wrap.set(ct, 12);
    await api('api/view/passkey/wrap', {method: 'POST', body: {id: credential.id, wrap: b64u(wrap)}});
    state.passkeyWrapped = true; $('setup-error').textContent = '';
  }
  $('fingerprint-unlock').onclick = () => {
    if (isBusy()) return;
    $('setup-error').textContent = '';
    act(async signal => {
      if (phone.available && phone.saved) {
        try {
          const password = await vault().open('Unlock Messenger');
          if (await unlockWith(password, signal)) { phone.typed = password; await snapshot(signal); }
        } catch (error) {
          if (error.name === 'AbortError') return;
          // Wizard holds the prompt until Messenger is in front; if you never opened it, ask again when you do.
          if (error.code === 'not_in_front') { phone.tried = false; refreshPhoneVault(); return; }
          if (error.code === 'vault_unlock_failed' || error.code === 'invalidated' || error.code === 'not_saved') { await vault().forget(); phone.saved = false; renderPasskey(); }
          $('setup-error').textContent = error.code === 'cancelled' ? '' : error.code === 'vault_unlock_failed' ? 'Your password changed. Type it once and your fingerprint takes over again.'
            : error.code === 'invalidated' ? 'Your phone\'s fingerprints changed. Type your password once to turn fingerprint back on.' : error.code ? "Fingerprint didn't work. Type your password." : friendly(error);
        } finally { updateSetup(); }
        return;
      }
      try {
        const options = await api('api/view/passkey/unlock-options', {method: 'POST', body: {}, signal, session: true});
        const {credential, prf} = await fingerprint(options, signal);
        const wrap = options.prf?.wraps?.[credential.id];
        if (prf && wrap) {
          let password = null; try { password = await openSealed(prf, wrap); } catch { /* resealed on next passphrase */ }
          if (password) {
            try {
              if (await unlockWith(password, signal)) { state.passkeyWrapped = true; await snapshot(signal); }
              return;
            } catch (error) {
              if (error.code === 'vault_unlock_failed') { api('api/view/passkey/wrap', {method: 'POST', body: {id: credential.id, wrap: null}}).catch(() => {}); }
              throw error;
            }
          }
        }
        const r = credential.response;
        const session = await api('api/view/passkey/unlock', {method: 'POST', session: true, signal, body: {id: credential.id, clientDataJSON: b64u(r.clientDataJSON), authenticatorData: b64u(r.authenticatorData), signature: b64u(r.signature)}});
        if (typeof session?.csrf_token !== 'string' || !session.csrf_token) { disconnect(); return; }
        state.csrf = session.csrf_token; state.authenticated = true; state.sessionLocked = false;
        await snapshot(signal);
      } catch (error) {
        if (error.name === 'AbortError') return;
        $('setup-error').textContent = error.name === 'NotAllowedError' ? 'Fingerprint cancelled. Use your passphrase.' : error.code === 'passkey_vault_locked' ? 'Type your passphrase once: Messenger restarted or was locked.' : error.code?.startsWith('passkey_') ? "Fingerprint unlock didn't work. Use your passphrase." : friendly(error);
      } finally { updateSetup(); }
    });
  };
  $('fingerprint-toggle').onclick = () => {
    if (isBusy()) return;
    $('copy-error').textContent = '';
    if (phone.available) {
      act(async () => {
        if (phone.saved) { await vault().forget(); phone.saved = false; renderPasskey(); $('copy-error').textContent = 'Fingerprint unlock is off. Messenger asks for your password.'; return; }
        if (!phone.typed) { $('copy-error').textContent = 'Lock Messenger, then type your password once: your fingerprint takes over from then on.'; return; }
        if (await savePhoneFingerprint(phone.typed)) $('copy-error').textContent = 'Fingerprint unlock is on, even after Messenger restarts.';
      });
      return;
    }
    act(async signal => {
      try {
        const wasOn = state.passkey;
        if (wasOn) await api('api/view/passkey/clear', {method: 'POST', body: {}, signal});
        else {
          const o = await api('api/view/passkey/register-options', {method: 'POST', body: {}, signal});
          const credential = await navigator.credentials.create({signal, publicKey: {...o, challenge: unb64u(o.challenge), user: {...o.user, id: unb64u(o.user.id)}, excludeCredentials: o.excludeCredentials.map(c => ({...c, id: unb64u(c.id)})), extensions: {prf: {}}}});
          await api('api/view/passkey/register', {method: 'POST', signal, body: {clientDataJSON: b64u(credential.response.clientDataJSON), attestationObject: b64u(credential.response.attestationObject)}});
        }
        await refreshPasskey();
        $('copy-error').textContent = wasOn ? 'Fingerprint unlock is off.' : 'Fingerprint unlock is on. Type your passphrase once more next time it asks; after that your fingerprint reopens Messenger, even after restarts.';
      } catch (error) {
        if (error.name !== 'AbortError') $('copy-error').textContent = error.name === 'NotAllowedError' ? 'Fingerprint setup cancelled.' : error.name === 'InvalidStateError' ? 'This phone is already set up.' : friendly(error);
      }
    });
  };
  $('lock').onclick = () => {
    act(async signal => {
      try { await api('api/setup', {method: 'POST', body: {action: 'lock'}, signal}); window.MessengerUnified?.signout(true); eraseView(); gate('locked'); }
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
    else if (state.mode === 'opening' || state.mode === 'reconnect') { clearTimeout(bootTimer); clearTimeout(trustedTimer); boot(); }
  });
  addEventListener('pagehide', cancel);
  function viewport() {
    // The keyboard shrinks the visual viewport: Messenger follows it so the composer stays above the keyboard.
    // iOS also scrolls the page under the keyboard; keep Messenger's box on the visible part. A pinch zoom is not a keyboard.
    const vv = window.visualViewport, zoomed = vv && vv.scale > 1.01;
    const height = (!zoomed && vv?.height) || window.innerHeight;
    $('messenger').style.setProperty('--view-height', Math.round(height) + 'px');
    const top = !zoomed && vv?.offsetTop > 0 ? Math.round(vv.offsetTop) : 0;
    $('messenger').style.transform = top ? 'translateY(' + top + 'px)' : '';
  }
  window.visualViewport?.addEventListener('resize', viewport); window.visualViewport?.addEventListener('scroll', viewport); addEventListener('resize', viewport); viewport();
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
  async function boot(redeemTicket = false) {
    // Bound views may preload in a different browser context. A preview must not
    // consume the owner's one-use enrollment before they act in this window.
    if (launchTicket && redeemTicket !== true && document.querySelector?.('meta[name="messenger-enrollment"]')?.content === 'manual') {
      gate('enrollment_ready'); return;
    }
    gate('opening');
    await run(async signal => {
      try {
        const ticket = launchTicket; launchTicket = null;
        if (!ticket) {
          try {
            let response;
            for (let attempt = 0; ; attempt++) {
              try { response = await fetch('api/view/trusted-owner', {method: 'GET', headers: {Accept: 'application/json'}, signal, credentials: 'same-origin', cache: 'no-store'}); }
              catch (error) { if (error.name === 'AbortError' || !(error instanceof TypeError) || attempt >= 2) throw error; await sleepFor(400 * (attempt + 1), signal); continue; }
              if (response.status < 500 || response.status === 501 || attempt >= 2) break;
              await sleepFor(400 * (attempt + 1), signal);
            }
            // A restarting server or a refused burst is no answer: keep what this device knew and retry the boot.
            if (response.status >= 500 && response.status !== 501) throw new APIError('server_restarting', response.status);
            let answer = null; try { answer = await response.json(); } catch { throw new APIError('server_restarting', response.status); }
            trustedWizard = response.ok && answer?.result?.enabled === true;
            try { if (trustedWizard) localStorage.setItem(TRUSTED_KEY, '1'); else localStorage.removeItem(TRUSTED_KEY); } catch { /* storage blocked */ }
          } catch (error) { if (error.name === 'AbortError') throw error; if (!transient(error)) trustedWizard = false; else throw error; }
        }
        if ($('remember-wizard-label')) $('remember-wizard-label').hidden = true;
        $('lock').hidden = trustedWizard; renderPasskey();
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
        bootTries = 0; if (state.mode === 'ready') trustedTries = 0;
      } catch (error) {
        if (error.name === 'AbortError') return;
        if (['session_unlock_required', 'remembered_unlock_unavailable', 'locked', 'vault_locked'].includes(error.code)) { if (trustedWizard) recoverTrusted(); return; }
        // Messenger restarting (502/empty body) or the phone briefly offline: keep "Opening" and retry by itself,
        // like sends do. Only a real sign-out lands on the Try again card (a home-screen Messenger has no Wizard to reopen from).
        // It keeps trying for as long as the page is open: after ~3 minutes the Try again card shows as well, but the
        // retries carry on (every 15 s) so the inbox comes back by itself once Messenger answers again. A trusted
        // Wizard treats any refusal the same way (it can always open a fresh session); only setup is a real stop.
        if ((transient(error) || (trustedWizard && error.code !== 'setup_link_required')) ) {
          bootTries++; clearTimeout(bootTimer);
          if (bootTries <= 40) { gate('opening'); $('gate-description').textContent = 'Messenger is restarting. Reconnecting…'; }
          else { if (state.mode !== 'reconnect') { cancelView(); gate('reconnect'); } $('gate-description').textContent = "Couldn't reach Messenger yet. Still trying… or tap Try again."; }
          bootTimer = setTimeout(() => boot(), bootTries <= 40 ? Math.min(1000 * bootTries, 5000) : 15000); return;
        }
        bootTries = 0; disconnect(); if (error.code === 'setup_link_required') gate('first_open');
      }
    }, false, true);
  }
  let bootTries = 0, bootTimer = null;
  const transient = error => error.code === 'server_restarting' || error instanceof TypeError || (error.status >= 500 && error.status !== 501);
  function cancelView() { window.MessengerUnified?.signout(); eraseView(); state.csrf = null; state.authenticated = false; }
  addEventListener('online', () => { if (state.mode === 'reconnect' || state.mode === 'opening' || bootTries) { clearTimeout(bootTimer); clearTimeout(trustedTimer); boot(); } });
  window.MessengerUnified?.mount({api, csrf: () => state.csrf, native: {open: openChat, close: () => { if (state.sheet) closeSheet(); if (state.group) leaveChat(); window.MessengerUnified?.returnNative?.(); }, newChat: () => openSheet('contact'), settings: () => openSheet('address'), address: () => { try { return state.identity ? publicAddress(state.identity) || '' : ''; } catch { return ''; } }}});
  window.MessengerUnified?.paintSaved();
  $('reconnect').onclick = () => { trustedTries = 0; bootTries = 0; clearTimeout(bootTimer); clearTimeout(trustedTimer); boot(true); };
  refreshPasskey(); refreshPhoneVault();
  boot();
})();
