// Unit proof: the voice-note speed-up keeps pitch and shortens time, fast enough for a phone.
const fs = require('node:fs'), assert = require('node:assert/strict');
const src = fs.readFileSync(__dirname + '/../static/unified.js', 'utf8');
const body = src.slice(src.indexOf('  function stretchChannels('), src.indexOf('\n  }\n', src.indexOf('  function stretchChannels(')) + 4);
const stretchChannels = new Function(body + '; return stretchChannels;')();
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
const long = new Float32Array(sr * 60); for (let i = 0; i < long.length; i++) long[i] = Math.sin(i * 0.05) * Math.sin(i * 0.0007);
const t0 = Date.now(); stretchChannels([long], sr, 1.5); const ms = Date.now() - t0;
console.log('60 s note at 1.5x:', ms, 'ms'); assert.ok(ms < 1500);
console.log('pass');
