/* One app's owner-needs checklist. Store and both shells use these rows and actions.
 * The Router remains authoritative: no keys, inferred approvals or private-data bypasses here. */
(() => {
  'use strict';
  const script = new URL(document.currentScript.src);
  const base = new URL('../', script);
  const url = path => new URL(path, base).href;
  const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
  let R, installer, current = null, overlay = null, links = null, alternative = null;
  let hooks = {}, serial = 0, pending = false;
  const moduleURL = path => { const u = new URL(path, base); if (script.searchParams.has('v')) u.searchParams.set('v', script.searchParams.get('v')); return u.href; };
  const ready = Promise.all([import(moduleURL('store/store-router.js')), import(moduleURL('store/store-install.js'))]).then(([r, i]) => { R = r; installer = i; });
  // Keep a failed dynamic import handled, too: older/offline boxes must still open apps.
  ready.catch(() => {});
  const entries = data => [...(data?.models || []), ...(data?.services || [])];
  const gaps = data => entries(data).filter(n => n.status !== 'ready');
  const canContinue = data => !gaps(data).some(n => n.required !== false);
  const needsSetup = data => data?.ready_to_open === false || gaps(data).length > 0;

  function html(app, data, ctx = {}) {
    return `<div class="was-checklist" data-mc-app="${esc(app)}">${R.routerRows(app, data, { ...ctx, esc: ctx.esc || esc, checklist: true })}</div>`;
  }
  function controls(app, data, ctx = {}) {
    const { need, target } = R.setupTarget(data, ctx);
    if (canContinue(data)) return `<footer class="was-actions"><button type="button" class="mc-btn was-primary" ${ctx.store ? `data-open="${esc(app)}"` : 'data-was-continue'}>Open ${esc(ctx.name || app)}</button></footer>`;
    const key = need?.slot || need?.feature || '';
    return `<footer class="was-actions">${target ? `<button type="button" class="mc-btn was-primary" data-mc-connect="${esc(target.id)}" data-mc-need="${esc(key)}" data-mc-installed="${target.installed ? 1 : 0}">Set up with ${esc(target.name)}</button>` : `<button type="button" class="mc-btn was-primary" data-mc-another="${esc(key)}">Choose a provider</button>`}${target ? `<button type="button" class="was-link" data-mc-another="${esc(key)}">Use another provider</button>` : ''}</footer>`;
  }
  // Providers from the Router are installed; Store listings need an explicit installed read.
  function choices(need, data, ctx = {}) {
    const all = new Map((ctx.storeApps || []).filter(a => ctx.isInstalled?.(a)).map(a => [a.id, a]));
    for (const p of data.providers || []) all.set(p.id, { ...all.get(p.id), ...p });
    return [...all.values()].filter(p => {
      if (need.private_data && p.private !== true) return false;
      if (need.slot) return (p.provides || []).includes(need.slot);
      return (p.models || []).some(m => (need.swap === 'never' ? m.id === need.tested_on : m.tier === need.tier || m.id === need.tested_on));
    });
  }
  function dismissAlternative() {
    if (!alternative) return false;
    const { el, button } = alternative; alternative = null; el.remove(); button?.focus(); return true;
  }
  function others(btn, context) {
    dismissAlternative();
    const { data, app } = context, key = btn.dataset.mcAnother;
    const need = entries(data).find(n => (n.slot || n.feature) === key); if (!need) return;
    const candidates = choices(need, data, context);
    const box = document.createElement('div'); box.className = 'was-alternatives'; box.dataset.wasAlternatives = '';
    box.setAttribute('role', 'dialog'); box.setAttribute('aria-modal', 'true'); box.setAttribute('aria-label', 'Other providers');
    box.innerHTML = `<h3>Use another provider</h3><p class="mc-line">${need.private_data ? 'Private providers only.' : 'Choose a connection.'}</p>` + candidates.map(p => {
      if (need.slot) return `<button type="button" class="mc-btn alt" data-mc-connect="${esc(p.id)}" data-mc-installed="1">Connect ${esc(R.providerName(data, p.id, context.storeApps))}</button>`;
      return (p.models || []).filter(m => need.swap === 'never' ? m.id === need.tested_on : m.tier === need.tier || m.id === need.tested_on).map(m => `<button type="button" class="mc-btn alt" data-mc-approve="${esc(need.feature)}" data-mc-provider="${esc(p.id)}" data-mc-model="${esc(m.id)}">Approve ${esc(m.label || m.id)} · ${esc(R.providerName(data, p.id, context.storeApps))}</button>`).join('');
    }).join('') + `${!candidates.length ? '<p class="mc-line">No other installed provider.</p>' : ''}<button type="button" class="mc-btn alt" data-was-store="${esc(need.slot || 'ai-connection')}">Find providers in Store</button><button type="button" class="mc-btn alt" data-was-back>Back to checklist</button>`;
    (btn.closest('.mc-row') || btn.closest('[data-mc-app]') || btn.closest('.was-card')).appendChild(box); alternative = { el: box, button: btn, app };
    box.querySelector('button')?.focus();
  }
  async function action(btn, context) {
    const { app, data } = context;
    if (btn.matches('[data-was-back]')) { dismissAlternative(); return true; }
    if (btn.matches('[data-mc-another]')) { others(btn, context); return true; }
    if (btn.matches('[data-was-store]')) { context.openStore(btn.dataset.wasStore); return true; }
    if (btn.matches('[data-mc-approve]')) {
      await R.routerApprove({ app, feature: btn.dataset.mcApprove, provider: btn.dataset.mcProvider, model: btn.dataset.mcModel });
      dismissAlternative(); await context.recheck(); return true;
    }
    if (!btn.matches('[data-mc-connect]')) return false;
    const id = btn.dataset.mcConnect;
    const row = btn.closest('.mc-row');
    const need = entries(data).find(n => (n.slot || n.feature) === btn.dataset.mcNeed || (n.slot && n.slot === row?.dataset.mcSlot) || (n.feature && n.feature === row?.dataset.mcFeature));
    if (!id) { if (need?.fix_url) await context.openProvider('', need.fix_url); else context.openStore(need?.slot || 'ai-connection'); return true; }
    if (btn.dataset.mcInstalled !== '1') {
      const provider = (context.storeApps || []).find(a => a.id === id);
      if (!provider) { context.openStore(id); return true; }
      btn.textContent = 'Setting up…';
      if (!await context.installProvider(provider)) return true;
    }
    const provider = (data.providers || []).find(p => p.id === id);
    const fix = id === (need?.recommend || need?.provider || need?.route?.provider) ? need?.fix_url : null;
    await context.openProvider(id, fix || provider?.fix_url);
    return true;
  }
  async function catalog() {
    const apps = []; let offset = 0;
    for (let i = 0; i < 100; i++) {
      const r = await fetch(url(`store-data/wizard/v1/index/search?limit=100&offset=${offset}`), { credentials: 'same-origin', cache: 'no-store' });
      if (!r.ok) throw Error('The App Index is unavailable.');
      const j = await r.json(); apps.push(...(j.apps || []));
      if (j.next_offset == null) return apps;
      if (!Number.isSafeInteger(j.next_offset) || j.next_offset <= offset) break;
      offset = j.next_offset;
    }
    throw Error('The App Index did not finish loading.');
  }
  async function installed() {
    const r = await fetch(url('store-data/wizard/v1/installed-apps'), { credentials: 'same-origin', cache: 'no-store' });
    if (!r.ok) throw Error('Installed apps could not be checked.');
    const j = await r.json();
    if (j.complete !== true || !Array.isArray(j.wam) || !Array.isArray(j.shell)) throw Error('Installed apps are still being checked. Try again before installing a provider.');
    return [...j.wam, ...j.shell];
  }
  function close() {
    if (!overlay && !current && !pending) return false;
    pending = false; serial++; dismissAlternative(); const focus = current?.focus; current = null;
    links?.close(); links = null; overlay?.remove(); overlay = null; if (focus?.isConnected) focus.focus(); return true;
  }
  function paint() {
    if (!overlay || !current) return;
    dismissAlternative();
    const c = current;
    const ctx = { name: c.name, storeApps: c.apps, isInstalled: a => c.installed.some(p => p.id === a.id) };
    overlay.querySelector('.was-card').innerHTML = `<header class="was-head"><span class="was-app-icon" aria-hidden="true">${window.WizSigil?.html(c.record.sigil || c.record) || esc(c.name.charAt(0))}</span><h2 tabindex="-1">Set up ${esc(c.name)}</h2><p>${esc(c.name)} needs a few services to work.</p></header>
      ${html(c.app, c.data, ctx)}<p class="mc-line was-note" role="status">${esc(c.note || '')}</p>${controls(c.app, c.data, ctx)}`;
  }
  async function recheck() {
    const c = current; if (!c) return;
    const check = c.check = (c.check || 0) + 1;
    const r = await R.routerNeeds(c.app);
    if (current !== c || check !== c.check) return;
    // Compatibility fallback applies on every check, not only the initial open.
    if (!r.data) { const resume = c.resume; close(); resume(); return; }
    c.data = r.data; paint();
  }
  function child(href) {
    let u; try { u = new URL(href, location.href); } catch (_) { throw Error('No connection page is available.'); }
    if (u.origin !== location.origin || !/^https?:$/.test(u.protocol)) throw Error('The connection page must be on this Wizard.');
    if (!links) links = window.WizLinks.mount({ parent: overlay, onChange: open => {
      if (!open && current) {
        // A connect page is one nested visit. Do not reuse a closing sheet's
        // delayed history stack if another connection is opened immediately.
        const ended = links; links = null; ended?.el.remove(); recheck();
      }
    } });
    links.open(u.href);
  }
  async function openProvider(id, fix) {
    const c = current;
    await window.WizCore?.refreshApps?.();
    if (current !== c || !overlay) return;
    // Router fix links may be shell deep links: resolve them to the installed app's page,
    // never embed another shell inside the checklist.
    let target = fix;
    const u = fix && new URL(fix, location.href);
    if (!target || u.searchParams.has('open')) target = hooks.getApp?.(u?.searchParams.get('open') || id)?.url;
    if (!target) throw Error('Open this provider from Apps, then return here and check again.');
    child(target);
  }
  function context(c) {
    return { app: c.app, data: c.data, storeApps: c.apps, isInstalled: a => c.installed.some(p => p.id === a.id), recheck,
      openStore: slot => child(url('store/index.html?q=' + encodeURIComponent(slot))),
      openProvider: (id, fix) => current === c ? openProvider(id, fix) : undefined,
      installProvider: async provider => {
        if (provider.conflict) throw Error('This provider has a source conflict. Choose its release in the Store.');
        // Never interpret an unavailable/incomplete registry as a missing provider.
        const before = await installed();
        if (current !== c) return false;
        const existing = before.find(p => p.id === provider.id);
        if (existing?.conflict) throw Error('This provider has a source conflict. Choose its release in the Store.');
        if (existing) { c.installed = before; return true; }
        await installer.installRelease(provider, { base });
        const snapshot = await installed();
        if (!snapshot.some(p => p.id === provider.id && !p.conflict && p.repo === provider.repo && p.commit === provider.commit)) throw Error('The installed release is not registered yet. Check again before retrying.');
        if (current !== c) return false;
        c.installed = snapshot; await window.WizCore?.refreshApps?.(); return current === c;
      } };
  }
  function trapFocus(e, scope) {
    if (e.key !== 'Tab') return;
    const buttons = [...scope.querySelectorAll('button:not(:disabled), summary')].filter(el => el.getClientRects().length);
    const first = buttons[0], last = buttons.at(-1);
    if (e.shiftKey && (document.activeElement === first || document.activeElement.tagName === 'H2')) { e.preventDefault(); last?.focus(); }
    else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first?.focus(); }
  }
  // The Store reuses the same provider sheet without constructing a launch gate.
  document.addEventListener('keydown', e => { if (alternative && !overlay) trapFocus(e, alternative.el); });
  // Admission preserves the shells' boolean openApp contract. Only the captured continuation
  // can create a window; cancelling or a newer launch invalidates an in-flight read.
  // settled: called once the check is over (the app opens, its setup sheet shows, or another open replaced it),
  // so the shell's "Opening …" feedback ends exactly then.
  // Opening never waits on the Router (James, 28 Oct 2026: "3 to 5 seconds staring at the screen"). An app whose
  // last check was ready opens at once; any other app waits at most OPEN_WAIT for the check, then opens anyway with
  // its window's loading spinner. A check that lands later with a real gap puts the setup sheet over the open app.
  const OPEN_WAIT = 250, OK_KEY = 'wos.appSetup.ready';
  const okRead = () => { try { return JSON.parse(localStorage.getItem(OK_KEY) || '{}') || {}; } catch (_) { return {}; } };
  const okWrite = (id, ok) => { try { const m = okRead(); if (ok) m[id] = 1; else delete m[id]; localStorage.setItem(OK_KEY, JSON.stringify(m)); } catch (_) {} };
  function gate(app, resume, { settled } = {}) {
    let once = false; const settle = () => { if (once) return; once = true; try { settled?.(); } catch (_) {} };
    const ticket = ++serial;
    if (current || overlay || pending) { close(); serial = ticket; }
    pending = true;
    let opened = false;
    const openNow = () => { if (opened || ticket !== serial) return; opened = true; pending = false; resume(); settle(); };
    if (okRead()[app.id]) openNow();
    const wait = opened ? 0 : setTimeout(openNow, OPEN_WAIT);
    (async () => {
      let result;
      try { await ready; result = await R.routerNeeds(app.id); } catch (_) { result = {}; }
      clearTimeout(wait);
      if (ticket !== serial) { settle(); return; }
      if (result.data) okWrite(app.id, !needsSetup(result.data));
      if (!result.data || !needsSetup(result.data)) { openNow(); return; }
      // Opened already and the owner has since moved to another app: a late sheet would land on the wrong screen.
      if (opened && hooks.isFront && !hooks.isFront(app.id)) return;
      pending = false;
      current = { app: app.id, record: app, name: app.name || app.id, resume, data: result.data, apps: [], installed: [], note: '', focus: document.activeElement };
      const c = current;
      overlay = document.createElement('section'); overlay.className = 'was-overlay'; overlay.setAttribute('aria-label', 'App setup');
      overlay.innerHTML = `<div class="was-card" role="dialog" aria-modal="true" aria-label="Set up ${esc(c.name)}"></div>`; document.body.appendChild(overlay); paint(); settle();
      overlay.addEventListener('keydown', e => {
        if (!links?.isOpen()) trapFocus(e, alternative?.el || overlay.querySelector('.was-card'));
      });
      overlay.querySelector('h2')?.focus();
      overlay.addEventListener('click', async e => {
        const btn = e.target.closest('button'); if (!btn || !btn.closest('.was-card') || current !== c) return;
        if (btn.matches('[data-was-close]')) { close(); return; }
        if (c.busy) return;
        if (btn.matches('[data-was-continue]')) { if (canContinue(c.data)) { close(); c.resume(); } return; }
        if (btn.matches('[data-was-agents]')) { window.WosAppRoute?.open(c.app, { name: c.name }); return; }
        c.busy = true; btn.disabled = true; c.note = '';
        try { if (btn.matches('[data-was-recheck]')) await recheck(); else await action(btn, context(c)); }
        catch (e) { if (current === c) { c.note = 'Couldn’t finish setup. Try again.'; paint(); } }
        finally { c.busy = false; if (btn.isConnected) btn.disabled = false; }
      });
      Promise.allSettled([catalog(), installed()]).then(([apps, inst]) => {
        if (current !== c) return;
        c.apps = apps.status === 'fulfilled' ? apps.value : [];
        c.installed = inst.status === 'fulfilled' ? inst.value : [];
        if (!links?.isOpen()) paint();
      });
    })();
    return true;
  }
  function back() {
    if (links?.isOpen()) return links.back();
    if (alternative) return dismissAlternative();
    const expanded = [...document.querySelectorAll('.was-checklist details[open]')].at(-1);
    if (expanded) { expanded.open = false; expanded.querySelector('summary')?.focus(); return true; }
    return close();
  }
  // The nested Store uses its existing hosted-app messages. Trust only our exact
  // Store frame (never a provider frame or a claimed app id) and installed app URLs.
  addEventListener('message', async e => {
    const frame = links?.el.querySelector('iframe');
    if (!current || e.origin !== location.origin || e.source !== frame?.contentWindow) return;
    let page; try { page = new URL(links.state().url); } catch (_) { return; }
    if (page.origin !== location.origin || !page.pathname.startsWith(new URL('store/', base).pathname)) return;
    const d = e.data; if (!d || typeof d.id !== 'string' || !/^[a-z0-9-]{1,80}$/.test(d.id)) return;
    if (d.type === 'wizard:open-app') { try { await openProvider(d.id); } catch (err) { if (current) { current.note = 'Couldn’t open the provider. Try again.'; paint(); } } }
    else if (d.type === 'wizard:app-route') window.WosAppRoute?.request(d);
  });
  const onReturn = () => { if (!document.hidden && current && !links?.isOpen()) ready.then(recheck).catch(() => {}); };
  document.addEventListener('visibilitychange', onReturn); addEventListener('focus', onReturn);
  window.WosAppSetup = { ready, html, controls, action, choices, gaps, canContinue, needsSetup, gate, back, close, recheck,
    init(o) { hooks = { ...hooks, ...o }; }, isOpen: () => !!current };
})();
