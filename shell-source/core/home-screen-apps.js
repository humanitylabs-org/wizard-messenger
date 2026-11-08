/* Existing Apps surface + a bounded long-press action, not a new launcher. */
(() => {
  'use strict';
  let overlay = null, active = null, pending = false, requestSerial = 0;
  const responses = new Map();
  const port = () => window.wizardHomeScreenPort;
  function request(op, app, extra = {}) {
    if (!port()) return Promise.resolve({ status:'unsupported' });
    const requestId = String(++requestSerial);
    return new Promise(resolve => {
      const timer = setTimeout(() => { responses.delete(requestId); resolve({ status:'error' }); }, 8000);
      responses.set(requestId, value => { clearTimeout(timer); resolve(value); });
      try { port().postMessage(JSON.stringify({ op, requestId, appId:app.id, ...extra })); }
      catch (_) { clearTimeout(timer); responses.delete(requestId); resolve({ status:'error' }); }
    });
  }
  function bindPort() {
    if (!port()) return;
    port().onmessage = e => { try { const d = JSON.parse(e.data); const fn = responses.get(d.requestId); responses.delete(d.requestId); fn?.(d); } catch (_) {} };
  }
  bindPort();
  function close() { overlay?.remove(); overlay = null; active = null; pending = false; }
  function paint(status) {
    if (!overlay) return;
    const button = overlay.querySelector('button');
    const text = { ready:'Add to home screen', pending:'Adding…', pinned:'Already on home screen', confirmed:'Added to home screen', unsupported:"Can't add on this device", error:"Couldn't add. Try again" };
    button.textContent = text[status] || text.error; button.disabled = !['ready','error'].includes(status);
  }
  async function iconPNG(a, header) {
    const c = document.createElement('canvas'); c.width = c.height = 192;
    const ctx = c.getContext('2d'), sigil = window.WizSigil.of(a.sigil || a);
    ctx.fillStyle = '#110d1b'; ctx.fillRect(0,0,192,192);
    if (sigil.logo) {   // the app's own logo: the home-screen icon is that picture
      try { const image = new Image(); image.src = sigil.logo; await image.decode(); const k = Math.max(192 / image.naturalWidth, 192 / image.naturalHeight), w = image.naturalWidth * k, h = image.naturalHeight * k; ctx.drawImage(image, (192 - w) / 2, (192 - h) / 2, w, h); return c.toDataURL('image/png'); } catch (_) {}
    }
    const glyph = header.querySelector('.sgi');
    const computed = glyph && getComputedStyle(glyph);
    // Keep existing house/glyph pins; only brand-only apps need the brand mask.
    const mask = computed && computed.getPropertyValue((!sigil.glyph || sigil.guessed) && glyph.classList.contains('sgb') ? '--sgb' : '--sg').trim();
    // Match the renderer's same-origin file whitelist; never load an external mask.
    const match = mask?.match(/^url\(["']?((?:data:image\/svg\+xml[^"')]+|\/(?!\/)[A-Za-z0-9._~\/-]+\.(?:svg|png|webp)))["']?\)$/);
    let image = null;
    if (match) { try { image = new Image(); image.src = match[1]; await image.decode(); } catch (_) { image = null; } }
    if (image) {
      const tmp = document.createElement('canvas'); tmp.width = tmp.height = 192;
      // Raster files retain their aspect; existing SVG drawing remains unchanged.
      const raster = match[1].startsWith('/') && /\.(?:png|webp)$/.test(match[1]), k = raster ? Math.min(128 / image.naturalWidth, 128 / image.naturalHeight) : 0;
      const w = raster ? image.naturalWidth * k : 128, h = raster ? image.naturalHeight * k : 128;
      const t = tmp.getContext('2d'); t.drawImage(image,(192-w)/2,(192-h)/2,w,h); t.globalCompositeOperation = 'source-in'; t.fillStyle = sigil.color; t.fillRect(0,0,192,192); ctx.drawImage(tmp,0,0);
    } else { ctx.fillStyle = sigil.color; ctx.font = 'bold 100px sans-serif'; ctx.textAlign='center'; ctx.textBaseline='middle'; ctx.fillText(sigil.letter || a.name[0],96,100); }
    return c.toDataURL('image/png');
  }
  async function show(a) {
    close(); bindPort(); active = a;
    const name = window.WizHomeScreenPolicy.displayName(a);
    overlay = document.createElement('div'); overlay.className = 'home-pin-backdrop';
    const sheet = document.createElement('section'); sheet.className = 'home-pin-sheet'; sheet.setAttribute('role','dialog'); sheet.setAttribute('aria-label', name + ' home screen');
    const header = document.createElement('header'); header.innerHTML = window.WizSigil.box('span','',a);
    const title = document.createElement('span'); title.textContent = name; header.append(title);
    const button = document.createElement('button'); button.type = 'button'; button.disabled = true; button.textContent = 'Add to home screen';
    sheet.append(header, button); overlay.append(sheet); document.body.append(overlay);
    let freshPress = false, png = '';
    overlay.addEventListener('pointerdown', e => { freshPress = e.isTrusted; e.stopPropagation(); });
    overlay.addEventListener('pointercancel', () => { freshPress = false; });
    // Opening gesture's release/click can never activate the newly mounted action.
    overlay.addEventListener('click', e => {
      // Selection can cancel its pointer stream. Guard actions, not native text selection.
      if (e.target.dataset?.installLink !== undefined) return;
      if (!freshPress && e.detail !== 0) { e.preventDefault(); e.stopImmediatePropagation(); return; }
      freshPress = false;
      if (e.target === overlay) window.WizHomeScreenApps.back();
    }, true);
    if (!port()) {
      // offer/attach validate the registered frontend with the shared same-origin policy.
      const url = new URL(a.url, location.origin).href;
      const ios = /iPad|iPhone|iPod/.test(navigator.userAgent || '') || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
      const android = /Android/i.test(navigator.userAgent || '');
      const browser = ios ? 'Safari' : android ? 'Chrome' : 'your browser';
      sheet.classList.add('home-pin-guide');
      button.remove();
      const steps = document.createElement('ol');
      const first = document.createElement('li');
      const heading = document.createElement('strong'); heading.textContent = 'Open this link in ' + browser;
      const hint = document.createElement('p'); hint.textContent = 'Copy the link, open ' + browser + ', and paste it into the address bar.';
      const copy = document.createElement('button'); copy.type = 'button'; copy.textContent = 'Copy link';
      const address = document.createElement('textarea'); address.readOnly = true; address.rows = 4; address.value = url;
      address.setAttribute('aria-label', 'App link'); address.setAttribute('data-install-link', ''); address.spellcheck = false;
      const status = document.createElement('p'); status.setAttribute('role', 'status'); status.setAttribute('aria-live', 'polite');
      const select = () => { address.focus(); address.select(); address.setSelectionRange(0, url.length); };
      address.onclick = select;
      copy.onclick = async () => {
        try { await navigator.clipboard.writeText(url); status.textContent = 'Copied. Paste into ' + browser + '’s address bar.'; }
        catch (_) { select(); status.textContent = 'Couldn’t copy automatically. Copy the selected link, then paste it into ' + browser + '.'; }
      };
      first.append(heading, hint, copy, address, status);
      const second = document.createElement('li');
      const save = document.createElement('strong'); save.textContent = 'Save to Home Screen';
      const instruction = document.createElement('p'); instruction.textContent = ios ? 'In Safari, tap Share → Add to Home Screen → Add.' : android ? 'In Chrome, open the ⋮ menu → Add to Home screen / Install app, then confirm.' : 'Open your browser’s menu → Install app / Add to Home screen, if available, then confirm.';
      second.append(save, instruction); steps.append(first, second); sheet.append(steps);
      return;
    }
    try { png = await iconPNG(a, header); } catch (_) { if (active === a) paint('error'); return; }
    if (active !== a) return;
    const response = await request('status', a);
    if (active !== a) return; paint(response.status);
    button.onclick = e => {
      if (!e.isTrusted || !navigator.userActivation?.isActive || pending || !png) return;
      pending = true; paint('pending');
      // No async work before postMessage: retain the tap's native user activation.
      request('pin',a,{ name, icon:png }).then(r => {
        if (active !== a) return;
        if (r.status !== 'pending') { pending = false; paint(r.status); }
      });
    };
  }
  const pinnable = a => !!a && a.kind === 'wizard' && !!a.url && window.WizHomeScreenPolicy.validId(a.id) && !window.WizHomeScreenPolicy.isShell(a.url) && window.WizHomeScreenPolicy.within(a.url,a.url);
  let refreshing = false, rerun = false, resumePending = false, lastSig = '';
  // Registry echoes must not redraw shortcuts. Resume is different: Android may have
  // changed its pinned set, and an old/silent APK must be allowed to retry.
  const signature = list => JSON.stringify(list.map(a => [a.id, a.url,
    window.WizHomeScreenPolicy.displayName(a), window.WizSigil.of(a.sigil || a),
    window.WizSigil.box('span','',a)]));
  async function refreshPinned(force = false) {
    // Browser/desktop and old APKs stay inert. One bounded query before rendering any icons.
    // A registry update mid-pass marks the pass dirty and reruns it with the new apps afterwards.
    if (!port()) return;
    if (refreshing) { rerun = true; resumePending ||= force; return; }
    refreshing = true; rerun = false;
    try {
      bindPort();
      await window.WizCore?.appsLoaded?.();
      if (!port()) return;
      const apps = Object.values(window.WizCore?.apps('mobile')?.APP || {}).filter(pinnable);
      const candidates = [...new Map(apps.map(a => [a.id,a])).values()].slice(0,128);
      const sig = signature(candidates);
      // Reading/building the registry can announce that same registry synchronously.
      // Its state is already in this snapshot; only later updates need another pass.
      rerun = resumePending;
      if (!force && sig === lastSig) return;
      lastSig = sig;
      if (!candidates.length) return;
      const r = await request('pinned', { id:'' }, { candidates:candidates.map(a => a.id) });
      if (r.status !== 'pinned-list' || !Array.isArray(r.appIds) || r.appIds.length > 128) return;
      const pinned = new Set(r.appIds);
      for (const a of candidates) {
        if (!pinned.has(a.id) || !port()) continue;
        let header;
        try {
          // Connect the glyph so CSS masks resolve exactly as they do in the existing pin sheet.
          header = document.createElement('header');
          header.style.cssText = 'position:fixed;left:-10000px;visibility:hidden;pointer-events:none';
          header.setAttribute('aria-hidden','true'); header.innerHTML = window.WizSigil.box('span','',a);
          document.body.append(header);
          const icon = await iconPNG(a,header);
          await request('refresh',a,{ name:window.WizHomeScreenPolicy.displayName(a), icon });
        } catch (_) { /* one broken app cannot block the remaining pinned shortcuts */ }
        finally { header?.remove(); }
      }
    } catch (_) { /* unavailable registry, bridge, decode or old-APK timeout: silent no-op */ }
    finally {
      refreshing = false;
      if (rerun) { const force = resumePending; resumePending = false; void refreshPinned(force); }
    }
  }
  // scripts load after the app registry; appsLoaded waits for installed apps on first shell load.
  void refreshPinned();
  addEventListener('wizard:apps', () => { void refreshPinned(); });
  // Desks overview: hold a one-app desk and let go without dragging → the same sheet (drag still reorders).
  function offer(a) { if (!pinnable(a)) return false; try { navigator.vibrate?.(12); } catch (_) {} show(a); return true; }
  // rows: which tiles inside `menu` can be held; live(row): the surface is still showing when the hold fires.
  // Default is the Apps sheet (#launcher, live while .open). The New desk grid passes its own (it has no .open).
  function attach(menu, appFor, opts = {}) {
    const rows = opts.rows || '[data-app]', live = opts.live || (() => menu.classList.contains('open'));
    let hold = null, timer = null, blockedUntil = 0;
    function cancel() { clearTimeout(timer); timer = null; hold = null; }
    const block = () => { blockedUntil = performance.now() + 700; };
    menu.addEventListener('pointerdown', e => {
      if (hold) { cancel(); block(); return; }
      if (opts.available && !opts.available()) return;
      const row = e.target.closest(rows), a = row && appFor(row.dataset.app);
      if (!e.isTrusted || !e.isPrimary || e.button !== 0 || !pinnable(a)) return;
      hold = { id:e.pointerId, x:e.clientX, y:e.clientY, a };
      timer = setTimeout(() => { if (!hold || !row.isConnected || !live(row) || (opts.available && !opts.available())) { cancel(); return; } block(); try { navigator.vibrate?.(12); } catch (_) {} show(a); },450);
    }, true);
    document.addEventListener('pointerdown', e => { if (hold && e.pointerId !== hold.id) { cancel(); block(); } },true);
    menu.addEventListener('pointermove', e => { if (hold && e.pointerId === hold.id && Math.hypot(e.clientX-hold.x,e.clientY-hold.y) > 8) { cancel(); block(); } },true);
    menu.addEventListener('scroll', () => { if (hold) { cancel(); block(); } },true);
    document.addEventListener('pointerup', e => { if (hold && e.pointerId === hold.id) { if (overlay) { block(); e.preventDefault(); } cancel(); } },true);
    document.addEventListener('pointercancel', () => { if (hold) block(); cancel(); },true);
    menu.addEventListener('contextmenu', e => { if (overlay || hold) e.preventDefault(); },true);
    menu.addEventListener('click', e => { if (overlay || performance.now() < blockedUntil) { e.preventDefault(); e.stopImmediatePropagation(); } },true);
    document.addEventListener('visibilitychange', () => { if (hold) block(); cancel(); });
  }
  addEventListener('wos-native-resume', async () => {
    void refreshPinned(true);
    if (!pending || !active) return;
    const a = active, r = await request('status',a);
    if (active !== a) return;
    pending = false;
    if (r.status === 'pinned') { paint('confirmed'); setTimeout(() => { if (active === a) close(); },1200); }
    else close(); // OS cancellation is silent; dispatch isn't success.
  });
  window.WizHomeScreenApps = Object.freeze({ attach, offer, canOffer: a => pinnable(a), back() { if (!overlay) return false; close(); return true; }, get state() { return { open:!!overlay, appId:active?.id || '', pending }; } });
})();
