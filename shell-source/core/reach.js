/* Failure-only connectivity diagnosis, independent of Agent Service/Hermes.
 * No healthy polling: consumers call failure() only while a read/send is failing.
 */
(() => {
  'use strict';
  const order = ['gateway', 'signin', 'shell', 'agent-service', 'hermes'];
  // Browser onLine is only a scheduling hint, never evidence of absent internet.
  let epoch = 0;
  const result = (layer, message, short) => ({ layer, message, short, action: 'troubleshoot' });
  const RECONNECTING = 'Reconnecting…';
  const pending = result('checking', 'Checking the connection to Wizard. Messages are kept on this device while we retry.', RECONNECTING);
  let cached = null, cachedAt = 0, work = null, failureAt = -Infinity;
  async function request(url, options = {}, json = false) {
    const controller = new AbortController(); let timer;
    try {
      return await Promise.race([
        (async () => { const response = await fetch(url, { cache: 'no-store', credentials: 'same-origin', ...options, signal: controller.signal }); return json ? { response, body: response.ok ? await response.json() : null } : response; })(),
        new Promise((_, reject) => { timer = setTimeout(() => { reject(Object.assign(new Error('Diagnosis timed out'), { code: 'diagnosis_timeout' })); controller.abort(); }, 4000); }),
      ]);
    } finally { clearTimeout(timer); }
  }
  async function probe(observedPing) {
    let ping;
    try { ping = observedPing || await request('/troubleshoot/api/ping'); }
    catch (_) {
      // Success is positive evidence; failure (including CSP blocking) is unknown.
      const net = await internetProbe();
      const ts = /\.ts\.net$/i.test(String(location.hostname || ''));
      return result(ts ? 'tailscale' : 'unreachable', connectionHelp(net.ok, ts), 'Can’t reach Wizard · retrying');
    }
    // An HTTP error proves the server is reachable; never blame the device/VPN.
    if (!ping.ok) return result('gateway', `Wizard’s gateway answered (${ping.status}), but Troubleshooter isn’t available. Messages are kept while we retry.`, RECONNECTING);
    try {
      const { response, body } = await request('/troubleshoot/api/status', {}, true);
      if (!response.ok || !Array.isArray(body.checks)) throw new Error('Invalid status');
      // Repair-chat engine probes (reply-claude/chatgpt/tinfoil) say whether Troubleshooter's own AI can answer;
      // they never explain why Wizard is unreachable, so the connection pill must not blame them (James, 27 Oct).
      const relevant = check => !check.ok && !check.skipped && !String(check.id || '').startsWith('reply-');
      const failed = body.checks.filter(relevant).sort((a, b) => {
        const rank = id => order.includes(id) ? order.indexOf(id) : order.length;
        return rank(a.id) - rank(b.id);
      })[0];
      if (failed) {
        const labels = { gateway: 'Wizard’s gateway isn’t responding.', signin: 'Wizard sign-in needs attention.', shell: 'Wizard’s shell isn’t responding.', 'agent-service': 'Wizard’s Agent Service isn’t answering right now.', hermes: 'Your agent (Hermes) isn’t answering right now.' };
        const message = labels[failed.id], selfHeals = ['agent-service', 'hermes'].includes(failed.id);
        // While we are retrying, the one-line pill says what is happening (reconnecting), not an alarm; the
        // unfolded line names the layer. Only sign-in asks the owner to act (James, 27 Oct).
        const short = failed.id === 'signin' ? 'Sign-in needs attention · retrying' : RECONNECTING;
        return result(failed.id, message ? message + (selfHeals ? ' It usually comes back on its own within a minute; messages wait and send afterwards. Open Troubleshooter if it doesn’t.' : ' Open Troubleshooter to check it.') : `${failed.label || failed.id}: ${failed.detail || 'Needs attention'}`, short);
      }
      if (body.overall === 'down') return result('wizard', body.summary || 'Wizard reports a problem. Open Troubleshooter to check it.', RECONNECTING);
    } catch (e) {
      if (e?.code === 'diagnosis_timeout') return result('busy', 'Your Wizard is busy and answering slowly. Messages are kept on this device and send by themselves.', RECONNECTING);
      return result('diagnosis', 'Wizard’s gateway is reachable, but its health report isn’t available. Open Troubleshooter to check it. Messages are kept while we retry.', RECONNECTING); }
    // Healthy probes prove reachability, not why a separate read/send failed or
    // whether anything was admitted. The shared result stays request-neutral;
    // label('send') alone words it as a saved message (PR689 review).
    return result('send', 'Wizard’s connection checks passed. Retrying automatically; these checks don’t show whether the request went through.', 'Wizard reachable · retrying');
  }
  /** The one short line for a failing request. operation is 'send' (a saved outbound message, count of them) or
   *  'read'. Only a confirmed-healthy diagnosis differs: a send names the unsent message instead of the connection,
   *  a read stays neutral. Any real outage, or no diagnosis yet, keeps its connection wording for both. */
  function label(operation, { count = 1, diagnosis } = {}) {
    const d = diagnosis || window.WizReach.failure();
    if (operation === 'send' && d.layer === 'send') return count > 1 ? `${count} messages not sent · retrying` : 'Message not sent · retrying';
    return d.short;
  }
  function publish(value, generation) {
    if (generation !== epoch) return value;
    const changed = JSON.stringify(value) !== JSON.stringify(cached);
    cached = value; cachedAt = Date.now();
    if (changed) window.dispatchEvent(new Event('wizreachchange'));
    return value;
  }
  function diagnose(maxAge = 10000, observedPing) {
    if (work && maxAge !== 0) return work;
    if (cached && Date.now() - cachedAt < maxAge) return Promise.resolve(cached);
    const generation = ++epoch;
    const next = probe(observedPing).then(value => publish(value, generation)).finally(() => { if (work === next) work = null; });
    work = next; return next;
  }
  /* The three checks the offline pop-up shows (core/status.js), run only while something is already failing:
   *   internet   one tiny request to Tailscale's own connectivity check (a 204 with no body; this device already
   *              talks to Tailscale). The only cross-site request the shell makes; CSP allows exactly this URL.
   *   tailscale  does Wizard's address answer at all (any HTTP answer counts)?
   *   wizard     is Wizard healthy once reached (its own status report, the same diagnosis as above)?
   * Each is { state: 'ok'|'slow'|'bad'|'wait'|'skip', ms, detail }. A slow answer is timed, never a speed test:
   * no megabytes on the connections this exists for. */
  const INTERNET = 'https://derp1.tailscale.com/generate_204', SLOW_MS = 1500;
  const now = () => (typeof performance !== 'undefined' && performance.now ? performance.now() : Date.now());
  async function timed(run) {
    const t = now();
    try { const r = await run(); return { ok: true, ms: Math.round(now() - t), r }; }
    catch (_) { return { ok: false, ms: Math.round(now() - t) }; }
  }
  const secs = ms => ms >= 1000 ? `${(ms / 1000).toFixed(1)} s` : `${ms} ms`;
  const slowLink = () => ['slow-2g', '2g'].includes(navigator.connection?.effectiveType);
  const connectionHelp = (internet, ts) => (internet ? 'Internet works, but we can’t reach your Wizard. ' : 'Can’t reach your Wizard. Check this device’s internet connection. ')
    + (ts ? 'Open the Tailscale app and check it’s connected and signed in to the same account as your Wizard. Check that the computer running your Wizard is on. ' : 'Check that the computer running your Wizard is on. ')
    + 'Messages stay saved on this device and send when the connection returns.';
  async function internetProbe() {
    return timed(async () => {
      // Cross-origin no-cors + redirect=error/manual is a Fetch network error even
      // for a nonredirecting 204. CSP still confines this credential-free request.
      const r = await request(INTERNET, { mode: 'no-cors', credentials: 'omit', redirect: 'follow' });
      if (!r.ok && r.type !== 'opaque') throw Error('Public check not confirmed');
      return r;
    });
  }
  async function checks() {
    // Only publish observations from the latest check. A newer focus/network/read check supersedes this one.
    const generation = ++epoch;
    const [net, ping] = await Promise.all([
      internetProbe(), timed(() => request('/troubleshoot/api/ping')),
    ]);
    const ts = /\.ts\.net$/i.test(String(location.hostname || ''));
    const out = { tailnet: ts, hostReachable: ping.ok };
    const speed = r => (r.ms > SLOW_MS || slowLink()) ? { state: 'slow', ms: r.ms, detail: `Slow · ${secs(r.ms)}` } : { state: 'ok', ms: r.ms, detail: `Working · ${secs(r.ms)}` };
    out.internet = net.ok ? speed(net) : { state: 'skip', ms: 0, detail: 'Unknown · public check didn’t answer' };
    if (ping.ok) {
      out.tailscale = { ...speed(ping), detail: `Wizard’s address answered · ${secs(ping.ms)}` };
      const d = await probe(ping.r);
      publish(d, generation);
      out.wizard = d.layer === 'send' ? { state: 'ok', ms: 0, detail: 'Healthy' } : d.layer === 'busy' ? { state: 'slow', ms: 0, detail: 'Busy · answering slowly', layer: 'busy' } : { state: 'bad', ms: 0, detail: d.message, layer: d.layer };
      out.help = d.message;
    } else {
      out.tailscale = { state: 'bad', ms: 0, detail: ts ? 'Not confirmed · check Tailscale' : 'Can’t reach your Wizard’s address' };
      out.wizard = { state: 'wait', ms: 0, detail: 'Waiting for the connection' };
      out.help = connectionHelp(net.ok, ts);
      publish(result(ts ? 'tailscale' : 'unreachable', out.help, 'Can’t reach Wizard · retrying'), generation);
    }
    out.stale = generation !== epoch;
    return out;
  }
  const esc = s => String(s || '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  // Local entry is part of the cached shell, not a second app or a remote preflight.
  function recoveryHtml() {
    return `<section class="wz-recovery" data-recovery><details open><summary>Connection help</summary><div class="wz-recovery-help"><h2>Can’t reach your Wizard?</h2><p data-recovery-message>Check this device’s internet connection. On a Tailscale address, open the Tailscale app and check it’s connected. Your saved chats stay on this device.</p><ul class="wz-list" data-recovery-rows><li class="wz-row">Internet · Not checked</li><li class="wz-row">Your Wizard’s connection · Not checked</li><li class="wz-row">Wizard · Not checked</li></ul><button type="button" class="wz-button" data-recovery-check>Check again</button><p data-recovery-remote>Repair buttons and repair chat need a connection to your Wizard. Local connection help is available here.</p></div></details><iframe class="appframe" data-own-app="troubleshooter" title="Troubleshooter" hidden allow="clipboard-read; clipboard-write" referrerpolicy="same-origin"></iframe></section>`;
  }
  const recoveries = new Set();
  function mountRecovery(root, url) {
    if (!root || root._recovery) return;
    // Provider reconnect links carry their sign-in workflow in this query. Keep it through local-first checks.
    const target = typeof url === 'string' && /^\/troubleshoot\/(?:[?#]|$)/.test(url) ? url : '/troubleshoot/';
    root._recovery = true;
    const frame = root.querySelector('iframe'), details = root.querySelector('details'), button = root.querySelector('[data-recovery-check]');
    let serial = 0, timer, remoteReady = false, remoteLoading = false, last;
    const connected = () => root.isConnected;
    const remoteMessage = text => { root.querySelector('[data-recovery-remote]').textContent = text; };
    frame.addEventListener('load', () => {
      if (!frame.getAttribute('src')) return; // initial about:blank is not a failed repair-page load
      remoteLoading = false;
      try {
        const doc = frame.contentDocument;
        if (!connected() || !last?.hostReachable || !doc || !/\/troubleshoot\//.test(doc.location.pathname) || !doc.querySelector('header h1')) throw Error('Repair page unavailable');
        remoteReady = true; frame.hidden = false; root.classList.add('repair-ready'); details.open = false;
        if (last.wizard.state === 'ok') clearTimeout(timer);
        remoteMessage('Connected. The repair home and repair chat are below.');
      } catch (_) { frame.hidden = true; remoteReady = false; root.classList.remove('repair-ready'); details.open = true; remoteMessage('The repair page didn’t load. Local connection help is still available.'); }
    });
    async function run() {
      if (!connected()) { clearTimeout(timer); recoveries.delete(run); return; }
      const id = ++serial; clearTimeout(timer); button.disabled = true; button.textContent = 'Checking…';
      const c = await checks();
      if (!connected() || id !== serial) return;
      if (c.stale) { timer = setTimeout(run, 0); return; }
      last = c; button.disabled = false; button.textContent = 'Check again';
      root.querySelector('[data-recovery-message]').textContent = c.help;
      root.querySelector('[data-recovery-rows]').innerHTML = [['internet', 'Internet'], ['tailscale', c.tailnet ? 'Tailscale / private connection' : 'Your Wizard’s connection'], ['wizard', 'Wizard']].map(([key, title]) => `<li class="wz-row" data-recovery-row="${key}"><span class="wz-main"><b>${esc(title)}</b><small>${esc(c[key].detail)}</small></span></li>`).join('');
      if (c.hostReachable && !remoteReady && !remoteLoading) {
        remoteLoading = true;
        // A host HTTP error is not proof the repair page loaded. Keep help visible until its actual document loads.
        request(target, { method: 'HEAD' }).then(r => {
          if (!connected() || id !== serial) { remoteLoading = false; return; }
          if (!r.ok) throw Error('Repair page unavailable');
          frame.src = target;
        }).catch(() => { remoteLoading = false; remoteMessage('The repair page isn’t available yet. Local connection help is still available.'); });
      }
      if (!c.hostReachable) { frame.hidden = true; remoteReady = false; remoteLoading = false; root.classList.remove('repair-ready'); details.open = true; remoteMessage('Repair buttons and repair chat need a connection to your Wizard. Local connection help is available here.'); }
      if (c.wizard.state === 'ok') window.WizLive?.refresh?.();
      // Only the open failing recovery window polls; healthy checks stop. Outbox retains sole retry ownership.
      if (c.wizard.state !== 'ok' || !remoteReady) timer = setTimeout(run, 15000);
    }
    button.addEventListener('click', run);
    recoveries.add(run);
    // Mount and paint the ordinary window before any diagnostic work starts.
    requestAnimationFrame(() => setTimeout(run, 0));
  }
  if (typeof addEventListener === 'function') {
    for (const event of ['online', 'offline', 'focus', 'visibilitychange']) addEventListener(event, () => {
      ++epoch; cachedAt = 0; work = null;
      if (!document.hidden) for (const run of recoveries) run();
      if (!recoveries.size && cached && cached.layer !== 'send') diagnose(0);
    });
  }
  window.WizReach = {
    diagnose,
    recoveryHtml,
    mountRecovery,
    checks,
    label,
    failure() {
      if (Date.now() - failureAt >= 15000) { failureAt = Date.now(); diagnose(); }
      return cached || pending;
    },
    // Troubleshooter is an ordinary built-in app: open it in a shell window like any other app. Leaving the shell
    // for the bare page is only the last resort, when the shell can't open windows at all.
    open() {
      try { if (window.WizOpenApp?.('troubleshooter')) return true; } catch (e) {}
      if (document.documentElement.dataset.shell === 'desktop') window.open('/troubleshoot/', '_blank', 'noopener');
      else location.assign('/troubleshoot/');
      return true;
    },
  };
})();
