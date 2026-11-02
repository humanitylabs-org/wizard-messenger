// Pictures, suggested merges, "Replying on" and Slack browser sign-in (Miguel, 30 Oct 2026).
// node tests/merge_pictures_browser.cjs [outdir]   (needs playwright via PLAYWRIGHT_MODULE). Synthetic APIs only.
const {chromium} = require(process.env.PLAYWRIGHT_MODULE || 'playwright');
const fs = require('node:fs'), path = require('node:path'), assert = require('node:assert/strict');
const L = require('../static/app.js');
const root = path.resolve(__dirname, '../static'), out = path.resolve(process.argv[2] || 'merge-shots');
fs.mkdirSync(out, {recursive: true});
const TYPES = {'.js': 'application/javascript', '.css': 'text/css', '.html': 'text/html', '.svg': 'image/svg+xml'};
// 1x1 PNGs: a red face and a blue frame
const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8DwHwAFBQIAX8jx0gAAAABJRU5ErkJggg==', 'base64');
const now = Date.now(), min = 60e3;
const ident = (id, net, kind = 'person') => ({id: id + '-' + net, network: net, kind, label: id});
(async () => {
  const browser = await chromium.launch(), summary = [];
  for (const [label, viewport] of [['390', {width: 390, height: 844}], ['1280', {width: 1280, height: 860}]]) {
    let people = [
      {id: 'ana-w', display_name: 'Ana Souza', accounts: [{network: 'whatsapp', value: '5511999', label: 'Ana'}], identities: [ident('ana', 'whatsapp')], labels: [], unread: 1, avatar: 'abc123', last: {text: 'Oi!', timestamp: now - 2 * min, outgoing: false}},
      {id: 'ana-i', display_name: 'Ana Souza', identities: [ident('ana', 'instagram')], labels: [], unread: 0, avatar: null, last: {text: "> Replied to @Owner's story\n\n[https://www.instagram.com/stories/x/1](https://www.instagram.com/stories/x/1?reel_id=1)", msgtype: 'm.image', timestamp: now - 90 * min, outgoing: false}},
      {id: 'bo', display_name: 'Bo Chen', accounts: [{network: 'telegram', value: '42', label: 'Bo'}], identities: [ident('bo', 'telegram'), ident('bo', 'whatsapp')], labels: [], unread: 0, avatar: 'def456', last: {text: 'see you', timestamp: now - 30 * min, outgoing: false}},
    ];
    const groups = [{id: 'fam', display_name: 'Family', identities: [ident('fam', 'whatsapp', 'group')], labels: [], unread: 0, avatar: null, last: {text: 'Dinner?', timestamp: now - 5 * min, outgoing: false, sender: 'Pedro'}}];
    let suggestions = [{id: 'ana-i|ana-w', name: 'Ana Souza', people: [
      {id: 'ana-w', display_name: 'Ana Souza', avatar: 'abc123', networks: ['whatsapp'], last: people[0].last},
      {id: 'ana-i', display_name: 'Ana Souza', avatar: null, networks: ['instagram'], last: people[1].last}]}];
    const posted = [], pics = [], inputs = [], saved = [];
    let frames = 0, signin = 'signing_in';
    const finishAfter = () => { signin = 'done'; };
    const ctx = await browser.newContext({viewport, deviceScaleFactor: 2});
    // Desktop split (Messenger 900px and wider): no Back button beside the list; Back (Escape) clears the open chat.
    const closeChat = async () => (await page.evaluate(() => document.documentElement.hasAttribute('data-split'))) ? page.keyboard.press('Escape') : page.getByRole('button', {name: 'Back', exact: true}).click();
    await ctx.addInitScript(() => { try { localStorage.setItem('messenger.previews', '1'); } catch {} }); // previews are opt-in since 15.11; this test reads them
await ctx.addInitScript(() => { const noop = () => {}; window.WizardApp = {ready: noop, update: {hold: () => ({release: noop})}, back: {register: noop}, on: noop, nav: {}, toast: noop, badge: {set: noop}}; });
    const page = await ctx.newPage(), errors = [];
    page.on('pageerror', e => errors.push(e.message));
    const ownKey = '11'.repeat(32);
    await page.route('https://messenger.test/**', async route => {
      const req = route.request(), url = new URL(req.url()), p = url.pathname.slice(1);
      const ok = result => route.fulfill({status: 200, contentType: 'application/json', body: JSON.stringify({ok: true, result})});
      const body = req.postData() ? JSON.parse(req.postData()) : {};
      if (p === 'api/view/session') return ok({authenticated: true, csrf_token: 'fixture'});
      if (p === 'api/status') return ok({state: 'ready', account_configured: true});
      if (p === 'api/identity') return ok({identity: {account_id: ownKey, npub: L.encodePublic(ownKey), display_name: 'Owner'}});
      if (['api/contacts', 'api/invites', 'api/dms'].includes(p)) return ok({contacts: [], invites: [], dms: []});
      if (p === 'api/unified/people') return ok({people, seq: 5});
      if (p === 'api/unified/groups') return ok({groups, seq: 5});
      if (p === 'api/unified/merge-suggestions') return ok({suggestions});
      if (p === 'contacts/api/contacts') return route.fulfill({status: 200, contentType: 'application/json', body: JSON.stringify({contacts: [{id: 'c_1', name: 'Ana from Contacts', accounts: [{network: 'whatsapp', value: '5511999'}]}].concat(saved)})});
      if (p === 'contacts/api/save') { const b = JSON.parse(req.postData()); saved.push({id: 'c_2', name: b.name, accounts: b.accounts}); posted.push(['save', b.accounts]); return route.fulfill({status: 200, contentType: 'application/json', body: JSON.stringify({contact: {id: 'c_2', name: b.name}, created: true})}); }
      if (p === 'api/unified/merge-suggestions/dismiss') { posted.push(['dismiss', body.id]); suggestions = []; return ok({dismissed: true}); }
      let m = /^api\/unified\/people\/([^/]+)\/avatar$/.exec(p);
      if (m) { pics.push([decodeURIComponent(m[1]), url.searchParams.get('who')]); return route.fulfill({status: 200, contentType: 'image/png', body: PNG}); }
      if (/^api\/unified\/media\//.test(p)) return route.fulfill({status: 200, contentType: 'image/png', body: PNG});
      m = /^api\/unified\/people\/([^/]+)\/merge$/.exec(p);
      if (m) { posted.push(['merge', m[1], body.source_id]); people = [{...people[0], identities: [...people[0].identities, ...people[1].identities]}, people[2]]; suggestions = []; return ok({}); }
      m = /^api\/unified\/people\/([^/]+)$/.exec(p);
      if (m) {
        const id = decodeURIComponent(m[1]), pr = [...people, ...groups].find(x => x.id === id);
        const msgs = id === 'fam' ? [{id: 'f1', timestamp: now - 9 * min, outgoing: false, original: 'Who cooks?', sender: 'Pedro', msgtype: 'm.text', network: 'whatsapp', reactions: []}]
          : [{id: 'b1', timestamp: now - 40 * min, outgoing: false, original: 'on telegram', sender: 'Bo', msgtype: 'm.text', network: 'telegram', reactions: []},
             {id: 'b2', timestamp: now - 30 * min, outgoing: false, original: 'see you', sender: 'Bo', msgtype: 'm.text', network: 'whatsapp', reactions: [{key: '👍', count: 2, mine: true}]},
             {id: 'b4', timestamp: now - 35 * min, outgoing: false, original: "> Reacted to @Owner's story\n\n[https://www.instagram.com/stories/x/1](https://www.instagram.com/stories/x/1?reel_id=1)", sender: 'Bo', msgtype: 'm.image', network: 'whatsapp', reactions: [], media: {mime: 'image/jpeg', w: 720, h: 1280, thumb: true}},
             {id: 'b5', timestamp: now - 34 * min, outgoing: false, original: '', sender: 'Bo', msgtype: 'm.video', network: 'whatsapp', reactions: [], media: {mime: 'video/mp4', w: 1280, h: 720, duration: 12000, thumb: true}},
             {id: 'b3', timestamp: now - 29 * min, outgoing: true, original: 'look https://example.com/a', sender: 'me', msgtype: 'm.text', network: 'whatsapp', reactions: [], reply: {id: 'b2', sender: 'Bo', outgoing: false, text: 'see you', msgtype: 'm.text'},
              links: [{url: 'https://example.com/a', title: 'Example article', desc: 'A short description of the page', site: 'Example', image: true, w: 1200, h: 630}]}];
        return ok({person: {...pr, faces: id === 'fam' ? {Pedro: 'aaa111'} : {}}, messages: msgs, has_more: false, next_cursor: null, seq: 5, typing: []});
      }
      if (p.endsWith('/read')) return ok({});
      m = /^api\/unified\/people\/([^/]+)\/unread$/.exec(p);
      if (m) { posted.push(['unread', decodeURIComponent(m[1])]); return ok({ok: true}); }
      if (p === 'api/unified/connectors') return ok({providers: [{network: 'slack', label: 'Slack', supported: true, state: 'disconnected', flows: [{id: 'email', name: 'Email'}, {id: 'token', name: 'Token'}], logins: []}]});
      if (p === 'api/unified/connectors/browser/start') { posted.push(['start', body.network, body.width > 0]); return ok({id: 'S1', title: 'Slack'}); }
      m = /^api\/unified\/connectors\/browser\/S1\/(frame|input|cancel)$/.exec(p);
      if (m && m[1] === 'frame') { await new Promise(r => setTimeout(r, 150)); frames++; return ok({seq: frames, frame: PNG.toString('base64'), state: signin, host: 'app.slack.com', message: 'Connected Acme', result: {connected: ['Acme'], failed: []}}); }
      if (m && m[1] === 'input') { inputs.push(body); return ok({ok: true}); }
      if (m && m[1] === 'cancel') { posted.push(['cancel']); return ok({}); }
      if (p.startsWith('api/unified/updates')) { await new Promise(r => setTimeout(r, 20000)); return ok({seq: 5}); }
      if (p.startsWith('api/')) return ok({});
      const file = path.join(root, p || 'index.html');
      if (!file.startsWith(root) || !fs.existsSync(file)) return route.fulfill({status: 404, body: ''});
      return route.fulfill({status: 200, contentType: TYPES[path.extname(file)] || 'application/octet-stream', body: fs.readFileSync(file)});
    });
    const shot = name => page.screenshot({path: path.join(out, `${name}-${label}.png`)});
    await page.goto('https://messenger.test/');
    if (label === '1280') await page.addStyleTag({content: '#messenger { position: fixed !important; left: 240px !important; top: 90px !important; width: 900px !important; height: 740px !important; }'});
    await page.locator('.u-person', {hasText: 'Bo Chen'}).waitFor({timeout: 15000});
    // Pictures: rows with a picture load it; rows without keep initials.
    await page.waitForFunction(() => document.querySelectorAll('.u-person .u-avatar.has-img').length >= 2);
    assert.equal(await page.locator('.u-person', {hasText: 'Family'}).locator('img.u-av-img').count(), 0);
    assert.ok(pics.some(x => x[0] === 'ana-w'));
    assert.equal(await page.locator('.u-person', {hasText: 'Bo Chen'}).locator('.u-net').count(), 2, 'merged chat shows both network badges');
    assert.equal(await page.locator('.u-person', {hasText: 'Family'}).locator('.u-net').count(), 1);
    assert.match(await page.locator('.u-person', {hasText: 'Replied to your story'}).textContent(), /Ana Souza/);
    assert.equal(await page.locator('.u-person', {hasText: 'instagram.com'}).count(), 0, 'no raw links in previews');
    await page.locator('#u-filters .u-filter-btn').click();
    assert.equal(await page.locator('.u-filter-menu').getByRole('menuitemradio', {name: 'Merged', exact: true}).count(), 1, 'Merged filter appears when a chat is merged');
    await page.keyboard.press('Escape'); await page.locator('.u-filter-menu').waitFor({state: 'detached'});
    await page.locator('.u-person', {hasText: 'Ana from Contacts'}).waitFor();
    await page.locator('.u-person', {hasText: 'Bo Chen'}).click({button: 'right'});
    await page.getByRole('menuitem', {name: 'Add to Contacts'}).click();
    await page.waitForFunction(() => true); await page.waitForTimeout(400);
    assert.ok(posted.some(x => x[0] === 'save' && x[1][0].network === 'telegram' && x[1][0].value === '42'), 'Add to Contacts sends the account');
    await shot('inbox');

    // First click into the window: a mouse press whose release never arrives must not open the row menu.
    const fam = page.locator('.u-person', {hasText: 'Family'}); const fb = await fam.boundingBox();
    await page.mouse.move(fb.x + 60, fb.y + 20); await page.mouse.down(); await page.waitForTimeout(700);
    assert.equal(await page.locator('.u-menu').count(), 0, 'mouse press is never a long-press');
    await page.mouse.up(); await page.waitForTimeout(200);
    if (await page.getByRole('button', {name: 'Back', exact: true}).count()) await page.getByRole('button', {name: 'Back', exact: true}).click();
    // Mark as unread from the row menu (right-click), then read again.
    await page.locator('.u-person', {hasText: 'Bo Chen'}).click({button: 'right'});
    await page.getByRole('menuitem', {name: 'Mark as unread'}).click();
    assert.ok(posted.some(x => x[0] === 'unread' && x[1] === 'bo'));
    await page.locator('.u-person', {hasText: 'Bo Chen'}).click({button: 'right'});
    await page.getByRole('menuitem', {name: 'Mark as read'}).waitFor(); await page.keyboard.press('Escape');
    if (await page.locator('#u-overlay').count()) await page.locator('#u-overlay').click({position: {x: 5, y: 5}});
    // Suggested merges live in Settings, merge on a tap and leave the list in place.
    await page.locator('.u-settings-btn').click();
    await page.locator('.u-settings-row', {hasText: 'Suggested merges'}).waitFor();
    await page.locator('.u-settings-row', {hasText: 'Suggested merges'}).click();
    await page.locator('.u-merge-card').waitFor();
    assert.match(await page.locator('.u-merge-card').textContent(), /WhatsApp.*Instagram|Instagram.*WhatsApp/s);
    await shot('merges');
    await page.locator('.u-merge-card').getByRole('button', {name: 'Merge'}).click();
    await page.locator('.u-merge-card').waitFor({state: 'detached'});
    assert.deepEqual(posted.find(x => x[0] === 'merge'), ['merge', 'ana-w', 'ana-i']);
    await page.getByText('No suggestions right now.').waitFor();
    await page.keyboard.press('Escape'); if (await page.locator('#u-overlay').count()) await page.locator('#u-overlay .icon-button[aria-label=Close]').click();

    // Merged chat: the composer says where the reply goes; replying to a message switches to its network.
    await page.locator('.u-person', {hasText: 'Bo Chen'}).click();
    const pill = page.locator('.u-via-pick');
    await pill.waitFor();
    assert.match(await pill.textContent(), /Replying on\s*Telegram/);
    const target = page.locator('.u-row[data-id=b2] .bubble-text, .u-row[data-id=b2] .u-message').first();
    await target.scrollIntoViewIfNeeded(); const tb = await target.boundingBox();
    await page.mouse.click(tb.x + 10, tb.y + 8, {button: 'right'});
    const mb = await page.locator('.u-menu').boundingBox(), vh = viewport.height;
    // Right-click menu opens at the pointer (inside the window, even when Messenger is offset on the page).
    assert.ok(Math.abs(mb.x - (tb.x + 10)) < 40 || mb.x + mb.width <= viewport.width - 4, 'menu x near pointer: ' + mb.x + ' vs ' + (tb.x + 10));
    assert.ok(mb.y >= 0 && mb.y + mb.height <= vh, 'menu inside the window');
    if (label === '1280') assert.ok(Math.abs(mb.x - (tb.x + 10)) < 40 && (Math.abs(mb.y - (tb.y + 8)) < 20 || Math.abs(mb.y + mb.height - (tb.y + 8)) < 20), 'menu at pointer: ' + JSON.stringify(mb) + ' ' + JSON.stringify(tb));
    await shot('menu-at-pointer');
    await page.getByRole('menuitem', {name: /Reply/}).click();
    assert.match(await pill.textContent(), /Replying on\s*WhatsApp/);
    await shot('reply-on');
    await pill.click();
    await page.getByRole('menuitem', {name: /Telegram/}).click();
    assert.match(await pill.textContent(), /Replying on\s*Telegram/);
    await closeChat();

    // Link preview card, reply card, reaction pill; header ⋯ offers Mark as unread and Merge with…
    await page.locator('.u-person', {hasText: 'Bo Chen'}).click();
    await page.locator('.u-row[data-id=b3] .u-link-card').waitFor();
    assert.match(await page.locator('.u-row[data-id=b3] .u-link-card').textContent(), /Example article/);
    await page.waitForFunction(() => document.querySelector('.u-row[data-id=b3] .u-link-img')?.complete);
    assert.equal(await page.locator('.u-row[data-id=b3] .u-quote').count(), 1);
    assert.match(await page.locator('.u-row[data-id=b4] .u-story-tag').textContent(), /Reacted to your story/);
    assert.equal(await page.locator('.u-row[data-id=b4]', {hasText: 'instagram.com/stories'}).count(), 0, 'no raw story markup');
    await page.locator('.u-row[data-id=b5]').scrollIntoViewIfNeeded();
    await shot('previews');
    await page.locator('.u-thread-head .icon-button[aria-label="Chat options"]').click();
    await page.getByRole('menuitem', {name: 'Merge with…'}).click();
    await page.locator('.u-pick-row', {hasText: 'Ana from Contacts'}).first().waitFor();
    await shot('merge-picker');
    if (await page.locator('#u-overlay .icon-button[aria-label=Close]').count()) await page.locator('#u-overlay .icon-button[aria-label=Close]').click();
    await page.locator('.u-thread-head .icon-button[aria-label="Chat options"]').click();
    await page.getByRole('menuitem', {name: 'Mark as unread'}).waitFor();
    await page.keyboard.press('Escape'); if (await page.locator('#u-overlay').count()) await page.locator('#u-overlay').click({position: {x: 5, y: 5}});
    await closeChat();
    // Group bubbles carry the sender's picture.
    await page.locator('.u-person', {hasText: 'Family'}).click();
    await page.locator('.u-row[data-id=f1]').waitFor();
    await page.waitForFunction(() => document.querySelector('.u-row[data-id=f1] .u-avatar.has-img'));
    assert.ok(pics.some(x => x[0] === 'fam' && x[1] === 'Pedro'));
    await closeChat();

    // Slack: browser sign-in first, email second, no developer-tools steps.
    await page.locator('.u-settings-btn').click();
    const card = page.locator('.c-card[data-network=slack]');
    await card.waitFor();
    assert.deepEqual(await card.locator('button').evaluateAll(b => b.map(x => x.textContent.trim())), ['Sign in with your browser', 'Sign in with email']);
    await card.getByRole('button', {name: /Sign in with your browser/}).click();
    await page.locator('.c-live-img[src^="data:image"]').waitFor();
    assert.match(await page.locator('.c-live-hint').textContent(), /use Slack in your browser/);
    assert.equal(await page.locator('.u-sheet', {hasText: /F12|Console|cURL|xoxc/}).count(), 0, 'no developer-tools instructions');
    await page.locator('.c-live-img').click({position: {x: 50, y: 60}});
    await page.locator('.c-live-type').pressSequentially('me@acme.com');
    await page.getByRole('button', {name: 'Enter ⏎'}).click();
    const ib = await page.locator('.c-live-img').boundingBox();
    await page.mouse.move(ib.x + ib.width / 2, ib.y + ib.height * .7); await page.mouse.down();
    for (let k = 1; k <= 6; k++) await page.mouse.move(ib.x + ib.width / 2, ib.y + ib.height * .7 - k * 30);
    await page.mouse.up(); await page.waitForTimeout(400);
    const scrolled = inputs.filter(i => i.type === 'scroll').reduce((a, i) => a + i.dy, 0);
    assert.ok(scrolled > 60, 'drag scrolls the page live: ' + scrolled);
    assert.ok(ib.height <= viewport.height * .7, 'live page fits the window: ' + ib.height);
    await shot('slack-live'); finishAfter();
    await page.getByText('Slack connected').waitFor({timeout: 15000});
    assert.ok(inputs.some(i => i.type === 'tap' && i.x > 0 && i.x < 1), 'tap mapped to page coordinates');
    assert.equal(inputs.filter(i => i.type === 'text').map(i => i.text).join(''), 'me@acme.com');
    assert.ok(inputs.some(i => i.type === 'key' && i.key === 'Enter'));
    await shot('slack-done');
    assert.deepEqual(errors, [], 'no page errors');
    summary.push(label);
    await ctx.close();
  }
  await browser.close();
  console.log('PASS merge_pictures_browser: ' + summary.join(', ') + ' · pictures, suggested merges, Replying on, group faces, Slack browser sign-in');
})().catch(e => { console.error('FAIL', e); process.exit(1); });
