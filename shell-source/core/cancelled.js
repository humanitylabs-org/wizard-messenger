/* Wizard OS · cancelled recordings (James, 11 Oct 2026)
 *
 * An X tapped by accident must not throw away a long message. Any take cancelled after 20 s or more is kept on
 * this phone for a week (newest 10): Settings → Cancelled recordings lists them with "Transcribe & copy", which
 * runs it through Wizard Voice and puts the words on the clipboard (and shows them, selectable). A quick cancel
 * is still just gone.
 *
 * Where they live:
 *   native takes (floating orb, side button, the app's orb on Android 0.9.5+) → files/cancelled/ in the app,
 *     read through WizardOSDevice.cancelledList / cancelledRead / cancelledDelete;
 *   takes the page recorded itself (browser, PWA, older shells) → IndexedDB "wos-cancelled".
 * Transcripts are cached per id so a second copy is instant.
 *
 *   WosCancelled.keepWeb(blob, ms)  → Promise<bool>  (the page's own recorder, on Cancel)
 *   WosCancelled.html()             → the Settings group (painted again on change)
 *   WosCancelled.act(el)            → handles a [data-cx] tap inside the group; true if handled
 */
(() => {
  'use strict';
  const KEEP_FROM_MS = 20000, MAX_KEPT = 10, MAX_AGE_MS = 7 * 24 * 3600 * 1000;
  const DB = 'wos-cancelled', STORE = 'takes', TX_KEY = 'wos.cancelled.text';
  const DEV = () => { const d = window.WizardOSDevice; return d && typeof d.cancelledList === 'function' ? d : null; };
  const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const J = s => { try { return JSON.parse(s); } catch (e) { return null; } };
  const fmt = ms => { const s = Math.round((Number(ms) || 0) / 1000); return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`; };
  const toast = (i, t, ms) => (window.__wos || window.__wux)?.toast?.(i, t, ms);
  const SRC = { everywhere: 'Floating orb', side: 'Side button', app: 'Orb', web: 'Orb', desktop: 'Microphone' };
  let web = [];          // [{id, at, ms, source, mime, bytes, blob}]
  const sessionWeb = new Map(); // Failed durable writes keep an explicit retry owner in this page.
  const deleting = new Set();
  let busy = new Set(), errs = {}, open = new Set();
  const texts = (() => { try { return JSON.parse(localStorage.getItem(TX_KEY) || '{}'); } catch (e) { return {}; } })();
  const saveTexts = () => { try { localStorage.setItem(TX_KEY, JSON.stringify(texts)); } catch (e) {} };

  /* ---- IndexedDB (web takes) ---- */
  let dbp = null;
  function db() {
    if (!dbp) dbp = new Promise((res, rej) => {
      let settled = false, r;
      const finish = (err, value) => { if (settled) { value?.close(); return; } settled = true; clearTimeout(timer); err ? rej(err) : res(value); };
      const timer = setTimeout(() => finish(new Error('Recording storage timed out')), 3000);
      try { r = indexedDB.open(DB, 1); } catch (e) { finish(e); return; }
      r.onupgradeneeded = () => { if (!r.result.objectStoreNames.contains(STORE)) r.result.createObjectStore(STORE, { keyPath: 'id' }); };
      r.onsuccess = () => { r.result.onversionchange = () => { r.result.close(); dbp = null; }; finish(null, r.result); };
      r.onerror = r.onblocked = () => finish(r.error || new Error('Recording storage unavailable'));
    }).catch(e => { dbp = null; throw e; });
    return dbp;
  }
  async function tx(mode, fn) {
    const d = await db();
    return new Promise((res, rej) => {
      let t, q;
      const timer = setTimeout(() => { try { t?.abort(); } catch (_) {} rej(new Error('Recording save timed out')); }, 3000);
      try {
        t = d.transaction(STORE, mode);
        t.oncomplete = () => { clearTimeout(timer); res(q?.result); };
        t.onerror = t.onabort = () => { clearTimeout(timer); rej(t.error || new Error('Recording save failed')); };
        q = fn(t.objectStore(STORE));
      } catch (e) { clearTimeout(timer); rej(e); }
    });
  }
  async function loadWeb() {
    try { web = (await tx('readonly', s => s.getAll())) || []; } catch (e) { web = web || []; }
    for (const t of sessionWeb.values()) if (!web.some(x => x.id === t.id)) web.push(t);
    web.sort((a, b) => b.at - a.at);
    for (const t of web) if (t.text && !texts[t.id]) texts[t.id] = t.text;
    const now = Date.now();
    for (const [i, t] of [...web.entries()]) if (!t.retained && !t.sessionOnly && (i >= MAX_KEPT || now - t.at > MAX_AGE_MS)) await removeWeb(t.id);
    return web;
  }
  async function removeWeb(id) { sessionWeb.delete(id); web = web.filter(t => t.id !== id); try { await tx('readwrite', s => s.delete(id)); } catch (e) {} }

  async function keepWeb(blob, ms, retained = false, text = '', source = 'web') {
    if (!(blob instanceof Blob) || blob.size < (retained ? 1200 : 2000) || (!retained && !(ms >= KEEP_FROM_MS))) return false;
    const t = { retained, id: 'w' + Date.now() + '-' + Math.random().toString(36).slice(2, 8), at: Date.now(), ms: Math.round(ms), source, mime: blob.type || 'audio/webm', bytes: blob.size, blob };
    let persisted = true;
    if (text) t.text = text;
    try { await tx('readwrite', s => s.put(t)); } catch (e) { persisted = false; /* memory only for this session */ }
    if (!persisted) { t.sessionOnly = true; sessionWeb.set(t.id, t); }
    if (text) { t.text = text; texts[t.id] = text; saveTexts(); open.add(t.id); }
    web.unshift(t); await loadWeb().catch(() => {}); if (!web.find(x => x.id === t.id)) web.unshift(t);
    repaint();
    return persisted;
  }
  async function retrySave(id, quiet = false) {
    if (window.WosOutbox?.get(id)) { await window.WosOutbox.pump(); repaint(); return; }
    const t = sessionWeb.get(id); if (!t) return;
    try {
      const saved = { ...t }; delete saved.sessionOnly;
      await tx('readwrite', s => s.put(saved));
      sessionWeb.delete(id); web = web.map(x => x.id === id ? saved : x);
      toast('✎', 'Recording saved on this device', 2000);
    } catch (_) { if (!quiet) toast('!', 'Storage still unavailable · keep this page open', 3000); }
    repaint();
  }

  // The app's capture journal marks the recordings it kept with "custody": true (CancelledTakes.keepCustody). That
  // means the PHONE holds them, not the page's outbox: keep it out of `custody`, which routes Delete and Transcribe
  // to WosOutbox (James, 21 Oct 2026: ten "0:00 · Orb" journal takes answered Delete with "Deletion not saved",
  // then with a "Deleted" that deleted nothing).
  function nativeList() { const d = DEV(); if (!d) return []; return (J(d.cancelledList()) || []).map(t => ({ ...t, native: true, custody: false, journal: !!t.custody })); }
  function all() {
    const custody = (window.WosOutbox?.recordings() || []).filter(x => x.state !== 'capturing').map(x => ({ id: x.id, at: x.createdAt, source: 'web', ms: x.ms || 0, mime: x.audio.type, bytes: x.audio.size, custody: true, sessionOnly: !x.durable, conversation: x.kind === 'conversation', text: x.text, error: x.error, state: x.state }));
    const l = nativeList().concat(web.map(({ blob, ...t }) => t), custody);
    l.sort((a, b) => b.at - a.at);
    for (const k of Object.keys(texts)) if (!l.some(t => t.id === k)) delete texts[k];
    return l;
  }

  function readNative(id, type) {
    const d = DEV(), parts = []; let off = 0;
    for (let k = 0; k < 8000 && off >= 0; k++) {
      const c = J(d.cancelledRead(id, off)); if (!c) break;
      const bin = atob(c.b64), u = new Uint8Array(bin.length);
      for (let i = 0; i < bin.length; i++) u[i] = bin.charCodeAt(i);
      parts.push(u); off = c.next;
    }
    return new Blob(parts, { type: type || 'audio/mp4' });
  }
  function blobOf(t) {
    if (t.custody) return window.WosOutbox.get(t.id)?.audio;
    if (t.native) return readNative(t.id, t.mime);
    const w = web.find(x => x.id === t.id); return w ? w.blob : null;
  }

  async function copy(text) {
    // The native clipboard works without a fresh tap (transcribing takes seconds and the page's tap "expires").
    try { const d = window.WizardOSDevice; if (d && typeof d.clip === 'function') { d.clip(text); return true; } } catch (e) {}
    try { return await window.WosChat.copyText(text); } catch (e) { return false; }
  }

  async function transcribe(id) {
    const t = all().find(x => x.id === id); if (!t || busy.has(id)) return;
    if (texts[id]) { const ok = await copy(texts[id]); open.add(id); repaint(); toast(ok ? '⧉' : '!', ok ? 'Copied' : 'Couldn’t copy · select the text below', 1800); return; }
    busy.add(id); delete errs[id]; repaint();
    try {
      const blob = blobOf(t); if (!blob || blob.size < 1000) throw new Error('The recording is empty');
      const prompt = window.WizConfig.voicePrompt?.() || '';
      const j = t.custody ? await window.WosOutbox.transcribeDictation(id) : await window.WosOutbox.bounded(signal => window.WizConfig.transcribe(blob, { prompt, language: 'en', signal }), window.WosOutbox.TRANSCRIBE_TIMEOUT_MS);
      const text = String(j.text || '').trim();
      if (!text) throw new Error('No speech found in it');
      texts[id] = text; saveTexts(); open.add(id);
      const ok = await copy(text);
      toast(ok ? '⧉' : '!', ok ? 'Copied · paste it anywhere' : 'Couldn’t copy · select the text below', 2200);
    } catch (e) {
      errs[id] = String(e?.message || e).slice(0, 120);
      toast('!', 'Couldn’t transcribe · tap to try again', 2200);
    } finally { busy.delete(id); repaint(); }
  }
  // One deletion; returns '' on success or the reason it failed. remove() and deleteAll() share it.
  async function drop(t) {
    const id = t.id;
    if (t.custody) {
      let removed = false, why = '';
      try { removed = await window.WosOutbox.remove(id); } catch (e) { why = String(e?.message || e); }
      if (!removed) return why || window.WosOutbox.removeError?.(id) || 'device storage refused it';
    }
    else if (t.native) { try { DEV().cancelledDelete(id); } catch (e) {} } else await removeWeb(id);
    // Never report a deletion that did not happen: the row must be gone from its own store.
    if (all().some(x => x.id === id && x.native === !!t.native && x.custody === !!t.custody)) return t.native ? 'the phone kept the file' : 'it is still stored';
    delete texts[id]; saveTexts(); open.delete(id);
    return '';
  }
  async function remove(id) {
    const t = all().find(x => x.id === id); if (!t || deleting.has(id)) return;
    deleting.add(id); repaint();
    let why; try { why = await drop(t); } catch (e) { why = e.message || 'device storage refused it'; } finally { deleting.delete(id); repaint(); }
    // Say why, so a failure on the phone is diagnosable from one screenshot.
    if (why) { toast('!', 'Couldn’t delete · ' + why.slice(0, 90), 4000); repaint(); return; }
    toast('✕', 'Deleted', 1200); repaint();
  }
  let confirmAll = 0;
  async function deleteAll() {
    if (Date.now() - confirmAll > 4000) { confirmAll = Date.now(); repaint(); toast('!', 'Tap Delete all again to delete every recording here', 4000); return; }
    confirmAll = 0;
    if (deleting.size) return;
    const list = all(); let failed = 0, why = '';
    for (const t of list) deleting.add(t.id); repaint();
    for (const t of list) { let w; try { w = await drop(t); } catch (e) { w = e.message || 'device storage refused it'; } finally { deleting.delete(t.id); } if (w) { failed++; why = why || w; } }
    repaint();
    toast(failed ? '!' : '✕', failed ? `Deleted ${list.length - failed} · ${failed} couldn’t be deleted · ${why.slice(0, 70)}` : `Deleted ${list.length}`, failed ? 5000 : 1600);
  }

  const ago = at => { const m = Math.round((Date.now() - at) / 60000); return m < 1 ? 'just now' : m < 60 ? `${m} min ago` : m < 1440 ? `${Math.round(m / 60)} h ago` : `${Math.round(m / 1440)} d ago`; };
  function row(t) {
    const b = busy.has(t.id) || ['transcribing', 'sending'].includes(t.state), tx = texts[t.id] || t.text, err = errs[t.id] || t.error;
    return `<div class="cx-row" data-cxid="${esc(t.id)}">
      <div class="cx-t"><b>${fmt(t.ms)}</b> · ${esc(SRC[t.source] || 'Orb')} · ${esc(ago(t.at))}</div>
      ${tx && (open.has(t.id) || t.conversation) ? `<div class="cx-text" data-cxtext>${esc(tx)}</div>` : ''}
      ${t.conversation ? `<div class="cx-t">App voice input · original destination retained</div><button data-cx="manager" ${b ? 'disabled' : ''}>Retry original to app</button>` : ''}
      ${err ? `<div class="cx-err">${esc(err)}</div>` : ''}
      ${t.sessionOnly ? '<div class="cx-err">Storage unavailable · kept only while this page stays open.</div><button data-cx="save">Retry saving</button>' : ''}
      <div class="ub-a"><button data-cx="copy" ${b ? 'disabled' : ''}>${b ? 'Transcribing…' : tx ? 'Copy again' : 'Transcribe &amp; copy'}</button>${tx ? `<button data-cx="show" class="ghost">${open.has(t.id) ? 'Hide words' : 'Show words'}</button>` : ''}<button data-cx="delete" class="ghost" ${deleting.has(t.id) ? 'disabled' : ''}>${deleting.has(t.id) ? 'Deleting…' : 'Delete'}</button></div></div>`;
  }
  function html() {
    const l = all();
    return `<div class="st-group" data-cancelled><h4>Recovered &amp; cancelled recordings <span>${l.length || ''}</span></h4>
      ${l.length ? l.map(row).join('') : '<div class="st-empty">No recordings waiting.</div>'}
      ${l.length > 1 ? `<button class="st-wide ghost" data-cx-all="delete" ${deleting.size ? 'disabled' : ''}>${deleting.size ? 'Deleting…' : Date.now() - confirmAll < 4000 ? 'Tap again to delete all ' + l.length : 'Delete all'}</button>` : ''}
      <details class="st-info"><summary aria-label="About recovered recordings">?</summary><p class="st-note">Interrupted and retained recordings stay until deleted. Older cancelled recordings may expire after a week (the newest ${MAX_KEPT}). Transcribe &amp; copy never sends to an agent.</p></details></div>`;
  }
  function repaint() {
    window.WosSettings?.refresh();
    const g = document.querySelector('[data-settings-root] [data-cancelled]');
    if (g) g.outerHTML = html();
  }
  function act(el) {
    if (el.closest('[data-cx-all="delete"]')) { deleteAll(); return true; }
    const b = el.closest('[data-cx]'); if (!b) return false;
    const id = b.closest('[data-cxid]')?.dataset.cxid; if (!id) return true;
    const a = b.dataset.cx;
    if (a === 'copy') transcribe(id);
    else if (a === 'manager') window.WosOutbox.retryConversation(id).then(repaint);
    else if (a === 'save') retrySave(id);
    else if (a === 'delete') remove(id);
    else if (a === 'show') { open.has(id) ? open.delete(id) : open.add(id); repaint(); }
    return true;
  }

  addEventListener('beforeunload', e => { if (sessionWeb.size) { e.preventDefault(); e.returnValue = ''; } });
  setInterval(() => { for (const id of sessionWeb.keys()) retrySave(id, true); }, 5000);
  window.WosOutbox?.onChange(repaint);
  loadWeb().then(repaint).catch(() => {});
  window.WosCancelled = { KEEP_FROM_MS, keepWeb, retainWeb: (blob, ms, text = '') => keepWeb(blob, ms, true, text), html, act, repaint, list: all, deleteAll, transcribe, retrySave, _texts: texts };
})();
