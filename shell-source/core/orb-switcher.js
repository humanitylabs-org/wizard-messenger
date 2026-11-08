/* Orb switcher: hold the orb for pinned apps, voice and Customize only (James, 1 Nov 2026).
 * Pinned apps fill the inner ring first, then the outer ring, in the saved pin order. Open desktops stay on swipe up.
 * Voice needs a deliberate slide and slow dwell: holding or sliding past never records.
 * The shell owns app placement, desktop previews and voice and hands them in
 * through its core adapter; this module owns geometry, hit-testing, paint and the Customize sheet.
 *
 *   createOrbSwitcher(adapter)       host: { apps(), openItems(), hover(i|null), vib(ms),
 *                                     cancelGesture(), armBack(), voice: { enabled(), start(), active(), finish(),
 *                                     cancel(), pause() } }
 *   WosOrbSwitcher.open({x, y})       the radial, centred on the orb; move(x, y); release(cancelled) -> outcome
 *   WosOrbSwitcher.get()              the settings (localStorage wos.orbSwitcher.v1)
 *   WosOrbSwitcher.openSettings()     the Orb switcher sheet; back() closes the sheet, then the radial, one layer */
window.WosCreateOrbSwitcher = function createOrbSwitcher(adapter) {
  'use strict';
  const KEY = 'wos.orbSwitcher.v1', EVT = 'wos:orb-switcher';
  const HOLDS = [200, 300, 450], MAX_PINS = 13;
  const DEFAULTS = Object.freeze({ pins: [], voiceSlot: 'near', holdMs: 300, quickTakes: false });
  // Condensed for the thumb (James, 31 Oct): the inner ring starts right at the orb's edge, the outer ring is directly
  // beside it (2 px hairline gap). Six inner and nine outer slots over a 210° sweep keep every wedge >= 40 px of arc at
  // its mid-radius (inner 41, outer 47). Everything is within 138 px of the orb centre, so it fits a 360 px phone unscaled.
  const IN0 = 44, IN1 = 90, OUT0 = 92, OUT1 = 138, N_IN = 6, N_OUT = 9, MOVE_ARM = 16;
  // Per-ring sweep: the inner ring spans -17.5°..192.5° (35° slots), the outer -10°..190° (22.2° slots), so the far-left
  // outer wedge does not dip below a dock-height orb. Angles run anticlockwise from straight right; k=0 is rightmost.
  const RING = [{ n: N_IN, a: -17.5, sec: 35 }, { n: N_OUT, a: -10, sec: 200 / N_OUT }]; // MOVE_ARM: px the finger must travel from where it pressed before the voice wedge may arm
  const ARM_SLOW = 0.6; // px/ms: a faster finger is passing through the voice wedge, not stopping on it
  const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const reduced = () => !!window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;

  function norm(o) {
    o = o && typeof o === 'object' ? o : {};
    const pins = []; for (const id of Array.isArray(o.pins) ? o.pins : []) if (typeof id === 'string' && id && id.length < 80 && !pins.includes(id)) pins.push(id);
    return { pins: pins.slice(0, MAX_PINS), voiceSlot: o.voiceSlot === 'far' ? 'far' : 'near', holdMs: HOLDS.includes(o.holdMs) ? o.holdMs : DEFAULTS.holdMs,
      quickTakes: o.quickTakes === true };
  }
  let cfg = (() => { try { return norm(JSON.parse(localStorage.getItem(KEY) || '{}')); } catch (_) { return norm({}); } })();
  function save() { try { localStorage.setItem(KEY, JSON.stringify(cfg)); } catch (_) {} window.dispatchEvent(new CustomEvent(EVT, { detail: cfg })); }
  function set(patch) { cfg = norm({ ...cfg, ...patch }); save(); paintSheet(); }
  const onStorage = e => { if (e.key === KEY) { cfg = (() => { try { return norm(JSON.parse(e.newValue || '{}')); } catch (_) { return norm({}); } })(); paintSheet(); } };
  window.addEventListener('storage', onStorage);
  // The registry may finish loading/installing after Customize opened. Never freeze an empty app picker.
  const onApps = () => paintSheet();
  window.addEventListener('wizard:apps', onApps);

  let host = adapter, st = null, sheet = null, disposed = false;
  const H = () => host || { apps: () => [], openItems: () => [], openApp() {}, goDesk() {}, hover() {}, vib() {}, cancelGesture() {}, armBack() {}, voice: { enabled: () => false, start() {}, active: () => false, finish() {}, cancel() {}, pause() {} } };

  /* ---------------- layout ---------------- */
  // k increases right-to-left. Assign pin order left-to-right, inner ring first, without filling
  // empty slots. Voice is always rightmost; Customize always far left on the outer ring.
  function assign(items, voiceSlot) {
    const out = [], vRing = voiceSlot === 'far' ? 1 : 0;
    out.push({ kind: 'voice', ring: vRing, k: 0 });
    out.push({ kind: 'custom', ring: 1, k: N_OUT - 1 });
    const pins = items;
    const inner = Array.from({ length: N_IN - (vRing === 0 ? 1 : 0) }, (_, i) => N_IN - 1 - i);
    const outer = Array.from({ length: N_OUT - 1 - (vRing === 1 ? 1 : 0) }, (_, i) => N_OUT - 2 - i);
    const add = (item, ring, k) => out.push({ kind: 'app', ring, k, item });
    pins.slice(0, inner.length).forEach((it, i) => add(it, 0, inner[i]));
    const rest = pins.slice(inner.length);
    rest.slice(0, outer.length).forEach((it, i) => add(it, 1, outer[i]));
    if (rest.length > outer.length) console.info('[orb-switcher] ' + (rest.length - outer.length) + ' app(s) did not fit and were left out');
    return out;
  }
  function geometry(wedges, cx, cy, s) {
    return wedges.map(w => {
      const R = RING[w.ring], sec = R.sec, a0 = R.a + w.k * sec, a1 = a0 + sec;
      const r0 = (w.ring ? OUT0 : IN0) * s, r1 = (w.ring ? OUT1 : IN1) * s, am = (a0 + a1) / 2, rm = (r0 + r1) / 2;
      return { ...w, a0, a1, r0, r1, am, rm, x: cx + rm * Math.cos(am * Math.PI / 180), y: cy - rm * Math.sin(am * Math.PI / 180) };
    });
  }
  function sector(cx, cy, r0, r1, a0, a1) {
    const gap = 1.5, rad = Math.PI / 180, P = (r, a) => [cx + r * Math.cos(a * rad), cy - r * Math.sin(a * rad)].map(v => +v.toFixed(2));
    const t1 = gap / 2 / r1 / rad, t0 = gap / 2 / r0 / rad;
    const [ox0, oy0] = P(r1, a0 + t1), [ox1, oy1] = P(r1, a1 - t1), [ix1, iy1] = P(r0, a1 - t0), [ix0, iy0] = P(r0, a0 + t0);
    return `M${ox0} ${oy0}A${r1} ${r1} 0 0 0 ${ox1} ${oy1}L${ix1} ${iy1}A${r0} ${r0} 0 0 1 ${ix0} ${iy0}Z`;
  }
  // The fan's geometry for a viewport and orb, exported so a test can check it fits 360 px phones.
  function frame(x, y, vw, vh) {
    const s = Math.max(.6, Math.min(1, (vw / 2 - 8) / OUT1, (y - 64) / OUT1));
    const R = OUT1 * s, cx = Math.max(R + 8, Math.min(vw - R - 8, x));
    return { s, cx, cy: y };
  }

  /* ---------------- items ---------------- */
  function buildItems() {
    const h = H(), catalog = new Map(h.apps().map(a => [a.id, a])), open = h.openItems();
    // A desk can hold several apps. Its focused title/id must not replace or hide another pinned app on it.
    return cfg.pins.flatMap(id => {
      const a = catalog.get(id); if (!a) return [];
      const o = open.find(o => (o.appIds || [o.id]).includes(id));
      return [{ id, label: a.name, html: a.html, desk: o?.desk ?? null, open: !!o, cur: !!o?.cur, pinned: true }];
    });
  }

  /* ---------------- the radial ---------------- */
  const MIC = '<span class="dsg" style="--c:var(--wz-accent)"><i class="sgi sg-mic" aria-hidden="true"></i></span>';
  const GEAR = '<svg class="wor-gear" viewBox="0 0 24 24" aria-hidden="true"><path d="M4 7h9M17 7h3M4 17h3M11 17h9"/><circle cx="15" cy="7" r="2"/><circle cx="9" cy="17" r="2"/></svg>';
  const isVoice = i => i != null && st?.wedges[i]?.kind === 'voice';
  function open({ x, y, fromX = x, fromY = y }) {
    if (disposed) return false;
    close(true);
    const h = H(), vw = document.documentElement.clientWidth, vh = document.documentElement.clientHeight;
    const f = frame(x, y, vw, vh), items = buildItems(), wedges = geometry(assign(items, cfg.voiceSlot), f.cx, f.cy, f.s);
    const voiceOk = !!h.voice.enabled();
    const el = document.createElement('div');
    el.className = 'wor'; el.setAttribute('role', 'menu'); el.setAttribute('aria-label', 'Orb switcher');
    el.style.setProperty('--ox', x + 'px'); el.style.setProperty('--oy', y + 'px');
    const label = (w) => w.kind === 'voice' ? 'Voice command' : w.kind === 'custom' ? 'Customize' : w.item.label;
    const svg = `<svg class="wor-svg" width="${vw}" height="${vh}" viewBox="0 0 ${vw} ${vh}" aria-hidden="false">${wedges.map((w, i) => {
      const dis = w.kind === 'voice' && !voiceOk;
      return `<g class="wor-w ${w.kind}${w.item?.open ? ' open' : ''}${w.item?.cur ? ' cur' : ''}${dis ? ' dis' : ''}" data-i="${i}" role="menuitem" aria-label="${esc(label(w))}${w.item?.cur ? ' (here)' : w.item?.open ? ' (open)' : ''}"${dis ? ' aria-disabled="true"' : ''}${w.item?.cur ? ' aria-current="true"' : ''} style="transform-origin:${f.cx}px ${f.cy}px;--d:${Math.round((w.ring * 90 + w.k * 22))}ms"><path class="wor-p" d="${sector(f.cx, f.cy, w.r0, w.r1, w.a0, w.a1)}"/>${w.kind === 'voice' ? `<circle class="wor-arm" cx="${w.x.toFixed(1)}" cy="${w.y.toFixed(1)}" r="21" pathLength="100"/>` : ''}</g>`;
    }).join('')}</svg>`;
    const icons = wedges.map((w, i) => {
      const dx = Math.cos(w.am * Math.PI / 180) * 5, dy = -Math.sin(w.am * Math.PI / 180) * 5;
      return `<div class="wor-ic ${w.kind}${w.item?.cur ? ' cur' : ''}${w.kind === 'voice' && !voiceOk ? ' dis' : ''}" data-i="${i}" style="left:${w.x.toFixed(1)}px;top:${w.y.toFixed(1)}px;--mx:${dx.toFixed(1)}px;--my:${dy.toFixed(1)}px;--d:${Math.round((w.ring * 90 + w.k * 22))}ms">${w.kind === 'voice' ? MIC : w.kind === 'custom' ? GEAR : w.item.html}${w.item?.open ? '<i class="wor-dot"></i>' : ''}</div>`;
    }).join('');
    el.innerHTML = `<div class="wor-veil"></div>${svg}${icons}<div class="wor-label" role="status" aria-live="polite"></div>`;
    document.body.appendChild(el); document.body.classList.add('wor-open');
    st = { el, f, x, y, wedges, items, sel: null, voice: 'idle', after: null, last: null, speed: 0, armT: 0, tick: 0, voiceOk, from: { x: fromX, y: fromY }, moved: false, startInVoice: false };
    st.startInVoice = st.wedges[pick(fromX, fromY)]?.kind === 'voice'; // pressed down already inside the voice wedge: it only arms after the finger leaves it and returns
    // The pill sits just above the highest painted edge of the fan, not above an imaginary full ring.
    const topY = Math.min(...wedges.map(w => Math.min(...[w.a0, w.a1, w.am].map(a => f.cy - w.r1 * Math.sin(a * Math.PI / 180)))));
    st.labelY = Math.max(58, topY - 36);
    const L = el.querySelector('.wor-label'); L.style.top = st.labelY + 'px'; L.style.left = Math.max(110, Math.min(vw - 110, f.cx)) + 'px';
    requestAnimationFrame(() => st && st.el === el && el.classList.add('on'));
    paintLabel();
    return true;
  }
  function pick(px, py) {
    if (!st) return null;
    const { f } = st, dx = px - f.cx, dy = f.cy - py, r = Math.hypot(dx, dy);
    if (r < IN0 * f.s) return null; // the cancel zone is the orb itself and never overlaps the first ring
    const mid = (IN1 + OUT0) / 2 * f.s;
    const ring = r < mid ? 0 : 1;
    if (ring === 1 && r > (OUT1 + 22) * f.s) return null;
    let a = Math.atan2(dy, dx) * 180 / Math.PI; if (a < -90) a += 360;
    const R = RING[ring], n = R.n, sec = R.sec;
    if (a < R.a - 12 || a > R.a + n * sec + 12) return null;
    const k = Math.max(0, Math.min(n - 1, Math.floor((a - R.a) / sec)));
    const i = st.wedges.findIndex(w => w.ring === ring && w.k === k);
    return i < 0 ? null : i;
  }
  function move(px, py) {
    if (!st) return;
    const now = performance.now();
    if (!st.moved && Math.hypot(px - st.from.x, py - st.from.y) >= MOVE_ARM) st.moved = true;
    if (st.last) { const dt = Math.max(1, now - st.last.t), d = Math.hypot(px - st.last.x, py - st.last.y); st.speed = st.speed * .4 + (d / dt) * .6; }
    st.last = { x: px, y: py, t: now };
    setSel(pick(px, py));
  }
    function setSel(i) {
    if (!st || i === st.sel) return;
    const was = st.sel; st.sel = i;
    if (st.startInVoice && !isVoice(i)) st.startInVoice = false;
    if (isVoice(was)) voiceLeave();
    st.el.querySelectorAll('.wor-w.sel, .wor-ic.sel').forEach(n => n.classList.remove('sel'));
    if (i != null) {
      st.el.querySelectorAll(`[data-i="${i}"]`).forEach(n => n.classList.add('sel'));
      const g = st.el.querySelector(`.wor-w[data-i="${i}"]`); if (g) g.parentNode.appendChild(g); // hovered wedge paints above its neighbours
    }
    H().vib(i == null ? 4 : 8);
    if (isVoice(i)) voiceEnter();
    paintLabel();
    const w = i == null ? null : st.wedges[i];
    H().hover(w?.item && w.item.desk != null ? w.item.desk : null);
  }
  function paintLabel() {
    if (!st) return;
    const L = st.el.querySelector('.wor-label'), w = st.sel == null ? null : st.wedges[st.sel];
    let t;
    if (!w) t = st.items.length ? 'Slide to choose' : 'Pin apps in Customize';
    else if (w.kind === 'voice') t = !st.voiceOk ? 'Voice command · finish the current recording first'
      : st.voice === 'rec' ? 'Listening · let go to run · slide out to cancel'
      : st.voice === 'starting' ? 'Starting…' : 'Voice command · hold still to start';
    else if (w.kind === 'custom') t = 'Customize';
    else t = w.item.label + (w.item.cur ? ' · here' : w.item.open ? ' · open' : w.item.pinned ? ' · opens' : '');
    L.textContent = t; L.classList.toggle('hint', !w);
  }

  /* ---------------- voice slot: dwell, then record ---------------- */
  function voiceEnter() {
    if (!st.voiceOk || !st.moved || st.startInVoice) return;
    st.voice = 'arming'; st.armT = performance.now();
    clearInterval(st.tick); st.tick = setInterval(armTick, 40); armPaint(0);
  }
  function armTick() {
    if (!st || st.voice !== 'arming') return clearInterval(st?.tick);
    const now = performance.now(), v = st.last && now - st.last.t < 90 ? st.speed : 0;
    if (v > ARM_SLOW) st.armT = now; // still travelling: the dwell starts over
    const p = Math.min(1, (now - st.armT) / cfg.holdMs);
    armPaint(p);
    if (p >= 1 && st.sel != null && isVoice(st.sel)) voiceStart();
  }
  function armPaint(p) {
    const c = st?.el.querySelector('.wor-arm'); if (!c) return;
    c.style.strokeDashoffset = String(100 - p * 100); c.classList.toggle('on', p > 0);
  }
  function voiceStart() {
    const vs = st; clearInterval(vs.tick); vs.voice = 'starting'; vs.after = null; armPaint(1);
    H().vib(18); paintLabel();
    const vhost = H().voice;
    const p = Promise.resolve().then(() => vs.after === 'pause' && disposed ? undefined : vhost.start());
    vs.vp = p;
    p.catch(() => {}).then(() => {
      const act = vs.after; vs.after = null;
      if (!vhost.active()) { vs.voice = 'idle'; if (st === vs) { vs.voice = 'idle'; paintLabel(); } return; }
      if (act === 'cancel') { vhost.cancel(); vs.voice = 'idle'; return; }
      if (act === 'finish') { vhost.finish(); vs.voice = 'idle'; return; }
      if (act === 'pause') { vhost.pause(); vs.voice = 'idle'; return; }
      if (st !== vs) { vhost.pause(); vs.voice = 'idle'; return; } // closed some other way mid-start: keep the take, paused
      vs.voice = 'rec'; vs.el.querySelector('.wor-w.voice')?.classList.add('rec'); vs.el.querySelector('.wor-ic.voice')?.classList.add('rec'); paintLabel();
    });
  }
  function voiceLeave() {
    const vs = st; clearInterval(vs.tick); armPaint(0);
    if (vs.voice === 'starting') vs.after = 'cancel';
    else if (vs.voice === 'rec') { H().voice.cancel(); H().vib(10); }
    vs.voice = 'idle';
    vs.el.querySelectorAll('.rec').forEach(n => n.classList.remove('rec'));
    vs.el.style.setProperty('--lvl', 0);
  }
  function level(v) { if (st && st.voice === 'rec') st.el.style.setProperty('--lvl', (+v || 0).toFixed(3)); }

  /* ---------------- release / close ---------------- */
  function release(cancelled) {
    if (!st) return { kind: 'none' };
    const vs = st, w = cancelled || vs.sel == null ? null : vs.wedges[vs.sel];
    let out = { kind: 'none' };
    if (cancelled) {
      if (vs.voice === 'rec') H().voice.pause(); else if (vs.voice === 'starting') vs.after = 'pause';
    } else if (w?.kind === 'voice') {
      if (vs.voice === 'rec') { H().voice.finish(); out = { kind: 'voice' }; }
      else if (vs.voice === 'starting') { vs.after = 'finish'; out = { kind: 'voice' }; }
    } else if (w?.kind === 'custom') out = { kind: 'customize' };
    else if (w?.kind === 'app') out = { kind: 'open', id: w.item.id }; // the shared opener, never a cached desk index
    close();
    return out;
  }
  function close(instant) {
    if (!st) return;
    const vs = st; st = null; clearInterval(vs.tick);
    document.body.classList.remove('wor-open');
    const gone = vs.el; gone.classList.remove('on'); gone.classList.add('off');
    if (instant || reduced()) gone.remove(); else setTimeout(() => gone.remove(), 180);
  }

  /* ---------------- the settings sheet ---------------- */
  const UP2 = '<span class="wor-2up" aria-hidden="true"><i>↑</i><i>↑</i></span>';
  function pinRows() {
    const catalog = new Map(H().apps().map(a => [a.id, a])), pinned = cfg.pins;
    const row = (a, on, i, n) => `<div class="wor-row" data-app="${esc(a.id)}"><span class="wor-rico">${a.html}</span><span class="wor-nm">${esc(a.name)}</span>${on ? `<span class="wor-mv" role="group" aria-label="Move ${esc(a.name)}"><button type="button" data-mv="top" aria-label="Move ${esc(a.name)} to top"${i === 0 ? ' disabled' : ''}>${UP2}</button><button type="button" data-mv="up" aria-label="Move ${esc(a.name)} up"${i === 0 ? ' disabled' : ''}>↑</button><button type="button" data-mv="down" aria-label="Move ${esc(a.name)} down"${i === n - 1 ? ' disabled' : ''}>↓</button></span>` : ''}<button type="button" class="wor-sw${on ? ' on' : ''}" role="switch" aria-checked="${on}" aria-label="Pin ${esc(a.name)}" data-pin${!on && cfg.pins.length >= MAX_PINS ? ' disabled' : ''}><i></i></button></div>`;
    const rest = H().apps().filter(a => !cfg.pins.includes(a.id));
    return `<div class="wor-g"><h4>Pinned apps</h4><p class="wor-note">Pinned apps fill the radial. Open desktops stay on swipe up.</p><p class="wor-note">Up to ${MAX_PINS} pins, in your order: inner ring first, then outer. Open apps keep their pin.</p>${pinned.length ? pinned.map((id, i) => row(catalog.get(id) || { id, name: 'Unavailable app', html: '' }, true, i, pinned.length)).join('') : '<div class="wor-empty">Nothing pinned yet. Pin an app below.</div>'}</div>
      <div class="wor-g"><h4>Add an app</h4>${rest.length ? rest.map(a => row(a, false)).join('') : '<div class="wor-empty">Every app is pinned.</div>'}</div>`;
  }
  const seg = (name, opts, cur) => `<div class="wor-seg" role="radiogroup" aria-label="${esc(name)}">${opts.map(([v, t]) => `<button type="button" role="radio" aria-checked="${v === cur}" data-set="${esc(name)}" data-v="${esc(v)}">${esc(t)}</button>`).join('')}</div>`;
  const toggle = (key, title, sub, on) => `<div class="wor-row tog"><span class="wor-tx"><b>${esc(title)}</b><small>${esc(sub)}</small></span><button type="button" class="wor-sw${on ? ' on' : ''}" role="switch" aria-checked="${on}" aria-label="${esc(title)}" data-toggle="${key}"><i></i></button></div>`;
  function sheetBody() {
    return `${pinRows()}
      <div class="wor-g"><h4>Voice command slot</h4><p class="wor-note">Near: directly right of the orb on the inner ring. Far: rightmost outer slot. Slide onto it, then hold still to start; holding the orb never records.</p>${seg('voiceSlot', [['near', 'Near the orb'], ['far', 'Outer ring']], cfg.voiceSlot)}</div>
      <div class="wor-g"><h4>Voice hold time</h4><p class="wor-note">How long to stay on the microphone before it starts.</p>${seg('holdMs', HOLDS.map(v => [String(v), v + ' ms']), String(cfg.holdMs))}</div>
      <div class="wor-g">${toggle('quickTakes', 'Short takes (under 3 s) run as commands', 'Off: a tap on the orb always sends a message to your agent, however short.', cfg.quickTakes)}</div>`;
  }
  function openSettings() {
    if (disposed || sheet) return;
    close(true);
    const el = document.createElement('div');
    el.className = 'wor-scrim';
    el.innerHTML = `<section class="wor-sheet" role="dialog" aria-modal="true" aria-label="Orb switcher settings"><header><h3>Orb switcher</h3><button type="button" class="wor-x" data-close aria-label="Close">×</button></header><div class="wor-sb"></div></section>`;
    document.body.appendChild(el);
    sheet = el; paintSheet();
    el.addEventListener('click', onSheetClick);
    requestAnimationFrame(() => sheet === el && el.classList.add('on'));
    H().armBack();
  }
  function paintSheet() {
    if (!sheet) return;
    const sb = sheet.querySelector('.wor-sb'), top = sb.scrollTop, f = document.activeElement?.getAttribute?.('aria-label');
    sb.innerHTML = sheetBody(); sb.scrollTop = top;
    if (f && sheet.contains(document.activeElement) === false) { const n = [...sb.querySelectorAll('[aria-label]')].find(x => x.getAttribute('aria-label') === f && !x.disabled); n?.focus({ preventScroll: true }); }
  }
  function onSheetClick(e) {
    if (e.target === sheet || e.target.closest('[data-close]')) return closeSheet();
    const row = e.target.closest('[data-app]'), id = row?.dataset.app;
    const mv = e.target.closest('[data-mv]');
    if (mv && id && !mv.disabled) {
      const pins = cfg.pins.slice(), i = pins.indexOf(id); if (i < 0) return;
      pins.splice(i, 1); pins.splice(mv.dataset.mv === 'top' ? 0 : mv.dataset.mv === 'up' ? Math.max(0, i - 1) : Math.min(pins.length, i + 1), 0, id);
      return set({ pins });
    }
    const pin = e.target.closest('[data-pin]');
    if (pin && id && !pin.disabled) return set({ pins: cfg.pins.includes(id) ? cfg.pins.filter(x => x !== id) : cfg.pins.concat(id) });
    const sg = e.target.closest('[data-set]');
    if (sg) return set({ [sg.dataset.set]: sg.dataset.set === 'holdMs' ? +sg.dataset.v : sg.dataset.v });
    const tg = e.target.closest('[data-toggle]');
    if (tg) return set({ [tg.dataset.toggle]: !cfg[tg.dataset.toggle] });
  }
  function closeSheet() {
    if (!sheet) return false;
    const gone = sheet; sheet = null; gone.classList.remove('on');
    if (reduced()) gone.remove(); else setTimeout(() => gone.remove(), 180);
    return true;
  }
  // Back closes one layer: the sheet, else the radial (the held finger is let go).
  function back() {
    if (sheet) { closeSheet(); return 'sheet'; }
    if (st) { H().cancelGesture(); close(true); return 'radial'; }
    return null;
  }
  const settingsRow = () => `<div class="st-group" data-orbsw><h4>Orb switcher</h4><button type="button" class="st-row wz-row" data-orbsw-open><span class="st-tx"><b>Hold the orb for pinned apps</b><small>${cfg.pins.length ? cfg.pins.length + ' pinned' : 'Nothing pinned'} · voice command ${cfg.voiceSlot === 'far' ? 'on the outer ring' : 'near the orb'}</small></span><span class="st-go">›</span></button></div>`;

  const instance = {
    active: () => !disposed,
    dispose() {
      if (disposed) return;
      release(true); H().cancelGesture(); H().hover(null); close(true);
      sheet?.remove(); sheet = null;
      document.querySelectorAll('.wor, .wor-scrim').forEach(n => n.remove());
      document.body.classList.remove('wor-open');
      window.removeEventListener('storage', onStorage);
      window.removeEventListener('wizard:apps', onApps);
      disposed = true;
      if (window.WosOrbSwitcher === instance) delete window.WosOrbSwitcher;
    },
    available: true,
    open, move, release, close, back, level, openSettings, closeSheet, settingsRow,
    get: () => ({ ...cfg, pins: cfg.pins.slice() }), set,
    get isOpen() { return !!st; }, get sheetOpen() { return !!sheet; },
    get selected() { return st ? st.sel : null; }, get voice() { return st ? st.voice : 'idle'; },
    holdMs: () => cfg.holdMs, HOLD_OPEN_MS: 380,
    _frame: frame, _buildItems: buildItems, _pick: pick, _wedges: () => st?.wedges || [], _assign: (items, vs) => geometry(assign(items, vs), 206, 800, 1), _norm: norm, DEFAULTS,
  };
  window.WosOrbSwitcher = instance;
  return instance;
}
