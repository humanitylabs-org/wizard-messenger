/* App kinds (Miguel's design): both shells sort apps the same way, in App Store order.
 *   Apps        anything with a screen you use
 *   Agent apps  backend-only apps your agent uses (tap = its settings sheet)
 *   Agents      each agent's chats; "Build agents" opens the Agents app that makes and manages them
 *   Connectors  sign-ins to another service (AI subscriptions, bank feeds, Cloudflare...)
 * System apps (the defaults Wizard OS ships for its parking spots, wizard-os docs/SYSTEM_APPS.md) lead their group and
 * wear one accent ring. Every group ends with a "+ Get ..." tile that opens that section of the App Store.
 * The phone launcher / New desk (app.js) and the desktop app selector (desktop/desktop.js) both read this. */
(function () {
  'use strict';
  // The app's declared type (wizard.md `type: external`, projected by the Agent Service) decides. The id list and the
  // summary wording are only a fallback for tiles without a type (cached lists from older Agent Services).
  const CONNECTOR_IDS = new Set(['wizard-chatgpt', 'wizard-claude', 'wizard-tinfoil', 'wizard-cloudflare', 'wizard-monarch', 'wizard-simplefin', 'wizard-teller']);
  const isConnector = a => !!a && (typeof a.type === 'string' && a.type ? a.type === 'external'
    : CONNECTOR_IDS.has(a.id) || /^(connect|sign in to)\b/i.test(a.desc || ''));
  const SYSTEM_IDS = new Set(['wizard', 'setup', 'files', 'notifications', 'transcriber', 'browser', 'secret-drop', 'wizard-chatgpt', 'wizard-claude']);
  const isSystem = a => !!a && (SYSTEM_IDS.has(a.id) || a.system === true);
  const inDev = a => !isSystem(a) && (window.WizCore?.isInDevelopment?.(a) || a.source === 'launcher.json' || /-next$/.test(a.id) || /\(test\)\s*$/i.test(a.name || ''));
  // Notifications shown in Chats (a package holds WosSkinHost.inboxThreads): its page is no longer the way in, so it
  // sits with the agent apps (system ring, tap = its settings sheet) even while the app still serves a page.
  const inChats = a => !!a && a.id === 'notifications' && !!window.WosSkinHost?.inboxThreads;
  const byName = (x, y) => (isSystem(y) - isSystem(x)) || x.name.localeCompare(y.name, undefined, { sensitivity: 'base' });
  // Section labels and the App Store section each "+ Get" tile opens (store/store.js KINDS ids).
  const LABELS = Object.freeze({ apps: 'Apps', wiz: 'Agent apps', agents: 'Agents', conns: 'Connectors' });
  const GET = Object.freeze({ apps: ['apps', 'Get apps'], wiz: ['agent-apps', 'Get agent apps'], agents: ['agents', 'Get agents'], conns: ['connections', 'Get connectors'] });
  const storeUrl = kind => '/wizard-os-home/store/index.html?kind=' + encodeURIComponent(kind || 'apps');
  function kinds(APPS, APP) {
    const C = window.WizCore || {};
    const mine = APPS.filter(a => !['app-store', 'system', 'agents'].includes(a.id) && !C.isMaintenanceApp?.(a) && ['wizard', 'chats', 'usuals', 'view'].includes(a.kind));
    const conns = mine.filter(a => a.kind === 'wizard' && isConnector(a));
    // Agents: each agent's chats, main agent first (as registered). The Agents app itself is the "Build agents" tile.
    const agents = mine.filter(a => a.kind === 'chats').sort((x, y) => isSystem(y) - isSystem(x));
    const people = mine.filter(a => a.kind !== 'chats' && !conns.includes(a) && !inChats(a)).sort(byName);
    // In development (James, 23 Oct 2026): launcher links and test copies fold under their own row.
    const apps = people.filter(a => !inDev(a)), dev = people.filter(inDev);
    const back = [...mine.filter(inChats), ...(C.backendApps?.() || []).filter(a => !APP[a.id])];
    return { apps, dev, agents, builder: APP.agents || null, wiz: back.filter(a => !isConnector(a)).sort(byName), conns: [...conns, ...back.filter(isConnector)].sort(byName) };
  }
  const sysFirst = list => [...list.filter(isSystem), ...list.filter(a => !isSystem(a))];
  /* The kinds as plain rows for layouts (the Orb and Apps views' app sheet, both shells): { apps, wiz, agents, conns,
   * dev }, system apps first, the main agent left out (it is Chats); ico(a) draws the shell's own mark. */
  function rows(APPS, APP, ico) {
    const K = kinds(APPS, APP), row = a => ({ id: a.id, name: a.name, icon: ico(a), system: isSystem(a) });
    const agents = K.agents.filter(a => a.id !== 'wizard').map(row);
    if (K.builder) agents.push({ ...row(K.builder), name: 'Build agents' });
    return { apps: sysFirst(K.apps).map(row), wiz: sysFirst(K.wiz).map(row), agents, conns: sysFirst(K.conns).map(row), dev: K.dev.map(row) };
  }
  /* Open any of those rows: an app with a screen (or an agent's chats) through openApp; an agent app (no screen) shows
   * its settings sheet. Returns false for an unknown id. */
  function openRow(APPS, APP, id, openApp) {
    const a = APP[id] || (window.WizCore?.backendApps?.() || []).find(x => x.id === id); if (!a) return false;
    if (APP[id] && (a.url || a.kind !== 'wizard')) return openApp(id) !== false;
    window.WosAppRoute?.open(a.id, { name: a.name }); return true;
  }
  window.WosAppKinds = Object.freeze({ inChats, isSystem, isConnector, inDev, byName, kinds, sysFirst, rows, openRow, LABELS, GET, storeUrl });
})();
