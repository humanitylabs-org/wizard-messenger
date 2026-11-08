/* Wizard UX core: the link sheet, an in-app browser for links tapped inside Wizard.
 *
 * Spec (Archimedes + Claude Fable, 9 Oct 2026):
 *   - Same-origin links (our private apps and previews) open in ONE sheet over the current desk.
 *     Every other origin goes straight to the system browser: no card, no limbo.
 *   - Phone: a sheet at full height (above the dock, orb usable); ⤡ shrinks it to ~3/4. Drag the top bar down
 *     to dismiss. Desktop: a right-half pane.
 *   - One top bar: ‹ (page back; hidden at depth 1), title over domain, Keep, ↗ (not in the Android
 *     app, where it would load over the shell), ✕.
 *   - Back pops the sheet's own page stack, then dismisses. It never exits.
 *   - Same-origin image links (.png/.jpg/…) open in the media viewer, never as a raw page: fit to width,
 *     pinch to zoom, swipe between the page's images, Back closes only the viewer.
 *   - Keep turns the current page into a normal window on the current desk (through the shell's window
 *     manager), then dismisses. It never creates a desk.
 *   - A second link while the sheet is open pushes onto the same stack.
 *   - Frames are same-origin, so after every load the sheet patches the page: target=_top/_parent/_blank
 *     anchors and forms, plus window.open, load inside the sheet; pushState keeps the title current.
 *     A page can never replace the Wizard shell.
 *
 * Use: const L = WizLinks.mount({ parent, mode: 'sheet' | 'pane', onKeep(url, title), onChange(open) });
 *      L.open(url) · L.back() → bool · L.close() · L.isOpen() · L.state()
 *      asWindow(path, title) → bool: the host opens same-origin pages as its own window instead of the sheet/pane.
 *      WizLinks.intercept(root, L) wires every http(s) link inside `root` (chat bubbles) to the sheet.
 */
(() => {
  'use strict';
  const ORIGIN = location.origin;
  const NATIVE = !!window.WizardOSNative || /WizardOS-Android\//.test(navigator.userAgent || '');
  const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

  function abs(href, base) {
    try { return window.WizConfig?.localURL ? window.WizConfig.localURL(href, base || location.href) : new URL(href, base || location.href); }
    catch (_) { return null; }
  }
  function inApp(u) { return !!u && (u.protocol === 'https:' || u.protocol === 'http:') && u.origin === ORIGIN; }
  function external(u) {
    // Android app: a main-frame navigation to another origin is handed to the system browser natively.
    // Browser / PWA: a new tab.
    try { window.open(u.href, '_blank', 'noopener'); } catch (e) { location.href = u.href; }
  }
  // Files (an APK, a PDF, an archive) are downloaded, never loaded into the sheet, where a WebView frame
  // swallows them and nothing happens (James 23 Oct 2026: the 0.10.3 Download button did nothing).
  const FILE = /\.(apk|aab|pdf|zip|7z|tar|t?gz|dmg|pkg|exe|msi|csv|xlsx?|docx?|pptx?|epub|mp3|m4a|aac|wav|flac|mp4|mov|mkv|webm)$/i;
  const isFile = u => !!u && FILE.test(u.pathname);
  const bridge = () => window.WizardOSNative || null;
  // Opening in the phone's own browser needs the native bridge for this Wizard's own pages: a plain window.open
  // on Android loads in the main frame (multiple windows are off) and would replace Wizard.
  const canBrowse = u => !!u && (!inApp(u) || !NATIVE || typeof bridge()?.openInBrowser === 'function');
  function browse(u) {
    const b = bridge();
    if (NATIVE && typeof b?.openInBrowser === 'function') { try { b.openInBrowser(u.href); return; } catch (_) {} }
    if (NATIVE && inApp(u)) return;
    external(u);
  }
  function download(u, doc) {
    const b = bridge();
    if (NATIVE && typeof b?.download === 'function') { try { b.download(u.href); return true; } catch (_) {} }
    // Android builds before 0.10.4 have no download bridge, and a main-frame file request would arm the
    // "can't reach your Wizard" screen. Copy the link so it can be pasted into the phone's browser.
    if (NATIVE) {
      const say = t => { const n = document.createElement('div'); n.textContent = t; n.setAttribute('role', 'status');
        n.style.cssText = 'position:fixed;left:50%;bottom:96px;transform:translateX(-50%);z-index:2147483001;max-width:86vw;background:linear-gradient(rgba(22,14,46,.98),rgba(22,14,46,.98)),var(--wz-panel,var(--wz-base,var(--bg,#05030c)));color:#f1ecff;border:1px solid rgba(205,190,255,.18);border-radius:12px;padding:10px 14px;font:14px/1.35 system-ui,sans-serif;box-shadow:0 10px 30px rgba(0,0,0,.5)';
        document.body.appendChild(n); setTimeout(() => n.remove(), 4200); };
      try { navigator.clipboard.writeText(u.href).then(() => say('Link copied · paste it into Chrome to download'), () => say('Open this link in Chrome to download: ' + u.href)); }
      catch (_) { say('Open this link in Chrome to download: ' + u.href); }
      return true;
    }
    // Browsers: an <a download> click.
    const d = doc || document, a = d.createElement('a');
    a.href = u.href; a.download = decodeURIComponent(u.pathname.split('/').pop() || ''); a.rel = 'noopener';
    // Cross-origin inline responses may ignore download; never let them replace the shell or a hosted app.
    if (!inApp(u)) a.target = '_blank';
    d.body.appendChild(a); a.click(); a.remove(); return true;
  }
  // Images never load as a raw page (Android shows them at full pixel size, wider than the screen, no zoom).
  // They open in the shared media viewer: fit to the screen width, pinch to zoom, Back closes only the viewer.
  const IMG = /\.(png|jpe?g|gif|webp|avif|bmp|svg)$/i;
  const isImage = u => !!u && IMG.test(u.pathname);
  function viewImage(u, doc) {
    const V = window.WosChat && window.WosChat.viewer; if (!V || !u) return false;
    const rel = x => x.origin === ORIGIN ? x.pathname + x.search : x.href;
    const item = x => ({ url: rel(x), name: decodeURIComponent(x.pathname.split('/').pop() || 'Image'), kind: 'image', mime: '' });
    // Swipe between every image linked from the same page, starting at the tapped one.
    const seen = new Set(), list = [];
    if (doc) for (const a of doc.querySelectorAll('a[href]')) { const x = abs(a.getAttribute('href'), doc.baseURI); if (x && isImage(x) && !seen.has(x.href)) { seen.add(x.href); list.push(x); } }
    if (!seen.has(u.href)) list.unshift(u);
    return V.open(list.map(item), Math.max(0, list.findIndex(x => x.href === u.href)));
  }
  function nice(u) {
    const p = decodeURIComponent(u.pathname.replace(/\/+$/, '').split('/').filter(Boolean).pop() || u.hostname);
    return p.replace(/[-_]+/g, ' ').replace(/\b\w/g, c => c.toUpperCase());
  }

  function mount({ parent, mode = 'sheet', onKeep, onChange, allowURL = () => true, asWindow = null, readerApp = () => null, readerOpen = null } = {}) {
    const el = document.createElement('section');
    el.className = `linksheet ${mode}`; el.setAttribute('aria-label', 'Link'); el.hidden = true;
    el.innerHTML = `<div class="ls-scrim" data-ls="close"></div><div class="ls-panel"><header class="ls-bar">
        <span class="ls-grip" aria-hidden="true"></span>
        <button class="ls-back" data-ls="back" aria-label="Back" hidden>‹</button>
        <span class="ls-title"><b></b><small></small></span>
        <button class="ls-full" data-ls="full" aria-label="Smaller" title="Smaller">⤡</button>
        <button class="ls-keep" data-ls="keep" title="Keep as a window on this desk">Keep</button>
        ${!NATIVE || typeof bridge()?.openInBrowser === 'function' ? '<button class="ls-out" data-ls="out" aria-label="Open in browser" title="Open in browser">↗</button>' : ''}
        <button class="ls-x" data-ls="close" aria-label="Close">✕</button>
      </header>
      <div class="ls-body"><i class="ls-load"></i><iframe class="ls-frame" title="Link" allow="microphone; clipboard-read; clipboard-write; fullscreen" referrerpolicy="same-origin"></iframe></div></div>`;
    (parent || document.body).appendChild(el);
    const frame = el.querySelector('iframe'), bar = el.querySelector('.ls-bar'), panel = el.querySelector('.ls-panel');
    let stack = [], open = false, popping = false, hideT = 0;

    const cur = () => stack[stack.length - 1] || null;
    function paint() {
      const c = cur(); if (!c) return;
      const u = abs(c.url);
      el.querySelector('.ls-title b').textContent = c.title || (u ? nice(u) : 'Link');
      el.querySelector('.ls-title small').textContent = u ? u.host + u.pathname : '';
      el.querySelector('.ls-back').hidden = stack.length < 2;
    }
    function load(url) {
      if (!allowURL(abs(url))) { close(); return; }
      el.classList.add('loading');
      try { frame.contentWindow.location.replace(url); } catch (e) { frame.src = url; }
    }
    function show() {
      if (open) return; open = true; clearTimeout(hideT);
      el.hidden = false; panel.style.transform = ''; void el.offsetWidth; el.classList.add('open');
      onChange && onChange(true);
    }
    function close() {
      if (!open) return false; open = false; el.classList.remove('peek'); { const fb = el.querySelector('[data-ls="full"]'); if (fb) { fb.textContent = '⤡'; fb.setAttribute('aria-label', 'Smaller'); fb.title = 'Smaller'; } }
      el.classList.remove('open'); panel.style.transform = '';
      hideT = setTimeout(() => { if (!open) { el.hidden = true; stack = []; try { frame.contentWindow.location.replace('about:blank'); } catch (e) {} } }, 260);
      onChange && onChange(false);
      return true;
    }
    function go(href, base, doc) {
      const u = abs(href, base); if (!u) return false;
      if (!allowURL(u)) return true; // consumed, never navigate a forbidden shell/task
      if (inApp(u) && isImage(u) && viewImage(u, doc)) return true;
      if (isFile(u)) return download(u, doc);
      if (!inApp(u)) {
        const app = readerApp(), target = app?.url ? abs(app.url) : null;
        if (target && inApp(target)) {
          target.searchParams.set('url', u.href);
          const path = target.pathname + target.search + target.hash;
          if (readerOpen?.(path)) return true;
          return go(path);
        }
        browse(u); return true;
      }
      // Desktop: a page preview is a normal window (wizard-os#265 rule 7), not a side pane. Images and files stay above.
      if (asWindow && asWindow(u.pathname + u.search + u.hash, nice(u))) return true;
      if (cur() && cur().url === u.href) { show(); return true; }
      stack.push({ url: u.href, title: '' }); paint(); show(); load(u.href);
      return true;
    }
    function back() {
      if (!open) return false;
      if (stack.length > 1) { stack.pop(); popping = true; paint(); load(cur().url); return true; }
      return close();
    }

    // Every load: record where the page really is, and keep it inside the sheet.
    frame.addEventListener('load', () => {
      el.classList.remove('loading');
      let win, doc; try { win = frame.contentWindow; doc = frame.contentDocument; } catch (e) { return; }
      if (!doc || doc.location.href === 'about:blank') return;
      if (!allowURL(abs(doc.location.href))) { close(); return; }
      // A bare image reached the frame anyway (redirect, no file extension): show it in the viewer instead.
      if (/^image\//.test(doc.contentType || '') && window.WosChat && window.WosChat.viewer) {
        const img = abs(doc.location.href);
        if (cur() && cur().url === img.href) { if (stack.length > 1) { stack.pop(); popping = true; paint(); load(cur().url); } else close(); }
        viewImage(img); return;
      }
      const here = doc.location.href, c = cur();
      if (c && c.url !== here) {
        // The page moved by itself (redirect, or a plain link click that we let through).
        if (popping) c.url = here; else stack.push({ url: here, title: '' });
      }
      popping = false;
      if (cur()) cur().title = (doc.title || '').trim();
      paint();
      patch(win, doc);
    });
    function patch(win, doc) {
      if (doc.__wizLinks) return; doc.__wizLinks = true;
      try { linkMenu(doc, 'body', doc.baseURI); } catch (_) {}
      doc.addEventListener('click', e => {
        if (e.defaultPrevented || e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
        const a = e.target.closest && e.target.closest('a[href]'); if (!a) return;
        const u = abs(a.getAttribute('href'), doc.baseURI); if (!u) return;
        if (!/^https?:$/.test(u.protocol)) return; // mailto:, tel:, intent:, the page's own handling
        if (inApp(u) && (isFile(u) || a.hasAttribute('download'))) { e.preventDefault(); download(u, doc); return; }
        const t = (a.getAttribute('target') || '').toLowerCase();
        if (a.hasAttribute?.('data-wizard-browse')) { e.preventDefault(); browse(u); return; }
        if (!inApp(u)) { e.preventDefault(); go(u.href, null, doc); return; }
        if (!t || t === '_self') { const h = doc.location; if (u.pathname === h.pathname && u.search === h.search && u.hash) return; } // in-page anchor
        // Every step is a replace-load driven by the sheet, so browser history never fills with frame entries
        // and Back always means "the sheet's previous page".
        e.preventDefault(); go(u.href, null, doc);
      }, true);
      // Keyboard inside the page: Esc steps back / closes; ⌘/Ctrl+Enter keeps; ⌘/Ctrl+⇧+Enter opens in the browser.
      doc.addEventListener('keydown', e => {
        if (e.key === 'Escape') { if (window.WosBack?.escape) return window.WosBack.escape(e); e.preventDefault(); e.stopPropagation(); const V = window.WosChat && window.WosChat.viewer; if (V && V.isOpen()) V.close(); else back(); return; }
        if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') { e.preventDefault(); e.stopPropagation(); el.querySelector(e.shiftKey ? '[data-ls="out"]' : '[data-ls="keep"]')?.click(); }
      }, true);
      doc.addEventListener('submit', e => {
        const f = e.target; const t = (f.getAttribute && f.getAttribute('target') || '').toLowerCase();
        if (t && t !== '_self') f.setAttribute('target', '_self');
      }, true);
      try {
        win.open = (href) => { const u = abs(href, doc.baseURI); if (u) go(u.href); return null; };
        const h = win.history, rep = h.replaceState.bind(h), push = h.pushState.bind(h);
        const sync = () => { const c = cur(); if (c) { try { c.url = win.location.href; c.title = (doc.title || '').trim() || c.title; } catch (e) {} paint(); } };
        // Single-page navigation updates the current entry; it never pads the shell's Back stack.
        h.pushState = function (s, t, u) { const r = rep(s, t, u); sync(); return r; };
        h.replaceState = function (s, t, u) { const r = rep(s, t, u); sync(); return r; };
        void push;
        new win.MutationObserver(() => { const c = cur(); if (c && doc.title && c.title !== doc.title.trim()) { c.title = doc.title.trim(); paint(); } })
          .observe(doc.querySelector('title') || doc.head || doc.documentElement, { childList: true, subtree: true, characterData: true });
      } catch (e) {}
    }

    el.addEventListener('click', e => {
      const b = e.target.closest('[data-ls]'); if (!b) return;
      const k = b.dataset.ls, c = cur();
      if (k === 'full') { const peek = !el.classList.contains('peek'); el.classList.toggle('peek', peek); b.textContent = peek ? '⤢' : '⤡'; b.setAttribute('aria-label', peek ? 'Full screen' : 'Smaller'); b.title = b.getAttribute('aria-label'); return; }
      if (k === 'close') { if (b.classList.contains('ls-scrim')) back(); else close(); }
      else if (k === 'back') back();
      else if (k === 'out' && c) { let url = c.url; try { url = frame.contentWindow.location.href; } catch (e) {} browse(abs(url)); }
      else if (k === 'keep' && c) {
        let url = c.url; try { url = frame.contentWindow.location.href; } catch (e) {}
        const u = abs(url), title = c.title || (u ? nice(u) : 'Page');
        close(); onKeep && onKeep(u ? u.pathname + u.search + u.hash : url, title);
      }
    });
    // Long-press the title: reload (expert gesture).
    let lpT = 0;
    el.querySelector('.ls-title').addEventListener('pointerdown', () => { lpT = setTimeout(() => { const c = cur(); if (c) load(c.url); }, 600); });
    ['pointerup', 'pointercancel', 'pointerleave'].forEach(t => el.querySelector('.ls-title').addEventListener(t, () => clearTimeout(lpT)));

    // Phone: drag the top bar down to dismiss. Only the bar drags; the page keeps its own scroll.
    if (mode === 'sheet') {
      let y0 = null, dy = 0, t0 = 0;
      bar.addEventListener('pointerdown', e => { if (e.target.closest('button')) return; y0 = e.clientY; dy = 0; t0 = performance.now(); el.classList.add('dragging'); try { bar.setPointerCapture(e.pointerId); } catch (x) {} });
      bar.addEventListener('pointermove', e => { if (y0 == null) return; dy = Math.max(0, e.clientY - y0); panel.style.transform = `translateY(${dy}px)`; });
      const end = () => {
        if (y0 == null) return; y0 = null; el.classList.remove('dragging');
        const v = dy / ((performance.now() - t0) || 1);
        if (dy > 120 || v > .6) close(); else panel.style.transform = '';
      };
      bar.addEventListener('pointerup', end); bar.addEventListener('pointercancel', end);
    }

    return {
      el, open: go, back, close,
      isOpen: () => open,
      state: () => ({ open, depth: stack.length, url: cur()?.url || '', title: cur()?.title || '' }),
    };
  }

  // Chat bubbles: every http(s) link goes through the sheet (same origin) or the system browser.
  function intercept(root, sheet, scope = '.bub, .note-line, .steps') {
    linkMenu(root, scope);
    root.addEventListener('click', e => {
      if (e.defaultPrevented || e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
      const a = e.target.closest && e.target.closest('a[href]'); if (!a || !a.closest(scope)) return;
      // Chat-kit links that already open in place: @session threads, Wizard Files, inline media.
      if (a.hasAttribute('data-session') || a.hasAttribute('data-mlink') || a.closest('[data-mi]')) return;
      const u = abs(a.getAttribute('href')); if (!u || !/^https?:$/.test(u.protocol)) return;
      // A thread link to this app inside a Chats thread is left to chats.js, which opens it in place and
      // remembers the thread it came from (Done/Back step back to it).
      const DL0 = window.WizCore && window.WizCore.deeplink, d0 = DL0 && DL0.isOwn(u) ? DL0.parse(u.href) : null;
      if (d0 && d0.session && !d0.video && a.closest('[data-chats]')) { e.preventDefault(); return; }
      e.preventDefault(); e.stopPropagation();
      if (inApp(u) && isImage(u) && viewImage(u, a.ownerDocument)) return;
      if (isFile(u)) { download(u, a.ownerDocument); return; }
      // A link to this app itself (…/wizard-os-home/?session=…, ?view=…) opens in place, not in a sheet.
      const DL = window.WizCore && window.WizCore.deeplink;
      if (DL && DL.route(u.href, a)) return;
      // The phone shell can claim a link (sheet.route) to open it on a desk of its own instead of the sheet.
      if (a.hasAttribute?.('data-wizard-browse')) return browse(u);
      if (!inApp(u)) return sheet.open(u.href);
      if (sheet.route && sheet.route(u.href, a)) return;
      sheet.open(u.href);
    }, true);
  }

  /* Long-press (or right-click) a link in a chat or in a page in the link sheet: open it in your own browser,
   * download it (files), or copy it. This Wizard's own pages count too (James 23 Oct 2026).
   * (James 18 Oct 2026: links in chats mostly come from the agent, so asking the agent to open its own link added nothing.) */
  const linkMenus = new Set();
  function backMenu() {
    const close = [...linkMenus].at(-1); if (!close) return false;
    close(); return true;
  }
  function linkMenu(root, scope = '.bub, .note-line, .steps', base) {
    let menu = null, timer = 0, at = null, swallow = 0;
    const shut = () => { linkMenus.delete(shut); if (menu) { menu.remove(); menu = null; } };
    const show = (a, x, y) => {
      const u = abs(a.getAttribute('href'), base); if (!u || !/^https?:$/.test(u.protocol)) return false;
      const DLm = window.WizCore && window.WizCore.deeplink;
      if (inApp(u) && DLm && DLm.isOwn && DLm.isOwn(u) && !isFile(u)) return false; // Wizard's own threads/apps open in place
      const items = (canBrowse(u) ? '<button type="button" role="menuitem" data-wl="mine">Open in your browser</button>' : '')
        + (isFile(u) ? '<button type="button" role="menuitem" data-wl="dl">Download</button>' : '')
        + '<button type="button" role="menuitem" data-wl="copy">Copy link</button>';
      shut();
      const doc = a.ownerDocument;
      menu = doc.createElement('div'); menu.className = 'wiz-linkmenu'; menu.setAttribute('role', 'menu');
      menu.innerHTML = `<div class="wl-host">${esc(inApp(u) ? decodeURIComponent(u.pathname.split('/').filter(Boolean).pop() || u.hostname) : u.hostname)}</div>${items}`;
      menu.style.cssText = 'position:fixed;z-index:2147483000;min-width:220px;max-width:min(300px,calc(100vw - 16px));background:var(--wz-base);color:var(--wz-text);border:1px solid var(--wz-border);border-radius:var(--wz-radius);box-shadow:0 14px 40px color-mix(in srgb,var(--wz-base) 65%,transparent);padding:6px;font:var(--wz-font-size)/1.3 var(--wz-font-ui)';
      for (const b of menu.querySelectorAll('button')) b.style.cssText = 'display:block;width:100%;text-align:left;border:0;background:none;padding:12px 10px;font:inherit;color:inherit;border-radius:8px;cursor:pointer';
      menu.querySelector('.wl-host').style.cssText = 'padding:6px 10px 4px;font-size:var(--wz-text-sm);color:var(--wz-text-secondary);overflow:hidden;text-overflow:ellipsis;white-space:nowrap';
      doc.body.appendChild(menu); linkMenus.add(shut);
      doc.defaultView.addEventListener('pagehide', shut, { once: true });
      let freshPress = false;
      menu.addEventListener('pointerdown', () => { freshPress = true; });
      menu.addEventListener('pointercancel', () => { freshPress = false; });
      menu.addEventListener('click', e => {
        if (!freshPress && e.detail !== 0) { e.preventDefault(); e.stopImmediatePropagation(); }
        freshPress = false;
      }, true);
      if (!isFinite(x) || !isFinite(y)) { const ar = a.getBoundingClientRect(); x = ar.left; y = ar.bottom + 6; } // no pointer position: sit under the link
      const r = menu.getBoundingClientRect(), vw = doc.documentElement.clientWidth, vh = doc.documentElement.clientHeight;
      menu.style.left = Math.max(8, Math.min(x, vw - r.width - 8)) + 'px';
      menu.style.top = Math.max(8, Math.min(y, vh - r.height - 8)) + 'px';
      menu.addEventListener('click', e => {
        const b = e.target.closest('[data-wl]'); if (!b) return; e.preventDefault(); e.stopPropagation();
        if (b.dataset.wl === 'mine') { shut(); return browse(u); }
        if (b.dataset.wl === 'dl') { shut(); return download(u, doc); }
        const done = ok => { b.textContent = ok ? 'Link copied' : 'Couldn’t copy'; setTimeout(shut, 700); };
        try { (doc.defaultView.navigator.clipboard?.writeText(u.href) || Promise.reject()).then(() => done(true), () => done(false)); } catch (_) { done(false); }
      });
      setTimeout(() => doc.addEventListener('pointerdown', function off(e) { if (!menu || !menu.contains(e.target)) { shut(); doc.removeEventListener('pointerdown', off, true); } }, true), 0);
      return true;
    };
    const target = e => { const a = e.target.closest && e.target.closest('a[href]'); return a && a.closest(scope) && !a.hasAttribute('data-session') && !a.hasAttribute('data-mlink') && !a.closest('[data-mi]') ? a : null; };
    root.addEventListener('contextmenu', e => { const a = target(e); if (a && show(a, e.clientX, e.clientY)) e.preventDefault(); }, true);
    // iOS Safari never fires contextmenu for links: a 550 ms still touch opens the same menu.
    root.addEventListener('touchstart', e => {
      const a = target(e); if (!a || e.touches.length !== 1) return;
      const t = e.touches[0]; at = { x: t.clientX, y: t.clientY };
      clearTimeout(timer); timer = setTimeout(() => { if (show(a, at.x, at.y)) swallow = Date.now() + 700; }, 550);
    }, { passive: true, capture: true });
    root.addEventListener('touchmove', e => { const t = e.touches[0]; if (at && t && Math.hypot(t.clientX - at.x, t.clientY - at.y) > 10) clearTimeout(timer); }, { passive: true, capture: true });
    root.addEventListener('touchend', () => clearTimeout(timer), { passive: true, capture: true });
    // The finger lifting after a long-press must not also follow the link.
    root.addEventListener('click', e => { if (Date.now() < swallow && target(e)) { e.preventDefault(); e.stopImmediatePropagation(); } }, true);
  }

  /* Hosted (same-origin) app frames: a link that would leave the app (another app, target=_blank/_top,
   * window.open) must never replace Wizard. On Android the WebView loads such links in the MAIN frame
   * (multiple windows are off), which is what made a tapped link take over the whole screen and need
   * several Backs. Links that stay inside the app's own path keep working as normal in-app navigation. */
  function guardFrame(win, base, sheet) {
    let doc; try { doc = win.document; } catch (e) { return; }
    if (!doc || doc.__wizLinkGuard) return; doc.__wizLinkGuard = true;
    linkMenu(doc, 'body', win.location.href);
    const home = String(base || '').split(/[?#]/)[0].replace(/[^/]*$/, '') || '/';
    const leaves = (u, tgt) => u.origin !== ORIGIN || /^_(blank|top|parent)$/i.test(tgt || '') || (home !== '/' && !u.pathname.startsWith(home));
    const go = u => {
      if (isFile(u)) return download(u, doc);
      if (u.origin !== ORIGIN) return sheet.open(u.href);
      let fe = null; try { fe = win.frameElement; } catch (e) {}
      // Hosted apps use the same canonical thread/app navigation as chat links.
      // Otherwise a Manager result opens a second Wizard inside the link viewer.
      const DL = window.WizCore && window.WizCore.deeplink;
      if (DL && DL.route(u.href, fe)) return;
      if (sheet.route && sheet.route(u.href, fe)) return;
      sheet.open(u.href);
    };
    doc.addEventListener('click', e => {
      if (e.defaultPrevented || e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
      const a = e.target.closest && e.target.closest('a[href]'); if (!a) return;
      // Verified app-owned thread action saves its draft before native navigation.
      if (window.WizAppServices?.ownsThreadLink(win, a)) return;
      const u = abs(a.getAttribute('href'), win.location.href); if (!u || !/^https?:$/.test(u.protocol)) return;
      if (u.origin === ORIGIN && isImage(u)) { if (viewImage(u, doc)) { e.preventDefault(); e.stopPropagation(); } return; }
      if (!leaves(u, a.getAttribute('target'))) return;
      e.preventDefault(); e.stopPropagation();
      if (a.hasAttribute?.('data-wizard-browse')) return browse(u);
      go(u);
    }, true);
    // A form aimed at _top/_parent would replace the whole shell (desktop previews and kept pages are windows): it stays in its window.
    doc.addEventListener('submit', e => {
      const f = e.target, b = e.submitter, own = b && b.hasAttribute && b.hasAttribute('formtarget');
      const t = ((own ? b.getAttribute('formtarget') : f && f.getAttribute && f.getAttribute('target')) || '').toLowerCase();
      if (t === '_top' || t === '_parent') (own ? b : f).setAttribute(own ? 'formtarget' : 'target', '_self');
    }, true);
    try {
      const orig = win.open;
      win.open = function (href, tgt, feat) {
        const u = abs(href, win.location.href);
        if (u && /^https?:$/.test(u.protocol) && (tgt == null || tgt === '' || /^_(blank|top|parent)$/i.test(tgt))) { go(u); return null; }
        return orig.call(win, href, tgt, feat);
      };
    } catch (e) {}
  }

  window.WizLinks = { mount, intercept, guardFrame, backMenu, isMenuOpen: () => linkMenus.size > 0, viewImage: href => viewImage(abs(href)), inApp: href => inApp(abs(href)) };
})();
