/* Wizard UX core: resumable uploads (Agent Service v1, /wizard/v1/uploads).
 *
 * One upload path for every attachment, any size (James, 14 Oct 2026: "handle chat attachments seamlessly behind
 * the scenes instead of rejecting something the user is trying to do"). The file is sent in chunks cut with
 * Blob.slice, so nothing is ever held in memory whole; each chunk is a PATCH carrying Upload-Offset. When the
 * network drops or the Wizard restarts, the client waits (backoff), asks the server where it got to (GET) and
 * carries on from that byte. The server only refuses when the file would not fit on its disk.
 *
 *   WizUploads.supported()                    the box advertises capabilities.resumable_uploads
 *   WizUploads.upload(file, { signal, onProgress(sent, total, state) })
 *        → { id, name, mime, bytes }          the Wizard Files receipt (id works as a wizard_file_id)
 *        state: 'uploading' | 'reconnecting' | 'finishing'
 *   Errors meant for the user carry .user = true (e.g. "Not enough space on your Wizard").
 */
(() => {
  'use strict';
  const MIB = 1048576;
  const MIN_CHUNK = 256 * 1024, MAX_CHUNK = 64 * MIB, DEFAULT_CHUNK = 8 * MIB;
  const STALL_MS = 45000;          // no bytes moving for this long → treat the request as lost and reconcile
  const GIVE_UP_MS = 30 * 60000;   // continuous failure without progress for this long → stop and say so
  const abortErr = () => Object.assign(new Error('Upload cancelled'), { name: 'AbortError' });
  const userErr = (m, extra = {}) => Object.assign(new Error(m), { user: true }, extra);
  const NO_SPACE = 'Not enough space on your Wizard for that file.';
  const sleep = (ms, signal) => new Promise((res, rej) => {
    if (signal?.aborted) return rej(signal.reason || abortErr());
    const t = setTimeout(res, ms);
    signal?.addEventListener('abort', () => { clearTimeout(t); rej(signal.reason || abortErr()); }, { once: true });
  });
  /* 1 s, 2 s, 4 s … capped at 30 s, with jitter so many tabs don't hammer a restarting Wizard together. */
  const backoff = n => Math.min(30000, 1000 * 2 ** Math.min(n, 5)) * (0.75 + Math.random() * 0.5);
  const newId = () => 'web-' + (crypto.randomUUID ? crypto.randomUUID() : Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 12));

  function supported() {
    const C = window.WizConfig;
    return !!(C && C.raw && C.raw.bootstrap && C.has('resumable_uploads'));
  }
  const base = () => (window.WizConfig && window.WizConfig.endpoint('uploads')) || '/wizard/v1/uploads';

  /* Control calls (create, where-did-I-get-to, complete) are tiny: one that hangs (a busy or restarting Wizard,
   * a half-dead mobile connection) is abandoned after CALL_MS and retried with backoff, never waited on forever.
   * 19 Oct 2026: a create sat unanswered while the Agent Service stalled and the chip stayed at 0% with no retry. */
  const CALL_MS = 15000;
  async function call(method, url, body, signal) {
    const ctl = new AbortController(), stop = () => ctl.abort();
    if (signal?.aborted) throw signal.reason || abortErr();
    signal?.addEventListener('abort', stop, { once: true });
    const timer = setTimeout(stop, CALL_MS);
    try {
      let r;
      try {
        r = await fetch(url, { method, credentials: 'same-origin', cache: 'no-store', signal: ctl.signal,
          headers: body ? { 'Content-Type': 'application/json' } : {}, body: body ? JSON.stringify(body) : undefined });
      } catch (e) {
        if (signal?.aborted) throw signal.reason || abortErr();
        return { status: 0, j: {} };
      }
      const j = await r.json().catch(() => ({}));
      if (signal?.aborted) throw signal.reason || abortErr();
      return { status: ctl.signal.aborted ? 0 : r.status, j };
    } finally { clearTimeout(timer); signal?.removeEventListener('abort', stop); }
  }

  /* One chunk. XHR rather than fetch: only XHR reports upload progress inside a chunk. Never rejects for HTTP
   * statuses; a lost connection resolves as status 0 so the caller reconciles. */
  function patch(url, blob, offset, onBytes, signal) {
    return new Promise((resolve, reject) => {
      if (signal?.aborted) return reject(signal.reason || abortErr());
      const x = new XMLHttpRequest();
      let stall = 0, done = false;
      const finish = v => { if (done) return; done = true; clearTimeout(stall); signal?.removeEventListener('abort', stop); resolve(v); };
      const arm = () => { clearTimeout(stall); stall = setTimeout(() => { try { x.abort(); } catch (e) {} finish({ status: 0, j: {} }); }, STALL_MS); };
      const stop = () => { done = true; clearTimeout(stall); try { x.abort(); } catch (e) {} reject(signal.reason || abortErr()); };
      x.open('PATCH', url);
      x.withCredentials = true;
      x.setRequestHeader('Content-Type', 'application/offset+octet-stream');
      x.setRequestHeader('Upload-Offset', String(offset));
      x.upload.onprogress = e => { arm(); onBytes(e.loaded); };
      x.onload = () => {
        let j = {}; try { j = JSON.parse(x.responseText || '{}'); } catch (e) {}
        const h = x.getResponseHeader('Upload-Offset');
        finish({ status: x.status, offset: h == null || h === '' ? NaN : Number(h), j });
      };
      x.onerror = x.ontimeout = () => finish({ status: 0, j: {} });
      x.onabort = () => { if (!done) finish({ status: 0, j: {} }); };
      signal?.addEventListener('abort', stop, { once: true });
      arm();
      x.send(blob);
    });
  }

  const transient = s => s === 0 || s === 408 || s === 425 || s === 429 || s >= 500 && s !== 507;
  /* Plain words for the Agent Service's refusals (server/uploads.mjs); never a bare status for a known code. */
  const TOO_LARGE = 'That file is too large for this Wizard.';
  const words = (s, j = {}) => {
    const e = String(j.error || '');
    if (s === 507 || e === 'insufficient_storage') return NO_SPACE;
    if (e === 'file_too_large' || s === 413) return TOO_LARGE;
    if (e === 'sha256_mismatch' || s === 422) return 'The file changed while uploading · attach it again.';
    if (s === 404 || s === 410) return 'The upload expired on your Wizard · attach the file again.';
    if (e === 'client_upload_id_conflict') return 'That upload clashed with an earlier one · attach the file again.';
    if (s === 400 && j.field === 'bytes') return 'Empty files can’t be attached.';
    return `Upload failed (${s}).`;
  };

  async function upload(file, { signal, onProgress } = {}) {
    const total = file.size, name = file.name || 'upload', mime = file.type || 'application/octet-stream';
    const report = (sent, state) => { try { onProgress && onProgress(Math.min(sent, total), total, state); } catch (e) {} };
    const clientId = newId();
    let fails = 0, lastMove = Date.now();
    const wait = async () => {
      if (Date.now() - lastMove > GIVE_UP_MS) throw userErr('Couldn’t reach your Wizard · the upload stopped. Try attaching again.');
      fails++;
      await sleep(backoff(fails), signal);
    };
    const space = s => { if (s === 507) throw userErr(NO_SPACE, { status: 507, code: 'insufficient_storage' }); };

    // 1) Create (idempotent on client_upload_id, so a retried POST returns the same upload).
    let up;
    for (;;) {
      const r = await call('POST', base(), { client_upload_id: clientId, filename: name, mime, bytes: total }, signal);
      space(r.status);
      if (r.status >= 200 && r.status < 300 && r.j && r.j.upload_id) { up = r.j; break; }
      if (!transient(r.status)) throw userErr(r.status === 404 || r.status === 405 ? `Wizard Files is unavailable (${r.status}).` : words(r.status, r.j), { status: r.status });
      report(0, 'reconnecting');
      await wait();
    }
    const url = `${base()}/${encodeURIComponent(up.upload_id)}`;
    const chunk = Math.max(MIN_CHUNK, Math.min(MAX_CHUNK, Number(up.chunk_bytes) || DEFAULT_CHUNK));
    let offset = Number(up.offset) || 0, status = up.status, receipt = up.file || null;
    let conflicts = 0;
    report(offset, 'uploading');

    // Ask the server where it got to (after a lost request, a restart, a 5xx).
    const reconcile = async () => {
      const r = await call('GET', url, null, signal);
      if (r.status === 200 && Number.isFinite(Number(r.j.offset))) {
        offset = Number(r.j.offset); status = r.j.status; if (r.j.file) receipt = r.j.file;
        return true;
      }
      if (r.status === 404) throw userErr('The upload expired on your Wizard · attach the file again.', { status: 404, code: 'expired' });
      return false;
    };

    for (;;) {
      // 2) Bytes, from the server's offset.
      while (status !== 'complete' && offset < total) {
        const end = Math.min(total, offset + chunk);
        const at = offset;
        const r = await patch(url, file.slice(at, end), at, n => report(at + n, 'uploading'), signal);
        if (r.status === 204 || r.status === 200) {
          offset = Number.isFinite(r.offset) && r.offset >= at ? r.offset : end;
          fails = 0; conflicts = 0; lastMove = Date.now();
          report(offset, 'uploading');
          continue;
        }
        if (r.status === 409 && Number.isFinite(Number(r.j.offset))) {
          // The server has a different byte count (an earlier chunk landed after all, or only partly): resume there.
          if (++conflicts > 20) throw userErr('The upload got out of step with your Wizard · attach the file again.');
          offset = Number(r.j.offset); report(offset, 'uploading');
          continue;
        }
        space(r.status);
        if (r.status === 404) throw userErr('The upload expired on your Wizard · attach the file again.', { status: 404, code: 'expired' });
        if (!transient(r.status)) throw userErr(words(r.status, r.j), { status: r.status, code: r.j.error || 'refused' });
        report(offset, 'reconnecting');
        await wait();
        try { if (await reconcile()) report(offset, 'uploading'); } catch (e) { throw e; }
      }
      // 3) Complete (idempotent): verifies the size and files it in Wizard Files.
      if (receipt && receipt.id) break;
      report(total, 'finishing');
      const r = await call('POST', `${url}/complete`, null, signal);
      if (r.status === 200 || r.status === 201) { receipt = r.j.file || r.j; if (receipt && receipt.id) break; throw new Error('Wizard Files returned an invalid upload receipt.'); }
      if (r.status === 409) { if (!(await reconcile())) await wait(); continue; } // not all bytes there: send the rest
      space(r.status);
      if (!transient(r.status)) throw userErr(words(r.status, r.j), { status: r.status, code: r.j.error || 'refused' });
      report(total, 'reconnecting');
      await wait();
    }
    report(total, 'finishing');
    return { id: String(receipt.id), name: String(receipt.filename || name), mime: String(receipt.mime || mime), bytes: Number(receipt.bytes) || total };
  }

  /* Send now, upload behind (James, 19 Oct 2026: "Don't block the user from being able to send their message
   * because an attachment is still uploading. Send the message and process it in the background.")
   * A tray/take row still uploading at the send tap becomes a placeholder file ref { id: 'pending:<key>' } that
   * rides every existing files path unchanged. The registry keeps the original bytes and the running upload; the
   * outbox stores the bytes with the message (IndexedDB) and, just before delivery, swaps each placeholder for the
   * real Wizard Files receipt: the running upload if it is still alive, else a fresh resumable upload of the bytes. */
  const PENDING = new Map(); // key → { row, blob, done }
  const PFX = 'pending:';
  const isPending = id => typeof id === 'string' && id.startsWith(PFX);
  /* A promise the row's uploader settles; attach before the upload starts. Non-enumerable: rows are spread/cloned.
   * A row reserved before its bytes exist (a screenshot being captured) is tracked at once with blob = null; the
   * capture's upload then settles that same promise. A retry after a failure gets a fresh one. */
  function track(row, blob) {
    const cur = row.upSettle;
    if (cur && !cur.settled) { if (blob) Object.defineProperty(row, 'upBlob', { value: blob, configurable: true, writable: true }); return cur; }
    let res, rej; const done = new Promise((a, b) => { res = a; rej = b; }); done.catch(() => {});
    const settle = { settled: false, ok: f => { settle.settled = true; res(f); }, fail: e => { settle.settled = true; rej(e); } };
    Object.defineProperty(row, 'upSettle', { value: settle, configurable: true, writable: true });
    Object.defineProperty(row, 'upDone', { value: done, configurable: true, writable: true });
    Object.defineProperty(row, 'upBlob', { value: blob || null, configurable: true, writable: true });
    return settle;
  }
  /* The ref a send takes for this row: the receipt when uploaded, a pending placeholder while it uploads (or
   * failed with its bytes still here), nothing when there is nothing to send. */
  function ref(row) {
    if (!row) return null;
    if (row.id && !row.uploading && !isPending(row.id)) return { id: row.id, name: row.name, mime: row.mime, bytes: row.bytes };
    if (isPending(row.id)) return { id: row.id, name: row.name, mime: row.mime, bytes: row.bytes };
    const blob = row.upBlob || row.local || row.file || null;
    const live = row.uploading && (row.upDone || blob instanceof Blob), retryable = row.error && blob instanceof Blob;
    if (!live && !retryable) return null;
    if (!row.pendingKey) Object.defineProperty(row, 'pendingKey', { value: (crypto.randomUUID ? crypto.randomUUID() : Date.now().toString(36) + Math.random().toString(36).slice(2)).replaceAll('-', ''), configurable: true });
    row.handedOff = true; // its own failure toast is moot now: the outbox owns retrying it
    PENDING.set(row.pendingKey, { row });
    return { id: PFX + row.pendingKey, name: row.name || blob?.name || 'file', mime: row.mime || blob?.type || '', bytes: row.bytes || blob?.size || 0 };
  }
  const blobOfRow = r => { const b = r && (r.upBlob || r.local || r.file); return b instanceof Blob ? b : null; };
  const blobOf = id => blobOfRow(PENDING.get(String(id).slice(PFX.length))?.row);
  const rowOf = id => PENDING.get(String(id).slice(PFX.length))?.row || null;
  async function uploadOnce(file) {
    const r = await fetch('/wizard/files/upload', { method: 'POST', credentials: 'same-origin', cache: 'no-store',
      headers: { 'Content-Type': 'application/octet-stream', 'X-Wizard-Filename': file.name || 'upload', 'X-Wizard-Mime': file.type || 'application/octet-stream' }, body: file });
    if (!r.ok) throw Object.assign(new Error(r.status === 413 ? TOO_LARGE : `Upload failed (${r.status}).`), { status: r.status, user: r.status !== 429 && r.status < 500 });
    const f = (await r.json()).file || {};
    if (!f.id) throw Object.assign(new Error('Wizard Files returned an invalid upload receipt.'), { status: 502 });
    return { id: String(f.id), name: String(f.filename || file.name), mime: String(f.mime || file.type || ''), bytes: Number(f.bytes) || file.size };
  }
  /* The receipt for a placeholder. stored: the bytes the outbox kept (after a reload the registry is empty).
   * Throws { permanent: true } when it can never upload (refused, too big, bytes gone). */
  async function settle(fileRef, stored) {
    const key = String(fileRef.id).slice(PFX.length), p = PENDING.get(key), row = p?.row;
    // The running upload first (read at settle time: a retry may have replaced it), then the kept bytes.
    if (row?.upDone && !(row.upSettle?.settled && row.error)) { try { const f = await row.upDone; if (f?.id) return f; } catch (_) { /* fall through to the bytes */ } }
    if (row?.id && !row.uploading && !isPending(row.id)) return { id: row.id, name: row.name, mime: row.mime, bytes: row.bytes };
    const blob = blobOfRow(row) || stored;
    if (!(blob instanceof Blob)) throw Object.assign(new Error('the file was lost before it uploaded'), { permanent: true });
    const file = blob instanceof File ? blob : new File([blob], fileRef.name || 'file', { type: fileRef.mime || blob.type || '' });
    try {
      const f = supported() ? await upload(file) : await uploadOnce(file);
      return f;
    } catch (e) {
      const s = Number(e.status) || 0;
      if (e.name === 'AbortError') throw e;
      if (s === 507 || (s >= 400 && s < 500 && s !== 408 && s !== 425 && s !== 429) ) throw Object.assign(e, { permanent: true });
      throw e;
    }
  }
  const forget = id => PENDING.delete(String(id).slice(PFX.length));
  const pending = { PFX, isPending, track, ref, blobOf, rowOf, settle, forget, _map: PENDING };

  window.WizUploads = { supported, upload, NO_SPACE, pending };
})();
