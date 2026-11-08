/* Shared Incognito view. Normal Markdown, work progress and run streams; no durable adapters. */
(() => {
  'use strict';
  window.WizCore = window.WizCore || {};
  // Only a preference is durable. Transcript, session and draft never use this adapter.
  const optInKey = 'wos.incognito.opt-in';
  let optedIn = false;
  try { optedIn = localStorage.getItem(optInKey) === 'true'; } catch (_) {}
  const capable = a => a?.privacy === 'private' && a.incognito_available === true;
  const available = () => (window.WosAgents?.list || []).some(capable);
  const enabled = a => optedIn && capable(a);
  window.WizCore.incognitoOptIn = Object.freeze({ enabled, available });
  window.WosSettings?.register({ id: 'incognito-opt-in', page: 'chats', available,
    html: () => `<div class="st-group"><h4>Temporary chats</h4><button type="button" class="st-row" data-incognito-opt-in role="switch" aria-checked="${optedIn}"><span class="st-tx"><b>Offer Incognito</b><small>Optional text-only chats on a private agent that supports them. Off by default.</small></span><span class="sw ${optedIn ? 'on' : ''}" aria-hidden="true"><i></i></span></button></div>`,
    act(ctx, el) {
      if (!available() || !el.closest('[data-incognito-opt-in]')) return false;
      const next = !optedIn;
      try { localStorage.setItem(optInKey, String(next)); optedIn = next; }
      catch (_) { ctx.toast?.('!', 'Could not save preference', 2400); }
      ctx.render?.(); return true;
    } });
  window.WosAgents?.onChange?.(() => window.WosSettings?.refresh());
  window.WizCore.incognitoChats = function ({ win, elOf, paint, grow, toast, kit = window.WosChat, fetchImpl = fetch, confirm = text => window.confirm(text) }) {
    const open = new Map();
    const alive = (wid, s) => open.get(wid) === s;
    const raw = (s, path, method = 'GET', body) => fetchImpl(s.base + path, { method, credentials: 'same-origin', cache: 'no-store', signal: s.abort.signal,
      headers: body !== undefined ? { 'Content-Type': 'application/json' } : {}, body: body !== undefined ? JSON.stringify(body) : undefined });
    const request = async (s, path, method = 'GET', body) => {
      const r = await raw(s, path, method, body);
      if (!r.ok) throw Object.assign(new Error('Incognito unavailable'), { status: r.status });
      return r.json();
    };
    const destroyRemote = s => s.base && fetchImpl(s.base, { method: 'DELETE', credentials: 'same-origin', cache: 'no-store', keepalive: true }).catch(() => {});
    function close(wid, force = false, checkOnly = false) {
      const s = open.get(wid); if (!s) return true;
      if (!force && !confirm('End incognito chat? It will be erased.')) return false;
      if (checkOnly) return true;
      open.delete(wid); clearInterval(s.lease); s.stream?.close(); s.abort.abort();
      const el = elOf(wid); if (el?.querySelector('[data-incog-thread]')) el.replaceChildren();
      s.draft = ''; s.lastInput = ''; s.messages.length = 0; s.output = ''; s.steps = []; void destroyRemote(s); return true;
    }
    async function start(wid, agent) {
      if (!enabled(agent) || open.has(wid)) return;
      const s = { agent, draft: '', messages: [], output: '', steps: [], working: true, starting: true, sent: false, error: '', abort: new AbortController(), base: '' };
      open.set(wid, s); paint(wid);
      try {
        const route = `/wizard/v1/agents/${encodeURIComponent(agent.id)}/incognito`;
        const response = await fetchImpl(route, { method: 'POST', credentials: 'same-origin', cache: 'no-store', headers: { 'Content-Type': 'application/json' }, body: '{}' });
        if (!response.ok) throw new Error('Unavailable');
        const result = await response.json();
        if (!/^incog_[a-f0-9]{32}$/.test(result.session_id || '')) throw new Error('Unavailable');
        s.sid = result.session_id; s.history = result.history_search; s.base = route + '/' + s.sid;
        if (!alive(wid, s)) { void destroyRemote(s); return; }
        s.starting = false; s.working = false;
        s.lease = setInterval(async () => {
          if (!win(wid) || !elOf(wid)?.querySelector('[data-incog-thread]')) { close(wid, true); return; }
          try { await request(s, '/lease', 'POST', {}); }
          catch { if (alive(wid, s)) { close(wid, true); paint(wid); toast('!', 'Incognito ended · temporary chat discarded', 3000); } }
        }, 20_000);
      } catch { if (alive(wid, s)) { s.starting = false; s.working = false; s.error = 'Incognito couldn’t start. Nothing was sent. Close this chat and try again.'; } }
      if (alive(wid, s)) paint(wid);
    }
    function render(wid, el) {
      const s = open.get(wid); if (!s || !el) return false;
      const esc = kit.esc, md = text => kit.md(text).replace(/<img\b[^>]*>/gi, '');
      const bubble = m => `<div class="msg ${m.role === 'user' ? 'u' : 'a'}"><div class="bub">${md(m.text)}</div></div>`;
      const old = el.querySelector('[data-incog-field]'), focused = !!old && old === document.activeElement;
      const selection = old ? [old.selectionStart, old.selectionEnd] : null;
      const work = s.working && !s.starting ? window.WosWork?.html({ work: [] }, { live: true, open: true, md, esc, clip: (x, n) => x.slice(0, n), key: 'incognito', streamSteps: s.steps }) || '<p role="status">Replying…</p>' : '';
      el.innerHTML = `<div class="ch-thread ch-incognito" data-incog-thread>
        <div class="ch-head"><button type="button" class="ch-back" data-incog-close aria-label="End Incognito chat">‹</button><div class="ti"><b>Incognito</b><span class="ch-privtag">Private · temporary</span></div>${!s.sent ? '<button type="button" class="pbtn ch-incog-toggle" role="switch" aria-checked="true" data-incog-off aria-label="Incognito"><span>Incognito</span><span class="sw on" aria-hidden="true"><i></i></span></button>' : ''}<button type="button" class="pbtn" data-incog-close>Close</button></div>
        <div class="ch-incog-note" role="note"><b>This chat is never saved.</b><span>Text only · microphone unavailable in Incognito. Memory edits stay temporary. App changes require your yes and remain in those apps.${s.history === 'unavailable' ? ' Past-chat search is unavailable.' : ''}</span></div>
        <div class="ch-msgs">${s.messages.map(bubble).join('')}${s.output ? bubble({ role: 'assistant', text: s.output }) : ''}${s.starting ? '<p role="status">Opening Incognito…</p>' : work}${s.error ? `<p class="ch-empty" role="alert">${esc(s.error)}${s.retry ? '<button type="button" data-incog-retry>Retry</button>' : ''}</p>` : ''}</div>
        <form class="ch-compose" data-incog-form><div class="ch-row2"><div class="ch-field"><textarea data-incog-field rows="1" placeholder="Message ${esc(s.agent.label || 'Private agent')}" aria-label="Incognito message" autocomplete="off" autocorrect="off" spellcheck="false" ${s.starting || (s.error && !s.retry) ? 'disabled' : ''}>${esc(s.draft)}</textarea></div>${s.working && !s.starting ? '<button type="button" class="ch-send" data-incog-stop aria-label="Stop Incognito reply">■</button>' : `<button type="submit" class="ch-send" aria-label="Send Incognito message" ${s.working || (s.error && !s.retry) ? 'disabled' : ''}>↑</button>`}</div></form></div>`;
      const field = el.querySelector('[data-incog-field]'); grow(field);
      if (focused && !field.disabled) { field.focus({ preventScroll: true }); field.setSelectionRange(...selection); }
      const box = el.querySelector('.ch-msgs'); box.scrollTop = box.scrollHeight;
      return true;
    }
    async function send(wid, text, retry = false) {
      const s = open.get(wid); text = String(text || '').trim();
      if (!s || s.working || (s.error && !s.retry) || !text) return false;
      s.stream?.close(); s.draft = ''; s.sent = true; s.working = true; s.error = ''; s.retry = false; s.output = ''; s.steps = []; s.lastInput = text;
      if (!retry) s.messages.push({ role: 'user', text }); paint(wid);
      try {
        const admitted = await request(s, '/v1/runs', 'POST', { input: text });
        if (!alive(wid, s)) return false;
        s.run = admitted.run_id || admitted.id;
        if (!/^[A-Za-z0-9._:-]{1,200}$/.test(s.run || '')) throw new Error('Unavailable');
        s.stream = window.WizLive?.openRunStream(s.sid, s.agent.id, s.run, snapshot => {
          if (!alive(wid, s)) return;
          s.steps = snapshot.steps || [];
          const final = typeof snapshot.result?.output === 'string' ? snapshot.result.output : snapshot.result?.output_text || '';
          // At terminal the final run read is authoritative; a partial stream may lack non-delta output.
          s.output = (snapshot.terminal && final) || snapshot.text || final;
          if (snapshot.terminal) {
            if (s.output) s.messages.push({ role: 'assistant', text: s.output });
            s.output = ''; s.working = false; s.retry = snapshot.status !== 'completed' && snapshot.status !== 'cancelled';
            s.error = snapshot.status === 'completed' ? '' : snapshot.status === 'cancelled' ? 'Reply stopped.' : 'The reply did not finish. Retry sends your message again in this temporary chat.';
            s.stream?.close();
          }
          paint(wid);
        }, { base: s.base, read: url => raw(s, url.slice(s.base.length)) });
        if (!s.stream) throw new Error('Live stream unavailable');
        return true;
      } catch { if (alive(wid, s)) { s.working = false; s.retry = true; s.error = 'The connection was lost. Retry sends the same message again here, never to a normal chat.'; paint(wid); } }
      return false;
    }
    async function stop(wid) {
      const s = open.get(wid); if (!s?.run || !s.working) return;
      try { await request(s, '/v1/runs/' + encodeURIComponent(s.run) + '/stop', 'POST', {}); }
      catch { if (alive(wid, s)) { s.error = 'Stop could not be confirmed. Close this chat to discard it.'; paint(wid); } }
    }
    function click(wid, event) {
      const s = open.get(wid); if (!s) return false;
      if (event.target.closest('[data-incog-retry]')) { void send(wid, s.lastInput, true); return true; }
      if (event.target.closest('[data-incog-stop]')) { void stop(wid); return true; }
      return false;
    }
    function input(wid, field) { const s = open.get(wid); if (!s) return false; s.draft = field.value; grow(field); return true; }
    const leave = () => { for (const wid of [...open.keys()]) { close(wid, true); paint(wid); } };
    addEventListener('pagehide', leave);
    addEventListener('pageshow', e => { if (e.persisted) leave(); });
    addEventListener('beforeunload', leave);
    function beforeNavigate(ids = []) {
      const leaving = [...open.keys()].filter(id => !ids.includes(id));
      if (!leaving.length) return true;
      if (!confirm('End incognito chat? It will be erased.')) return false;
      for (const id of leaving) { close(id, true); paint(id); }
      return true;
    }
    return { active: wid => open.has(wid), start, close, beforeNavigate, render, send, input, click, stop,
      draft: wid => open.get(wid)?.draft || '', endAll: leave };
  };
})();
