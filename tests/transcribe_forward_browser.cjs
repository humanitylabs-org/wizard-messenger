// Disposable preview only. Real Messenger persistence/API; fake shell transcriber and outgoing share receipts.
const {chromium} = require('playwright');
const fs = require('node:fs');
const {execFileSync} = require('node:child_process');
const assert = require('node:assert/strict');
(async () => {
  const base = process.env.PREVIEW_URL || 'https://localhost:19253/';
  assert.match(new URL(base).hostname, /^(localhost|127\.0\.0\.1)$/, 'preview only');
  const ev = process.env.EVIDENCE_DIR || './evidence'; fs.mkdirSync(ev, {recursive: true});
  const transcript = 'Miguel says: Let us think through the next step together. ' + 'This longer transcript wraps safely inside the voice-note bubble. '.repeat(3).trim();
  let transcribes = 0; const shares = [], inputs = []; let receipt = 'sent';
  const browser = await chromium.launch({headless: true});
  const ctx = await browser.newContext({viewport: {width: 390, height: 844}, deviceScaleFactor: 2, colorScheme: 'dark', ignoreHTTPSErrors: true, hasTouch: true, isMobile: true, timezoneId: 'UTC'});
  await ctx.exposeBinding('__transcribe', (_, data) => { transcribes++; inputs.push(data); return {text: transcript}; });
  await ctx.exposeBinding('__share', (_, data) => { shares.push(data); return receipt; });
  await ctx.addInitScript(() => {
    let app; Object.defineProperty(window, 'WizardApp', {configurable: true, get: () => app, set(v) { app = Object.freeze({...v,
      back: {...v.back, register(h) {window.__backHandler = h; return v.back.register(h);}},
      voice: window.__oldShell ? undefined : {transcribe: async file => window.__transcribe({type: file.type, bytes: Array.from(new Uint8Array(await file.arrayBuffer()))})},
      share: {get wizard() {return window.__legacyShare ? undefined : async data => window.__share({kind:'wizard', text:data.text, title:data.title, files: await Promise.all(data.files.map(async f => ({name:f.name,type:f.type,bytes:Array.from(new Uint8Array(await f.arrayBuffer()))})))});}, file: async (file, options) => window.__share({kind: 'file', name: file.name, type: file.type, bytes: Array.from(new Uint8Array(await file.arrayBuffer())), options}), text: data => window.__share({kind: 'text', ...data})},
      vault: {has: async () => ({available: false, saved: false})},
      update: {...v.update, hold(reason) {const h = {reason, released: false}; (window.__holds ||= []).push(h); return {release() {h.released = true;}};}},
    }); }});
  });
  const sr = 16000, n = sr * 2, wav = Buffer.alloc(44 + n * 2);
  wav.write('RIFF', 0); wav.writeUInt32LE(36 + n * 2, 4); wav.write('WAVEfmt ', 8); wav.writeUInt32LE(16, 16); wav.writeUInt16LE(1, 20); wav.writeUInt16LE(1, 22);
  wav.writeUInt32LE(sr, 24); wav.writeUInt32LE(sr * 2, 28); wav.writeUInt16LE(2, 32); wav.writeUInt16LE(16, 34); wav.write('data', 36); wav.writeUInt32LE(n * 2, 40);
  for (let i = 0; i < n; i++) wav.writeInt16LE(Math.round(8000 * Math.sin(2 * Math.PI * 220 * i / sr)), 44 + i * 2);
  execFileSync('docker', ['exec', 'messenger-mvp-preview-messenger-1', 'python3', '-c', `
from unified import PeopleStore
s=PeopleStore('/data/unified/people.sqlite3')
a=s.identity('telegram','!preview-miguel','Miguel')
s.add_message('$v1',a,'Miguel',False,'',1792869840000,msgtype='m.audio',media={'voice':True,'duration':2000,'mime':'audio/wav'})
s.add_message('$t1',a,'Miguel',False,'What do you think of this idea?',1792869900000)
s.add_message('$v2',a,'You',True,'',1792869960000,msgtype='m.audio',media={'voice':True,'duration':2000,'mime':'audio/wav'})
`]);
  let mediaFetches = 0;
  await ctx.route(/api\/unified\/media\/%24v[12]/, route => {mediaFetches++; return route.fulfill({status: 200, contentType: 'audio/wav', body: wav});});
  const page = await ctx.newPage(), errors = [], changes = []; page.on('pageerror', e => errors.push(e.message));
  page.on('response', async r => { if (r.url().includes('api/unified/updates')) { try { const j=await r.json(); changes.push({status:r.status(),seq:j.result?.seq,removed:j.result?.removed,people:j.result?.people?.length}); } catch {} } });
  page.on('close', () => {});
  const ticket = JSON.parse(execFileSync('curl', ['-sf','-X','POST','-H','Authorization: Bearer ' + process.env.MESSENGER_API_TOKEN,'-H','Content-Type: application/json','-d','{"bootstrap":true}','http://127.0.0.1:19252/api/view/ticket'])).result.ticket;
  await page.goto(base + '#ticket=' + ticket); await page.waitForTimeout(2000);
  if (!(await page.locator('#setup-form').isVisible())) await page.click('#inbox-tabs [data-tab="messenger"]');
  await page.locator('#confirm-passphrase').waitFor({state: 'visible', timeout: 30000});
  const pw = 'preview-only-passphrase-' + Date.now(); await page.fill('#passphrase', pw); await page.fill('#confirm-passphrase', pw); await page.click('#setup-submit');
  await page.locator('#inbox-tabs').waitFor({state: 'visible', timeout: 60000});
  if (await page.locator('#sheet-layer:not([hidden])').count()) await page.click('#close-sheet');
  await page.click('#inbox-tabs [data-tab="people"]');
  await page.locator('.u-person', {hasText: 'Miguel'}).click();
  const note = page.locator('.u-row').filter({has: page.locator('.u-voice')}).first();
  await note.locator('.u-transcribe').click(); await note.locator('.u-transcript:not([hidden])').waitFor({timeout: 10000});
  assert.equal(await note.locator('.u-transcript').textContent(), transcript); assert.equal(transcribes, 1);
  assert.equal(inputs[0].type, 'audio/wav'); assert.deepEqual(Buffer.from(inputs[0].bytes), wav);
  assert.equal(await page.locator('.u-row.outgoing .u-transcribe').count(), 1, 'outgoing voice note has the same renderer/button');
  const geometry = async () => page.evaluate(() => {
    const selectors = ['.u-transcript:not([hidden])', '.u-selection:not([hidden])', '.u-message'];
    return selectors.flatMap(s => [...document.querySelectorAll(s)].map(e => ({s, left: e.getBoundingClientRect().left, right: e.getBoundingClientRect().right, sw: e.scrollWidth, cw: e.clientWidth}))).filter(r => r.left < -1 || r.right > innerWidth + 1 || r.sw > r.cw + 2);
  });
  assert.deepEqual(await geometry(), []); await page.screenshot({path: ev + '/transcript-dark.png'});
  await page.reload(); await page.locator('.u-transcript:not([hidden])').waitFor({timeout: 20000});
  assert.equal(transcribes, 1, 'persisted transcript never retranscribes on reload');
  const persisted = await page.evaluate(async () => { const r = await fetch('api/unified/people'); const people = (await r.json()).result.people; return (await (await fetch('api/unified/people/' + people.find(p => p.display_name === 'Miguel').id)).json()).result.messages.find(m => m.id === '$v1').transcript; });
  assert.equal(persisted, transcript, 'read back exact persisted target from the real server');
  const cdp = await ctx.newCDPSession(page);
  const press = async locator => { await locator.scrollIntoViewIfNeeded(); const r = await locator.boundingBox(); await cdp.send('Input.dispatchTouchEvent', {type:'touchStart', touchPoints:[{x:r.x+12, y:r.y+r.height-8}]}); await page.waitForTimeout(800); await cdp.send('Input.dispatchTouchEvent', {type:'touchEnd', touchPoints:[]}); };
  await page.locator('.u-message').first().tap({position:{x:12,y:12}});
  assert.equal(await page.getByRole('menuitem', {name:'Select',exact:true}).count(),0);
  await page.getByRole('menuitem', {name:'Forward to Wizard',exact:true}).waitFor();
  await page.screenshot({path:ev+'/tap-menu-dark.png'});
  { const vp = page.viewportSize(); await page.touchscreen.tap(Math.round(vp.width/2), 90); }
  await page.waitForTimeout(150);
  assert.equal(await page.getByRole('menu').count(), 0, 'tapping outside the menu closes it without Back');
  assert.equal(await page.locator('.u-selection:not([hidden])').count(), 0, 'outside tap is consumed, nothing beneath reacts');
  await page.locator('.u-vplay').first().tap();
  assert.equal(await page.getByRole('menu').count(),0,'play is not a menu gesture');
  await page.locator('.u-vplay').first().tap();
  const vpFull = page.viewportSize(); await page.setViewportSize({width: vpFull.width, height: 380}); await page.waitForTimeout(300);
  const target = page.locator('.u-message').nth(1); await target.evaluate(el => el.scrollIntoView({block: 'center'})); await page.waitForTimeout(200);
  const overflow = await page.evaluate(() => { const s = document.querySelector('.u-scroll,#u-scroll,.u-thread-scroll') || [...document.querySelectorAll('*')].find(n => ['auto','scroll'].includes(getComputedStyle(n).overflowY) && n.querySelector('.u-row')); return s ? s.scrollHeight - s.clientHeight : -1; });
  const y0 = (await target.boundingBox()).y;
  await press(target);
  const y1 = (await target.boundingBox()).y;
  console.log('anchor', {overflow, y0, y1});
  assert.ok(overflow > 0, 'thread scrolls in the anchor check'); assert.ok(Math.abs(y1 - y0) < 4, 'long-press selection keeps the pressed message in place (' + y0 + ' -> ' + y1 + ')');
  await page.setViewportSize(vpFull); await page.waitForTimeout(300);
  await page.getByRole('button', {name: 'Cancel', exact: true}).click(); await page.locator('.u-selection').waitFor({state: 'hidden'});
  await press(page.locator('.u-message').first());
  assert.equal(await page.evaluate(() => window.getSelection().toString()),'','initial touch hold never highlights text');
  assert.equal(await page.getByRole('menu').count(),0);
  await page.getByRole('button', {name: 'Forward to Wizard', exact: true}).waitFor();
  assert.equal(await page.locator('.u-selection strong').textContent(), '1 selected');
  await page.locator('.u-message', {hasText: 'What do you think'}).tap();
  assert.equal(await page.locator('.u-selection strong').textContent(), '2 selected');
  assert.equal(await page.locator('.u-row.u-selected').count(), 2);
  // The next long-press is native: selectstart and contextmenu are no longer cancelled.
  await press(page.locator('.u-message', {hasText:'What do you think'}));
  const nativeSelection = await page.locator('.u-message', {hasText:'What do you think'}).evaluate(el => {
    const selection = new Event('selectstart',{bubbles:true,cancelable:true}); el.dispatchEvent(selection);
    const menu = new Event('contextmenu',{bubbles:true,cancelable:true}); el.dispatchEvent(menu);
    return {selection:selection.defaultPrevented,menu:menu.defaultPrevented,style:getComputedStyle(el).userSelect};
  });
  assert.deepEqual(nativeSelection,{selection:false,menu:false,style:'text'});
  await page.evaluate(() => window.getSelection().removeAllRanges());
  assert.deepEqual(await geometry(), []); await page.screenshot({path: ev + '/selection-dark.png'});
  assert.equal(await page.evaluate(() => window.__backHandler.back()), true, 'registered platform Back consumes selection');
  assert.equal(await page.locator('.u-selection').isVisible(), false); assert.equal(await page.locator('.u-timeline').count(), 1, 'Back stays in thread');
  await press(page.locator('.u-message').first());
  await page.locator('.u-message', {hasText:'What do you think'}).tap();
  assert.ok(!(await page.evaluate(() => (window.__holds || []).filter(h => !h.released).map(h => h.reason))).some(r => /unified|sending|recording/i.test(r)), 'selection is not unsent work and holds no Wizard updates');
  await page.locator('.u-row.outgoing .u-message').tap();
  assert.equal(await page.locator('.u-selection strong').textContent(),'3 selected');
  const beforeFetch = mediaFetches;
  await page.getByRole('button', {name:'Forward to Wizard',exact:true}).click();
  await page.locator('.u-selection').waitFor({state:'hidden',timeout:10000});
  assert.ok(mediaFetches <= beforeFetch + 1, 'incoming file reuses preloaded bytes; outgoing downloads at most once');
  assert.equal(shares.length, 1); assert.equal(shares[0].kind,'wizard');
  assert.equal(shares[0].files.length,2); assert.match(shares[0].files[0].name,/^Miguel voice note 2026-10-24 \d{2}-\d{2}\.wav$/);
  assert.equal(shares[0].files[0].type,'audio/wav'); assert.deepEqual(Buffer.from(shares[0].files[0].bytes),wav);
  assert.deepEqual(Buffer.from(shares[0].files[1].bytes),wav); assert.match(shares[0].files[1].name,/^You voice note/);
  assert.match(shares[0].text,/Miguel \(.+\):/); assert.ok(shares[0].text.includes(transcript)); assert.ok(shares[0].text.endsWith('What do you think of this idea?'));
  await page.locator('.u-toast', {hasText:'Sent to Wizard'}).waitFor();
  // Tap-menu single-message forward uses exactly the same internal operation.
  await page.locator('.u-message', {hasText:'What do you think'}).tap();
  await page.getByRole('menuitem',{name:'Forward to Wizard',exact:true}).click();
  await page.locator('.u-selection').waitFor({state:'hidden'});
  assert.equal(shares.length,2); assert.equal(shares[1].kind,'wizard'); assert.equal(shares[1].files.length,0);
  // Old shell: only when .wizard is missing use the legacy ordered file/text receipts.
  await page.evaluate(() => {window.__legacyShare=true;}); receipt='shared';
  await press(page.locator('.u-message').first()); await page.locator('.u-message',{hasText:'What do you think'}).tap();
  await page.getByRole('button',{name:'Forward to Wizard',exact:true}).click(); await page.locator('.u-selection').waitFor({state:'hidden'});
  assert.equal(shares.length,4); assert.equal(shares[2].kind,'file'); assert.equal(shares[3].kind,'text');
  await page.evaluate(() => {window.__legacyShare=false;}); receipt='sent';
  await page.waitForTimeout(4700);
  // A live skin change: retain the transcript, use the host's token roles, no state reset.
  await page.evaluate(() => {document.documentElement.dataset.wzHosted=''; document.documentElement.dataset.colorScheme='light'; const s=document.documentElement.style; for(const [k,v] of Object.entries({'base':'#f5f2ec','canvas':'#f5f2ec','surface':'#ffffff','surface-raised':'#eee8dd','chrome':'#e9e3d8','text':'#211c17','text-secondary':'#62584c','text-muted':'#756958','accent':'#674a29','accent-soft':'#e9ddcb','on-accent':'#ffffff','border':'#d4c7b8'})) s.setProperty('--wz-'+k,v);});
  const outgoing = await page.locator('.u-row.outgoing .u-message').evaluate(el => getComputedStyle(el).backgroundColor);
  assert.equal(outgoing,'rgb(44, 107, 237)','outgoing retains the original blue, not brown host accent');
  await page.screenshot({path:ev+'/outgoing-blue-light.png'});
  await page.screenshot({path:ev+'/transcript-light.png'});
  await press(page.locator('.u-message').first());
  assert.deepEqual(await geometry(),[]); await page.screenshot({path:ev+'/selection-light.png'});
  // A cancelled share keeps selection, never claims delivery.
  receipt='cancelled'; await page.getByRole('button',{name:'Forward to Wizard',exact:true}).click();
  await page.locator('.u-toast',{hasText:'Share cancelled'}).waitFor(); assert.equal(await page.locator('.u-selection').isVisible(),true);
  await page.getByRole('button',{name:'Cancel',exact:true}).click();
  assert.equal(await page.locator('.u-timeline').count(),1);
  await page.waitForTimeout(4700);
  // Wide desktop geometry uses the same renderer (no separate desktop transcription logic).
  await page.setViewportSize({width:1280,height:900}); await page.waitForTimeout(200); assert.deepEqual(await geometry(), []);
  await page.screenshot({path:ev+'/transcript-desktop.png'});
  // An old shell has no voice API: leave its untranscribed outgoing bubble intact, but hide Transcribe.
  await ctx.addInitScript(() => {window.__oldShell = true;});
  await page.reload(); await page.locator('.u-transcript:not([hidden])').waitFor({timeout:20000});
  assert.equal(await page.locator('.u-transcribe').count(),0); assert.equal(transcribes,1);
  // Text-only Marmot/Messenger tab reuses the same selection controller, including platform Back.
  await page.setViewportSize({width:390,height:844});
  const own = await page.evaluate(async () => (await (await fetch('api/identity')).json()).result.identity);
  const nativeDM = {group_id:'ab'.repeat(32), members:[own,{member_id:'cd'.repeat(32),display_name:'Marmot Miguel'}], pending_confirmation:false};
  const nativeMsg = {message_id:'ef'.repeat(32), group_id:nativeDM.group_id, direction:'received', author:'cd'.repeat(32), text:'A note from the Messenger tab', created_at:1792869900};
  await ctx.route(/\/api\/dms$/, r => r.fulfill({status:200,contentType:'application/json',body:JSON.stringify({ok:true,result:{dms:[nativeDM]}})}));
  await ctx.route(/\/api\/dms\/ab[ab]+\/messages/, r => r.fulfill({status:200,contentType:'application/json',body:JSON.stringify({ok:true,result:{messages:[nativeMsg]}})}));
  await page.evaluate(() => window.__backHandler.back());
  await page.click('#inbox-tabs [data-tab="messenger"]');
  await page.reload(); await page.locator('.conversation-row',{hasText:'Marmot Miguel'}).click({timeout:20000});
  await page.locator('#messages .bubble',{hasText:nativeMsg.text}).waitFor();
  await press(page.locator('#messages .bubble').first());
  assert.equal(await page.locator('#chat .u-selection strong').textContent(),'1 selected');
  assert.equal(await page.evaluate(() => window.__backHandler.back()),true); assert.equal(await page.locator('#chat').isVisible(),true);
  await press(page.locator('#messages .bubble').first());
  receipt='sent'; const nativeStart=shares.length;
  await page.getByRole('button',{name:'Forward to Wizard',exact:true}).click();
  await page.locator('#chat .u-selection').waitFor({state:'hidden'}); assert.equal(shares.length,nativeStart+1); assert.match(shares.at(-1).text,/Marmot Miguel \(.+\): A note from the Messenger tab/);
  await page.locator('#messages .bubble').first().tap();
  assert.equal(await page.getByRole('menuitem',{name:'Select',exact:true}).count(),0);
  await page.getByRole('menuitem',{name:'Forward to Wizard',exact:true}).waitFor();
  await page.screenshot({path:ev+'/messenger-tap-menu.png'}); await page.evaluate(() => window.__backHandler.back());
  // Removing a Telegram conversation by redactions updates the open list without a reload.
  await page.evaluate(() => window.__backHandler.back());
  await page.click('#inbox-tabs [data-tab="people"]');
  await page.locator('.u-person',{hasText:'Miguel'}).waitFor();
  const fixtureId = await page.evaluate(async() => (await(await fetch('api/unified/people')).json()).result.people.find(p=>p.display_name==='Miguel').id);
  // The fixture writer is another process; pulse the live store's in-memory change counter via its
  // authenticated mutation route. Real bridge redactions run in that store and notify it directly.
  const pulse = async () => page.evaluate(async id => {
    const csrf=(await(await fetch('api/view/session')).json()).result.csrf_token;
    for(let n=0;n<12;n++){const r=await fetch('api/unified/people/'+id,{method:'POST',headers:{'Content-Type':'application/json','X-Messenger-CSRF':csrf},body:JSON.stringify({muted:!!(n%2)})});if(!r.ok)throw Error('Fixture pulse failed '+r.status);}
  },fixtureId);
  execFileSync('docker',['exec','-i','messenger-mvp-preview-messenger-1','python3','-c',"from unified import PeopleStore; s=PeopleStore('/data/unified/people.sqlite3'); [s.redact(x) for x in ['$v1','$v2','$t1']]"],{timeout:30000});
  await pulse();
  await page.locator('.u-person',{hasText:'Miguel'}).waitFor({state:'hidden',timeout:45000}).catch(async e => { console.log(JSON.stringify({changes,api:await page.evaluate(async()=>await(await fetch('api/unified/people')).json())})); throw e; });
  execFileSync('docker',['exec','-i','messenger-mvp-preview-messenger-1','python3','-c',"from unified import PeopleStore; s=PeopleStore('/data/unified/people.sqlite3'); a=s.identity('telegram','!preview-miguel','Miguel'); s.add_message('$back',a,'Miguel',False,'A new message restores this chat',1792869990000)"],{timeout:30000});
  await pulse();
  await page.locator('.u-person',{hasText:'Miguel'}).waitFor({timeout:45000});
  fs.writeFileSync(ev+'/receipt.json',JSON.stringify({transcribes,shares:shares.map(({bytes,...x})=>({...x,bytes:bytes?.length})),mediaFetches,errors},null,2));
  assert.deepEqual(errors,[]); await browser.close(); console.log('pass: persistence, bytes, incoming/outgoing UI, tap menus, CDP touch selection + native second hold, platform Back, internal batch share + legacy fallback, cancel, no update holds, two skins');
})().catch(e=>{console.error('FAIL',e.stack);process.exit(1);});
