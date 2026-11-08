/* Wizard OS · Settings → Microphone (James, 18 Oct 2026)
 *
 * By default every recording uses the phone's own mic, so a Bluetooth speaker never hijacks a voice note. Someone
 * who wants a Bluetooth headset or other mic chooses it here, per phone, without a native update or an agent edit:
 *
 *   Phone mic only (default)   {"mode":"phone"}
 *   Any connected mic          {"mode":"any"}         whatever Android picks, Bluetooth included
 *   Use <device> when connected {"mode":"prefer","prefer":[{type,name,address}…]}
 *                              remembered mics first, in order; otherwise the phone mic, never another device
 *
 * Native side: WizardOSDevice.micPolicy() → {v, policy, inputs[]} and setMicPolicy(json) (ai.wizards.os.audio.MicPolicy,
 * Android 0.9.30+). Every native recorder and the page's own browser recorder honour the saved policy at start.
 *
 *   WosMic.html()       → the Settings group
 *   WosMic.act(el, ctx) → handles a [data-mic] tap; true if handled
 *   WosMic.available()  → this shell can choose its mic
 */
(() => {
  'use strict';
  const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const DEV = () => { const d = window.WizardOSDevice; return d && typeof d.micPolicy === 'function' && typeof d.setMicPolicy === 'function' ? d : null; };
  const KIND = { bluetooth_sco: 'Bluetooth', bluetooth_le: 'Bluetooth', wired_headset: 'Headset', usb: 'USB', builtin_mic: 'Phone' };
  const same = (a, b) => a.type === b.type && (a.address && b.address ? a.address.toLowerCase() === b.address.toLowerCase() : !!a.name && a.name.toLowerCase() === (b.name || '').toLowerCase());
  const label = d => d.name && !/^(unknown)?$/i.test(d.name) ? d.name : `${KIND[d.type] || 'External'} mic`;

  function read() {
    const d = DEV(); if (!d) return null;
    try {
      const s = JSON.parse(d.micPolicy());
      const policy = s?.policy && typeof s.policy === 'object' ? s.policy : { mode: 'phone' };
      return { policy: { mode: policy.mode || 'phone', prefer: Array.isArray(policy.prefer) ? policy.prefer : [] }, inputs: Array.isArray(s?.inputs) ? s.inputs : [] };
    } catch (_) { return { policy: { mode: 'phone', prefer: [] }, inputs: [] }; }
  }
  function save(policy) {
    const d = DEV(); if (!d) return null;
    const body = { v: 1, mode: policy.mode };
    if (policy.mode === 'prefer') body.prefer = policy.prefer.map(({ type, name, address }) => ({ type, name: name || '', address: address || '' }));
    try { return JSON.parse(d.setMicPolicy(JSON.stringify(body))); } catch (_) { return null; }
  }

  function html() {
    const s = read(); if (!s) return '';
    const { policy, inputs } = s, mode = policy.mode;
    const others = inputs.filter(i => i.type !== 'builtin_mic');
    const remembered = mode === 'prefer' ? policy.prefer : [];
    const opt = (key, icon, title, sub, on) =>
      `<button class="st-row" data-mic="${key}" role="radio" aria-checked="${on}"><span class="st-tx"><b>${esc(title)}</b><small>${esc(sub)}</small></span><span class="st-go">${on ? '●' : '○'}</span></button>`;
    let rows = opt('phone', '🎙', 'Phone mic only', 'Recommended · a Bluetooth speaker or headset never takes over your recordings', mode === 'phone')
      + opt('any', '🎧', 'Any connected mic', 'Android picks · a Bluetooth headset mic is used while it is connected', mode === 'any');
    // Mics this phone remembers (prefer list), connected or not, then connected ones not yet chosen.
    const seen = [];
    for (const [i, d] of remembered.entries()) {
      const live = inputs.some(x => same(d, x)); seen.push(d);
      rows += `<button class="st-row" data-mic="forget" data-mici="${i}" role="radio" aria-checked="true"><span class="st-tx"><b>Use ${esc(label(d))}${i ? ' (backup)' : ''}</b><small>${live ? 'Connected · used for recordings · tap to stop using it' : 'Not connected · phone mic until it is · tap to forget'}</small></span><span class="st-go">●</span></button>`;
    }
    for (const d of others) {
      if (seen.some(x => same(x, d))) continue;
      const j = inputs.indexOf(d);
      rows += `<button class="st-row" data-mic="prefer" data-mici="${j}" role="radio" aria-checked="false"><span class="st-tx"><b>Use ${esc(label(d))} when connected</b><small>${esc(KIND[d.type] || 'External')} · remembered on this phone · otherwise the phone mic</small></span><span class="st-go">○</span></button>`;
    }
    return `<div class="st-group" data-mic-group><h4>Microphone</h4>${rows}</div>`;
  }

  function act(el, ctx) {
    const b = el.closest('[data-mic]'); if (!b) return false;
    const s = read(); if (!s) return false;
    const { policy, inputs } = s, i = Number(b.dataset.mici);
    let next = null, note = '';
    if (b.dataset.mic === 'phone') { next = { mode: 'phone', prefer: [] }; note = 'Phone mic only'; }
    else if (b.dataset.mic === 'any') { next = { mode: 'any', prefer: [] }; note = 'Any connected mic · Bluetooth headsets included'; }
    else if (b.dataset.mic === 'prefer' && inputs[i]) {
      const keep = policy.mode === 'prefer' ? policy.prefer.filter(p => !same(p, inputs[i])) : [];
      next = { mode: 'prefer', prefer: [inputs[i], ...keep].slice(0, 8) }; note = `${label(inputs[i])} · used when connected`;
    } else if (b.dataset.mic === 'forget' && policy.prefer[i]) {
      const rest = policy.prefer.filter((_, k) => k !== i);
      next = rest.length ? { mode: 'prefer', prefer: rest } : { mode: 'phone', prefer: [] }; note = rest.length ? `Stopped using ${label(policy.prefer[i])}` : 'Phone mic only';
    }
    if (!next) return true;
    const saved = save(next);
    const ok = saved && saved.mode === next.mode;
    (ctx?.toast || ((...a) => (window.__wos || window.__wux)?.toast?.(...a)))(ok ? '🎙' : '!', ok ? note : 'Could not save the microphone choice', 2400);
    ctx?.haptic?.(8); ctx?.render?.(); return true;
  }

  window.WosMic = { html, act, summary: () => { const p = read()?.policy; return !p || p.mode === 'phone' ? 'default' : p.mode === 'any' ? 'any connected' : label(p.prefer[0] || {}); }, available: () => !!DEV(), read, same };
})();
