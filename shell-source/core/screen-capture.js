/* Explicit capture of this window: native main-frame-only port, or a desktop screen-share chooser.
 * Chrome is hidden at sampling, never while waiting for a chooser/upload. Cancellation owns its own cleanup. */
(() => {
  const pending = new Map();
  const abortError = signal => signal?.reason || new DOMException('Capture cancelled', 'AbortError');
  function close(id) {
    const p = pending.get(id); if (!p) return null;
    pending.delete(id); clearTimeout(p.timer); p.signal?.removeEventListener('abort', p.abort);
    p.release?.(); return p;
  }
  window.__wosScreenSample = id => {
    const p = pending.get(id); if (!p || p.signal?.aborted) return false;
    p.release = p.conceal?.();
    const rect = document.getElementById('dock')?.getBoundingClientRect();
    // Hidden workspace dock has top=0 in a pinned task: do not crop its capture to one pixel.
    const dock = rect?.width > 0 && rect?.height > 0 ? rect : null;
    return { width: innerWidth, height: innerHeight, contentHeight: Math.min(innerHeight, Math.max(1, dock?.top ?? innerHeight)) };
  };
  window.__wosScreenSampled = id => { const p = pending.get(id); p?.release?.(); if (p) p.release = null; };
  window.__wosScreenResult = (id, data, error) => {
    const p = close(id); if (!p) return;
    if (error || !/^data:image\/png;base64,/.test(data || '')) return p.reject(new Error(error || 'Screen capture failed'));
    try {
      const raw = atob(data.split(',')[1]);
      if (raw.length > 8 * 1024 * 1024) throw new Error('Screen capture too large');
      p.resolve(new File([Uint8Array.from(raw, c => c.charCodeAt(0))], 'screenshot-' + new Date().toISOString().replace(/[:.]/g, '-') + '.png', { type: 'image/png' }));
    } catch (e) { p.reject(e); }
  };
  const paint = () => new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r)));
  window.WosScreenCapture = {
    async capture({ signal, conceal } = {}) {
      if (signal?.aborted) throw abortError(signal);
      if (navigator.userActivation && !navigator.userActivation.isActive) throw new Error('Tap Screenshot to capture this app');
      const port = window.wizardScreenPort;
      if (typeof port?.postMessage === 'function') {
        const id = crypto.randomUUID().replace(/-/g, '');
        return new Promise((resolve, reject) => {
          const abort = () => { close(id); try { port.postMessage('cancel:' + id); } catch (e) {} reject(abortError(signal)); };
          const timer = setTimeout(() => { close(id); reject(new Error('Screen capture timed out · tap Screenshot again')); }, 12000);
          pending.set(id, { resolve, reject, timer, signal, abort, conceal });
          signal?.addEventListener('abort', abort, { once: true });
          try { port.postMessage(id); } catch (e) { close(id); reject(e); }
        });
      }
      if (!navigator.mediaDevices?.getDisplayMedia) throw new Error('This browser cannot capture a screen · use Attach or a supported screen-capture bridge');
      // User activation stays intact. A cancelled chooser may return later; close its stream then.
      const choice = navigator.mediaDevices.getDisplayMedia({ video: true, audio: false, preferCurrentTab: true });
      let abortListener;
      const cancel = new Promise((_, reject) => {
        abortListener = () => reject(abortError(signal)); signal?.addEventListener('abort', abortListener, { once: true });
      });
      const task = (async () => {
        const stream = await choice; let release;
        try {
          if (signal?.aborted) throw abortError(signal);
          const video = document.createElement('video'); video.srcObject = stream; video.muted = true;
          await video.play();
          if (signal?.aborted) throw abortError(signal);
          if (!video.videoWidth || !video.videoHeight) throw new Error('Screen capture has no image');
          release = conceal?.(); await paint();
          // Wait for an actual captured frame after hiding chrome, rather than sampling a stale pre-hide frame.
          if (video.requestVideoFrameCallback) await new Promise((resolve, reject) => {
            const t = setTimeout(() => reject(new Error('Screen capture has no fresh frame')), 2000);
            video.requestVideoFrameCallback(() => { clearTimeout(t); resolve(); });
          });
          if (signal?.aborted) throw abortError(signal);
          const scale = Math.min(1, 1600 / Math.max(video.videoWidth, video.videoHeight));
          const canvas = document.createElement('canvas'); canvas.width = Math.round(video.videoWidth * scale); canvas.height = Math.round(video.videoHeight * scale);
          canvas.getContext('2d').drawImage(video, 0, 0, canvas.width, canvas.height);
          release?.(); release = null;
          const blob = await new Promise(r => canvas.toBlob(r, 'image/png'));
          if (!blob) throw new Error('Screen capture failed');
          return new File([blob], 'screenshot-' + Date.now() + '.png', { type: 'image/png' });
        } finally { release?.(); stream.getTracks().forEach(t => t.stop()); }
      })();
      try { return await Promise.race([task, cancel]); }
      finally { signal?.removeEventListener('abort', abortListener); }
    }
  };
})();
