// Real staging server + shipping view in Chromium. Agent drafts via real HTTP MCP, owner sends via the UI.
const {chromium} = require(process.env.PLAYWRIGHT_MODULE || 'playwright');
const fs = require('node:fs'), assert = require('node:assert/strict');
const dir = process.env.AGENT_STAGE_DIR || '/home/oscar/.hermes/cache/scratch/agentkeys';
const st = JSON.parse(fs.readFileSync(dir + '/state.json', 'utf8'));
async function mcp(key, name, args) {
  const r = await fetch(st.origin + '/mcp', {method: 'POST', headers: {'Content-Type': 'application/json', Origin: st.origin, ...(key ? {Authorization: 'Bearer ' + key} : {})},
    body: JSON.stringify({jsonrpc: '2.0', id: 1, method: name ? 'tools/call' : 'tools/list', params: name ? {name, arguments: args || {}} : undefined})});
  const j = await r.json(); if (!name) return j.result.tools.map(t => t.name);
  return {data: JSON.parse(j.result.content[0].text), error: !!j.result.isError};
}
(async () => {
  const out = {};
  out.anon = await mcp(null); out.oscarTools = await mcp(st.agents.Oscar);
  const chats = await mcp(st.agents.Oscar, 'messenger_list_chats'); assert.equal(chats.error, false); out.chats = chats.data.chats.map(c => c.title + ' · ' + c.channels[0].network);
  const thread = await mcp(st.agents.Oscar, 'messenger_read_thread', {chat_id: st.alice}); out.thread = thread.data.messages.map(m => m.text);
  const denied = await mcp(st.agents.Reader, 'messenger_create_draft', {chat_id: st.alice, text: 'nope'}); assert.equal(denied.error, true); out.readerDraft = denied.data.error.code;
  const made = await mcp(st.agents.Oscar, 'messenger_create_draft', {chat_id: st.alice, text: 'Yes! 12:30 at the usual place?'}); assert.equal(made.error, false);
  const made2 = await mcp(st.agents.Oscar, 'messenger_create_draft', {chat_id: st.bob, text: 'Landed, call you in 10'}); assert.equal(made2.error, false);
  // Agent's own send attempt over HTTP with the same key: refused.
  const r = await fetch(st.origin + '/api/drafts/' + made.data.draft.id + '/send', {method: 'POST', headers: {'Content-Type': 'application/json', Authorization: 'Bearer ' + st.agents.Oscar}, body: JSON.stringify({revision: 1})});
  out.agentSend = r.status;
  const browser = await chromium.launch();
  for (const width of [390, 1280]) {
    if (width === 1280) { const again = await mcp(st.agents.Oscar, 'messenger_create_draft', {chat_id: st.alice, text: 'Second draft for the wide screen'}); assert.equal(again.error, false); }
    const ctx = await browser.newContext({viewport: {width, height: 844}});
    await ctx.addCookies([{name: 'wizard_messenger_session', value: st.cookie, url: st.origin}]);
    await ctx.route('**/wizard-os-home/**', route => { const u = new URL(route.request().url()); route.continue({url: 'http://127.0.0.1:8796' + u.pathname}); });
    const page = await ctx.newPage(), errors = []; page.on('pageerror', e => errors.push(e.message));
    await page.goto(st.origin + '/');
    await page.locator('.u-person', {hasText: 'Alice Example'}).first().click();
    const card = page.locator('.u-agent-draft');
    await card.waitFor();
    assert.match(await card.textContent(), /Draft from Oscar · not sent/);
    await page.waitForTimeout(400);
    await page.screenshot({path: `${dir}/thread-draft-${width}.png`});
    if (width === 390) {
      await page.getByRole('button', {name: 'Send draft'}).click();
      await page.locator('.u-agent-drafts').waitFor({state: 'hidden'});
      out.ownerSent = JSON.parse(fs.readFileSync(dir + '/sent.json', 'utf8') || '{}');
      await page.waitForTimeout(1200);
      out.ownerSent = JSON.parse(fs.readFileSync(dir + '/sent.json', 'utf8'));
    }
    // Settings > Agents (the app reopens the last chat after a reload: go Back to the list first)
    await page.goto(st.origin + '/'); await page.waitForTimeout(1500);
    if (!(await page.getByRole('button', {name: 'Settings', exact: true}).count())) { await page.locator('header button').first().click(); await page.waitForTimeout(500); }
    await page.getByRole('button', {name: 'Settings', exact: true}).first().click();
    await page.locator('.u-settings .u-more').waitFor({timeout: 40000}).catch(() => {});
    if (await page.locator('.u-settings .u-more').count()) {
      await page.locator('.u-settings .u-more').scrollIntoViewIfNeeded();
      await page.waitForTimeout(300);
      await page.locator('.u-settings .u-more').screenshot({path: `${dir}/agents-${width}.png`});
      out['levels' + width] = await page.locator('select[aria-label="What Oscar may do"] option').allTextContents();
    } else out['settings' + width] = 'not found';
    if (width === 1280) {
      await page.goto(st.origin + '/'); await page.waitForTimeout(1500);
      if (!(await page.locator('.u-person', {hasText: 'Bob Wizard'}).count())) { await page.locator('header button').first().click(); await page.waitForTimeout(500); }
      await page.locator('.u-person', {hasText: 'Bob Wizard'}).first().click();
      await page.locator('.u-agent-draft').waitFor();
      await page.getByRole('button', {name: 'Discard'}).click();
      await page.getByRole('button', {name: 'Discard'}).last().click();
      await page.locator('.u-agent-drafts').waitFor({state: 'hidden'});
      out.discarded = true;
      // Native Wizard-to-Wizard thread shows the same agent drafts and the owner sends from there.
      const nd = await mcp(st.agents.Oscar, 'messenger_create_draft', {chat_id: st.bob, text: 'Native thread draft'}); assert.equal(nd.error, false);
      await page.goto(st.origin + '/'); await page.waitForTimeout(1500);
      if (!(await page.locator('.u-person[data-native-group="groupbob"]').count())) { await page.locator('header button').first().click(); await page.waitForTimeout(500); }
      await page.locator('.u-person[data-native-group="groupbob"]').first().click();
      await page.locator('#native-agent-drafts .u-agent-draft').waitFor();
      await page.waitForTimeout(300); await page.screenshot({path: `${dir}/native-draft-${width}.png`});
      await page.locator('#native-agent-drafts').getByRole('button', {name: 'Send draft'}).click();
      await page.locator('#native-agent-drafts').waitFor({state: 'hidden'});
      await page.waitForTimeout(1200);
      out.nativeSent = JSON.parse(fs.readFileSync(dir + '/sent.json', 'utf8')).engine;
    }
    out['errors' + width] = errors;
    await ctx.close();
  }
  await browser.close();
  const left = await mcp(st.agents.Oscar, 'messenger_list_drafts'); out.draftsLeft = left.data.drafts.length;
  console.log(JSON.stringify(out, null, 1));
})().catch(e => { console.error(e); process.exit(1); });
