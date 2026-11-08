/* App-owned command claims. Core routes utterances, never parses app grammar. */
(() => {
  'use strict';
  const warned = new Set();
  function aliases(apps, norm) {
    const names = new Map();
    // Registry order is installation order; never sort before resolving a claim.
    for (const app of apps) for (const name of app.voice_names || []) {
      if (typeof name !== 'string') continue;
      const key = norm(name).replace(/^(open |the |my )+/, '').replace(/ (app|application|view)$/, ''); if (!key) continue;
      if (names.has(key) && names.get(key).id !== app.id) {
        const conflict = key + ':' + app.id;
        if (!warned.has(conflict)) { warned.add(conflict); console.warn('Duplicate app voice name refused:', key, app.id, 'using', names.get(key).id); }
      } else names.set(key, app);
    }
    return names;
  }
  function parse(stage, text, ctx) {
    // The legacy contextual player already owned this later stage. Installed
    // fallback aliases must not overtake it (for example, while music is open).
    if (stage === 'app') { const c = window.WosVoiceLegacy?.parse(stage, text, ctx); if (c) return c; }
    if (stage === 'beforeNames' || stage === 'app' || stage === 'priority' && ctx.kind === 'command') {
      const claim = window.WizAppServices?.voiceCommand(ctx.text ?? text, {...ctx, stage});
      if (claim) return claim;
    }
    return window.WosVoiceLegacy?.parse(stage, text, ctx) || null;
  }
  function execute(c, text, H) {
    if (c.action === 'app_voice') return window.WizAppServices?.runVoiceCommand(c, H.musicDone) || false;
    return window.WosVoiceLegacy?.execute(c, text, H) ?? null;
  }
  window.WosAppVoice = {aliases, parse, execute, install: h => window.WosVoiceLegacy?.install(h)};
})();
