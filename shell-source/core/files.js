/* Wizard UX core: the Files screen (#23). Shared by every shell.
 *
 * Browse what's in Wizard Files (GET /wizard/files), preview any of it with the chat media viewer,
 * and attach an existing file to a chat without uploading it again (its id rides as wizard_file_ids,
 * the same contract the paperclip uses). Port of wizard-mobile ff86db8c wizardFiles.ts (normalize, kinds).
 *
 *   WosFiles.load(force)         → Promise<files[]>   (cached 30 s)
 *   WosFiles.files / ready / error
 *   WosFiles.media(f)            → a media-viewer item { url, name, mime, kind, bytes }
 *   WosFiles.panelHtml({ q, kind, attach, picked }) → the screen (attach = a composer is waiting for a pick)
 */
(() => {
  'use strict';
  const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const kindOf = f => /^image\//.test(f.mime) ? 'image' : /^video\//.test(f.mime) ? 'video' : /^audio\//.test(f.mime) ? (/^wizard-(voice|everywhere)-/.test(f.name) ? 'voice' : 'audio') : 'file';
  const KINDS = [['all', 'All'], ['image', 'Photos'], ['voice', 'Voice'], ['file', 'Files']];
  const fsize = b => b >= 1048576 ? (b / 1048576).toFixed(1) + ' MB' : b >= 1024 ? Math.round(b / 1024) + ' KB' : b ? b + ' B' : '';
  // Wizard's own capture names carry their time: wizard-voice-2026-10-09T15-06-55-181Z.m4a, wizard-screen-2026-10-09T21-41-19-1.png
  function stamp(f) {
    const t = Date.parse(f.createdAt || '');
    if (isFinite(t)) return t;
    const m = /(\d{4}-\d{2}-\d{2})T(\d{2})-(\d{2})-(\d{2})(?:-(\d{3}))?(Z)?/.exec(f.name);
    if (!m) return NaN;
    const iso = `${m[1]}T${m[2]}:${m[3]}:${m[4]}.${m[5] || '000'}${m[6] ? 'Z' : ''}`;
    return Date.parse(iso);
  }
  function normalize(payload) {
    const list = Array.isArray(payload?.files) ? payload.files : Array.isArray(payload) ? payload : [];
    return list.map(v => {
      if (!v || typeof v !== 'object' || typeof v.id !== 'string' || !v.id) return null;
      if (v.status && v.status !== 'ready') return null;
      const f = { id: v.id, name: String(v.filename || v.name || 'file'), mime: String(v.mime || ''), bytes: Number(v.bytes) || 0, source: String(v.source || ''), note: String(v.note || ''), createdAt: String(v.created_at || '') };
      f.kind = kindOf(f); f.at = stamp(f);
      return f;
    }).filter(Boolean);
  }
  const F = {
    files: [], ready: false, error: '', at: 0, loading: null,
    load(force) {
      if (F.loading) return F.loading;
      if (!force && F.ready && Date.now() - F.at < 30e3) return Promise.resolve(F.files);
      F.loading = fetch('/wizard/files', { cache: 'no-store', credentials: 'same-origin' })
        .then(r => { if (!r.ok) throw new Error(r.status === 403 ? 'Wizard sign-in needed' : `Wizard Files is unavailable (${r.status})`); return r.json(); })
        .then(j => { F.files = normalize(j); F.ready = true; F.error = ''; F.at = Date.now(); return F.files; })
        .catch(e => { F.error = String(e.message || e); return F.files; })
        .finally(() => { F.loading = null; });
      return F.loading;
    },
    normalize, kindOf,
    get(id) { return F.files.find(f => f.id === id) || null; },
    media(f) { return { id: f.id, url: `/wizard/files/${encodeURIComponent(f.id)}/content`, name: f.name, mime: f.mime, bytes: f.bytes, kind: f.kind === 'voice' ? 'audio' : f.kind }; },
    filter(q, kind) {
      const n = String(q || '').toLowerCase().trim();
      return F.files.filter(f => (!kind || kind === 'all' || f.kind === kind || (kind === 'file' && (f.kind === 'audio' || f.kind === 'video')))
        && (!n || f.name.toLowerCase().includes(n) || f.note.toLowerCase().includes(n) || f.source.toLowerCase().includes(n)));
    },
    panelHtml({ q = '', kind = 'all', attach = false, picked = [], when }) {
      const list = F.filter(q, kind).slice(0, 200);
      const label = f => f.kind === 'voice' ? 'Voice note' : f.name;
      const ic = f => f.kind === 'image' ? `<img src="${esc(F.media(f).url)}" alt="" loading="lazy" decoding="async">` : `<span class="fi-ic">${f.kind === 'voice' || f.kind === 'audio' ? '♪' : f.kind === 'video' ? '▶' : '📄'}</span>`;
      const rows = !F.ready && !F.files.length ? `<p class="ch-sheet-n">${F.error ? esc(F.error) : 'Loading Wizard Files…'}</p>`
        : !list.length ? `<p class="ch-sheet-n">${q ? `Nothing matches “${esc(q)}”.` : 'Nothing here yet.'}</p>`
          : list.map(f => {
            const on = picked.includes(f.id);
            const meta = [isFinite(f.at) && when ? when(f.at) : '', fsize(f.bytes), f.source].filter(Boolean).join(' · ');
            return `<div class="fi-row${on ? ' on' : ''}" data-fiid="${esc(f.id)}"><button type="button" class="fi-open" data-fiopen="${esc(f.id)}" aria-label="Preview ${esc(label(f))}">${ic(f)}<span class="fi-tx"><b>${esc(label(f))}</b><small>${esc(meta)}</small></span></button>`
              + `<button type="button" class="fi-att" data-fiattach="${esc(f.id)}" aria-pressed="${on}">${on ? 'Attached' : attach ? 'Attach' : 'Send in chat'}</button></div>`;
          }).join('');
      return `<div class="ch-sheet ch-files" role="dialog" aria-label="Wizard Files"><div class="ch-sheet-b fi-b">
        <div class="fi-top"><b>Files</b><small>${F.ready ? `${F.files.length} in Wizard Files` : ''}</small><button type="button" class="fi-x" data-ficlose aria-label="Close">×</button></div>
        <label class="ch-search fi-q"><svg viewBox="0 0 24 24"><circle cx="11" cy="11" r="7"/><path d="m20 20-3.5-3.5"/></svg><input data-fiq placeholder="Search files" value="${esc(q)}" spellcheck="false" enterkeyhint="search"></label>
        <div class="fi-kinds" role="tablist">${KINDS.map(([k, l]) => `<button type="button" role="tab" data-fikind="${k}" aria-selected="${k === kind}" class="${k === kind ? 'on' : ''}">${l}</button>`).join('')}</div>
        <div class="fi-list">${rows}</div>
        ${attach ? `<p class="ch-sheet-n">Attached files go with your next message in this chat.</p>` : ''}</div></div>`;
    },
  };
  window.WosFiles = F;
})();
