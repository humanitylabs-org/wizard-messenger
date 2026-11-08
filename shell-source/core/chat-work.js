/* Wizard UX core: the work receipt under each request (#17). Shared by every shell.
 *
 * One compact, collapsible row per turn, from what the Agent Service already projects onto the
 * message history (view=wizard): named tool calls (display_label), their results (timing), the
 * agent's plan (tool rows carry `plan`: [{id, content, status}]) and clarify questions
 * (`question`: {text, choices, state: waiting|answered|unanswered, answer}).
 * Collapsed:  ◇ Worked for 3m · 2 of 4 done · 12 steps          (a live turn: … 2 of 4 · current step · 1m)
 * Open:       Waiting on you / You answered · plan checklist · named steps with durations · notes.
 * Port of wizard-mobile ff86db8c App.tsx WorkPlan/WorkQuestion + normalizers.ts (plan, question, elapsedLabel).
 *
 *   WosWork.analyse(turn, live, now)  → { start, end, plan, done, question, steps, count }
 *   WosWork.html(turn, { live, open, md, esc, clip, key }) → '<details class="steps …">…'
 */
(() => {
  'use strict';
  const STATUS = new Set(['pending', 'in_progress', 'completed', 'cancelled']);
  const fin = v => typeof v === 'number' && isFinite(v);
  // legacy elapsedLabel: seconds under a minute, minutes under an hour, then h + m.
  function dur(ms) {
    if (!fin(ms) || ms < 0) return '';
    const s = Math.round(ms / 1000);
    if (s < 60) return `${Math.max(1, s)}s`;
    const m = Math.floor(s / 60);
    if (m < 60) return s % 60 && m < 10 ? `${m}m ${s % 60}s` : `${m}m`;
    return `${Math.floor(m / 60)}h ${m % 60}m`;
  }
  const cleanQ = q => {
    if (!q || typeof q !== 'object') return null;
    const text = String(q.text || '').replace(/\s+/g, ' ').trim().slice(0, 400); if (!text) return null;
    const state = ['waiting', 'answered', 'unanswered'].includes(q.state) ? q.state : 'waiting';
    return { text, state, choices: (Array.isArray(q.choices) ? q.choices : []).map(c => String(c || '').trim().slice(0, 120)).filter(Boolean).slice(0, 4), answer: String(q.answer || '').trim().slice(0, 200) };
  };
  const cleanPlan = p => (Array.isArray(p) ? p : []).slice(0, 40).map((it, i) => ({ id: String(it?.id || `item-${i}`), content: String(it?.content || '').replace(/\s+/g, ' ').trim().slice(0, 160), status: STATUS.has(it?.status) ? it.status : 'pending' })).filter(it => it.content);

  function analyse(tn, live, now = Date.now()) {
    const calls = new Map(), steps = []; let plan = null, question = null;
    const evs = tn.work || [];
    for (const ev of evs) {
      for (const c of ev.calls || []) {
        const st = { id: c.id, label: c.label || 'Worked on it', start: ev.at, end: NaN };
        steps.push(st); if (c.id) calls.set(c.id, st);
        const q = cleanQ(c.question); if (q) question = q;
      }
      if (ev.role === 'tool') {
        const st = calls.get(ev.callId); if (st && fin(ev.at)) st.end = ev.at;
        if (ev.plan) { const p = cleanPlan(ev.plan); if (p.length) plan = p; }
        const q = cleanQ(ev.question); if (q) question = q;
      }
    }
    // A question still open when the run ended was never answered; the agent carried on without it.
    if (question && question.state === 'waiting' && !live) question = { ...question, state: 'unanswered' };
    const times = evs.map(e => e.at).filter(fin);
    const start = fin(tn.u?.at) ? tn.u.at : fin(tn.note?.at) ? tn.note.at : times.length ? Math.min(...times) : NaN;
    const end = live ? now : fin(tn.a?.at) ? tn.a.at : times.length ? Math.max(...times) : NaN;
    // A step with no result yet: done when the next step started (or the answer came), running if live.
    steps.forEach((st, i) => { if (!fin(st.end)) { const nx = steps[i + 1]?.start; st.end = fin(nx) ? nx : live ? NaN : end; st.running = live && !fin(nx); } });
    const done = plan ? plan.filter(p => p.status === 'completed').length : 0;
    const dropped = plan ? plan.filter(p => p.status === 'cancelled').length : 0;
    return { start, end, plan, done, dropped, question, steps, count: steps.length || tn.steps || 0, worked: fin(start) && fin(end) ? end - start : NaN };
  }

  function html(tn, o) {
    const { live, open, md, esc, clip } = o;
    const r = analyse(tn, live, o.now);
    // Bind previews by call ID only. ID-less events are explicitly transient live rows,
    // never guessed onto a historical row by tool name or position; completed replays stay out.
    if (live) for (const s of (Array.isArray(o.streamSteps) ? o.streamSteps : []).slice(-4)) {
      const matched = s.id && r.steps.find(st => st.id === s.id);
      if (matched) { matched.preview = s.preview; if (!fin(matched.end)) { matched.running = !s.done; matched.streamDone = s.done; matched.error = s.error; } }
      else if (!s.done && s.tool) {
        const name = String(s.tool).replace(/^mcp__(wizard__)?/, '').replace(/__/g, ' · ').replace(/_/g, ' ').trim();
        r.steps.push({ label: name ? name[0].toUpperCase() + name.slice(1) : 'Working', preview: s.preview, running: true, transient: true });
      }
    }
    const notes = tn.notes || [];
    if (!r.count && !notes.length && !live) return '';
    const cur = r.plan?.find(p => p.status === 'in_progress');
    const waiting = live && r.question?.state === 'waiting';
    const progress = r.plan ? `${r.done} of ${r.plan.length} done${r.dropped ? ` · ${r.dropped} dropped` : ''}` : '';
    let label;
    if (live) {
      const now = waiting ? 'Waiting on you' : cur ? cur.content : notes.length ? notes[notes.length - 1] : r.steps.length ? r.steps[r.steps.length - 1].label : 'Working';
      label = [r.plan ? `${r.done} of ${r.plan.length}` : '', clip(now, 80), dur(r.worked)].filter(Boolean).join(' · ');
    } else {
      label = [fin(r.worked) && r.worked >= 1000 ? `Worked for ${dur(r.worked)}` : 'Worked', progress, r.count ? `${r.count} step${r.count === 1 ? '' : 's'}` : '', r.question?.state === 'unanswered' ? 'question left open' : ''].filter(Boolean).join(' · ');
    }
    const helper = live ? helperLabel(o.helperStatus, o.now) : '';
    if (helper) label = helper;
    const icon = live ? '<i class="dots"><b></b><b></b><b></b></i>' : '◇';
    let body = '';
    if (helper) {
      const hs = o.helperStatus;
      body += `<div class="wk-helper ${esc(hs.phase)}" role="status"><b>${esc(helper)}</b><small>${esc(helperDetail(hs))}</small>${hs.resumeEligible ? `<button type="button" data-helper-continue ${hs.preview ? 'data-preview="1"' : ''}>${hs.preview ? 'Try Continue · example only' : 'Continue'}</button>` : ''}${hs.preview ? '<small>Illustrative example · live tasks are unchanged.</small>' : ''}</div>`;
    }
    if (r.question) {
      const q = r.question, head = q.state === 'answered' ? 'You answered' : q.state === 'unanswered' ? 'No answer recorded' : 'Waiting on you';
      body += `<div class="wk-q ${q.state}" role="group" aria-label="${esc(head)}"><b>${esc(head)}</b><p>${esc(q.text)}</p>`
        + (q.state === 'answered' && q.answer ? `<p class="wk-qa">${esc(q.answer)}</p>` : q.choices.length ? `<p class="wk-qa">Suggested: ${esc(q.choices[0])}</p>` : '')
        + (q.state === 'waiting' ? '<small>Reply in this thread to answer.</small>' : '') + '</div>';
    }
    if (r.plan) {
      body += `<ol class="wk-plan" aria-label="Plan, ${esc(progress)}">${r.plan.map((p, i) => `<li class="${p.status}"><span class="wk-m" aria-hidden="true">${p.status === 'completed' ? '✓' : p.status === 'in_progress' ? '◌' : p.status === 'cancelled' ? '–' : i + 1}</span><span>${esc(p.content)}</span></li>`).join('')}</ol>`;
    }
    if (r.steps.length) {
      const MAX = 40, shown = r.steps.slice(-MAX);
      body += `<ul class="wk-steps">${r.steps.length > MAX ? `<li class="wk-more">${r.steps.length - MAX} earlier steps</li>` : ''}${shown.map(st => `<li${st.running ? ' class="run"' : ''}><span>${esc(st.label)}${st.preview ? `<small class="wk-preview">${esc(clip(String(st.preview).replace(/\s+/g, ' ').trim(), 90))}</small>` : ''}</span><time>${st.running ? '…' : st.streamDone ? (st.error ? '!' : '✓') : esc(dur(st.end - st.start))}</time></li>`).join('')}</ul>`;
    }
    if (notes.length) body += notes.map(x => `<div class="note-line">${md(x)}</div>`).join('');
    return `<details class="steps wk${live ? ' live' : ''}${waiting ? ' asks' : ''}" data-wk="${esc(o.key)}"${open ? ' open' : ''}><summary>${icon} <span class="wk-l">${esc(label)}</span>${waiting ? '<em class="wk-dot" aria-hidden="true"></em>' : ''}</summary>${body}</details>`;
  }
  function helperLabel(h, now = Date.now()) {
    if (!h || !['running','integrating','waiting','stalled','held','uncertain'].includes(h.phase)) return '';
    const age = dur(Math.max(0, now - Number(h.since) * 1000));
    const labels = { running: `Waiting on ${Math.max(1, Number(h.pending) || 1)} helper${Number(h.pending) === 1 ? '' : 's'}`, integrating: 'Helpers returned · finishing your answer', waiting: 'Helpers returned · waiting to resume', stalled: 'Stuck · helpers returned, no agent running', held: 'Waiting on your decision · helpers tracked', uncertain: 'Helper status needs checking' };
    return labels[h.phase] + (age ? ` · ${age}` : '');
  }
  function helperDetail(h) {
    if (h.phase === 'running') return (h.returned ? `${h.returned} helper${h.returned === 1 ? '' : 's'} returned. ` : '') + 'Still waiting for the remaining results; returned results are not a finished task.';
    if (h.phase === 'integrating') return 'The main agent is active: checking the results and completing your request.';
    if (h.phase === 'waiting') return 'Results are saved. Automatic continuation has not started yet.';
    if (h.phase === 'stalled') return h.resumeEligible ? 'Results are saved. Continue resumes the same request.' : 'Results are saved; recovery eligibility needs checking.';
    if (h.phase === 'held') return 'Your existing decision stays in control. Helpers do not bypass it.';
    return 'The last receipt is too old to claim this work is still running.';
  }
  window.WosWork = { analyse, html, dur, helperLabel, helperDetail };
})();
