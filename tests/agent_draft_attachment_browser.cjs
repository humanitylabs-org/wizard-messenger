// Agent-drafted image in an already-open chat: the owner sees text + picture with no attachment warning, a transient
// attachment load failure heals on the next poll, and sending while a drafts poll is in flight never brings the sent
// draft back (31 Oct 2026: that left "An attachment could not be saved or opened" over an empty composer until reload).
// Usage: AGENT_STAGE_DIR=<dir> python3 tests/agent_drafts_stage.py <port> &  then  AGENT_STAGE_DIR=<dir> node tests/agent_draft_attachment_browser.cjs
const {chromium} = require(process.env.PLAYWRIGHT_MODULE || 'playwright');
const fs = require('node:fs'), path = require('node:path'), assert = require('node:assert/strict');
const dir = process.env.AGENT_STAGE_DIR || '/home/oscar/.hermes/cache/scratch/agentkeys';
const st = JSON.parse(fs.readFileSync(path.join(dir, 'state.json')));
const auth = {Authorization: 'Bearer ' + st.agents.Oscar};
const png = fs.readFileSync(path.join(__dirname, '../evidence/01-chats.png'));
const BANNER = '.u-draft-note.conflict';
const drafts = async () => (await (await fetch(st.origin + '/api/drafts', {headers: auth})).json()).result.drafts;
async function agentDraft(identity_id) {
  // Same two HTTP writes an agent can make (create, then attach), so the open chat may see either revision.
  let r = await fetch(st.origin + '/api/drafts', {method: 'POST', headers: {...auth, 'Content-Type': 'application/json'},
    body: JSON.stringify({person_id: st.alice, identity_id, text: "Here's a quick mock-up"})});
  const d = (await r.json()).result.draft;
  r = await fetch(st.origin + '/api/drafts/' + d.id + '/attachments?revision=' + d.revision + '&name=montrose-mockup.png', {method: 'PUT', headers: {...auth, 'Content-Type': 'image/png'}, body: png});
  assert.equal(r.status, 200); return (await r.json()).result.draft;
}
(async () => {
  for (const d of await drafts()) await fetch(st.origin + '/api/drafts/' + d.id, {method: 'DELETE', headers: {...auth, 'Content-Type': 'application/json'}, body: JSON.stringify({revision: d.revision})});
  const identity_id = (await (await fetch(st.origin + '/api/unified/people/' + st.alice, {headers: auth})).json()).result.person.identities[0].id;
  const browser = await chromium.launch();
  const ctx = await browser.newContext({viewport: {width: 1280, height: 844}});
  await ctx.addCookies([{name: 'wizard_messenger_session', value: st.cookie, url: st.origin}]);
  await ctx.route('**/wizard-os-home/**', r => { const u = new URL(r.request().url()); r.continue({url: 'http://127.0.0.1:8796' + u.pathname}); });
  let failAttachments = 0, holdList = false, held = false;
  await ctx.route(/\/api\/drafts\/[0-9a-f]+\/attachments\/[0-9a-f]+$/, r => failAttachments > 0 && r.request().method() === 'GET' ? (failAttachments--, r.fulfill({status: 502, body: 'bad gateway'})) : r.continue());
  await ctx.route(/\/api\/drafts$/, async r => {
    if (r.request().method() !== 'GET' || !holdList) return r.continue();
    holdList = false; const resp = await r.fetch(), body = await resp.text(); // snapshot taken now, delivered late
    held = true; await new Promise(res => setTimeout(res, 3000)); await r.fulfill({status: resp.status(), headers: resp.headers(), body});
  });
  const page = await ctx.newPage(), errors = [];
  page.on('pageerror', e => errors.push(e.message));
  await page.goto(st.origin + '/'); await page.locator('.u-person', {hasText: 'Alice Example'}).first().click();
  const field = page.locator('textarea[aria-label="Message"]'); await field.waitFor(); await page.waitForTimeout(1500);

  // 1. Chat already open; the agent drafts text + image. It shows within a poll, with the picture and no warning.
  await agentDraft(identity_id);
  await page.waitForFunction(() => document.querySelectorAll('.u-attach-strip').length === 1, null, {timeout: 15000});
  assert.equal(await field.inputValue(), "Here's a quick mock-up");
  assert.equal(await page.locator(BANNER).count(), 0, 'no warning for an agent draft in an open chat');
  await page.screenshot({path: path.join(dir, 'agent-draft-open-chat.png')});

  // 2. A transient failure loading the picture shows the warning once, then the next poll loads it and clears it.
  let d = (await drafts())[0];
  await fetch(st.origin + '/api/drafts/' + d.id, {method: 'DELETE', headers: {...auth, 'Content-Type': 'application/json'}, body: JSON.stringify({revision: d.revision})});
  await page.waitForFunction(() => !document.querySelector('.u-attach-strip') && !document.querySelector('textarea[aria-label="Message"]').value, null, {timeout: 15000});
  failAttachments = 1; await agentDraft(identity_id);
  await page.waitForSelector(BANNER, {timeout: 15000});
  await page.waitForSelector(BANNER, {state: 'detached', timeout: 15000});
  assert.equal(await page.locator('.u-attach-strip').count(), 1, 'retried picture is in the tray');

  // 3. Send while a drafts poll is in flight with a pre-send snapshot: the sent draft never comes back.
  holdList = true; for (let i = 0; i < 80 && !held; i++) await page.waitForTimeout(100);
  assert.ok(held, 'a poll is in flight');
  await page.getByRole('button', {name: 'Send', exact: true}).last().click();
  await page.waitForTimeout(9000);
  assert.equal((await drafts()).length, 0, 'draft removed after owner send');
  assert.equal(await page.locator(BANNER).count(), 0, 'no stuck attachment warning after send');
  assert.equal(await field.inputValue(), '');
  assert.equal(await page.locator('.u-attach-strip').count(), 0);
  assert.deepEqual(errors, []);
  await browser.close();
  console.log('PASS agent draft attachment: open chat shows picture, transient failure heals, send during poll stays sent');
})().catch(e => { console.error(e); process.exitCode = 1; });
