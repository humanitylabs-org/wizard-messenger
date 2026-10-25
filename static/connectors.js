/* Owner-only bridgev2 UI. Mount in existing authenticated Settings sheet.
 * Existing api() must enforce session+CSRF and return decoded JSON; never
 * expose this controller through agent tools or save provisioning QR data.
 */
(function (global) {
  'use strict';
  global.MessengerConnectors = function (root, api) {
    let generation = 0, active = null;
    const element = (tag, text) => { const node = document.createElement(tag); if (text) node.textContent = text; return node; };
    const request = (network, action, body) => api('/api/unified/connectors/' + network + '/' + action, body === undefined ? 'GET' : 'POST', body);
    const error = e => { const p = element('p', e.message || 'Private bridge unavailable'); p.setAttribute('role', 'alert'); root.append(p); };
    function button(parent, label, run) {
      const b = element('button', label); b.type = 'button'; parent.append(b);
      b.onclick = async () => { b.disabled = true; try { await run(); } catch (e) { error(e); } finally { b.disabled = false; } };
    }
    async function step(network, result, mine) {
      if (mine !== generation) return;
      root.replaceChildren(element('h3', network), element('p', result.instructions || ''));
      if (result.type === 'complete') { active = null; await show(); return; }
      active = {network, login_id: result.login_id};
      const payload = () => ({login_id: result.login_id, step_id: result.step_id, type: result.type, txn_id: result.txn_id});
      button(root, 'Cancel', async () => { ++generation; await request(network, 'cancel', {login_id: result.login_id}); active = null; await show(); });
      if (result.type === 'display_and_wait') {
        const params = result.display_and_wait || {};
        if (params.type === 'qr') {
          if (typeof global.qrcode !== 'function') throw new Error('QR renderer unavailable');
          const qr = global.qrcode(0, 'M'); qr.addData(params.data); qr.make();
          // Render QR modules directly; never insert upstream HTML or open a QR URI.
          const n = qr.getModuleCount(), canvas = element('canvas'); canvas.width = canvas.height = (n + 8) * 5;
          const ctx = canvas.getContext('2d'); ctx.fillStyle = '#fff'; ctx.fillRect(0, 0, canvas.width, canvas.height); ctx.fillStyle = '#000';
          for (let r = 0; r < n; r++) for (let c = 0; c < n; c++) if (qr.isDark(r, c)) ctx.fillRect((c + 4) * 5, (r + 4) * 5, 5, 5);
          canvas.setAttribute('aria-label', 'Scan with the linked devices screen on your phone'); root.append(canvas);
        } else if (params.type === 'code' || params.type === 'emoji') root.append(element('pre', params.data));
        else if (params.type !== 'nothing') throw new Error('Unsupported login display type');
        // Explicit polling only while this owner screen is open.
        button(root, 'I scanned / entered the code — Continue', async () => step(network, await request(network, 'step', {...payload(), fields: {}}), mine));
      } else if (result.type === 'user_input') {
        const form = element('form'), inputs = {};
        for (const field of (result.user_input || {}).fields || []) {
          const label = element('label', field.name || field.id), input = element(field.type === 'select' ? 'select' : 'input'); input.name = field.id;
          if (field.type === 'select') for (const value of field.options || []) { const option = element('option', value); option.value = value; input.append(option); }
          // Mask all owner login fields, including email codes and MFA OTPs.
          if (field.type !== 'select') input.type = 'password'; input.autocomplete = 'off'; input.required = true;
          label.append(input); form.append(label); inputs[field.id] = input;
        }
        const submit = element('button', 'Continue'); submit.type = 'submit'; form.append(submit); root.append(form);
        form.onsubmit = async e => { e.preventDefault(); submit.disabled = true; const fields = Object.fromEntries(Object.entries(inputs).map(([k, v]) => [k, v.value]));
          for (const input of Object.values(inputs)) input.value = '';
          try { await step(network, await request(network, 'step', {...payload(), fields}), mine); } catch (e) { error(e); } finally { submit.disabled = false; }
        };
      } else throw new Error('Unsupported login step');
    }
    async function show() {
      const mine = ++generation; const data = await api('/api/unified/connectors', 'GET'); if (mine !== generation) return;
      root.replaceChildren(element('h3', 'Connected networks'));
      for (const provider of data.providers) {
        const section = element('section'); section.append(element('h4', provider.label), element('p', provider.state), element('p', provider.message)); root.append(section);
        for (const flow of provider.flows) button(section, 'Connect — ' + flow.name, async () => step(provider.network, await request(provider.network, 'start', {flow: flow.id}), mine));
        if (provider.logins.length) button(section, 'Disconnect', async () => { await request(provider.network, 'disconnect', {}); await show(); });
      }
    }
    return {show, close: async () => { ++generation; root.replaceChildren(); if (active) { const old = active; active = null; await request(old.network, 'cancel', {login_id: old.login_id}); } }};
  };
})(window);
