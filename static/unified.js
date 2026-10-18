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
  // A letter outside the Latin script (Thai, Cyrillic, CJK…) offers Translate; English never does.
  const foreignScript = t => /(?![\p{Script=Latin}])\p{L}/u.test(t || '');
  const shown = {}; // message id -> 'translated' | 'original' for on-tap translation
  const node = (tag, cls, content) => { const el = document.createElement(tag); if (cls) el.className = cls; if (content != null) el.textContent = content; return el; };
  const button = (label, fn, cls = 'secondary') => { const el = node('button', cls, label); el.type = 'button'; el.onclick = fn; return el; };
  const call = (path, body) => api('api/unified/' + path, body === undefined ? {} : {method: 'POST', body});
  const error = e => { const el = $('u-error'); if (el) el.textContent = e.message || 'Request failed. Please try again.'; };
  async function action(fn) { if (s.busy) return; s.busy = true; try { await fn(); } catch (e) { error(e); } finally { s.busy = false; } }
  function hold() { const pending = Object.values(s.drafts).some(Boolean) || !!s.overlay || s.busy; if (pending && !updateHold) updateHold = window.WizardApp.update.hold('Unified inbox unsent work'); else if (!pending && updateHold) { updateHold.release(); updateHold = null; } }
  function closeOverlay() {
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
  function paintMessages(scroll, messages, auto = false) {
    const signature = JSON.stringify([auto, messages.map(m => [m.id, m.translated, m.translation_error, shown[m.id]])]);
    if (scroll.dataset.signature === signature) return;
    const follow = scroll.scrollHeight - scroll.scrollTop - scroll.clientHeight < 64;
    const top = scroll.scrollTop;
    scroll.replaceChildren(); scroll.dataset.signature = signature;
    for (const m of messages) {
      const bubble = node('article', 'u-message' + (m.outgoing ? ' outgoing' : ''));
      if (auto || m.outgoing) {
        bubble.append(node('p', '', m.translated || m.original));
        if (m.translated && m.translated !== m.original) bubble.append(node('p', 'u-original', m.original));
        if (m.translation_error) bubble.append(node('p', 'u-original error', m.translation_error));
      } else {
        const translated = shown[m.id] === 'translated' && m.translated;
        bubble.append(node('p', '', translated ? m.translated : m.original));
        if (foreignScript(m.original)) {
          const toggle = button(translated ? 'Show original' : 'Translate', () => action(async () => {
            if (!translated && !m.translated) {
              const r = await call('messages/' + encodeURIComponent(m.id) + '/translate', {});
              if (r.error) throw new Error(r.error);
              m.translated = r.translated;
            }
            shown[m.id] = translated ? 'original' : 'translated'; paintMessages(scroll, messages, auto);
          }), 'u-translate link');
          bubble.append(toggle);
        }
      }
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
      paintMessages(scroll, result.messages, !!p.language && p.language !== 'en');
      root.append(scroll);
      const form = node('form', 'u-composer');
      const channel = node('select'); channel.setAttribute('aria-label', 'Send using channel');
      for (const i of p.identities) { const opt = node('option', '', i.network + ' · ' + i.label); opt.value = i.id; channel.append(opt); }
      channel.value = p.preferred_identity || p.identities[0].id;
      const draft = node('textarea'); draft.placeholder = 'Write in English…'; draft.setAttribute('aria-label', 'Message'); draft.maxLength = 16384; draft.value = s.drafts[id] || ''; draft.oninput = () => { s.drafts[id] = draft.value; try { sessionStorage.setItem('messenger-unified-drafts', JSON.stringify(s.drafts)); } catch { error(new Error('Draft storage is unavailable. Keep this window open.')); } hold(); };
      const reviewed = !!p.language && p.language !== 'en';
      const send = button(reviewed ? 'Preview send' : 'Send', () => form.requestSubmit(), 'primary');
      form.append(channel, draft, send); form.onsubmit = e => { e.preventDefault(); if (!draft.value.trim()) return; action(async () => {
        const preview = await call('people/' + id + '/preview', {text: draft.value, identity_id: channel.value});
        if (s.person !== id) return;
        if (!reviewed && !preview.error && preview.translated === preview.original) {
          // Plain English chat: no review sheet, the preview is only the server's send receipt.
          const receipt = await call('people/' + id + '/send', {preview_id: preview.id, send_original: false});
          if (s.drafts[id] === preview.original) { s.drafts[id] = ''; sessionStorage.setItem('messenger-unified-drafts', JSON.stringify(s.drafts)); }
          await openPerson(id);
          if (receipt.state === 'queued') error(new Error('Queued in Messenger, not yet published. Use the Messenger tab to check or retry the existing event.'));
          return;
        }
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
    const lang = node('select'); for (const [value, label] of [['','Off'],['th','Thai'],['en','English'],['ja','Japanese'],['zh','Chinese'],['es','Spanish'],['fr','French'],['de','German']]) { const o = node('option', '', label); o.value = value; lang.append(o); } lang.value = p.language;
    const langLabel = node('label', '', 'Auto-translate (optional)'); langLabel.append(lang);
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
      if (status.pending_login) { localStorage.setItem(LOGIN_FLAG, '1'); return loginStep(status.pending_login, true); }
      sheet.append(node('p', 'helper', status.message + (status.state === 'disconnected' ? ' · Not connected' : '')));
      if (status.state === 'not_configured') sheet.append(node('p', 'helper', 'Add TELEGRAM_API_ID and TELEGRAM_API_HASH in the app’s installation settings. Your phone number and login code stay inside this private Messenger.'));
      for (const [flow, label] of [['qr','Connect with QR'],['phone','Connect with phone']]) { const b = button(label, () => action(async () => loginStep(await call('telegram/start', {flow}))), 'primary wide'); b.disabled = status.state === 'not_configured' || status.state === 'unavailable'; sheet.append(b); }
      if (status.logins?.length) sheet.append(button('Disconnect Telegram', () => action(async () => { await call('telegram/disconnect', {}); await accounts(); }), 'secondary wide'));
    } catch (e) { error(e); }
    agentAccess(sheet);
  }
  async function agentAccess(sheet) {
    const box = node('section', 'u-agent-access'); sheet.append(box);
    const paint = st => {
      box.replaceChildren(node('h3', '', 'Agent access'));
      box.append(node('p', 'helper', st.enabled
        ? 'Agents can read and send your messages until ' + new Date(st.until).toLocaleTimeString([], {hour: '2-digit', minute: '2-digit'}) + '.'
        : 'Off. Agents can see Messenger status only, never your messages.'));
      const set = minutes => action(async () => paint(await api('api/view/agent-access', {method: 'POST', body: {minutes}})));
      if (st.enabled) box.append(button('Turn off now', () => set(0), 'primary wide'));
      else box.append(button('Allow for 1 hour', () => set(60), 'secondary wide'), button('Allow for 24 hours', () => set(1440), 'secondary wide'));
      if (st.log.length) {
        const list = node('ul', 'u-access-log');
        for (const e of st.log.slice(0, 20)) list.append(node('li', e.outcome === 'blocked' ? 'blocked' : '', new Date(e.t).toLocaleString([], {month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit'}) + ' · ' + e.outcome + ' · ' + e.method + ' ' + e.route));
        box.append(node('p', 'helper', 'Recent agent requests'), list);
      }
    };
    try { const st = await api('api/view/agent-access'); if (s.overlay === 'Connected accounts') paint(st); } catch (e) { error(e); }
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
      sheet.append(problem, button('I scanned it · Continue', () => advance({}), 'primary wide'));
    } else if (step.type === 'complete') { s.login = null; sheet.append(node('p', '', 'Telegram connected. Your chats will appear under People and Groups shortly.'), button('Done', () => { closeOverlay(); refresh(); }, 'primary wide')); return; }
    else sheet.append(node('p', 'error', 'This Telegram login step is not supported yet. Cancel and try again.'));
    sheet.append(button('Cancel login', () => action(async () => {
      localStorage.removeItem(LOGIN_FLAG);
      await call('telegram/cancel', {login_id: result.login_id}).catch(() => {});
      closeOverlay();
    }), 'secondary wide'));
  }
  function switchTab(tab) { if (s.overlay) closeOverlay(); s.tab = tab; s.person = null; s.epoch++; document.documentElement.dataset.inboxTab = tab; $('unified-inbox').hidden = tab === 'messenger'; for (const el of $('inbox-tabs').querySelectorAll('[data-tab]')) el.setAttribute('aria-selected', String(el.dataset.tab === tab)); if (tab !== 'messenger') renderList(); }
  async function refresh() {
    if (!s.ready || document.hidden || s.busy || s.overlay) return;
    try { const result = await call('sync', {}); if (!s.person && s.tab !== 'messenger') await renderList(true); else if (s.person && !s.overlay) { const id = s.person, epoch = s.epoch; const timeline = await call('people/' + id); const scroll = $('unified-inbox').querySelector('.u-timeline'); if (scroll && s.person === id && s.epoch === epoch && !s.overlay) paintMessages(scroll, timeline.messages); } if (result.error) error(new Error(result.error)); } catch (e) { error(e); }
  }
  document.addEventListener('visibilitychange', () => { if (!document.hidden) resumeLogin(); });
  window.MessengerUnified = {
    mount(options) { api = options.api; try { s.drafts = JSON.parse(sessionStorage.getItem('messenger-unified-drafts') || '{}'); } catch { s.drafts = {}; } for (const el of $('inbox-tabs').querySelectorAll('[data-tab]')) el.onclick = () => switchTab(el.dataset.tab); $('connected-accounts').onclick = accounts; },
    authenticated() { if (s.ready) return; s.ready = true; $('inbox-tabs').hidden = false; switchTab('people'); refresh(); timer = setInterval(refresh, 15000); resumeLogin(); },
    active: () => s.ready && (s.tab !== 'messenger' || !!s.overlay), canGoBack: () => !!(s.overlay || s.person), back,
    signout() { clearInterval(timer); closeOverlay(); s.ready = false; s.epoch++; $('inbox-tabs').hidden = true; $('unified-inbox').hidden = true; $('unified-inbox').replaceChildren(); delete document.documentElement.dataset.inboxTab; }
  };
})();
