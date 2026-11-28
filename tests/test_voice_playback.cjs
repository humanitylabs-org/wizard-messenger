// Issue 502: which way a voice note plays, and the first part of a long Ogg note that Web Audio starts on.
const assert = require('node:assert/strict');
const fs = require('node:fs'), os = require('node:os'), path = require('node:path');
const {execFileSync} = require('node:child_process');
const {voiceOnElement, oggPrefix} = require('../static/unified.js');

const MAC = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.1 Safari/605.1.15';
const WIN = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0 Safari/537.36';
const ANDROID = 'Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0 Mobile Safari/537.36 WizardOS-Android/0.9.1';
const IPHONE = 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_1 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Mobile/15E148';
assert.equal(voiceOnElement(MAC, false), true, 'Mac app and Safari: audio element');
assert.equal(voiceOnElement(WIN, false), true, 'desktop Chrome: audio element');
assert.equal(voiceOnElement(ANDROID, true), false, 'Android: Web Audio');
assert.equal(voiceOnElement(IPHONE, true), false, 'iPhone: Web Audio');
assert.equal(voiceOnElement(MAC, true), false, 'iPad asking for the desktop site (Mac UA, touch first): Web Audio');
assert.equal(voiceOnElement('', false), true);

// A hand-made Ogg stream: pages of 1 KB, page 5 continues a packet from page 4.
function page(seq, size, flags = 0) {
  const segs = Math.ceil(size / 255) || 1, lace = [];
  for (let left = size; lace.length < segs; left -= 255) lace.push(Math.min(255, left));
  const h = Buffer.alloc(27 + segs); h.write('OggS', 0, 'latin1'); h[5] = flags; h[26] = segs; Buffer.from(lace).copy(h, 27); h.writeUInt32LE(seq, 18);
  return Buffer.concat([h, Buffer.alloc(size, seq)]);
}
const pages = Array.from({length: 20}, (_, i) => page(i, 1000, i === 5 ? 1 : 0));
const ogg = Buffer.concat(pages), ab = ogg.buffer.slice(ogg.byteOffset, ogg.byteOffset + ogg.length);
const sizes = pages.map(p => p.length), end = n => sizes.slice(0, n).reduce((a, b) => a + b, 0);
// Want 4.5 pages: cutting in front of page 5 would split a packet, so it cuts in front of page 6.
const cut = oggPrefix(ab, Math.round(end(4) + sizes[4] / 2));
assert.ok(cut instanceof ArrayBuffer);
assert.equal(cut.byteLength, end(6), 'never cut in front of a continued packet');
assert.equal(oggPrefix(ab, ogg.length), null, 'a short note decodes whole');
assert.equal(oggPrefix(new TextEncoder().encode('ftypM4A '.repeat(5000)).buffer, 1000), null, 'not Ogg: whole decode');
const broken = Buffer.from(ogg); broken.write('Oggx', end(3), 'latin1');
assert.equal(oggPrefix(broken.buffer.slice(broken.byteOffset, broken.byteOffset + broken.length), end(5)), null, 'a damaged stream decodes whole');

// A real Opus note from ffmpeg (when it is here): the cut is at a page start inside the file.
const ffmpeg = process.env.FFMPEG || 'ffmpeg';
let real = null;
try {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ogg502-')), f = path.join(dir, 'n.ogg');
  execFileSync(ffmpeg, ['-loglevel', 'error', '-y', '-f', 'lavfi', '-i', 'anoisesrc=d=60:r=48000', '-ac', '1', '-c:a', 'libopus', '-b:a', '32k', f], {stdio: 'ignore'});
  real = fs.readFileSync(f);
} catch { console.log('no ffmpeg: real Opus case skipped'); }
if (real) {
  const head = oggPrefix(real.buffer.slice(real.byteOffset, real.byteOffset + real.length), 64 * 1024);
  assert.ok(head && head.byteLength >= 64 * 1024 && head.byteLength < 80 * 1024, 'cut a little after 64 KB: ' + head?.byteLength);
  assert.equal(real.subarray(head.byteLength, head.byteLength + 4).toString('latin1'), 'OggS', 'the rest starts with a page');
}
console.log('pass');
