/* Wizard OS · Settings → About & updates: one update card, Automatic / Ask me, release channel; the Home pop-up.
 *
 * Two kinds of update, two names (Miguel, 27 Oct 2026). "Wizard OS" is only the box (App Manager, Agent Service,
 * apps): a 10–20 minute install that waits for a quiet moment, like a macOS update. The screens you use are the
 * "Interface": a new one is already on the box and only needs a Reload, so its notice never says "Wizard OS".
 *
 * The box updates the one documented way: the App Manager reruns the installer (`os.sh | bash -s start`) onto the
 * release `releases/stable` names. Automatic (the default) does that overnight, skipping while a chat run is
 * active; Ask me waits for a tap on Update.
 *
 * Same path as the Store's Get: `../store-install/_updates` is the App Manager's owner-only listener behind
 * Tailscale Serve (owner login, the shell's own Origin, JSON + X-Wizard-Store). No token reaches the browser.
 *   GET                       {mode, chosen, installed, latest, update_available, unpinned, checked, installing,
 *                              interrupted (the last update was cut short, e.g. by a reboot; it is retried),
 *                              quick (the release only swaps the interface image in place: about 2 minutes, not
 *                              the 10–20 minute installer; App Managers without it never send it)}
 *   POST {"mode":"auto"|"ask"} the owner's choice (kept across installer reruns)
 *   POST {"channel":"stable"|"latest"} release channel (DECISIONS #75): stable = promoted releases (default),
 *                              latest = every release, for testers. GET then also returns {channel, stable};
 *                              `latest` is this box's channel release. Automatic installs stable only, either way.
 *                              An App Manager without channels returns no `channel`, so the picker stays hidden.
 *   POST {"action":"apply"}    start the update now
 * An unavailable route is reported in About; no install/policy controls are enabled without a valid response.
 *
 * One card, same look in every state; only the words change. Nothing to do = no card:
 *   behind    "Wizard OS update" · Automatic: "Installs tonight when it’s quiet" · Install now
 *                                         Ask me:    "Takes 10–20 minutes" · Install
 *   building  "Updating Wizard OS…" · "Takes 10–20 minutes · Wizard reconnects by itself" · Install (disabled)
 *             (quick: "Takes about 2 minutes" in both; the new interface then offers its own Reload)
 *   failed    "Wizard OS update didn’t finish" · "Tries again tonight" (Ask me: "Takes 10–20 minutes") · Try again
 *   reload    the interface changed under this page (core/web-update.js) → "Interface updated" · Reload
 *
 *   WosUpdates.card()       → {state, title, line, action, label, disabled} or null
 *   WosUpdates.cardHtml()   → the card's markup ('' when there is nothing to do); Settings puts it on top
 *   WosUpdates.html()       → the About & updates group, including loading/unavailable status
 *   WosUpdates.act(el, ctx) → handles a [data-osu] tap; true if handled
 *   WosUpdates.load(force)  → refresh the status (cached 60 s here; the App Manager caches stable ~10 min)
 *   WosUpdates.popup()      → show / hide the Home pop-up now
 *
 * Home pop-up: when the card says Update, Try again or Reload, Home shows the same words and the same button in a
 * small card clear of the dock, with a ×. × hides it for that exact state (keyed by the release or the web build)
 * until something new arrives. It replaces the old "Interface updated · Reload" banner (core/web-update.js asks
 * ownsReload() and stays away while the pop-up has the reload, or after its ×), so only one notice shows.
 */
(() => {
  'use strict';
  if (window.WosUpdates) return;
  const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const API = new URL('../store-install/_updates', document.currentScript?.src || location.href).href;
  const FRESH = 60e3;
  let st = null, at = 0, inflight = null, busy = '', off = false, issue = '';

  const valid = d => d && typeof d === 'object' && ['auto', 'ask'].includes(d.mode) && 'update_available' in d;
  function changed() { try { window.WosSettings?.refresh(); } catch (_) {} try { popup(); } catch (_) {} }
  function load(force) {
    if (off && !force) return Promise.resolve(st);
    if (!force && st && Date.now() - at < FRESH) return Promise.resolve(st);
    if (inflight) return inflight;
    inflight = (async () => {
      try {
        const r = await fetch(API, { credentials: 'same-origin', cache: 'no-store' });
        const d = r.ok ? await r.json().catch(() => null) : null;
        if (valid(d)) { st = d; off = false; issue = ''; }
        else { off = true; issue = r.status === 404 ? 'Update controls are not available on this Wizard.' : r.status === 401 || r.status === 403 ? 'Sign in as this Wizard’s owner to manage server updates.' : 'Could not check server updates.'; }
      } catch (_) { off = true; issue = 'Could not reach server updates.'; }
      at = Date.now(); inflight = null; changed(); return st;
    })();
    return inflight;
  }
  async function post(body) {
    const r = await fetch(API, { method: 'POST', credentials: 'same-origin', cache: 'no-store',
      headers: { 'Content-Type': 'application/json', 'X-Wizard-Store': '1' }, body: JSON.stringify(body) });
    const d = await r.json().catch(() => ({}));
    if (!r.ok && !d.note) throw new Error(d.error || `The App Manager said ${r.status}`);
    return d;
  }

  // The one card. Same shape for every state; null when there is nothing to do.
  function card() {
    // The interface: already on the box, a Reload away. Never called Wizard OS.
    if (window.WizWebUpdate?.pending) {
      const s = window.WizWebUpdate.reloadStatus?.() || {};
      const c = { state: 'reload', title: 'Interface updated', line: 'Reload to see the changes', action: 'reload', label: 'Reload' };
      return { ...c, line: s.reason || c.line, label: s.rescuing ? 'Saving…' : s.checking ? 'Getting ready…' : s.going ? 'Reloading…' : s.armed ? 'Cancel waiting reload' : c.label, disabled: !!(s.rescuing || s.checking || s.going) };
    }
    if (!st || issue) return null;
    const auto = st.mode === 'auto';
    const takes = st.quick === true ? 'Takes about 2 minutes' : 'Takes 10–20 minutes';
    if (st.installing) return { state: 'building', title: 'Updating Wizard OS…', line: st.quick === true ? takes : `${takes} · Wizard reconnects by itself`, action: 'apply', label: auto ? 'Install now' : 'Install', disabled: true };
    if (st.unpinned || !st.update_available) return null;
    // Wizard OS: the box itself. Automatic waits for a quiet night; the button is the "now" escape, like macOS.
    const start = busy === 'apply' ? 'Starting…' : '';
    if (st.interrupted) return { state: 'failed', title: 'Wizard OS update didn’t finish', line: auto ? 'Tries again tonight' : takes, action: 'apply', label: start || 'Try again', disabled: !!busy };
    return { state: 'behind', title: 'Wizard OS update', line: auto ? 'Installs tonight when it’s quiet' : takes, action: 'apply', label: start || (auto ? 'Install now' : 'Install'), disabled: !!busy };
  }
  function cardHtml() {
    const c = card(); if (!c) return '';
    return `<div class="osu-card" data-osu-card="${c.state}" role="status"><div class="osu-tx"><b data-osu-title>${esc(c.title)}</b><span>${esc(c.line)}</span></div><button type="button" class="osu-go" data-osu="${c.action}" ${c.disabled ? 'disabled' : ''}>${esc(c.label)}</button>${c.state === 'reload' ? window.WizWebUpdate?.rescueHtml?.('osu') || '' : ''}</div>`;
  }
  const seg = (name, items) => `<div class="st-seg" role="radiogroup" aria-label="${esc(name)}">${items.map(([key, text, on]) => `<button type="button" data-osu="${key}" role="radio" aria-checked="${on}" ${busy ? 'disabled' : ''}>${esc(text)}</button>`).join('')}</div>`;
  // Always retain the installed server version, including when an update card is present.
  function quietHead() {
    if (!st) return '';
    const have = st.installed ? `Wizard OS (server) ${st.installed}` : 'Wizard OS (server) · version unavailable';
    const sub = issue ? 'Last checked · previously verified' : st.unpinned ? 'Updated by hand · not on a release' : card() ? 'Installed on your Wizard' : !st.checked ? 'Couldn’t check for updates' : 'Up to date';
    return `<div class="st-row static osu-head" data-settings-version="server"><span class="st-tx"><b data-osu-title>${esc(have)}</b></span><span class="st-val">${esc(sub)}</span></div>`;
  }
  function html() {
    if (!st || issue) {
      if (!off && !inflight) load();
      return `<div class="st-group" data-osu-group><h4>Wizard OS (server)</h4><p class="st-note" role="status">${esc(issue || 'Checking server updates…')}</p>${issue ? `${quietHead()}${st?.installing ? '<p class="st-note" role="status" data-osu-last-progress>Last checked: Updating Wizard OS… Connection lost; latest progress unverified.</p>' : ''}<p class="st-hint">The current server version and update preference could not be verified.${st ? ' The information above was previously verified, not a live update.' : ' No update preference was changed by this check.'}</p><button type="button" class="st-wide wz-button secondary" data-osu="retry" ${inflight ? 'disabled aria-busy="true"' : ''}>${inflight ? 'Checking…' : 'Try again'}</button>` : ''}</div>`;
    }
    if (Date.now() - at > FRESH) load();
    const auto = st.mode === 'auto';
    const ch = ['stable', 'latest'].includes(st.channel) ? st.channel : '';
    const channel = ch ? `<div class="osu-sec"><span class="osu-lbl">Channel</span>${seg('Release channel', [['ch-stable', 'Stable', ch === 'stable'], ['ch-latest', 'Latest', ch === 'latest']])}<p class="st-hint">${ch === 'stable' ? 'Tested releases only.' : `Every release, for testers.${auto ? ' Automatic installs Stable only.' : ''}`}</p></div>` : '';
    const install = `<div class="osu-sec"><span class="osu-lbl">Updates</span>${seg('Updates', [['auto', 'Automatic', auto], ['ask', 'Ask me', !auto]])}<p class="st-hint">${auto ? 'Overnight, never during a chat.' : 'Nothing installs until you tap Install.'}</p></div>`;
    return `<div class="st-group" data-osu-group>${cardHtml()}${quietHead()}${install}${channel}</div>`;
  }
  function pick(chan, ctx) {
    if (!['stable', 'latest'].includes(chan) || chan === st.channel) return true;
    busy = 'ch'; ctx?.render?.(); ctx?.haptic?.(8);
    post({ channel: chan }).then(d => {
      st = valid(d) ? d : { ...st, channel: chan };
      ctx?.toast?.('✓', chan === 'latest' ? (st.mode === 'auto' ? 'Channel: Latest · Automatic still installs stable only' : 'Channel: Latest') : 'Channel: Stable', 2200);
      at = Date.now();
    }).catch(e => ctx?.toast?.('!', e.message || 'Couldn’t reach the App Manager', 2600))
      .finally(() => { busy = ''; changed(); });
    return true;
  }
  // Reload through the shell's guarded reload (waits for a recording, saves first) when it is there.
  function reload() {
    const W = window.WizWebUpdate;
    if (typeof W?.reload === 'function') { W.reload('tap'); return; }
    location.reload();
  }
  function act(el, ctx) {
    const b = el.closest('[data-osu]'); if (!b) return false;
    const what = b.dataset.osu;
    if (what === 'rescue-save' || what === 'rescue-discard') { void window.WizWebUpdate?.rescue?.(what.slice(7)); return true; }
    if (what === 'reload') { ctx?.haptic?.(8); reload(); return true; }
    if (what === 'retry') { if (!inflight) { off = false; void load(true); ctx?.render?.(); } return true; }
    if (busy || !st || issue) return true;
    if (what.startsWith('ch-')) return pick(what.slice(3), ctx);
    if ((what === 'auto' || what === 'ask') && what === st.mode && st.chosen) return true;
    if (what === 'apply' && card()?.disabled) return true;
    busy = what; ctx?.render?.(); ctx?.haptic?.(8);
    const body = what === 'apply' ? { action: 'apply' } : { mode: what };
    post(body).then(d => {
      if (what === 'apply') {
        if (d.started) { const quick = d.quick === true || (d.quick !== false && st.quick === true); st = { ...st, installing: true, quick }; ctx?.toast?.('↻', `Updating Wizard OS · takes ${quick ? 'about 2 minutes' : '10–20 minutes'}`, 3200); }
        else ctx?.toast?.('!', d.note || d.error || 'Already up to date', 2600);
      } else {
        st = valid(d) ? d : { ...st, mode: what, chosen: true };
        ctx?.toast?.('✓', what === 'auto' ? 'Updates: Automatic' : 'Updates: Ask me', 1800);
      }
      at = Date.now();
    }).catch(e => ctx?.toast?.('!', e.message || 'Couldn’t reach the App Manager', 2600))
      .finally(() => { busy = ''; changed(); if (what === 'apply') setTimeout(() => load(true), 1500); });
    return true;
  }
  /* ---- Home pop-up ---- */
  const POP_STATES = ['behind', 'reload', 'failed'], DISMISS = 'wos.osu.dismissed';
  const store = { get() { try { return window.localStorage.getItem(DISMISS) || ''; } catch (_) { return ''; } }, set(v) { try { window.localStorage.setItem(DISMISS, v); } catch (_) {} } };
  // One key per state worth telling: a new release or a new web build each count as new.
  function popKey(c) {
    if (!c || !POP_STATES.includes(c.state)) return '';
    if (c.state === 'reload') return 'reload:' + (window.WizWebUpdate?.version || 'web');
    return c.state + ':' + (st?.latest || '');
  }
  // Home in view, nothing over it: phone desk 0 with no windows and no sheet; desktop Home or an empty desk, no Settings.
  function homeInView() {
    if (typeof document === 'undefined' || document.hidden || document.querySelector?.('.mz-intro, .rs-sheet, .wos-burst, .tour.on')) return false;
    const P = window.__wos, D = window.__wux;
    // Desktop: any overlay (Settings, the palette, Inbox, the keys sheet, Usage) hides it; it never sits above a modal.
    if (D) return !!(D.homeOpen || !D.ws?.[D.cur]?.wins?.length) && !document.querySelector?.('.dsettings:not([hidden]), #palette:not([hidden]), #keys:not([hidden]), #inbox:not([hidden]), .usage-ov:not([hidden])');
    if (P) return P.idx === 0 && !P.sheet && !P.desks?.[0]?.wins?.length;
    return false;
  }
  function ownsReload() { const c = card(); if (c?.state !== 'reload') return false; const k = popKey(c); return k === store.get() || popShown === k; }
  let popEl = null, popShown = '', popTimer = 0;
  const popCtx = () => { const H = window.__wos || window.__wux; return { toast: (...a) => H?.toast?.(...a), haptic: n => { try { navigator.vibrate?.(n); } catch (_) {} }, render: () => popup(), root: popEl }; };
  // Phone: sit just above the dock (measured, so any skin's pill or orb stays clear); desktop: bottom right (CSS).
  function place() {
    if (!popEl || window.__wux) return;
    const dock = document.querySelector('#dock, .dock'), r = dock?.getBoundingClientRect?.();
    const vh = window.innerHeight || 0, top = r && r.height ? Math.min(r.top, vh) : vh - 140;
    popEl.style.bottom = Math.max(16, vh - top + 12) + 'px';
  }
  function popup() {
    if (typeof document === 'undefined' || !document.body) return;
    const c = card(), k = popKey(c), show = !!k && k !== store.get() && homeInView();
    const was = popShown; popShown = show ? k : '';
    if (!show) { if (popEl) { popEl.remove(); popEl = null; } }
    else {
      if (!popEl) {
        popEl = document.createElement('div'); popEl.className = 'osu-pop'; popEl.setAttribute('role', 'status'); popEl.setAttribute('aria-live', 'polite');
        popEl.dataset.shell = window.__wux ? 'desktop' : 'phone';
        popEl.addEventListener('click', e => {
          const x = e.target.closest('[data-osu-dismiss]');
          if (x) { store.set(popEl?.dataset.key || ''); popup(); return; }
          if (e.target.closest('[data-osu]')) act(e.target, popCtx(), e);
          popup();
        });
        document.body.appendChild(popEl);
      }
      const armed = c.state === 'reload' && window.WizWebUpdate?.armed;
      const html = `<div class="osu-pop-tx"><b>${esc(c.title)}</b><span>${esc(c.line)}</span></div><button type="button" class="osu-pop-go" data-osu="${c.action}" ${c.disabled ? 'disabled' : ''}>${esc(c.label)}</button><button type="button" class="osu-pop-x" data-osu-dismiss aria-label="Dismiss">×</button>${c.state === 'reload' ? window.WizWebUpdate?.rescueHtml?.('osu') || '' : ''}`;
      if (popEl.dataset.key !== k || popEl.dataset.html !== html) { popEl.innerHTML = html; popEl.dataset.key = k; popEl.dataset.html = html; popEl.dataset.state = c.state; }
      place();
    }
    // The old "Interface updated" banner steps aside while the pop-up has the reload (and after its ×).
    if (was !== popShown) { try { window.WizWebUpdate?.render?.(); } catch (_) {} }
    // Home comes and goes without telling this module; while there is something to say, look again every second.
    clearInterval(popTimer); popTimer = 0;
    if (k && k !== store.get() && typeof setInterval === 'function') { popTimer = setInterval(popup, 1000); popTimer?.unref?.(); }
  }
  window.WosUpdates = { html, act, load, card, cardHtml, popup, popKey, ownsReload, homeInView, get state() { return st; } };
  window.WosSettings?.register({ id: 'updates', aliases: ['updates'], available: () => true, html: () => html(), act: (ctx, el) => act(el, ctx) });
  load();
  // Look again by itself so Home hears about a new release without a reload: every minute while an update runs,
  // otherwise every 10 minutes (the App Manager caches stable ~10 min), and whenever the page comes back into view.
  const IDLE = 10 * FRESH;
  const tick = () => { if (!st || document.hidden) return; if (st.installing || Date.now() - at >= IDLE) load(true); };
  const timer = typeof setInterval === 'function' ? setInterval(tick, FRESH) : 0;
  timer?.unref?.();
  document.addEventListener?.('visibilitychange', () => { if (!document.hidden && st && Date.now() - at >= FRESH) load(true); });
})();
