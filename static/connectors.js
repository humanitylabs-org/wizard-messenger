/* Owner-only bridgev2 account linking. Mount in an authenticated owner sheet.
 * Existing api() must enforce session+CSRF and return decoded JSON; never
 * expose this controller through agent tools or save provisioning QR data.
 */
(function (global) {
  'use strict';
  const ABOUT = {
    whatsapp: 'Links like WhatsApp Web. Your phone stays the main device.',
    telegram: 'Links as a new Telegram device.',
    signal: 'Links as a Signal linked device.',
  };
  const SCAN = {
    whatsapp: ['Open WhatsApp on your phone', 'Settings → Linked devices → Link a device'],
    telegram: ['Open Telegram on your phone', 'Settings → Devices → Link Desktop Device'],
    signal: ['Open Signal on your phone', 'Settings → Linked devices → +'],
  };
  const TELEGRAM_LABEL = {qr: 'Connect with QR', failure: 'Telegram did not accept that. Try again.'};
  const FLOW_LABEL = {qr: 'Show QR code', phone: 'Connect with phone'};
  const STATE = {
    connected: ['Connected', 'on'], disconnected: ['Not connected', 'off'], degraded: ['Needs reconnecting', 'warn'],
    not_configured: ['Needs one-time setup', 'off'], unavailable: ['Bridge offline', 'warn'], unsupported: ['Not available yet', 'off'],
  };
  const isQR = flow => /(^|[._])qr($|[._])/.test(flow.id);
  const SECRET = /password|pass|code|otp|token|cookie|secret|2fa/i;

  function qrCanvas(data) {
      if (typeof global.qrcode !== 'function') throw new Error('QR renderer unavailable');
      const qr = global.qrcode(0, 'M'); qr.addData(data); qr.make();
      // Render QR modules directly; never insert upstream HTML or open a QR URI.
      const n = qr.getModuleCount(), scale = 8, canvas = document.createElement('canvas'); canvas.width = canvas.height = (n + 8) * scale;
      const ctx = canvas.getContext('2d'); ctx.fillStyle = '#fff'; ctx.fillRect(0, 0, canvas.width, canvas.height); ctx.fillStyle = '#000';
      for (let r = 0; r < n; r++) for (let c = 0; c < n; c++) if (qr.isDark(r, c)) ctx.fillRect((c + 4) * scale, (r + 4) * scale, scale, scale);
      canvas.className = 'u-qr';
      canvas.setAttribute('role', 'img'); canvas.setAttribute('aria-label', 'Login QR code. Scan it with the app on your phone.');
      return canvas;
    }

  global.MessengerConnectors = function (root, api, options = {}) {
    let generation = 0, active = null, providers = [];
    const element = (tag, cls, text) => { const n = document.createElement(tag); if (cls) n.className = cls; if (text != null) n.textContent = text; return n; };
    const request = (network, action, body) => api('/api/unified/connectors/' + network + '/' + action, body === undefined ? 'GET' : 'POST', body);
    const label = network => (providers.find(p => p.network === network) || {}).label || network;
    function problem(e, where = root) {
      for (const old of where.children) if (old.className === 'error u-connector-problem') old.remove();
      const p = element('p', 'error u-connector-problem', (e && e.message) || 'Private bridge unavailable'); p.setAttribute('role', 'alert'); where.append(p);
    }
    function button(parent, text, run, cls = 'secondary wide') {
      const b = options.button ? options.button(text, null, cls) : element('button', cls, text); b.type = 'button'; parent.append(b);
      b.onclick = async () => { b.disabled = true; try { await run(); } catch (e) { if (root.contains(b)) problem(e); } finally { b.disabled = false; } };
      return b;
    }
    function heading(network, title) {
      const head = element('div', 'u-connector-heading'); head.append(element('h3', '', title || 'Connect ' + label(network))); return head;
    }
    async function cancel() {
      const old = active; active = null; const mine = ++generation;
      if (old) {
        options.onPending?.(old.network, false);
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
      if (network === 'telegram' && error.code === 'login_failed') error = new Error(TELEGRAM_LABEL.failure);
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
        options.onPending?.(network, false);
        root.replaceChildren(heading(network, label(network) + ' connected'),
          element('p', 'helper', 'Your chats appear in the Inbox over the next few minutes. Older history fills in gradually.'));
        button(root, 'Done', async () => { if (options.onDone) options.onDone(); else await show(); }, 'primary wide');
        options.onChange?.(network);
        return;
      }
      active = {network, login_id: result.login_id};
      options.onPending?.(network, true);
      const payload = () => ({login_id: result.login_id, step_id: result.step_id, type: result.type, txn_id: result.txn_id});
      root.replaceChildren(heading(network));
      const back = () => button(root, 'Cancel', async () => {
        const nextGeneration = generation + 1;
        await cancel(); if (nextGeneration === generation) { if (options.onCancel) options.onCancel(); else await show(); }
      });
      if (result.type === 'display_and_wait') {
        const params = result.display_and_wait || {};
        if (params.type === 'qr') {
          const steps = SCAN[network];
          if (steps) { const ol = element('ol', 'helper'); for (const s of steps) ol.append(element('li', '', s)); root.append(ol); }
          else if (result.instructions) root.append(element('p', 'helper', result.instructions));
          const frame = element('div', 'u-connector-qr'); frame.append(qrCanvas(params.data)); root.append(frame);
        } else if (params.type === 'code' || params.type === 'emoji') {
          root.append(element('p', 'helper', result.instructions || 'Enter this code on your phone.'), element('p', 'u-preview', params.data));
        } else if (params.type === 'nothing') {
          root.append(element('p', 'helper', result.instructions || 'Approve the login in the app on your phone.'));
        } else throw new Error('Unsupported login display type');
        const wait = element('p', 'helper'); wait.append(element('span', 'spinner'), element('span', '', 'Waiting for your phone…'));
        root.append(wait);
        if (network === 'telegram') button(root, 'I scanned it', async () => {
          const status = await request(network, 'status');
          if (mine !== generation) return;
          if (status.logins?.length) { active = null; await step(network, flow, {type: 'complete'}, ++generation); }
          else wait.textContent = 'Waiting for Telegram to confirm…';
        });
        if (params.type === 'qr') button(root, 'Refresh QR code', () => { start(network, flow); });
        back();
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
        const form = element('form', ''), inputs = {}; form.autocomplete = 'off';
        for (const field of (result.user_input || {}).fields || []) {
          if (network === 'telegram' && options.phoneField && (/phone/.test(field.type) || field.id === 'phone_number')) { inputs[field.id] = options.phoneField(form); continue; }
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
          for (const input of Object.values(inputs)) { if ('clear' in input) input.clear(); else input.value = ''; }
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
    function card(provider) {
      const [stateText, tone] = STATE[provider.state] || [provider.state, 'off'];
      const section = element('section', 'u-connector-card ' + tone); section.dataset.network = provider.network;
      const top = element('div', 'u-connector-top');
      const text = element('div', 'u-connector-text'); text.append(element('strong', '', provider.label), element('span', 'u-status ' + tone, stateText));
      top.append(text); section.append(top);
      const flows = provider.flows || [];
      if (provider.state === 'connected') {
        const who = (provider.logins || []).map(l => l.name).filter(Boolean).join(', ');
        if (who) section.append(element('p', 'helper', who));
        button(section, provider.network === 'telegram' ? 'Disconnect Telegram' : 'Disconnect', async () => {
          if (global.confirm && !global.confirm('Disconnect ' + provider.label + '? Its chats leave this Messenger. Nothing changes on ' + provider.label + ' itself.')) return;
          await request(provider.network, 'disconnect', {}); await show(); options.onChange?.(provider.network);
        }, 'secondary wide danger').setAttribute('aria-label', 'Disconnect ' + provider.label);
        return section;
      }
      if (ABOUT[provider.network] && flows.length) section.append(element('p', 'helper', ABOUT[provider.network]));
      if (provider.state === 'not_configured') {
        if (provider.network === 'telegram') section.append(element('p', 'helper', 'Add TELEGRAM_API_ID and TELEGRAM_API_HASH in the app’s installation settings.'));
        else button(section, 'Enable ' + provider.label, async () => {
          await request(provider.network, 'enable', {});
          section.replaceChildren(element('p', 'helper', 'Starting ' + provider.label + '…'));
          // Dormant workers start only after the owner enables this network.
          for (let attempt = 0; attempt < 30; attempt++) {
            await new Promise(resolve => global.setTimeout(resolve, 500));
            if (!root.contains(section)) return;
            const status = await request(provider.network, 'status');
            if (status.state !== 'unavailable') break;
          }
          await show();
        }, 'primary wide');
      }
      else if (provider.state === 'unavailable') section.append(element('p', 'helper', 'The private bridge is not responding. Try again in a minute.'));
      [...flows].sort((a, b) => isQR(b) - isQR(a)).forEach((flow, i) => {
        const name = FLOW_LABEL[flow.id] || flow.name;
        button(section, name, async () => start(provider.network, flow.id), i === 0 ? 'primary wide' : 'secondary wide').setAttribute('aria-label', name + ' for ' + provider.label);
      });
      return section;
    }
    async function show({focus} = {}) {
      const mine = generation + 1;
      await cancel(); if (mine !== generation) return;
      const data = await api('/api/unified/connectors', 'GET'); if (mine !== generation) return;
      providers = data.providers || [];
      root.replaceChildren(element('p', 'helper', 'Connect an account to bring its chats into your Inbox'));
      for (const provider of providers) root.append(card(provider));
      const resumed = providers.find(p => p.pending_login);
      if (resumed) step(resumed.network, 'phone', resumed.pending_login, mine);
      if (focus) root.querySelector('[data-network="' + focus + '"] .primary')?.focus();
      return providers;
    }
    return {show, start, close: async () => { root.replaceChildren(); await cancel(); }};
  };

})(window);
