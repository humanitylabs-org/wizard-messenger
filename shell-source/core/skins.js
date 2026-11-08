/* Wizard OS skins: one shell, many looks. Frame composition extends the original colour-only contract.
 * See docs/SKIN-FRAMES.md. Existing definitions without frame retain the Standard foundation.
 * Original palette contract (James, 11 Oct 2026: "same exact layout, feel and sizing; a skin of
 * our existing operating system"). A skin changes only:
 *   - design tokens, set inline on <html> so every existing var(--ink)/var(--glass)/… follows (blended while browsing)
 *   - the clock typeface and a few card details (core/skins.css, keyed on html[data-skin])
 *   - the living background: two canvases under the desks (#skinA/#skinB) that crossfade while browsing. Their
 *     motion is gated by core/scenery.js (WosScenery): drawn ~30 fps only while Home is in view and touched in the
 *     last 45 s; otherwise frozen on the last frame (James, 12 Oct: no battery drain when not viewed).
 *   - the orb's colour, through a CSS filter; orb.js stays byte-identical with the Android copy
 * Nebula is the original look and sets nothing. Choice persists per device in localStorage 'wos.skin'
 * (box-level theme.json sync comes later). Ten skins: Nebula, Grove, Tide, Ember, Signal, Novairecito, Sepia, Dark, Light, Landscapes (Paper retired 12 Oct).
 * API: WosSkin.list, .current, .set(id), .preview(pos), .commit(i), .index(id), .pkgOf(id),
 *      .families, .family, .familyOf(id), .lastIn(family), .setFamily(family) (skins and their palettes).
 * Collaborator skins keep their look and behaviour in web/skins/<dir>/ (see web/skins/README.md), declared with pkg. */
(() => {
  'use strict';
  const KEY = 'wos.skin';
  const TAU = Math.PI * 2, rnd = (a, b) => a + Math.random() * (b - a);
  const T = (o) => o; // token table helper (readability)
  // Skins and palettes (James, 21 Oct 2026; wizard-os spec/SKINS_AND_VIEWS.md). A skin is one look-and-feel; each entry
  // below is one of its palettes (colour sets). The saved choice stays the palette id, so nothing migrates.
  // A skin entry not listed here is a skin of its own with one palette (so a new collaborator skin needs no edit here).
  const FAMILIES = [
    { id: 'wizard', name: 'Wizard', tweaks: 'wizard', who: 'The original Wizard look, in five moods.', palettes: ['nebula', 'grove', 'tide', 'ember', 'signal'] },
    { id: 'mizel', name: 'Mizel', tweaks: 'miguel', recommends: { chats: 'mizel-chats' }, who: 'Miguel’s skin: black and white, or a new landscape every minute.', palettes: ['obsidian', 'obsidian-light', 'landscapes', 'landscapes-light'] },
    { id: 'novairecito', name: 'Novairecito', who: 'Novaire’s skin: a noir violet command deck, or warm paper for long reads.', palettes: ['novairecito', 'sepia'] },
  ];
  const LAST = 'wos.skin.last.';
  const SKINS = [
    { id: 'nebula', name: 'Nebula', who: 'For dreamers and late-night thinkers. The original.', orb: [0, 1, 1],
      t: T({ bg: '#05030c', ink: '#f3efff', 'ink-2': '#b9b0d8', 'ink-3': '#7d74a3', line: 'rgba(205,190,255,.13)', 'line-2': 'rgba(205,190,255,.24)', glass: 'rgba(18,12,38,.58)', 'glass-2': 'rgba(28,19,58,.72)',
        violet: '#8f63ff', 'violet-2': '#b99bff', pink: '#ff5ccf', cyan: '#3fe0ff', amber: '#ffbe55', green: '#4ff0b0', red: '#ff6b86',
        'sk-time-a': '#ffffff', 'sk-time-b': '#b8a6ff', 'sk-dock': 'rgba(8,5,18,.94)', 'sk-dock-line': 'rgba(205,190,255,.10)', 'sk-ddot': 'rgba(205,190,255,.45)', 'sk-tour': 'rgba(8,5,18,.78)', 'sk-dim': 'rgba(3,1,10,.74)', 'sk-win': 'rgba(12,8,26,.82)' }) },
    { id: 'grove', name: 'Grove', who: 'For the grounded. Walkers, gardeners, anyone who finds screens too loud.', orb: [-160, .85, 1.08],
      t: T({ bg: '#050b07', ink: '#eef5e9', 'ink-2': '#b5cbb9', 'ink-3': '#7f9a86', line: 'rgba(207,232,200,.14)', 'line-2': 'rgba(207,232,200,.26)', glass: 'rgba(10,22,14,.55)', 'glass-2': 'rgba(16,32,22,.78)',
        violet: '#7ddc8a', 'violet-2': '#e6c66b', pink: '#e8a07a', cyan: '#8fd6c4', amber: '#f0b45a', green: '#9be37a', red: '#e8806a',
        'sk-time-a': '#f6f9ee', 'sk-time-b': '#cfe3a6', 'sk-dock': 'rgba(9,22,14,.94)', 'sk-dock-line': 'rgba(207,232,200,.10)', 'sk-ddot': 'rgba(207,232,200,.45)', 'sk-tour': 'rgba(9,22,14,.82)', 'sk-dim': 'rgba(4,12,7,.72)', 'sk-win': 'rgba(8,15,10,.84)' }) },
    { id: 'tide', name: 'Tide', who: 'For the calm. Breath, water, slow mornings.', orb: [-95, 1, 1.06],
      t: T({ bg: '#052a36', ink: '#e8f6f8', 'ink-2': '#a9cdd4', 'ink-3': '#6f98a2', line: 'rgba(168,230,238,.15)', 'line-2': 'rgba(168,230,238,.27)', glass: 'rgba(4,38,50,.5)', 'glass-2': 'rgba(8,56,72,.7)',
        violet: '#3fd2c0', 'violet-2': '#7fd8ff', pink: '#ffd08a', cyan: '#7fd8ff', amber: '#ffc070', green: '#8fe3a8', red: '#ff8a8a',
        'sk-time-a': '#f2fbfc', 'sk-time-b': '#9fe6e6', 'sk-dock': 'rgba(3,26,34,.94)', 'sk-dock-line': 'rgba(168,230,238,.10)', 'sk-ddot': 'rgba(168,230,238,.45)', 'sk-tour': 'rgba(3,26,34,.82)', 'sk-dim': 'rgba(1,14,19,.72)', 'sk-win': 'rgba(4,26,34,.82)' }) },
    { id: 'ember', name: 'Ember', who: 'For night owls who want a lamp, not a lab.', orb: [115, 1.15, 1.05],
      t: T({ bg: '#090504', ink: '#ffe9d6', 'ink-2': '#d4b49c', 'ink-3': '#a0806a', line: 'rgba(255,176,122,.15)', 'line-2': 'rgba(255,176,122,.27)', glass: 'rgba(26,13,7,.58)', 'glass-2': 'rgba(36,19,11,.8)',
        violet: '#ff8a3d', 'violet-2': '#ffb470', pink: '#e2553a', cyan: '#ffcf8a', amber: '#ffc24d', green: '#ffd27a', red: '#ff6a4d',
        'sk-time-a': '#fff1e2', 'sk-time-b': '#ffb27a', 'sk-dock': 'rgba(20,10,6,.95)', 'sk-dock-line': 'rgba(255,176,122,.10)', 'sk-ddot': 'rgba(255,176,122,.45)', 'sk-tour': 'rgba(20,10,6,.84)', 'sk-dim': 'rgba(10,5,3,.74)', 'sk-win': 'rgba(16,9,5,.85)' }) },
    { id: 'signal', name: 'Signal', who: 'For operators. A phone that means business.', orb: [-125, 1.2, 1.1],
      t: T({ bg: '#000000', ink: '#d8ffd8', 'ink-2': '#8fc79a', 'ink-3': '#4f8a5a', line: 'rgba(57,255,140,.16)', 'line-2': 'rgba(57,255,140,.32)', glass: 'rgba(0,10,4,.62)', 'glass-2': 'rgba(0,20,8,.76)',
        violet: '#39ff8c', 'violet-2': '#ffbe55', pink: '#5ad1ff', cyan: '#5ad1ff', amber: '#ffbe55', green: '#39ff8c', red: '#ff5f56',
        'sk-time-a': '#e6ffe6', 'sk-time-b': '#39ff8c', 'sk-dock': 'rgba(0,0,0,.96)', 'sk-dock-line': 'rgba(57,255,140,.18)', 'sk-ddot': 'rgba(57,255,140,.5)', 'sk-tour': 'rgba(0,8,3,.88)', 'sk-dim': 'rgba(0,0,0,.76)', 'sk-win': 'rgba(0,10,4,.86)' }) },
    { id: 'novairecito', pkg: { css: true, js: true, when: 'always', dir: 'novairecito' }, name: 'Noir', who: 'Noir focus with Wizard violet. The boss’s quiet command deck.', orb: [0, 1.12, .96],
      t: T({ bg: '#05030a', ink: '#f4f0ff', 'ink-2': '#c2b8da', 'ink-3': '#81769a', line: 'rgba(197,174,255,.14)', 'line-2': 'rgba(197,174,255,.28)', glass: 'rgba(13,9,24,.66)', 'glass-2': 'rgba(22,14,40,.82)',
        violet: '#946cff', 'violet-2': '#c3aaff', pink: '#d96fc7', cyan: '#75cfe8', amber: '#d8ad63', green: '#70d4a2', red: '#ef718a',
        'sk-time-a': '#ffffff', 'sk-time-b': '#a98bff', 'sk-dock': 'rgba(6,4,12,.96)', 'sk-dock-line': 'rgba(197,174,255,.12)', 'sk-ddot': 'rgba(197,174,255,.5)', 'sk-tour': 'rgba(8,5,16,.86)', 'sk-dim': 'rgba(2,1,6,.78)', 'sk-win': 'rgba(9,6,18,.9)' }) },
    { id: 'sepia', pkg: { css: true, dir: 'sepia' }, name: 'Sepia', who: 'For long reads. Warm vintage paper with soft, readable ink.', orb: [18, .38, .82],
      t: T({ bg: '#f3ead2', ink: '#332b22', 'ink-2': '#5f5243', 'ink-3': '#786651', line: 'rgba(86,65,40,.16)', 'line-2': 'rgba(86,65,40,.30)', glass: 'rgba(236,222,190,.76)', 'glass-2': 'rgba(247,239,219,.92)',
        violet: '#76533d', 'violet-2': '#684733', pink: '#9a5c56', cyan: '#557878', amber: '#94691d', green: '#57704d', red: '#a34236',
        'sk-time-a': '#3a3026', 'sk-time-b': '#735b43', 'sk-dock': 'rgba(238,225,197,.96)', 'sk-dock-line': 'rgba(86,65,40,.16)', 'sk-ddot': 'rgba(86,65,40,.52)', 'sk-tour': 'rgba(247,239,219,.94)', 'sk-dim': 'rgba(75,55,32,.24)', 'sk-win': 'rgba(247,239,219,.94)' }) },
    { id: 'obsidian', pkg: { css: true, dir: 'obsidian' }, name: 'Dark', who: 'Miguel’s dark skin. Black and white, with the violet orb.', orb: [0, 1, 1.05],
      t: T({ bg: '#000000', ink: '#f7f7f7', 'ink-2': '#c4c4c4', 'ink-3': '#8a8a8a', line: 'rgba(255,255,255,.12)', 'line-2': 'rgba(255,255,255,.26)', glass: 'rgba(20,20,20,.62)', 'glass-2': 'rgba(24,24,24,.86)',
        violet: '#ffffff', 'violet-2': '#e8e8e8', pink: '#bdbdbd', cyan: '#d6d6d6', amber: '#e6b15c', green: '#9fd8a8', red: '#ff6b6b',
        'sk-time-a': '#ffffff', 'sk-time-b': '#9a9a9a', 'sk-dock': 'rgba(0,0,0,.96)', 'sk-dock-line': 'rgba(255,255,255,.12)', 'sk-ddot': 'rgba(255,255,255,.5)', 'sk-tour': 'rgba(10,10,10,.9)', 'sk-dim': 'rgba(0,0,0,.78)', 'sk-win': 'rgba(10,10,10,.9)' }) },
    { id: 'obsidian-light', pkg: { css: true, dir: 'obsidian' }, name: 'Light', who: 'Miguel’s light skin. Ink on white paper, with the violet orb.', orb: [0, 1.1, .95],
      t: T({ bg: '#ffffff', ink: '#000000', 'ink-2': '#2e2e2e', 'ink-3': '#6b6b6b', line: 'rgba(0,0,0,.14)', 'line-2': 'rgba(0,0,0,.32)', glass: 'rgba(244,244,244,.78)', 'glass-2': 'rgba(240,240,240,.94)',
        violet: '#000000', 'violet-2': '#1a1a1a', pink: '#555555', cyan: '#3a3a3a', amber: '#9a6400', green: '#0f7a3e', red: '#c62828',
        'sk-time-a': '#000000', 'sk-time-b': '#5a5a5a', 'sk-dock': 'rgba(255,255,255,.96)', 'sk-dock-line': 'rgba(0,0,0,.12)', 'sk-ddot': 'rgba(0,0,0,.5)', 'sk-tour': 'rgba(250,250,250,.94)', 'sk-dim': 'rgba(255,255,255,.72)', 'sk-win': 'rgba(255,255,255,.94)' }) },
    // Opinionated: Landscapes rotates the classic macOS landscape wallpapers (Mavericks → Golden Gate) behind frosted glass.
    // Split by Miguel (28 Oct 2026): Landscapes Dark rotates the night and dusk photos under dark glass; Landscapes Light the
    // day photos under light glass. The dark one keeps the 'landscapes' id so a saved choice carries over.
    { id: 'landscapes', pkg: { css: true, dir: 'landscapes' }, name: 'Landscapes Dark', who: 'Miguel’s photo skin after dark: night and dusk views under dark glass.', orb: [0, 1, 1.05],
      t: T({ bg: '#0B0A10', ink: '#ffffff', 'ink-2': 'rgba(255,255,255,.80)', 'ink-3': 'rgba(255,255,255,.58)', line: 'rgba(255,255,255,.16)', 'line-2': 'rgba(255,255,255,.28)', glass: 'rgba(16,14,22,.52)', 'glass-2': 'rgba(20,18,26,.74)',
        violet: '#7A5CFF', 'violet-2': '#A08CFF', pink: '#ff7ac8', cyan: '#6fd8ff', amber: '#ffbe55', green: '#62e6a8', red: '#ff6b86',
        'sk-time-a': '#ffffff', 'sk-time-b': '#ffffff', 'sk-dock': 'rgba(11,10,16,.62)', 'sk-dock-line': 'rgba(255,255,255,.10)', 'sk-ddot': 'rgba(255,255,255,.6)', 'sk-tour': 'rgba(11,10,16,.80)', 'sk-dim': 'rgba(11,10,16,.70)', 'sk-win': 'rgba(16,14,22,.85)' }) },
    { id: 'landscapes-light', pkg: { css: true, dir: 'landscapes' }, name: 'Landscapes Light', who: 'Miguel’s photo skin by day: bright views under light glass.', orb: [0, 1.1, .95],
      t: T({ bg: '#EEF1F4', ink: '#111216', 'ink-2': 'rgba(17,18,22,.76)', 'ink-3': 'rgba(17,18,22,.54)', line: 'rgba(0,0,0,.12)', 'line-2': 'rgba(0,0,0,.26)', glass: 'rgba(250,250,252,.58)', 'glass-2': 'rgba(250,250,252,.80)',
        violet: '#5B3FE6', 'violet-2': '#4A30CC', pink: '#c42a83', cyan: '#0a7fae', amber: '#9a6400', green: '#0f7a4a', red: '#c8304c',
        'sk-time-a': '#ffffff', 'sk-time-b': '#ffffff', 'sk-dock': 'rgba(250,250,252,.66)', 'sk-dock-line': 'rgba(0,0,0,.08)', 'sk-ddot': 'rgba(0,0,0,.5)', 'sk-tour': 'rgba(250,250,252,.88)', 'sk-dim': 'rgba(240,242,246,.66)', 'sk-win': 'rgba(250,250,252,.85)' }) },
  ];
  // Each skin's own display face (the one its Home clock wears; fonts self-hosted in skins.css), for the preview cards
  // in the skin picker. Kept outside the entries so each skin definition stays as its author made it.
  const FACES = {
    nebula: { family: 'ui-sans-serif, system-ui, -apple-system, "Segoe UI", sans-serif', weight: 600 },
    grove: { family: '"Sk Fraunces", Georgia, serif', weight: 600 },
    tide: { family: '"Sk Jost", ui-sans-serif, sans-serif', weight: 400 },
    ember: { family: '"Sk Cormorant", Georgia, serif', weight: 500, style: 'italic' },
    signal: { family: '"Sk Mono", ui-monospace, monospace', weight: 500 },
    sepia: { family: '"Sk Fraunces", Georgia, serif', weight: 600 },
  };
  const FAMS = (() => { // resolved once: every skin entry gets .family, every family its palettes in SKINS order
    const out = [];
    for (const s of SKINS) {
      let f = FAMILIES.find(x => x.palettes.includes(s.id)) || out.find(x => x.id === s.id);
      if (!f) f = { id: s.id, name: s.name, who: s.who, palettes: [s.id] };
      if (!out.includes(f)) out.push(f);
      s.family = f.id;
    }
    return out.map(f => Object.freeze({ id: f.id, name: f.name, who: f.who, ...(f.recommends ? { recommends: Object.freeze({ ...f.recommends }) } : {}), ...(f.tweaks ? { tweaks: f.tweaks } : {}), palettes: Object.freeze(SKINS.filter(s => s.family === f.id).map(s => s.id)) }));
  })();
  const N = SKINS.length;
  const idxOf = id => Math.max(0, SKINS.findIndex(s => s.id === id));
  const stored = () => { try { return localStorage.getItem(KEY); } catch (e) { return null; } };
  const FRAME_KEY = 'wos.skin.composition.v1', F = window.WosSkinFrame;
  let composition = null;
  try { const saved = JSON.parse(localStorage.getItem(FRAME_KEY)); if (saved && F) composition = F.composition(saved, SKINS); } catch (_) { /* corrupt/old data: safe skin default */ }
  // Borderless on both shells. The App borders tweak borrows a transient framed foundation.
  let borrowedFoundation = null;
  const shellFrame = { foundation: 'borderless' };
  const frameOf = skin => ({ ...(composition?.frame || skin.frame || shellFrame), foundation: borrowedFoundation || 'borderless' });
  function applyFrame(skin) { F?.apply(frameOf(skin)); }
  function saveComposition() { try { localStorage.setItem(FRAME_KEY, JSON.stringify(composition)); } catch (_) {} }

  /* ---------- colour blending ---------- */
  const parse = c => {
    if (c[0] === '#') { const h = c.slice(1); return [parseInt(h.slice(0, 2), 16), parseInt(h.slice(2, 4), 16), parseInt(h.slice(4, 6), 16), 1]; }
    const m = c.match(/[\d.]+/g).map(Number); return [m[0], m[1], m[2], m[3] == null ? 1 : m[3]];
  };
  const PARSED = SKINS.map(s => Object.fromEntries(Object.entries(s.t).map(([k, v]) => [k, parse(v)])));
  const mixc = (A, B, f) => { const r = A.map((v, i) => v + (B[i] - v) * f); return `rgba(${r[0] | 0},${r[1] | 0},${r[2] | 0},${+r[3].toFixed(3)})`; };
  const root = document.documentElement;
  /* Window opacity (Settings › Look): one per-device number for the glass behind every window, Chats and every app
     alike. Unset = the skin's own --sk-win. Only the alpha changes; the skin keeps its tint. */
  const GLASS_KEY = 'wos.window.opacity', GLASS_MIN = .6, GLASS_MAX = 1;
  const glassOk = v => typeof v === 'number' && Number.isFinite(v) && v >= GLASS_MIN && v <= GLASS_MAX;
  let glass = null;
  try { const v = parseFloat(localStorage.getItem(GLASS_KEY)); if (glassOk(v)) glass = v; } catch (_) {}
  let pos = idxOf(stored()), shown = -1;
  function paint(p) {
    p = Math.max(0, Math.min(N - 1, p)); pos = p;
    const a = Math.floor(p), b = Math.min(N - 1, a + 1), f = p - a;
    const st = root.style;
    if (a === 0 && f < 1e-3) { for (const k of Object.keys(SKINS[0].t)) st.removeProperty('--' + k); st.removeProperty('--sk-orb'); }
    else {
      for (const k of Object.keys(SKINS[0].t)) st.setProperty('--' + k, mixc(PARSED[a][k], PARSED[b][k], f));
      const o = SKINS[a].orb.map((v, i) => v + (SKINS[b].orb[i] - v) * f);
      st.setProperty('--sk-orb', `hue-rotate(${o[0].toFixed(1)}deg) saturate(${o[1].toFixed(3)}) brightness(${o[2].toFixed(3)})`);
    }
    if (glass == null) delete root.dataset.winGlass;
    else {
      const A = PARSED[a]['sk-win'], B = PARSED[b]['sk-win'], w = A.map((v, i) => v + (B[i] - v) * f);
      st.setProperty('--sk-win', `rgba(${w[0] | 0},${w[1] | 0},${w[2] | 0},${glass})`); root.dataset.winGlass = '';
    }
    // space layers belong to Nebula only
    const space = a === 0 && !wizardImage(SKINS[a]) ? 1 - f : 0; st.setProperty('--sk-space', space.toFixed(3));
    imageState(SKINS[Math.round(p)]);
    const near = Math.round(p);
    if (near !== shown) { shown = near; root.dataset.skin = SKINS[near].id; window.WosSkinHost?.preview(SKINS[near].id); const m = document.querySelector('meta[name=theme-color]'); if (m) m.content = SKINS[near].t.bg; }
    applyFrame(SKINS[near]);
    BGL.a = a; BGL.b = b; BGL.f = f; wake();
  }

  /* ---------- living backgrounds ---------- */
  const BGL = { a: 0, b: 0, f: 0, cv: [], cx: [], st: {}, W: 0, H: 0, dpr: 1, t: 0 };
  const mk = (w, h) => { const c = document.createElement('canvas'); c.width = Math.max(1, w | 0); c.height = Math.max(1, h | 0); return c; };
  const sprite = (r, rgb, mid = .4) => { const c = mk(r * 2, r * 2), x = c.getContext('2d'), g = x.createRadialGradient(r, r, 0, r, r, r); g.addColorStop(0, `rgba(${rgb},1)`); g.addColorStop(.3, `rgba(${rgb},${mid})`); g.addColorStop(1, `rgba(${rgb},0)`); x.fillStyle = g; x.fillRect(0, 0, r * 2, r * 2); return c; };
  // Landscapes: one wallpaper at a time, cover-fitted once into an offscreen canvas (a frame is one or two drawImage
  // calls). Each app load starts on the next one, and every minute on Home moves on with a 2.5 s crossfade; only the current and next
  // files are fetched. Frozen with the scenery gate like every other skin. Landscapes Dark and Landscapes Light each rotate their own
  // half of the set, split by how bright the photo is overall (Miguel, 28 Oct 2026).
  /* Wizard OS backgrounds (Miguel, 4 Nov 2026: "a proper main background we can call Wizard OS"). The Landscapes
   * palettes can show a Wizard OS scene instead of the rotating photos. Each scene is baked from the supplied designer
   * hat (web/brand/wizard-mark-white.png, never redrawn) by tools/brand/wallpapers.html, one image per palette (night /
   * day) and per shape (wide desktop, tall phone), cover-fitted once like the photos. Per device, like Window opacity. */
  const WALL_KEY = 'wos.skin.wallpaper';
  const WALLS = [
    { id: 'landscapes', name: 'Photos', who: 'Landscape photos that change every minute.' },
    { id: 'lake', name: 'Lake', who: 'The hat as a mountain on a still lake: aurora and a lit door by night, sunrise by day.' },
    { id: 'valley', name: 'Valley', who: 'The hat as the far peak over layered hills and pines, at dusk or in the morning.' },
    { id: 'moonrise', name: 'Moonrise', who: 'The hat on a hill in front of a huge moon, fireflies in the grass; a setting sun by day.' },
    { id: 'sea', name: 'Sea', who: 'The hat as an island: the Milky Way and a lit door on the water by night, open sea by day.' },
    { id: 'clouds', name: 'Clouds', who: 'The hat rising above a sea of clouds.' },
    { id: 'glass', name: 'Glass', who: 'The hat in frosted glass over soft colour.' },
  ];
  let wall = (() => { try { const v = localStorage.getItem(WALL_KEY); return WALLS.some(w => w.id === v) ? v : 'landscapes'; } catch (_) { return 'landscapes'; } })();
  // Wizard desktop has its own choice: never adopt a Mizel preference or change the phone.
  const WIZARD_WALL_KEY = 'wos.skin.wallpaper.wizard.desktop';
  const CUSTOM_WALL_KEY = 'wos.skin.wallpaper.wizard.custom';
  const fileId = id => typeof id === 'string' && /^[a-zA-Z0-9_-]{1,160}$/.test(id);
  let customWall = (() => { try { const v = JSON.parse(localStorage.getItem(CUSTOM_WALL_KEY)); return fileId(v?.wide) ? { wide: v.wide, ...(fileId(v.tall) ? { tall: v.tall } : {}) } : null; } catch (_) { return null; } })();
  let wizardWall = (() => { try { const v = localStorage.getItem(WIZARD_WALL_KEY); return (v === 'custom' && customWall) || WALLS.some(w => w.id === v) ? v : 'living'; } catch (_) { return 'living'; } })();
  const desktopBackdrop = () => ({ id: wizardWall, ...(customWall || {}) });
  function adoptDesktopBackdrop(v) {
    if (!v || !['living', 'custom', ...WALLS.map(w => w.id)].includes(v.id) || (v.id === 'custom' && !fileId(v.wide))) throw new Error('Unknown background');
    wizardWall = v.id;
    customWall = fileId(v.wide) ? { wide: v.wide, ...(fileId(v.tall) ? { tall: v.tall } : {}) } : null;
    try { wizardWall === 'living' ? localStorage.removeItem(WIZARD_WALL_KEY) : localStorage.setItem(WIZARD_WALL_KEY, wizardWall); customWall ? localStorage.setItem(CUSTOM_WALL_KEY, JSON.stringify(customWall)) : localStorage.removeItem(CUSTOM_WALL_KEY); } catch (_) {}
    paint(pos); wake();
    dispatchEvent(new CustomEvent('wos:wallpaper', { detail: { wallpaper: wizardWall, desktopBackdrop: desktopBackdrop() } }));
  }
  const wizardBackgrounds = skin => root.dataset.shell === 'desktop' && skin.family === 'wizard';
  const wizardImage = skin => wizardBackgrounds(skin) && wizardWall !== 'living';
  function imageState(skin) {
    // Material belongs to the Wizard palette, never to its selected backdrop.
    if (wizardBackgrounds(skin)) root.dataset.wizardBackgrounds = '';
    else delete root.dataset.wizardBackgrounds;
    if (wizardImage(skin) || /^landscapes/.test(skin.id)) root.dataset.imageBackground = '';
    else delete root.dataset.imageBackground;
  }
  const WIZ = {
    memo: {},
    get(id, light, W, H) {
      const tall = H > W * 1.1;
      const file = id === 'custom' ? `/wizard/files/${encodeURIComponent(tall && customWall?.tall || customWall?.wide || '')}/content` : `/wizard-os-home/core/skins/wizard/${id}${light ? '-light' : ''}-${tall ? 'tall' : 'wide'}.webp`, key = `${W}x${H}@${BGL.dpr}`;
      let m = this.memo[file];
      if (!m) { m = this.memo[file] = { im: new Image(), ready: false, key: '', c: null }; m.im.decoding = 'async'; m.im.onload = () => { m.ready = true; wake(); }; m.im.src = file; }
      if (!m.ready) return null;
      if (m.key !== key) { const o = mk(W * BGL.dpr, H * BGL.dpr), x = o.getContext('2d'), im = m.im, k = Math.max(o.width / im.naturalWidth, o.height / im.naturalHeight), w = im.naturalWidth * k, h = im.naturalHeight * k;
        x.drawImage(im, (o.width - w) / 2, (o.height - h) / 2, w, h);
        if (id === 'custom') LANDSCAPES.dark.shade(x, o); // Shared photo legibility policy; built-ins are already baked.
        m.c = o; m.key = key; }
      return m.c;
    },
  };
  const LANDSCAPES = (() => {
    const ALL = ['00-10-9', '01-10-10', '02-10-11', '03-10-12', '04-10-13', '05-10-14-day', '06-10-14-night', '07-10-15-day', '08-10-15-night',
      '09-11-big-sur-day', '10-11-big-sur-night', '11-26-tahoe-beach-dawn', '12-26-tahoe-beach-day', '13-26-tahoe-beach-dusk', '14-26-tahoe-beach-night', '15-27-golden-gate-bridge'];
    const AVG = ['#347883', '#937b75', '#71747c', '#715c63', '#9b8773', '#6d5d5a', '#232d43', '#4f4d60', '#18253e', '#40576a', '#0d1b2e', '#8a818c', '#4d8da3', '#405877', '#0d1011', '#87736a'];
    const make = (files, key, scrim, light) => ({
      FILES: files.map(i => ALL[i]), AVG: files.map(i => AVG[i]),
      HOLD: 60, FADE: 2.5, KEY: key, LIGHT: light,
      load(s, i, W, H) {
        if (s.img[i]) return s.img[i];
        const slot = s.img[i] = { ready: false, c: null }, im = new Image();
        im.decoding = 'async';
        slot.im = im;
        im.onload = () => { this.cover(slot, W, H); slot.ready = true; wake(); };
        im.src = `/wizard-os-home/core/skins/macos/${this.FILES[i]}.webp`;
        return slot;
      },
      // the photo cover-fitted to the page once (again only when the page itself changes size: resize below)
      cover(slot, W, H) {
        const im = slot.im, o = mk(W * BGL.dpr, H * BGL.dpr), x = o.getContext('2d'), k = Math.max(o.width / im.naturalWidth, o.height / im.naturalHeight),
          w = im.naturalWidth * k, h = im.naturalHeight * k; x.drawImage(im, (o.width - w) / 2, (o.height - h) / 2, w, h);
        this.shade(x, o); slot.c = o;
      },
      shade(x, o) {
          // a soft top and bottom scrim so the clock and the bottom bar stay legible on bright skies
          const g = x.createLinearGradient(0, 0, 0, o.height); g.addColorStop(0, `rgba(11,10,16,${scrim[0]})`); g.addColorStop(.28, 'rgba(11,10,16,0)'); g.addColorStop(.7, 'rgba(11,10,16,0)'); g.addColorStop(1, `rgba(11,10,16,${scrim[1]})`);
        x.fillStyle = g; x.fillRect(0, 0, o.width, o.height);
      },
      // the window itself changed size: the same photo (never the next one), cropped again for the new size
      resize(s, W, H) { for (const slot of Object.values(s.img)) if (slot.ready && slot.im) this.cover(slot, W, H); },
      init(s, W, H) {
        const n = this.FILES.length; let at = 0;
        try { at = (parseInt(localStorage.getItem(this.KEY), 10) + 1) % n; if (!isFinite(at)) at = 0; localStorage.setItem(this.KEY, String(at)); } catch (e) {}
        s.img = {}; s.cur = at; s.from = null; s.fadeAt = 0; s.shownAt = BGL.t; s.n = n;
        this.load(s, at, W, H); this.load(s, (at + 1) % n, W, H);
      },
      draw(c, s, t, dt, W, H, selected = wall) {
        if (selected !== 'landscapes') { const w = WIZ.get(selected, this.LIGHT, W, H); if (w) c.drawImage(w, 0, 0, W, H); else { c.fillStyle = SKINS[Math.round(pos)].t.bg; c.fillRect(0, 0, W, H); } return; }
        const cur = s.img[s.cur];
        if (cur?.ready && t - s.shownAt > this.HOLD) {
          const nx = (s.cur + 1) % s.n, nxt = this.load(s, nx, W, H);
          if (nxt.ready) { s.from = s.cur; s.cur = nx; s.fadeAt = t; s.shownAt = t; try { localStorage.setItem(this.KEY, String(nx)); } catch (e) {} this.load(s, (nx + 1) % s.n, W, H);
            for (const k of Object.keys(s.img)) if (+k !== s.cur && +k !== s.from && +k !== (nx + 1) % s.n) delete s.img[k]; }
        }
        const f = s.from == null ? 1 : Math.min(1, (t - s.fadeAt) / this.FADE);
        const prev = s.from != null ? s.img[s.from] : null;
        if (prev?.ready && f < 1) c.drawImage(prev.c, 0, 0, W, H);
        else if (!s.img[s.cur]?.ready) { c.fillStyle = this.AVG[s.cur]; c.fillRect(0, 0, W, H); }
        if (s.img[s.cur]?.ready) { c.globalAlpha = f; c.drawImage(s.img[s.cur].c, 0, 0, W, H); c.globalAlpha = 1; }
        if (f >= 1) s.from = null;
      },
    });
    return {
      dark: make([6, 7, 8, 10, 13, 14], 'wos.skin.landscapes.at', ['.42', '.55']),
      light: make([0, 1, 2, 3, 4, 5, 9, 11, 12, 15], 'wos.skin.landscapes-light.at', ['.30', '.40'], true),
    };
  })();
  const BG = {
    grove: {
      init(s, W, H) {
        const o = mk(W, H), x = o.getContext('2d'); const g = x.createLinearGradient(0, 0, W * .3, H); g.addColorStop(0, '#0f2017'); g.addColorStop(.5, '#08130c'); g.addColorStop(1, '#040906'); x.fillStyle = g; x.fillRect(0, 0, W, H);
        s.off = o; s.sh = sprite(64, '3,12,6', .55); s.li = sprite(90, '255,226,140', .35); s.fl = sprite(10, '255,232,150', .5);
        s.shadows = Array.from({ length: 26 }, () => ({ x: rnd(-40, W + 40), y: rnd(-40, H + 40), rx: rnd(50, 120), ry: rnd(24, 60), rot: rnd(0, TAU), ph: rnd(0, TAU), amp: rnd(6, 16) }));
        s.lights = Array.from({ length: 10 }, () => ({ x: rnd(0, W), y: rnd(0, H * .8), r: rnd(40, 110), ph: rnd(0, TAU), sp: rnd(.2, .5) }));
        s.flies = Array.from({ length: 14 }, () => ({ x: rnd(0, W), y: rnd(H * .2, H * .9), p1: rnd(0, TAU), p2: rnd(0, TAU), sp: rnd(.15, .4), bl: rnd(.6, 1.4) }));
        s.leaves = []; s.next = 1.5;
      },
      draw(c, s, t, dt, W, H) {
        c.drawImage(s.off, 0, 0, W, H); c.globalCompositeOperation = 'lighter';
        for (const l of s.lights) { c.globalAlpha = .06 + .1 * (.5 + .5 * Math.sin(t * l.sp + l.ph)); c.drawImage(s.li, l.x - l.r + Math.sin(t * .35 + l.ph) * 10, l.y - l.r, l.r * 2, l.r * 2); }
        c.globalCompositeOperation = 'source-over';
        for (const q of s.shadows) { c.save(); c.globalAlpha = .55; c.translate(q.x + Math.sin(t * .45 + q.ph) * q.amp, q.y + Math.cos(t * .3 + q.ph) * q.amp * .4); c.rotate(q.rot + Math.sin(t * .2 + q.ph) * .08); c.drawImage(s.sh, -q.rx, -q.ry, q.rx * 2, q.ry * 2); c.restore(); }
        c.globalCompositeOperation = 'lighter';
        for (const f of s.flies) { const a = Math.pow(Math.max(0, Math.sin(t * f.bl + f.p1)), 3); if (a < .02) continue; c.globalAlpha = a; c.drawImage(s.fl, f.x + Math.sin(t * f.sp + f.p1) * 34 - 9, f.y + Math.cos(t * f.sp * .8 + f.p2) * 26 - 9, 18, 18); }
        c.globalCompositeOperation = 'source-over'; c.globalAlpha = 1;
        if (t > s.next) { s.leaves.push({ x: rnd(-20, W * .7), y: -20, vx: rnd(18, 42), vy: rnd(36, 58), r: rnd(0, TAU), vr: rnd(-1.4, 1.4), sz: rnd(8, 13), ph: rnd(0, TAU) }); s.next = t + rnd(2.5, 5.5); }
        for (const l of s.leaves) {
          l.x += (l.vx + Math.sin(t * 1.6 + l.ph) * 30) * dt; l.y += l.vy * dt; l.r += l.vr * dt;
          c.save(); c.translate(l.x, l.y); c.rotate(l.r); c.scale(1, .55 + .45 * Math.abs(Math.sin(t * 1.3 + l.ph)));
          c.fillStyle = '#4f8a52'; c.beginPath(); c.moveTo(-l.sz, 0); c.quadraticCurveTo(0, -l.sz * .75, l.sz, 0); c.quadraticCurveTo(0, l.sz * .75, -l.sz, 0); c.fill(); c.restore();
        }
        s.leaves = s.leaves.filter(l => l.y < H + 30);
      }
    },
    tide: {
      init(s, W, H) {
        const o = mk(W, H), x = o.getContext('2d'); const g = x.createLinearGradient(0, 0, 0, H); g.addColorStop(0, '#0d5466'); g.addColorStop(.45, '#073746'); g.addColorStop(1, '#021219'); x.fillStyle = g; x.fillRect(0, 0, W, H);
        const rg = x.createRadialGradient(W * .5, -H * .05, 0, W * .5, -H * .05, H * .55); rg.addColorStop(0, 'rgba(255,214,150,.16)'); rg.addColorStop(1, 'rgba(255,214,150,0)'); x.fillStyle = rg; x.fillRect(0, 0, W, H);
        s.off = o; s.bub = Array.from({ length: 16 }, () => ({ x: rnd(0, W), y: rnd(0, H), r: rnd(1.2, 3.4), sp: rnd(14, 40), ph: rnd(0, TAU) }));
        s.rays = Array.from({ length: 6 }, (_, i) => ({ x: W * (i + .5) / 6 + rnd(-20, 20), w: rnd(14, 34), ph: rnd(0, TAU) }));
      },
      draw(c, s, t, dt, W, H) {
        c.drawImage(s.off, 0, 0, W, H); c.globalCompositeOperation = 'lighter';
        for (const r of s.rays) { const sk = W * .18 + Math.sin(t * .25 + r.ph) * 30, a = .035 + .03 * Math.sin(t * .4 + r.ph), g = c.createLinearGradient(0, 0, 0, H * .85); g.addColorStop(0, `rgba(190,240,245,${a})`); g.addColorStop(1, 'rgba(190,240,245,0)'); c.fillStyle = g; c.beginPath(); c.moveTo(r.x - r.w, 0); c.lineTo(r.x + r.w, 0); c.lineTo(r.x + sk + r.w * 3, H * .85); c.lineTo(r.x + sk - r.w * 3, H * .85); c.fill(); }
        c.lineWidth = 1.4;
        for (let fam = 0; fam < 2; fam++) for (let k = 0; k < 10; k++) {
          const y0 = H * .6 * k / 9 + 10; c.strokeStyle = `rgba(175,235,242,${.1 * (1 - k / 12)})`; c.beginPath();
          for (let x = -10; x <= W + 12; x += 12) { const y = y0 + Math.sin(x * (fam ? .021 : .017) + t * (fam ? .9 : -.7) + k * 1.7) * 9 + Math.sin(x * .043 - t * (fam ? .6 : 1.1) + k) * 5; x < 0 ? c.moveTo(x, y) : c.lineTo(x, y); }
          c.stroke();
        }
        c.globalCompositeOperation = 'source-over';
        for (const b of s.bub) { b.y -= b.sp * dt; if (b.y < -10) { b.y = H + 10; b.x = rnd(0, W); } const x = b.x + Math.sin(t * 2 + b.ph) * 3; c.strokeStyle = 'rgba(200,242,248,.35)'; c.lineWidth = 1; c.beginPath(); c.arc(x, b.y, b.r, 0, TAU); c.stroke(); }
      }
    },
    ember: {
      spawn(p, W, H, any) { p.x = rnd(W * .08, W * .92); p.y = any ? rnd(H * .2, H + 10) : H + rnd(0, 20); p.vy = -rnd(22, 66); p.vx = rnd(-8, 8); p.max = rnd(4, 9); p.life = any ? rnd(0, p.max) : p.max; p.sz = rnd(2, 5); p.hot = Math.random() < .35; p.ph = rnd(0, TAU); return p; },
      init(s, W, H) {
        const v = mk(W, H), x = v.getContext('2d'), g = x.createRadialGradient(W / 2, H * .45, H * .2, W / 2, H * .45, H * .78); g.addColorStop(0, 'rgba(0,0,0,0)'); g.addColorStop(1, 'rgba(0,0,0,.7)'); x.fillStyle = g; x.fillRect(0, 0, W, H);
        s.vig = v; s.sa = sprite(8, '255,140,60', .5); s.sb = sprite(8, '255,214,120', .6); s.sp = Array.from({ length: 60 }, () => this.spawn({}, W, H, true));
      },
      draw(c, s, t, dt, W, H) {
        c.fillStyle = '#090504'; c.fillRect(0, 0, W, H);
        const pulse = .78 + .22 * Math.sin(t * .35) + .05 * Math.sin(t * 2.1);
        const g = c.createRadialGradient(W / 2, H * 1.1, 0, W / 2, H * 1.1, H * .85); g.addColorStop(0, `rgba(255,110,30,${.3 * pulse})`); g.addColorStop(.45, `rgba(180,50,10,${.1 * pulse})`); g.addColorStop(1, 'rgba(80,20,5,0)'); c.fillStyle = g; c.fillRect(0, 0, W, H);
        c.globalCompositeOperation = 'lighter';
        for (const p of s.sp) { p.life -= dt; p.vx += Math.sin(t * 1.7 + p.y * .015 + p.ph) * 26 * dt; p.vx *= .99; p.x += p.vx * dt; p.y += p.vy * dt; if (p.life <= 0 || p.y < -10) this.spawn(p, W, H); const a = Math.min(1, p.life / p.max * 1.6) * (.6 + .4 * Math.sin(t * 9 + p.ph)); c.globalAlpha = Math.max(0, a); const z = p.sz * (.4 + .6 * p.life / p.max) * 2; c.drawImage(p.hot ? s.sb : s.sa, p.x - z, p.y - z, z * 2, z * 2); }
        c.globalCompositeOperation = 'source-over'; c.globalAlpha = 1; c.drawImage(s.vig, 0, 0, W, H);
      }
    },
    signal: {
      init(s, W, H) {
        const o = mk(W, H), x = o.getContext('2d'); x.fillStyle = '#000'; x.fillRect(0, 0, W, H);
        x.fillStyle = 'rgba(57,255,140,.08)'; for (let yy = 12; yy < H; yy += 24) for (let xx = 12; xx < W; xx += 24) x.fillRect(xx, yy, 1, 1);
        x.fillStyle = 'rgba(0,0,0,.22)'; for (let yy = 0; yy < H; yy += 3) x.fillRect(0, yy, W, 1);
        s.off = o; s.CH = '0123456789ABCDEF<>/#*:;=+';
        s.gl = Array.from({ length: 46 }, () => ({ x: Math.round(rnd(0, W) / 12) * 12, y: Math.round(rnd(0, H) / 18) * 18, ch: s.CH[(Math.random() * s.CH.length) | 0], ph: rnd(0, TAU), sp: rnd(.4, 1.6) }));
      },
      draw(c, s, t, dt, W, H) {
        c.drawImage(s.off, 0, 0, W, H);
        const scan = ((t / 7) % 1) * (H + 160) - 80;
        c.font = '11px "Sk Mono", ui-monospace, monospace';
        for (const g of s.gl) { const near = Math.max(0, 1 - Math.abs(g.y - scan) / 60); if (near > .9 && Math.random() < .2) g.ch = s.CH[(Math.random() * s.CH.length) | 0]; c.fillStyle = `rgba(57,255,140,${.05 + .14 * Math.pow(Math.max(0, Math.sin(t * g.sp + g.ph)), 10) + near * .45})`; c.fillText(g.ch, g.x, g.y); }
        const gr = c.createLinearGradient(0, scan - 120, 0, scan); gr.addColorStop(0, 'rgba(57,255,140,0)'); gr.addColorStop(1, 'rgba(57,255,140,.06)'); c.fillStyle = gr; c.fillRect(0, scan - 120, W, 120);
        c.fillStyle = 'rgba(57,255,140,.3)'; c.fillRect(0, scan, W, 1);
        const px = W * (.5 + .38 * Math.sin(t * .23)), py = H * (.42 + .25 * Math.sin(t * .17 + 1)), R = 130, sz = 17, hw = Math.sqrt(3) * sz, vh = 1.5 * sz;
        c.lineWidth = 1;
        for (let r = Math.floor((py - R) / vh); r <= Math.ceil((py + R) / vh); r++) {
          const off = (r & 1) ? hw / 2 : 0;
          for (let q = Math.floor((px - R - off) / hw); q <= Math.ceil((px + R - off) / hw); q++) {
            const cx = q * hw + off, cy = r * vh, d = Math.hypot(cx - px, cy - py); if (d > R) continue;
            c.strokeStyle = `rgba(57,255,140,${(1 - d / R) * .14})`; c.beginPath();
            for (let k = 0; k < 6; k++) { const an = Math.PI / 6 + k * Math.PI / 3, X = cx + Math.cos(an) * sz * .92, Y = cy + Math.sin(an) * sz * .92; k ? c.lineTo(X, Y) : c.moveTo(X, Y); }
            c.closePath(); c.stroke();
          }
        }
      }
    },
    // Novairecito: the existing night-sky language, pared back into a noir violet command deck.
    // It keeps the shell geometry untouched and uses only two inexpensive gradients over a solid field.
    novairecito: {
      init() {},
      draw(c, s, t, dt, W, H) {
        c.fillStyle = '#05030a'; c.fillRect(0, 0, W, H);
        const x = W * (.28 + .04 * Math.sin(t * .05)), y = H * (.18 + .03 * Math.cos(t * .04));
        const glow = c.createRadialGradient(x, y, 0, x, y, Math.max(W, H) * .72);
        glow.addColorStop(0, 'rgba(148,108,255,.16)'); glow.addColorStop(.46, 'rgba(79,48,145,.06)'); glow.addColorStop(1, 'rgba(5,3,10,0)');
        c.fillStyle = glow; c.fillRect(0, 0, W, H);
        const edge = c.createLinearGradient(0, 0, W, H);
        edge.addColorStop(0, 'rgba(255,255,255,.018)'); edge.addColorStop(.55, 'rgba(255,255,255,0)'); edge.addColorStop(1, 'rgba(0,0,0,.24)');
        c.fillStyle = edge; c.fillRect(0, 0, W, H);
      },
    },
    // Obsidian: still film grain plus one slow, soft light drifting across. Pre-rendered noise tiles, so a frame is
    // two drawImage calls and a gradient; frozen by the scenery gate whenever Home is not live.
    obsidian: {
      init(s, W, H) { this.prep(s, W, H, '#09090b', 255); },
      prep(s, W, H, base, ink) {
        s.base = base; s.ink = ink;
        s.tiles = [0, 1, 2].map(() => { const n = mk(160, 160), x = n.getContext('2d'), d = x.createImageData(160, 160);
          for (let i = 0; i < d.data.length; i += 4) { const v = Math.random() < .5 ? 0 : 1; d.data[i] = d.data[i + 1] = d.data[i + 2] = ink; d.data[i + 3] = v ? (Math.random() * 22) | 0 : 0; }
          x.putImageData(d, 0, 0); return n; });
      },
      // Opinionated (owner, 21 Oct): clean and modern, no film grain. A flat base with one very soft, near-still light
      // from the top so the surface reads as depth, not texture.
      draw(c, s, t, dt, W, H) {
        c.fillStyle = s.base; c.fillRect(0, 0, W, H);
        const k = s.ink ? '255,255,255' : '40,36,60', a = s.ink ? .055 : .05;
        const lx = W * (.5 + .12 * Math.sin(t * .02)), g = c.createRadialGradient(lx, -H * .1, 0, lx, -H * .1, Math.max(W, H) * .95);
        g.addColorStop(0, `rgba(${k},${a})`); g.addColorStop(1, `rgba(${k},0)`);
        c.fillStyle = g; c.fillRect(0, 0, W, H);
      },
    },
    'obsidian-light': { init(s, W, H) { BG.obsidian.prep(s, W, H, '#ffffff', 0); }, draw(c, s, t, dt, W, H) { BG.obsidian.draw(c, s, t, dt, W, H); } },
    // Sepia: a softly mottled vintage paper field. The texture is pre-rendered once; drawing it is one fill, one
    // gradient and one pattern pass, and the shared scenery gate freezes it whenever Home is not being viewed.
    sepia: {
      init(s) {
        const n = mk(192, 192), x = n.getContext('2d');
        x.clearRect(0, 0, 192, 192);
        for (let i = 0; i < 900; i++) {
          const a = rnd(.008, .035), warm = Math.random() < .72;
          x.fillStyle = warm ? `rgba(91,65,36,${a})` : `rgba(255,251,235,${a})`;
          x.fillRect(rnd(0, 192), rnd(0, 192), rnd(.4, 1.8), rnd(.4, 1.8));
        }
        for (let i = 0; i < 18; i++) {
          x.strokeStyle = `rgba(103,76,43,${rnd(.012, .028)})`; x.lineWidth = rnd(.3, .8); x.beginPath();
          const y = rnd(0, 192); x.moveTo(-8, y); x.bezierCurveTo(42, y + rnd(-3, 3), 132, y + rnd(-3, 3), 200, y + rnd(-2, 2)); x.stroke();
        }
        s.paper = n;
      },
      draw(c, s, t, dt, W, H) {
        c.fillStyle = '#f3ead2'; c.fillRect(0, 0, W, H);
        const g = c.createRadialGradient(W * .48, H * .38, 0, W * .48, H * .38, Math.max(W, H) * .78);
        g.addColorStop(0, 'rgba(255,252,237,.34)'); g.addColorStop(.68, 'rgba(137,99,55,.025)'); g.addColorStop(1, 'rgba(92,63,32,.10)');
        c.fillStyle = g; c.fillRect(0, 0, W, H);
        c.fillStyle = c.createPattern(s.paper, 'repeat'); c.fillRect(0, 0, W, H);
      },
    },
    landscapes: LANDSCAPES.dark,
    'landscapes-light': LANDSCAPES.light,
  };
  /* The canvases follow the page's own size only (Miguel, 2 Nov 2026: the background jolted whenever a panel opened).
   * Layouts and the desktop shell send \`resize\` for their own re-tiling while the page keeps its size: that is a no-op
   * here (a canvas re-sized is wiped, and a fresh state re-picks: Landscapes moved to the next photo, every random scene
   * re-rolled). A real size change keeps each scene's state where the skin can crop again (resize), else starts it over. */
  function size() {
    const d = BGL.cv[0] && BGL.cv[0].parentElement; if (!d) return false;
    const r = d.getBoundingClientRect(), dpr = Math.min(devicePixelRatio || 1, 1.5);
    if (r.width === BGL.W && r.height === BGL.H && dpr === BGL.dpr && BGL.cv.every(c => c.width === (r.width * dpr | 0) && c.height === (r.height * dpr | 0))) return false;
    BGL.W = r.width; BGL.H = r.height; BGL.dpr = dpr;
    for (const c of BGL.cv) { c.width = BGL.W * BGL.dpr | 0; c.height = BGL.H * BGL.dpr | 0; }
    for (const id of Object.keys(BGL.st)) { const R = BG[id]; if (R && R.resize) R.resize.call(R, BGL.st[id], BGL.W, BGL.H); else delete BGL.st[id]; }
    return true;
  }
  function drawLayer(k, i, op, dt) {
    const c = BGL.cv[k], x = BGL.cx[k];
    c.style.opacity = op.toFixed(3);
    if (op < .002) return;
    const image = wizardImage(SKINS[i]), id = image ? 'landscapes' : SKINS[i].id, R = BG[id]; if (!R) return;
    if (!BGL.st[id]) { BGL.st[id] = {}; R.init.call(R, BGL.st[id], BGL.W, BGL.H); }
    x.setTransform(BGL.dpr, 0, 0, BGL.dpr, 0, 0); R.draw.call(R, x, BGL.st[id], BGL.t, dt, BGL.W, BGL.H, image ? wizardWall : wall);
  }
  // Motion belongs to the scenery gate (core/scenery.js): it calls draw() ~30 fps only while Home is live, and
  // still() once after a change (skin picked, resize) so a frozen scene still shows the right skin.
  const needs = () => BGL.a !== 0 || BGL.f > .002 || wizardImage(SKINS[BGL.a]);
  function drawAll(dt) {
    if (!BGL.cv.length) return;
    BGL.t += dt;
    const { a, b, f } = BGL;
    const blank = i => i === 0 && !wizardImage(SKINS[i]);
    const opA = blank(a) ? 0 : (blank(b) ? 1 - f : 1), opB = (b === a || blank(b)) ? 0 : f;
    drawLayer(0, a, opA, dt); drawLayer(1, b, opB, dt);
  }
  const LAYER = { name: 'skin', fps: 30, active: () => BGL.cv.length > 0 && needs(), draw: dt => drawAll(dt), still: () => drawAll(0), off: () => BGL.cv.forEach(c => { if (c.style.opacity !== '0') c.style.opacity = 0; }) };
  function wake() { const S = window.WosScenery; if (S) { S.still(); S.update(); } }

  function mount() {
    const device = document.getElementById('device') || (document.documentElement.dataset.shell === 'desktop' ? document.body : null); if (!device || BGL.cv.length) return;
    const ref = device.querySelector('.lean') || device.firstChild;
    ['skinA', 'skinB'].forEach(id => { const c = document.createElement('canvas'); c.id = id; c.className = 'skin-bg'; c.setAttribute('aria-hidden', 'true'); device.insertBefore(c, ref); BGL.cv.push(c); BGL.cx.push(c.getContext('2d')); });
    size(); addEventListener('resize', () => { if (size()) wake(); });
    window.WosScenery?.layer(LAYER);
    paint(pos);
  }
  paint(pos); // tokens before first paint (no flash of the wrong skin)
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', mount); else mount();

  // Light / dark twins (Miguel, 30 Oct 2026): ⌥B on desktop flips between them. Only palettes with a real twin.
  const TWINS = { obsidian: 'obsidian-light', 'obsidian-light': 'obsidian', landscapes: 'landscapes-light', 'landscapes-light': 'landscapes' };
  window.WosSkin = {
    twin(id = this.current) { const t = TWINS[id]; const s = t && SKINS.find(x => x.id === t); return s ? { id: s.id, name: s.name, light: TWINS[t] === id && /-light$/.test(t) } : null; },
    list: SKINS.map(s => ({ id: s.id, family: s.family, name: s.name, who: s.who, bg: s.t.bg, accent: s.t.violet, face: FACES[s.id] || null, t: { ...s.t } })),
    // Skins (families) with their palettes, in list order. Picking a skin puts on the palette last worn in it.
    families: FAMS,
    familyOf(id) { return (SKINS.find(s => s.id === id) || SKINS[0]).family; },
    get family() { return SKINS[Math.round(pos)].family; },
    lastIn(fid) { const ids = SKINS.filter(s => s.family === fid).map(s => s.id); let v = null; try { v = localStorage.getItem(LAST + fid); } catch (e) {} return ids.includes(v) ? v : ids[0] || null; },
    setFamily(fid) { const id = this.lastIn(fid); return id ? this.set(id) : this.current; },
    get current() { return SKINS[Math.round(pos)].id; },
    get pos() { return pos; },
    get chosen() { return stored(); },
    index: idxOf,
    // Skin packages (core/skin-host.js): a collaborator skin's own folder web/skins/<dir>/ (skin.css, skin.js).
    pkgOf(id) { const s = SKINS.find(x => x.id === id); return s && s.pkg ? Object.freeze({ ...s.pkg }) : null; },
    preview(p) { paint(p); },
    set(id) { const i = idxOf(id); if (composition) { composition.extends = SKINS[i].id; saveComposition(); } paint(i); try { localStorage.setItem(KEY, SKINS[i].id); localStorage.setItem(LAST + SKINS[i].family, SKINS[i].id); } catch (e) {} window.WosSkinHost?.commit(SKINS[i].id); try { dispatchEvent(new CustomEvent('wos:skin', { detail: SKINS[i].id })); } catch (e) {} return SKINS[i].id; },
    get frame() { return F ? F.frame(frameOf(SKINS[Math.round(pos)])) : { foundation: 'framed' }; },
    get frameAdjustable() { return true; },
    useFoundation(foundation) {
      if (!['framed', 'borderless'].includes(foundation)) throw new Error('Unknown foundation');
      const token = {}; borrowedFoundation = foundation; this._foundationToken = token; applyFrame(SKINS[Math.round(pos)]);
      return () => { if (this._foundationToken === token) { borrowedFoundation = null; this._foundationToken = null; applyFrame(SKINS[Math.round(pos)]); } };
    },
    // One catalogue/renderer for Mizel (both shells) and Wizard desktop; choices stay independent.
    get wizardBackgrounds() { return wizardBackgrounds(SKINS[Math.round(pos)]); },

    wallpapers: Object.freeze(WALLS.map(w => Object.freeze({ ...w }))),
    // a small preview of a background in the current palette (night or day)
    get desktopBackdrop() { return desktopBackdrop(); },
    adoptDesktopBackdrop,
    async uploadWallpaper(file, { portrait = false, onProgress } = {}) {
      if (!file || !/^image\/(jpeg|png|webp|avif|gif)$/.test(file.type) || !file.size || file.size > 20 * 1024 * 1024) throw new Error('Choose a PNG, JPEG, WebP, AVIF or GIF image up to 20 MB.');
      if (portrait && !customWall) throw new Error('Choose your main image first.');
      if (!window.WizUploads?.supported()) throw new Error('Wizard Files is not ready. Try again shortly.');
      // Decode before sending: a renamed non-image must never replace a working backdrop.
      const image = await createImageBitmap(file); image.close();
      const receipt = await window.WizUploads.upload(file, { onProgress });
      if (!fileId(receipt?.id)) throw new Error('Wizard Files returned an invalid image.');
      // Read the current choice after upload, not its stale pre-upload snapshot.
      adoptDesktopBackdrop({ id: 'custom', ...(portrait ? { ...customWall, tall: receipt.id } : { wide: receipt.id }) });
      return desktopBackdrop();
    },
    wallpaperThumb(id) { if (id === 'custom') return customWall ? `/wizard/files/${encodeURIComponent(customWall.wide)}/content` : ''; const light = /-light$/.test(SKINS[Math.round(pos)].id); return id === 'landscapes' ? `/wizard-os-home/skins/landscapes/preview${light ? '' : '-dark'}.webp` : `/wizard-os-home/core/skins/wizard/${id}${light ? '-light' : ''}-thumb.webp`; },
    get wallpaper() { return this.wizardBackgrounds ? wizardWall : wall; },
    get wallpaperable() { return this.wizardBackgrounds || /^landscapes/.test(SKINS[Math.round(pos)].id); },
    setWallpaper(id) {
      const wizard = this.wizardBackgrounds;
      if (wizard) { adoptDesktopBackdrop({ ...desktopBackdrop(), id }); return id; }
      if (!WALLS.some(w => w.id === id)) throw new Error('Unknown background');
      else { wall = id; try { id === 'landscapes' ? localStorage.removeItem(WALL_KEY) : localStorage.setItem(WALL_KEY, id); } catch (_) {} }
      paint(pos); wake(); try { dispatchEvent(new CustomEvent('wos:wallpaper', { detail: { wallpaper: id } })); } catch (_) {}
      return id;
    },
    // Window opacity: null = the skin's own glass. setGlass(null) returns to it.
    get glass() { return glass; },
    get skinGlass() { return PARSED[Math.round(pos)]['sk-win'][3]; },
    glassRange: Object.freeze({ min: GLASS_MIN, max: GLASS_MAX }),
    setGlass(v) {
      const n = v == null ? null : Math.round(Math.max(GLASS_MIN, Math.min(GLASS_MAX, Number(v))) * 100) / 100;
      if (n != null && !glassOk(n)) throw new Error('Window opacity must be a number');
      glass = n; try { n == null ? localStorage.removeItem(GLASS_KEY) : localStorage.setItem(GLASS_KEY, String(n)); } catch (_) {}
      paint(pos); try { dispatchEvent(new CustomEvent('wos:window-glass', { detail: { glass: n } })); } catch (_) {}
      return n;
    },
    get composition() { return { version: 1, extends: this.current, frame: this.frame }; },
    compose(value) {
      const next = F.composition(value, SKINS); // validate all fields before any mutation
      composition = next; this.set(next.extends);
      dispatchEvent(new CustomEvent('wos:skin-frame')); return this.composition;
    },
    setFoundation(foundation) { return this.compose({ version: 1, extends: this.current, frame: { foundation } }); },
    resetFrame() { return this.compose({ version: 1, extends: this.current, frame: SKINS[Math.round(pos)].frame || shellFrame || {} }); },
    commit(i) { return this.set(SKINS[Math.max(0, Math.min(N - 1, Math.round(i)))].id); },
    _bg: BGL,
  };
})();
