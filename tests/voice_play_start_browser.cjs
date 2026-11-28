// Issue 502: a received voice note starts within a second of the tap and always plays, also while another
// player (Wizard Music) is going in another frame, also at 1.5x/2x, and also when the shared AudioContext is stuck
// in 'suspended' (WebKit after a Bluetooth route change, the app in the background, another media session).
// It serves the real static view and a real 6:15 Ogg Opus note (mono 48 kHz, about 1.5 MB, like the Telegram note
// in the issue) from a small HTTP server with Range and a delay per request, then times tap -> first sound:
// a voice <audio> element whose currentTime moves, or a Web Audio source started on a context that is running and
// whose clock moves past the source's start. It also records the longest main-thread stall after the tap.
// PLAYWRIGHT_MODULE=... [BROWSER=webkit] [FFMPEG=ffmpeg] [BEFORE=1 STATIC_DIR=<main>/static] [ONLY=<label>] node tests/voice_play_start_browser.cjs [outdir]
const pw = require(process.env.PLAYWRIGHT_MODULE || 'playwright'), BROWSER = process.env.BROWSER || 'chromium';
const fs = require('node:fs'), path = require('node:path'), os = require('node:os'), http = require('node:http'), assert = require('node:assert/strict');
const {execFileSync} = require('node:child_process');
const BEFORE = process.env.BEFORE === '1';
const root = path.resolve(process.env.STATIC_DIR || path.join(__dirname, '../static')), out = path.resolve(process.argv[2] || 'voice-play-start-shots');
const L = require(path.join(__dirname, '../static/app.js'));
fs.mkdirSync(out, {recursive: true});
const TYPES = {'.js': 'application/javascript', '.css': 'text/css', '.html': 'text/html', '.svg': 'image/svg+xml', '.png': 'image/png'};
const LATENCY = Number(process.env.LATENCY || 60), BYTES_PER_S = Number(process.env.BANDWIDTH || 4e6);
const SECONDS = 375;
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'voice502-'));
const ffmpeg = process.env.FFMPEG || 'ffmpeg';
// Speech-like: a pitch that wanders plus noise, so Opus spends about 32 kbit/s on it (1.5 MB for 6:15).
const note = path.join(dir, 'note.ogg'), music = path.join(dir, 'music.ogg');
execFileSync(ffmpeg, ['-loglevel', 'error', '-y', '-f', 'lavfi', '-i', `aevalsrc='0.4*sin(2*PI*(180+60*sin(2*PI*0.7*t))*t)':s=48000:d=${SECONDS}`,
  '-f', 'lavfi', '-i', `anoisesrc=color=pink:amplitude=0.08:d=${SECONDS}:r=48000`, '-filter_complex', 'amix=inputs=2', '-ac', '1', '-ar', '48000',
  '-c:a', 'libopus', '-b:a', '32k', '-vbr', 'off', note]);
execFileSync(ffmpeg, ['-loglevel', 'error', '-y', '-f', 'lavfi', '-i', 'sine=frequency=330:d=600', '-c:a', 'libopus', '-b:a', '64k', music]);
const NOTE = fs.readFileSync(note), MUSIC = fs.readFileSync(music);
const now = Date.now(), min = 60e3;
const person = {id: 'ann', display_name: 'Ann Lee', identities: [{id: 'ann-i', network: 'telegram', kind: 'person', label: 'Ann Lee'}], labels: [], unread: 0, muted: false, low_priority: false, last: {text: 'Voice message', timestamp: now - min, outgoing: false, msgtype: 'm.audio'}, language: '', peer_read_ts: 0};
const MESSAGES = [{id: '$voice', identity_id: 'ann-i', network: 'telegram', sender: 'Ann Lee', outgoing: false, original: '', timestamp: now - min, timeline_order: 1, msgtype: 'm.audio', media: {voice: true, mime: 'audio/ogg', duration: SECONDS * 1000, size: NOTE.length}, reactions: []}];
const PHONE_UA = 'Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0 Mobile Safari/537.36';
const MAC_UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.1 Safari/605.1.15';
const wait = ms => new Promise(r => setTimeout(r, ms));

function server(log) {
  const ownKey = '11'.repeat(32), identity = {account_id: ownKey, npub: L.encodePublic(ownKey), display_name: 'Owner'};
  return http.createServer(async (req, res) => {
    const url = new URL(req.url, 'http://x'), p = url.pathname.slice(1);
    const ok = result => { res.writeHead(200, {'Content-Type': 'application/json'}); res.end(JSON.stringify({ok: true, result})); };
    if (p === 'api/view/session') return ok({authenticated: true, csrf_token: 'fixture'});
    if (p === 'api/view/switches') { res.writeHead(200, {'Content-Type': 'application/json'}); return res.end(JSON.stringify({contract: 'wizard.app-switches/1', switches: []})); }
    if (p === 'api/status') return ok({state: 'ready', account_configured: true});
    if (p === 'api/identity') return ok({identity});
    if (p === 'api/contacts') return ok({contacts: []});
    if (p === 'api/invites') return ok({invites: []});
    if (p === 'api/dms') return ok({dms: []});
    if (p === 'api/unified/people') return ok({people: [person], seq: 5});
    if (p === 'api/unified/groups') return ok({groups: [], seq: 5});
    if (p === 'api/unified/people/ann') return ok({person, messages: MESSAGES, has_more: false, next_cursor: null, seq: 5, typing: []});
    if (p === 'music.ogg' || p.startsWith('api/unified/media/')) {
      const body = p === 'music.ogg' ? MUSIC : NOTE;
      // The box's Range rules (web.py _blob), over a link with a delay per request and a bandwidth cap.
      const size = body.length, m = /^bytes=(\d*)-(\d*)$/.exec(req.headers.range || '');
      let start = 0, end = size - 1, status = 200;
      if (m) { if (m[1]) { start = +m[1]; end = m[2] ? Math.min(+m[2], size - 1) : size - 1; } else if (m[2]) start = Math.max(0, size - +m[2]); status = 206; }
      if (body === NOTE) log.push({at: Date.now(), range: req.headers.range || '', start});
      await wait(LATENCY);
      const head = {'Content-Type': 'audio/ogg', 'Content-Length': end - start + 1, 'Accept-Ranges': 'bytes'};
      if (status === 206) head['Content-Range'] = `bytes ${start}-${end}/${size}`;
      res.writeHead(status, head);
      let at = start, closed = false;
      res.on('close', () => { closed = true; });
      while (at <= end && !closed) {
        const n = Math.min(32768, end - at + 1);
        res.write(body.subarray(at, at + n)); at += n;
        await wait(n / BYTES_PER_S * 1000);
      }
      return res.end();
    }
    if (p.startsWith('api/unified/updates')) { await wait(20000); return ok({seq: 5}); }
    if (p.startsWith('api/')) return ok({});
    const file = path.join(root, p || 'index.html');
    if (!file.startsWith(root) || !fs.existsSync(file)) { res.writeHead(404); return res.end(); }
    res.writeHead(200, {'Content-Type': TYPES[path.extname(file)] || 'application/octet-stream'});
    res.end(fs.readFileSync(file));
  });
}

// Runs in the page before Messenger: a stand-in WizardApp, the sound clock, and (stuck) a first AudioContext
// that stays 'suspended' whatever is asked of it, with a clock that never moves.
function probe(opts) {
  const {stuck, rate} = opts;
  if (rate) try { localStorage.setItem('messenger.voice.rate', String(rate)); } catch {}
  const noop = () => {};
  window.WizardApp = {ready: noop, update: {hold: () => ({release: noop})}, back: {register: noop}, on: noop, nav: {}, toast: noop, badge: {set: noop}, audio: {duck: () => Promise.resolve(false)}};
  const mark = () => { const r = document.documentElement; if (!r) return false; r.dataset.wzHosted = ''; return true; };
  if (!mark()) new MutationObserver((_, o) => { if (mark()) o.disconnect(); }).observe(document, {childList: true});
  const c = window.__clock = {sources: [], elements: [], contexts: 0, stall: 0, path: ''};
  const AC = window.AudioContext;
  window.AudioContext = function (...a) {
    const ctx = new AC(...a); c.contexts++;
    if (stuck && c.contexts === 1) {
      Object.defineProperty(ctx, 'state', {get: () => 'suspended'});
      Object.defineProperty(ctx, 'currentTime', {get: () => 0});
      ctx.resume = () => new Promise(noop);
      ctx.suspend().catch(noop);
    }
    return ctx;
  };
  window.AudioContext.prototype = AC.prototype;
  const start = AudioBufferSourceNode.prototype.start, play = HTMLMediaElement.prototype.play;
  AudioBufferSourceNode.prototype.start = function (when = 0, ...rest) { c.sources.push({ctx: this.context, when: Math.max(when, this.context.currentTime), at: when, offset: rest[0] || 0, length: rest[1] ?? this.buffer.duration - (rest[0] || 0)}); return start.call(this, when, ...rest); };
  if (opts.noOgg) { const can = HTMLMediaElement.prototype.canPlayType; HTMLMediaElement.prototype.canPlayType = function (t) { return /ogg/.test(t) ? '' : can.call(this, t); }; }
  if (opts.badElement) HTMLMediaElement.prototype.play = function () { if (this.dataset?.music) return play.call(this); c.elements.push(this); return Promise.reject(new DOMException('no', 'NotSupportedError')); };
  if (opts.frozen) { const desc = Object.getOwnPropertyDescriptor(BaseAudioContext.prototype, 'currentTime'); let first = null; Object.defineProperty(BaseAudioContext.prototype, 'currentTime', {configurable: true, get() { first ||= this; const t = desc.get.call(this); return this === first ? Math.min(t, 0.05) : t; }}); }
  if (!opts.badElement) HTMLMediaElement.prototype.play = function () { if (!this.dataset?.music) c.elements.push(this); return play.call(this); };
  document.addEventListener('pointerdown', e => { if (e.target.closest?.('.u-vplay')) c.tap = performance.now(); }, true);
  let last = 0;
  const tick = () => {
    const t = performance.now();
    if (c.tap && !c.sound && last) c.stall = Math.max(c.stall, t - last);
    last = t;
    if (c.tap && !c.sound) {
      const el = c.elements.find(e => !e.paused && e.currentTime > 0.05);
      const src = c.sources.find(s => s.ctx.state === 'running' && s.ctx.currentTime > s.when + 0.05);
      if (el) { c.sound = t; c.path = 'element'; c.elRate = el.playbackRate; c.pitch = el.preservesPitch; }
      else if (src) { c.sound = t; c.path = 'webaudio'; }
    }
    setTimeout(tick, 10);
  };
  tick();
}

async function run(browser, {label, phone, rate = 1, stuck = false, noOgg = false, badElement = false, frozen = false, then}) {
  const log = [], srv = server(log);
  await new Promise(r => srv.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${srv.address().port}/`;
  const ctx = await browser.newContext(phone
    ? {viewport: {width: 412, height: 860}, deviceScaleFactor: 2, isMobile: true, hasTouch: true, colorScheme: 'dark', userAgent: PHONE_UA}
    : {viewport: {width: 1280, height: 860}, colorScheme: 'dark', userAgent: MAC_UA});
  await ctx.addInitScript(probe, {stuck, rate, noOgg, badElement, frozen});
  const page = await ctx.newPage(), errors = [];
  page.on('pageerror', e => errors.push(e.message));
  await page.goto(base);
  // Wizard Music is playing in another frame the whole time.
  await page.evaluate(src => { const f = document.createElement('iframe'); f.style.cssText = 'position:fixed;width:1px;height:1px;opacity:0'; f.srcdoc = `<audio data-music="1" src="${src}" loop autoplay></audio>`; document.documentElement.append(f); }, base + 'music.ogg');
  await page.locator('.u-person', {hasText: 'Ann Lee'}).first().click({timeout: 20000});
  const play = page.locator('.u-vplay').first();
  await play.waitFor({timeout: 15000});
  // The owner reads the chat for a moment before tapping, as people do.
  await page.waitForTimeout(Number(process.env.READ_MS || 1500));
  const musicOn = await page.evaluate(() => { const a = document.querySelector('iframe')?.contentDocument?.querySelector('audio'); return !!a && !a.paused && a.currentTime > 0; });
  const b = await play.boundingBox();
  if (phone) await page.touchscreen.tap(b.x + b.width / 2, b.y + b.height / 2); else await page.mouse.click(b.x + b.width / 2, b.y + b.height / 2);
  await page.waitForFunction(() => window.__clock.sound, null, {timeout: 15000}).catch(() => {});
  await page.waitForTimeout(1200);
  const clock = await page.evaluate(() => { const c = window.__clock, el = c.elements[c.elements.length - 1]; return {tap: c.tap, sound: c.sound, path: c.path, stall: Math.round(c.stall), contexts: c.contexts, elRate: c.elRate, pitch: c.pitch, elements: c.elements.length, elementTime: el ? el.currentTime : 0, playing: !!document.querySelector('.u-voice.playing'), loading: !!document.querySelector('.u-voice.loading')}; });
  const extra = then ? await then(page, play) : {};
  const musicStill = await page.evaluate(() => { const a = document.querySelector('iframe')?.contentDocument?.querySelector('audio'); return !!a && !a.paused; });
  await page.screenshot({path: path.join(out, `${BEFORE ? 'before' : 'after'}-${label}.png`)});
  await ctx.close(); srv.close();
  const result = {label, before: BEFORE, phone, rate, stuck, musicOn, musicStill, tapToSoundMs: clock.sound ? Math.round(clock.sound - clock.tap) : null, ...clock, noteRequests: log.length, errors, ...extra};
  delete result.tap; delete result.sound;
  return result;
}

// What the bubble says is left of the note, in seconds.
const left = page => page.locator('.u-voice .u-dur').first().textContent().then(t => { const [m, sec] = t.trim().split(':').map(Number); return m * 60 + sec; });
const seek = async (page, f) => { const w = await page.locator('.u-voice .u-wave').first().boundingBox(); await page.mouse.click(w.x + w.width * f, w.y + w.height / 2); };
// Web Audio pieces scheduled since `from`, on the context that plays now: each must start where the one before ends.
const gaps = (page, from) => page.evaluate(from => { const all = window.__clock.sources.slice(from), ctx = all[all.length - 1]?.ctx; const s = all.filter(x => x.ctx === ctx); return {pieces: s.length, worst: s.slice(1).reduce((w, x, i) => Math.max(w, Math.abs(x.at - (s[i].at + s[i].length))), 0)}; }, from);
const playingNow = page => page.locator('.u-voice.playing').count().then(n => n > 0);
// Across the end of the first part (the first 160 KB, about 40 s of this note) into the whole note.
const seam = rate => async page => {
  const from = await page.evaluate(() => window.__clock.sources.length);
  await seek(page, 36 / SECONDS); await page.waitForTimeout(8000 / rate);
  return {seamLeft: await left(page), seamWant: SECONDS - 36 - 8, seamPlaying: await playingNow(page), seamGaps: await gaps(page, from)};
};
const pauseResume = async (page, play) => {
  await page.waitForTimeout(1000); await play.click(); await page.waitForTimeout(300);
  const paused = await left(page); await page.waitForTimeout(1200);
  const still = await left(page), stopped = !(await playingNow(page));
  await play.click(); await page.waitForTimeout(1500);
  return {pausedLeft: paused, stillLeft: still, stopped, resumedLeft: await left(page), resumed: await playingNow(page)};
};
const rateChange = async page => {
  await page.waitForTimeout(800); await page.locator('.u-voice .u-speed').first().click(); await page.waitForTimeout(1500);
  return {pill: (await page.locator('.u-voice .u-speed').first().textContent()).trim(), ratePlaying: await playingNow(page)};
};
const toTheEnd = async page => {
  // Chromium seeks an Ogg stream to a page a few seconds early, so give it time to run out.
  await seek(page, 0.995); await page.waitForTimeout(8000);
  return {endPlaying: await playingNow(page), endLeft: await left(page)};
};
const CASES = [
  {label: 'mac-1x', phone: false, rate: 1},
  {label: 'mac-1.5x', phone: false, rate: 1.5},
  {label: 'mac-2x', phone: false, rate: 2},
  {label: 'mac-suspended', phone: false, rate: 1, stuck: true},
  {label: 'mac-pause-resume', phone: false, rate: 1, then: pauseResume},
  {label: 'mac-end', phone: false, rate: 1, then: toTheEnd},
  // Safari before Ogg in media elements, and an element that refuses to play: Web Audio takes over.
  {label: 'mac-no-ogg-element', phone: false, rate: 1.5, noOgg: true},
  {label: 'mac-element-refused', phone: false, rate: 1, badElement: true},
  {label: 'phone-1x', phone: true, rate: 1},
  {label: 'phone-1.5x', phone: true, rate: 1.5},
  {label: 'phone-2x', phone: true, rate: 2},
  {label: 'phone-suspended', phone: true, rate: 1, stuck: true},
  // A context that says 'running' but whose clock stands still: the element carries on.
  {label: 'phone-frozen-clock', phone: true, rate: 1, frozen: true, slow: 2500},
  {label: 'phone-seam-1x', phone: true, rate: 1, then: seam(1)},
  {label: 'phone-seam-2x', phone: true, rate: 2, then: seam(2)},
  {label: 'phone-pause-resume', phone: true, rate: 1.5, then: pauseResume},
  {label: 'phone-speed-change', phone: true, rate: 1, then: rateChange},
  {label: 'phone-end', phone: true, rate: 2, then: toTheEnd},
];

(async () => {
  const browser = await pw[BROWSER].launch(BROWSER === 'chromium' ? {args: ['--autoplay-policy=no-user-gesture-required']} : {}), summary = [];
  for (const c of CASES) if (!process.env.ONLY || process.env.ONLY.split(',').includes(c.label)) { const r = await run(browser, c); summary.push(r); console.log(JSON.stringify(r)); }
  await browser.close();
  fs.writeFileSync(path.join(out, (BEFORE ? 'before' : 'after') + '-summary.json'), JSON.stringify(summary, null, 2));
  if (BEFORE) return;
  for (const r of summary) {
    const c = CASES.find(x => x.label === r.label);
    assert.ok(r.musicOn, `${r.label}: the other frame's music was playing before the tap`);
    assert.ok(r.musicStill, `${r.label}: and still plays`);
    assert.ok(r.tapToSoundMs !== null && r.tapToSoundMs < (c.slow || 1000), `${r.label}: sound starts within ${(c.slow || 1000) / 1000} s of the tap: ${r.tapToSoundMs} ms`);
    if (!c.then) assert.ok(r.playing, `${r.label}: the bubble still shows playing (and is playing) a second later`);
    assert.ok(!r.loading || c.then, `${r.label}: loading is gone once it plays`);
    assert.ok(r.stall < 250, `${r.label}: no long main-thread stall after the tap: ${r.stall} ms`);
    assert.deepEqual(r.errors, [], `${r.label}: no page errors`);
    if (!r.phone && !c.noOgg && !c.badElement) assert.equal(r.path, 'element', `${r.label}: on a desktop the note streams through an audio element`);
    if (!r.phone && r.path === 'element' && r.rate !== 1) { assert.equal(r.elRate, r.rate, `${r.label}: the element plays at the chosen speed`); assert.equal(r.pitch, true, `${r.label}: speed keeps the pitch`); }
    if (c.noOgg || c.badElement) assert.equal(r.path, 'webaudio', `${r.label}: Web Audio takes over`);
    if (r.phone && !c.frozen) { assert.equal(r.path, 'webaudio', `${r.label}: on a phone the note plays through Web Audio (keeps the owner's music going)`); assert.equal(r.elements, 0, `${r.label}: no media element takes the phone's audio focus`); }
    if (c.frozen) assert.equal(r.path, 'element', `${r.label}: the element took over`);
    if (r.stuck) assert.ok(r.path === 'element' || r.contexts >= 2, `${r.label}: a stuck context is replaced or the element takes over`);
    if ('seamLeft' in r) {
      assert.ok(r.seamPlaying, `${r.label}: still playing after the first part ran out`);
      assert.ok(Math.abs(r.seamLeft - r.seamWant) <= 2, `${r.label}: the clock went on through the seam: ${r.seamLeft} s left, want ${r.seamWant}`);
      assert.ok(r.seamGaps.pieces >= 2 && r.seamGaps.worst < 0.002, `${r.label}: pieces join without gaps: ${JSON.stringify(r.seamGaps)}`);
    }
    if ('pausedLeft' in r) {
      assert.ok(r.stopped && r.stillLeft === r.pausedLeft, `${r.label}: a second tap pauses it: ${r.pausedLeft} -> ${r.stillLeft}`);
      assert.ok(r.resumed && r.resumedLeft < r.pausedLeft && r.resumedLeft >= r.pausedLeft - 3, `${r.label}: a third tap goes on from there: ${r.pausedLeft} -> ${r.resumedLeft}`);
    }
    if ('pill' in r) { assert.equal(r.pill, '1.5×'); assert.ok(r.ratePlaying, `${r.label}: still playing at the new speed`); }
    if ('endPlaying' in r) { assert.equal(r.endPlaying, false, `${r.label}: stops at the end`); assert.equal(r.endLeft, SECONDS, `${r.label}: shows the whole length again`); }
  }
  console.log('pass');
})().catch(e => { console.error(e); process.exit(1); });
