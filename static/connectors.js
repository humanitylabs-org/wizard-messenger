/* Owner-only bridgev2 account linking. Mount in an authenticated owner sheet.
 * Existing api() must enforce session+CSRF and return decoded JSON; never
 * expose this controller through agent tools or save provisioning QR data.
 */
(function (global) {
  'use strict';
  // Brand colour + short mark per network (text only; no remote logos).
  const BRAND = {
    whatsapp: {color: '#128c7e', mark: 'W'}, telegram: {color: '#2aabee', mark: 'T'}, slack: {color: '#611f69', mark: 'S'},
    line: {color: '#06c755', mark: 'L'}, instagram: {color: '#e1306c', mark: 'IG'}, signal: {color: '#3a76f0', mark: 'Si'},
    kakaotalk: {color: '#c9a800', mark: 'K'}, messenger: {color: '#2c6bed', mark: 'M'},
  };
  // What linking does for each network, in one line.
  const ABOUT = {
    whatsapp: 'Links like WhatsApp Web. Your phone stays the main device.',
    telegram: 'Links as a new Telegram device.',
    slack: 'Signs in with your work email. Slack emails you a code.',
    line: 'Links as a LINE desktop device. LINE may show a PIN to confirm.',
    instagram: 'Signs in for your Instagram DMs. Instagram may ask you to approve the new login.',
    signal: 'Links as a Signal linked device.',
  };
  // Where the owner scans on the phone.
  const SCAN = {
    whatsapp: ['Open WhatsApp on your phone', 'Tap Settings (iPhone) or ⋮ (Android) → Linked devices', 'Tap Link a device and point your camera here'],
    telegram: ['Open Telegram on your phone', 'Go to Settings → Devices', 'Tap Link Desktop Device and point your camera here'],
    line: ['Open LINE on your phone', 'Tap the QR scanner on the Home tab', 'Scan this code, then confirm on your phone'],
    signal: ['Open Signal on your phone', 'Go to Settings → Linked devices', 'Tap + and point your camera here'],
  };
  const FLOW_LABEL = {
    qr: 'Show QR code', phone: 'Use a pairing code instead', email: 'Sign in with email',
    'dev.highest.matrix.line.qr_login': 'Show QR code', 'dev.highest.matrix.line.email_login': 'Sign in with email & password',
    android: 'Sign in with username & password', 'instagram-password': 'Try the web sign-in instead',
  };
  const STATE = {
    connected: ['Connected', 'on'], disconnected: ['Not connected', 'off'], degraded: ['Needs reconnecting', 'warn'],
    not_configured: ['Needs one-time setup', 'off'], unavailable: ['Bridge offline', 'warn'], unsupported: ['Not available yet', 'off'],
  };
  const isQR = flow => /(^|[._])qr($|[._])/.test(flow.id);
  const SECRET = /password|pass|code|otp|token|cookie|secret|2fa/i;

  global.MessengerConnectors = function (root, api, options = {}) {
    let generation = 0, active = null, providers = [];
    const element = (tag, cls, text) => { const n = document.createElement(tag); if (cls) n.className = cls; if (text != null) n.textContent = text; return n; };
    const request = (network, action, body) => api('/api/unified/connectors/' + network + '/' + action, body === undefined ? 'GET' : 'POST', body);
    const label = network => (providers.find(p => p.network === network) || {}).label || network;
    function mark(network, cls = '') {
      const b = BRAND[network] || {color: '#555', mark: (network[0] || '?').toUpperCase()};
      const m = element('span', 'c-mark' + (cls ? ' ' + cls : ''), b.mark); m.style.background = b.color; m.setAttribute('aria-hidden', 'true'); return m;
    }
    function problem(e, where = root) {
      for (const old of where.children) if (old.className === 'error c-problem') old.remove();
      const p = element('p', 'error c-problem', (e && e.message) || 'Private bridge unavailable'); p.setAttribute('role', 'alert'); where.append(p);
    }
    function button(parent, text, run, cls = 'secondary wide') {
      const b = element('button', cls, text); b.type = 'button'; parent.append(b);
      b.onclick = async () => { b.disabled = true; try { await run(); } catch (e) { if (root.contains(b)) problem(e); } finally { b.disabled = false; } };
      return b;
    }
    function qrCanvas(data) {
      if (typeof global.qrcode !== 'function') throw new Error('QR renderer unavailable');
      const qr = global.qrcode(0, 'M'); qr.addData(data); qr.make();
      // Render QR modules directly; never insert upstream HTML or open a QR URI.
      const n = qr.getModuleCount(), scale = 8, canvas = element('canvas', 'c-qr'); canvas.width = canvas.height = (n + 8) * scale;
      const ctx = canvas.getContext('2d'); ctx.fillStyle = '#fff'; ctx.fillRect(0, 0, canvas.width, canvas.height); ctx.fillStyle = '#000';
      for (let r = 0; r < n; r++) for (let c = 0; c < n; c++) if (qr.isDark(r, c)) ctx.fillRect((c + 4) * scale, (r + 4) * scale, scale, scale);
      canvas.setAttribute('role', 'img'); canvas.setAttribute('aria-label', 'Login QR code. Scan it with the app on your phone.');
      return canvas;
    }
    function heading(network, title) {
      const head = element('div', 'c-step-head'); head.append(mark(network, 'big'), element('h3', '', title || 'Connect ' + label(network))); return head;
    }
    async function cancel() {
      const old = active; active = null; const mine = ++generation;
      if (old) {
        try { await request(old.network, 'cancel', {login_id: old.login_id}); }
        catch (e) {
          // Already-ended logins need no cleanup; other failures must be visible.
          if (!['login_expired', 'invalid_step', 'login_cancelled'].includes(e.code)) {
            if (mine === generation) active = old;
            throw e;
          }
        }
      }
    }
    async function start(network, flow) {
      const mine = generation + 1;
      await cancel(); if (mine !== generation) return;
      root.replaceChildren(heading(network), element('p', 'helper', 'Starting…'));
      try {
        const result = await request(network, 'start', {flow});
        if (mine !== generation) {
          // Close may happen before start returns a process ID. Cancel that exact
          // orphan, never the newer controller's login.
          if (result.login_id && result.type !== 'complete') await request(network, 'cancel', {login_id: result.login_id});
          return;
        }
        await step(network, flow, result, mine);
      } catch (e) { if (mine !== generation) return; failure(e, network, flow, mine); }
    }
    function failure(error, network, flow, mine) {
      if (mine !== generation) return;
      problem(error);
      button(root, 'Start again', async () => start(network, flow), 'primary wide');
      button(root, 'Back to accounts', async () => show());
    }
    async function advance(network, payload, fields, mine) {
      let result = await request(network, 'step', {...payload, fields});
      while (result.type === 'pending' && mine === generation) {
        await new Promise(resolve => global.setTimeout(resolve, 1000));
        if (mine !== generation) return null;
        // Poll the local worker. Never replay passwords or email/MFA codes.
        result = await request(network, 'step', {...payload, fields: {}});
      }
      return result;
    }
    async function step(network, flow, result, mine) {
      if (mine !== generation || !result) return;
      if (result.type === 'complete') {
        active = null;
        root.replaceChildren(heading(network, label(network) + ' connected'),
          element('p', 'helper', 'Your chats appear in the Inbox over the next few minutes. Older history fills in gradually.'));
        button(root, 'Done', async () => show(), 'primary wide');
        options.onChange?.(network);
        return;
      }
      active = {network, login_id: result.login_id};
      const payload = () => ({login_id: result.login_id, step_id: result.step_id, type: result.type, txn_id: result.txn_id});
      root.replaceChildren(heading(network));
      const back = () => button(root, 'Cancel', async () => {
        const nextGeneration = generation + 1;
        await cancel(); if (nextGeneration === generation) await show();
      });
      if (result.type === 'display_and_wait') {
        const params = result.display_and_wait || {};
        if (params.type === 'qr') {
          const steps = SCAN[network];
          if (steps) { const ol = element('ol', 'c-howto'); for (const s of steps) ol.append(element('li', '', s)); root.append(ol); }
          else if (result.instructions) root.append(element('p', 'helper', result.instructions));
          const frame = element('div', 'c-qr-frame'); frame.append(qrCanvas(params.data)); root.append(frame);
        } else if (params.type === 'code' || params.type === 'emoji') {
          root.append(element('p', 'helper', result.instructions || 'Enter this code on your phone.'), element('p', 'c-code', params.data));
        } else if (params.type === 'nothing') {
          root.append(element('p', 'helper', result.instructions || 'Approve the login in the app on your phone.'));
        } else throw new Error('Unsupported login display type');
        const wait = element('p', 'c-waiting'); wait.append(element('span', 'spinner'), element('span', '', 'Waiting for your phone…'));
        root.append(wait); back();
        // The bridge answers once the phone acts, or with a refreshed code, so wait while this owner
        // screen is open. Closing the sheet bumps the generation and cancels the login.
        let next;
        try { next = await advance(network, payload(), {}, mine); }
        catch (e) {
          if (mine !== generation) return;
          wait.replaceChildren(element('span', '', 'Login has stopped waiting.'));
          failure(e, network, flow, mine);
          return;
        }
        await step(network, flow, next, mine);
      } else if (result.type === 'challenge') {
        root.append(element('p', 'helper', label(network) + ' requires browser verification (such as a CAPTCHA or checkpoint). This view cannot safely complete it. Finish verification in the official app or website, then start a new login. Completing it elsewhere may not resume this bridge session.'));
        button(root, 'Start again', async () => start(network, flow), 'primary wide'); back();
      } else if (result.type === 'user_input') {
        if (result.instructions) root.append(element('p', 'helper', result.instructions));
        const form = element('form', 'c-form'), inputs = {}; form.autocomplete = 'off';
        for (const field of (result.user_input || {}).fields || []) {
          const wrap = element('label', '', field.name || field.id);
          const input = element(field.type === 'select' ? 'select' : 'input'); input.name = field.id;
          if (field.type === 'select') for (const value of field.options || []) { const option = element('option', '', value); option.value = value; input.append(option); }
          else {
            // Passwords, codes and tokens stay masked; emails, usernames and phone numbers stay readable.
            const kind = (field.type || '') + ' ' + (field.id || '');
            input.type = SECRET.test(kind) ? 'password' : /phone/.test(kind) ? 'tel' : /email/.test(kind) ? 'email' : 'text';
            input.autocapitalize = 'none'; input.spellcheck = false;
            if (field.description) input.placeholder = field.description;
          }
          input.autocomplete = 'off'; input.required = !field.optional;
          if (field.default_value != null && !SECRET.test((field.type || '') + ' ' + field.id)) input.value = field.default_value;
          if (field.min_length) input.minLength = field.min_length;
          if (field.max_length) input.maxLength = field.max_length;
          wrap.append(input); form.append(wrap); inputs[field.id] = input;
        }
        const submit = element('button', 'primary wide', 'Continue'); submit.type = 'submit'; form.append(submit); root.append(form); back();
        global.requestAnimationFrame?.(() => Object.values(inputs)[0]?.focus?.());
        form.onsubmit = async e => {
          e.preventDefault(); if (submit.disabled || mine !== generation) return; submit.disabled = true;
          submit.textContent = 'Waiting for bridge…';
          const fields = Object.fromEntries(Object.entries(inputs).map(([k, v]) => [k, v.value]));
          for (const input of Object.values(inputs)) input.value = '';
          try { await step(network, flow, await advance(network, payload(), fields, mine), mine); }
          catch (err) {
            if (mine !== generation) return;
            // A returned user_input step is the upstream's recoverable retry.
            // A thrown error is fatal/ambiguous: never resubmit stale credentials.
            failure(err, network, flow, mine);
          } finally { for (const key of Object.keys(fields)) delete fields[key]; }
        };
      } else throw new Error('Unsupported login step');
    }
    async function setupTelegram() {
      const mine = generation + 1;
      await cancel(); if (mine !== generation) return;
      root.replaceChildren(heading('telegram', 'Set up Telegram'));
      root.append(element('p', 'helper', 'Add your Telegram application keys once. Then connect your account by scanning a QR code with Telegram on your phone. These are app keys, not your Telegram login code.'));
      const link = element('a', '', 'Get application keys at my.telegram.org/apps');
      link.href = 'https://my.telegram.org/apps'; link.target = '_blank'; link.rel = 'noopener noreferrer'; root.append(link);
      const form = element('form', 'c-form'); form.autocomplete = 'off';
      const idLabel = element('label', '', 'API ID'), id = element('input');
      id.name = 'api_id'; id.type = 'text'; id.inputMode = 'numeric'; id.required = true; id.autocomplete = 'off'; idLabel.append(id);
      const hashLabel = element('label', '', 'API hash'), hash = element('input');
      hash.name = 'api_hash'; hash.type = 'password'; hash.required = true; hash.autocomplete = 'off'; hashLabel.append(hash);
      const save = element('button', 'primary wide', 'Save application keys'); save.type = 'submit'; form.append(idLabel, hashLabel, save); root.append(form);
      button(root, 'Back to accounts', async () => show());
      form.onsubmit = async e => {
        e.preventDefault(); if (save.disabled || mine !== generation) return;
        save.disabled = true;
        const payload = {api_id: id.value, api_hash: hash.value}; hash.value = '';
        try {
          const result = await api('/api/view/telegram/application', 'POST', payload);
          if (mine !== generation) return;
          if (result.configured !== true) throw new Error('Telegram application setup did not complete. Try again.');
          root.replaceChildren(heading('telegram', 'Telegram application configured'), element('p', 'helper', 'Telegram is warming up. Wait a moment, then refresh accounts. When the QR option appears, click it to connect your phone.'));
          button(root, 'Refresh accounts', async () => show(), 'primary wide');
        } catch (_) {
          // Setup errors must not reflect the submitted hash or other server text.
          if (mine === generation) problem(new Error('Could not save Telegram application keys. Check the API ID and hash from my.telegram.org/apps, then try again.'), form);
        } finally { payload.api_hash = ''; save.disabled = false; }
      };
    }
    function card(provider) {
      const [stateText, tone] = STATE[provider.state] || [provider.state, 'off'];
      const section = element('section', 'c-card ' + tone); section.dataset.network = provider.network;
      const top = element('div', 'c-card-top'); top.append(mark(provider.network));
      const text = element('div', 'c-card-text'); text.append(element('strong', '', provider.label), element('span', 'c-pill ' + tone, stateText));
      top.append(text); section.append(top);
      const flows = provider.flows || [];
      if (provider.state === 'connected') {
        const who = (provider.logins || []).map(l => l.name).filter(Boolean).join(', ');
        if (who) section.append(element('p', 'helper', who));
        button(section, 'Disconnect', async () => {
          if (global.confirm && !global.confirm('Disconnect ' + provider.label + '? Its chats leave this Messenger. Nothing changes on ' + provider.label + ' itself.')) return;
          await request(provider.network, 'disconnect', {}); await show(); options.onChange?.(provider.network);
        }, 'c-link danger').setAttribute('aria-label', 'Disconnect ' + provider.label);
        return section;
      }
      if (ABOUT[provider.network] && flows.length) section.append(element('p', 'helper', ABOUT[provider.network]));
      if (provider.state === 'not_configured' && provider.network === 'telegram') {
        section.append(element('p', 'helper', 'Add Telegram application keys once, then scan a QR code with your phone.'));
        button(section, 'Set up Telegram', setupTelegram, 'primary wide');
      }
      else if (provider.state === 'unavailable') section.append(element('p', 'helper', 'The private bridge is not responding. Try again in a minute.'));
      [...flows].sort((a, b) => isQR(b) - isQR(a)).forEach((flow, i) => {
        const name = FLOW_LABEL[flow.id] || flow.name;
        button(section, name, async () => start(provider.network, flow.id), i === 0 ? 'primary wide' : 'c-link').setAttribute('aria-label', name + ' for ' + provider.label);
      });
      return section;
    }
    async function show({focus} = {}) {
      const mine = generation + 1;
      await cancel(); if (mine !== generation) return;
      const data = await api('/api/unified/connectors', 'GET'); if (mine !== generation) return;
      providers = data.providers || [];
      // Signal and KakaoTalk are optional on this Wizard; they fold away until set up.
      const usable = providers.filter(p => p.network === 'telegram' || (p.supported && p.state !== 'not_configured'));
      const later = providers.filter(p => !usable.includes(p));
      const connected = usable.filter(p => p.state === 'connected');
      root.replaceChildren(element('p', 'c-summary', connected.length ? connected.length + ' of ' + usable.length + ' accounts connected' : 'Connect an account to bring its chats into your Inbox'));
      const order = p => p.state === 'connected' ? 2 : p.state === 'not_configured' ? 1 : 0;
      for (const provider of [...usable].sort((a, b) => order(a) - order(b))) root.append(card(provider));
      if (later.length) {
        const more = element('details', 'c-later'); more.append(element('summary', '', 'More networks'));
        for (const p of later) { const row = element('p', 'c-later-row'); row.append(mark(p.network, 'small'), element('span', '', p.label + ' · ' + (STATE[p.state] || [p.state])[0])); more.append(row); }
        root.append(more);
      }
      if (focus) root.querySelector('[data-network="' + focus + '"] .primary')?.focus();
      return providers;
    }
    return {show, start, close: async () => { root.replaceChildren(); await cancel(); }};
  };
  global.MessengerConnectors.BRAND = BRAND;
})(window);
