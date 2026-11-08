/* Notifications bell on the Chats panel: a small bell beside search with the unread count from the installed
 * Notifications app (same origin, /notifications/api/count). Tapping it opens Notifications as an ordinary app
 * window, so it sits on a desk you can swipe to. Hidden entirely when no Notifications app is installed, and
 * hidden while a Notifications window is open: its desk mark already carries the same count as a badge, so the
 * owner sees one or the other, never both. Shells expose WizAppOpen(id) and call WosBell.paint() on window changes.
 *
 * Where each source's notifications go (Settings › Notifications; Miguel, 1–4 Nov 2026: one place per source, never
 * a badge AND a row): Chats · Badge · Morning report · Off, loudest to quietest (see "Routing" below). Chats = its items
 * wait in Chats (yellow threads with Open / Archive / Snooze, counted in Chats' Ready badge) and its icon shows no
 * count; Badge = the count on its own icon, nothing in Chats. Default (Miguel, 3 Nov 2026: "notifications should come
 * in the same place chat threads come in"): Chats, for Notifications' own alerts and for every app that publishes an
 * inbox feed; an app without a feed can only show a badge. Chats needs a package that lists inbox threads
 * (wizard/unified-inbox, on by default); without one everything is a badge. Saved on the box (Notifications
 * /api/routes), the same on every device; this device keeps a copy as the fallback.
 *
 * Where things go is one replaceable part, `notify-routing` (version 1): the stock part below is the levels above.
 * A trusted tweak (skin-host `notify` capability) may replace it whole; core only renders what the part answers and
 * never names a tweak. */
(() => {
  'use strict';
  const S = { unread: 0, needs: 0, ok: false, at: 0 };
  const BELL = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M6 16V11a6 6 0 1 1 12 0v5l1.5 2h-15z"/><path d="M10 20.5a2 2 0 0 0 4 0"/></svg>';
  // Installed: openable as an app window, or present as a screenless agent app (its inbox then lives in Chats).
  const installed = () => !!((window.WizCanOpen && window.WizCanOpen('notifications')) || window.WizCore?.backendApps?.().some(a => a.id === 'notifications'));
  const store = (() => { try { return window.localStorage || null; } catch (e) { return null; } })();
  const readJson = (k, d) => { try { const v = JSON.parse(store?.getItem(k) || 'null'); return v && typeof v === 'object' && !Array.isArray(v) ? v : d; } catch (e) { return d; } };
  const writeJson = (k, v) => { try { store?.setItem(k, JSON.stringify(v)); } catch (e) {} };

  /* ---- Routing: notification levels, one place per source (Miguel, 2–4 Nov 2026) ----
   * Chats · Badge · Morning report · Off, loudest to quietest. Morning report (stored `daily`) = one line in the next
   * Morning Report (its Overnight section reads Notifications /api/daily); only for Notifications' own alerts and System
   * notices, greyed out for an app's feed (Mail, Messenger), which would lose its point waiting a day. Off = no badge,
   * nothing in Chats, kept in Notifications' own history.
   * System: notices about Wizard itself (app updates, app connections, Wizard updates) come through Notifications but
   * route on their own rows (`system:<kind>`), default Morning report. One that needs the owner (tagged `needs-you`,
   * priority 4+, or a title asking for him) never goes quiet: it routes as Notifications. System notices set to Badge
   * count on the Settings cog; opening Settings › Notifications is seeing them. A notice is System when its sender tags
   * it `wizard-system,<kind>`, else by known title.
   * Saved ON THE BOX (Notifications /notifications/api/routes), so every device shows the same. This device's copy
   * (`wos.notify.route.v1`) is only the fallback: a cold start, Notifications not answering, or no Notifications app. A
   * choice made offline is sent on the next sync. One-time move: a box with nothing saved takes this device's saved
   * choices (the same key the old Badge | Chats picker and the opt-in levels tweak used) once, then the box wins. */
  const ROUTE_KEY = 'wos.notify.route.v1';
  const APPID = /^[a-z0-9][a-z0-9-]{0,63}$/;
  let ROUTES = readJson(ROUTE_KEY, {});
  const TO = ['chats', 'badge', 'daily', 'off'];
  const SYSTEM = [
    { kind: 'app-updates', name: 'App updates', title: /^(\d+ apps? updated|App updates need a look)$/i },
    { kind: 'connections', name: 'App connections', title: /^(App connection added|Connection needs your OK)$/i },
    { kind: 'wizard-updates', name: 'Wizard updates', title: /^(App Manager updated|Wizard OS updated|Your release needs you to finish an update)$/i },
  ];
  const SYSID = /^system:([a-z-]{1,40})$/;
  const sysOf = id => { const m = SYSID.exec(String(id || '')); return m ? SYSTEM.find(k => k.kind === m[1]) || null : null; };
  const validId = id => APPID.test(id) || !!sysOf(id);
  const dailyOk = id => id === 'notifications' || !!sysOf(id);
  const LABEL = { chats: 'Chats', badge: 'Badge', daily: 'Morning report', off: 'Off' };
  // The Morning Report's own coffee cup (its house sigil, sigils.css .sg-coffee), so the choice reads as that app.
  const CUP = 'M96 235H349V236Q353 236 357 236Q381 236 399 253Q416 270 416 295Q416 320 399 337Q381 354 357 354Q346 354 336 351C316 389 275 414 222 414C148 414 96 365 96 297V281H349V297C349 306 348 315 346 323Q351 325 357 325Q369 325 378 316Q387 307 387 295Q387 282 378 274Q369 265 357 265Q353 265 349 266V260H96ZM173 213Q162 199 163 181Q164 172 171 156Q176 144 176 138Q177 130 172 122Q169 117 170 110Q172 104 177 101Q183 97 189 99Q195 100 199 105Q209 123 207 141Q206 152 199 168Q195 180 194 184Q194 189 198 194Q202 199 201 205Q200 212 195 216Q190 220 184 219Q177 218 173 213ZM251 213Q240 199 241 181Q242 172 249 156Q254 144 254 138Q255 130 250 122Q247 117 248 110Q250 104 255 101Q260 97 267 99Q273 100 276 105Q287 123 285 141Q284 152 277 168Q273 180 272 184Q272 189 275 194Q280 199 279 205Q278 212 273 216Q268 220 262 219Q255 218 251 213Z';
  const ICON = { daily: { viewBox: '0 0 512 512', d: CUP, cls: 'wos-route-mr' }, off: { viewBox: '0 0 16 16', circle: [8, 8, 5.5], d: 'M4.2 11.8l7.6-7.6' } };
  // Which System kind a Notifications item is: the sender's tags (`wizard-system` + kind), else its known title.
  function sysKind(it) {
    if (!it || it.app) return null;
    const tags = Array.isArray(it.tags) ? it.tags.map(String) : [];
    if (tags.includes('wizard-system')) { const k = SYSTEM.find(k => tags.includes(k.kind)); if (k) return k; }
    const t = String(it.title || '').trim();
    return SYSTEM.find(k => k.title.test(t)) || null;
  }
  // Needs the owner: tagged so, high priority, or a title that asks for him. Never silenced by a System row.
  const needsYou = it => (Array.isArray(it.tags) && it.tags.includes('needs-you')) || (Number(it.priority) || 3) >= 4
    || /need(s)? (a look|your OK|you)/i.test(String(it.title || ''));
  /* The app a Notifications item is about (Miguel, 4 Nov 2026: the agent's group held Sniper scans, backups and sales):
   * its sender tags it `app:<id>` (the cron relay's CRON_JOB_APPS, notify's `app`). It is then listed under that app
   * (its name, its mark) and goes where that app's notifications go; one that needs the owner keeps following
   * Notifications' own choice, like System notices. An app that is not installed (yet) leaves it the agent's own. */
  const APP_TAG = /^app:([a-z0-9][a-z0-9-]{0,63})$/;
  function appInstalled(id) {
    if (!id || id === 'notifications' || id === 'wizard') return false;
    try { if ((window.WizCore?.apps?.('mobile')?.APPS || []).some(a => a && a.id === id)) return true; } catch (e) {}
    try { if ((window.WizCore?.backendApps?.() || []).some(a => a && a.id === id)) return true; } catch (e) {}
    return false;
  }
  function fromOf(it) {
    if (!it || it.app) return '';
    const tag = (Array.isArray(it.tags) ? it.tags : []).map(t => APP_TAG.exec(String(t))?.[1]).find(Boolean);
    const id = tag || (typeof it.from === 'string' && APPID.test(it.from) ? it.from : '');
    return appInstalled(id) ? id : '';
  }
  const LV = { notes: [], snapshot: null, seen: new Set(), sync: { at: 0, pending: {}, busy: false } };
  const unreadNote = i => !i.read && !i.archived && !LV.seen.has(i.id);
  const sourceOfNote = it => { const k = sysKind(it); return k && !needsYou(it) ? 'system:' + k.kind : 'notifications'; };
  const badgedSystem = () => LV.notes.filter(i => unreadNote(i) && sysOf(sourceOfNote(i)) && route(sourceOfNote(i)) === 'badge');
  const recentSystem = () => LV.notes.filter(i => sysKind(i)).sort((a, b) => b.time - a.time).slice(0, 8)
    .map(i => ({ title: i.title || sysKind(i).name, text: String(i.message || '').slice(0, 160), time: i.time, fresh: unreadNote(i), needs: needsYou(i) }));
  /* The box copy: read every 30 s at most (and at once after a pick); a pick made while Notifications is down is kept
   * pending and sent on the next sync. GET/POST /notifications/api/routes only. */
  const ROUTES_URL = '/notifications/api/routes';
  async function getBoxRoutes() { const r = await timed(fetch(ROUTES_URL, { cache: 'no-store', credentials: 'same-origin' })); return r.ok ? r.json() : null; }
  async function saveBoxRoutes(routes) {
    const r = await timed(fetch(ROUTES_URL, { method: 'POST', credentials: 'same-origin', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ routes }) }));
    return !!r.ok;
  }
  const keepable = (k, v) => validId(k) && TO.includes(v) && (v !== 'daily' || dailyOk(k));
  async function syncRoutes(force) {
    const Y = LV.sync;
    if (!installed() || Y.busy || (!force && Date.now() - Y.at < 30e3)) return;
    Y.busy = true; Y.at = Date.now();
    try {
      const up = Object.keys(Y.pending).length ? { ...Y.pending } : null;
      if (up && await saveBoxRoutes(up)) for (const k of Object.keys(up)) if (Y.pending[k] === up[k]) delete Y.pending[k];
      const d = await getBoxRoutes();
      if (!d || !d.routes || typeof d.routes !== 'object') return;
      if (!d.saved) {
        // One-time move: a box with nothing saved takes this device's choices, then every device follows the box.
        const keep = {}; for (const [k, v] of Object.entries(ROUTES)) if (keepable(k, v)) keep[k] = v;
        if (Object.keys(keep).length) await saveBoxRoutes(keep);
        return;
      }
      HOST.adopt({ ...d.routes, ...Y.pending });
    } catch (e) {} finally { Y.busy = false; }
  }
  /* The stock `notify-routing` part. Every method is pure data; core escapes and renders it. */
  const STOCK = Object.freeze({
    // A source with no saved choice: apps and Notifications' own alerts start in Chats (Chats is the inbox), System in
    // the Morning report. An unknown or no-longer-allowed value reads as Badge, the quietest place that still shows it.
    route: (id, stored) => {
      const r = stored !== undefined ? stored : sysOf(id) ? 'daily' : 'chats';
      return TO.includes(r) && (r !== 'daily' || dailyOk(id)) ? r : 'badge';
    },
    accepts: (id, to) => keepable(id, to),
    choices: (id, name) => TO.map(to => ({ to, label: LABEL[to], ...(ICON[to] ? { icon: ICON[to] } : {}),
      ...(to === 'daily' ? { disabled: !dailyOk(id), title: dailyOk(id) ? 'One line in tomorrow’s Morning Report' : `${name} would lose its point waiting for the Morning Report` } : {}) })),
    quiet: (id, r) => r === 'off' || r === 'daily',   // true = no badge and nothing in Chats (kept in Notifications' history)
    carried: id => !!sysOf(id),                       // a source Notifications carries besides its own alerts
    sourceOf: it => sourceOfNote(it),                 // which source a Notifications item routes as
    name: id => sysOf(id)?.name || '',
    describe(r, off) {
      if (sysOf(r.id)) return r.route === 'daily' ? 'In the Morning Report · once a day' : r.route === 'off' ? 'Off · listed below' : r.route === 'chats' && !off ? 'In Chats' : 'Badge on the Settings cog';
      return r.route === 'daily' ? 'In the Morning Report · once a day' : r.route === 'off' ? 'Off · kept in its own history' : r.route === 'chats' && !off ? 'In Chats · no badge on its icon' : 'Badge on its icon · not in Chats';
    },
    // "Notifications go to", "App updates go to", "Messenger notifications go to" (never "Notifications notifications").
    ask: (id, name) => id === 'notifications' || sysOf(id) ? `${name} go to` : `${name} notifications go to`,
    moved(id, r, from, name) {
      const back = TO.includes(from) && from !== r ? from : r === 'badge' ? 'chats' : 'badge';
      const text = r === 'off' ? `${name} turned off · ` : r === 'daily' ? `${name} moved to the Morning Report · ` : `${name} moved to ${r === 'badge' ? 'badges' : 'Chats'} · `;
      return { back, text };
    },
    intro: () => ({ lead: [['Each app tells you in one place: a thread in '], ['Chats', true], [' that waits with Archive and Snooze, a '], ['Badge', true], [' on its icon, a line in the '], ['Morning report', true], [', or '], ['Off', true], ['. The Chats badge counts everything waiting in Chats.']],
      foot: installed() ? 'Every app listed starts in Chats. Apps not listed here only show badges. The same on every device.' : 'Every app listed starts in Chats. Apps not listed here only show badges. Saved on this device.' }),
    // More Settings groups: [{ key, title, hint, rows: [source ids], list?: { title, items } }]
    groups: () => installed() ? [{ key: 'sys', title: 'System', hint: 'About Wizard itself, not your apps. Anything that needs you, like a failed update, still reaches you as Notifications do.',
      rows: SYSTEM.map(k => 'system:' + k.kind), list: { title: 'Recent', items: LV.snapshot || recentSystem() } }] : [],
    // { n, label, short }: a count on the Settings cog and a row in Settings (System notices set to Badge).
    attention: () => { const n = badgedSystem().length; return n ? { n, label: 'new from Wizard', short: 'new' } : null; },
    readsAll: () => true,        // read Notifications' whole list even while it is not routed to Chats (System rows)
    notes(items) { LV.notes = Array.isArray(items) ? items : []; for (const id of [...LV.seen]) { const i = LV.notes.find(x => x.id === id); if (!i || i.read || i.archived) LV.seen.delete(id); } },
    picked(id, to) { LV.sync.pending = { ...LV.sync.pending, [id]: to }; void syncRoutes(true); },
    tick(force) { void syncRoutes(force); },
    // Opening Settings › Notifications is seeing the System notices: the cog clears, the list keeps their dots.
    entered() {
      LV.snapshot = recentSystem();
      const ids = badgedSystem().map(i => i.id); if (!ids.length) return;
      for (const id of ids) LV.seen.add(id);
      HOST.changed(); void mark(ids, { read: true });
    },
    left() { LV.snapshot = null; },
  });
  const PART = { version: 1, live: null };
  // The part as core calls it: the replacement while one is live, stock when it has no such method or it throws.
  // Hooks: notes(items), picked(id, to), tick(force), entered(), left(); a replacement may also take attach(host).
  const P = new Proxy({}, { get: (_, k) => (...args) => {
    const live = PART.live?.impl;
    if (live) {
      if (typeof live[k] === 'function') { try { return live[k](...args); } catch (e) {} }
      return undefined; // optional hooks belong to the replacement too; never leak into stock IO
    }
    return typeof STOCK[k] === 'function' ? STOCK[k](...args) : undefined;
  } });
  const own = id => Object.prototype.hasOwnProperty.call(ROUTES, id) ? ROUTES[id] : undefined;
  const route = id => { id = String(id || ''); return P.route(id, own(id)); };
  const chatsReady = () => !!window.WosSkinHost?.inboxList;
  // Effective: Chats only when Chats can list it (a package holds the inbox list) and, for an app, it has a feed.
  // Chats itself ('wizard') is the inbox and always keeps its own badge.
  function inChats(id) {
    id = String(id || '');
    if (!id || id === 'wizard' || route(id) !== 'chats' || !chatsReady()) return false;
    // An app's feed must be answering: one that went away or stays offline gets its own badge back (never nowhere).
    return id === 'notifications' || P.carried(id) ? installed() : known()[id]?.s === 'yes' && !FD.down[id];
  }
  // Quiet (a part's Off, say): no badge anywhere and nothing in Chats. Never true for the stock part.
  const isOff = id => { id = String(id || ''); return !!id && id !== 'wizard' && P.quiet(id, route(id)) === true; };
  // The source that decides one item: its app, else what the part says (stock: Notifications').
  const routeIdOf = it => it?.app ? String(it.app) : it?.from && !needsYou(it) ? String(it.from) : String(P.sourceOf(it) || 'notifications');
  // One item in Chats? An item Notifications carries for an app is there while that app is set to Chats and Chats can
  // list it (no feed of the app's own needed); everything else as its source decides.
  function itemInChats(it) {
    const id = routeIdOf(it);
    return it && !it.app && it.from && id === it.from ? route(id) === 'chats' && chatsReady() && installed() : inChats(id);
  }
  // Unread items Notifications carries for an app that are not in Chats (and not Off): they count on that app's badge.
  function carriedCounts() {
    const n = {};
    for (const i of NOTES.all) if (i.from && !i.read && !i.archived && routeIdOf(i) === i.from && !itemInChats(i) && !isOff(i.from)) n[i.from] = (n[i.from] || 0) + 1;
    return n;
  }
  function setRoute(id, to) {
    id = String(id || ''); if (id === 'wizard' || P.accepts(id, to) !== true) return false;
    if (route(id) === to) return true;
    ROUTES = { ...ROUTES, [id]: to }; writeJson(ROUTE_KEY, ROUTES);
    P.picked(id, to);
    rerouted(); loadItems();
    return true;
  }
  // Something changed what goes where: drop items that no longer belong in Chats at once, recount every badge.
  // Items stay loaded (IN.all) so turning Chats back on shows them at once, with no read and no flicker.
  function rerouted() {
    const keep = Object.freeze(IN.all.filter(itemInChats));
    if (JSON.stringify(keep) !== JSON.stringify(IN.items)) { IN.items = keep; for (const fn of [...IN.subs]) { try { fn(IN.items); } catch (e) {} } }
    window.WizCore?.workspaceNav?.rerouted?.();
    paint();
    window.dispatchEvent(new CustomEvent('wizard:notify-route'));
    inboxChanged(); attentionChanged();
  }
  // What the part puts on the Settings cog; `wizard:notify-attention` fires when it changes.
  let ATT = '';
  function attention() {
    const a = P.attention(); const n = Math.max(0, Math.min(999, Number(a?.n) | 0));
    return n ? Object.freeze({ n, label: String(a.label || 'new').slice(0, 40), short: String(a.short || 'new').slice(0, 20) }) : null;
  }
  function attentionChanged() {
    const a = attention(), k = a ? JSON.stringify(a) : '';
    if (k !== ATT) { ATT = k; window.dispatchEvent(new CustomEvent('wizard:notify-attention', { detail: a })); }
  }
  /* Replace the part (skin-host `notify` capability). Returns a remover, or a reason: 'version' | 'methods' | 'taken'. */
  const REQUIRED = ['route', 'accepts', 'choices', 'quiet', 'carried', 'sourceOf'];
  function replaceRouting(impl, { owner = 'tweak', version } = {}) {
    if (version !== PART.version) return 'version';
    if (!impl || REQUIRED.some(m => typeof impl[m] !== 'function')) return 'methods';
    if (PART.live && PART.live.owner !== owner) return 'taken';
    const live = { impl, owner }; PART.live = live;
    try { impl.attach?.(HOST); } catch (e) {}
    rerouted(); loadItems();
    return () => { if (PART.live !== live) return; PART.live = null; rerouted(); loadItems(); };
  }
  // What a replacement may do back: read this device's saved choices, take the box's, ask for a recount, mark items.
  const HOST = Object.freeze({
    stored: () => ({ ...ROUTES }),
    adopt(next) {
      if (!next || typeof next !== 'object' || Array.isArray(next)) return false;
      const clean = {}; for (const [k, v] of Object.entries(next).slice(0, 200)) if (typeof v === 'string' && k.length <= 80 && v.length <= 20) clean[k] = v;
      if (JSON.stringify(clean) === JSON.stringify(ROUTES)) return false;
      ROUTES = clean; writeJson(ROUTE_KEY, ROUTES); rerouted(); loadItems(); return true;
    },
    route: id => route(id),
    installed: () => installed(),
    changed: () => { paint(); attentionChanged(); window.dispatchEvent(new CustomEvent('wizard:notify-route')); },
    mark: (ids, marks) => mark(ids, marks),
  });

  function html() {
    if (!installed()) return '';
    // Routed to Chats (or its window is open): the count already shows in one place, so no bell. Quiet: nowhere.
    if (inChats('notifications') || isOff('notifications') || (typeof window.WizAppOpen === 'function' && window.WizAppOpen('notifications'))) return '<button type="button" class="ch-bell" data-chbell hidden aria-hidden="true" tabindex="-1"></button>';
    const n = S.unread, lbl = n ? `Notifications, ${n} unread` : 'Notifications';
    return `<button type="button" class="ch-bell${S.needs ? ' needs' : ''}" data-chbell aria-label="${lbl}">${BELL}${n ? `<b>${n > 99 ? '99+' : n}</b>` : ''}</button>`;
  }
  function paint() {
    // The raw count; workspace-navigation shows it as a badge only while Notifications is set to Badge. Items the part
    // routes as another source (none for the stock part) count there instead, never here.
    window.WizCore?.workspaceNav?.setCount('notifications', Math.max(0, S.unread - away()));
    window.WizCore?.workspaceNav?.carry?.(carriedCounts());
    for (const b of document.querySelectorAll('[data-chbell]')) {
      const h = html(); if (!h) { b.remove(); continue; }
      const t = document.createElement('div'); t.innerHTML = h; const nb = t.firstElementChild;
      if (b.outerHTML !== nb.outerHTML) b.replaceWith(nb);
    }
  }
  /* Inbox items for a trusted tweak (skin-host `inbox` capability): newest first, each with read / archived. Fetched only
   * while something watches, on the bell's own cadence. Text stays data; the tweak renders it with textContent.
   * Only what is routed to Chats is listed: Notifications' items, and the items of apps set to Chats. */
  const IN = { items: [], all: [], subs: new Set(), seq: 0 };
  // Notifications' own list as last read (every item, not only what Chats lists), for the part's other sources.
  const NOTES = { all: [] };
  const away = () => NOTES.all.reduce((n, i) => n + (!i.read && !i.archived && routeIdOf(i) !== 'notifications' ? 1 : 0), 0);
  function gotNotes(items) {
    NOTES.all = Object.freeze(items.filter(i => i && i.id).map(cleanItem));
    P.notes(NOTES.all); paint(); attentionChanged();
  }
  const str = (v, n) => String(v == null ? '' : v).slice(0, n);
  // The editor's short message is a preview, not the source. Keep the complete original separately, including
  // paragraphs and long diagnostic output. Legacy items without editor details use their complete body.
  const cleanItem = i => Object.freeze({ id: str(i.id, 128), title: str(i.title, 300), message: str(i.message, 8000), details: String(i.details || i.message || ''), time: Number(i.time) || 0, source: str(i.source, 40), priority: Number(i.priority) || 3, link: str(i.link, 2000), read: !!i.read, archived: !!i.archived,
    ...(Array.isArray(i.tags) ? { tags: Object.freeze(i.tags.slice(0, 8).map(t => str(t, 40))) } : {}),
    ...(i.app ? { app: str(i.app, 64), appName: str(i.appName, 80), key: str(i.key, 200), open: str(i.open, 500) } : {}),
    ...(() => { const f = fromOf(i); return f ? { from: f, fromName: str(appName(f), 80) } : {}; })() });

  /* App inbox feeds (Wizard OS inbox feed v1): an installed app that serves GET /<app>/api/inbox → { inbox: 1, items }
   * lists what needs the owner now (what its badge counts), one item per thing. Read only for apps set to Chats (and
   * once per app to learn which apps have one, for the Settings list). A thing handled in the app leaves its feed, so
   * its row clears by itself. Archive / Snooze are inbox marks (Notifications /api/marks, else this device) covering
   * the item's activity time: newer activity brings it back. Only a definite answer (404/405/410, or a 200 that is
   * not a feed) counts as "no feed", asked again after 30 min; an app that was restarting is asked again in 2 min. */
  const FEED_KEY = 'wos.inbox.feeds.v2', MARK_KEY = 'wos.inbox.appmarks.v1', NO_AGAIN = 30 * 60e3, RETRY = 2 * 60e3;
  const FEED_SKIP = new Set(['notifications', 'wizard', 'wizard-agent-service', 'wizard-connection-router', 'wizard-ux', 'setup', 'side-button', 'pages', 'app-store', 'agents', 'troubleshooter']);
  const FD = { known: null, last: {}, marks: null, retry: {}, probing: null, ready: null, more: {}, down: {} };
  const known = () => FD.known || (FD.known = readJson(FEED_KEY, {}));
  const saveKnown = () => writeJson(FEED_KEY, known());
  const hash = t => { let a = 0x811c9dc5, b = 0x01000193; for (const c of String(t)) { const k = c.codePointAt(0); a = Math.imul(a ^ k, 16777619) >>> 0; b = Math.imul(b ^ k, 2246822519) >>> 0; } return a.toString(16).padStart(8, '0') + b.toString(16).padStart(8, '0'); };
  const appItemId = (app, key) => 'a-' + app + '-' + hash(key);
  const timed = (p, ms = 4000) => Promise.race([p, new Promise((_, no) => setTimeout(() => no(new Error('timeout')), ms))]);
  function feedApps() {
    const ids = new Set();
    try { for (const a of window.WizCore?.apps?.('mobile')?.APPS || []) if (a && a.kind === 'wizard' && a.source && a.url) ids.add(a.id); } catch (e) {}
    try { for (const a of window.WizCore?.backendApps?.() || []) if (a && (a.url || a.originalUrl)) ids.add(a.id); } catch (e) {}
    return [...ids].filter(id => APPID.test(String(id)) && !FEED_SKIP.has(id));
  }
  const appName = id => { try { return window.WizCore?.appMetadata?.(id)?.name || [...(window.WizCore?.apps?.('mobile')?.APPS || [])].find(a => a.id === id)?.name || id; } catch (e) { return id; } };
  // A feed, null when the app definitely has none, or a throw when it could not answer now (restarting, offline).
  async function getFeed(id) {
    const r = await timed(fetch(`/${id}/api/inbox`, { cache: 'no-store', credentials: 'same-origin', redirect: 'error' }));
    if (!r.ok) { if ([404, 405, 410].includes(r.status)) return null; throw new Error('feed ' + r.status); }
    if (!/json/.test(r.headers?.get?.('content-type') || '')) return null;
    const d = await r.json();
    if (!(d && d.inbox === 1 && Array.isArray(d.items))) return null;
    FD.more[id] = d.more === true || d.items.length > 50; return d.items;
  }
  function fromFeed(app, raw) {
    const key = str(raw && raw.key, 200); if (!key) return null;
    const open = typeof raw.open === 'string' && !/^[a-z][a-z0-9+.-]*:|^\/\//i.test(raw.open) ? str(raw.open.replace(/^\/+/, ''), 500) : '';
    const text = str(raw.text, 2000);
    return { id: appItemId(app, key), app, appName: appName(app), key, title: str(raw.title, 300), message: text, details: text, time: Number(raw.time) || 0, source: app,
      priority: Math.max(1, Math.min(5, Number(raw.priority) || 3)), link: '', open };
  }
  async function readFeed(id, now) {
    const k = known()[id];
    if (k && k.s === 'no' && now - k.at < NO_AGAIN) return null;
    if (!(k && k.s === 'yes') && FD.retry[id] && now < FD.retry[id]) return null;
    try {
      const items = await getFeed(id);
      delete FD.retry[id];
      if (!items) { const was = k && k.s === 'yes'; known()[id] = { s: 'no', at: now }; saveKnown(); delete FD.last[id]; delete FD.down[id]; if (was) rerouted(); return null; }
      if (!k || k.s !== 'yes') { known()[id] = { s: 'yes', at: now }; saveKnown(); }
      if (FD.down[id]) { delete FD.down[id]; rerouted(); }
      const list = items.slice(0, 50).map(it => fromFeed(id, it)).filter(Boolean);
      FD.last[id] = { at: now, items: list }; return list;
    } catch (e) {
      if (!(k && k.s === 'yes')) FD.retry[id] = now + RETRY;
      // A feed that stops answering keeps its last items a few minutes (no flicker), then they go and its badge
      // comes back until it answers again.
      if (FD.last[id] && now - FD.last[id].at < 5 * 60e3) return FD.last[id].items;
      if (k && k.s === 'yes' && !FD.down[id]) { FD.down[id] = true; rerouted(); }
      return null;
    }
  }
  const feedList = () => feedApps().filter(id => known()[id]?.s === 'yes');
  /* Which installed apps have a feed (for Settings › Notifications). One probe per app, remembered on the device. */
  function discover() {
    if (FD.probing) return FD.probing;
    const now = Date.now(), want = feedApps().filter(id => { const k = known()[id]; return !k || (k.s === 'no' && now - k.at >= NO_AGAIN); });
    if (!want.length) return Promise.resolve(false);
    const before = JSON.stringify(feedList());
    FD.probing = Promise.all(want.map(id => readFeed(id, now))).then(() => {
      FD.probing = null; const changed = before !== JSON.stringify(feedList());
      if (changed) { rerouted(); loadItems(); }
      return changed;
    }, () => { FD.probing = null; return false; });
    return FD.probing;
  }
  async function loadMarks() {
    if (installed()) try { const r = await timed(fetch('/notifications/api/marks', { cache: 'no-store', credentials: 'same-origin' })); if (r.ok) { const d = await r.json(); if (d && d.marks) { FD.marks = d.marks; return; } } } catch (e) {}
    if (!FD.marks) FD.marks = readJson(MARK_KEY, {});
  }
  const withMarks = list => { const M = FD.marks || {}; return list.map(it => { const m = M[it.id]; const covers = m && Number(m.at) >= it.time; return { ...it, read: !!(covers && (m.read || m.archived)), archived: !!(covers && m.archived) }; }); };
  // Only apps set to Chats are asked for their items; an app on Badge costs nothing here.
  async function loadFeeds() {
    if (!chatsReady()) return [];
    const now = Date.now(), out = [];
    await Promise.all(feedApps().filter(id => route(id) === 'chats').map(async id => { const l = await readFeed(id, now); if (l) out.push(...l); }));
    if (out.length) await loadMarks();
    return withMarks(out.filter(it => inChats(it.app)));
  }
  const readNotes = () => fetch('/notifications/api/items?view=all&limit=200', { cache: 'no-store', credentials: 'same-origin' }).then(r => r.ok ? r.json() : null, () => null);
  async function loadItems() {
    if (!IN.subs.size) {
      // Nothing lists them, but the part reads the whole list for its own sources (never the stock part).
      if (installed() && P.readsAll() === true) { const d = await readNotes().catch(() => null); if (d && Array.isArray(d.items)) gotNotes(d.items); }
      return;
    }
    const seq = ++IN.seq;
    try {
      const all = P.readsAll() === true, wantNotes = installed() && (all || route('notifications') === 'chats');
      const [notes, apps] = await Promise.all([
        wantNotes ? readNotes() : null,
        loadFeeds().catch(() => []),
      ]);
      if (seq !== IN.seq) return;
      if (wantNotes && notes && Array.isArray(notes.items)) gotNotes(notes.items);
      // A failed Notifications read keeps its last items; Notifications set to Badge lists none. With the whole list
      // read, only what routes to Chats is listed there.
      const got = (notes && Array.isArray(notes.items) ? notes.items : IN.items.filter(i => !i.app)).filter(i => i && i.id).map(cleanItem);
      const base = !wantNotes ? [] : !all ? got : got.filter(i => routeIdOf(i) === 'notifications' ? route('notifications') === 'chats' : itemInChats(i));
      const before = JSON.stringify(IN.items);
      IN.all = Object.freeze([...base, ...apps].filter(i => i && i.id).map(cleanItem).sort((a, b) => b.time - a.time));
      IN.items = Object.freeze(IN.all.filter(itemInChats));
      for (const fn of [...IN.subs]) { try { fn(IN.items); } catch (e) {} }
      if (before !== JSON.stringify(IN.items)) inboxChanged();
    } catch (e) {}
  }
  function watch(fn) {
    if (typeof fn !== 'function') return () => {};
    IN.subs.add(fn); if (IN.items.length) { try { fn(IN.items); } catch (e) {} }
    loadItems();
    return () => { IN.subs.delete(fn); };
  }
  function inboxChanged() { window.dispatchEvent(new CustomEvent('wizard:notifications')); }
  // Same rows as Chats Ready, including quiet/snoozed ones, never completed ones. Apps set to Chats count here too.
  // Chats shows "50+" when an app routed here lists only its newest items (Mail: the newest 50 unread).
  const readyMore = () => !!window.WosSkinHost?.inboxList && Object.keys(FD.more).some(id => FD.more[id] && inChats(id));
  const readyCount = () => window.WosSkinHost?.inboxList ? IN.items.filter(i => !i.archived).length : 0;
  // Badge only: keep Ready's full inventory and all other app routing/count policies unchanged.
  const unreadCount = () => window.WosSkinHost?.inboxList ? IN.items.filter(i => !i.archived && !i.read).length : 0;
  async function mark(ids, marks) {
    ids = (ids || []).map(String).filter(Boolean); if (!ids.length) return false;
    const appIds = ids.filter(id => IN.items.some(i => i.id === id && i.app));
    if (!installed() && appIds.length < ids.length) return false;
    // Moves at once; a failed write puts it back on the reload below. Archiving also marks read (the server does too).
    const next = { ...marks, ...(marks.archived ? { read: true } : {}) };
    // An app item's mark covers its activity as of now: newer activity in the app brings it back.
    const at = {}; for (const id of appIds) { const it = IN.items.find(i => i.id === id); at[id] = it ? it.time : Date.now() / 1000; }
    const upd = l => Object.freeze(l.map(i => ids.includes(i.id) ? Object.freeze({ ...i, ...next }) : i));
    IN.all = upd(IN.all); IN.items = upd(IN.items); for (const fn of [...IN.subs]) { try { fn(IN.items); } catch (e) {} }
    inboxChanged();
    if (appIds.length) { FD.marks = { ...(FD.marks || {}) }; for (const id of appIds) FD.marks[id] = { ...(FD.marks[id] || {}), ...next, at: at[id] }; writeJson(MARK_KEY, FD.marks); }
    let ok = !installed();
    try {
      if (installed()) { const r = await fetch('/notifications/api/mark', { method: 'POST', credentials: 'same-origin', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ ids, ...marks, ...(appIds.length ? { at } : {}) }) }); ok = r.ok; }
    } catch (e) {}
    await refresh(true); await loadItems();
    return ok;
  }
  // At most one count read every 10 s (60 s after a failure): a burst of registry events must
  // never become a request storm against the Notifications app (26 Oct 2026: ~50 req/s).
  // An owner action (mark) forces a read; one landing during an in-flight read reruns once right after it.
  let inflight = false, nextAt = 0, again = false;
  async function refresh(force) {
    P.tick(force === true);
    if (!installed()) { if (IN.subs.size && (force === true || Date.now() >= nextAt)) { nextAt = Date.now() + 10000; loadItems(); } return; }
    if (inflight) { if (force === true) again = true; return; }
    if (force !== true && Date.now() < nextAt) return;
    inflight = true; nextAt = Date.now() + 10000;
    loadItems();
    try {
      const r = await fetch('/notifications/api/count', { cache: 'no-store', credentials: 'same-origin' });
      if (!r.ok) { nextAt = Date.now() + 60000; return; }
      const d = await r.json();
      const ch = d.unread !== S.unread || d.needs !== S.needs;
      Object.assign(S, { unread: d.unread | 0, needs: d.needs | 0, ok: true, at: Date.now() });
      if (ch) { paint(); window.dispatchEvent(new CustomEvent('wizard:notifications', { detail: { ...S } })); }
    } catch (e) { nextAt = Date.now() + 60000; } finally { inflight = false; if (again) { again = false; refresh(true); } }
  }
  // The Notifications window tells us its count as soon as something is marked read.
  addEventListener('message', e => {
    const d = e.data; if (e.origin !== location.origin || !d || d.type !== 'wizard:notifications:count') return;
    S.unread = d.unread | 0; S.needs = d.needs | 0; paint(); loadItems();
  });
  document.addEventListener('click', e => {
    if (!e.target.closest('[data-chbell]')) return;
    e.preventDefault(); e.stopPropagation();
    if (typeof window.WizOpenApp === 'function') window.WizOpenApp('notifications');
  }, true);
  document.addEventListener('visibilitychange', () => { if (!document.hidden) refresh(); });
  addEventListener('wizard:apps', () => { refresh(); paint(); });
  // The inbox package came or went (skin-host fires wos:prefs): what Chats can hold changed, so recount.
  // Everything already read moves at once (no request); apps' feeds are read only when Chats can now list them.
  addEventListener('wos:prefs', () => { const on = chatsReady(); if (on !== FD.ready) { FD.ready = on; rerouted(); if (on && feedList().some(id => route(id) === 'chats')) loadItems(); } });
  // Another tab on this device changed a choice.
  addEventListener('storage', e => { if (e && e.key === ROUTE_KEY) { ROUTES = readJson(ROUTE_KEY, {}); rerouted(); loadItems(); } });
  setInterval(() => { if (!document.hidden) refresh(); }, 60000);
  setTimeout(refresh, 800);
  // The box's saved choices, at once (a device without Notifications keeps its own copy).
  void syncRoutes(true);
  const nameOf = id => { const own = P.name(id); if (own) return String(own); const n = appName(id); return id === 'notifications' && n === 'notifications' ? 'Notifications' : n; };
  /* The list Settings › Notifications shows: Notifications (when installed), then every app with a feed, by name. */
  function routes() {
    const out = [];
    if (installed()) out.push({ id: 'notifications', name: nameOf('notifications'), route: route('notifications'), chats: inChats('notifications') });
    const carried = [...LV.notes.map(fromOf), ...Object.keys(ROUTES)].filter(appInstalled);
    for (const id of [...new Set([...feedList(), ...carried])].sort((a, b) => appName(a).localeCompare(appName(b)))) out.push({ id, name: appName(id), route: route(id), chats: inChats(id) });
    return out;
  }

  /* THE Badge | Chats picker (Miguel, 1 Nov 2026: "one simple design everywhere"). Settings › Notifications and every
   * notification opened in Chats render this one function, and both write the one saved route above, so a change in
   * either place shows in the other at once (`wizard:notify-route`). Badge wears a badge dot, Chats a chat bubble. */
  const ROUTE_ICON = {
    badge: '<svg class="wos-route-ic" viewBox="0 0 16 16" aria-hidden="true"><circle cx="8" cy="8" r="4.5"/></svg>',
    chats: '<svg class="wos-route-ic" viewBox="0 0 16 16" aria-hidden="true"><path d="M3 2.5h10A1.5 1.5 0 0 1 14.5 4v6a1.5 1.5 0 0 1-1.5 1.5H7.5L4.5 14v-2.5H3A1.5 1.5 0 0 1 1.5 10V4A1.5 1.5 0 0 1 3 2.5z"/></svg>',
  };
  const escH = t => String(t == null ? '' : t).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
  // A part's own icon: an optional circle and one path on its own grid (data only; no markup crosses).
  const num = v => Number.isFinite(+v) && +v >= 0 && +v <= 1024 ? String(+v) : null;
  const partIcon = ic => {
    if (!ic || !/^[0-9 .]{3,40}$/.test(String(ic.viewBox || '')) || !/^[MmLlHhVvCcSsQqTtAaZz0-9 ,.\-]{1,4000}$/.test(String(ic.d || ''))) return '';
    const c = Array.isArray(ic.circle) && ic.circle.length === 3 && ic.circle.every(num) ? `<circle cx="${num(ic.circle[0])}" cy="${num(ic.circle[1])}" r="${num(ic.circle[2])}"/>` : '';
    return `<svg class="wos-route-ic${/^[a-z0-9-]{1,30}$/.test(String(ic.cls || '')) ? ' ' + ic.cls : ''}" viewBox="${ic.viewBox}" aria-hidden="true">${c}<path d="${ic.d}"/></svg>`;
  };
  const TOID = /^[a-z][a-z0-9-]{0,19}$/;
  function picker(id, { name, off = false } = {}) {
    id = String(id || ''); const nm = name || nameOf(id), now = route(id), cur = off && now === 'chats' ? 'badge' : now;
    const got = P.choices(id, nm), list = (Array.isArray(got) ? got : STOCK.choices(id, nm)).filter(c => c && TOID.test(String(c.to))).slice(0, 6);
    return `<div class="st-seg st-nr-seg wos-route" role="radiogroup" aria-label="Where ${escH(nm)} notifications go">${list.map(c => { const to = String(c.to); return `<button type="button" role="radio" data-notify-route="${escH(id)}" data-notify-to="${to}" aria-checked="${cur === to}"${(to === 'chats' && off) || c.disabled === true ? ' disabled' : ''}${c.title ? ` title="${escH(String(c.title).slice(0, 200))}"` : ''}>${ROUTE_ICON[to] && !c.icon ? ROUTE_ICON[to] : partIcon(c.icon)}<span>${escH(String(c.label || to).slice(0, 40))}</span></button>`; }).join('')}</div>`;
  }
  /* Picked Badge from inside Chats: its items have already left Chats (setRoute). The shell's own toast says so, with
   * Undo, which puts the app back on Chats. `toast` is the shell's toast(icon, text, ms); the button is added here. */
  function movedToast(id, toast, ms = 5000, from) {
    id = String(id || ''); let m = P.moved(id, route(id), from, nameOf(id));
    if (!m || typeof m.text !== 'string' || !P.accepts(id, m.back)) m = STOCK.moved(id, route(id), from, nameOf(id));
    const back = m.back, text = m.text.slice(0, 200);
    try { toast?.('●', '', ms); } catch (e) {}
    const t = document.getElementById?.('toast'); if (!t) return null;
    const spans = t.querySelectorAll('span'); const tx = spans[spans.length - 1];
    if (tx) tx.textContent = text; else t.append(document.createTextNode(text));
    const b = document.createElement('button'); b.type = 'button'; b.className = 'wos-undo'; b.dataset.wosUndo = id; b.textContent = 'Undo';
    b.addEventListener('click', e => { e.preventDefault(); e.stopPropagation(); setRoute(id, back); t.classList.remove('show', 'on'); });
    t.append(b);
    return b;
  }
  /* Settings › Notifications reads these from the part (stock: the Badge | Chats wording, no extra groups). */
  const text = (v, n) => String(v == null ? '' : v).slice(0, n);
  const describe = (r, off) => text(P.describe(r, off) ?? STOCK.describe(r, off), 120);
  const ask = (id, name) => text(P.ask(id, name) || STOCK.ask(id, name), 120);
  function intro() {
    const i = P.intro(); const ok = i && Array.isArray(i.lead) && i.lead.every(x => Array.isArray(x) && typeof x[0] === 'string');
    const v = ok ? i : STOCK.intro();
    return Object.freeze({ lead: v.lead.slice(0, 16).map(([t, b]) => Object.freeze([text(t, 300), b === true])), foot: text(v.foot, 300) });
  }
  function groups() {
    const g = P.groups(); if (!Array.isArray(g)) return [];
    return g.slice(0, 4).filter(x => x && typeof x.title === 'string').map(x => Object.freeze({
      title: text(x.title, 60), hint: text(x.hint, 300), key: /^[a-z][a-z0-9-]{0,19}$/.test(String(x.key || '')) ? x.key : 'more',
      rows: (Array.isArray(x.rows) ? x.rows : []).map(String).filter(id => /^[a-z0-9][a-z0-9:-]{0,80}$/.test(id)).slice(0, 12).map(id => Object.freeze({ id, name: nameOf(id), route: route(id), chats: inChats(id) })),
      list: x.list && Array.isArray(x.list.items) ? Object.freeze({ title: text(x.list.title, 60), items: x.list.items.slice(0, 20).map(i => Object.freeze({ title: text(i?.title, 300), text: text(i?.text, 160), time: Number(i?.time) || 0, fresh: i?.fresh === true, needs: i?.needs === true })) }) : null,
    }));
  }
  const routing = Object.freeze({ version: PART.version, replace: replaceRouting, get owner() { return PART.live?.owner || null; } });
  /** The label of where this source goes now (its picker's choice: Chats, Badge, Morning report, Off). */
  function routeLabel(id) { id = String(id || ''); const now = route(id), got = P.choices(id, nameOf(id)), list = Array.isArray(got) ? got : STOCK.choices(id, nameOf(id)); const c = list.find(x => x && String(x.to) === now); return c ? String(c.label || now).slice(0, 40) : ''; }
  window.WosBell = { html, refresh, paint, watch, mark, readyCount, unreadCount, readyMore, route, setRoute, inChats, isOff, routeIdOf, itemInChats, routes, discover, picker, routeLabel, movedToast, nameOf, describe, ask, intro, groups, attention, routing,
    entered: () => { P.entered(); }, left: () => { P.left(); },
    get chatsAvailable() { return chatsReady(); }, item: id => IN.items.find(i => i.id === String(id)) || null, items: () => IN.items, icon: BELL, get state() { return { ...S }; } };
})();
