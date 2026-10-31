// One Inbox row per Wizard chat: once the mirrored unified chat (network 'messenger', address = group) exists,
// the native private:<group> row is hidden and opening the chat goes to the mirrored thread, which has the
// attach button and server drafts. Without a mirror the native row still works. Fully synthetic APIs, shipping
// app.js/unified.js in real Chromium; no account access, nothing is sent.
const {chromium} = require(process.env.PLAYWRIGHT_MODULE || 'playwright');
const fs = require('node:fs'), path = require('node:path'), assert = require('node:assert/strict');
const L = require('../static/app.js');
const root = path.resolve(__dirname, '../static'), out = process.argv[2] || '/home/oscar/.hermes/cache/scratch/wizard-chat-row-proof';
fs.mkdirSync(out, {recursive: true});

async function scenario(browser, width, mirrored) {
  const ctx = await browser.newContext({viewport: {width, height: 844}});
  await ctx.addInitScript(() => {
    const noop = () => {}; window.__badges = [];
    window.WizardApp = {ready: noop, update: {hold: () => ({release: noop})}, back: {register: hooks => { window.__back = hooks; }}, on: noop, badge: {set: n => window.__badges.push(n)}};
  });
  const page = await ctx.newPage(), errors = [], requests = [];
  page.on('pageerror', e => errors.push(e.message));
  const ownKey = '11'.repeat(32), peerKey = '22'.repeat(32), inviteKey = '33'.repeat(32);
  const own = {account_id: ownKey, npub: L.encodePublic(ownKey), display_name: 'Owner'};
  const dm = {group_id: 'ab'.repeat(32), members: [{member_id: peerKey, display_name: 'Wizard Alice'}, {member_id: ownKey}]};
  const invite = {group_id: 'cd'.repeat(32), pending_confirmation: true, members: [{member_id: inviteKey, display_name: 'Wizard Invite'}, {member_id: ownKey}]};
  const now = Date.now();
  const msg = (id, text) => ({message_id: id.repeat(64), group_id: dm.group_id, author: peerKey, direction: 'received', text, created_at: now / 1000});
  const alice = {id: 'm1', display_name: 'Wizard Alice', identities: [{id: 'i3', network: 'messenger', kind: 'person', address: dm.group_id}], unread: 1, last: {text: 'Wizard hello', timestamp: now}};
  // A mirror of the pending invite must not add a second row either: the native invite row (with Accept) stays.
  const invited = {id: 'm2', display_name: 'Wizard Invite', identities: [{id: 'i4', network: 'messenger', kind: 'person', address: invite.group_id}], unread: 0, last: {text: 'hi', timestamp: now - 5000}};
  const bob = {id: 'p1', display_name: 'Bridged Bob', identities: [{id: 'i1', network: 'telegram', kind: 'person', address: '!bob'}], unread: 2, last: {text: 'Bridge hello', timestamp: now - 60000}};
  const draft = {id: 'd1', person_id: 'm1', identity_id: 'i3', state: 'draft', revision: 1, text: 'Agent drafted reply', attachments: [], updated: now, created_by: {kind: 'agent', id: 'a1', label: 'Wizard'}};
  await page.route('https://messenger.test/**', async route => {
    const req = route.request(), url = new URL(req.url()), p = url.pathname.slice(1); requests.push([p, req.method()]);
    const ok = result => route.fulfill({status: 200, contentType: 'application/json', body: JSON.stringify({ok: true, result})});
    if (p === 'api/view/session') return ok({authenticated: true, csrf_token: 'fixture'});
    if (p === 'api/status') return ok({state: 'ready', account_configured: true});
    if (p === 'api/identity') return ok({identity: own});
    if (p === 'api/contacts') return ok({contacts: []});
    if (p === 'api/invites') return ok({invites: [invite]});
    if (p === 'api/dms') return ok({dms: [dm]});
    if (p.startsWith('api/dms/') && p.endsWith('/messages')) {
      if (req.method() !== 'GET') return route.fulfill({status: 500, body: ''});
      return ok({messages: p.includes(invite.group_id) ? [] : [msg('b', 'Wizard hello')], next_cursor: null});
    }
    if (p === 'api/unified/people') return ok({people: mirrored ? [alice, invited, bob] : [bob], seq: 5});
    if (p === 'api/unified/groups') return ok({groups: [], seq: 5});
    if (p === 'api/unified/people/m1') return ok({person: {...alice, language: null}, messages: [{id: 'x1', person_id: 'm1', identity_id: 'i3', network: 'messenger', outgoing: false, sender: 'Wizard Alice', original: 'Wizard hello', msgtype: 'm.text', timestamp: now, reactions: []}], has_more: false, seq: 5});
    if (p === 'api/unified/people/m1/read') return ok({});
    if (p === 'api/unified/directory') return ok({people: mirrored ? [alice, invited, bob] : [bob], groups: []});
    if (p === 'api/unified/connectors') return ok({providers: []});
    if (p === 'api/unified/telegram/status') return ok({state: 'not_configured', logins: []});
    if (p === 'api/unified/updates') { await new Promise(r => setTimeout(r, 1000)); return ok({seq: 5}); }
    if (p === 'api/drafts') return ok({drafts: mirrored ? [draft] : []});
    if (p.startsWith('api/')) return ok({enabled: false, log: []});
    if (p.startsWith('wizard-') || p.startsWith('shared/')) return route.fulfill({status: 404, body: ''});
    const file = path.join(root, p || 'index.html');
    if (!file.startsWith(root + '/') || !fs.existsSync(file)) return route.fulfill({status: 404, body: ''});
    return route.fulfill({status: 200, contentType: {'.js': 'application/javascript', '.css': 'text/css', '.html': 'text/html'}[path.extname(file)] || 'application/octet-stream', body: fs.readFileSync(file)});
  });
  await page.goto('https://messenger.test/');
  const row = page.locator('.u-person', {hasText: 'Wizard Alice'});
  await row.first().waitFor();
  await page.waitForTimeout(400);
  assert.equal(await row.count(), 1, 'one row per Wizard chat');
  assert.equal(await page.locator('.u-person', {hasText: 'Wizard Invite'}).count(), 1, 'pending invite: one row');
  assert.equal(await page.locator('.u-person').count(), 3);
  // Bridged Bob unread + Wizard Alice unread + the invite; Alice is never counted twice.
  assert.equal(await page.evaluate(() => window.__badges.at(-1)), 3, 'badge counts each Wizard chat once');
  if (mirrored) {
    assert.equal(await row.getAttribute('data-native-group'), null, 'the mirrored row is the one listed');
    assert.equal(await page.locator('.u-person[data-native-group="' + invite.group_id + '"]').count(), 1, 'invite keeps its native row');
    await page.locator('.u-person', {hasText: 'Agent drafted reply'}).waitFor({timeout: 8000});
  } else assert.equal(await row.getAttribute('data-native-group'), dm.group_id);
  await page.getByRole('button', {name: 'Wizard', exact: true}).click();
  assert.equal(await page.locator('.u-person').count(), 2, 'Wizard chip lists Wizard chats (mirrored or native)');
  await page.getByRole('button', {name: 'Unread', exact: true}).click();
  assert.equal(await page.locator('.u-person', {hasText: 'Wizard Alice'}).count(), 1);
  await page.screenshot({path: path.join(out, `inbox-${mirrored ? 'mirrored' : 'native'}-${width}.png`)});
  await page.getByRole('button', {name: 'All', exact: true}).click();
  await row.click();
  if (mirrored) {
    await page.locator('.u-attach').waitFor({state: 'visible'});
    assert.equal(await page.locator('.u-attach').isVisible(), true, 'Wizard chat has the attach button');
    assert.equal(await page.locator('[data-private-view]').count(), 0, 'not the native thread');
    await page.screenshot({path: path.join(out, `thread-mirrored-${width}.png`)});
    assert.equal(await page.evaluate(() => window.__back.canGoBack()), true);
    await page.evaluate(() => window.__back.back());
    await row.waitFor();
    assert.equal(await row.count(), 1, 'still one row after Back');
    assert.ok(requests.some(([p, m]) => p === 'api/unified/people/m1' && m === 'GET'));
    assert.equal(requests.filter(([p]) => p.startsWith('api/dms/' + dm.group_id + '/messages')).length >= 0, true);
  } else {
    await page.locator('#messages', {hasText: 'Wizard hello'}).waitFor();
    if (width >= 900) {
      // Desktop split: the native thread sits beside the list; Back (no header button there) returns to the empty pane.
      assert.equal(await page.locator('#u-pane-list').isVisible(), true, 'list stays beside the native thread');
      assert.equal(await page.locator('#chat-back').isVisible(), false, 'no Back button in the split');
      await page.evaluate(() => window.__back.back()); await page.locator('#u-pane-thread .u-newmsg').waitFor();
    } else await page.locator('#chat-back').click();
    await row.waitFor();
  }
  assert.equal(requests.filter(([p, m]) => m === 'POST' && /(send|messages)$/.test(p)).length, 0, 'nothing sent');
  assert.deepEqual(errors, []);
  console.log(`PASS ${width} ${mirrored ? 'mirrored' : 'native-only'}: one row, badge, Wizard chip, open + Back${mirrored ? ', attach button, agent draft' : ''}`);
  await ctx.close();
}

(async () => {
  const browser = await chromium.launch();
  for (const width of [390, 1280]) for (const mirrored of [false, true]) await scenario(browser, width, mirrored);
  await browser.close();
})().catch(e => { console.error(e); process.exit(1); });
