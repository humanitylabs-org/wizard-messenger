/* Wizard UX core: AI usage in Settings (#24). Shared by every shell.
 *
 * GET /wizard/ai-usage → { fetchedAt, providers: [{ id, name, plan, status, fetchedAt, limits: [{ id, label,
 * usedPercent, remainingPercent, resetsAt }], paid, error }] }. One row per quota window: how much is left,
 * a bar, when it resets (countdown + the exact moment in the owner's time zone). A provider Wizard could not
 * read says so in a line instead of going missing. Port of wizard-mobile ff86db8c aiUsage.ts (compactRows,
 * usageTone, formatCountdown, formatResetTime, paidSummary, formatFreshness) and AiUsage.tsx.
 *
 *   WosUsage.load(force) → Promise<snapshot|null>   (cached 60 s)
 *   WosUsage.html(now)   → the Settings card
 */
(() => {
  'use strict';
  const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const pct = v => { if (v == null || v === '') return null; const n = Number(v); return isFinite(n) ? Math.max(0, Math.min(100, Math.round(n))) : null; };
  const iso = v => (typeof v === 'string' && isFinite(Date.parse(v)) ? v : null);
  function normalize(j) {
    const groups = (Array.isArray(j?.providers) ? j.providers : []);
    // Provider identity is presentation only: never merge subscriptions by label.
    const family = p => {
      const raw = String(p.providerId || p.provider || p.id || '').split(':')[0];
      return /^(?:codex(?:-\d+)?|openai-codex|chatgpt)$/i.test(raw) ? 'chatgpt' : raw;
    };
    const counts = new Map();
    for (const p of groups) {
      if (!p?.id) continue;
      const id = family(p), prior = counts.get(id);
      counts.set(id, {id, name: id === 'chatgpt' ? 'ChatGPT' : String(p.name || id), count:(prior?.count || 0) + (Array.isArray(p.accounts) ? p.accounts.length : 1)});
    }
    const accountCounts = [...counts.values()];
    const expanded = groups.flatMap(p => Array.isArray(p?.accounts) ? p.accounts.map(a => { const childOut = ['signed_out', 'auth', 'reauth'].includes(a.status); return {...a, providerId:p.id, providerName:p.name, status:childOut ? a.status : ['stale', 'unavailable', 'signed_out', 'auth', 'reauth'].includes(p.status) ? p.status : a.status, signedOut:childOut || a.signedOut === true || p.signedOut === true, error:a.error || p.error}; }) : [p]);
    const providers = expanded.map(p => {
      if (!p || typeof p !== 'object' || !p.id) return null;
      const limits = (Array.isArray(p.limits) ? p.limits : []).map(l => {
        const rem = pct(l?.remainingPercent ?? (l?.usedPercent != null ? 100 - l.usedPercent : null)); if (rem == null) return null;
        return { id: String(l.id || l.label || ''), label: String(l.label || 'Quota'), remainingPercent: rem, usedPercent: 100 - rem, resetsAt: iso(l.resetsAt) };
      }).filter(Boolean);
      const paid = p.paid && typeof p.paid === 'object' ? p.paid : null;
      // Signed out: any limits it still carries are from before; every renderer reads that as unavailable, never live.
      const signedOut = ['signed_out', 'auth', 'reauth'].includes(p.status) || p.signedOut === true || /sign.?in|signed.?out|reauth|401|unauthori[sz]ed/i.test(String(p.error?.code || p.error?.kind || ''));
      return { id: String(p.id), provider: family(p), providerName: family(p) === 'chatgpt' ? 'ChatGPT' : String(p.providerName || p.name || p.id), name: String(p.name || p.id), email: typeof p.email === 'string' && p.email.includes('@') && !p.email.includes('*') ? p.email : '', plan: p.plan ? String(p.plan) : '', status: signedOut ? 'unavailable' : ['ok', 'stale', 'unavailable'].includes(p.status) ? p.status : (limits.length ? 'ok' : 'unavailable'),
        signedOut,
        fetchedAt: iso(p.fetchedAt), limits, paid, error: p.error ? String(p.error.message || p.error) : '' };
    }).filter(Boolean);
    return { fetchedAt: iso(j?.fetchedAt), providers, accountCounts };
  }
  const tone = rem => (rem <= 10 ? 'alert' : rem <= 25 ? 'warning' : 'normal');
  const zone = () => (window.WizConfig?.timeZone?.() || undefined);
  const clock = ms => { try { return new Intl.DateTimeFormat('en-GB', { timeZone: zone(), hour: '2-digit', minute: '2-digit', hour12: false }).format(ms); } catch (e) { return ''; } };
  const wday = ms => { try { return new Intl.DateTimeFormat('en-GB', { timeZone: zone(), weekday: 'short' }).format(ms); } catch (e) { return ''; } };
  function countdown(at, now) {
    const m = Math.floor((at - now) / 60000);
    if (m <= 0) return 'Awaiting reset';
    if (m < 60) return `Resets in ${m}m`;
    const h = Math.floor(m / 60);
    return h < 24 ? `Resets in ${h}h ${m % 60}m` : `Resets in ${Math.floor(h / 24)}d ${h % 24}h`;
  }
  function resetLine(resetsAt, now) {
    const at = Date.parse(resetsAt || ''); if (!isFinite(at)) return '';
    return `${countdown(at, now)} · ${wday(at)} ${clock(at)}`;
  }
  function freshness(providers, now) {
    const ts = providers.filter(p => p.status !== 'unavailable' && p.fetchedAt).map(p => Date.parse(p.fetchedAt));
    if (!ts.length) return 'Not updated yet';
    const m = Math.max(0, Math.floor((now - Math.min(...ts)) / 60000));
    return m < 1 ? 'Updated just now' : m < 60 ? `Updated ${m} min ago` : `Updated ${clock(Math.min(...ts))}`;
  }
  const money = (minor, exp, cur) => minor == null ? '' : (cur === 'USD' ? '$' : '') + (minor / 10 ** Math.max(0, exp || 0)).toLocaleString('en-US', {minimumFractionDigits:Math.max(0, Math.min(4, exp || 0)),maximumFractionDigits:Math.max(0, Math.min(4, exp || 0))}) + (cur && cur !== 'USD' ? ' ' + cur : '');
  function paidLine(p) {
    if (!p || p.enabled === false) return '';
    if (p.type === 'credits') return p.unlimited ? 'Credits: unlimited' : p.balanceMinor != null ? `Credits: ${money(p.balanceMinor, p.exponent, p.currency)}` : '';
    const u = money(p.usedMinor, p.exponent, p.currency), l = money(p.limitMinor, p.exponent, p.currency);
    if (p.type === 'spend' && p.enabled === true && !l) return `Extra usage: Enabled · ${u ? u + ' spent' : 'Spend unavailable'} · Balance and cap unavailable`;
    return u && l ? `Extra usage: ${u} of ${l}` : l ? `Extra usage: Enabled · Spend unavailable · ${l} cap` : u ? `Extra usage: ${u} spent` : '';
  }
  // compactRows: 'Claude · Session', 'ChatGPT 2 · Weekly'; a model-scoped window names the model ('Fable · weekly').
  function rowLabel(p, l) {
    const scope = l.label.split('·').map(s => s.trim()).filter(Boolean);
    const named = scope.filter(s => s.toLowerCase() !== 'all models'), parts = named.length ? named : scope;
    return parts.length > 1 ? parts.join(' · ') : `${p.name} · ${parts[0] || l.label}`;
  }
  const U = {
    snap: null, error: '', at: 0, loading: null,
    load(force) {
      if (U.loading) return U.loading;
      if (!force && U.snap && Date.now() - U.at < 60e3) return Promise.resolve(U.snap);
      U.loading = fetch('/wizard/ai-usage', { cache: 'no-store', credentials: 'same-origin' })
        .then(r => { if (!r.ok) throw new Error(r.status === 403 ? 'Wizard sign-in needed' : `AI usage unavailable (${r.status})`); return r.json(); })
        .then(j => { U.snap = normalize(j); U.error = ''; U.at = Date.now(); return U.snap; })
        .catch(e => { U.error = String(e.message || e); return U.snap; })
        .finally(() => { U.loading = null; });
      return U.loading;
    },
    normalize, tone, resetLine, rowLabel,
    html(now = Date.now()) {
      const s = U.snap;
      const head = `<h4>AI usage <button type="button" class="st-mini" data-usage-refresh aria-label="Refresh AI usage">${U.loading ? '…' : '↻'}</button></h4>`;
      if (!s) return `<div class="st-group st-usage" data-usage>${head}<div class="st-empty">${U.error ? esc(U.error) : 'Loading…'}</div></div>`;
      const rows = [], notes = [];
      for (const p of s.providers) {
        if (p.status === 'unavailable' || !p.limits.length) { notes.push(`${p.name}${p.plan ? ' · ' + p.plan : ''}: ${p.signedOut ? 'signed out · sign in again to read usage' : p.status === 'unavailable' ? 'couldn’t read usage' : 'no quota windows'}${p.error ? ' · ' + p.error : ''}`); }
        if (p.status === 'stale') notes.push(`${p.name}: last known reading`);
        if (p.status === 'unavailable') continue;
        // Every bar in Wizard shows how much is USED (fills up toward 100%), like the server and Home bars.
        for (const l of p.limits) rows.push(`<div class="us-row ${tone(l.remainingPercent)}${p.status === 'stale' ? ' stale' : ''}" data-usage-row="${esc(p.id + ':' + l.id)}"><div class="us-t"><b>${esc(rowLabel(p, l))}</b><span class="us-p">${l.usedPercent}% used</span></div>`
          + `<div class="us-bar" role="meter" aria-valuemin="0" aria-valuemax="100" aria-valuenow="${l.usedPercent}" aria-label="${esc(rowLabel(p, l))} used"><i style="width:${l.usedPercent}%"></i></div>`
          + `<small class="us-r">${esc(resetLine(l.resetsAt, now) || 'No reset time reported')}</small></div>`);
        const pl = paidLine(p.paid); if (pl) notes.push(`${p.name}: ${pl}`);
      }
      return `<div class="st-group st-usage" data-usage>${head}${rows.join('') || '<div class="st-empty">No quota windows reported.</div>'}`
        + (notes.length ? `<p class="st-note us-notes">${notes.map(esc).join('<br>')}</p>` : '')
        + `<p class="st-note">${U.error ? 'Last known reading · ' : ''}${esc(freshness(s.providers, now))}${U.error ? ' · ' + esc(U.error) : ''} · times in ${esc(zone() || 'local time')}</p></div>`;
    },
  };
  window.WosUsage = U;
})();
