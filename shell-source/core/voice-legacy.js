/* DELETION: remove this entire adapter when installed apps publish voice_names and
 * register WizardApp.voice.commands handlers; Food also needs APK A automation.
 * Frozen pre-slice-5 grammar + transport. Music has a raw receiver, but no claim
 * contract, and its parser lacks open-and-play. Do not grow this grammar. */
(() => {
  'use strict';
  // Retired id aliases are owned by the app registry (apps.js), not a second voice registry.
  const legacyAliases = { troubleshooter: 'troubleshooter', troubleshooting: 'troubleshooter', troubleshoot: 'troubleshooter', 'fix wizard': 'troubleshooter', wizard: 'wizard', chats: 'wizard', chat: 'wizard', threads: 'wizard', 'google maps': 'maps', map: 'maps', 'cine queue': 'movies', cinequeue: 'movies', 'i ching': 'iching', notifications: 'wizard', 'side key': 'side-button', 'power button': 'side-button', 'side button assistant': 'side-button', inbox: 'wizard', terminal: 'console', music: 'spotify', reader: 'wisdom', 'wisdom reader': 'wisdom', 'wizard reader': 'wisdom', collections: 'wisdom', jobs: 'wisdom', 'steve jobs': 'wisdom', signal: 'wizard-signal', shop: 'shopping', meetings: 'mizel', 'meeting recorder': 'mizel' };
  const norm = s => String(s || '').toLowerCase().replace(/[^a-z0-9ก-๙ ]+/g, ' ').replace(/\s+/g, ' ').trim();
  const MUSIC = '(?: the)?(?: music| song| track| tune| playback| it| this)?';
  const MUSIC_WORD = /\b(music|song|songs|track|tune|tunes|playlist|radio|spotify)\b/;
  // Search shows the results list in Wizard Music; it never plays the first hit (James, 12 Oct 2026).
  // The spell, said anywhere: "music search Home Tides" (also "search music for …", "search … in music",
  // "open music and search for …"). Plain "search for X" is the player's only with Wizard Music in front.
  const FIND = '(?:search|find|look up|look for)(?: for)?(?: me)?';
  const SPELL = [
    new RegExp(`^(?:open )?(?:wizard )?music(?: and| then)? ${FIND} (.+)$`),
    new RegExp(`^(?:search|find|look up|look for) (?:wizard |my )?music(?: for)? (.+)$`),
    new RegExp(`^${FIND} (.+?) (?:in|on) (?:wizard |my )?music$`),
  ];
  const PLAIN_FIND = new RegExp(`^${FIND} (.+)$`);
  /** The words as said (case kept) for the query the normalised grammar found. */
  const asSaid = (text, found) => {
    const words = found.split(' ').filter(Boolean).map(w => w.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'));
    const m = words.length ? String(text).match(new RegExp(words.join('[^a-z0-9ก-๙]+'), 'i')) : null;
    return m ? m[0] : found;
  };

  /** -> {op, ...} | null. `strong` marks a phrase that can only mean music (safe on a tap).
   * inMusic: a held take with Wizard Music in front (anything is for the player). front: Music is in front. */
  function parse(text, inMusic, front) {
    const s = norm(window.WizConfig.stripAddress(text)).replace(/ (?:please|for me|now)$/, '').replace(/^(?:(?:can|could|would|will) you |please |maybe |just |go ahead and )+/, '');
    if (!s) return null;
    for (const rx of SPELL) { const q = s.match(rx); if (q) return { op: 'search', query: asSaid(text, q[1]), strong: true }; }
    { const q = (inMusic || front) ? s.match(PLAIN_FIND) : null; if (q) return { op: 'search', query: asSaid(text, q[1]), strong: true }; }
    const strong = MUSIC_WORD.test(s);
    const c = cmd => ({ ...cmd, strong: strong || cmd.strong || false });
    if (new RegExp(`^(?:pause|stop|hold)${MUSIC}$|^(?:shut up|silence)$`).test(s)) return c({ op: 'pause' });
    if (new RegExp(`^(?:resume|unpause|continue|keep playing|play again)${MUSIC}$|^play$`).test(s)) return c({ op: 'resume' });
    if (/^(?:next|skip)(?: song| track| one| this(?: song| track| one)?| it| that)?$|^(?:play )?(?:the )?next (?:song|track|one)$/.test(s)) return c({ op: 'next' });
    if (/^(?:previous|last)(?: song| track| one)$|^previous$|^go back a (?:song|track)$|^play (?:the )?(?:previous|last) (?:song|track|one)$/.test(s)) return c({ op: 'previous' });
    if (/^(?:turn (?:it|this|the (?:music|volume|sound)) up|turn up(?: the (?:music|volume|sound))?|volume up|louder|(?:a bit |a little |make it |little )louder|crank it(?: up)?|raise the volume|more volume|pump it up)$/.test(s)) return c({ op: 'volume', dir: 'up' });
    if (/^(?:turn (?:it|this|the (?:music|volume|sound)) down|turn down(?: the (?:music|volume|sound))?|volume down|quieter|softer|(?:a bit |a little |make it |little )(?:quieter|softer)|lower the volume|less volume)$/.test(s)) return c({ op: 'volume', dir: 'down' });
    if (new RegExp(`^mute${MUSIC}$`).test(s)) return c({ op: 'volume', dir: 'mute' });
    if (new RegExp(`^unmute${MUSIC}$`).test(s)) return c({ op: 'volume', dir: 'unmute' });
    let m = s.match(/^(?:set )?(?:the )?volume (?:to |at )?(\d{1,3})(?: percent)?$/);
    if (m) return c({ op: 'volume', dir: 'set', level: Math.min(100, +m[1]) / 100, strong: true });
    if (/^(?:i (?:really )?(?:like|love) (?:this|it|that)(?: song| track| one)?|(?:like|love) (?:this|it)(?: song| track)?|thumbs up|save (?:this|it)(?: song| track)?|more like this)$/.test(s)) return c({ op: 'like' });
    if (/^(?:i (?:don t|do not|dont) (?:like|want) (?:this|it|that)(?: song| track| one)?|thumbs down|dislike(?: this| it)?(?: song| track)?|i hate (?:this|it)(?: song| track)?|not this(?: song| one)?|no more of this|less like this)$/.test(s)) return c({ op: 'dislike' });
    if (/^(?:what s|what is|whats) (?:this|playing|this song|the song|this track)$|^what song is (?:this|playing)$|^who (?:is|s) (?:this|singing|playing)$/.test(s)) return c({ op: 'what' });
    m = s.match(/^(?:play|put on|throw on|queue up|shuffle|blast|spin|listen to|i want to (?:hear|listen to)|i wanna (?:hear|listen to)|let s (?:hear|listen to))\b\s*(.*)$/);
    if (m) return c({ op: 'play', said: String(text).trim() });
    // "Open music and play Home Tides": the player is the app being opened, so this is a play.
    m = s.match(/^(?:open|launch|start|go to) (?:wizard |my |the )?music(?: app)?(?: and| then)+ (?:play|put on) (.+)$/);
    if (m) return { op: 'play', said: 'play ' + asSaid(text, m[1]).replace(/[.!?]+$/, ''), strong: true };
    if (inMusic) return c({ op: 'play', said: String(text).trim() });
    return null;
  }

  let host = null; // { findWin, openMusic, toast, frameOf }
  let seq = 0;
  const pending = new Map(); // id -> { win, cmd, timer, acked, t0 }
  const log = e => { window.__musicLog = (window.__musicLog || []).concat(e).slice(-40); };

  const settle = (p, ok) => { const f = p.onDone; p.onDone = null; try { f && f(ok); } catch (_) {} };
  function post(id) {
    const p = pending.get(id); if (!p || p.acked) return;
    const f = host.frameOf(p.win);
    try { if (f && f.contentWindow) f.contentWindow.postMessage({ type: 'wizard-os:music', id, cmd: p.cmd }, location.origin); } catch (e) {}
    if (performance.now() - p.t0 > 20000) { pending.delete(id); log('timeout:' + p.cmd.op); settle(p, false); host.toast('♫', 'Wizard Music didn’t answer · open it and try again', 3200); return; }
    p.timer = setTimeout(() => post(id), 400);
  }
  function send(win, cmd, onDone) {
    const id = 'm' + Date.now().toString(36) + (++seq);
    const clean = { ...cmd }; delete clean.strong;
    pending.set(id, { win, cmd: clean, acked: false, t0: performance.now(), timer: 0, onDone });
    log('send:' + clean.op);
    post(id);
    return id;
  }
  window.addEventListener('message', ev => {
    const d = ev.data;
    if (!d || typeof d !== 'object' || ev.origin !== location.origin || typeof d.type !== 'string' || !d.type.startsWith('wizard-os:music:')) return;
    const p = d.id ? pending.get(d.id) : null;
    if (!p || ev.source !== host.frameOf(p.win)?.contentWindow) return;
    if (d.type === 'wizard-os:music:ack' && p) { p.acked = true; clearTimeout(p.timer); log('ack:' + p.cmd.op); return; }
    if (d.type === 'wizard-os:music:done') {
      if (p) { clearTimeout(p.timer); pending.delete(d.id); settle(p, !!d.ok); }
      log((d.ok ? 'done:' : 'fail:') + (d.text || ''));
      if (d.text) host.toast(d.ok ? '♫' : '♪', String(d.text).replace(/[<>&]/g, ''), d.ok ? 2400 : 3400);
    }
  });

  /** Run a parsed command. True when it was taken (the outcome arrives as a toast). */
  function run(cmd, onDone) {
    if (!host) return false;
    let win = host.findWin();
    if (!win) {
      // Nothing to control without the player; "play …", "music search …" (and resume) open Wizard Music on this desk.
      if (cmd.op !== 'play' && cmd.op !== 'resume' && cmd.op !== 'search') { host.toast('♪', 'Nothing is playing · say “play …” to start', 2600); if (onDone) onDone(true); return true; }
      win = host.openMusic();
      if (!win) return false;
    }
    if (cmd.op === 'search') host.toast('♫', `Searching music for “${String(cmd.query).replace(/[<>&]/g, '')}”…`, 4000);
    if (cmd.op === 'play') {
      const what = String(cmd.said || '').replace(/^\s*(?:play|put on)\s+/i, '').replace(/[.!?]+$/, '');
      host.toast('♫', what && !/^(?:some |the )?music$/i.test(what) ? `Finding “${what.replace(/[<>&]/g, '')}”…` : 'Starting your music…', 4000);
    }
    send(win, cmd, onDone);
    return true;
  }

  // DELETE with APK A: installed legacy bridge method names, never UI or grammar.
  // Food was id `usuals` at /usuals/ before app ids followed app names; both stay admitted while boxes move.
  const FOOD_METHODS = [
    'usuals', 'usualsTeach', 'usualsCancel', 'usualsKeepName', 'usualsRun', 'usualsDelete', 'usualsSave', 'usualsMatch', 'voiceTypingSettings'
  ];
  window.WizDeviceLegacy = [{appId:'food', path:'/food/', probe:'usuals', phoneOnly:true, methods:FOOD_METHODS},
    {appId:'usuals', path:'/usuals/', probe:'usuals', phoneOnly:true, methods:FOOD_METHODS}];
  window.__wosUsuals = () => window.WizAndroidRelay?.resume();
  window.WosVoiceLegacy = {
    alias(q, APP) {
      if (/^(music|my music|the music|songs|music app|music player|wizard music)$/.test(q) && APP['wizard-music']) return APP['wizard-music'];
      const aliases = window.WizCore?.appIdAliases || {};
      const old = Object.keys(aliases).find(id => norm(id) === q);
      const id = legacyAliases[q] || aliases[old];
      const previous = Object.keys(aliases).find(key => aliases[key] === id);
      return APP[id] || APP[previous] || APP[q.replace(/ /g, '')] || null; // unrenamed boxes keep working
    },
    parse(stage, text, ctx) {
      const music = window.WosMusic;
      if (stage === 'beforeNames') return null;
      if (!music.available()) return null;
      if (stage === 'priority') { const cmd=music.parse(text,false,false); return cmd?.op === 'search' ? {action:'music',cmd} : null; }
      const front=ctx.view?.appId === 'wizard-music';
      const cmd=music.parse(text,ctx.kind === 'command' && front,front);
      const typedOk=cmd && (cmd.strong || (cmd.op === 'play' && ctx.view?.kind !== 'chat thread' && norm(text).split(' ').length <= 8));
      return cmd && (ctx.kind === 'command' || typedOk) ? {action:'music',cmd} : null;
    },
    execute(c, text, H) {
      if (c.action === 'music') return window.WosMusic.run(c.cmd,H.musicDone) || false;
      if (c.action === 'play_music') return window.WosMusic.run({op:'play',said:'play '+String(c.query || '').trim()},H.musicDone) || false;
      return null;
    },
    install(h) { window.WosMusic.install({app:()=>h.apps()['wizard-music'],findWin:()=>h.findWin('wizard-music'),openMusic:()=>h.open('wizard-music'),frameOf:h.frameOf,toast:h.toast}); },
  };
  window.WosMusic = {
    parse, run,
    install(h) { host = h; },
    available: () => !!(host && host.app()),
    pending: () => pending.size,
  };
})();
