const test = require('node:test');
const assert = require('node:assert/strict');
const {deviceTranslate} = require('../static/unified.js');
// Issue 199: Translate uses the browser's own built-in translator (Chrome's
// Translator and LanguageDetector APIs) and never the box's model; null means "this browser can't", so the view falls
// back to the box.

function fakeBrowser({detected = 'th', availability = 'available', output = 'Hello', fail} = {}) {
  const calls = [];
  return {calls, g: {
    LanguageDetector: {create: async () => ({detect: async text => { calls.push(['detect', text]); return [{detectedLanguage: detected, confidence: 0.9}]; }, destroy() { calls.push(['detector.destroy']); }})},
    Translator: {
      availability: async pair => { calls.push(['availability', pair]); return availability; },
      create: async pair => {
        calls.push(['create', pair]);
        if (fail) throw new Error(fail);
        return {translate: async text => { calls.push(['translate', text]); return output; }, destroy() { calls.push(['translator.destroy']); }};
      },
    },
  }};
}

test('translates on the device from the detected language', async () => {
  const {g, calls} = fakeBrowser({detected: 'th', output: '  Hello there  '});
  assert.deepEqual(await deviceTranslate('สวัสดี', 'en', g), {text: 'Hello there', source: 'th'});
  assert.deepEqual(calls, [['detect', 'สวัสดี'], ['detector.destroy'], ['availability', {sourceLanguage: 'th', targetLanguage: 'en'}],
    ['create', {sourceLanguage: 'th', targetLanguage: 'en'}], ['translate', 'สวัสดี'], ['translator.destroy']]);
});

test('a region tag is cut to the base language', async () => {
  const {g, calls} = fakeBrowser({detected: 'zh-Hant'});
  assert.equal((await deviceTranslate('你好', 'en', g)).source, 'zh');
  assert.deepEqual(calls.find(c => c[0] === 'create')[1], {sourceLanguage: 'zh', targetLanguage: 'en'});
});

test('a language pack still to download is fine (the tap downloads it)', async () => {
  const {g} = fakeBrowser({availability: 'downloadable'});
  assert.equal((await deviceTranslate('สวัสดี', 'en', g)).text, 'Hello');
});

test('null whenever this browser cannot, so Translate falls back to the box', async () => {
  assert.equal(await deviceTranslate('สวัสดี', 'en', {}), null, 'no built-in translator (Safari, Firefox, phones)');
  assert.equal(await deviceTranslate('สวัสดี', 'en', {Translator: fakeBrowser().g.Translator}), null, 'no language detector');
  assert.equal(await deviceTranslate('สวัสดี', 'en', undefined), null);
  assert.equal(await deviceTranslate('   ', 'en', fakeBrowser().g), null, 'nothing to translate');
  assert.equal(await deviceTranslate('Hello', 'en', fakeBrowser({detected: 'en'}).g), null, 'already English');
  assert.equal(await deviceTranslate('??', 'en', fakeBrowser({detected: 'und'}).g), null, 'language unknown');
  assert.equal(await deviceTranslate('สวัสดี', 'en', fakeBrowser({availability: 'unavailable'}).g), null, 'no pack for this pair');
  assert.equal(await deviceTranslate('สวัสดี', 'en', fakeBrowser({fail: 'NotAllowedError'}).g), null, 'download refused');
  assert.equal(await deviceTranslate('สวัสดี', 'en', fakeBrowser({output: ' '}).g), null, 'empty result');
});

test('issue 204: with {same: true}, text already in the target language comes back as is, without a model', async () => {
  const {g, calls} = fakeBrowser({detected: 'en'});
  assert.deepEqual(await deviceTranslate(' See you ', 'en', g, {same: true}), {text: 'See you', source: 'en', same: true});
  assert.equal(calls.some(c => c[0] === 'create'), false);
  assert.equal(await deviceTranslate('See you', 'en', fakeBrowser({detected: 'en'}).g), null, 'without it: still null');
});

test('issue 204: the reply preview translates English to the chat language', async () => {
  const {g, calls} = fakeBrowser({detected: 'en', output: 'เจอกัน'});
  assert.deepEqual(await deviceTranslate('See you', 'th', g), {text: 'เจอกัน', source: 'en'});
  assert.deepEqual(calls.find(c => c[0] === 'create')[1], {sourceLanguage: 'en', targetLanguage: 'th'});
});
