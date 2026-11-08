/* Wizard UX core: who and when, from the Wizard Agent Service.
 *
 * Nothing about any particular owner, agent or place is built into the UX. At start it reads
 * GET /wizard/v1/bootstrap (Wizard OS settings.json + what this box can do) and keeps the last
 * answer on the device, so a reload paints instantly and offline still works.
 *
 *   WizConfig.agent()          the agent's display name ("Wizard" until the owner names it)
 *   WizConfig.agentName(name)  save a new agent name (PUT /wizard/v1/settings), resolves to the confirmed name
 *   WizConfig.owner()          the owner's name, or '' (UI then says "you")
 *   WizConfig.timeZone()       the device's own zone (follows the owner when they travel), else settings timezone
 *   WizConfig.homeZone()       the settings timezone the server schedules in, else the device's zone
 *   WizConfig.dayStart(t)      start (ms) of the owner's day containing t (settings day_starts_at)
 *   WizConfig.dayParts(t)      {y, m, d, dow} of t in the owner's zone
 *   WizConfig.endpoint(name)   'transcribe' | 'route' | 'apps' | 'upload' URL, or '' when absent
 *   WizConfig.has(capability)  voice, router, files, approvals, steer, joined_delegation, markdown
 *   WizConfig.ready            promise for the first live answer (resolves even if it fails)
 *   'wizard:config' event      fired on window whenever the answer changes
 *
 * Backwards compatibility: with an Agent Service that has no bootstrap endpoint yet, the UX falls
 * back to the shell's own same-origin api/transcribe and api/route sidecar, as before. */
(() => {
  'use strict';
  const KEY = 'wux.bootstrap.v1';
  const DEFAULTS = {
    bootstrap: 0,
    settings: { owner: { name: '', place: '' }, agent: { name: 'Wizard' }, clock: { timezone: '', day_starts_at: '00:00' }, voice: { language: '', vocabulary: [] } },
    capabilities: {},
    endpoints: {},
  };
  let B = (() => { try { return JSON.parse(localStorage.getItem(KEY) || 'null') || DEFAULTS; } catch (e) { return DEFAULTS; } })();
  let live = false;

  // The zone the phone reports, or '' when it reports none (some WebViews), so the settings zone can take over.
  const phoneZone = () => { try { return Intl.DateTimeFormat().resolvedOptions().timeZone || ''; } catch (e) { return ''; } };
  const deviceZone = () => phoneZone() || 'UTC';
  const zoneOk = z => { if (!z) return false; try { new Intl.DateTimeFormat('en-US', { timeZone: z }); return true; } catch (e) { return false; } };
  const fmtCache = new Map();
  const fmt = z => {
    if (!fmtCache.has(z)) fmtCache.set(z, new Intl.DateTimeFormat('en-US', { timeZone: z, hourCycle: 'h23', year: 'numeric', month: 'numeric', day: 'numeric', hour: 'numeric', minute: 'numeric', second: 'numeric', weekday: 'short' }));
    return fmtCache.get(z);
  };
  const DOWS = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 };

  const C = {
    get raw() { return B; },
    get live() { return live; },
    // Only canonical -> sibling preview is folded. Daily -> preview and preview ->
    // other preview remain external. Resolve lazily: bootstrap arrives after scripts.
    localURL(href, base = location.href) {
      const u = new URL(href, base);
      let canonical; try { canonical = new URL(B.settings?.network?.base_url); } catch (_) { return u; }
      if (location.protocol === 'https:' && canonical.protocol === 'https:' &&
          location.hostname === canonical.hostname && location.port !== canonical.port &&
          u.origin === canonical.origin && !u.username && !u.password) {
        return new URL(u.pathname + u.search + u.hash, location.origin);
      }
      return u;
    },
    isPreview() {
      try { const c = new URL(B.settings?.network?.base_url); return location.protocol === 'https:' && c.protocol === 'https:' && location.hostname === c.hostname && location.port !== c.port; }
      catch (_) { return false; }
    },
    agent() { return (B.settings?.agent?.name || 'Wizard').trim() || 'Wizard'; },
    // Match the configured spoken name literally, with a boundary (never a name prefix).
    stripAddress(text) {
      const escape = s => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      const names = [...new Set([C.agent(), 'Wizard'])].sort((a, b) => b.length - a.length);
      return String(text || '').trim().replace(new RegExp('^(?:(?:hey|ok|okay)\\s+)?(?:' + names.map(escape).join('|') + ')(?:[,.!]?\\s+|[,.!]?$)', 'i'), '');
    },
    owner() { return (B.settings?.owner?.name || '').trim(); },
    place() { return (B.settings?.owner?.place || '').trim(); },
    vocabulary() { return Array.isArray(B.settings?.voice?.vocabulary) ? B.settings.voice.vocabulary : []; },
    // Times on screen follow the phone's clock, so a trip abroad needs no settings change.
    // The settings zone stays the fallback (and the server's home zone) when the device reports none.
    timeZone() { const d = phoneZone(); if (zoneOk(d)) return d; const z = B.settings?.clock?.timezone; return zoneOk(z) ? z : 'UTC'; },
    homeZone() { const z = B.settings?.clock?.timezone; return zoneOk(z) ? z : deviceZone(); },
    /* Wall-clock parts of instant t in the owner's zone. */
    dayParts(t = Date.now()) {
      const p = {}; for (const x of fmt(C.timeZone()).formatToParts(new Date(t))) p[x.type] = x.value;
      return { y: +p.year, m: +p.month, d: +p.day, h: +p.hour % 24, min: +p.minute, s: +p.second, dow: DOWS[p.weekday] ?? 0 };
    },
    /* Offset (ms) of the owner's zone from UTC at instant t. */
    offset(t = Date.now()) { const p = C.dayParts(t); return Date.UTC(p.y, p.m - 1, p.d, p.h, p.min, p.s) - Math.floor(t / 1000) * 1000; },
    /* Start of the owner's working day that contains t (day_starts_at, e.g. 06:00), as a UTC ms instant. */
    dayStart(t = Date.now()) {
      const [hh, mm] = String(B.settings?.clock?.day_starts_at || '00:00').split(':').map(Number);
      const shift = ((hh || 0) * 60 + (mm || 0)) * 6e4;
      const off = C.offset(t);
      const DAY = 864e5;
      return Math.floor((t + off - shift) / DAY) * DAY + shift - off;
    },
    endpoint(name) {
      if (B.bootstrap) return B.endpoints?.[name] || '';
      // Pre-bootstrap Agent Service: the shell's own sidecar answers these, same origin as the page.
      return { transcribe: 'api/transcribe', route: 'api/route' }[name] || '';
    },
    has(cap) { return B.bootstrap ? !!B.capabilities?.[cap] : (cap === 'voice' || cap === 'router' || cap === 'files' || cap === 'approvals' || cap === 'steer'); },
    /* One audio take → text, through whichever transcription endpoint this box has. */
    async transcribe(blob, { prompt = '', language = '', signal } = {}) {
      let url = C.endpoint('transcribe');
      // A cached bootstrap may have caught a busy voice service. Recheck once before rejecting the take.
      if (!url) {
        await load(signal);
        url = C.endpoint('transcribe');
      }
      if (!url) throw Object.assign(new Error('Voice is not set up on this Wizard'), { code: 'no_voice' });
      const t0 = performance.now();
      let r;
      if (B.bootstrap) {
        const type = (blob.type || 'audio/webm').split(';')[0];
        const ext = type.includes('mp4') ? 'm4a' : type.includes('ogg') ? 'ogg' : type.includes('wav') ? 'wav' : 'webm';
        // A browser can keep an IndexedDB-restored Blob's request stream open without sending its bytes. Materialize
        // the recording first so a recovered voice send either uploads a finite body or fails locally and keeps it.
        let body = blob;
        if (typeof blob?.arrayBuffer === 'function') {
          try { body = await blob.arrayBuffer(); }
          catch { throw new Error('Recording could not be read from device storage'); }
          if (!body.byteLength && blob.size) throw new Error('Recording could not be read from device storage');
        }
        r = await fetch(url, { method: 'POST', signal, credentials: 'same-origin', headers: { 'Content-Type': type, 'X-Wizard-Filename': `voice.${ext}` }, body });
      } else {
        const fd = new FormData();
        const ext = blob.type.includes('mp4') ? 'm4a' : blob.type.includes('ogg') ? 'ogg' : 'webm';
        fd.append('file', blob, `voice.${ext}`); fd.append('language', language || 'en');
        if (prompt) fd.append('prompt', prompt);
        r = await fetch(url, { method: 'POST', signal, body: fd });
      }
      const j = await r.json().catch(() => ({}));
      if (!r.ok) throw Object.assign(new Error(j.error || ('HTTP ' + r.status)), { status: r.status });
      return { text: String(j.text || '').trim(), ms: j.ms ?? Math.round(performance.now() - t0), model: j.model || '' };
    },
    /* Spoken names the transcriber should spell right: the agent, the owner, the apps, the owner's words. */
    voicePrompt(extra = []) {
      const names = [C.agent(), C.owner(), ...C.vocabulary(), ...extra].filter(Boolean);
      return names.length ? `Names: ${[...new Set(names)].join(', ')}.` : '';
    },
    // The Service owns this preference across devices; the cache is display-only.
    async responseStyle(value) {
      if (value !== undefined) {
        if (!['summary', 'concise', 'own'].includes(value)) throw Error('Choose Summary, Concise or Own');
        const saved = await fetch('/wizard/v1/settings', { method: 'PUT', credentials: 'same-origin', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ response_style: value }) });
        if (!saved.ok) throw Error('Could not save response style');
      }
      const read = await fetch('/wizard/v1/settings', { credentials: 'same-origin', cache: 'no-store' });
      if (!read.ok) throw Error('Could not read response style');
      const style = (await read.json()).settings?.response_style;
      if (!['summary', 'concise', 'own'].includes(style)) throw Error('Update your Wizard to choose a response style');
      if (value !== undefined && style !== value) throw Error('Your Wizard has not confirmed this response style. Try again.');
      B = { ...B, settings: { ...B.settings, response_style: style } };
      try { localStorage.setItem(KEY, JSON.stringify(B)); } catch (_) {}
      window.dispatchEvent(new CustomEvent('wizard:config', { detail: B }));
      return style;
    },
    // The agent's name (Name your Wizard, Settings): saved in the Agent Service settings, then read back. One line of
    // plain text, at most 40 characters; the rest of the agent block (adapter) is kept as it is.
    // from: the name the owner was looking at; if the agent was renamed elsewhere since, nothing is written and the
    // error carries code 'conflict' and the current name.
    async agentName(value, { from } = {}) {
      const name = String(value ?? '').replace(/[\u0000-\u001f\u007f<>]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 40).trim();
      if (!name) throw Error('Type a name');
      const cur = await fetch('/wizard/v1/settings', { credentials: 'same-origin', cache: 'no-store' });
      if (!cur.ok) throw Error('Could not read your Wizard settings');
      // The Agent Service replaces the whole agent block on PUT, so the fields read here go back with the new name.
      const agent = (await cur.json()).settings?.agent || {};
      if (from !== undefined && (agent.name || 'Wizard') !== from) {
        B = { ...B, settings: { ...B.settings, agent: { ...B.settings?.agent, name: agent.name || 'Wizard' } } };
        try { localStorage.setItem(KEY, JSON.stringify(B)); } catch (_) {}
        window.dispatchEvent(new CustomEvent('wizard:config', { detail: B }));
        throw Object.assign(Error('Renamed on another device'), { code: 'conflict', current: agent.name || 'Wizard' });
      }
      const saved = await fetch('/wizard/v1/settings', { method: 'PUT', credentials: 'same-origin', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ agent: { ...agent, name } }) });
      if (!saved.ok) throw Error('Could not save the name');
      const now = (await saved.json().catch(() => ({}))).settings?.agent?.name;
      if (now !== name) throw Error('Your Wizard has not confirmed the new name. Try again.');
      B = { ...B, settings: { ...B.settings, agent: { ...B.settings?.agent, name: now } } };
      try { localStorage.setItem(KEY, JSON.stringify(B)); } catch (_) {}
      window.dispatchEvent(new CustomEvent('wizard:config', { detail: B }));
      return now;
    },
    ready: null,
  };

  async function load(signal) {
    try {
      const r = await fetch('/wizard/v1/bootstrap', { credentials: 'same-origin', cache: 'no-store', signal });
      if (!r.ok) throw new Error('HTTP ' + r.status);
      const next = await r.json();
      if (!next || typeof next.bootstrap !== 'number') throw new Error('bad bootstrap');
      const changed = JSON.stringify(next) !== JSON.stringify(B);
      B = next; live = true;
      try { localStorage.setItem(KEY, JSON.stringify(B)); } catch (e) {}
      if (changed) window.dispatchEvent(new CustomEvent('wizard:config', { detail: B }));
    } catch (e) {
      if (signal?.aborted) throw e;
      // 404 = an Agent Service without bootstrap yet: keep sidecar fallbacks, forget any stale cache.
      if (String(e.message).includes('404') && B.bootstrap) {
        B = DEFAULTS; try { localStorage.removeItem(KEY); } catch (e2) {}
        window.dispatchEvent(new CustomEvent('wizard:config', { detail: B }));
      }
    }
    return B;
  }
  C.ready = load();
  // Settings can change while the app is open (the owner renames the agent): refresh on focus.
  document.addEventListener('visibilitychange', () => { if (!document.hidden) load(); });
  // Clock text in the owner's zone (settings timezone, else the device's own).
  C.hm = (t = Date.now()) => { try { return new Intl.DateTimeFormat('en-GB', { hour: '2-digit', minute: '2-digit', hour12: false, timeZone: C.timeZone() || undefined }).format(t); } catch (e) { const d = new Date(t); return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`; } };
  C.dateLabel = (t = Date.now(), opts = { weekday: 'short', day: 'numeric', month: 'short' }) => { try { return new Intl.DateTimeFormat(undefined, { ...opts, timeZone: C.timeZone() || undefined }).format(t); } catch (e) { return new Date(t).toLocaleDateString(undefined, opts); } };
  window.WizConfig = C;
})();
