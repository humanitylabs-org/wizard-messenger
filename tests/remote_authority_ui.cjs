// Behavioral fixture for the exact shipped review function. No provider/network.
const fs = require('node:fs');
const vm = require('node:vm');
const assert = require('node:assert/strict');
const source = fs.readFileSync('static/unified.js', 'utf8');
const functionSource = source.slice(source.indexOf('  async function reviewAgentDraft('), source.indexOf('  const LOGIN_FLAG'));
async function exercise(ready) {
  const nodes = [], calls = [];
  const node = (tag, cls, text) => {
    const n = {tag, cls, text, children: [], value: '', disabled: false,
      setAttribute(k, v) { this[k] = v; }, append(...items) { this.children.push(...items); },
      replaceChildren(...items) { this.children = items; }};
    nodes.push(n); return n;
  };
  const sheet = node('sheet');
  let draft = {id: 'fixture', revision: 1, state: 'draft', person_id: 'person-a', identity_id: 'identity-a', text: 'Original'};
  const s = {overlay: 'Review agent draft'};
  const context = {node, s, overlay: () => sheet, action: f => f(), confirm: () => true,
    cap: x => x, agentDrafts: () => {},
    button: (text, click, cls) => { const b = node('button', cls, text); b.click = click; return b; },
    call: async name => ({people: [{id: 'person-a', display_name: 'A', identities: [{id: 'identity-a', network: 'telegram', label: 'A'}]},
      {id: 'person-b', display_name: 'B', identities: [{id: 'identity-b', network: 'telegram', label: 'B'}]}], groups: []}),
    api: async (path, options) => {
      calls.push({path, options});
      if (path === 'api/view/authority') return {ready, reason: ready ? 'Owner attested' : 'Not configured', review_origin: 'https://owner.example.test'};
      if (path === 'api/drafts/fixture') {
        assert.equal(options.method, 'POST'); assert.equal(options.body.text, 'Edited exact text\n');
        assert.equal(options.body.person_id, 'person-b'); assert.equal(options.body.identity_id, 'identity-b');
        assert(nodes.find(n => n.tag === 'textarea').disabled);
        draft = {...draft, ...options.body, revision: 2}; return {draft};
      }
      if (path === 'api/drafts/fixture/export') {
        assert.equal(options.body.revision, 2); assert.deepEqual(Object.keys(options.body), ['revision']);
        draft = {...draft, state: 'exported'}; return {draft, review_origin: 'https://owner.example.test'};
      }
      throw Error('Unexpected request ' + path);
    }};
  vm.createContext(context); vm.runInContext(functionSource + '\nthis.reviewAgentDraft = reviewAgentDraft;', context);
  await context.reviewAgentDraft(draft);
  const review = nodes.find(n => n.tag === 'button' && n.text === 'Review securely');
  assert.equal(review.disabled, !ready);
  if (!ready) { assert(nodes.some(n => n.text === 'Not configured')); return; }
  nodes.find(n => n.tag === 'textarea').value = 'Edited exact text\n';
  nodes.find(n => n.tag === 'select').value = JSON.stringify(['person-b', 'identity-b']);
  await review.click();
  assert.deepEqual(calls.map(c => c.path), ['api/view/authority', 'api/drafts/fixture', 'api/drafts/fixture/export', 'api/view/authority']);
  const link = nodes.find(n => n.tag === 'a');
  assert.equal(link.href, 'https://owner.example.test'); assert.equal(link.target, '_blank');
  assert.equal(link.rel, 'noopener noreferrer'); assert.equal(link.referrerPolicy, 'no-referrer');
  assert(nodes.find(n => n.tag === 'textarea').disabled);
}
(async () => { await exercise(false); await exercise(true); console.log('remote authority review UI behavior passed'); })().catch(e => { console.error(e); process.exit(1); });
