/* WizAttachChip: the one "about to send" attachment chip for every chat box in Wizard (Chats' composer tray and
 * apps through WizardApp.attachChip). A photo stages as a big thumbnail; any other file as an icon + name + size;
 * a voice take as "Voice note". Upload progress paints in place. It renders and paints only: the caller owns the
 * file, the upload and what Remove does (James, 26 Oct 2026: "One implementation once, shared by many apps").
 * Styles: core/attach-chip.css (class names ch-att*, kept so skins that style Chats' tray keep working).
 *
 * chip = {key, name, bytes, kind: 'image'|'file'|'voice', preview?, uploading?, sent?, total?, state?: 'reconnecting'|'finishing'}
 *   html(chip, {style: false})  markup string (Chats' templated tray). style:false omits the inline --up style for
 *                               pages whose CSP forbids style attributes; call paint() after inserting.
 *   node(chip, {onRemove})      element (apps); Remove calls onRemove(chip.key).
 *   paint(el, chip)             progress / label in place, no re-render.
 *   size(bytes)                 "12 KB" style size.
 */
(() => {
  'use strict';
  if (window.WizAttachChip) return;
  const MIC = '<svg viewBox="0 0 24 24"><path d="M12 15a4 4 0 0 0 4-4V7a4 4 0 0 0-8 0v4a4 4 0 0 0 4 4Zm-7-4a7 7 0 0 0 14 0M12 18v4"/></svg>';
  const CLIP = '<svg viewBox="0 0 24 24"><path d="m9.5 17.5 7.7-7.7a3 3 0 0 0-4.2-4.2l-8 8a5 5 0 0 0 7.1 7.1l8-8"/></svg>';
  const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const size = b => { b = Number(b) || 0; return b >= 1073741824 ? (b / 1073741824).toFixed(1) + ' GB' : b >= 1048576 ? (b / 1048576).toFixed(1) + ' MB' : b >= 1024 ? Math.round(b / 1024) + ' KB' : b + ' B'; };
  const pct = c => c.total ? Math.floor(100 * (c.sent || 0) / c.total) : 0;
  const label = c => c.state === 'reconnecting' ? (c.sent ? `Reconnecting \u00b7 ${pct(c)}%` : 'Waiting for Wizard\u2026') : c.state === 'finishing' ? 'Finishing\u2026' : c.total > 0 ? `${pct(c)}% \u00b7 ${size(c.total)}` : 'Uploading\u2026';
  const photo = c => c.kind === 'image' && !!c.preview;
  function html(c, opts = {}) {
    const up = !!c.uploading, key = esc(c.key);
    const st = up && opts.style !== false ? ` style="--up:${pct(c)}%"` : '';
    const rm = `<button type="button" class="ch-attrm" data-attrm="${key}" aria-label="Remove">\u00d7</button>`;
    if (photo(c)) return `<span class="ch-att ch-attimg${up ? ' up' : ''}" data-attkey="${key}"${st}><img src="${esc(c.preview)}" alt="${esc(c.name || 'Photo')}">${up ? `<i class="ch-attspin" aria-label="Uploading"></i><b class="ch-attpct">${pct(c)}%</b><i class="ch-attbar"></i>` : ''}${rm}</span>`;
    const icon = c.preview ? `<img src="${esc(c.preview)}" alt="">` : `<span class="ic">${c.kind === 'voice' ? MIC : CLIP}</span>`;
    return `<span class="ch-att${up ? ' up' : ''}" data-attkey="${key}"${st}>${icon}<span class="nm">${esc(c.kind === 'voice' ? 'Voice note' : c.name)}<small>${esc(up ? label(c) : size(c.bytes))}</small></span>${up ? '<i class="ch-attbar"></i>' : ''}${rm}</span>`;
  }
  function paint(el, c) {
    if (!el) return;
    el.style.setProperty('--up', pct(c) + '%');
    el.classList.toggle('up', !!c.uploading);
    el.classList.toggle('wait', c.state === 'reconnecting');
    const s = el.querySelector('small'); if (s) s.textContent = c.uploading ? label(c) : size(c.bytes);
    const r = el.querySelector('.ch-attpct'); if (r) r.textContent = c.state === 'reconnecting' ? '\u2026' : pct(c) + '%';
    if (c.uploading) el.setAttribute('aria-label', `Uploading ${c.name || 'file'} \u00b7 ${label(c)}`); else el.removeAttribute('aria-label');
  }
  function node(c, opts = {}) {
    const t = document.createElement('template'); t.innerHTML = html(c, { style: false });
    const el = t.content.firstElementChild; paint(el, c);
    el.querySelector('.ch-attrm').addEventListener('click', e => { e.preventDefault(); e.stopPropagation(); opts.onRemove?.(c.key); });
    return el;
  }
  window.WizAttachChip = Object.freeze({ html, node, paint, size, label, pct, MIC, CLIP });
})();
