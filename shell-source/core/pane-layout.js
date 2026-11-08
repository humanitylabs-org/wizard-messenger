/* Core pane placement. Pure geometry; Classic and AI apps share split/column arithmetic.
 * Device-local only: not Look sync. No controls, DOM ownership or app lifecycle here. */
((root) => {
  'use strict';
  const KEY = 'wos.pane-layout.v1', PRESETS = Object.freeze({ '1/2': .5, '1/3': 1 / 3, '2/3': 2 / 3 });
  const clamp = (n, lo, hi) => Math.max(lo, Math.min(hi, n));
  const fraction = (v, fallback = .5) => Number.isFinite(Number(v)) ? clamp(Number(v), .25, .75) : fallback;
  // Classic's saved out-of-range split falls back, rather than being silently rewritten.
  const splitOf = (d, n) => +d.split >= .25 && +d.split <= .75 ? +d.split : n === 2 ? .5 : .56;
  // Preserve Classic's rounding, 80% reservation and unspecified-share behaviour exactly.
  function columns(width, shares, gap = 0) {
    const avail = Math.max(0, width - (shares.length + 1) * gap), asked = shares.reduce((t, s) => t + (s > 0 ? s : 0), 0);
    const rest = shares.filter(s => !(s > 0)).length, scale = rest ? Math.min(1, .8 / asked) : 1 / asked;
    const free = rest ? (1 - asked * scale) / rest : 0;
    let x = gap;
    return shares.map(s => { const w = Math.round(avail * (s > 0 ? s * scale : free)); const r = { x, width: w }; x += w + gap; return r; });
  }
  const defaults = () => ({ mode: 'tiled', focus: 'chats', slots: ['chats', 'app'], ratio: null, side: 'start', weights: {}, app2: null,
    dock: { edge: 'end', insets: { top: 0, bottom: 0, start: 0, end: 0 } } });
  function normalize(input = {}) {
    if (!input || typeof input !== 'object') input = {};
    const d = defaults(), seen = new Set();
    const slots = (Array.isArray(input.slots) ? input.slots : d.slots).filter(s => ['chats', 'app', 'app2'].includes(s) && !seen.has(s) && seen.add(s));
    const ratio = input.ratio == null ? null : fraction(PRESETS[input.ratio] ?? input.ratio);
    const weights = {}; for (const s of slots) if (Number.isFinite(+input.weights?.[s]) && +input.weights[s] > 0) weights[s] = +input.weights[s];
    const insets = {}; for (const k of Object.keys(d.dock.insets)) insets[k] = clamp(Number(input.dock?.insets?.[k]) || 0, 0, 10000);
    return { mode: ['tiled', 'centre', 'pair', 'full'].includes(input.mode) ? input.mode : 'tiled',
      focus: ['chats', 'app', 'app2'].includes(input.focus) ? input.focus : 'chats',
      slots: slots.length ? slots : d.slots, ratio, side: input.side === 'end' ? 'end' : 'start', weights,
      app2: typeof input.app2 === 'string' && input.app2 ? input.app2 : null,
      dock: { edge: ['start', 'end', 'top', 'bottom'].includes(input.dock?.edge) ? input.dock.edge : 'end', insets } };
  }
  const box = (x, y, width, height) => ({ x, y, width: Math.max(0, width), height: Math.max(0, height) });
  function geometry(input, viewport, env = {}) {
    const m = normalize(input), W = Math.max(0, viewport.width), H = Math.max(0, viewport.height);
    const i = m.dock.insets, ix = Math.min(i.start, W), iy = Math.min(i.top, H);
    const aw = Math.max(0, W - ix - i.end), ah = Math.max(0, H - iy - i.bottom);
    const vertical = ['start', 'end'].includes(m.dock.edge), dw = Math.min(env.dockWidth ?? 200, vertical ? aw : ah);
    const dock = vertical ? box(m.dock.edge === 'start' ? ix : ix + aw - dw, iy, dw, ah) : box(ix, m.dock.edge === 'top' ? iy : iy + ah - dw, aw, dw);
    const area = box(ix + (m.dock.edge === 'start' ? dw : 0), iy + (m.dock.edge === 'top' ? dw : 0), aw - (vertical ? dw : 0), ah - (vertical ? 0 : dw));
    const sw = Math.min(env.sideWidth ?? 288, area.width);
    const sidebar = box(m.side === 'start' ? area.x : area.x + area.width - sw, area.y, sw, area.height);
    const content = box(area.x + (m.side === 'start' ? sw : 0), area.y, area.width - sw, area.height);
    const chatOn = !!env.chatOn, appOn = !!env.appOn;
    const chatWidth = chatOn ? (appOn ? clamp(W * .30, 360, 480) : clamp(W * .33333, 400, 560)) : 0;
    const appWidth = appOn ? (env.wide && !chatOn ? content.width : Math.min(env.appWidth ?? 560, Math.max(0, content.width - chatWidth))) : 0;
    const chat = box(m.side === 'start' ? content.x : content.x + content.width - chatWidth, content.y, chatWidth, content.height);
    const app = box(m.side === 'start' ? content.x + content.width - appWidth : content.x, content.y, appWidth, content.height);
    const panes = { chats: chat, app };
    const active = m.slots.filter(s => s === 'chats' ? chatOn : s === 'app' ? appOn : !!env.app2On);
    // Modes never rewrite the tiled arrangement. A later set({mode:'tiled'})
    // restores its slots, ratios, weights, side and dock exactly.
    if (m.mode !== 'tiled') {
      const stage = box(ix, iy, aw, ah), focus = active.includes(m.focus) ? m.focus : active.includes('chats') ? 'chats' : active[0];
      const visible = m.mode === 'pair' ? active.filter(s => s === focus || s === active.find(s => s !== focus)) : active.filter(s => s === focus);
      const ordered = m.side === 'end' && visible.includes('chats') ? [...visible.filter(s => s !== 'chats'), 'chats'] : visible;
      const result = { chats: box(ix, iy, 0, 0), app: box(ix, iy, 0, 0), app2: box(ix, iy, 0, 0) };
      if (m.mode === 'pair') {
        // Pair fills the existing content stage, reserving navigation rails.
        // Use the ratio presets, not custom three-column tiled weights.
        const ratio = m.ratio ?? .5;
        const shares = ordered.map(s => visible.length === 1 ? 1 : visible.includes('chats') ? s === 'chats' ? ratio : 1 - ratio : s === focus ? ratio : 1 - ratio);
        const tracks = columns(content.width, shares);
        ordered.forEach((s, j) => { result[s] = box(content.x + tracks[j].x, content.y, j === ordered.length - 1 ? content.width - tracks[j].x : tracks[j].width, content.height); });
      } else if (focus) {
        const margin = Math.min(32, stage.width / 16, stage.height / 16);
        const w = Math.min(840, Math.max(0, stage.width - margin * 2));
        result[focus] = m.mode === 'full' ? stage : box(stage.x + (stage.width - w) / 2, stage.y + margin, w, stage.height - margin * 2);
      }
      return { sidebar: m.mode === 'full' ? box(ix, iy, 0, 0) : sidebar,
        dock: m.mode === 'full' ? box(ix, iy, 0, 0) : dock, content: m.mode === 'pair' ? content : stage, panes: result, tiled: m.mode === 'pair' };
    }
    // Null ratio is the exact legacy overlay arrangement. Explicit ratios/weights use tiled slots.
    if ((m.ratio != null || Object.keys(m.weights).length || active.includes('app2')) && active.length) {
      const ordered = m.side === 'end' && active.includes('chats') ? [...active.filter(s => s !== 'chats'), 'chats'] : active;
      const shares = ordered.map(s => m.weights[s] || (m.ratio != null && active.includes('chats') ? s === 'chats' ? m.ratio : (1 - m.ratio) / Math.max(1, active.length - 1) : 1));
      const tracks = columns(content.width, shares);
      ordered.forEach((s, j) => { panes[s] = box(content.x + tracks[j].x, content.y, tracks[j].width, content.height); });
    }
    for (const s of ['chats', 'app', 'app2']) if (!m.slots.includes(s)) panes[s] = box(content.x, content.y, 0, 0);
    return { sidebar, dock, content, panes, tiled: m.ratio != null || !!Object.keys(m.weights).length || active.includes('app2') };
  }
  function create(storage, events) {
    let value; try { value = normalize(JSON.parse(storage?.getItem(KEY) || '{}')); } catch (_) { value = defaults(); }
    const listeners = new Set(), get = () => normalize(value);
    const notify = () => { for (const fn of [...listeners]) fn(get()); };
    const set = patch => {
      const p = patch || {}; value = normalize({ ...value, ...p, dock: { ...value.dock, ...p.dock, insets: { ...value.dock.insets, ...p.dock?.insets } } });
      try { storage?.setItem(KEY, JSON.stringify(value)); } catch (_) {} notify(); return get();
    };
    events?.addEventListener?.('storage', e => { if (e.key !== KEY) return; try { value = normalize(JSON.parse(e.newValue || '{}')); } catch (_) { value = defaults(); } notify(); });
    return { get, set, subscribe(fn) { listeners.add(fn); return () => listeners.delete(fn); }, geometry, fraction, splitOf, columns, PRESETS, KEY, normalize, create };
  }
  let storage; try { storage = root.localStorage; } catch (_) {}
  root.WizCore = root.WizCore || {}; root.WizCore.panes = root.WizCore.panes || create(storage, root);
})(typeof window === 'object' ? window : globalThis);
