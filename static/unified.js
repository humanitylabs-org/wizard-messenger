/* Unified inbox is a view of the authenticated Messenger API, never a Matrix client. */
(() => {
  'use strict';
  function backState(state) {
    if (state.overlay) return {...state, overlay: null, handled: true};
    if (state.person) return {...state, person: null, handled: true};
    return {...state, handled: false}; // Shared WizardApp owns the root guard.
  }
  if (typeof module !== 'undefined') module.exports = {backState};
  if (typeof document === 'undefined') return;
  const $ = id => document.getElementById(id);
  const s = {tab: 'people', person: null, overlay: null, ready: false, epoch: 0, busy: false, drafts: {}, people: [], login: null};
  let api, timer, lastFocus, updateHold;
  const node = (tag, cls, content) => { const el = document.createElement(tag); if (cls) el.className = cls; if (content != null) el.textContent = content; return el; };
  const button = (label, fn, cls = 'secondary') => { const el = node('button', cls, label); el.type = 'button'; el.onclick = fn; return el; };
  const call = (path, body) => api('api/unified/' + path, body === undefined ? {} : {method: 'POST', body});
  const error = e => { const el = $('u-error'); if (el) el.textContent = e.message || 'Request failed. Please try again.'; };
  async function action(fn) { if (s.busy) return; s.busy = true; try { await fn(); } catch (e) { error(e); } finally { s.busy = false; } }
  function hold() { const pending = Object.values(s.drafts).some(Boolean) || !!s.overlay || s.busy; if (pending && !updateHold) updateHold = window.WizardApp.update.hold('Unified inbox unsent work'); else if (!pending && updateHold) { updateHold.release(); updateHold = null; } }
  function closeOverlay() {
    if (s.login) call('telegram/cancel', {login_id: s.login.login_id}).catch(() => {});
    s.login = null; s.overlay = null; $('u-overlay')?.remove(); lastFocus?.focus(); hold();
  }
  function back() {
    const next = backState(s);
    if (!next.handled) return false;
    if (s.overlay) closeOverlay(); else { s.person = null; s.epoch++; renderList(); }
    return true;
  }
  function overlay(title) {
    closeOverlay(); lastFocus = document.activeElement; s.overlay = title;
    const layer = node('div', 'u-overlay'); layer.id = 'u-overlay';
    const panel = node('section', 'u-sheet'); panel.setAttribute('role', 'dialog'); panel.setAttribute('aria-modal', 'true'); panel.setAttribute('aria-label', title); panel.tabIndex = -1;
    const head = node('header'); head.append(node('h2', '', title), button('×', closeOverlay)); panel.append(head);
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
  function base(title, subtitle) {
    const root = $('unified-inbox'); root.replaceChildren();
    const head = node('header', 'u-header');
    if (s.person) head.append(button('‹', back, 'icon-button'));
    const headings = node('div'); headings.append(node('h1', '', title), node('p', 'helper', subtitle)); head.append(headings);
    root.append(head); const notice = node('p', 'error'); notice.id = 'u-error'; notice.setAttribute('role', 'status'); root.append(notice); return root;
  }
  async function renderList(quiet = false) {
    const epoch = ++s.epoch;
    const root = quiet ? $('unified-inbox') : base(s.tab === 'groups' ? 'Groups' : 'People', s.tab === 'groups' ? 'Your circles, across networks' : 'One person. Every conversation.');
    if (!quiet) root.append(node('p', 'helper u-loading', 'Loading…'));
    try {
      const result = await call(s.tab === 'groups' ? 'groups' : 'people');
      if (s.epoch !== epoch || s.person) return;
      root.querySelector('.u-loading')?.remove(); root.querySelector('.u-list')?.remove(); root.querySelector(':scope > select')?.remove(); const people = result[s.tab] || []; if (s.tab === 'people') s.people = people;
      const list = node('div', 'u-list'); root.append(list);
      let label = '';
      const draw = () => {
        list.replaceChildren();
        for (const p of people.filter(p => !label || p.labels.includes(label))) {
          const card = button('', () => openPerson(p.id), 'u-person');
          card.append(node('span', 'u-avatar', p.display_name.slice(0, 1).toUpperCase()));
          const info = node('span', 'u-person-info'); info.append(node('strong', '', p.display_name));
          const badges = node('span', 'u-badges'); for (const n of new Set(p.identities.map(i => i.network))) badges.append(node('span', 'u-badge', n));
          if (p.language) badges.append(node('span', 'u-badge language', p.language === 'th' ? 'Thai ↔ English' : p.language + ' ↔ English'));
          for (const l of p.labels || []) badges.append(node('span', 'u-badge', l));
          info.append(badges); card.append(info, node('span', '', '›')); list.append(card);
        }
        if (!list.children.length) list.append(node('p', 'u-empty', label ? 'No groups with this label.' : s.tab === 'groups' ? 'Group chats appear here when an account is connected.' : 'Your contacts appear here when messages arrive. Connect Telegram in Settings, or open Messenger to add a contact.'));
      };
      if (s.tab === 'groups') {
        const select = node('select'); select.setAttribute('aria-label', 'Filter groups by label');
        for (const l of ['', ...new Set(people.flatMap(p => p.labels))]) { const opt = node('option', '', l || 'All groups'); opt.value = l; select.append(opt); }
        select.onchange = () => { label = select.value; draw(); }; root.insertBefore(select, list);
      }
      draw();
    } catch (e) { error(e); }
  }
  function paintMessages(scroll, messages) {
    const signature = JSON.stringify(messages.map(m => [m.id, m.translated, m.translation_error]));
    if (scroll.dataset.signature === signature) return;
    const follow = scroll.scrollHeight - scroll.scrollTop - scroll.clientHeight < 64;
    const top = scroll.scrollTop;
    scroll.replaceChildren(); scroll.dataset.signature = signature;
    for (const m of messages) {
      const bubble = node('article', 'u-message' + (m.outgoing ? ' outgoing' : ''));
      bubble.append(node('p', '', m.translated || m.original));
      if (m.translated && m.translated !== m.original) bubble.append(node('p', 'u-original', m.original));
      if (m.translation_error) bubble.append(node('p', 'u-original error', m.translation_error));
      const meta = node('footer'); meta.append(node('span', 'u-badge', m.network), node('time', '', new Date(m.timestamp).toLocaleTimeString([], {hour: '2-digit', minute: '2-digit'}))); bubble.append(meta); scroll.append(bubble);
    }
    if (!messages.length) scroll.append(node('p', 'u-empty', 'No messages yet.'));
    scroll.scrollTop = follow ? scroll.scrollHeight : top;
  }
  async function openPerson(id) {
    s.person = id; const epoch = ++s.epoch;
    base('Opening conversation…', '');
    try {
      const result = await call('people/' + id);
      if (s.epoch !== epoch) return;
      const p = result.person; const root = base(p.display_name, p.language ? 'English for you · ' + (p.language === 'th' ? 'Thai' : p.language) + ' for them' : 'Messages across your connected channels');
      root.querySelector('header').append(button('Edit', () => editPerson(p)));
      if (result.history_warning) root.append(node('p', 'helper', result.history_warning));
      const scroll = node('div', 'u-timeline'); scroll.setAttribute('role', 'log');
      paintMessages(scroll, result.messages);
      root.append(scroll);
      const form = node('form', 'u-composer');
      const channel = node('select'); channel.setAttribute('aria-label', 'Send using channel');
      for (const i of p.identities) { const opt = node('option', '', i.network + ' · ' + i.label); opt.value = i.id; channel.append(opt); }
      channel.value = p.preferred_identity || p.identities[0].id;
      const draft = node('textarea'); draft.placeholder = 'Write in English…'; draft.setAttribute('aria-label', 'Message'); draft.maxLength = 16384; draft.value = s.drafts[id] || ''; draft.oninput = () => { s.drafts[id] = draft.value; try { sessionStorage.setItem('messenger-unified-drafts', JSON.stringify(s.drafts)); } catch { error(new Error('Draft storage is unavailable. Keep this window open.')); } hold(); };
      const send = button('Preview send', () => form.requestSubmit(), 'primary');
      form.append(channel, draft, send); form.onsubmit = e => { e.preventDefault(); if (!draft.value.trim()) return; action(async () => {
        const preview = await call('people/' + id + '/preview', {text: draft.value, identity_id: channel.value});
        if (s.person !== id) return;
        const sheet = overlay('Review before sending');
        sheet.append(node('p', 'helper', p.identities.find(i => i.id === preview.identity_id).network + ' → ' + p.display_name), node('p', 'u-preview', preview.translated), node('p', 'u-original', preview.original));
        if (preview.error) sheet.append(node('p', 'error', preview.error));
        const confirm = original => action(async () => {
          const receipt = await call('people/' + id + '/send', {preview_id: preview.id, send_original: original});
          if (s.drafts[id] === preview.original) { s.drafts[id] = ''; sessionStorage.setItem('messenger-unified-drafts', JSON.stringify(s.drafts)); }
          closeOverlay(); await openPerson(id);
          if (receipt.state === 'queued') error(new Error('Queued in Messenger, not yet published. Use the Messenger tab to check or retry the existing event.'));
        });
        if (!preview.error) sheet.append(button('Confirm send', () => confirm(false), 'primary wide'));
        if (preview.error || preview.translated !== preview.original) sheet.append(button('Send English original instead', () => confirm(true), 'secondary wide'));
      }); };
      root.append(form); scroll.scrollTop = scroll.scrollHeight; hold();
    } catch (e) { error(e); }
  }
  function editPerson(p) {
    const sheet = overlay('Person & channels'); const form = node('form');
    const name = node('input'); name.value = p.display_name; name.maxLength = 160;
    const nameLabel = node('label', '', 'Name'); nameLabel.append(name);
    const lang = node('select'); for (const [value, label] of [['','No translation'],['th','Thai'],['en','English'],['ja','Japanese'],['zh','Chinese'],['es','Spanish'],['fr','French'],['de','German']]) { const o = node('option', '', label); o.value = value; lang.append(o); } lang.value = p.language;
    const langLabel = node('label', '', 'Their language'); langLabel.append(lang);
    const preferred = node('select'); const auto = node('option', '', 'Reply on their last-used channel'); auto.value = ''; preferred.append(auto);
    for (const i of p.identities) { const o = node('option', '', i.network + ' · ' + i.label); o.value = i.id; preferred.append(o); } preferred.value = p.preferred_identity || '';
    const preferredLabel = node('label', '', 'Default reply channel'); preferredLabel.append(preferred);
    form.append(nameLabel, langLabel, preferredLabel, button('Save', () => form.requestSubmit(), 'primary wide'));
    form.onsubmit = e => { e.preventDefault(); action(async () => { await call('people/' + p.id, {display_name: name.value, language: lang.value, preferred_identity: preferred.value}); closeOverlay(); await openPerson(p.id); }); }; sheet.append(form);
    if (p.identities.every(i => i.kind === 'person')) {
      const others = s.people.filter(x => x.id !== p.id);
      if (others.length) {
        const select = node('select'); select.setAttribute('aria-label', 'Merge another person'); for (const x of others) { const o = node('option', '', x.display_name); o.value = x.id; select.append(o); }
        sheet.append(select, button('Merge selected person', () => action(async () => { await call('people/' + p.id + '/merge', {source_id: select.value}); closeOverlay(); await openPerson(p.id); }), 'secondary wide'));
      }
      if (p.identities.length > 1) for (const i of p.identities) sheet.append(button('Separate ' + i.network + ' · ' + i.label, () => action(async () => { await call('people/' + p.id + '/unmerge', {identity_id: i.id}); closeOverlay(); await openPerson(p.id); }), 'secondary wide'));
    } else {
      const labels = node('input'); labels.placeholder = 'Family, Friends'; labels.setAttribute('aria-label', 'Group labels');
      sheet.append(labels, button('Set labels (comma-separated)', () => action(async () => { await call('groups/' + p.identities[0].id + '/labels', {labels: labels.value.split(',').map(x => x.trim()).filter(Boolean)}); closeOverlay(); }), 'secondary wide'));
    }
  }
  async function accounts() {
    const sheet = overlay('Connected accounts'); sheet.append(node('h3', '', 'Telegram'));
    try {
      const status = await call('telegram/status'); if (s.overlay !== 'Connected accounts') return;
      sheet.append(node('p', 'helper', status.message + (status.state === 'disconnected' ? ' · Not connected' : '')));
      if (status.state === 'not_configured') sheet.append(node('p', 'helper', 'Add TELEGRAM_API_ID and TELEGRAM_API_HASH in the app’s installation settings. Your phone number and login code stay inside this private Messenger.'));
      for (const [flow, label] of [['qr','Connect with QR'],['phone','Connect with phone']]) { const b = button(label, () => action(async () => loginStep(await call('telegram/start', {flow}))), 'primary wide'); b.disabled = status.state === 'not_configured' || status.state === 'unavailable'; sheet.append(b); }
      if (status.logins?.length) sheet.append(button('Disconnect Telegram', () => action(async () => { await call('telegram/disconnect', {}); await accounts(); }), 'secondary wide'));
    } catch (e) { error(e); }
  }
  function loginStep(result) {
    // bridgev2 embeds the LoginStep fields alongside login_id.
    s.login = null; const sheet = overlay('Connect Telegram'); s.login = result;
    const step = result.step || result; sheet.append(node('p', 'helper', step.instructions || 'Continue on Telegram'));
    const advance = fields => action(async () => {
      const current = s.login;
      const next = await call('telegram/step', {login_id: result.login_id, step_id: step.step_id, type: step.type, fields});
      if (s.login === current) { s.login = null; loginStep(next); }
    });
    if (step.type === 'user_input') {
      const form = node('form'); form.autocomplete = 'off'; const inputs = {};
      for (const field of step.user_input.fields) {
        const label = node('label', '', field.name); const input = node('input'); input.type = /password/.test(field.type) ? 'password' : /phone/.test(field.type) ? 'tel' : 'text'; input.required = !field.optional; input.autocomplete = /password/.test(field.type) ? 'current-password' : /code/.test(field.type) ? 'one-time-code' : 'off'; label.append(input); form.append(label); inputs[field.id] = input;
      }
      form.append(button('Continue', () => form.requestSubmit(), 'primary wide')); form.onsubmit = e => { e.preventDefault(); const fields = Object.fromEntries(Object.entries(inputs).map(([id, input]) => [id, input.value])); for (const input of Object.values(inputs)) input.value = ''; advance(fields); }; sheet.append(form);
    } else if (step.type === 'display_and_wait') {
      const display = step.display_and_wait;
      if (display.type === 'qr' && window.qrcode) {
        const qr = window.qrcode(0, 'M'); qr.addData(display.data); qr.make();
        const canvas = node('canvas', 'u-qr'); const count = qr.getModuleCount(), scale = 6; canvas.width = canvas.height = (count + 8) * scale;
        const ctx = canvas.getContext('2d'); ctx.fillStyle = '#fff'; ctx.fillRect(0, 0, canvas.width, canvas.height); ctx.fillStyle = '#000';
        for (let y=0;y<count;y++) for (let x=0;x<count;x++) if (qr.isDark(y,x)) ctx.fillRect((x+4)*scale,(y+4)*scale,scale,scale); sheet.append(canvas);
      } else sheet.append(node('p', 'u-preview', display.data || 'Waiting for Telegram approval'));
      sheet.append(button('I scanned it · Continue', () => advance({}), 'primary wide'));
    } else if (step.type === 'complete') { s.login = null; sheet.append(node('p', '', 'Telegram connected.'), button('Done', () => { closeOverlay(); refresh(); }, 'primary wide')); }
    else sheet.append(node('p', 'error', 'This Telegram login step is not supported by this preview. Cancel and try the phone flow.'));
  }
  function switchTab(tab) { if (s.overlay) closeOverlay(); s.tab = tab; s.person = null; s.epoch++; document.documentElement.dataset.inboxTab = tab; $('unified-inbox').hidden = tab === 'messenger'; for (const el of $('inbox-tabs').querySelectorAll('[data-tab]')) el.setAttribute('aria-selected', String(el.dataset.tab === tab)); if (tab !== 'messenger') renderList(); }
  async function refresh() {
    if (!s.ready || document.hidden || s.busy || s.overlay) return;
    try { const result = await call('sync', {}); if (!s.person && s.tab !== 'messenger') await renderList(true); else if (s.person && !s.overlay) { const id = s.person, epoch = s.epoch; const timeline = await call('people/' + id); const scroll = $('unified-inbox').querySelector('.u-timeline'); if (scroll && s.person === id && s.epoch === epoch && !s.overlay) paintMessages(scroll, timeline.messages); } if (result.error) error(new Error(result.error)); } catch (e) { error(e); }
  }
  window.MessengerUnified = {
    mount(options) { api = options.api; try { s.drafts = JSON.parse(sessionStorage.getItem('messenger-unified-drafts') || '{}'); } catch { s.drafts = {}; } for (const el of $('inbox-tabs').querySelectorAll('[data-tab]')) el.onclick = () => switchTab(el.dataset.tab); $('connected-accounts').onclick = accounts; },
    authenticated() { if (s.ready) return; s.ready = true; $('inbox-tabs').hidden = false; switchTab('people'); refresh(); timer = setInterval(refresh, 15000); },
    active: () => s.ready && (s.tab !== 'messenger' || !!s.overlay), canGoBack: () => !!(s.overlay || s.person), back,
    signout() { clearInterval(timer); closeOverlay(); s.ready = false; s.epoch++; $('inbox-tabs').hidden = true; $('unified-inbox').hidden = true; $('unified-inbox').replaceChildren(); delete document.documentElement.dataset.inboxTab; }
  };
})();
