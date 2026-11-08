/* One responsive Settings feature surface. Register once: both shells render and dispatch it.
 * Shell adapters own navigation/input only; capability checks never depend on viewport width.
 * Existing outbox/recording stores remain the sole owners of durable user content. */
(() => {
  'use strict';
  const features = new Map(), mounts = new Set();
  const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const native = () => window.WizardOSNative;
  const android = () => !!native() || /Android/i.test(navigator.userAgent);
  const shell = () => !native() && /WizardShell\//.test(navigator.userAgent || '');
  const shellOrb = () => shell() && window.WosDeviceOrb?.ready ? window.WosDeviceOrb : null;
  // Rows are plain lines split by hairlines: no boxes, no icon tiles; a second line only when it says something.
  const row = (id, title, sub) => `<button class="st-row wz-row" data-st="${esc(id)}"><span class="st-tx"><b>${esc(title)}</b>${sub ? `<small>${esc(sub)}</small>` : ''}</span><span class="st-go">›</span></button>`;
  // System pages are filled by packages (WosSettings.register with page = one of these); a page with nothing on it hides.
  const filled = id => () => [...features.values()].some(f => f.page === id && (!f.available || f.available()));
  const PAGES = [
    { id: 'overview', title: 'Your network', group: 'System', available: filled('overview') },
    { id: 'ai', title: 'AI', group: 'System', available: filled('ai') },
    { id: 'network', title: 'Network & security', group: 'System', available: filled('network') },
    { id: 'storage', title: 'Storage & backups', group: 'System', available: filled('storage') },
    { id: 'appearance', title: 'Appearance', group: 'Preferences' },
    { id: 'chats', title: 'Chats & app screens' },
    // Where each app's notifications go: a badge on its icon, or Chats (core/notif-bell.js routes; one place each).
    { id: 'notifications', title: 'Notifications', available: () => typeof window.WosBell?.routes === 'function' },
    { id: 'voice', title: 'Voice & typing' },
    // Phones over Tailscale (Phone Setup). Hidden on a Wizard without Phone Setup or for a non-owner.
    // Hidden only for a non-owner; a Wizard without phone access shows the shared "not available yet" note.
    { id: 'phones', title: 'Phones & devices', available: phonesAvailable },
    { id: 'phone', title: 'Phone', available: () => shell() ? !!shellOrb() : android() },
    // Connections: the App Manager's own view (agents, what each may use, app-to-app links), only where its owner
    // listener answers. System pieces that come with every box live in Settings, not the launcher (wizard-os issue 324).
    // pending: availability not known yet; a deep link to it waits for the answer instead of falling back to the root.
    { id: 'connections', title: 'Connections', available: () => connectionsAvailable(), pending: () => conn.ok === null },
    { id: 'recovery', title: 'Unsent & recovered' },
    // Resources: the Home resource bars (AI + Compute) from the shared renderer, when it is there; else AI usage.
    // Kept beside the System pages: it is the only place with service health and the manual refresh.
    { id: 'usage', get title() { return window.WosResources?.bars ? 'Resources' : 'AI usage'; } },
    { id: 'schedules', title: 'Schedules', available: () => !!window.WosSchedules?.available },
    { id: 'about', title: 'About & updates' },
  ];
  const featurePages = { look: 'appearance', 'window-glass': 'appearance', 'skin-frame': 'appearance', 'chats-default': 'chats', 'own-views': 'chats', voice: 'voice', microphone: 'voice', selection: 'voice', assistant: 'phone', unsent: 'recovery', cancelled: 'recovery', usage: 'usage' };
  const pageOf = f => f?.page != null ? PAGES.some(p => p.id === f.page) ? f.page : 'about' : featurePages[f?.id] || 'about';
  /* Connections is served by the App Manager behind its owner channel, on this origin; the page hosts it as is, so
   * its owner-only actions (Disconnect, Reconnect, agent access, Restore defaults) stay the App Manager's own. The tab
   * shows only once that listener answers this device (a non-owner, or a box without it, never sees an empty tab). */
  // Beside the shell's own pages (/wizard-os-home/), like the Store's install routes.
  const CONNECTIONS = (() => { try { return new URL('store-install/_connections/', document.baseURI || location.href).pathname; } catch (_) { return '/wizard-os-home/store-install/_connections/'; } })();
  const conn = { ok: null, at: 0, busy: false };
  function connectionsAvailable() {
    if (!conn.busy && Date.now() - conn.at > (conn.ok ? 300000 : 60000) && typeof fetch === 'function') {
      conn.busy = true;
      fetch(CONNECTIONS, { credentials: 'same-origin', cache: 'no-store' }).then(r => r.ok, () => conn.ok).then(ok => {
        const was = conn.ok; conn.ok = ok === true; conn.at = Date.now(); conn.busy = false;
        if (was !== conn.ok) for (const m of mounts) m.render();
      });
    }
    return conn.ok === true;
  }
  const chatsHost = () => window.WizChatsHost;
  const chatsName = id => id === 'wizard-chats' ? 'Wizard Chats' : chatsHost()?.installed().find(a => a.id === id)?.name || id;
  const recovered = () => window.WosCancelled?.list?.() || [];
  function attention(ctx) {
    const items = [], n = unsentAll(ctx).length, r = recovered().length;
    if (n) items.push({ title: `${n} ${n === 1 ? 'message' : 'messages'} not sent`, feature: 'unsent' });
    if (r) items.push({ title: `${r} ${r === 1 ? 'recording' : 'recordings'} to recover`, feature: 'cancelled' });
    // Updates never appear here: the update card at the top of Settings says it once.
    if (window.WizCore.voiceStatus?.state?.ready === false) items.push({ title: 'Voice unavailable', feature: 'voice' });
    if (ctx.live?.error === 'access') items.push({ title: 'Sign-in needed', feature: 'wizard' });
    // Whatever the notification routing part puts on the Settings cog (stock: nothing) opens Notifications.
    const at = window.WosBell?.attention?.();
    if (at?.n) items.push({ title: `${at.n} ${at.label}`, feature: 'notification-routing' });
    return items;
  }
  // A quiet value on the right of a row, only where it tells you something at a glance; '' otherwise.
  function subtitle(id, ctx) {
    if (id === 'phones') { const pc = phones(), v = pc?.view; if (!v) return ''; if (pc.lost) return 'Can’t check'; const n = v.phones.length; return pc.on ? (n ? `${n} ${n === 1 ? 'device' : 'devices'}` : 'On') : pc.settingUp ? 'Setting up' : v.step === 'off' ? 'Off' : ''; }
    if (id === 'appearance') return window.WosSkin ? (mySkinWorn() ? window.WosMySkin.active.name + ' · ' : '') + lookName(window.WosSkin, window.WosSkin.current) : '';
    if (id === 'phone') { if (shell()) return shellOrb()?.state.on ? 'Everywhere on' : ''; try { return JSON.parse(native()?.everywhere?.() || '{}').enabled ? 'Everywhere on' : ''; } catch (_) { return ''; } }
    if (id === 'recovery') { const n = new Set([...unsentAll(ctx), ...recovered()].map(x => x.id)).size; return n ? String(n) : ''; }
    // Resources: quiet unless something is running low (under a quarter left), then the lowest one.
    const own = [...features.values()].find(f => f.page === id && typeof f.subtitle === 'function');
    if (own) { try { return String(own.subtitle() || '').slice(0, 40); } catch (_) { return ''; } }
    if (id === 'usage') { const low = window.WosResources?.lowest?.(); return low && low.left < 25 ? `${low.label} ${low.value || (100 - low.left) + '% used'}` : ''; }
    return '';
  }
  // The update card (os-updates.js) sits above the list, same look in every state; nothing to do = nothing shown.
  function cardHtml() {
    const h = window.WosUpdates?.cardHtml?.(); if (!h) return '';
    return `<section class="st-card-wrap" data-settings-feature="updates">${h}</section>`;
  }
  function register(feature) {
    if (!feature.id || features.has(feature.id) || typeof feature.html !== 'function') throw new Error('Settings feature requires a unique id and html');
    features.set(feature.id, feature);
    for (const m of mounts) m.render();
    return () => { features.delete(feature.id); for (const m of mounts) m.render(); };
  }
  function unsentAll(ctx) {
    let nat = []; try { nat = JSON.parse(native()?.unsent?.() || '[]'); } catch (_) {}
    return [...(ctx.outbox?.unsent() || []).map(it => ({ ...it, origin: 'app' })), ...nat.map(it => ({ ...it, origin: 'everywhere' }))].sort((a, b) => a.createdAt - b.createdAt);
  }
  function unsentRow(it, ctx) {
    const when = ctx.ago?.(new Date(it.createdAt).toISOString()) || '';
    const blocked = it.state === 'unconfirmed' || ctx.outbox?.quarantined?.(it.id);
    const held = it.state === 'held', audio = !!(it.audio || it.audioFile || it.hasAudio);
    const st = blocked ? esc(ctx.outbox?.quarantined?.(it.id) ? 'Waiting for device storage verification' : it.error || 'Could not confirm delivery · original kept') : it.state === 'empty' ? 'No speech detected · recording kept' : held ? esc(it.error || 'Kept on this device · no delivery intent confirmed; not queued') : it.state === 'failed' ? `<b class="fail">Not sent</b> · ${esc(it.error || '')}` : ['sending', 'queued'].includes(it.state) ? 'Queued / sending · awaiting receipt' : esc(window.WizReach?.label?.('send') || 'Reconnecting…');
    const src = it.origin === 'everywhere' ? 'Everywhere button' : it.source === 'orb' ? 'Orb' : 'Chat';
    const canRetry = it.origin === 'app' ? ctx.outbox?.canRetry(it) : !blocked && ['failed', 'waiting'].includes(it.state);
    const transcript = it.recoveryText || it.text || '';
    const recovery = it.origin === 'app' && it.audio && ['held', 'empty', 'failed', 'unconfirmed'].includes(it.state);
    const working = ctx.outbox?.transcribingRecording?.(it.id);
    return `<div class="ub-row ${esc(it.state)}" data-ubid="${esc(it.id)}" data-uborigin="${it.origin}"><div class="ub-t"><span>${esc(transcript || it.typed || (audio ? 'Retained voice recording' : 'Retained message'))}</span></div><div class="ub-m">${src} · ${esc(when)} · ${st}</div>${it.recoveryError ? `<div class="ub-m">${esc(it.recoveryError)}</div>` : ''}<div class="ub-a">${it.state === 'waiting' ? '<button data-ub="troubleshoot">Open Troubleshooter</button>' : ''}${it.parkedDraft && ctx.restoreReply ? '<button data-ub="restore-reply">Return to paused reply</button>' : ''}${canRetry ? `<button data-ub="retry">${it.state === 'empty' ? 'Retry speech & send' : 'Retry'}</button>` : ''}${recovery ? `<button data-ub="play">Play audio</button><button data-ub="download">Save audio</button>${!ctx.outbox?.quarantined?.(it.id) ? `<button data-ub="transcribe" ${working ? 'disabled' : ''}>${working ? 'Transcribing…' : 'Transcribe only'}</button>` : ''}` : ''}${transcript ? '<button data-ub="copy">Copy transcript</button>' : ''}${it.origin === 'app' && it.sessionId && ctx.live?.session(it.sessionId) ? '<button data-ub="open">Open thread</button>' : ''}${it.origin === 'app' && !audio && !blocked && !held && !it.body && !['sending', 'queued'].includes(it.state) ? '<button data-ub="edit">Edit</button>' : ''}<button data-ub="delete" class="ghost">Delete</button></div></div>`;
  }
  function focusUnsent(id) {
    requestAnimationFrame(() => {
      const row = [...document.querySelectorAll('[data-ubid]')].find(el => el.dataset.ubid === id && el.getClientRects().length);
      if (row) { row.scrollIntoView({ block: 'center' }); row.querySelector('button')?.focus({ preventScroll: true }); }
    });
  }
  let preview = null, previewUrl = '';
  function stopPreview() { if (preview) { preview.pause(); preview.remove(); preview = null; } if (previewUrl) URL.revokeObjectURL(previewUrl); previewUrl = ''; }
  function retryAll(ctx) {
    const n = ctx.outbox?.retryAll() || 0;
    // Native retained custody has independent intent/receipt rules. Never wildcard it
    // from a web bulk action; its explicit per-item recovery remains available.
    ctx.toast?.('↻', ctx.outbox?.retryFeedback(n) || 'Nothing eligible to retry', 2400);
    setTimeout(() => ctx.render?.(), 300); return n;
  }
  function unsentAction(ctx, id, origin, action) {
    if (action === 'troubleshoot') { window.WizReach?.open(); return; }
    if (origin === 'everywhere') {
      if (action === 'retry') native()?.retryUnsent?.(id);
      if (action === 'delete') { for (const row of ctx.root?.querySelectorAll('[data-ubid]') || []) if (row.dataset.ubid === id) { const b = row.querySelector('[data-ub="delete"]'); if (b) { b.disabled = true; b.textContent = 'Deleting…'; } } native()?.deleteUnsent?.(id); }
      setTimeout(() => ctx.changed?.(), 300); return;
    }
    const it = ctx.outbox?.get(id); if (!it) return;
    if (action === 'restore-reply') { ctx.restoreReply?.(id); return; }
    if (action === 'retry') ctx.toast?.('↻', ctx.outbox.retryFeedback(ctx.outbox.retry(id)), 2400);
    if (action === 'transcribe') { ctx.outbox.transcribeRecording(id).then(() => { ctx.changed?.(); ctx.render?.(); }); return; }
    if (action === 'copy') { window.WosChat.copyText(it.recoveryText || it.text || '').then(() => ctx.toast?.('✓', 'Transcript copied · nothing sent', 2000)); return; }
    if (action === 'play' && it.audio) {
      stopPreview(); previewUrl = URL.createObjectURL(it.audio); preview = document.createElement('audio');
      preview.controls = true; preview.src = previewUrl; preview.style.maxWidth = '100%';
      const row = [...document.querySelectorAll('[data-ubid]')].find(el => el.dataset.ubid === id && el.getClientRects().length);
      row?.appendChild(preview); preview.onended = stopPreview;
      preview.play().catch(() => ctx.toast?.('!', 'Could not play this format · Save audio instead', 2400)); return;
    }
    if (action === 'download' && it.audio) {
      const url = URL.createObjectURL(it.audio), a = document.createElement('a');
      const ext = /aac/.test(it.audioType) ? 'aac' : /mp4|m4a/.test(it.audioType) ? 'm4a' : /wav/.test(it.audioType) ? 'wav' : /ogg/.test(it.audioType) ? 'ogg' : 'webm';
      a.href = url; a.download = `wizard-recording-${id}.${ext}`; a.click(); setTimeout(() => URL.revokeObjectURL(url), 60000); return;
    }
    if (action === 'delete') {
      // Custody deletes must be durable before losing the original; acknowledge the tap now.
      const buttons = [...(ctx.root?.querySelectorAll('[data-ubid]') || [])].filter(row => row.dataset.ubid === id).map(row => row.querySelector('[data-ub="delete"]')).filter(Boolean);
      for (const b of buttons) { if (b.disabled) return; b.disabled = true; b.textContent = 'Deleting…'; }
      Promise.resolve(ctx.outbox.remove(id)).then(ok => { ctx.render?.(); ctx.toast?.(ok === false ? '!' : '✕', ok === false ? 'Could not save deletion · keep Wizard open' : 'Deleted', 2400); }, () => { for (const b of buttons) { b.disabled = false; b.textContent = 'Delete'; } ctx.toast?.('!', 'Could not save deletion · original kept', 2400); });
    }
    if (action === 'open') ctx.openThread(it.sessionId);
    // Moving an audio-bearing/in-flight record to a text composer would lose custody. Never do it.
    if (action === 'edit') {
      if (it.audio || it.audioFile || it.hasAudio || it.body || it.state === 'sending' || it.state === 'unconfirmed' || ctx.outbox.quarantined?.(id)) return ctx.toast?.('!', 'Recording or sending message kept · retry it, or open its thread', 2400);
      ctx.editUnsent(it);
    }
  }
  register({ id: 'unsent', aliases: ['unsent'], html(ctx) {
    const all = unsentAll(ctx);
    return `<div class="st-group"><h4>Unsent & retained <span>${all.length || ''}</span></h4>${all.length ? all.map(it => unsentRow(it, ctx)).join('') + (all.length > 1 ? '<button class="st-wide wz-button secondary" data-ub-all="retry">Retry all</button>' : '') : '<div class="st-empty">No messages awaiting delivery on this device.</div>'}<details class="st-info"><summary aria-label="About retained messages">?</summary><p class="st-note">Held recordings are not queued. Retry all sends eligible failed/waiting messages only; held commands and unconfirmed delivery stay kept.</p></details></div>`;
  }, act(ctx, el) {
    const b = el.closest('[data-ub]');
    if (b) { const r = b.closest('[data-ubid]'); unsentAction(ctx, r.dataset.ubid, r.dataset.uborigin, b.dataset.ub); return true; }
    if (!el.closest('[data-ub-all]')) return false;
    retryAll(ctx); return true;
  } });
  // Public kind-0 only. The signed event comes from native; no secret is handled by the page.
  const identityRelays = ['wss://relay.aiwizards.com', 'wss://nos.lol', 'wss://relay.damus.io'];
  function publishIdentityProfile(event) {
    return Promise.any(identityRelays.map(url => new Promise((resolve, reject) => {
      let socket; const timer = setTimeout(() => { socket?.close(); reject(new Error('relay timeout')); }, 8000);
      const finish = (ok, message) => { clearTimeout(timer); socket?.close(); ok ? resolve(url) : reject(new Error(message || 'relay refused')); };
      try {
        socket = new WebSocket(url);
        socket.onopen = () => socket.send(JSON.stringify(['EVENT', event]));
        socket.onmessage = ev => { let m; try { m = JSON.parse(ev.data); } catch (_) { return; } if (m[0] === 'OK' && m[1] === event.id) finish(m[2] === true, m[3]); };
        socket.onerror = () => finish(false, 'relay unavailable');
        socket.onclose = () => { clearTimeout(timer); reject(new Error('relay closed')); };
      } catch (e) { clearTimeout(timer); reject(e); }
    })));
  }
  let identityInfo = null, identityAsked = false;
  register({ id: 'wizard-id', page: 'phone', aliases: ['wizard-id'], available: () => !!window.wizardDevicePort,
    html(ctx) {
      if (!identityAsked) { identityAsked = true; window.WizCore?.bridge?.call('identity.info').then(info => { identityInfo = info?.npub ? info : null; (ctx?.render || ctx?.changed)?.(); }).catch(() => { identityAsked = false; }); }
      const sub = identityInfo?.npub ? `${identityInfo.name || 'Your ID'} · ${identityInfo.backed_up ? 'Backed up' : 'Not backed up'}` : 'Not set up · your signing key stays on this phone';
      return `<div class="st-group"><h4>Identity</h4>${row('wizard-id', 'Wizard ID', sub)}</div>`;
    },
    act(ctx, el) {
      if (!el.closest('[data-st="wizard-id"]')) return false;
      window.WizCore.bridge.call('identity.setup').then(async result => {
        if (result.cancelled || result.denied) return;
        identityInfo = await window.WizCore.bridge.call('identity.info');
        ctx.changed?.();
        if (result.profile_event) {
          try { await publishIdentityProfile(result.profile_event); ctx.toast?.('✓', 'Wizard ID profile published', 2200); }
          catch (_) { ctx.toast?.('!', 'ID saved on this phone · profile not published. Open Wizard ID to retry.', 4500); }
        }
      }).catch(() => ctx.toast?.('!', 'Wizard ID unavailable · update the Wizard Android app', 3000));
      return true;
    }
  });
  // Reply style belongs to each agent's own persona (SOUL.md), not to Wizard: one source, survives detach.
  register({ id: 'response-style', page: 'chats', aliases: ['response-style'],
    html() {
      return `<div class="st-group"><div class="st-row static"><span class="st-tx"><b>Reply style</b><small>Each agent keeps its own. Tell an agent how you like replies and it remembers.</small></span></div></div>`;
    },
  });
  const mySkinWorn = () => !!window.WosMySkin?.active;
  function mySkinRow(skin) {
    const M = window.WosMySkin, st = M?.state, js = st?.script;
    // A script that failed to load names its file and the reason, and stays off until the owner turns it on again.
    const jsFile = js?.file || (M.active ? 'Skins/' + M.active.id + '/skin.js' : 'skin.js');
    const jsTitle = js?.error && !js.approved ? 'Skin script off' : js?.approved ? 'Skin script on' : 'Skin script changed';
    const jsSub = js?.error && !js.approved ? `${jsFile} didn’t load: ${js.error.message}` : `${jsFile} · approval on this device`;
    const script = js?.exists && !st.off ? `<div class="st-row static my-skin-row${js.error && !js.approved ? ' failed' : ''}" data-myskin-script${js.error && !js.approved ? ' data-myskin-error' : ''}><span class="st-tx"><b>${jsTitle}</b><small>${esc(jsSub)}</small></span><span class="ms-acts">${js.approved ? '<button type="button" class="ghost" data-myskin="off">Turn off</button>' : `<button type="button" data-myskin="on" data-myskin-hash="${esc(js.sha256 || '')}" ${js.valid ? '' : 'disabled'}>Turn on</button>`}</span></div>` : '';
    return `<div class="ms-panel" data-ownskin-panel><button class="st-row wz-row" data-myskin="edit"><span class="st-tx"><b>Edit with your Wizard</b><small>Ask your Wizard ‘change my ${esc(skin.name)} skin so…’</small></span><span class="st-go">›</span></button><p class="st-hint">${M.storage === 'box' ? 'Saved on your Wizard.' : M.storage === 'local' ? 'Saved on this device until your Wizard is updated.' : 'Offline · showing a cached skin.'}</p>${script}<button class="st-row wz-row" data-ownskin-remove="${esc(skin.id)}"><span class="st-tx"><b>Remove skin</b></span><span class="st-go">›</span></button></div>`;
  }
  function mySkinAction(ctx, what, event) {
    const M = window.WosMySkin; if (!M) return;
    if (what === 'on') { M.turnOn(event); return; }
    if (what === 'off') { M.turnOff(); return; }
    if (what === 'edit') {
      const app = ['wizard-files', 'files'].find(id => window.WizCanOpen?.(id));
      // Open the registered app, not a guessed folder URL or an app id absent on this box.
      const opened = app && window.WizOpenApp?.(app);
      if (!opened) ctx.toast?.('✎', esc(`Ask your Wizard: “change my ${M.active?.name || 'own'} skin so…”`), 4000);
    }
  }
  // Settings › Look: choose a skin family, then one of its colours. Tweaks stay independent.
  const lookName = (S, id) => S.list.find(k => k.id === id)?.name || '';
  // Skin picker: a grid of small preview cards, one per look, in the skins' own order. Each card is a miniature of
  // that look (its background, a reply and a sent bubble, the dock with its orb) drawn in CSS from its own tokens, with
  // the name set in its own face. Names stay hidden until those faces load (at most 2.5s), so they never flash.
  let facesP = null, facesReady = false;
  const faceCss = f => f ? `font-family:${f.family};font-weight:${f.weight || 400};font-style:${f.style || 'normal'}` : '';
  function loadFaces() {
    if (facesP) return facesP;
    const L = window.WosSkin?.list || [], F = typeof document !== 'undefined' && document.fonts;
    if (!F || !F.load) { facesReady = true; return (facesP = Promise.resolve()); }
    const all = Promise.all(L.filter(k => k.face).map(k => F.load(`${k.face.style || 'normal'} ${k.face.weight || 400} 15px ${k.face.family}`).catch(() => null)));
    facesP = Promise.race([all, new Promise(r => setTimeout(r, 2500))]).then(() => {
      facesReady = true;
      for (const m of mounts) m.context?.root?.querySelectorAll?.('.skp-wait').forEach(n => n.classList.remove('skp-wait'));
    });
    return facesP;
  }
  const pvars = k => { const t = k.t || {}; return [['bg', t.bg || k.bg], ['ink', t.ink], ['ac', t.violet || k.accent], ['ac2', t['violet-2']], ['pk', t.pink], ['cy', t.cyan], ['dock', t['sk-dock']], ['dl', t['sk-dock-line']]]
    .filter(([, v]) => v).map(([n, v]) => `--p-${n}:${esc(v)}`).join(';'); };
  const mini = k => `<span class="skp-mini" data-skp="${esc(k.id)}" style="${pvars(k)}" aria-hidden="true"><i class="skp-a"></i><i class="skp-a skp-a2"></i><i class="skp-u"></i><i class="skp-dock"><i class="skp-orb"></i></i></span>`;
  const skinCard = (k, cur) => `<button type="button" class="skp-card" data-skinpick="${esc(k.id)}" aria-pressed="${k.id === cur}" aria-label="${esc(k.name)}">${mini(k)}<span class="skp-nm" style="${esc(faceCss(k.face))}">${esc(k.name)}</span></button>`;
  /* Tweaks are separate from color: a row of published sets to start from (Standard, Miguel's, …), then one
   * disclosure with every installed tweak as a switch. Picking a set clears the per-tweak choices. */
  const tweakSwitches = (items, attr, busy = false, by = null) => items.map(t => `<button type="button" class="st-row tw-row" ${attr}="${esc(t.id)}" role="switch" aria-checked="${!!t.on}"${busy ? ' disabled' : ''}><span class="st-tx"><b>${esc(t.name)}</b>${by ? `<small class="tw-by">${t.where ? esc(t.where) + ' · ' : ''}by ${esc(by(t.author))}</small>` : ''}${t.description ? `<small>${esc(t.description)}</small>` : ''}</span><span class="sw ${t.on ? 'on' : ''}" aria-hidden="true"><i></i></span></button>`).join('');
  // One support predicate for both Look and New skin. Filter rows only: the
  // draft map must retain hidden other-shell defaults when it is saved.
  const shellTweaks = (items, shell) => items.filter(t => !t.view || !Array.isArray(t.shells) || t.shells.includes(shell));
  function tweakRows(S) {
    const E = window.WosExperience; if (!E) return '';
    const s = E.state, own = window.WosMySkin?.active;
    if (!s.tweaks.length && !s.error) return '';
    if (!authorList) E.authors?.().then(list => { authorList = list; for (const m of mounts) m.render(); }, () => {});
    const name = who => (authorList || []).find(a => a.id === who)?.name || who;
    // Release-wide features are ordinary settings on their own pages (settingRow below), never tweaks.
    const exp = s.tweaks.filter(t => !t.builtin && !(E.desktopViews?.length && t.layout));
    const views = E.desktopViews || [];
    const viewPicker = views.length ? `<div class="tw-group"><h4>Shell view</h4><p class="st-hint">On this desktop</p><div role="radiogroup" aria-label="Shell view">${views.map(v => `<button type="button" class="st-row wz-row" data-desktop-view="${esc(v.id)}" role="radio" aria-checked="${E.desktopView === v.id}"><span class="st-tx"><b>${esc(v.name)}</b></span><span aria-hidden="true">${E.desktopView === v.id ? '●' : '○'}</span></button>`).join('')}</div></div>` : '';
    // Views are chosen per type of device (desktop / phone): only the ones this one can wear, marked as such.
    const where = s.shell === 'desktop' ? 'Desktop view' : 'Phone view';
    const shown = shellTweaks(exp, s.shell).map(t => t.view && s.shell ? { ...t, where } : t);
    const err = s.error ? `<p role="alert">${esc(s.error)}</p>` : '';
    // One flat list, A to Z (Miguel, 1 Nov 2026): one switch per tweak, each labelled "by <author>"; no per-author
    // quick buttons. Same list whatever skin is worn; skins are looks only.
    const list = [...shown].sort((a, b) => String(a.name || a.id).localeCompare(String(b.name || b.id)) || a.id.localeCompare(b.id));
    const rows = list.map(t => tweakSwitches([t], 'data-tweak-toggle', s.busy, name) + (t.on && tweakOpts.has(t.id) ? `<div class="tw-opts" data-tweak-opts="${esc(t.id)}"></div>` : '')).join('');
    return `${viewPicker}<div class="tw-group"><h4>Tweaks</h4><p class="st-hint">Each one is a feature someone is trying out. They work with any skin.</p>${err}<div class="tw-list">${rows}</div></div>`;
  }
  let authorList = null;
  const tweakOpts = new Map(); // tweak id -> its options node (skin-host api.settings.section(.., 'look', node))
  function tweakOptions(id, node) {
    tweakOpts.set(id, node); for (const m of mounts) m.render();
    return () => { if (tweakOpts.get(id) === node) { tweakOpts.delete(id); node.remove?.(); for (const m of mounts) m.render(); } };
  }
  window.addEventListener?.('wos:experience', () => { for (const m of mounts) m.render(); });
  const newTile = () => window.WosMySkin ? '<button type="button" class="skp-card skp-my" data-newskin aria-label="New skin"><span class="skp-mini skp-mini-my" aria-hidden="true"><i class="skp-plus"></i></span><span class="skp-nm">+ New skin</span></button>' : '';
  function skinAction(action, done, failed) {
    try { const result = action(); if (result?.then) result.then(done, failed); else done(result); } catch (e) { failed(e); }
  }
  function ownTiles(S, removing) {
    const M = window.WosMySkin;
    return (M?.recipes || []).filter(skin => skin.id !== removing).map(skin => {
      const palette = S.list.find(k => k.id === skin.base);
      return `<button type="button" class="skp-card" data-ownskin="${esc(skin.id)}" aria-pressed="${M.active?.id === skin.id}" aria-label="${esc(skin.name)}">${palette ? mini(palette) : ''}<span class="skp-nm">${esc(skin.name)}</span></button>`;
    }).join('');
  }
  async function draftDefaults(ctx, base) {
    const draft = ctx.skinDraft; if (!draft) return;
    const seq = draft.seq = (draft.seq || 0) + 1;
    draft.base = base || draft.base; draft.error = '';
    // The list is warmed when Look opens, so Loading only shows on a cold first read.
    draft.loading = !window.WosExperience.installedReady; ctx.render?.();
    try {
      let [items, map] = await Promise.all([window.WosExperience.installed(), window.WosExperience.defaults()]);
      if (ctx.skinDraft !== draft || draft.seq !== seq) return;
      if (draft.recoveryTweaks) map = { ...map, ...draft.recoveryTweaks };
      // A replacement group (two Home maps) is one switch: keep only the member that would load, so the draft never
      // shows two and never saves the hidden one as off (any member saved off turns the whole group off).
      for (const g of window.WosExperience.groups?.() || []) {
        const present = g.filter(id => items.some(t => t.id === id)); if (present.length < 2) continue;
        const pick = present.find(id => map[id]) || present[0];
        map = Object.fromEntries(Object.entries(map).filter(([id]) => id === pick || !present.includes(id)));
        items = items.filter(t => t.id === pick || !present.includes(t.id));
      }
      draft.items = items; draft.tweaks = map;
    } catch (e) { if (ctx.skinDraft === draft && draft.seq === seq) draft.error = 'Could not load installed tweaks. Try again.'; }
    finally { if (ctx.skinDraft === draft && draft.seq === seq) { draft.loading = false; ctx.render?.(); } }
  }
  function newSkinHtml(S, draft) {
    const family = S.families.find(f => f.id === S.familyOf(draft.base));
    return `<div class="st-group sc-sheet skin-create" data-newskin-sheet><h4>New skin</h4><label>Name<input data-skin-name maxlength="60" autocomplete="off" value="${esc(draft.name)}" placeholder="Give your skin a name"></label><label>Base skin<select data-skin-base>${S.families.map(f => `<option value="${esc(f.id)}"${f.id === family?.id ? ' selected' : ''}>${esc(f.name)}</option>`).join('')}</select></label><h4>Color</h4><div class="skp" role="group" aria-label="New skin colors">${(family?.palettes || []).map(id => S.list.find(k => k.id === id)).filter(Boolean).map(k => skinCard(k, draft.base)).join('')}</div><h4>Tweaks</h4><p class="st-hint">Starts with the ones on now.</p>${draft.loading ? '<p role="status">Loading tweaks…</p>' : tweakSwitches(shellTweaks(draft.items || [], window.WosExperience?.state.shell).map(t => ({ ...t, on: draft.tweaks[t.id] })), 'data-draft-tweak')}${draft.validation ? `<p role="alert">${esc(draft.validation)}</p>` : ''}${draft.error ? `<p role="alert">${esc(draft.error)}</p><button data-skinretry>Try again</button>` : ''}<div class="st-actions"><button data-skin-create${draft.loading || draft.error || draft.saving ? ' disabled' : ''}>Create skin</button></div></div>`;
  }
  function deviceSkinRecovery() {
    const previews = window.WosMySkin?.previews || [];
    if (!previews.length) return '';
    return `<details class="st-advanced"><summary>Recover device skins</summary><p>These previews are still on this device. Recover opens New skin; nothing is saved until you choose Create.</p>${previews.map(s => `<div><button type="button" data-skin-preview="${esc(s.id)}">Recover ${esc(s.name)}</button><button type="button" data-skin-preview-dismiss="${esc(s.id)}">Dismiss preview</button></div>`).join('')}</details>`;
  }
  function lookHtml(S, ctx) {
    window.WosExperience?.installed?.().catch(() => {}); // warm the tweak list for New skin
    if (ctx.skinDraft) return newSkinHtml(S, ctx.skinDraft);
    const cur = S.current, base = lookName(S, cur), own = window.WosMySkin?.active;
    loadFaces();
    const fams = S.families || [{ id: cur, name: base, palettes: S.list.map(k => k.id) }];
    const worn = S.familyOf?.(cur) || fams[0]?.id;
    const family = fams.find(f => f.id === worn) || fams[0];
    const tiles = fams.map(f => {
      const k = S.list.find(k => k.id === (S.lastIn?.(f.id) || f.palettes[0]));
      return `<button type="button" class="skp-card" data-skinfamily="${esc(f.id)}" aria-pressed="${!own && f.id === worn}" aria-label="${esc(f.name)}">${k ? mini(k) : ''}<span class="skp-nm">${esc(f.name)}</span></button>`;
    }).join('');
    const grid = `<div class="skp skp-families" role="group" aria-label="Skins">${tiles}${ownTiles(S, ctx.skinRemoving)}${newTile()}</div>`;
    const colours = `<div class="skp-colours"><h4>Colors</h4><div class="skp" role="group" aria-label="${esc(own?.name || family?.name || 'Skin')} colors">${(family?.palettes || []).map(id => S.list.find(k => k.id === id)).filter(Boolean).map(k => skinCard(k, cur)).join('')}</div></div>` + (!own && (S.wizardBackgrounds || twinned(S, family)) ? backgroundHtml(S, family, cur, ctx) : '');
    const confirm = ctx.skinRemove ? `<div class="st-confirm-scrim"><section class="st-confirm" role="alertdialog" aria-modal="true" aria-labelledby="skin-remove-title"><h3 id="skin-remove-title">Remove ${esc(ctx.skinRemove.name)}?</h3><p>You can undo this removal. Your Wizard keeps the folder in trash for seven days.</p><div class="st-actions"><button data-skin-remove-cancel>Cancel</button><button data-skin-remove-confirm>Remove skin</button></div></section></div>` : '';
    const undo = ctx.skinUndo ? `<div class="st-skin-toast" role="status">Skin removed<button data-skin-undo>Undo</button><button data-skin-undo-dismiss aria-label="Dismiss">×</button></div>` : '';
    return `<div class="st-group" data-stgroup="look"><h4>Skin</h4><div class="skp-all${facesReady ? '' : ' skp-wait'}">${grid}${colours}</div>${deviceSkinRecovery()}${tweakRows(S)}${own ? mySkinRow(own) : ''}${confirm}${undo}</div>`;
  }
  // Background + Mode (Miguel, 4 Nov 2026): a skin whose colours come in dark/light twins shows ONE row of
  // backgrounds (Plain, landscape pictures, Wizard OS scenes) and a separate Dark | Light switch. Keep the
  // independent Colors control too (the shared Look contract). Background and Mode never disappear into a palette name.
  const twinned = (S, family) => typeof S.setWallpaper === 'function' && typeof S.twin === 'function' && (family?.palettes || []).length > 1 && family.palettes.every(id => S.twin(id));
  const isLight = id => /-light$/.test(id);
  function backgroundHtml(S, family, cur, ctx = {}) {
    const light = isLight(cur), plain = family.palettes.find(id => !/^landscapes/.test(id) && isLight(id) === light);
    const scenic = family.palettes.find(id => /^landscapes/.test(id) && isLight(id) === light);
    const wizard = !!S.wizardBackgrounds, onScene = wizard || /^landscapes/.test(cur), chosen = onScene ? S.wallpaper : 'plain';
    const card = (id, name, k, img) => `<button type="button" class="skp-card" data-bgpick="${esc(id)}" aria-pressed="${id === chosen}" aria-label="${esc(name)}"><span class="skp-mini" data-skp="${esc(k.id)}" style="${pvars(k)}${img ? `;background:linear-gradient(180deg, color-mix(in srgb, var(--p-bg, var(--wz-bg)) 35%, transparent), transparent 34%, transparent 66%, color-mix(in srgb, var(--p-bg, var(--wz-bg)) 45%, transparent)),url('${img}') center / cover` : ''}" aria-hidden="true"><i class="skp-a"></i><i class="skp-a skp-a2"></i><i class="skp-u"></i><i class="skp-dock"><i class="skp-orb"></i></i></span><span class="skp-nm">${esc(name)}</span></button>`;
    const pk = S.list.find(k => k.id === plain), lk = S.list.find(k => k.id === (wizard ? cur : scenic));
    const cards = [wizard ? card('living', 'Living canvas', lk) : pk ? card('plain', 'Plain', pk) : '', ...(lk ? S.wallpapers.map(w => card(w.id, w.name, lk, S.wallpaperThumb(w.id))) : []), wizard && lk ? card('custom', 'Custom', lk, S.wallpaperThumb('custom')) : ''].join('');
    const note = wizard && chosen === 'custom' ? 'Your image, shared with your other desktops.' : wizard && chosen === 'living' ? 'The living canvas for this color.' : onScene ? (S.wallpapers.find(w => w.id === S.wallpaper)?.who || '') : 'Plain black or white, no picture.';
    const mode = `<div class="st-seg" role="radiogroup" aria-label="Mode">${[['dark', 'Dark'], ['light', 'Light']].map(([m, n]) => `<button type="button" role="radio" aria-checked="${(m === 'light') === light}" data-skinmode="${m}">${n}</button>`).join('')}</div>`;
    return `<div class="skp-colours">${wizard ? '' : `<h4>Mode</h4>${mode}`}<h4>Background</h4><div class="skp" role="radiogroup" aria-label="Background">${cards}</div><p class="st-hint" data-wp-note>${esc(note)}</p>${wizard ? `<div class="st-actions"><button type="button" data-background-upload ${ctx.backgroundUploading ? 'disabled' : ''}>${S.desktopBackdrop?.wide ? 'Replace image' : 'Choose image'}</button>${S.desktopBackdrop?.wide ? `<button type="button" data-background-portrait ${ctx.backgroundUploading ? 'disabled' : ''}>${S.desktopBackdrop.tall ? 'Replace portrait image' : 'Add portrait image'}</button>` : ''}</div><p class="st-hint" role="status" data-background-status>${esc(ctx.backgroundUploading || 'PNG, JPEG, WebP, AVIF or GIF · up to 20 MB. Optional portrait image for tall desktop windows.')}</p>` : ''}</div>`;
  }
  function chooseBackgroundImage(ctx, portrait = false) {
    if (ctx.backgroundUploading) return;
    const input = document.createElement('input'); input.type = 'file'; input.accept = 'image/png,image/jpeg,image/webp,image/avif,image/gif';
    input.addEventListener('change', () => {
      const file = input.files?.[0]; if (!file) return;
      ctx.backgroundUploading = 'Uploading image…'; ctx.render();
      void window.WosSkin.uploadWallpaper(file, { portrait, onProgress(sent, total) {
        ctx.backgroundUploading = `Uploading image… ${Math.round(sent / total * 100)}%`;
        const status = ctx.root.querySelector('[data-background-status]'); if (status) status.textContent = ctx.backgroundUploading;
      } }).then(() => { ctx.backgroundUploading = ''; for (const m of mounts) m.render(); }, e => {
        ctx.backgroundUploading = ''; ctx.render(); ctx.toast?.('!', e.message || 'Could not upload image. Try again.', 4000);
      });
    }, { once: true });
    input.click();
  }
  function backgroundAct(ctx, el, pick) {
    const S = window.WosSkin, cur = S.current, light = isLight(cur);
    if (el.closest('[data-background-upload]')) { chooseBackgroundImage(ctx); return true; }
    if (el.closest('[data-background-portrait]')) { chooseBackgroundImage(ctx, true); return true; }
    const m = el.closest('[data-skinmode]');
    if (m) { const want = m.dataset.skinmode === 'light'; if (want !== light) { const t = S.twin(cur); if (t) pick(t.id); } return true; }
    const b = el.closest('[data-bgpick]'); if (!b) return false;
    const fam = S.families.find(f => f.id === S.familyOf(cur)), id = b.dataset.bgpick;
    if (S.wizardBackgrounds) { if (id === 'custom' && !S.desktopBackdrop?.wide) { chooseBackgroundImage(ctx); return true; } S.setWallpaper(id); ctx.render(); ctx.haptic?.(8); return true; }
    const target = fam.palettes.find(p => isLight(p) === light && (id === 'plain' ? !/^landscapes/.test(p) : /^landscapes/.test(p)));
    if (id !== 'plain') S.setWallpaper(id);
    if (target && target !== cur) pick(target); else { ctx.render(); ctx.haptic?.(8); }
    return true;
  }
  register({ id: 'look', aliases: ['skin'], html(ctx) {
    const S = window.WosSkin; if (!S) return '';
    return lookHtml(S, ctx);
  }, deferRefresh: ctx => !!(ctx.skinDraft || ctx.skinRemove) || [...tweakOpts.values()].some(n => n.contains?.(document.activeElement) && document.activeElement?.matches?.('input, textarea')),
  painted(ctx, section) { for (const slot of section?.querySelectorAll?.('[data-tweak-opts]') || []) { const n = tweakOpts.get(slot.dataset.tweakOpts); if (n && n.parentNode !== slot) slot.append(n); } },
  leave(ctx) { ctx.skinDraft = null; ctx.skinRemove = null; },
  back(ctx) {
    if (ctx.skinRemove) { ctx.skinRemove = null; ctx.render(); return true; }
    if (!ctx.skinDraft) return false;
    ctx.skinDraft = null; ctx.render(); ctx.root.querySelector('[data-newskin]')?.focus(); return true;
  }, input(ctx, el) {
    if (!ctx.skinDraft || ctx.skinDraft.saving) return;
    if (el.matches('[data-skin-name]')) ctx.skinDraft.name = el.value;
    if (el.matches('[data-skin-base]')) {
      const S = window.WosSkin, family = S.families.find(f => f.id === el.value);
      if (family && S.familyOf(ctx.skinDraft.base) !== family.id) {
        ctx.skinDraft.base = S.lastIn(family.id); ctx.render();
      }
    }
  }, act(ctx, el, event) {
    const M = window.WosMySkin, S = window.WosSkin;
    const pickPalette = id => skinAction(() => M?.active ? M.update({ base: id }) : S.set(id), () => { void window.WosExperience?.chooseSkin?.(); for (const m of mounts) m.render(); ctx.haptic?.(8); }, e => ctx.toast?.('!', e.message, 3000));
    if (backgroundAct(ctx, el, pickPalette)) return true;
    if (el.closest('[data-skin-remove-cancel]')) { ctx.skinRemove = null; ctx.render(); return true; }
    if (el.closest('[data-skin-remove-confirm]')) {
      if (ctx.skinSaving) return true; ctx.skinSaving = true;
      const removed = ctx.skinRemove; ctx.skinRemoving = removed.id; ctx.skinRemove = null; ctx.render();
      skinAction(() => M.remove(removed.id), snapshot => { ctx.skinSaving = false; ctx.skinRemoving = null; ctx.skinUndo = snapshot; ctx.render(); ctx.root.querySelector('[data-skin-undo]')?.focus(); }, e => { ctx.skinSaving = false; ctx.skinRemoving = null; if (!ctx.skinRemove) ctx.skinRemove = removed; ctx.render(); ctx.toast?.('!', e.message || 'Could not remove skin', 3000); }); return true;
    }
    if (ctx.skinRemove) return true;
    if (el.closest('[data-skin-undo]')) { if (ctx.skinSaving) return true; ctx.skinSaving = true; skinAction(() => M.restore(ctx.skinUndo), () => { ctx.skinSaving = false; ctx.skinUndo = null; ctx.render(); }, e => { ctx.skinSaving = false; ctx.toast?.('!', e.message || 'Could not restore skin', 3000); }); return true; }
    if (el.closest('[data-skin-undo-dismiss]')) { ctx.skinUndo = null; ctx.render(); return true; }
    const dismiss = el.closest('[data-skin-preview-dismiss]');
    if (dismiss) { M.dismissPreview(dismiss.dataset.skinPreviewDismiss); ctx.render(); return true; }
    const preview = el.closest('[data-skin-preview]');
    if (preview) {
      const saved = M.previews.find(s => s.id === preview.dataset.skinPreview); if (!saved) return true;
      ctx.skinDraft = { name: saved.name, items: [], tweaks: {}, previewId: saved.id, recoveryTweaks: { ...saved.tweaks } };
      void draftDefaults(ctx, saved.base); return true;
    }
    if (el.closest('[data-newskin]')) {
      ctx.skinDraft = { name: '', items: [], tweaks: {} };
      void draftDefaults(ctx, S.current);
      ctx.root.querySelector('[data-skin-name]')?.focus(); return true;
    }
    if (ctx.skinDraft) {
      const draft = ctx.skinDraft, tweak = el.closest('[data-draft-tweak]'), colour = el.closest('[data-skinpick]');
      if (draft.saving) return true;
      if (tweak) { const id = tweak.dataset.draftTweak; draft.tweaks[id] = !draft.tweaks[id]; ctx.render(); return true; }
      if (colour) { draft.base = colour.dataset.skinpick; ctx.render(); return true; }
      if (el.closest('[data-skinretry]')) { void draftDefaults(ctx, draft.base); return true; }
      if (el.closest('[data-skin-create]') && !draft.loading && !draft.error) {
        if (draft.saving) return true; draft.saving = true; ctx.render();
        const snapshot = { name: draft.name, base: draft.base, tweaks: { ...draft.tweaks } };
        skinAction(() => M.create(snapshot), () => { if (draft.previewId) M.dismissPreview(draft.previewId); draft.saving = false; if (ctx.skinDraft !== draft) return; ctx.skinDraft = null; ctx.render(); ctx.root.querySelector('[data-ownskin][aria-pressed="true"]')?.focus(); }, e => { draft.saving = false; draft.validation = e.message; if (ctx.skinDraft === draft) ctx.render(); }); return true;
      }
      return false;
    }
    const remove = el.closest('[data-ownskin-remove]');
    if (remove) { ctx.skinRemove = M.recipes.find(s => s.id === remove.dataset.ownskinRemove); ctx.render(); ctx.root.querySelector('[data-skin-remove-cancel]')?.focus(); return true; }
    const own = el.closest('[data-ownskin]');
    // Tapping the skin you wear takes it off (back to plain color + tweaks); any other one puts it on.
    if (own) { skinAction(() => M.active?.id === own.dataset.ownskin ? M.leave() : M.wear(own.dataset.ownskin), () => ctx.render(), e => ctx.toast?.('!', e.message, 3000)); return true; }
    const view = el.closest('[data-desktop-view]');
    if (view) { void window.WosExperience.chooseDesktopView(view.dataset.desktopView).catch(e => ctx.toast?.('!', e.message, 2400)); return true; }
    const tweak = el.closest('[data-tweak-toggle]');
    if (tweak) { void window.WosExperience.toggle(tweak.dataset.tweakToggle).catch(e => ctx.toast?.('!', e.message, 2400)); return true; }
    const my = el.closest('[data-myskin]');
    if (my) { mySkinAction(ctx, my.dataset.myskin, event); return true; }
    const family = el.closest('[data-skinfamily]');
    if (family) { skinAction(() => M?.active ? M.leave() : undefined, () => { S.setFamily(family.dataset.skinfamily); void window.WosExperience?.chooseSkin?.(); for (const m of mounts) m.render(); ctx.haptic?.(8); }, e => ctx.toast?.('!', e.message, 3000)); return true; }
    const b = el.closest('[data-skinpick]'); if (!b) return false;
    skinAction(() => M?.active ? M.update({ base: b.dataset.skinpick }) : S.set(b.dataset.skinpick), () => {
      void window.WosExperience?.chooseSkin?.();
      for (const m of mounts) m.render(); ctx.haptic?.(8);
    }, e => ctx.toast?.('!', e.message, 3000)); return true;
  } });
  // Window opacity: one slider for the glass behind every window (Chats and every app). Per device, like the skin.
  const glassPct = S => Math.round((S.glass ?? S.skinGlass) * 100);
  const glassNote = S => S.glass == null ? 'Skin default · every window and app' : 'Every window and app';
  register({ id: 'window-glass', aliases: ['window-opacity', 'opacity'], available: () => typeof window.WosSkin?.setGlass === 'function', html() {
    const S = window.WosSkin, r = S.glassRange, pct = glassPct(S);
    return `<div class="st-group wg-section"><h4>Windows</h4><div class="st-row static wg-row"><span class="st-tx"><b id="wg-label">Window opacity</b><small data-wg-note>${glassNote(S)}</small></span><output data-wg-val for="wg-range">${pct}%</output></div><input id="wg-range" class="wg-range" type="range" min="${Math.round(r.min * 100)}" max="${Math.round(r.max * 100)}" step="1" value="${pct}" data-wg-range aria-labelledby="wg-label" aria-valuetext="${pct}%">${S.glass == null ? '' : '<button type="button" class="wg-reset" data-wg-reset>Use skin default</button>'}</div>`;
  }, input(ctx, el) {
    if (!el.matches('[data-wg-range]')) return;
    const S = window.WosSkin, n = S.setGlass(Number(el.value) / 100), g = el.closest('.wg-section');
    el.setAttribute('aria-valuetext', `${Math.round(n * 100)}%`);
    const out = g?.querySelector('[data-wg-val]'); if (out) out.textContent = `${Math.round(n * 100)}%`;
    const note = g?.querySelector('[data-wg-note]'); if (note) note.textContent = glassNote(S);
    if (g && !g.querySelector('[data-wg-reset]')) el.insertAdjacentHTML('afterend', '<button type="button" class="wg-reset" data-wg-reset>Use skin default</button>');
  }, act(ctx, el) {
    if (!el.closest('[data-wg-reset]')) return false;
    window.WosSkin.setGlass(null); ctx.render(); ctx.root.querySelector('[data-wg-range]')?.focus(); return true;
  } });
  /* Features on for everyone (catalog `defaults`) are plain settings where they act: one switch each, no author. */
  const settingRow = id => { const t = window.WosExperience?.state.tweaks.find(x => x.id === id && x.builtin); return t ? tweakSwitches([t], 'data-tweak-toggle', window.WosExperience.state.busy) : ''; };
  const settingAct = (ctx, el) => { const b = el.closest('[data-tweak-toggle]'); if (!b) return false; void window.WosExperience.toggle(b.dataset.tweakToggle).catch(e => ctx.toast?.('!', e.message, 2400)); return true; };
  register({ id: 'home-network', page: 'appearance', html: () => { const r = settingRow('wizard/machines-home'); return r ? `<div class="st-group"><h4>Home</h4>${r}</div>` : ''; }, act: settingAct });
  register({ id: 'skin-frame', available: () => !!window.WosSkin, html() {
    return '<div class="st-group sf-section"><details class="st-advanced"><summary>Advanced</summary><button class="sf-import" data-skinimport>Import skin JSON</button><input type="file" data-skinfile accept="application/json,.json" hidden><p data-skinimport-status role="status"></p></details></div>';
  }, act(ctx, el) {
    if (!el.closest('[data-skinimport]')) return false;
    ctx.root.querySelector('[data-skinfile]').click(); return true;
  } });
  // Wizard Shell: Everywhere is the shell's floating orb (device.orb). One switch; nothing the shell can't do.
  function shellAssistant() {
    const O = shellOrb(); if (!O) return '';
    const s = O.state, on = !!s.on;
    const sub = on ? (s.permitted ? 'On · tap to talk, hold to pause recording · hides while Wizard is open' : 'Needs “Display over other apps”') : s.permitted ? 'A floating Wizard button over your other apps. Tap to talk, drag to move.' : 'A floating Wizard button over your other apps. Android asks to let Wizard display over other apps.';
    return `<div class="st-group"><h4>Assistant</h4><button class="st-row wz-row" data-st="everywhere" role="switch" aria-checked="${on}"><span class="st-tx"><b>Wizard Everywhere</b><small>${esc(sub)}</small></span><span class="sw ${on ? 'on' : ''}"><i></i></span></button></div>`;
  }
  register({ id: 'assistant', aliases: ['everywhere', 'orb', 'floating-orb'], available: android, html(ctx) {
    if (shell()) return shellAssistant();
    const N = native(), evNative = typeof N?.setEverywhere === 'function'; let ev = null;
    try { ev = evNative ? JSON.parse(N.everywhere()) : null; } catch (_) {}
    const evOn = !!ev?.enabled;
    const evSub = !N ? 'Works in the Wizard OS Android app' : !evNative ? 'Update the Wizard OS app (0.5.0) to turn this on' : evOn ? (ev.overlay ? (ev.hold ? 'On · tap to talk · hold for Select text, Translate and Hide' : 'On · floats over other apps, hides while Wizard OS is open') : 'Needs “Display over other apps”') : 'A floating Wizard button over your other apps. Tap to talk, drag to move.';
    return `<div class="st-group"><h4>Assistant</h4><button class="st-row wz-row" data-st="everywhere" role="switch" aria-checked="${evOn}" ${evNative ? '' : 'disabled'}><span class="st-tx"><b>Wizard Everywhere</b><small>${esc(evSub)}</small></span><span class="sw ${evOn ? 'on' : ''}"><i></i></span></button>${evNative && evOn && typeof N.voiceTypingSettings === 'function' ? row('typing', 'Voice typing & screenshots', ev.keyboard ? 'On · with a keyboard open the orb types what you say' : 'Off · tap to set up: the orb types into any app and attaches screenshots') : ''}<button class="st-row wz-row" data-st="side" ${N ? '' : 'disabled'}><span class="st-tx"><b>Side button</b><small>${esc(!N ? 'Works in the Wizard OS Android app' : ctx.sideReady?.() ? 'On · hold the side button to talk' : 'Hold the side button to talk, even when locked')}</small></span><span class="st-go">›</span></button></div>`;
  }, act(ctx, el) {
    const st = el.closest('[data-st]')?.dataset.st, N = native();
    if (shell()) { const O = shellOrb(); if (st !== 'everywhere' || !O) return false; O.toggle().then(() => ctx.render()); ctx.haptic?.(8); return true; }
    if (st === 'typing' && N?.voiceTypingSettings) { N.voiceTypingSettings(); return true; }
    if (st === 'everywhere' && N?.setEverywhere) { let on = false; try { on = JSON.parse(N.everywhere()).enabled; } catch (_) {} N.setEverywhere(!on); setTimeout(ctx.render, 250); ctx.haptic?.(8); return true; }
    if (st === 'side' && N) { ctx.openSub('side'); return true; } return false;
  } });
  /* ---------------- Phones & devices ----------------
   * The owner's phones over Tailscale. Connecting is the shared phone-connect component (web/core/phone-connect.js),
   * the same one Setup's phone screen and Mac onboarding show, so every place says the same thing, including when
   * this Wizard can't do device access yet. Below it: the phones on the owner's tailnet and turning device access off
   * (the same reset as Setup's Disconnect, behind a confirmation sheet). A phone is a device on the owner's Tailscale
   * account, so removing one happens in Tailscale's admin; the page links there. Hidden only for a non-owner. */
  const PH = { pc: null, wanted: false, confirm: false, error: '', summary: '' };
  const phoneShell = () => document.documentElement.dataset.shell === 'phone' ? 'phone' : 'desktop';
  function phones() {
    if (PH.pc || typeof window.WizPhoneConnect?.create !== 'function' || typeof fetch !== 'function') return PH.pc;
    PH.pc = window.WizPhoneConnect.create({
      layout: phoneShell(), qrScript: 'setup/vendor/qrcode.js',
      active: () => PH.wanted && document.visibilityState === 'visible',
      // The connection pill's evidence: Wizard's live reads are failing from this device (not a missing permission).
      offline: () => { const L = window.WizLive; return !!L && !!L.error && L.error !== 'access'; },
      // Settings redraws only when what it shows itself changes (the list entry, phones, Turn off); the component
      // redraws its own part.
      onChange: pc => {
        const v = pc.view, key = JSON.stringify([pc.status, pc.lost, pc.connecting, v?.step, v?.phones]);
        if (key !== PH.summary) { PH.summary = key; for (const m of mounts) m.render(); }
      },
    });
    // When the connection drops or comes back, re-check at once instead of showing the last answer as current.
    try { window.WizLive?.onChange?.(() => { const off = !!window.WizLive.error && window.WizLive.error !== 'access'; if (off !== PH.off) { PH.off = off; PH.pc?.refresh(); } }); } catch (e) {}
    return PH.pc;
  }
  function phonesAvailable() { const pc = phones(); if (!pc) return false; pc.refresh(15000); return pc.status !== 'denied'; }
  const osName = os => ({ ios: 'iPhone', android: 'Android', ipados: 'iPad' })[String(os || '').toLowerCase()] || 'Device';
  function closePhonesSheet(ctx) { PH.confirm = false; PH.error = ''; ctx.render(); ctx.root.querySelector('[data-st="phones-off"]')?.focus(); }
  register({ id: 'phones', page: 'phones', aliases: ['phones', 'devices', 'phone-access'], available: phonesAvailable, html() {
    const pc = phones(); if (!pc) return '';
    const v = pc.view, busy = pc.busy;
    let h = '<div class="st-group"><h4>Device access</h4><div class="st-pc" data-phone-connect></div></div>';
    if (pc.on && !pc.connecting) {
      h += '<div class="st-group"><h4>Your devices</h4>';
      h += v.phones.length ? v.phones.map(p => `<div class="st-row wz-row static"><span class="st-tx wz-main"><b>${esc(p.name)}</b><small>${esc(osName(p.os))} · ${p.online ? 'Online' : 'Offline'}</small></span></div>`).join('')
        : '<div class="st-empty">No device on your Tailscale account yet.</div>';
      h += '<a class="st-row" data-st="phones-manage" href="https://login.tailscale.com/admin/machines" target="_blank" rel="noopener noreferrer"><span class="st-tx"><b>Remove a device</b><small>Devices are listed on your Tailscale account. Remove one there and it can’t reach Wizard any more.</small></span><span class="st-go">↗</span></a>';
      h += '</div>';
    }
    if (!pc.connecting && (pc.on || pc.settingUp)) h += '<div class="st-group"><h4>Turn off</h4>' + row('phones-off', 'Turn off device access', 'Disconnects this Wizard from Tailscale. Your chats stay here.') + '</div>';
    if (PH.confirm) h += `<div class="st-confirm-scrim"><section class="st-confirm" role="alertdialog" aria-modal="true" aria-labelledby="phones-off-title" aria-describedby="phones-off-text"><h3 id="phones-off-title">Turn off device access?</h3><p id="phones-off-text">Every device loses access to this Wizard until you connect one again. Your chats stay here.</p>${PH.error ? `<p class="sc-error" role="alert">${esc(PH.error)}</p>` : ''}<div class="st-actions"><button data-st="phones-off-cancel" ${busy ? 'disabled' : ''}>Cancel</button><button data-st="phones-off-confirm" ${busy ? 'disabled' : ''}>${busy ? 'Turning off…' : 'Turn off'}</button></div></section></div>`;
    return h;
  }, painted(ctx, section) {
    const host = section?.querySelector('[data-phone-connect]'); if (host) phones()?.attach(host);
  }, deferRefresh: () => PH.confirm,
  enter() { PH.wanted = true; },
  leave() { PH.wanted = false; if (!PH.pc?.busy) { PH.confirm = false; PH.error = ''; } },
  back(ctx) { if (PH.pc?.back()) return true; if (!PH.confirm) return false; if (!PH.pc?.busy) closePhonesSheet(ctx); return true; },
  act(ctx, el) {
    const st = el.closest('[data-st]')?.dataset.st;
    if (st === 'phones-manage') return false; // the link leaves on its own
    if (st === 'phones-off') { PH.confirm = true; PH.error = ''; ctx.render(); ctx.root.querySelector('[data-st="phones-off-cancel"]')?.focus(); return true; }
    if (st === 'phones-off-cancel') { if (!PH.pc?.busy) closePhonesSheet(ctx); return true; }
    if (st === 'phones-off-confirm' && PH.pc && !PH.pc.busy) {
      const done = PH.pc.reset();
      ctx.render(); // the sheet shows "Turning off…"
      done.then(ok => {
        if (ok) { PH.confirm = false; ctx.toast?.('✓', 'Device access is off', 2200); }
        else PH.error = 'Couldn’t turn off device access. Try again.';
        ctx.render();
      });
      return true;
    }
    return false;
  } });
  register({ id: 'server', available: () => typeof native()?.changeServer === 'function', html() {
    return `<div class="st-group"><h4>Connection</h4>${row('change-server', 'Change Wizard', 'Scan another box QR or enter its address')}</div>`;
  }, act(ctx, el) {
    if (el.closest('[data-st]')?.dataset.st !== 'change-server') return false;
    native().changeServer(); return true;
  } });
  register({ id: 'voice', html: () => window.WizCore.voiceStatus?.card() || '' });
  register({ id: 'microphone', aliases: ['mic'], available: () => !!window.WosMic?.available(), html: () => window.WosMic?.html() || '', act: (ctx, el) => window.WosMic?.act(el, ctx) });
  register({ id: 'cancelled', html: () => window.WosCancelled?.html() || '', act: (ctx, el) => window.WosCancelled?.act(el) });
  register({ id: 'selection', html: () => window.WosSelMenu?.html() || '', act: (ctx, el) => window.WosSelMenu?.act(el) });
  // Desktop bar: one mic by default; the other three voice buttons live in its menu and on their keys, and this puts
  // them back in the bar (James, 31 Oct 2026: fewer icons on the right, nothing new in their place).
  // Phone shell only (core/orb-switcher.js is not loaded on the desktop): the row opens the Orb switcher sheet.
  register({ id: 'orb-switcher', page: 'phone', aliases: ['orb-switcher', 'orb-radial'], available: () => !!window.WosOrbSwitcher?.available,
    html: () => window.WosOrbSwitcher.settingsRow(),
    act: (ctx, el) => { if (!el.closest('[data-orbsw-open]')) return false; window.WosOrbSwitcher.openSettings(); return true; } });
  register({ id: 'bar-voice-buttons', page: 'voice', available: ctx => !!ctx?.barMics?.(),
    html: ctx => { const on = !!ctx.barMics().get(), k = /Mac|iPhone|iPad/.test(navigator.platform || navigator.userAgent || '') ? '⌥' : 'Alt+';
      return `<div class="st-group" data-bar-mics><h4>Top bar</h4><button class="st-row" data-bar-mics-set role="switch" aria-checked="${on}"><span class="st-tx"><b>Show every voice button</b><small>${esc(`New voice chat, Dictate and Tell the computer beside the mic. Off, they are in the mic’s menu (right-click or hold) and on ${k}V, ${k}D and ${k}C.`)}</small></span><span class="sw ${on ? 'on' : ''}"><i></i></span></button></div>`; },
    act: (ctx, el) => { const m = ctx.barMics?.(); if (!m || !el.closest('[data-bar-mics-set]')) return false; m.set(!m.get()); ctx.render?.(); return true; } });
  // Moved from the phone adapter: one About renderer, native data/actions only in WosDevice.
  function deviceAboutHtml() {
    const d = window.WosDevice?.settingsState?.(); if (!d) return '';
    return `<div class="st-row static"><span class="st-tx"><b>Recording</b><small>Keeps going with the screen off or in another app · Stop and Send in the notification</small></span></div>
      <div class="st-row static"><span class="st-tx"><b>Reply notifications</b><small>${d.notificationsAllowed ? `On · when ${esc(window.WizConfig.agent())} answers a chat you sent from here · clear once you read the thread` : 'Off · allow notifications for Wizard OS in Android settings'}</small></span></div>
      <button class="st-row" data-dvupd data-settings-version="phone"><span class="st-tx"><b>Phone app (Android) ${esc(d.installed || '· version unavailable')}</b><small>${esc(d.updateDescription)}</small></span><span class="st-go">›</span></button>`;
  }
  register({ id: 'wizard', html(ctx) {
    const status = ctx.live?.ok ? 'Connected' : ctx.live?.error === 'access' ? 'Sign-in needed' : 'Connecting…';
    // No separate "Check for updates": the shell checks every minute and the update card offers Reload.
    const observed = window.WizWebUpdate?.firstObservedVersion || '';
    const device = deviceAboutHtml();
    return `<div class="st-group"><h4>Wizard</h4><div class="st-row static"><span class="st-tx"><b>${esc(status)}</b><small>${esc(native()?.platform?.() || 'Web')} · ${esc(location.host)}</small></span></div><p class="st-hint">The interface and your Wizard’s server update separately.${device ? ' The Android phone app updates separately too. Their version numbers are not comparable.' : ''}</p>${device}<details data-settings-technical><summary>Technical details</summary><div class="st-row static" data-settings-version="interface"><span class="st-tx"><b>Interface revision at first check</b><small title="${esc(observed)}">${esc(observed ? observed.slice(0, 8) : 'Not available yet')}</small></span></div><p class="st-hint" data-settings-observed-full style="overflow-wrap:anywhere">${esc(observed || 'Not available yet')}</p><p class="st-hint">The first successful version-file check, not a stamp of the code loaded in this page.</p></details>${row('help', 'Gestures & help', ctx.helpSub)}</div>`;
  }, act(ctx, el) { const st = el.closest('[data-st]')?.dataset.st; if (!['files', 'help'].includes(st)) return false; ctx.openSub(st); return true; } });
  // Settings › Resources shows the Home bars themselves (core/resources.js draws them into this host and keeps them
  // live); tapping a bar opens the same detail sheet as on Home (devices, health, AI accounts with reset times).
  register({ id: 'usage', aliases: ['usage', 'resources'], html: () => window.WosResources?.bars ? '<div class="st-group st-res" data-st-resources></div>' : window.WosUsage?.html() || '',
    painted(ctx, section) { const host = section?.querySelector?.('[data-st-resources]'); if (host) window.WosResources.bars(host); },
    act(ctx, el) { if (!el.closest('[data-usage-refresh]')) return false; window.WosUsage?.load(true).then(ctx.paintUsage); ctx.paintUsage(); return true; } });
  // A shell chooses the composer; common code owns preservation before consuming an unsent record.
  function moveDraft({ chats, wid, item, outbox, toast }) {
    if (item.audio || item.audioFile || item.hasAudio || item.body || item.state === 'unconfirmed' || item.state === 'sending' || outbox.quarantined?.(item.id)) {
      toast('!', 'Original kept · retry it or open its thread', 2400); return false;
    }
    if (item.model) {
      let selected; try { selected = window.WosModels?.snapshot(item.kind === 'reply' ? item.sessionId : '', null, item.agent || ''); } catch (_) {}
      if (!selected || selected.model !== item.model || (item.provider && selected.provider !== item.provider)) {
        toast('!', 'Original model route kept · select that model before editing', 2600); return false;
      }
    }
    const draft = chats.ch(wid);
    if (draft.draft || draft.files?.length) { toast('!', 'Existing draft kept · finish it before editing this unsent message', 2600); return false; }
    const text = item.text || item.typed || '', files = item.files || [];
    chats.setDraft(wid, text, files);
    const saved = window.WosChat?.drafts.get(chats.ch(wid).draftFor);
    if (!saved || saved.text !== text || files.length !== saved.files.length || files.some((f, i) => f.id !== saved.files[i]?.id)) {
      toast('!', 'Draft could not be saved · original unsent message kept', 2600); return false;
    }
    outbox.remove(item.id); return true;
  }
  // The frame is kept while the page is open: background refreshes never reload it under the owner's hand.
  register({ id: 'connections', page: 'connections', aliases: ['connections', 'app-connections'], available: () => connectionsAvailable(),
    deferRefresh: ctx => !!ctx.root?.querySelector?.('[data-st-connections] iframe'),
    // Back steps inside the view first, the way an app window does: its open pop-up (the kit's canonical
    // __wizardCloseOverlay hook), then the map back to the list; only then does Settings leave the page.
    back(ctx) {
      const f = ctx.root?.querySelector?.('[data-st-connections] iframe');
      try {
        const w = f?.contentWindow; if (!w || w.location.origin !== location.origin) return false;
        if (typeof w.__wizardCloseOverlay === 'function' && w.__wizardCloseOverlay() === true) return true;
        const list = w.document.querySelector('[data-cm-seelist]');
        if (list && list.getClientRects().length) { list.click(); return true; }
      } catch (_) {}
      return false;
    },
    // ?embed=settings: the view drops its own title, sheet and canvas and takes the shell's skin (Appearance v1), so the
    // page head is the one title and the content sits straight on the Settings page, with no box around it.
    html: () => `<div class="st-embed" data-st-connections><iframe src="${esc(CONNECTIONS)}?embed=settings" title="Connections"></iframe></div>` });
  register({ id: 'notifications-in-chats', page: 'chats', html: () => { const r = settingRow('wizard/unified-inbox'); return r ? `<div class="st-group"><h4>Notifications</h4>${r}</div>` : ''; }, act: settingAct });
  /* Settings › Notifications: one choice per app, Badge or Chats, never both (Miguel, 1 Nov 2026). Lists
   * Notifications and every installed app that has an inbox feed (only those can put items in Chats); every other app
   * shows a badge. Saved on this device. Chats needs Notifications in Chats (Settings › Chats) on. */
  // The picker itself is WosBell.picker: the same one sits on every notification opened in Chats.
  const routeSeg = (r, off) => window.WosBell.picker(r.id, { name: r.name, off });
  register({ id: 'notification-routing', page: 'notifications', aliases: ['notifications', 'notification-routing'],
    subtitle: () => { const at = window.WosBell?.attention?.(); if (at?.n) return `${at.n} ${at.short}`; const n = (window.WosBell?.routes?.() || []).filter(r => r.chats).length; return n ? `${n} in Chats` : ''; },
    // The routing part hears the page open and close (it may treat opening as having seen what it counts).
    enter: () => { window.WosBell?.discover?.(); window.WosBell?.entered?.(); },
    leave: () => { window.WosBell?.left?.(); },
    html() {
      const B = window.WosBell, list = B?.routes?.() || [], off = !B?.chatsAvailable;
      if (!B?.routes) return '';
      void B.discover?.();
      // Every word below comes from the routing part (WosBell.describe / intro / groups); stock = Badge | Chats.
      const row = r => `<div class="st-nr" data-notify-app="${esc(r.id)}"><span class="st-tx"><b>${esc(r.name)}</b><small>${esc(B.describe ? B.describe(r, off) : '')}</small></span>${routeSeg(r, off)}</div>`;
      const rows = list.map(row).join('');
      const ago = t => { const m = Math.max(0, Math.round((Date.now() / 1000 - t) / 60)); return m < 60 ? `${m || 1}m` : m < 1440 ? `${Math.round(m / 60)}h` : `${Math.round(m / 1440)}d`; };
      const listHtml = (l, key) => l?.items.length ? `<h4>${esc(l.title)}</h4><ul class="st-${key}-list">${l.items.map(i => `<li class="${i.fresh ? 'new' : ''}${i.needs ? ' needs' : ''}"><span class="st-tx"><b>${esc(i.title)}</b><small>${esc(i.text)}</small></span><time>${esc(ago(i.time))}</time></li>`).join('')}</ul>` : '';
      const more = (B.groups?.() || []).filter(g => g.rows.length).map(g => `<div class="st-group st-${g.key}"><h4>${esc(g.title)}</h4>${g.hint ? `<p class="st-hint">${esc(g.hint)}</p>` : ''}${g.rows.map(row).join('')}${listHtml(g.list, g.key)}</div>`).join('');
      const intro = B.intro?.(), lead = intro ? intro.lead.map(([t, b]) => b ? `<b>${esc(t)}</b>` : esc(t)).join('') : '';
      const note = off ? `<p class="st-hint">Chats isn’t showing notifications on this device, so every app shows a badge. Turn on Notifications in Chats to choose Chats:</p>${settingRow('wizard/unified-inbox')}` : '';
      return `<div class="st-group"><p class="st-hint">${lead}</p>${note}${rows || '<p class="st-hint">No apps send notifications yet.</p>'}<p class="st-hint">${esc(intro?.foot || '')}</p></div>${more}`;
    },
    act(ctx, el) {
      const b = el.closest('[data-notify-route]');
      if (!b) return settingAct(ctx, el);
      if (b.disabled) return true;
      window.WosBell?.setRoute?.(b.dataset.notifyRoute, b.dataset.notifyTo);
      ctx.render?.(); ctx.root?.querySelector?.(`[data-notify-route="${CSS.escape(b.dataset.notifyRoute)}"][data-notify-to="${CSS.escape(b.dataset.notifyTo)}"]`)?.focus?.({ preventScroll: true });
      return true;
    } });
  register({ id: 'chats-default', page: 'chats', aliases: ['chats-default'], html(ctx) {
    const host = chatsHost(), apps = host?.installed() || [{ id: 'wizard-chats' }], current = host?.defaultId() || 'wizard-chats';
    apps.sort((a, b) => (b.id === 'wizard-chats') - (a.id === 'wizard-chats'));
    return `<div class="st-group"><h4>Default Chats</h4><div class="st-chats-options" role="radiogroup" aria-label="Default Chats">${apps.map(a => `<button class="st-row wz-row" role="radio" aria-checked="${a.id === current}" data-chats-choice="${esc(a.id)}" ${ctx.chatsBusy ? 'disabled' : ''}><span aria-hidden="true">${a.id === current ? '◉' : '○'}</span><span class="st-tx"><b>${esc(a.id === 'wizard-chats' ? 'Wizard Chats (built in)' : a.name)}</b></span></button>`).join('')}</div>${apps.length === 1 ? '<div class="st-store-hint">Install another Chats from the <button data-chats-store>Store</button> to switch</div>' : ''}</div>`;
  } });
  function mount(root, adapter) {
    root.classList.add('st-root'); root.dataset.settingsRoot = '';
    const ctx = { ...adapter, root }, api = { render, focus, back, destroy, dispatch, context: ctx, get page() { return page; } };
    let skinImportMessage = '', page = '', confirm = null, wanted = '';
    const desktop = adapter.shell === 'desktop';
    const effectivePage = () => page || (desktop ? (filled('overview')() ? 'overview' : 'appearance') : '');
    ctx.render = () => render(true);
    ctx.paintUsage = () => { const g = root.querySelector('[data-usage]'); if (g) g.outerHTML = window.WosUsage.html(); paintSubtitles(); };
    function paintSubtitles() {
      root.querySelectorAll?.('[data-st-subtitle]').forEach(el => { el.textContent = subtitle(el.dataset.stSubtitle, ctx); });
    }
    function render(force = false) {
      // Background polls must not replace an active form under a keystroke.
      // Explicit feature actions render via ctx.render; skin changes use tokens.
      if (force !== true && [...features.values()].some(f => pageOf(f) === effectivePage() && f.deferRefresh?.(ctx))) return;
      if (adapter.visible && !adapter.visible()) return;
      const top = root.scrollTop, paneTop = root.querySelector('.st-page')?.scrollTop || 0, active = root.contains(document.activeElement) ? document.activeElement : null;
      const attrs = active ? [...active.attributes].filter(a => a.name.startsWith('data-')) : [];
      const record = active?.closest('[data-ubid]')?.dataset.ubid;
      const selection = active && typeof active.selectionStart === 'number' ? [active.selectionStart, active.selectionEnd] : null;
      const pages = PAGES.filter(p => !p.available || p.available(ctx));
      // A page whose availability is still being checked (a cold deep link) opens once it turns out available.
      if (wanted && !page && pages.some(p => p.id === wanted)) page = wanted;
      if (wanted && (page === wanted || !PAGES.find(p => p.id === wanted)?.pending?.())) wanted = '';
      if (page && !pages.some(p => p.id === page)) { if (PAGES.find(p => p.id === page)?.pending?.()) wanted = page; page = ''; }
      const selected = effectivePage();
      const heading = PAGES.find(p => p.id === selected)?.title || '';
      const items = attention(ctx);
      const attentionHtml = items.length ? `<div class="st-attention" aria-label="Needs attention">${items.map(i => `<button data-st-attention="${esc(i.feature)}">${esc(i.title)}<span aria-hidden="true">›</span></button>`).join('')}</div>` : '';
      // Desktop shows About & updates beside the list with the card on it, so the list does not repeat it.
      const card = desktop && selected === 'about' ? '' : cardHtml();
      const nav = pages.map((p, i) => (p.group && p.group !== pages[i - 1]?.group && pages.some(q => q.group && q.group !== p.group) ? `<h4 class="st-navgroup">${esc(p.group)}</h4>` : '') + `<button class="st-category" data-st-page="${p.id}" aria-current="${p.id === selected ? 'page' : 'false'}"><span class="st-tx"><b>${p.title}</b></span><span class="st-val" data-st-subtitle="${p.id}">${esc(subtitle(p.id, ctx))}</span><span class="st-go" aria-hidden="true">›</span></button>`).join('');
      const fs = [...features.values()].filter(f => pageOf(f) === selected && (!ctx.skinDraft || f.id === 'look') && (!f.available || f.available(ctx)));
      // About & updates leads with the update card and its choices; the connection rows follow.
      if (selected === 'about') fs.sort((x, y) => (y.id === 'updates') - (x.id === 'updates'));
      const content = fs.map(f => `<section data-settings-feature="${esc(f.id)}">${f.html(ctx)}</section>`).join('');
      root.dataset.settingsPage = page;
      root.dataset.settingsNested = ctx.skinDraft ? 'true' : 'false';
      root.innerHTML = `<div class="st-inner ${desktop ? 'st-desktop' : 'st-phone'} ${page ? 'st-in-page' : ''}"><div class="st-index"><h3 class="st-title" tabindex="-1">Settings</h3>${card}${attentionHtml}<nav aria-label="Settings categories">${nav}</nav></div><div class="st-page" ${selected ? '' : 'hidden'}><header class="st-page-head"><button data-st-back aria-label="${ctx.skinDraft ? 'Back to Look' : 'Back to Settings'}">‹</button><h3 tabindex="-1">${ctx.skinDraft ? 'New skin' : heading}</h3></header>${content}</div></div>${confirm ? `<div class="st-confirm-scrim"><section class="st-confirm" role="alertdialog" aria-modal="true" aria-labelledby="st-confirm-title"><h3 id="st-confirm-title">Use ${esc(chatsName(confirm.id))} for all your chats?</h3><p>You can switch back here any time.</p><div class="st-actions"><button data-chats-cancel ${ctx.chatsBusy ? 'disabled' : ''}>Cancel</button><button data-chats-confirm ${ctx.chatsBusy ? 'disabled' : ''}>${ctx.chatsBusy ? 'Switching…' : 'Use ' + esc(chatsName(confirm.id))}</button></div></section></div>` : ''}`;
      for (const f of fs) if (f.painted) { try { f.painted(ctx, root.querySelector(`[data-settings-feature="${CSS.escape(f.id)}"]`)); } catch (e) { console.error(e); } }
      root.scrollTop = top;
      const pane = root.querySelector('.st-page'); if (pane) pane.scrollTop = paneTop;
      const importStatus = root.querySelector('[data-skinimport-status]'); if (importStatus) importStatus.textContent = skinImportMessage;
      if (attrs.length) { const scope = record ? root.querySelector(`[data-ubid="${CSS.escape(record)}"]`) : root; const sel = attrs.map(a => `[${a.name}="${CSS.escape(a.value)}"]`).join(''); const target = scope?.querySelector(sel); target?.focus({ preventScroll: true }); if (target && selection) target.setSelectionRange(...selection); }
      const U = window.WosUsage;
      if (U && !U.loading && (!U.snap || Date.now() - U.at > 60000)) U.load().then(ctx.paintUsage);
    }
    function focus(id) {
      for (const f of features.values()) if (pageOf(f) === effectivePage()) f.leave?.(ctx);
      const f = features.get(id) || [...features.values()].find(f => f.aliases?.includes(id));
      wanted = '';
      page = f ? pageOf(f) : featurePages[id] || (id === 'updates' ? 'about' : PAGES.some(p => p.id === id) ? id : '');
      for (const f of features.values()) if (pageOf(f) === effectivePage()) f.enter?.(ctx);
      confirm = null; render(); root.scrollTop = 0;
      const pane = root.querySelector('.st-page'); if (pane) pane.scrollTop = 0;
      const g = id ? root.querySelector(`[data-settings-feature="${CSS.escape(f?.id || id)}"]`) : null;
      g?.scrollIntoView?.({ block: 'nearest' });
      (g?.querySelector('button:not(:disabled)') || root.querySelector(page ? '.st-page-head h3' : '.st-title'))?.focus({ preventScroll: true });
    }
    function back() {
      for (const f of features.values()) if (pageOf(f) === effectivePage() && f.back?.(ctx)) return true;
      if (confirm) { if (!ctx.chatsBusy) { confirm = null; render(); root.querySelector('[data-chats-choice][aria-checked="true"]')?.focus(); } return true; }
      if (!page) return false;
      const previous = page; focus(); root.querySelector(`[data-st-page="${previous}"]`)?.focus({ preventScroll: true }); return true;
    }
    function openStore(id) { ctx.openStore?.(id); }
    function askChats(id) {
      if (ctx.chatsBusy || id === chatsHost()?.defaultId() || !chatsHost()?.installed().some(a => a.id === id)) return;
      confirm = { id }; render(); root.querySelector('[data-chats-cancel]')?.focus();
    }
    async function useChats() {
      if (!confirm || ctx.chatsBusy) return;
      const id = confirm.id; ctx.chatsBusy = true; render();
      try {
        const url = '/wizard-os-home/store-install/_slots/chats';
        const response = await fetch(url, { method: 'POST', credentials: 'same-origin', headers: { 'Content-Type': 'application/json', 'X-Wizard-Store': '1' }, body: JSON.stringify({ default: id }) });
        if (!response.ok) { let message = 'Could not change Chats'; try { message = (await response.json()).error || message; } catch (_) {} throw Error(message); }
        const check = await fetch(url, { credentials: 'same-origin', cache: 'no-store' });
        if (!check.ok || (await check.json()).default !== id) throw Error('The App Manager has not confirmed this Chats choice. Try again.');
        await window.WizCore.refreshApps();
        if (chatsHost()?.defaultId() !== id) throw Error('The app list has not confirmed this Chats choice. Try again.');
        ctx.chatsChanged?.(id);
        ctx.toast?.('✓', 'Using ' + chatsName(id), 2200);
      } catch (error) { ctx.toast?.('!', String(error.message || error), 3200); }
      finally { ctx.chatsBusy = false; confirm = null; render(); root.querySelector('[data-chats-choice][aria-checked="true"]')?.focus({ preventScroll: true }); }
    }
    function dispatch(el, event) {
      if (el.classList?.contains('st-confirm-scrim')) return back();
      if (el.closest('[data-chats-confirm]')) { useChats(); return true; }
      if (el.closest('[data-chats-cancel]')) { back(); return true; }
      if (confirm) return false;
      const nav = el.closest('[data-st-page]'), att = el.closest('[data-st-attention]');
      if (nav || att) { focus(nav ? nav.dataset.stPage : att.dataset.stAttention); return true; }
      if (el.closest('[data-st-back]')) return back();
      const choose = el.closest('[data-chats-choice]'); if (choose) { askChats(choose.dataset.chatsChoice); return true; }
      if (el.closest('[data-chats-store]')) { openStore(); return true; }
      const id = el.closest('[data-settings-feature]')?.dataset.settingsFeature, f = features.get(id);
      return !!f?.act?.(ctx, el, event);
    }
    const click = e => dispatch(e.target, e);
    const featureInput = e => { const id = e.target.closest('[data-settings-feature]')?.dataset.settingsFeature; features.get(id)?.input?.(ctx, e.target); };
    const change = async e => {
      featureInput(e);
      const input = e.target.closest('[data-skinfile]'); if (!input) return;
      const file = input.files?.[0]; if (!file) return;
      try {
        if (file.size > 8192) throw new Error('Skin JSON must be 8 KB or smaller');
        const definition = JSON.parse(await file.text());
        if (!root.isConnected) return;
        window.WosSkin.compose(definition);
        skinImportMessage = 'Skin composition applied on this device.'; render();
      } catch (error) {
        skinImportMessage = `Not applied: ${error.message}`;
        const status = root.querySelector('[data-skinimport-status]'); if (status) status.textContent = skinImportMessage;
      } finally { input.value = ''; }
    };
    const key = e => {
      const dialog = root.querySelector('[data-settings-feature] [aria-modal="true"]');
      if (dialog) { if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); back(); } else trap(e, dialog); return; }
      if (confirm) { if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); back(); } else trap(e, root.querySelector('.st-confirm')); return; }
      const category = e.target.closest('[data-st-page]');
      if (category && ['ArrowUp', 'ArrowDown'].includes(e.key)) {
        e.preventDefault(); const buttons = [...root.querySelectorAll('[data-st-page]')], at = buttons.indexOf(category), n = (at + (e.key === 'ArrowDown' ? 1 : -1) + buttons.length) % buttons.length;
        const id = buttons[n].dataset.stPage; focus(id); root.querySelector(`[data-st-page="${id}"]`)?.focus(); return;
      }
      const radio = e.target.closest('[data-chats-choice]');
      if (radio && ['ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight'].includes(e.key)) {
        e.preventDefault(); const buttons = [...root.querySelectorAll('[data-chats-choice]')], at = buttons.indexOf(radio), delta = ['ArrowUp', 'ArrowLeft'].includes(e.key) ? -1 : 1;
        buttons[(at + delta + buttons.length) % buttons.length].focus(); return;
      }
      const b = e.target.closest('[data-skinpick], [data-skinfamily], [data-ownskin], [data-newskin]');
      if (!b || !['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(e.key)) return;
      const grid = b.closest('[role="group"]'); if (!grid) return;
      e.preventDefault(); const buttons = [...grid.querySelectorAll('button')], at = buttons.indexOf(b);
      const n = e.key === 'Home' ? 0 : e.key === 'End' ? buttons.length - 1 : (at + (e.key === 'ArrowRight' ? 1 : -1) + buttons.length) % buttons.length;
      buttons[n].focus();
    };
    const unsubscribe = ctx.live?.onChange?.(() => render());
    const appsChanged = () => render();
    window.addEventListener?.('wizard:apps', appsChanged); window.addEventListener?.('wizard:notify-route', appsChanged); window.addEventListener?.('wizard:notify-attention', appsChanged);
    function destroy() { for (const f of features.values()) f.leave?.(ctx); root.removeEventListener('input', featureInput); if (typeof unsubscribe === 'function') unsubscribe(); window.removeEventListener?.('wizard:apps', appsChanged); window.removeEventListener?.('wizard:notify-route', appsChanged); window.removeEventListener?.('wizard:notify-attention', appsChanged); mounts.delete(api); root.removeEventListener('click', click); root.removeEventListener('keydown', key); root.removeEventListener('change', change); }
    root.addEventListener('input', featureInput); root.addEventListener('click', click); root.addEventListener('keydown', key); root.addEventListener('change', change); mounts.add(api); render(); return api;
  }
  // One deferred System link at a time: a newer link, Back, or anything the user does first cancels the wait.
  let waiting = null;
  const STOPS = ['popstate', 'hashchange', 'pointerdown', 'keydown'];
  function cancelWait() { if (!waiting) return; clearInterval(waiting); waiting = null; for (const t of STOPS) window.removeEventListener?.(t, cancelWait, true); }
  function route(view, open) {
    cancelWait();
    if (view === 'settings') { open(); return true; }
    const f = [...features.values()].find(f => f.aliases?.includes(view));
    // System pages filled by a package (?view=network etc.) open once something is on them.
    if (!f && !features.has(view)) {
      const sys = PAGES.find(p => p.group === 'System' && p.id === view); if (!sys) return false;
      // A link can arrive before the package fills the page: wait for it (up to 10 s), then open.
      if (sys.available()) open(view);
      else { let n = 0; waiting = setInterval(() => { if (sys.available()) { cancelWait(); open(view); } else if (++n >= 40) cancelWait(); }, 250);
        for (const t of STOPS) window.addEventListener?.(t, cancelWait, true); }
      return true;
    }
    open(f?.id || view); return true;
  }
  // Shared focus containment. Existing shell Back guards own history; never add a second guard here.
  function trap(event, panel) {
    if (event.key !== 'Tab') return;
    const controls = [...panel.querySelectorAll('button:not(:disabled), input, textarea, select, a[href], [tabindex="0"]')].filter(e => e.getClientRects().length);
    if (!controls.length) return;
    const at = controls.indexOf(document.activeElement);
    if (at < 0 || (!event.shiftKey && at === controls.length - 1) || (event.shiftKey && at === 0)) { event.preventDefault(); controls[event.shiftKey ? controls.length - 1 : 0].focus(); }
  }
  window.WosMySkin?.on(() => { for (const m of mounts) m.render(); });
  window.WosSettings = { refresh: () => { for (const m of mounts) m.render(); }, register, mount, route, cancelWait, hasSystem: () => PAGES.some(p => p.group === 'System' && p.available()), systemPages: Object.freeze(PAGES.filter(p => p.group === 'System').map(p => p.id)), trap, pageOf, attention, moveDraft, unsentAll, unsentRow, unsentAction, retryAll, focusUnsent, tweakOptions, get features() { return [...features.values()].map(f => ({ id: f.id, aliases: f.aliases || [], page: pageOf(f) })); } };
})();
