/* Common browser capture accessories. A take owns its uploads, not the current window. */
(() => {
  'use strict';
  const AWAKE = { want: false, lock: null, pending: false };
  async function requestWakeLock() {
    if (!AWAKE.want || AWAKE.lock || AWAKE.pending || document.hidden || !navigator.wakeLock) return;
    AWAKE.pending = true;
    try { const l = await navigator.wakeLock.request('screen'); if (!AWAKE.want) { l.release(); return; } AWAKE.lock = l; l.addEventListener('release', () => { if (AWAKE.lock === l) AWAKE.lock = null; }); } catch (_) {} finally { AWAKE.pending = false; }
  }
  function awake(on) {
    AWAKE.want = !!on;
    try { if (typeof window.WizardOSNative?.keepAwake === 'function') { window.WizardOSNative.keepAwake(!!on); return; } } catch (_) {}
    if (on) requestWakeLock(); else { const l = AWAKE.lock; AWAKE.lock = null; l?.release().catch(() => {}); }
  }
  document.addEventListener('visibilitychange', () => { if (!document.hidden) requestWakeLock(); });
  async function uploadRow(upload, file, row, { signal, active = () => true, changed = () => {} } = {}) {
    const controller = row.abort || new AbortController(); row.abort = controller;
    const cancel = () => { if (!row.handedOff) controller.abort(signal?.reason); }; // a sent row finishes for its message
    signal?.addEventListener('abort', cancel, {once:true});
    if (signal?.aborted) cancel();
    let deadline; const arm = () => { clearTimeout(deadline); deadline=setTimeout(()=>controller.abort(new Error('Upload timed out · retry the original file')),60000); };
    arm(); row.uploading=true; row.local=file;changed();
    // A send never waits for this row: it takes a pending placeholder and the outbox collects this result (or
    // re-uploads the kept bytes). Any sign of life, including a reconnect attempt, re-arms the no-progress deadline.
    const settle=window.WizUploads?.pending?.track(row,file);
    try { const result=await upload(file,{signal:controller.signal,onProgress:()=>arm()}); settle?.ok(result); if(!active())return;Object.assign(row,result,{uploading:false});delete row.local;delete row.error; }
    catch(e) { settle?.fail(e); if(active())Object.assign(row,{uploading:false,error:String(controller.signal.reason?.message||e.message||e)}); }
    finally { clearTimeout(deadline); signal?.removeEventListener('abort',cancel);delete row.abort;if(active())changed(); }
  }
  function take(upload, changed = () => {}) {
    const files = [], abort = new AbortController(); let closed = false;
    const active = row => !closed && files.includes(row);
    const row = file => { if(closed)return null;if(files.length>=8)throw Error('Up to 8 files per message');const r={name:file.name,mime:file.type,bytes:file.size,uploading:true};files.push(r);changed(files);return r; };
    const put = (file,r) => uploadRow(upload,file,r,{signal:abort.signal,active:()=>active(r),changed:()=>changed(files)});
    async function add(file) { const r=row(file);if(r)await put(file,r); }
    return { files, add, async screenshot(conceal) {
      const r=row({name:'Screenshot',type:'image/png',size:0});if(!r)return;
      // Reserved and tracked before capture: a send now takes it as pending and it follows the message.
      const st=window.WizUploads?.pending?.track(r,null);
      try { const file=await window.WosScreenCapture.capture({signal:abort.signal,conceal});if(!active(r)&&!r.handedOff){st?.fail(new Error('Screenshot cancelled'));return;}Object.assign(r,{name:file.name,mime:file.type,bytes:file.size});await put(file,r); }
      catch(e) { st?.fail(e);if(active(r)){files.splice(files.indexOf(r),1);changed(files);}throw e; }
    },
      ready: () => files.every(f => !f.uploading && !f.error && f.id),
      retry(r) { if (!r.local || !active(r)) return;return put(r.local,r); },
      remove(r) { if (r.uploading) return;const i=files.indexOf(r);if(i>=0)files.splice(i,1);changed(files); },
      close() { closed=true;abort.abort(); },get closed(){return closed;} };
  }
  function setPaused(rec, on) { const from=on?'recording':'paused';if(rec?.state!==from)return false;try { on?rec.pause():rec.resume();return true; }catch(_){return false;} }
  window.WosCaptureTools = { awake, take, uploadRow, setPaused, get awakeWanted() { return AWAKE.want; }, screenshotAvailable: () => !!(window.wizardScreenPort?.postMessage || navigator.mediaDevices?.getDisplayMedia) };
})();
