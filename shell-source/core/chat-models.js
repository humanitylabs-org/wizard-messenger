/* Wizard UX core: model choices for Chats (#11). Shared by every shell.
 *
 * Port of wizard-mobile ff86db8c normalizers.ts normalizeModels + modelChoices.ts visibleModelChoices:
 *  - Hermes is the source of truth for the default: the top-level `model` + `provider` of
 *    GET /wizard/hermes/api/model/options. Never hard-coded, never inferred from catalogue order.
 *  - The picker offers the configured provider's models plus the authenticated subscription routes,
 *    one newest choice per model family ("More models" shows the full catalogue).
 *  - A thread's route changes with POST /wizard/hermes/api/sessions/:id/model { model, provider }.
 *  - A new chat starts on the Hermes default; a picker change only lasts for that unsent draft.
 *
 *   WosModels.load(force)            → Promise<options[]>   (cached 5 min)
 *   WosModels.options / ready / error
 *   WosModels.defaultOption()        → the Hermes global default option, or null
 *   WosModels.find(model, provider)  → option or null (provider optional)
 *   WosModels.visible(model, prov)   → presentation list (one per family)
 *   WosModels.short(model, provider) → 'Opus', 'Sol', 'GLM 5 3'…
 *   WosModels.name(model, provider)  → 'Claude Opus', …
 *   WosModels.setThreadModel(sid, o) → Promise (throws on failure)
 *   WosModels.sheetHtml(o)           → the picker sheet
 *   WosModels.failureHtml(o)         → the recovery panel for a failed thread
 */
(() => {
  'use strict';
  const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const str = (...v) => v.find(x => typeof x === 'string') ?? '';
  const arr = v => (Array.isArray(v) ? v : []);
  const obj = v => (v && typeof v === 'object' && !Array.isArray(v) ? v : {});

  const SUB = 'claude-subscription-directsdk-experimental';
  const CLAUDE_PROVIDERS = new Set([SUB, 'anthropic']);
  const SUBSCRIPTIONS = ['openai-codex', SUB];
  // Connection metadata only: native subscriptions belong to Hermes' Anthropic pool,
  // not the legacy Claude Code login. An unavailable connector leaves legacy intact.
  const nativeClaudeAccounts = connection => arr(obj(connection).accounts).filter(a =>
    a && a.id !== 'legacy-claude-code' && a.source !== 'legacy-claude-code');
  // A quota-limited grant is still installed in Hermes' pool. Dropping its route
  // from the picker would silently steer the owner onto the single-login legacy route.
  const hasNativeClaude = connection => nativeClaudeAccounts(connection).some(a =>
    ['ready', 'ok', 'connected', 'exhausted', 'rate_limited'].includes(a.status));
  const accountAtLimit = a => {
    if (!a || !['ready', 'ok', 'connected', 'exhausted', 'rate_limited'].includes(a.status)) return false;
    if (['exhausted', 'rate_limited'].includes(a.status)) return true;
    const usage = obj(a.usage);
    const fetched = Date.parse(usage.fetchedAt);
    if (!Number.isFinite(fetched) || Math.abs(Date.now() - fetched) > 15 * 60e3) return false;
    return arr(usage.limits).some(limit =>
      (limit.id === 'session:session' || limit.id === 'weekly_all:weekly') &&
      Number(limit.usedPercent) >= 100 && Number(limit.remainingPercent) <= 0);
  };
  const claudeLimitNote = connection => {
    const accounts = arr(obj(connection).accounts);
    // The connector can say connected/ok even when a fresh usage meter is full.
    // A model-specific allowance may remain, so never claim all Claude models are out.
    return accounts.length && accounts.every(accountAtLimit)
      ? 'Every listed Claude account reports a limit. Changing accounts alone may not restore this model; another model may still be available.' : '';
  };
  const CLAUDE_ORDER = ['fable', 'opus', 'sonnet', 'haiku'];
  const GPT_ORDER = ['astra', 'sol', 'terra', 'luna', 'codex-spark'];
  // The models closest to the thumb in the compact model menu (James 18 Oct 2026). Everything else is one tap away.
  const PRIMARY = [{ family: 'claude:opus', name: 'Opus' }, { family: 'claude:sonnet', name: 'Sonnet' }, { family: 'gpt:astra', name: 'Astra' }, { family: 'gpt:sol', name: 'Sol' }, { family: 'tinfoil', name: '' }];
  const isTinfoil = provider => provider === 'wizard-tinfoil' || provider === 'custom:wizard-tinfoil';
  /* Miguel's skins (Dark, Light, Landscapes) carry his model UX: the private Tinfoil slot, its setup row and the bottom
   * switch. James's skins keep the stock compact menu, so none of this shows there (team rule: taste lives in your skin). */
  const ours = () => typeof document !== 'undefined' && (document.documentElement.dataset.tweaks || '').split(' ').includes('miguel/model-pills');
  const primaryFamilies = () => ours() ? PRIMARY : PRIMARY.filter(p => p.family !== 'tinfoil');
  const shown = list => ours() ? list : list.filter(o => !isTinfoil(o.provider));
  /* Unified Chats: once a private agent offers models in the main picker, a confidential (Tinfoil) choice means the
   * private agent. The main agent's own Tinfoil route is hidden there so a locked GLM never lands in the shared
   * history; a thread already on it still shows its current model. */
  const keepMainOption = (o, privList, isCur) => !privList.length || !isTinfoil(o.provider) || Boolean(isCur && isCur(o));
  const cap = s => s ? s[0].toUpperCase() + s.slice(1) : s;
  /* Private (Tinfoil) routes show the model's own identifier, name + version like Opus 5.5: kimi-k3 → Kimi · K3,
   * glm-5-3 → GLM · 5.3, gpt-oss-120b → GPT OSS · 120B. The privacy colour, not a provider name, marks them private. */
  const UPPER = new Set(['glm', 'gpt', 'oss', 'qwen3', 'tts']);
  function privateName(model) {
    const toks = String(model || '').replace(/\[.*$/, '').split(/[-_]/).filter(Boolean);
    const word = p => UPPER.has(p.toLowerCase()) ? p.toUpperCase() : cap(p.toLowerCase());
    const isVer = p => /^(\d+|[kv]\d+|\d+b)$/i.test(p);
    const name = [], ver = [];
    toks.forEach((p, k) => {
      const lead = k === 0 && /^([a-z]+)(\d+)$/i.exec(p);
      if (lead && !UPPER.has(p.toLowerCase())) { name.push(word(lead[1])); ver.push(lead[2]); return; }
      if (!ver.length && !isVer(p)) { name.push(word(p)); return; }
      const prev = ver[ver.length - 1];
      if (/^\d+$/.test(p) && prev && /^([kv]?\d+(\.\d+)*)$/i.test(prev)) ver[ver.length - 1] = prev + '.' + p;
      else ver.push(/^\d+b$/i.test(p) || /^[kv]\d+$/i.test(p) ? p.toUpperCase() : /^\d+$/.test(p) ? p : word(p));
    });
    return { name: name.join(' '), version: ver.join(' ') };
  }

  const claudeFamily = (model, provider) => (!provider || CLAUDE_PROVIDERS.has(provider)) ? /^claude-(fable|opus|sonnet|haiku)(?:-|$)/i.exec(model)?.[1].toLowerCase() : undefined;
  const claudeName = (model, provider) => { const f = provider && claudeFamily(model, provider); return f ? `Claude ${cap(f)}` : undefined; };
  const routeLabel = provider => provider === SUB ? 'Claude subscription' : provider === 'anthropic' ? 'Anthropic API' : undefined;
  const KNOWN = { 'gpt-6-astra': 'Astra', 'gpt-6-astra-900k': 'Astra · 900K', 'gpt-6-sol': 'Sol', 'gpt-6-sol-900k': 'Sol · 900K', 'gpt-6-luna': 'Luna', 'gpt-6-luna-900k': 'Luna · 900K',
    'gpt-5.6-sol': 'Sol', 'gpt-5.6-sol-900k': 'Sol · 900K', 'gpt-5.6-terra': 'Terra', 'gpt-5.6-terra-900k': 'Terra · 900K', 'gpt-5.6-luna': 'Luna', 'gpt-5.6-luna-900k': 'Luna · 900K',
    'gpt-5.5': 'GPT-5.5', 'gpt-5.4-mini': 'GPT-5.4 Mini', 'gpt-5.3-codex-spark': 'Codex Spark' };
  const friendly = model => KNOWN[model] ?? String(model).replace(/^gpt-/i, 'GPT ').replace(/[-_]+/g, ' ').replace(/\b\w/g, l => l.toUpperCase());

  function gptFamily(model, provider) {
    if (provider !== 'openai-codex') return undefined;
    const base = model.replace(/-900k$/i, '').toLowerCase();
    if (/codex-spark/.test(base)) return 'gpt:codex-spark';
    const tier = /^gpt-[\d.]+-(astra|sol|terra|luna)$/.exec(base)?.[1];
    if (tier) return `gpt:${tier}`;
    if (/^gpt-[\d.]+$/.test(base)) return 'gpt:plain';
    return undefined;
  }
  const family = (model, provider) => { if (isTinfoil(provider)) return 'tinfoil'; const c = provider && CLAUDE_PROVIDERS.has(provider) ? claudeFamily(model, provider) : undefined; return c ? `claude:${c}` : gptFamily(model, provider); };
  const generation = m => Number(/^gpt-([\d.]+)/i.exec(m)?.[1] ?? 0);
  const versionKey = m => m.replace(/\[.*$/, '').replace(/-900k$/i, '').replace(/-\d{8}$/, '');
  const longTwin = m => /-900k$/i.test(m);

  /* normalizers.ts normalizeModels (direct routes only; Wizard UX has no private operator runtime). */
  function normalize(payload, nativeClaude = false) {
    const root = obj(payload);
    const providers = arr(root.providers).map(obj);
    const curProvider = str(root.provider), curModel = str(root.model);
    const provider = providers.find(p => str(p.slug) === curProvider || (p.is_user_defined === true && `custom:${str(p.slug)}` === curProvider)) || providers.find(p => p.is_current === true) || providers.find(p => p.authenticated === true && arr(p.models).length > 0);
    if (provider) {
      const pslug = str(provider.slug), pname = str(provider.name) || pslug;
      const currentSlug = provider.is_user_defined === true && !pslug.startsWith('custom:') ? `custom:${pslug}` : pslug;
      const defProvider = !curProvider || curProvider === pslug ? currentSlug : curProvider;
      const visible = [provider, ...providers.filter(p => str(p.slug) !== pslug && (SUBSCRIPTIONS.includes(str(p.slug)) || (nativeClaude && p.slug === 'anthropic') || p.is_user_defined === true) && p.authenticated === true)];
      const options = visible.flatMap(vp => {
        const slug = str(vp.slug), name = str(vp.name) || slug;
        const route = vp.is_user_defined === true && !slug.startsWith('custom:') ? `custom:${slug}` : slug;
        return arr(vp.models).map(v => {
          const it = obj(v), model = typeof v === 'string' ? v : str(it.value, it.id, it.model);
          if (!model) return null;
          return { value: model, provider: route, ...(nativeClaude && slug === 'anthropic' ? { nativeClaude: true } : {}), isGlobalDefault: model === curModel && (slug === defProvider || route === defProvider),
            name: claudeName(model, slug) || str(it.name, it.display_name, it.label) || friendly(model),
            description: nativeClaude && slug === 'anthropic' ? 'Claude subscription · Hermes pool' : nativeClaude && slug === SUB ? 'Claude subscription · legacy Claude Code' : routeLabel(slug) || str(it.description) || name };
        }).filter(Boolean);
      });
      const unique = [...new Map(options.map(o => [JSON.stringify([o.provider, o.value]), o])).values()];
      // The configured route is authoritative even when a static catalogue lags.
      if (curModel && currentSlug === defProvider && !unique.some(o => o.value === curModel && o.provider === defProvider))
        unique.unshift({ value: curModel, provider: currentSlug, isGlobalDefault: true, name: claudeName(curModel, pslug) || friendly(curModel), description: pname });
      // A default on the legacy Claude Code login (one subscription, no rotation) moves to the ready
      // Hermes pool's same model, so new chats don't lock onto an exhausted login. Explicit thread picks stay.
      const legacy = nativeClaude && unique.find(o => o.isGlobalDefault && o.provider === SUB && claudeFamily(o.value, SUB));
      const pooled = legacy && unique.find(o => o.nativeClaude && o.provider === 'anthropic' && versionKey(o.value) === versionKey(legacy.value));
      if (pooled) { legacy.isGlobalDefault = false; pooled.isGlobalDefault = true; }
      return curModel ? unique.sort((a, b) => Number(!!b.isGlobalDefault) - Number(!!a.isGlobalDefault)) : unique;
    }
    const raw = Array.isArray(payload) ? payload : arr(root.options).length ? arr(root.options) : arr(root.models);
    return raw.map(v => {
      if (typeof v === 'string') return { value: v, provider: '', name: friendly(v), description: '' };
      const it = obj(v), model = str(it.value, it.id, it.model); if (!model) return null;
      return { value: model, provider: str(it.provider), name: str(it.name, it.display_name, it.label) || friendly(model), description: str(it.description), isGlobalDefault: it.default === true || it.is_default === true };
    }).filter(Boolean);
  }

  /* modelChoices.ts visibleModelChoices: one newest choice per family; the selected route always shows. */
  function visibleChoices(models, selModel, selProvider) {
    const winners = new Map();
    const selected = m => m.value === selModel && (!selProvider || (m.provider || '') === selProvider);
    const pref = m => (selected(m) ? 2 : m.isGlobalDefault ? 1 : 0);
    const better = (m, prior) => {
      if (pref(m) !== pref(prior)) return pref(m) > pref(prior);
      // Prefer the available native pool for an unselected Claude family, even
      // when the legacy catalogue advertises a newer/long-context variant.
      // Explicit selected routes and the global default above stay authoritative.
      if ((m.nativeClaude || prior.nativeClaude) && CLAUDE_PROVIDERS.has(m.provider) && CLAUDE_PROVIDERS.has(prior.provider) && m.provider !== prior.provider)
        return m.provider === 'anthropic';
      const v = versionKey(m.value).localeCompare(versionKey(prior.value), 'en', { numeric: true });
      if (v !== 0) return v > 0;
      if (longTwin(m.value) !== longTwin(prior.value)) return !longTwin(m.value);
      return m.provider === SUB && prior.provider !== SUB;
    };
    for (const m of models) { const f = family(m.value, m.provider); if (!f) continue; const p = winners.get(f); if (!p || better(m, p)) winners.set(f, m); }
    const plain = winners.get('gpt:plain');
    if (plain && !pref(plain)) {
      const newest = Math.max(0, ...[...winners.entries()].filter(([k]) => k.startsWith('gpt:') && k !== 'gpt:plain').map(([, m]) => generation(m.value)));
      if (newest > generation(plain.value)) winners.delete('gpt:plain');
    }
    const rank = m => {
      if (m.isGlobalDefault) return -1;
      const f = family(m.value, m.provider);
      if (f?.startsWith('claude:')) return CLAUDE_ORDER.indexOf(f.slice(7));
      if (f?.startsWith('gpt:')) { const i = GPT_ORDER.indexOf(f.slice(4)); return CLAUDE_ORDER.length + (i < 0 ? GPT_ORDER.length : i); }
      return CLAUDE_ORDER.length + GPT_ORDER.length + 1;
    };
    // Routes outside the known families (another provider's catalogue) stay behind "More models".
    return models.filter(m => { const f = family(m.value, m.provider); return f ? winners.get(f) === m : m.isGlobalDefault || selected(m); }).sort((a, b) => rank(a) - rank(b));
  }

  const M = {
    options: [], providers: [], tinfoil: null, selections: new Map(), pending: new Map(), ready: false, error: '', at: 0, loading: null, claudeDown: false, claudeLimit: '',
    // The picker refetches on open when its list is older than this, so a just-added sign-in shows up right away.
    FRESH_MS: 15e3,
    stale() { return !M.ready || Date.now() - M.at > M.FRESH_MS; },
    claudeNote() { return `${M.claudeDown ? '<p class="ch-sheet-n mwarn" role="status">Claude app not answering · Claude models may be missing</p>' : ''}${M.claudeLimit ? `<p class="ch-sheet-n mwarn" role="status">${esc(M.claudeLimit)}</p>` : ''}`; },
    load(force) {
      if (M.loading) return M.loading;
      if (!force && M.ready && Date.now() - M.at < 5 * 60e3) return Promise.resolve(M.options);
      // The app owns the upstream key. Hermes' local bearer is not proof that a key is saved.
      const connection = fetch('/wizard-tinfoil/api/status', { cache: 'no-store', credentials: 'same-origin', signal: AbortSignal.timeout(4000) })
        .then(r => r.ok ? r.json() : null).catch(() => null);
      // A Claude app that hangs or errors is "not answering", which is different from "no Claude app" (404 or the
      // host's HTML fallback): only the first gets a line in the picker, so a broken app never looks like no subscription.
      const claude = fetch('/wizard-claude/api/accounts', { cache: 'no-store', credentials: 'same-origin', signal: AbortSignal.timeout(4000) })
        .then(r => { M.claudeDown = r.status >= 500; return r.ok ? r.json() : null; })
        .catch(e => { M.claudeDown = /abort|timeout/i.test(String(e?.name || '')) || e instanceof TypeError; return null; });
      M.loading = fetch('/wizard/hermes/api/model/options', { cache: 'no-store', credentials: 'same-origin' })
        .then(r => { if (!r.ok) throw new Error(`Models unavailable (${r.status})`); return r.json(); })
        .then(async j => { M.tinfoil = await connection; const accounts = await claude; M.claudeLimit = claudeLimitNote(accounts); M.providers = arr(obj(j).providers); M.options = normalize(j, hasNativeClaude(accounts)).filter(o => !isTinfoil(o.provider) || M.tinfoilReady()); M.ready = true; M.error = ''; M.at = Date.now(); M.recheckPlaceholder(); return M.options; })
        .catch(e => { M.error = String(e.message || e); return M.options; })
        .finally(() => { M.loading = null; });
      return M.loading;
    },
    /* Hermes answers with an offline placeholder catalogue while a ChatGPT sign-in is renewing or the pool just switched
     * accounts (no live answer yet). It omits account-gated models (Astra) and the newest tier (6.1 Sol), so the switch
     * greyed Astra and showed an older Sol for the full 5-minute cache. A signed-in ChatGPT list without Astra is
     * rechecked a few times soon after; listeners on `wos:models` repaint when the real catalogue arrives. Bounded,
     * so a plan without Astra settles after the last try. */
    placeholderTries: 0, PLACEHOLDER_RETRY_MS: [8e3, 30e3, 90e3], placeholderTimer: 0,
    codexPlaceholder() {
      const p = M.providers.find(x => str(obj(x).slug) === 'openai-codex');
      return !!p && p.authenticated === true && arr(p.models).length > 0 && !arr(p.models).some(m => gptFamily(typeof m === 'string' ? m : str(obj(m).id, obj(m).value), 'openai-codex') === 'gpt:astra');
    },
    recheckPlaceholder() {
      if (!M.codexPlaceholder()) { M.placeholderTries = 0; return; }
      const wait = M.PLACEHOLDER_RETRY_MS[M.placeholderTries]; if (wait === undefined || M.placeholderTimer) return;
      M.placeholderTries += 1;
      M.placeholderTimer = setTimeout(() => {
        M.placeholderTimer = 0; const before = JSON.stringify(M.options.map(o => [o.provider, o.value]));
        M.load(true).then(() => { if (JSON.stringify(M.options.map(o => [o.provider, o.value])) !== before) window.dispatchEvent?.(new Event('wos:models')); });
      }, wait);
    },
    normalize, hasNativeClaude, visibleChoices, PRIMARY, family, privateName, isPrivateRoute: isTinfoil, ours,
    tinfoilReady() { return M.tinfoil?.provider === 'tinfoil' && M.tinfoil?.credentialStored === true; },
    defaultOption() { return M.options.find(o => o.isGlobalDefault) || null; },
    find(model, provider) { if (!model) return null; return M.options.find(o => o.value === model && (!provider || o.provider === provider)) || null; },
    visible(model, provider) { return visibleChoices(shown(M.options), model, provider); },
    name(model, provider) { const o = M.find(model, provider); return o ? o.name : model ? (claudeName(model, provider || 'anthropic') || friendly(model)) : ''; },
    short(model, provider) {
      if (!model) return '';
      if (isTinfoil(provider)) { const n = privateName(model); return [n.name, n.version].filter(Boolean).join(' '); }
      const f = claudeFamily(model, /^claude-/i.test(model) ? 'anthropic' : provider);
      if (f) return cap(f);
      const o = M.find(model, provider);
      return (o ? o.name : friendly(model)).replace(/^Claude /, '').split(' · ')[0];
    },
    // One resolved choice for the chip and every send path. Telegram sessions can have a model
    // but no provider. Complete known metadata before native Send validates/persists the route.
    /* Agents MVP: a thread of a non-default agent (or a new chat in that agent's Chats) routes only to that agent's
     * allowed models on its own provider, and the route names the agent. The server enforces the same list. */
    agentFor(sid, agent) {
      const AG = window.WosAgents; if (!AG) return null;
      const id = agent || (sid && window.WizLive?.agentOf?.(sid)) || '';
      return id && AG.isOther(id) ? AG.get(id) || { id, missing: true } : null;
    },
    agentRoute(a, sid, choice) {
      if (!a || a.missing) return null;
      const s = sid && window.WizLive?.session(sid);
      const AG = window.WosAgents;
      // A choice counts only when it was made for THIS agent (its picker, its saved take). A main-agent route that
      // rode along with an orb or voice pick is not a choice: Philosopher ran on the main default, Opus, because Opus
      // happens to be in its allowed list (James, 23 Oct: "I asked you to send it to Fable"). The agent's default wins.
      const picked = choice && choice.agent === a.id ? choice.model || choice.value || '' : '';
      const want = picked || (sid && M.selections.get(sid)?.model) || s?.model || '';
      return AG.route(a, want);
    },
    currentRoute(sid, choice, agent) {
      // A choice from the picker's Private group names its agent: it routes there, never to the main catalogue.
      const ag = M.agentFor(sid, agent || choice?.agent || '');
      if (ag) return M.agentRoute(ag, sid, choice);
      const s = sid && window.WizLive?.session(sid);
      const route = choice?.model ? choice : sid && M.selections.get(sid) || (s?.model ? { model: s.model, provider: s.provider } : M.defaultOption());
      if (!route) return null;
      const model = route.model || route.value;
      let provider = route.provider || '';
      if (!provider) {
        const def = M.defaultOption();
        const matches = M.options.filter(o => o.value === model && o.provider);
        const providers = [...new Set(matches.map(o => o.provider))];
        // The configured default is authoritative for its own model; other models need a
        // unique catalogue route. Keep explicit routes and ambiguous non-defaults unchanged.
        provider = def?.value === model ? def.provider : providers.length === 1 ? providers[0] : '';
      }
      return { model, provider };
    },
    snapshot(sid, choice, agent) {
      if (sid && M.pending.has(sid)) throw new Error('Model change is still saving · send after it finishes');
      const ag = M.agentFor(sid, agent || choice?.agent || '');
      if (ag?.missing) throw new Error('Agent unavailable · open Agents and check it is running');
      return M.currentRoute(sid, choice, agent || choice?.agent || '');
    },
    keepVoiceRoute(id, route) {
      const all = JSON.parse(localStorage.getItem('wos.voice-model-routes.v1') || '{}');
      // A take for another agent keeps its agent, so a recovered recording never falls back to the main agent.
      all[id] = { model: route.model, provider: route.provider, ...(route.agent ? { agent: route.agent } : {}) };
      localStorage.setItem('wos.voice-model-routes.v1', JSON.stringify(all));
    },
    voiceRoute(id) {
      try {
        const saved = JSON.parse(localStorage.getItem('wos.voice-model-routes.v1') || '{}')[id];
        // Complete an older model-only take without replacing its saved model with today's choice.
        return saved?.model ? M.currentRoute('', saved, saved.agent || '') : null;
      } catch { throw new Error('Saved recording model route is unreadable'); }
    },
    forgetVoiceRoute(id) {
      const all = JSON.parse(localStorage.getItem('wos.voice-model-routes.v1') || '{}'); delete all[id];
      localStorage.setItem('wos.voice-model-routes.v1', JSON.stringify(all));
    },
    matchesRuntime(runtime, route) {
      if (runtime?.model !== route.model) return false;
      if (runtime.provider === route.provider) return true;
      return runtime.provider === 'custom' && route.provider.startsWith('custom:') && runtime.requested?.provider === route.provider;
    },
    reconcile(sessions) {
      for (const s of sessions) {
        const selected = M.selections.get(s.id); if (!selected) continue;
        if ((s.model === selected.model && s.provider === selected.provider) ||
            (selected.version > 0 && s.modelLockAt >= selected.version)) M.selections.delete(s.id);
      }
    },
    async resolveRoute(snapshot) {
      // An agent's route is the agent's own provider and model, never the main agent's catalogue.
      if (snapshot?.agent) {
        const AG = window.WosAgents, a = AG?.get(snapshot.agent);
        if (!a) throw new Error('Agent unavailable · open Agents and check it is running');
        if (!AG.allows(a, snapshot.model)) throw new Error(`${a.label} can’t use that model · pick one of its models`);
        return { model: snapshot.model, provider: a.model.provider, agent: a.id };
      }
      if (!M.ready || !snapshot?.provider) await M.load();
      const route = snapshot || M.snapshot('');
      if (!route?.model) throw new Error('Model unavailable · choose a model before sending');
      let provider = route.provider;
      if (!provider) {
        const matches = M.options.filter(o => o.value === route.model);
        if (matches.length === 1) provider = matches[0].provider;
      }
      // Old recap metadata used a display label; the transport needs the configured provider slug.
      if (provider === 'tinfoil') provider = 'custom:tinfoil-operator';
      if (provider && M.providers.some(p => p.slug === provider && p.is_user_defined)) provider = 'custom:' + provider;
      if (!provider) throw new Error('Model provider unavailable · choose the model again');
      if (isTinfoil(provider) && !M.tinfoilReady()) throw new Error('Set up Tinfoil in its connection app before choosing it');
      return { model: route.model, provider };
    },
    setThreadModel(sid, o) {
      if (M.pending.has(sid)) return Promise.reject(new Error('A model change is already saving'));
      const task = (async () => {
        const ag = M.agentFor(sid);
        const route = await M.resolveRoute(ag ? { model: o.value, provider: o.provider, agent: ag.id } : { model: o.value, provider: o.provider });
        const body = { ...route, require_model_lock: true };
        const r = await fetch(`/wizard/hermes/api/sessions/${encodeURIComponent(sid)}/model${ag ? `?agent=${encodeURIComponent(ag.id)}` : ''}`, { method: 'POST', cache: 'no-store', credentials: 'same-origin', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
        if (!r.ok) throw Object.assign(new Error(`Model not changed (${r.status})`), { status: r.status });
        const ack = await r.json();
        // An agent's own Hermes names its provider its own way (e.g. custom); the model is what must match.
        if (ack.runtime?.model_lock !== 'accepted' || ack.runtime?.model !== route.model || (!ag && !M.matchesRuntime(ack.runtime, route)))
          throw new Error('Wizard did not confirm the selected model');
        M.selections.set(sid, { model: route.model, provider: route.provider, version: Number(ack.runtime.selection_version) || 0 });
        return { model: route.model, provider: route.provider };
      })();
      M.pending.set(sid, task);
      return task.finally(() => M.pending.delete(sid));
    },
    /* Unified Chats: the owner's private agents' models, for the picker's Private group (oldest agent first, the
     * same order the Agent Service routes by). Each option names its agent; picking one routes the chat there. */
    privateOptions() {
      const AG = window.WosAgents; if (!AG?.ready) return [];
      const agents = AG.others().filter(a => AG.isPrivate(a)).sort((a, b) => (Number(a.created_at) || 0) - (Number(b.created_at) || 0) || String(a.id).localeCompare(String(b.id)));
      const multi = agents.length > 1;
      return agents.flatMap(a => AG.modelOptions(a).map(o => ({ ...o, private: true, description: [multi ? a.label : '', o.description].filter(Boolean).join(' · ') })));
    },
    /* The picker. mode: 'new' | 'thread' | 'retry'; cur = { model, provider }; all = show the full catalogue.
     * priv: the Private group (main Chats only), listed after the main agent's models. */
    sheetHtml({ mode, cur, all, title, agent, priv }) {
      // An agent's chats: only that agent's allowed models. No "More models": the rest are not this agent's.
      const own = agent && !agent.missing ? window.WosAgents.modelOptions(agent) : null;
      const privList = !own && Array.isArray(priv) ? priv : [];
      const isCur = o => cur && o.value === cur.model && (!cur.provider || o.provider === cur.provider) && (cur.agent || '') === (o.agent || '');
      const main = own || (all ? M.options : M.visible(cur?.model || '', cur?.provider || '')).filter(o => keepMainOption(o, privList, isCur));
      const list = main.concat(privList);
      const head = mode === 'retry' ? 'Retry with another model' : mode === 'new' ? 'Model for this new chat' : 'Model for this thread';
      const note = own ? `${agent.label} can only use ${own.length === 1 ? 'this model' : 'these models'}.${agent.privacy === 'private' ? ' Private: no other provider, no fallback.' : ''}`
        : mode === 'retry' ? 'Sends your last request again on the model you pick.' : mode === 'new' ? 'New chats start on your Wizard’s default.' : 'Replies in this thread use this model from now on.';
      const rows = own ? list.map((o, i) => `<button type="button" class="mrow${isCur(o) ? ' on' : ''}" data-mpick="${i}" aria-pressed="${isCur(o)}"><span class="mn"><b>${esc(o.name)}</b><small>${esc([o.description, o.isGlobalDefault ? 'Agent default' : ''].filter(Boolean).join(' · '))}</small></span>${isCur(o) ? '<i class="mck" aria-hidden="true">✓</i>' : ''}</button>`).join('')
        : !M.ready && !main.length ? `<p class="ch-sheet-n">${M.error ? esc(M.error) : 'Loading models…'}</p>`
        : main.map((o, i) => `<button type="button" class="mrow${isTinfoil(o.provider) ? ' secure' : ''}${isCur(o) ? ' on' : ''}" data-mpick="${i}" aria-pressed="${isCur(o)}"><span class="mn"><b>${esc(o.name)}</b><small>${esc([o.description, o.isGlobalDefault ? 'Default' : ''].filter(Boolean).join(' · ') || o.value)}</small></span>${isCur(o) ? '<i class="mck" aria-hidden="true">✓</i>' : ''}</button>`).join('');
      const lock = window.WosAgents?.lock?.() || '';
      const privNote = mode === 'thread' ? 'Starts a new private chat with this conversation quoted. This thread stays as it is.' : 'Runs on your private agent: its own history, no fallback.';
      const privRows = privList.length ? `<div class="msheet-grp priv" role="group" aria-label="Private models"><div class="msheet-gh">${lock}<span>Private</span></div>`
        + privList.map((o, k) => { const i = main.length + k; return `<button type="button" class="mrow priv${isCur(o) ? ' on' : ''}" data-mpick="${i}" data-mprivate="${esc(o.agent)}" aria-pressed="${isCur(o)}"><span class="mn"><b>${lock}${esc(o.name)}</b><small>${esc([o.description, o.isGlobalDefault ? 'Default' : ''].filter(Boolean).join(' · '))}</small></span>${isCur(o) ? '<i class="mck" aria-hidden="true">✓</i>' : ''}</button>`; }).join('')
        + `<p class="msheet-gn">${esc(privNote)}</p></div>` : '';
      return { list, html: `<div class="ch-sheet ch-msheet" role="dialog" aria-label="${esc(head)}"><div class="ch-sheet-b"><div class="ch-sheet-t">${esc(title ? `${head} · ${title}` : head)}</div>
        <div class="msheet-list">${own ? '' : M.claudeNote()}${rows}${!own && !privList.length && ours() && !M.options.some(o => isTinfoil(o.provider)) ? '<a class="mrow more" href="/wizard-tinfoil/" target="_blank" rel="noopener">Set up Tinfoil</a>' : ''}${!own && M.ready && !all && M.options.length > main.length ? `<button type="button" class="mrow more" data-mall>More models · ${M.options.length}</button>` : ''}${privRows}</div>
        <p class="ch-sheet-n">${esc(note)}</p></div></div>` };
    },
    /* The compact model menu opened from the label in the message box: a small card over the right side.
     * Read bottom-up (thumb first): this mode's primary models, then the other section (Private agent models in the
     * main Chats), then More models. An agent's own chats list only that agent's models. */
    popHtml({ mode, cur, all, agent, priv }) {
      const own = agent && !agent.missing ? window.WosAgents.modelOptions(agent) : null;
      const isCur = o => cur && o.value === cur.model && (!cur.provider || o.provider === cur.provider) && (cur.agent || '') === (o.agent || '');
      const lock = window.WosAgents?.lock?.() || '';
      const famOf = o => family(o.value, o.provider), up = primaryFamilies().map(p => p.family);
      const privList = !own && Array.isArray(priv) ? priv : [];
      const vis = own ? [] : M.visible(cur?.model || '', cur?.provider || '').filter(o => keepMainOption(o, privList, isCur));
      const primary = own || up.map(f => vis.find(o => famOf(o) === f)).filter(Boolean).concat(vis.filter(o => isCur(o) && !up.includes(famOf(o))));
      const rest = own || !all ? [] : vis.filter(o => !primary.includes(o)); // the other families' newest models (Fable, Haiku, Terra, Luna)
      const curPriv = privList.some(isCur);
      // Primary rows read Opus · Sonnet · Astra · Sol; everything else keeps its catalogue name (GLM 5.3, Fable 5.1…).
      const label = (o, p) => own || p ? o.name : isTinfoil(o.provider) ? M.short(o.value, o.provider) : PRIMARY.find(x => x.family === famOf(o))?.name || o.name || M.short(o.value, o.provider);
      const list = [], row = (o, cls = '') => { const i = list.push(o) - 1; const p = cls.includes('priv'); if (isTinfoil(o.provider)) cls += ' secure';
        return `<button type="button" class="mrow${cls}${isCur(o) ? ' on' : ''}" data-mpick="${i}"${p ? ` data-mprivate="${esc(o.agent)}"` : ''} aria-pressed="${isCur(o)}"><span class="mn"><b>${p || isTinfoil(o.provider) ? lock : ''}${esc(label(o, p))}</b></span>${isCur(o) ? '<i class="mck" aria-hidden="true">✓</i>' : ''}</button>`; };
      const sec = (label, rows, cls = '') => rows ? `<div class="mpop-sec${cls}" role="group" aria-label="${esc(label)}"><div class="msheet-gh">${cls.includes('priv') ? lock : ''}<span>${esc(label)}</span></div>${rows}</div>` : '';
      const setupRow = `<button type="button" class="mrow" disabled aria-disabled="true" title="Set up Tinfoil in its connection app"><span class="mn"><b>Tinfoil</b></span></button><a class="mrow more" href="/wizard-tinfoil/" target="_blank" rel="noopener">Set up Tinfoil</a>`;
      // A same-Hermes route, never a Private agent or a new history. No model id is guessed.
      const mainRows = primary.map(o => !own && isTinfoil(o.provider) && !M.tinfoilReady() ? setupRow : row(o)).join('')
        + (!own && !privList.length && ours() && !primary.some(o => isTinfoil(o.provider)) ? setupRow : '');
      const privRows = privList.map(o => row(o, ' priv')).join('');
      const moreRows = rest.map(o => row(o)).join('');
      const moreBtn = !own && M.ready && !all && vis.some(o => !primary.includes(o)) ? `<button type="button" class="mrow more" data-mall>More models</button>` : '';
      // The section you're in sits at the bottom, by your thumb; the other section is right above it.
      const mainSec = sec(own ? agent.label : 'Models', mainRows), privSec = sec('Private agent', privRows, ' priv');
      const body = !M.ready && !primary.length && !own ? `<p class="ch-sheet-n">${M.error ? esc(M.error) : 'Loading models…'}</p>`
        : (moreRows ? sec('More models', moreRows) : moreBtn) + (curPriv ? mainSec + privSec : privSec + mainSec) + (own ? '' : M.claudeNote());
      return { list, html: `<div class="ch-sheet ch-mpop" role="dialog" aria-label="${mode === 'new' ? 'Model for this new chat' : 'Model for this thread'}"><div class="ch-sheet-b"><div class="msheet-list">${body}</div></div></div>` };
    },
    /* A failed thread: what happened, on which model, and the ways out (Retry · Choose another model · Dismiss). */
    failureHtml({ s, busy, retryLabel, canRetry }) {
      const model = s.model ? M.name(s.model, s.provider) : '';
      // The provider's sign-in expired: Retry can't fix that, the provider's connection app can.
      const rc = s.reconnect;
      if (rc && s.queueReason !== 'provider_access' && busy !== 'retry') {
        const target = M.short(s.model, s.provider) || model || rc.name;
        return `<section class="ch-fail diagnosed" role="alert" data-chfail="${esc(s.id)}"><span class="lb">${esc(rc.name)} sign-in expired</span>
        <p>This message is saved. Sign in to ${esc(rc.name)} and it will send to ${esc(target)} on its own.</p>
        <div class="ch-fail-b"><button type="button" data-chreconnect="${esc(rc.appId)}" data-recovery-run="${esc(rc.runId || '')}">Sign in to ${esc(rc.name)}</button></div></section>`;
      }
      const waiting = s.status === 'queued' && s.queueReason === 'provider_access';
      const what = waiting ? s.safeError || 'The selected AI provider could not start this request.' : s.status === 'interrupted' ? 'The last request was interrupted before it finished.' : 'The last request didn’t finish.';
      return `<section class="ch-fail" role="alert" aria-busy="${!!busy}" data-chfail="${esc(s.id)}"><span class="lb">${s.status === 'interrupted' ? 'Interrupted' : 'Needs retry'}${model ? ` · ${esc(model)}` : ''}</span>
        <p${busy === 'retry' ? ' role="status"' : ''}>${busy === 'retry' ? esc(retryLabel || 'Retrying…') : `${esc(what)} ${waiting ? 'Your original message and files are saved. You can choose another model and retry now, or wait: it will retry automatically on the same provider when access returns. ' : ''}Retry sends it again${model ? ' on the same model' : ''}, or pick another model. Dismiss clears the error and keeps the thread.`}</p>
        <div class="ch-fail-b">${waiting && rc ? `<button type="button" data-chreconnect="${esc(rc.appId)}" data-recovery-run="${esc(rc.runId || '')}" ${busy ? 'disabled' : ''}>Sign in to ${esc(rc.name)}</button>` : ''}<button type="button" data-chretry ${busy || !canRetry ? 'disabled' : ''}>${busy === 'retry' ? 'Retrying…' : 'Retry'}</button><button type="button" data-chretrymodel ${busy || !canRetry ? 'disabled' : ''}>Choose another model</button><button type="button" class="ghost" data-chdismiss ${busy ? 'disabled' : ''}>${busy === 'dismiss' ? 'Dismissing…' : 'Dismiss'}</button></div></section>`;
    },
  };
  window.WosModels = M;
})();
