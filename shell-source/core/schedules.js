/* Settings → Schedules. One registration, both shells; owner API only.
 * Run-now is a durable request, never a completion claim. */
(() => {
  'use strict';
  if (window.WosSchedules) return;
  const API = '/wizard/v1/schedules';
  const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const states = new WeakMap();
  const state = ctx => { if (!states.has(ctx)) states.set(ctx, { sheet: null, busy: false, error: '' }); return states.get(ctx); };
  let jobs = null, unavailable = false, error = '', inflight = null;
  const changed = () => window.WosSettings?.refresh();
  async function request(suffix = '', method = 'GET', body) {
    const r = await fetch(API + suffix, { method, credentials: 'same-origin', cache: 'no-store',
      ...(body === undefined ? {} : { headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }) });
    const data = await r.json().catch(() => ({}));
    if (!r.ok) { const e = new Error(data.error || `Could not reach schedules (${r.status})`); e.status = r.status; throw e; }
    return data;
  }
  function load() {
    if (inflight) return inflight;
    inflight = (async () => {
      try {
        const d = await request();
        if (!Array.isArray(d.schedules)) throw Error('Could not read schedules');
        jobs = d.schedules; unavailable = false; error = '';
      } catch (e) {
        unavailable = e.status === 404;
        if (unavailable) jobs = null;
        error = e.message;
      } finally { inflight = null; changed(); }
      return jobs;
    })();
    return inflight;
  }
  async function readback() {
    if (inflight) await inflight;
    await load();
    if (error) throw Error('Saved request, but could not refresh schedules. Try again.');
  }
  function whenText(when) {
    if (when?.every) return `Every ${when.every} min`;
    if (when?.once) return `Once · ${dateText(when.once)}`;
    const c = when?.cron?.trim().split(/\s+/) || [];
    const time = /^\d+$/.test(c[0]) && /^\d+$/.test(c[1]) ? `${c[1].padStart(2, '0')}:${c[0].padStart(2, '0')}` : '';
    if (time && c.slice(2).join(' ') === '* * *') return `Every day ${time}`;
    if (time && c.slice(2).join(' ') === '* * 1-5') return `Weekdays ${time}`;
    if (/^\*\/\d+$/.test(c[0]) && c.slice(1).join(' ') === '* * * *') return `Every ${Number(c[0].slice(2))} min`;
    if (time && c[2] === '*' && c[3] === '*' && /^[0-6]$/.test(c[4])) return `Every ${['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'][Number(c[4])]} ${time}`;
    // Keep unsupported expressions exact, not a guessed English interpretation.
    return `Custom timing · ${when?.cron || 'unavailable'}`;
  }
  const zone = () => window.WizConfig?.timeZone?.() || undefined;
  function dateText(v) { const d = new Date(v); return Number.isFinite(d.getTime()) ? d.toLocaleString([], { dateStyle: 'medium', timeStyle: 'short', timeZone: zone() }) : 'Unavailable'; }
  function shortTime(v, relative = false) {
    const d = new Date(v); if (!v || !Number.isFinite(d.getTime())) return '';
    const timeZone = zone();
    const time = new Intl.DateTimeFormat('en-GB', { timeZone, hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).format(d);
    if (!relative) return time;
    // Compare owner-local calendar dates, not 24-hour durations (DST, midnight).
    const day = value => {
      const parts = new Intl.DateTimeFormat('en-US', { timeZone, year: 'numeric', month: 'numeric', day: 'numeric' }).formatToParts(value);
      const p = Object.fromEntries(parts.map(p => [p.type, p.value]));
      return Date.UTC(Number(p.year), Number(p.month) - 1, Number(p.day));
    };
    const delta = (day(d) - day(Date.now())) / 86400000;
    const label = delta === 0 ? 'today' : delta === 1 ? 'tomorrow' : new Intl.DateTimeFormat('en-GB', { timeZone, day: 'numeric', month: 'short', ...(d.getUTCFullYear() !== new Date().getUTCFullYear() ? { year: 'numeric' } : {}) }).format(d);
    return `${time} ${label}`;
  }
  function lastText(j) {
    const r = j.lastRun;
    if (!Object.hasOwn(j, 'lastRun')) return 'Last run · unavailable';
    if (!r) return 'Last run · not yet';
    const labels = { posted: 'Posted', silent: 'Silent', failed: `Failed${r.error ? ': ' + r.error : ''}`, running: 'Running' };
    const time = shortTime(r.startedAt || r.scheduledFor);
    return labels[r.outcome] && time ? `Last run ${time} · ${labels[r.outcome]}` : 'Last run · unavailable';
  }
  function nextText(j) {
    if (!Object.hasOwn(j, 'nextRun')) return 'Next · unavailable';
    if (j.nextRun === null) return j.enabled ? 'Next · none' : 'Next · paused';
    const time = shortTime(j.nextRun, true);
    return time ? `Next ${time}` : 'Next · unavailable';
  }
  const button = (action, title, id = '', attrs = '') => `<button type="button" data-sc="${action}" data-sc-id="${esc(id)}" ${attrs}>${esc(title)}</button>`;
  function row(j, ctx) {
    const s = state(ctx), chat = ctx.live?.session?.(j.thread);
    return `<article class="sc-row" data-sc-row="${esc(j.id)}"><div class="sc-head"><div class="st-tx"><b>${esc(j.name)}</b><small>${esc(whenText(j.when))}${j.timezone ? ` · ${esc(j.timezone)}` : ''}</small></div>${button('toggle', j.enabled ? 'On' : 'Off', j.id, `role="switch" aria-label="${esc(j.name)}" aria-checked="${!!j.enabled}" ${s.busy ? 'disabled' : ''}`)}</div><div class="sc-chat">${j.thread ? button('chat', chat?.title || `Schedules · ${j.name}`, j.id) : '<span>New chat on first run</span>'}</div><p class="sc-last">${esc(lastText(j))}<br>${esc(nextText(j))}</p><div class="st-actions">${button('run', 'Run now', j.id, s.busy ? 'disabled' : '')}${button('edit', 'Edit', j.id, s.busy ? 'disabled' : '')}${button('delete', 'Delete', j.id, s.busy ? 'disabled' : '')}</div></article>`;
  }
  function draftFor(j = {}) {
    const w = j.when || { cron: '0 7 * * *' };
    return { id: j.id || '', name: j.name || '', kind: w.every ? 'every' : w.once ? 'once' : 'cron',
      timing: String(w.every || w.once || w.cron || ''), prompt: j.prompt || '', thread: j.thread || '',
      timezone: j.timezone || '', agent: j.agent || 'main', skill: j.skill || '' };
  }
  function editHtml(d, ctx) {
    const field = (key, label, value, attrs = '') => `<label>${label}<input data-sc-field="${key}" value="${esc(value)}" ${attrs}></label>`;
    const sessions = (ctx.live?.sessions || []).filter(j => !j.archived && (ctx.live?.agentOf?.(j.id) || 'main') === d.agent);
    const known = sessions.some(j => j.id === d.thread);
    return `${field('name', 'Name', d.name, 'maxlength="160" required')}
      <label>When<select data-sc-field="kind">${[['cron', 'At a time (cron)'], ['every', 'Every few minutes'], ['once', 'Once']].map(([k, n]) => `<option value="${k}" ${d.kind === k ? 'selected' : ''}>${n}</option>`).join('')}</select></label>
      ${field('timing', 'Time or interval', d.timing, 'required aria-describedby="sc-timing-help"')}<p id="sc-timing-help" class="st-note">Cron: 0 7 * * * = every day 07:00. Interval: minutes. Once: date and time with Z or an offset.</p>
      <p class="st-note">Timezone: ${esc(d.timezone || 'Wizard’s timezone')}</p>
      <label>Prompt<textarea data-sc-field="prompt" rows="5" maxlength="64000">${esc(d.prompt)}</textarea></label>${d.skill ? `<p class="st-note">Skill kept: ${esc(d.skill)}</p>` : ''}
      <label>Chat<select data-sc-field="thread"><option value="">New chat on first run</option>${d.thread && !known ? `<option value="${esc(d.thread)}" selected>${esc(ctx.live?.session?.(d.thread)?.title || d.thread)}</option>` : ''}${sessions.map(j => `<option value="${esc(j.id)}" ${j.id === d.thread ? 'selected' : ''}>${esc(j.title || j.id)}</option>`).join('')}</select></label>`;
  }
  function sheetHtml(ctx) {
    const s = state(ctx), sh = s.sheet; if (!sh) return '';
    let title, content, action;
    if (sh.type === 'edit') { title = sh.draft.id ? 'Edit schedule' : 'New schedule'; content = `<fieldset ${s.busy ? 'disabled' : ''}>${editHtml(sh.draft, ctx)}</fieldset>`; action = button('save', s.busy ? 'Saving…' : 'Save', '', s.busy ? 'disabled' : ''); }
    if (sh.type === 'delete') { title = 'Delete schedule?'; content = `<p>${esc(sh.job.name)} will stop. Its chat stays.</p>`; action = button('confirm-delete', 'Delete', sh.job.id, s.busy ? 'disabled' : ''); }
    if (sh.type === 'import') {
      title = 'Import from Hermes';
      content = `<p>Supported jobs come in paused. Hermes jobs stay unchanged.</p>${sh.results ? `<ul class="sc-import">${sh.results.map(r => `<li><b>${esc(r.name || r.id || 'Unnamed job')}</b><small>${esc(r.status)}</small>${r.schedule ? `<small>${esc(whenText(r.schedule.when))}</small>` : ''}</li>`).join('')}</ul>${sh.results.length ? '' : '<p>No Hermes jobs found.</p>'}` : '<p>Reading Hermes jobs…</p>'}`;
      action = sh.results?.some(r => r.status === 'would import (paused)') ? button('confirm-import', s.busy ? 'Importing…' : 'Import paused', '', s.busy ? 'disabled' : '') : '';
    }
    return `<div class="st-confirm-scrim sc-scrim"><section class="st-confirm sc-sheet" role="${sh.type === 'delete' ? 'alertdialog' : 'dialog'}" aria-modal="true" aria-labelledby="sc-sheet-title"><h3 id="sc-sheet-title">${title}</h3>${content}${s.error ? `<p class="sc-error" role="alert">${esc(s.error)}</p>` : ''}<div class="st-actions">${button('close', 'Cancel')}${action}</div></section></div>`;
  }
  function html(ctx) {
    if (unavailable || (!jobs && !error)) return '';
    const s = state(ctx);
    return `<div class="st-group sc-group"><div class="st-actions">${button('new', 'New schedule', '', s.busy ? 'disabled' : '')}${button('import', 'Import from Hermes', '', s.busy ? 'disabled' : '')}</div>${error ? `<p class="sc-error" role="alert">${esc(error)}</p>${button('reload', 'Try again')}` : ''}${jobs?.length ? jobs.map(j => row(j, ctx)).join('') : '<p class="st-empty">No schedules yet.</p>'}${s.error && !s.sheet ? `<p class="sc-error" role="alert">${esc(s.error)}</p>` : ''}${sheetHtml(ctx)}</div>`;
  }
  function focus(ctx, selector) { requestAnimationFrame(() => {
    const target = ctx.root?.querySelector(selector), active = document.activeElement;
    // A delayed initial focus must not steal the next keystroke from a field
    // the owner has already reached (or a native keyboard has focused).
    if (active && active !== target && active.closest?.('.sc-sheet')) return;
    target?.focus({ preventScroll: true });
  }); }
  function close(ctx) {
    const s = state(ctx); if (!s.sheet) return false;
    const opener = s.sheet.opener || 'new'; s.sheet = null; s.error = ''; ctx.render(); focus(ctx, `[data-sc="${opener}"]`); return true;
  }
  async function work(ctx, fn) {
    const s = state(ctx); if (s.busy) return;
    s.busy = true; s.error = ''; ctx.render();
    try { await fn(s); } catch (e) { s.error = e.message || 'Could not save schedule'; }
    finally { s.busy = false; ctx.render(); }
  }
  function act(ctx, el) {
    const b = el.closest('[data-sc]'); if (!b) return false;
    const s = state(ctx), what = b.dataset.sc, j = jobs?.find(j => j.id === b.dataset.scId);
    if (what === 'close') { close(ctx); return true; }
    if (s.busy) return true;
    if (what === 'reload') { load(); return true; }
    if (what === 'chat' && j?.thread) { ctx.openThread?.(j.thread); return true; }
    if (what === 'new' || (what === 'edit' && j)) { s.error = ''; s.sheet = { type: 'edit', draft: draftFor(j), opener: what }; ctx.render(); focus(ctx, '[data-sc-field="name"]'); return true; }
    if (what === 'delete' && j) { s.error = ''; s.sheet = { type: 'delete', job: j, opener: what }; ctx.render(); focus(ctx, '[data-sc="close"]'); return true; }
    if (what === 'import') {
      s.sheet = { type: 'import', results: null, opener: 'import' }; const sh = s.sheet;
      work(ctx, async () => { const d = await request('/import-hermes', 'POST', { dryRun: true }); if (s.sheet === sh) { sh.results = d.results; focus(ctx, '[data-sc="close"]'); } }); return true;
    }
    if (what === 'confirm-import' && s.sheet?.type === 'import' && s.sheet.results?.some(r => r.status === 'would import (paused)')) {
      const sh = s.sheet;
      work(ctx, async () => { const d = await request('/import-hermes', 'POST', { dryRun: false }); if (s.sheet === sh) { sh.results = d.results; } await readback(); }); return true;
    }
    if (what === 'save' && s.sheet?.type === 'edit') {
      const sh = s.sheet, d = sh.draft;
      work(ctx, async () => {
        if (!d.name.trim()) throw Error('Add a name');
        if (!d.prompt.trim() && !d.skill) throw Error('Add a prompt');
        const timing = d.timing.trim();
        if (!timing) throw Error('Add a time or interval');
        if (d.kind === 'every' && (!Number.isFinite(Number(timing)) || Number(timing) < 1 || Number(timing) > 525600)) throw Error('Use an interval from 1 to 525600 minutes');
        if (d.kind === 'once' && (!/\dT.*(?:Z|[+-]\d\d:\d\d)$/.test(timing) || !Number.isFinite(Date.parse(timing)))) throw Error('Use a date and time with Z or an offset');
        const body = { name: d.name.trim(), when: { [d.kind]: d.kind === 'every' ? Number(timing) : timing }, prompt: d.prompt, thread: d.thread || null };
        // PATCH only edited fields: retain model, agent, skill, timezone and enabled.
        if (!d.id) Object.assign(body, { agent: 'main', enabled: true });
        const saved = await request(d.id ? '/' + encodeURIComponent(d.id) : '', d.id ? 'PATCH' : 'POST', body);
        // If readback fails, retry edits this created job instead of POSTing a copy.
        if (!d.id && (saved.id || saved.schedule?.id)) d.id = saved.id || saved.schedule.id;
        await readback(); if (s.sheet === sh) close(ctx);
      }); return true;
    }
    if (what === 'toggle' && j) { work(ctx, async () => { await request('/' + encodeURIComponent(j.id), 'PATCH', { enabled: !j.enabled }); await readback(); }); return true; }
    if (what === 'run' && j) { work(ctx, async () => { await request('/' + encodeURIComponent(j.id) + '/run', 'POST', {}); await readback(); ctx.toast?.('✓', 'Run requested', 1800); }); return true; }
    if (what === 'confirm-delete' && s.sheet?.type === 'delete' && j) {
      const sh = s.sheet;
      work(ctx, async () => { await request('/' + encodeURIComponent(j.id), 'DELETE'); await readback(); if (s.sheet === sh) close(ctx); }); return true;
    }
    return true;
  }
  function input(ctx, el) {
    const f = el.closest('[data-sc-field]'), sh = state(ctx).sheet;
    if (f && sh?.type === 'edit' && Object.hasOwn(sh.draft, f.dataset.scField)) sh.draft[f.dataset.scField] = f.value;
  }
  window.WosSchedules = { load, whenText, get available() { return !unavailable && (!!jobs || !!error); } };
  window.WosSettings?.register({ id: 'schedules', page: 'schedules', aliases: ['schedules'], available: () => window.WosSchedules.available,
    html, act, input, back: close, enter: load, deferRefresh: ctx => !!state(ctx).sheet, leave(ctx) { state(ctx).sheet = null; state(ctx).error = ''; } });
  load();
})();
