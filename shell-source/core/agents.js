/* Wizard OS — agents (Agents MVP, Lane B). Shared by both shells and the Agents app.
 *
 * One Wizard can run several agents. Each agent has its own harness (Hermes first), model provider, permissions
 * and its own chats. The Agent Service owns the truth:
 *   GET  /wizard/v1/agents                 → { agents: [{ id, label, harness, privacy, appearance:{glyph,hue},
 *                                              model:{provider,model,allowed_models,fallback}, permissions,
 *                                              status, status_detail, is_default }] }
 *   GET  /wizard/v1/agent-options          → { harnesses, providers:[{id,label,confidential,models}], presets,
 *                                              wizard_apps, agent_apps, outside_tools }
 *   POST /wizard/v1/agents, GET/PATCH /wizard/v1/agents/<id>, POST /wizard/v1/agents/<id>/start|stop
 * Threads and runs take agent=<id>; a thread carries agent:{id,label,privacy,appearance} from server metadata.
 *
 * The default agent (is_default, normally id "hermes") is the Wizard's main agent: its chats are the ordinary
 * Chats window's All focus. A persisted per-window Focus selects All, an agent or a subject.
 * Agent focus reuses the scoped list/composer route; legacy w.agent windows migrate into the main window.
 *
 *   WosAgents.load(force)        → Promise<agents[]> (404/absent API → [] and available=false)
 *   WosAgents.list / ready / available / error
 *   WosAgents.get(id), defaultId(), isOther(id), others()
 *   WosAgents.colour(a), glyph(a), sigil(a, cls), lock(), badge(a, opts)
 *   WosAgents.modelOptions(a)    → picker options limited to the agent's allowed_models
 *   WosAgents.modelName(a, model), providerLabel(id)
 *   WosAgents.loadOptions(force) → Promise<agent-options>
 *   WosAgents.onChange(fn)
 *
 * App → agent binding (wizard-os spec/AGENTS.md): an installed app that makes work for an agent (recording recaps,
 * reports, automations) declares agent_binding; the owner picks which agent it sends its work to. No entry = the main
 * agent. A bound agent that is stopped holds the work: it never falls back to another agent.
 *   GET /wizard/v1/app-bindings            → { bindings: [{ app_id, label, purpose, required, agent, is_default, problem? }] }
 *   GET/PUT /wizard/v1/apps/<app_id>/binding  PUT { agent } → { binding: <the same view> }
 *   agents carry bound_apps: [{ id, label, purpose }]   (without the list endpoint the bindings come from these)
 *   WosAgents.loadBindings(force) → Promise<views[]>; bindings / bindingsAvailable
 *   WosAgents.binding(appId)      → { app_id, label, purpose, agent, is_default, problem, target, held } | null
 *                                    target = the agent object; held = the work waits (agent missing/stopped/error)
 *   WosAgents.setBinding(appId, agentId) → Promise<view> (throws Error with .check on refusal)
 *
 * Which agents can use an app (#58, spec/AGENTS.md section 5): separate from the binding. Standard agents start
 * ticked, private agents unticked; the gateway serves an agent only its own apps.
 *   GET/PUT /wizard/v1/apps/<app_id>/agents   → { app_id, kind, agents: [{ id, label, privacy, enabled }] }; PUT { agents: [ids] }
 *   WosAgents.appKnown(appId)        → true when the Agent Service offers the app to agents (agent-options)
 *   WosAgents.appAgents(appId)       → Promise<{ kind, privacy, needs_private_agent, agents:[{ id, enabled }] } | null>
 *                                      (falls back to permissions). privacy 'private' = the app's optional wizard.md tag.
 *   WosAgents.setAppAgents(appId, ids) → Promise<same> (reloads the agents so their pages stay in sync)
 */
(() => {
  'use strict';
  if (window.WosAgents) return;
  const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const ID = /^[a-z0-9][a-z0-9-]{0,40}$/;
  const listeners = new Set();
  const A = {
    list: [], ready: false, available: false, error: '', at: 0, loading: null, options: null, optionsAt: 0,
    bindings: [], bindingsAvailable: false, bindingsFromList: false, bindingsAt: 0, bindingsLoading: null,
    onChange(fn) { listeners.add(fn); return () => listeners.delete(fn); },
    emit() { A.refreshTitlebars(); for (const fn of listeners) { try { fn(A); } catch (e) { console.error(e); } } },
    load(force) {
      if (A.loading) return A.loading;
      if (!force && A.ready && Date.now() - A.at < 30e3) return Promise.resolve(A.list);
      A.loading = fetch('/wizard/v1/agents', { cache: 'no-store', credentials: 'same-origin' })
        .then(async r => {
          if (r.status === 404) { A.available = false; return []; }
          if (!r.ok) throw Object.assign(new Error(`Agents unavailable (${r.status})`), { status: r.status });
          A.available = true;
          const j = await r.json();
          return (Array.isArray(j?.agents) ? j.agents : []).map(clean).filter(Boolean);
        })
        .then(list => { const before = JSON.stringify(A.list); A.list = list; A.ready = true; A.error = ''; A.at = Date.now(); if (JSON.stringify(list) !== before) A.emit(); return list; })
        .catch(e => { A.error = String(e.message || e); A.ready = true; A.emit(); return A.list; })
        .finally(() => { A.loading = null; });
      return A.loading;
    },
    loadOptions(force) {
      if (!force && A.options && Date.now() - A.optionsAt < 60e3) return Promise.resolve(A.options);
      return fetch('/wizard/v1/agent-options', { cache: 'no-store', credentials: 'same-origin' })
        .then(r => { if (!r.ok) throw Object.assign(new Error(`Agent options unavailable (${r.status})`), { status: r.status }); return r.json(); })
        .then(j => { const first = !A.options; A.options = j && typeof j === 'object' ? j : {}; A.optionsAt = Date.now(); if (first) A.emit(); return A.options; });
    },
    loadBindings(force) {
      if (A.bindingsLoading) return A.bindingsLoading;
      if (!force && A.bindingsAt && Date.now() - A.bindingsAt < 30e3) return Promise.resolve(A.bindings);
      A.bindingsLoading = fetch('/wizard/v1/app-bindings', { cache: 'no-store', credentials: 'same-origin' })
        .then(async r => {
          if (r.ok) { const j = await r.json(); A.bindingsFromList = true; return (Array.isArray(j?.bindings) ? j.bindings : Array.isArray(j?.apps) ? j.apps : []).map(cleanBinding).filter(Boolean); }
          if (r.status !== 404) throw new Error(`App routing unavailable (${r.status})`);
          // No list endpoint: the agents' own bound_apps say the same thing.
          A.bindingsFromList = false;
          if (!A.ready) await A.load();
          return A.list.flatMap(a => a.bound_apps.map(x => ({ app_id: x.id, label: x.label, purpose: x.purpose, required: false, agent: a.id, is_default: !!a.is_default, problem: '' })));
        })
        .then(list => { const before = JSON.stringify(A.bindings); A.bindings = list; A.bindingsAvailable = A.bindingsFromList || list.length > 0; A.bindingsAt = Date.now(); if (JSON.stringify(list) !== before) A.emit(); return list; })
        .catch(() => A.bindings)
        .finally(() => { A.bindingsLoading = null; });
      return A.bindingsLoading;
    },
    binding(appId) {
      const v = A.bindings.find(b => b.app_id === appId); if (!v) return null;
      const target = A.get(v.agent);
      const held = !target ? 'missing' : ['stopped', 'error'].includes(target.status) ? target.status : '';
      return { ...v, target, held };
    },
    async setBinding(appId, agentId) {
      const r = await fetch(`/wizard/v1/apps/${encodeURIComponent(appId)}/binding`, { method: 'PUT', cache: 'no-store', credentials: 'same-origin', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ agent: agentId }) });
      let j = null; try { j = await r.json(); } catch (_) {}
      if (!r.ok) {
        const code = typeof j?.error === 'string' ? j.error : '';
        const human = /^[a-z0-9_]+$/.test(code) ? (code[0].toUpperCase() + code.slice(1)).replace(/_/g, ' ') : code || `Request failed (${r.status})`;
        throw Object.assign(new Error(human + (j?.check ? ` (${j.check})` : '')), { status: r.status, check: j?.check || '' });
      }
      const v = cleanBinding(j && j.binding ? j.binding : j);
      if (v) { const i = A.bindings.findIndex(b => b.app_id === appId); if (i >= 0) A.bindings[i] = v; else A.bindings.push(v); }
      await Promise.all([A.load(true), A.loadBindings(true)]);
      A.emit();
      return v;
    },
    get(id) { return A.list.find(a => a.id === id) || null; },
    defaultId() { return (A.list.find(a => a.is_default) || {}).id || 'hermes'; },
    // A non-default agent: its threads, sends and models never go through the main agent's route.
    isOther(id) { return !!id && id !== A.defaultId(); },
    visible() { return A.list.filter(a => !a.hidden); },
    others() { return A.visible().filter(a => !a.is_default); },
    hue(a) {
      let h = Number(a?.appearance?.hue);
      if (!Number.isFinite(h)) {
        // Stable identity for future agents without a chosen hue.
        h = a?.privacy === 'private' ? 160 : !a || a.is_default ? 265
          : Array.from(String(a.id || a.label || 'agent')).reduce((n, c) => (n * 31 + c.codePointAt(0)) % 360, 0);
      }
      return ((Math.round(h) % 360) + 360) % 360;
    },
    // Every agent on this Wizard gets a colour you can tell apart: the main agent keeps its hue, then each agent in
    // order keeps its own unless it sits within 28° of one already taken, in which case it steps round the wheel.
    distinctHues() {
      const list = A.list || [];
      if (A._hueFor === list) return A._hues;
      const taken = [], out = new Map(), gap = (x, y) => { const d = Math.abs(x - y) % 360; return Math.min(d, 360 - d); };
      const order = [...list].sort((x, y) => (y.is_default ? 1 : 0) - (x.is_default ? 1 : 0));
      for (const ag of order) {
        let h = A.hue(ag);
        for (let i = 0; i < 24 && taken.some(t => gap(t, h) < 28); i++) h = (h + 47) % 360;
        taken.push(h); out.set(ag.id, h);
      }
      A._hueFor = list; A._hues = out;
      return out;
    },
    colour(a) {
      const h = (a?.id && A.distinctHues().get(a.id)) ?? A.hue(a);
      return `hsl(${h} 72% 62%)`;
    },
    glyph(a) {
      // Agents share the company hat; privacy changes its cutout, hue identifies the agent.
      return A.isPrivate(a) ? 'hat-private' : 'hat';
    },
    sigil(a, cls = 'ag-sig') {
      const g = A.glyph(a), c = A.colour(a);
      if (window.WizSigil) return window.WizSigil.chip('span', cls, g || initial(a), c);
      return `<span class="${cls} sgt" style="--c:${c}">${esc(initial(a))}</span>`;
    },
    title(a) {
      const label = String(a?.label || 'Hermes').trim();
      if (/\bagent$/i.test(label)) return label;
      return `${label} ${a?.is_default ? 'Main Agent' : 'Agent'}`;
    },
    titleRecord(id) {
      return A.get(id || A.defaultId()) || { id: id || 'hermes', label: id || 'Hermes', is_default: !id, appearance: {} };
    },
    titleContent(id, iconClass, titleClass, label = '') {
      const a = A.titleRecord(id);
      return A.sigil(a, iconClass) + `<span class="${titleClass}" style="color:var(--ink)">${esc(label || A.title(a))}</span>`;
    },
    titlebar(id = '', iconClass = 'ic', titleClass = 't') {
      return `<span class="agent-titlebar" data-agent-titlebar="${esc(id)}" data-icon-class="${iconClass}" data-title-class="${titleClass}">${A.titleContent(id, iconClass, titleClass)}</span>`;
    },
    setTitlebarLabel(el, label = '') {
      if (!el) return;
      el.dataset.titleLabel = label;
      const html = A.titleContent(el.dataset.agentTitlebar, el.dataset.iconClass, el.dataset.titleClass, label);
      if (el.innerHTML !== html) el.innerHTML = html;
    },
    refreshTitlebars() {
      // Registry updates only repaint the small identity wrapper, preserving drafts and scroll position.
      document.querySelectorAll('[data-agent-titlebar]').forEach(el => {
        const html = A.titleContent(el.dataset.agentTitlebar, el.dataset.iconClass, el.dataset.titleClass, el.dataset.titleLabel);
        if (el.innerHTML !== html) el.innerHTML = html;
      });
    },
    lock() { return '<svg class="ag-lock" viewBox="0 0 24 24" aria-hidden="true"><rect x="5" y="10.5" width="14" height="10" rx="2.2"/><path d="M8.5 10.5V7.8a3.5 3.5 0 0 1 7 0v2.7"/></svg>'; },
    isPrivate(a) { return a?.privacy === 'private'; },
    // The persistent "which agent is this" strip for Chats (list and thread, phone and desktop).
    badge(a, { where = 'list', model = '' } = {}) {
      if (!a) return '';
      const priv = A.isPrivate(a);
      const sub = [priv ? 'Private agent' : a.is_default ? 'Main agent' : 'Agent', model || A.modelName(a, a.model?.model)].filter(Boolean).join(' · ');
      return `<div class="ch-agent${priv ? ' private' : ''} ${where}" style="--ag:${A.colour(a)}" data-chagent="${esc(a.id)}" role="note" aria-label="${esc(`You are talking to ${a.label}${priv ? ', a private agent' : ''}`)}">`
        + `${A.sigil(a, 'ag-sig')}<span class="ag-t"><b>${esc(a.label)}</b><small>${esc(sub)}</small></span>${priv ? `<span class="ag-priv">${A.lock()}<span>Private</span></span>` : ''}</div>`;
    },
    providerLabel(id) {
      const p = (A.options?.providers || []).find(x => x.id === id);
      if (id === 'host') return 'Your Wizard’s setup'; // the main agent runs the host Hermes configuration
      return A.cleanProvider(p?.label || (id === 'tinfoil' ? 'Tinfoil' : String(id || '')));
    },
    // "Tinfoil (confidential)" → "Tinfoil": the UI says Confidential once, as its own badge or suffix.
    cleanProvider(label) { return String(label || '').replace(/\s*[(·-]\s*confidential\s*\)?\s*$/i, '').trim() || String(label || ''); },
    appKnown(appId) { const o = A.options || {}; return [...(o.wizard_apps || []), ...(o.agent_apps || [])].some(x => x && (x.id === appId || x === appId)); },
    async appAgents(appId) {
      try {
        const r = await fetch(`/wizard/v1/apps/${encodeURIComponent(appId)}/agents`, { cache: 'no-store', credentials: 'same-origin' });
        if (r.ok) { const j = await r.json(); if (Array.isArray(j?.agents)) return { kind: String(j.kind || ''), privacy: j.privacy === 'private' ? 'private' : 'standard', needs_private_agent: j.needs_private_agent === true, agents: j.agents.filter(x => x && typeof x.id === 'string').map(x => ({ id: x.id, enabled: x.enabled === true })) }; }
        if (r.status === 404 && (await r.clone().json().catch(() => null))?.check === 'app.id') return null;
      } catch (_) {}
      // Older Agent Service: the agents' own app lists say the same thing.
      if (!A.ready) await A.load();
      if (!A.appKnown(appId)) return null;
      return { kind: '', agents: A.list.map(a => ({ id: a.id, enabled: [...(a.permissions.wizard_apps || []), ...(a.permissions.agent_apps || [])].includes(appId) })) };
    },
    async setAppAgents(appId, ids) {
      const r = await fetch(`/wizard/v1/apps/${encodeURIComponent(appId)}/agents`, { method: 'PUT', cache: 'no-store', credentials: 'same-origin', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ agents: ids }) });
      let j = null; try { j = await r.json(); } catch (_) {}
      if (!r.ok) {
        const code = typeof j?.error === 'string' ? j.error : '';
        const human = /^[a-z0-9_]+$/.test(code) ? (code[0].toUpperCase() + code.slice(1)).replace(/_/g, ' ') : code || `Request failed (${r.status})`;
        throw Object.assign(new Error(human + (j?.check ? ` (${j.check})` : '')), { status: r.status, check: j?.check || '' });
      }
      await A.load(true); A.emit();
      const out = { kind: String(j?.kind || ''), agents: (j?.agents || []).map(x => ({ id: x.id, enabled: x.enabled === true })) };
      if (j && 'privacy' in j) out.privacy = j.privacy === 'private' ? 'private' : 'standard';
      if (j && 'needs_private_agent' in j) out.needs_private_agent = j.needs_private_agent === true;
      return out;
    },
    modelName(a, model) {
      if (!model) return '';
      const p = (A.options?.providers || []).find(x => x.id === a?.model?.provider);
      const m = (p?.models || []).map(v => typeof v === 'string' ? { id: v } : v || {}).find(v => (v.id || v.value || v.model) === model);
      if (m?.label || m?.name) return m.label || m.name;
      if (window.WosModels?.find?.(model)) return window.WosModels.name(model);
      return friendly(model);
    },
    // The model picker in an agent's chats: only that agent's allowed models, on its own provider.
    modelOptions(a) {
      if (!a?.model) return [];
      const allowed = Array.isArray(a.model.allowed_models) && a.model.allowed_models.length ? a.model.allowed_models : [a.model.model].filter(Boolean);
      return allowed.map(m => ({ value: m, provider: a.model.provider, agent: a.id, name: A.modelName(a, m), description: A.providerLabel(a.model.provider) + (a.model.fallback === false ? ' · no fallback' : ''), isGlobalDefault: m === a.model.model }));
    },
    allows(a, model) { return A.modelOptions(a).some(o => o.value === model); },
    route(a, model) {
      if (!a?.model) return null;
      const m = model && A.allows(a, model) ? model : a.model.model;
      return m ? { model: m, provider: a.model.provider, agent: a.id } : null;
    },
    friendly, esc,
  };
  function initial(a) { return String(a?.label || a?.id || '?').trim().charAt(0).toUpperCase() || '?'; }
  function friendly(model) {
    const m = String(model || '');
    const g = /^glm-(\d+)-(\d+)$/i.exec(m); if (g) return `GLM ${g[1]}.${g[2]}`;
    return m.replace(/[-_]+/g, ' ').replace(/\b\w/g, l => l.toUpperCase());
  }
  function clean(a) {
    if (!a || typeof a !== 'object' || !ID.test(String(a.id || ''))) return null;
    const model = a.model && typeof a.model === 'object' ? a.model : {};
    return {
      id: a.id, label: String(a.label || a.id).slice(0, 60), harness: String(a.harness || 'hermes'),
      privacy: a.privacy === 'private' ? 'private' : 'standard',
      incognito_available: a.incognito_available === true,
      appearance: { glyph: String(a.appearance?.glyph || ''), hue: Number.isFinite(Number(a.appearance?.hue)) ? Number(a.appearance.hue) : null },
      model: { provider: String(model.provider || ''), model: String(model.model || ''), allowed_models: Array.isArray(model.allowed_models) ? model.allowed_models.map(String) : [], fallback: model.fallback !== false },
      permissions: a.permissions && typeof a.permissions === 'object' ? a.permissions : {},
      status: ['running', 'stopped', 'starting', 'error'].includes(a.status) ? a.status : 'stopped',
      status_detail: String(a.status_detail || ''), is_default: a.is_default === true, hidden: a.hidden === true,
      bound_apps: (Array.isArray(a.bound_apps) ? a.bound_apps : []).map(x => typeof x === 'string' ? { id: x } : x).filter(x => x && typeof x.id === 'string' && x.id)
        .map(x => ({ id: x.id, label: String(x.label || x.name || x.id).slice(0, 60), purpose: String(x.purpose || '').slice(0, 160) })),
    };
  }
  function cleanBinding(v) {
    const id = v && (v.app_id || v.id);
    if (typeof id !== 'string' || !id) return null;
    return { app_id: id, label: String(v.label || v.name || id).slice(0, 60), purpose: String(v.purpose || '').slice(0, 160), required: v.required === true,
      agent: typeof v.agent === 'string' && v.agent ? v.agent : (v.agent?.id || 'hermes'), is_default: v.is_default === true, problem: String(v.problem || '') };
  }
  window.WosAgents = A;
  // The shells refresh the list in the background; the Agents app loads it on demand.
  if (document.documentElement.dataset.leaving) return;
  if (!/\/agents\//.test(location.pathname)) {
    A.load().then(() => A.loadBindings());
    A.loadOptions().catch(() => {});
    setInterval(() => { if (!document.hidden) A.load(true).then(() => A.loadBindings(true)); }, 30e3);
  }
})();
