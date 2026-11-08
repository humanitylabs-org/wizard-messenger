/* One local command grammar; explicit command misses NEVER fall through to an agent. */
(() => {
 'use strict';
 // Tap = message to the agent, never a command (James, 21 Oct 2026).
 // Typed command surfaces retain their existing grammar; long press = command.
 const isMessageTake = (kind, typed = false) => !typed && kind !== 'command';
 function create({ CHATS, APP, appByName, findApp, quickSearch, sendSnap }) {
 const norm = window.WizCore.norm;
  function chatsVoice(t, snap, kind) {
    const v = snap?.view; if (!v || v.kind !== 'thread list') return null;
    const s = norm(window.WizConfig.stripAddress(t)).replace(/ please$/, '').trim();
    if (/^(clear focus|all chats|show all chats)$/.test(s)) return { action: 'chats_focus', f: null };
    const focus = s.match(/^focus (.+)$/);
    if (focus) { const f = CHATS.matchFilters(focus[1], 20).find(f => f.kind !== 'status'); return f ? { action: 'chats_focus', f } : { action: 'chats_search', q: focus[1] }; }
    if (/^(clear|remove|reset|turn off|drop) (the |all )?(filters?|chips?)$|^(show )?(all|every) (chats|threads)$|^show everything$|^no filters?$/.test(s)) return { action: 'chats_filter', clear: true };
    let m = s.match(/^(?:filter|filtered) (?:by |to |for |on )?(.+)$/) || s.match(/^only (?:show )?(.+)$/) || s.match(/^show (?:me )?(?:only |just )?(?:the |my )?(.+?)(?: only| chats| threads)?$/);
    if (m) {
      const want = m[1].replace(/ (chats|threads|messages|ones)$/, '').trim();
      const f = CHATS.matchFilters(want, 1)[0];
      if (f) return { action: 'chats_filter', f };
      if (/^(?:filter|filtered)/.test(s)) return { action: 'chats_search', q: want };
      return null; // "show me …" with no filter match is not ours
    }
    // Only a held orb reaches voice command parsing; typed search keeps its grammar.
    m = s.match(kind === 'command' ? /^(?:search|find|look for)(?: (?:my |the )?(?:chats|threads|messages))?(?: for)? (.+)$/ : /^search(?: (?:my |the )?(?:chats|threads|messages))?(?: for)? (.+)$/);
    if (m) return { action: 'chats_search', q: m[1] };
    return null;
  }
  function localParse(t, snap, kind, typed = false) {
    if (isMessageTake(kind, typed)) return null;
    const explicit = norm(window.WizConfig.stripAddress(t)).replace(/ please$/, '');
    if (kind === 'command' || (snap || sendSnap()).view?.kind !== 'chat thread') {
    if (/^(help|show help|open help|gestures|keyboard shortcuts)$/.test(explicit)) return { action:'open_view', view:'help' };
    if (/^(settings|open settings|usage|show usage)$/.test(explicit)) return { action:'open_view', view:/usage/.test(explicit)?'usage':'settings' };
    const feature=window.WosFeatures?.entries.find(f=>[f.id,norm(f.title||f.id)].includes(explicit.replace(/^(open|show) /,'')));
    if(feature)return {action:'open_view',view:feature.id};
    }
    const context = {APP, kind, text:String(t || '').trim(), view:(snap || sendSnap()).view};
    { const c=window.WosAppVoice?.parse('priority',t,context); if(c) return c; }
    // The strong quick-search spells ("ask AI …", "image search …", "find images of …") win everywhere too: on the
    // Chats list a held "find images of cats" used to filter the list instead of opening Search.
    { const q0 = quickSearch(t); if (q0?.strong) return { action: 'quick_search', query: q0.query, tab: q0.tab }; }
    { const cv = chatsVoice(t, snap || sendSnap(), kind); if (cv) return cv; }
    { const c=window.WosAppVoice?.parse('beforeNames',t,context); if(c) return c; }
    if (/^(show |open )?(my )?(inbox|notifications)$/.test(explicit)) return { action: 'open_view', view: 'chats' };
    // A bare app name opens that app, no "open" needed (James, 12 Oct: "If I say the name of an app, it should just
    // open that app"). Held: anywhere, even over an app or a thread. Taps never enter this grammar.
    // Exact names and aliases only (appByName), never a fuzzy guess.
    if (kind === 'command' || (snap || sendSnap()).view?.kind !== 'chat thread') { const an = appByName(t); if (an) return { action: 'open_app', app: an.name }; }
    { const c=window.WosAppVoice?.parse('app',t,context); if(c) return c; }
    // The quick-search spell ("image search …", "search …") opens the search sheet on-device, even over a thread.
    // A held orb is always a command, so there even the plain "search for …" form is the search app's.
    const qs = quickSearch(t);
    if (qs && (qs.strong || kind === 'command' || (snap || sendSnap()).view?.kind !== 'chat thread')) return { action: 'quick_search', query: qs.query, tab: qs.tab };
    const s = norm(window.WizConfig.stripAddress(t)).replace(/ please$/, '');
    if (/^(next|right) desk|^desk (right|next)/.test(s)) return { action: 'desk', to: 'next' };
    if (/^(previous|prev|left|last) desk|^desk (left|back)/.test(s)) return { action: 'desk', to: 'prev' };
    if (/^(go )?home( screen| desk)?$/.test(s)) return { action: 'desk', to: 'home' };
    if (/^(clear|close) (this |the )?desk$/.test(s)) return { action: 'clear_desk' };
    if (/^(close|quit|kill) (this |the )?(window|app)$/.test(s)) return { action: 'close_window' };
    if (/^(go |make (it|this) )?full ?screen$|^(maximi[sz]e|expand)( (it|this))?$/.test(s)) return { action: 'fullscreen', on: true };
    if (/^(exit full ?screen|tile( it| this)?|un ?maximi[sz]e|shrink( it| this)?)$/.test(s)) return { action: 'fullscreen', on: false };
    let m = s.match(/^move (?:this|it|the window)(?: window| app)? (?:to )?(?:the )?(left|right|next|previous|prev)(?: desk)?$/);
    if (m) return { action: 'move_window', to: /left|prev/.test(m[1]) ? 'prev' : 'next' };
    if (/^((change|switch|pick|choose|open|show) )?(the |my |a )?(skins?|themes?)$|^change (the |my )?look$/.test(s)) return { action: 'open_view', view: 'skin' };
    if (/^(show |open )?(my )?(apps|app list|launcher|all apps)$/.test(s)) return { action: 'open_view', view: 'apps' };
    m = s.match(/^(?:open|launch|show|start|go to|switch to)\s+(?:me\s+)?(.+)$/);
    if (m) {
      const q = m[1];
      const a = findApp(q); if (a) return { action: 'open_app', app: a.name };
    }
    return null;
  }

 return {parse:localParse};
 }
 function execute(c, text, H) {
   const a = c.action;
   const appResult=window.WosAppVoice?.execute(c,text,H);
   if (appResult != null) return appResult;
   if (a === 'search' && c.query) return H.search(c.query, c.tab);
   if (a === 'quick_search') return H.search(c.query, c.tab);
   if (a === 'chats_focus' || a === 'chats_filter' || a === 'chats_search') {
     const w = H.focused(); if (w?.app !== 'chats') return false;
     if (a === 'chats_focus') H.chats.setFocus(w, c.f); else if (c.clear) H.chats.clearAll(w); else if (c.f) H.chats.addFilter(w, c.f); else H.chats.setQuery(w, c.q); return true;
   }
   if (a === 'open_view' || a === 'view' || a === 'show') {
     const v = c.view;
     if (window.WosFeatures.open(v, {date:c.date})) return true;
     if (window.WosSettings.route(v, H.settings)) return true;
     if (v === 'chats' || /inbox|notif/.test(v)) { H.chatList(); return true; }
     if (/apps|launcher/.test(v)) { H.launcher(''); return true; }
     return false;
   }
   if (/open|launch|app/.test(a)) { const app = H.findApp(c.app || c.target); return app ? !!H.openApp(app) : false; }
   return H.layout(c, text);
 }
 // These handlers finish synchronous shell navigation before returning. Music,
 // purchases, searches and app voice handoffs may only acknowledge acceptance.
 function completedLocally(c, ok) {
   return !!ok && !c?.then_agent && ['open_app','open','launch','app','open_view','view','show',
     'chats_focus','chats_filter','chats_search','desk','clear_desk','close_window','fullscreen','move_window'].includes(c?.action);
 }
 window.WosCommands = { create, execute, completedLocally, isMessageTake };
})();
