/* Wizard OS — an app's settings sheet: "Which agents can use <App>?" (#58) and "Sends its work to: [agent]"
 * (App → agent binding, wizard-os spec/AGENTS.md sections 5 and 7). Shared by both shells; the Agents app has the
 * same pickers on its agent pages.
 *
 * Which agents can use the app: one tick box per agent. A new app starts on the main agent only; an app tagged
 * `privacy: private` starts on private agents only (James, 23 Oct 2026: "the user should have to enable things
 * manually"). Everything else the owner ticks here.
 * The Agent Service writes the choice into each agent's app lists; the agent's page shows the same lists.
 * Sends its work to: only apps that declare agent_binding. Their window bar carries a small route button (the
 * agent's sigil; a red dot when that agent is stopped and the work is waiting). Default = the main agent. A
 * private agent needs no extra warning; a bound agent that is stopped says so plainly, because its work waits and
 * never goes elsewhere. Apps without a binding that agents can use get a plain settings button instead.
 *
 *   WosAppRoute.slot(appId)            window-bar markup (empty until the binding is known; repainted on change)
 *   WosAppRoute.open(appId, { name })  the settings sheet
 *   WosAppRoute.isOpen() / back()      Back closes the sheet first (true when it did)
 *   WosAppRoute.init({ openAgents })   shell hook: openAgents(id, { newPreset }) opens the Agents app at an agent
 *                                      or its New agent flow
 *   WosAppRoute.request(msg)           a trusted frame's 'wizard:app-route' message: { id } opens the sheet,
 *                                      { id, action: 'new-private-agent' } starts the private agent setup
 */
(() => {
  'use strict';
  const AG = window.WosAgents;
  if (!AG || window.WosAppRoute) return;
  const esc = AG.esc;
  const HOOK = { openAgents: null };
  let el = null, cur = null, busy = '', note = '', access = null, accessBusy = '';

  const heldText = (b, app) => {
    const who = b.target ? b.target.label : 'The agent it sends its work to';
    if (b.held === 'missing') return `${who} isn’t on this Wizard any more. Work from ${app} can’t be delivered until you pick an agent.`;
    return `${who} is ${b.held === 'error' ? 'not working' : 'stopped'}. Work from ${app} waits until it runs again. It never goes to another agent.`;
  };
  const statusWord = a => ({ running: 'Running', starting: 'Starting…', stopped: 'Stopped', error: 'Not working' }[a.status] || a.status);

  function slotInner(appId) {
    const b = AG.binding(appId);
    if (!b) {
      if (!AG.appKnown(appId)) return '';
      return `<button type="button" class="wb wroute wr-only" data-wact="route" data-route-open="${esc(appId)}" aria-label="App settings: which agents can use it" title="Which agents can use it">`
        + `<svg class="wr-gear" viewBox="0 0 24 24" aria-hidden="true"><circle cx="9" cy="9" r="3.2"/><circle cx="16.5" cy="15.5" r="2.6"/><path d="M3.5 20c.8-3 3-4.6 5.5-4.6M12.5 9h6"/></svg></button>`;
    }
    const name = b.target ? b.target.label : 'no agent';
    const label = `Sends its work to ${name}${b.held ? ` (${b.held === 'missing' ? 'missing' : 'stopped'})` : ''}`;
    return `<button type="button" class="wb wroute${b.held ? ' held' : ''}" data-wact="route" data-route-open="${esc(appId)}" aria-label="${esc(label)}" title="${esc(label)}">`
      + `<svg class="wr-arrow" viewBox="0 0 24 24" aria-hidden="true"><path d="M5 12h12M13 7l5 5-5 5"/></svg>${b.target ? AG.sigil(b.target, 'wr-sig') : '<span class="wr-sig wr-none">?</span>'}</button>`;
  }
  function slot(appId) { return appId ? `<span class="wroute-slot" data-route-slot="${esc(appId)}">${slotInner(appId)}</span>` : ''; }
  function paint() {
    for (const s of document.querySelectorAll('[data-route-slot]')) { const h = slotInner(s.dataset.routeSlot); if (s.innerHTML !== h) s.innerHTML = h; }
    if (el && cur) render();
  }

  function accessHtml(app) {
    if (!access) return AG.appKnown(cur.appId) ? '<p class="ar-note" data-access-loading>Loading agents…</p>' : '';
    const rows = (AG.visible?.() || AG.list).map(a => {
      const v = access.agents.find(x => x.id === a.id); if (!v) return '';
      const sub = [a.privacy === 'private' ? 'Private' : a.is_default ? 'Main agent' : 'Standard', statusWord(a)].join(' · ');
      return `<button type="button" class="ar-agent ar-tick${v.enabled ? ' on' : ''}" role="checkbox" aria-checked="${v.enabled}" data-access-pick="${esc(a.id)}" style="--ag:${AG.colour(a)}" ${accessBusy ? 'disabled' : ''}>`
        + `${AG.sigil(a, 'ar-sig')}<span class="tx"><b>${esc(a.label)}${a.privacy === 'private' ? `<span class="ar-lock">${AG.lock()}</span>` : ''}</b><small>${esc(sub)}</small></span><span class="cb"></span></button>`;
    }).join('');
    return `<div class="ar-sec" data-access-sec>Which agents can use ${esc(app)}?</div><div class="ar-list" role="group" aria-label="Which agents can use ${esc(app)}?" data-access>${rows || '<p class="ar-note">No agents yet.</p>'}</div>
      ${access.privacy === 'private' ? `<p class="ar-note warn" data-access-private>${esc(app)} is meant to be private.${access.needs_private_agent ? ' Set up a private agent, or tick a non-private one if you choose.' : ' Ticking a non-private agent lets it read what this app holds.'}</p>${access.needs_private_agent && HOOK.openAgents ? '<button type="button" class="ar-btn" data-access-new-private>Set up private agent</button>' : ''}` : ''}
      <p class="ar-note">A ticked agent can open and use ${esc(app)} for you. New apps start on your main agent only${access.privacy === 'private' ? '; private apps on private agents only' : ''}.</p>`;
  }
  function render() {
    const b = AG.binding(cur.appId);
    const app = (b && b.label) || cur.name || cur.appId;
    let body;
    if (!b) body = AG.appKnown(cur.appId) || access ? '' : `<p class="ar-note">${esc(app)} doesn’t send work to an agent.</p>`;
    else {
      const rows = (AG.visible?.() || AG.list).map(a => {
        const on = a.id === b.agent;
        const sub = [a.privacy === 'private' ? 'Private' : a.is_default ? 'Main agent' : 'Agent', statusWord(a)].join(' · ');
        return `<button type="button" class="ar-agent${on ? ' on' : ''}" role="radio" aria-checked="${on}" data-route-pick="${esc(a.id)}" style="--ag:${AG.colour(a)}" ${busy ? 'disabled' : ''}>`
          + `${AG.sigil(a, 'ar-sig')}<span class="tx"><b>${esc(a.label)}${a.privacy === 'private' ? `<span class="ar-lock">${AG.lock()}</span>` : ''}</b><small class="st-${esc(a.status)}">${esc(sub)}</small></span><span class="rd"></span></button>`;
      }).join('');
      body = `<div class="ar-sec">Sends its work to</div><div class="ar-list" role="radiogroup" aria-label="Sends its work to">${rows || '<p class="ar-note">No agents yet.</p>'}</div>
        ${b.held ? `<p class="ar-note bad" data-route-held>${esc(heldText(b, app))}</p>` : ''}
`;
    }
    el.innerHTML = `<div class="ar-card" role="dialog" aria-modal="true" aria-label="${esc(app)} settings">
      <div class="ar-head"><b>${esc(app)}</b><small>${esc((b && b.purpose) || (b ? 'Work from this app goes to one agent.' : 'App settings'))}</small></div>
      ${accessHtml(app)}
      ${body}
      ${note ? `<p class="ar-note ${note.startsWith('!') ? 'bad' : 'ok'}" role="status">${esc(note.replace(/^!/, ''))}</p>` : ''}
      ${b ? `<p class="ar-foot">${b.is_default ? 'Default: your main agent. ' : ''}Change it any time. The app never picks an agent itself.</p>` : ''}
      <div class="ar-acts">${HOOK.openAgents ? '<button type="button" class="ar-btn ghost" data-route-agents>Agents</button>' : ''}<button type="button" class="ar-btn" data-route-close>Done</button></div></div>`;
  }
  function open(appId, o = {}) {
    if (!appId) return false;
    cur = { appId, name: o.name || '' }; note = ''; busy = ''; access = null; accessBusy = '';
    if (!el) { el = document.createElement('div'); el.className = 'aroute'; el.dataset.routeSheet = ''; document.body.appendChild(el); }
    render(); requestAnimationFrame(() => el && el.classList.add('open'));
    Promise.all([AG.load(true), AG.loadBindings(true), AG.loadOptions().catch(() => null)]).then(() => loadAccess()).then(() => { if (el && cur) render(); });
    return true;
  }
  async function loadAccess() { const id = cur?.appId; if (!id) return; const v = await AG.appAgents(id); if (cur?.appId === id) access = v; }
  function close() { if (!el) return false; el.remove(); el = null; cur = null; access = null; return true; }
  const tellFrames = () => { for (const f of document.querySelectorAll('iframe')) { try { f.contentWindow?.postMessage({ type: 'wizard:bindings-changed' }, location.origin); } catch (_) {} } };
  async function toggleAccess(agentId) {
    if (!cur || !access || accessBusy) return;
    const appId = cur.appId, app = (AG.binding(appId)?.label) || cur.name || appId;
    const v = access.agents.find(x => x.id === agentId); if (!v) return;
    const want = access.agents.filter(x => x.id === agentId ? !x.enabled : x.enabled).map(x => x.id);
    accessBusy = agentId; v.enabled = !v.enabled; note = ''; render();
    const a = AG.get(agentId);
    try { const next = await AG.setAppAgents(appId, want); if (cur?.appId === appId) access = next.agents.length ? { ...access, ...next } : access; /* PUT may omit privacy: keep the sheet's private note */ note = `${a ? a.label : agentId} ${v.enabled ? 'can' : 'can’t'} use ${app} now.`; }
    catch (e) { v.enabled = !v.enabled; note = `!Not changed · ${e.message}`; }
    accessBusy = ''; if (el) render(); paint(); tellFrames();
  }
  async function pick(agentId) {
    const b = cur && AG.binding(cur.appId); if (!b || busy || agentId === b.agent) return;
    busy = agentId; note = ''; render();
    try { const v = await AG.setBinding(cur.appId, agentId); const a = AG.get(v?.agent || agentId); note = `${b.label} now sends its work to ${a ? a.label : agentId}.`; }
    catch (e) { note = `!Not changed · ${e.message}`; }
    busy = ''; if (el) render(); paint();
    // Open System / Agents windows show the same routes: tell them to look again.
    tellFrames();
  }
  // Capture: the window bar's own handlers (double-tap to fill, drag) never see a route tap.
  document.addEventListener('click', e => {
    const t = e.target.closest && e.target.closest('[data-route-open], [data-route-pick], [data-access-pick], [data-route-close], [data-route-agents], [data-access-new-private], .aroute');
    if (!t) return;
    if (t.dataset.routeOpen != null) { e.stopPropagation(); e.preventDefault(); open(t.dataset.routeOpen); return; }
    if (t.dataset.routePick != null) { e.stopPropagation(); pick(t.dataset.routePick); return; }
    if (t.dataset.accessPick != null) { e.stopPropagation(); toggleAccess(t.dataset.accessPick); return; }
    if (t.dataset.routeClose != null) { e.stopPropagation(); close(); return; }
    if (t.dataset.accessNewPrivate != null) { e.stopPropagation(); close(); HOOK.openAgents?.(null, { newPreset: 'private' }); return; }
    if (t.dataset.routeAgents != null) { e.stopPropagation(); const id = AG.binding(cur?.appId)?.agent; close(); HOOK.openAgents?.(id); return; }
    if (t.classList.contains('aroute') && e.target === t) { e.stopPropagation(); close(); }
  }, true);
  document.addEventListener('pointerdown', e => { if (e.target.closest && e.target.closest('[data-route-open]')) e.stopPropagation(); }, true);
  AG.onChange(paint);
  function request(d) {
    if (!d || typeof d.id !== 'string') return;
    if (d.action === 'new-private-agent') { HOOK.openAgents?.(null, { newPreset: 'private' }); return; }
    open(d.id);
  }
  window.WosAppRoute = { slot, paint, open, close, request, isOpen: () => !!el, back: close, init(o = {}) { if (typeof o.openAgents === 'function') HOOK.openAgents = o.openAgents; }, get current() { return cur && { ...cur }; } };
})();
