// Unit proof: the voice-note speed-up keeps pitch and shortens time, fast enough for a phone. Issue 502: it now
// runs a few frames at a time just ahead of playback, so the pieces must join into exactly what the whole-note
// stretch gave, also when the first part of the note is swapped for the whole note halfway.
const fs = require('node:fs'), assert = require('node:assert/strict');
const src = fs.readFileSync(__dirname + '/../static/unified.js', 'utf8');
const from = src.indexOf('  function stretcher('), at = src.indexOf('  function stretchChannels(');
const body = src.slice(from, src.indexOf('\n  }\n', at) + 4);
const {stretcher, stretchChannels} = new Function(body + '; return {stretcher, stretchChannels};')();
// The whole-note WSOLA as it was before issue 502, kept here as the reference.
function reference(chs, sr, rate) {
  const x = chs[0], len = x.length, N = Math.max(64, Math.round(sr * 0.04) & ~1), Hs = N >> 1, Ha = Hs * rate, tol = Math.round(sr * 0.006);
  if (rate === 1 || len < N * 2) return chs;
  const frames = Math.max(1, Math.floor((len - N) / Ha) + 1), outLen = (frames - 1) * Hs + N;
  const win = new Float32Array(N); for (let i = 0; i < N; i++) win[i] = 0.5 - 0.5 * Math.cos(2 * Math.PI * i / N);
  const out = chs.map(() => new Float32Array(outLen));
  let prev = 0;
  for (let k = 0; k < frames; k++) {
    const nominal = Math.round(k * Ha); let best = Math.min(nominal, len - N);
    if (k > 0) {
      const target = prev + Hs; let score = -Infinity;
      for (let d = -tol; d <= tol; d += 2) { const p = nominal + d; if (p < 0 || p + N > len) continue; let s = 0; for (let i = 0; i < Hs; i += 4) s += x[p + i] * x[target + i]; if (s > score) { score = s; best = p; } }
    }
    const o = k * Hs;
    for (let c = 0; c < chs.length; c++) { const s = chs[c], dst = out[c]; for (let i = 0; i < N; i++) dst[o + i] += s[best + i] * win[i]; }
    prev = best;
  }
  return out;
}
const join = parts => { const out = new Float32Array(parts.reduce((n, p) => n + p.length, 0)); let o = 0; for (const p of parts) { out.set(p, o); o += p.length; } return out; };
const same = (a, b, label) => { assert.equal(a.length, b.length, label + ' length'); let worst = 0; for (let i = 0; i < a.length; i++) worst = Math.max(worst, Math.abs(a[i] - b[i])); assert.ok(worst < 1e-6, label + ' samples differ by ' + worst); };
const sr = 48000, f0 = 220, x = new Float32Array(sr * 3);
for (let i = 0; i < x.length; i++) x[i] = Math.sin(2 * Math.PI * f0 * i / sr) * (0.6 + 0.4 * Math.sin(2 * Math.PI * 3 * i / sr));
const freq = a => { let z = 0; for (let i = sr * 0.2 + 1; i < a.length - sr * 0.2; i++) if (a[i - 1] < 0 && a[i] >= 0) z++; return z / ((a.length - sr * 0.4) / sr); };
for (const rate of [1.5, 2]) {
  const [y] = stretchChannels([x], sr, rate);
  const want = x.length / rate;
  assert.ok(Math.abs(y.length - want) / want < 0.03, `length at ${rate}x: ${y.length} vs ${want}`);
  const f = freq(y); assert.ok(Math.abs(f - f0) < 4, `pitch kept at ${rate}x: ${f.toFixed(1)} Hz`);
  console.log(rate + 'x', 'len', y.length, 'pitch', freq(y).toFixed(1));
}
// Same samples as the whole-note stretch: whole, or in pieces, mono and stereo.
const speech = new Float32Array(sr * 10); for (let i = 0; i < speech.length; i++) speech[i] = Math.sin(2 * Math.PI * (180 + 60 * Math.sin(2 * Math.PI * 0.7 * i / sr)) * i / sr) * 0.4 + Math.sin(i * 0.37) * 0.05;
const right = speech.map(v => -v * 0.5);
for (const rate of [1.5, 2]) {
  const ref = reference([speech, right], sr, rate);
  const whole = stretchChannels([speech, right], sr, rate);
  same(whole[0], ref[0], `whole ${rate}x left`); same(whole[1], ref[1], `whole ${rate}x right`);
  // Pieces of a few frames from the first part (4 s), then the whole note swapped in.
  const st = stretcher(sr, rate), head = [speech.subarray(0, sr * 4), right.subarray(0, sr * 4)], parts = [];
  st.input(head); st.from(0);
  let part; while ((part = st.next(7, head[0].length, false))) parts.push(part.map(p => p.slice()));
  assert.ok(st.read() < sr * 4 && st.read() > sr * 3.9, 'stopped just short of the first part: ' + st.read());
  st.input([speech, right]);
  while ((part = st.next(40, speech.length, true))) parts.push(part.map(p => p.slice()));
  assert.ok(st.done(), 'done at the end');
  same(join(parts.map(p => p[0])), ref[0], `pieces ${rate}x left`); same(join(parts.map(p => p[1])), ref[1], `pieces ${rate}x right`);
  // Starting in the middle (a seek, a speed change) is the reference over the rest of the note.
  const mid = sr * 6, st2 = stretcher(sr, rate), bits = []; st2.input([speech]); st2.from(mid);
  while ((part = st2.next(13, speech.length, true))) bits.push(part[0].slice());
  same(join(bits), reference([speech.subarray(mid)], sr, rate)[0], `from 6 s at ${rate}x`);
}
// The first second of a 6:15 note at 2x costs milliseconds, not the whole note's stretch.
const long = new Float32Array(sr * 375); for (let i = 0; i < long.length; i++) long[i] = Math.sin(i * 0.05) * Math.sin(i * 0.0007);
let t0 = Date.now(); const st = stretcher(sr, 2); st.input([long]); st.from(0); st.next(Math.ceil(sr / (st.N / 2) / 2), long.length, true); const firstMs = Date.now() - t0;
console.log('first 1 s of a 6:15 note at 2x:', firstMs, 'ms'); assert.ok(firstMs < 100);
t0 = Date.now(); stretchChannels([long.subarray(0, sr * 60)], sr, 1.5); const ms = Date.now() - t0;
console.log('60 s note at 1.5x:', ms, 'ms'); assert.ok(ms < 1500);
console.log('pass');
