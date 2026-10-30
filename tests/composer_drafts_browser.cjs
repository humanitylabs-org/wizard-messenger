// Disposable ViewServer + real unified store, fake Matrix provider. Owner's composer is the one draft UI.
const {chromium} = require(process.env.PLAYWRIGHT_MODULE || 'playwright');
const fs = require('node:fs'), path = require('node:path'), assert = require('node:assert/strict');
const dir = process.env.AGENT_STAGE_DIR || '/home/oscar/.hermes/cache/scratch/agentkeys';
const st = JSON.parse(fs.readFileSync(path.join(dir, 'state.json')));
const auth = {Authorization: 'Bearer ' + st.agents.Oscar, 'Content-Type': 'application/json'};
async function drafts() { return (await (await fetch(st.origin + '/api/drafts', {headers: auth})).json()).result.drafts; }
async function edit(d, text) {
  const r = await fetch(st.origin + '/api/drafts/' + d.id, {method:'POST', headers:auth,
    body:JSON.stringify({revision:d.revision,person_id:d.person_id,identity_id:d.identity_id,text})});
  assert.equal(r.status, 200, await r.text()); return (await drafts()).find(x=>x.id===d.id);
}
(async()=>{
  const browser=await chromium.launch();
  for (const width of [390,1280]) {
    const ctx=await browser.newContext({viewport:{width,height:844}});
    await ctx.addCookies([{name:'wizard_messenger_session',value:st.cookie,url:st.origin}]);
    await ctx.route('**/wizard-os-home/**',r=>{const u=new URL(r.request().url());r.continue({url:'http://127.0.0.1:8796'+u.pathname});});
    const page=await ctx.newPage(), errors=[];page.on('pageerror',e=>errors.push(e.message));
    await page.goto(st.origin+'/'); await page.locator('.u-person',{hasText:'Alice Example'}).first().click();
    const field=page.locator('textarea[aria-label="Message"]'); await field.waitFor();
    await page.waitForTimeout(900); // first cached thread may rebuild after its server response
    await field.fill('Owner begins'); await page.waitForTimeout(1500);
    let d=(await drafts()).find(x=>x.person_id===st.alice); assert.equal(d.text,'Owner begins');
    d=await edit(d,'Owner begins; Oscar continues');
    await page.waitForTimeout(7000); assert.equal(await field.inputValue(),d.text);
    // The same composer accepts an image and stores its actual bytes with the draft.
    const png=fs.readFileSync(path.join(__dirname,'../evidence/01-chats.png'));
    await page.locator('input[type=file]').setInputFiles({name:'screenshot.png',mimeType:'image/png',buffer:png});
    await page.waitForTimeout(1400);d=(await drafts()).find(x=>x.id===d.id);
    assert.equal(d.attachments.length,1);
    // Reload must recover both text and image; there is no separate review screen.
    await page.reload(); await field.waitFor(); await page.waitForTimeout(1100);
    assert.equal(await field.inputValue(),'Owner begins; Oscar continues');
    assert.equal(await page.locator('.u-attach-strip').count(),1);
    await page.screenshot({path:path.join(dir,'composer-draft-'+width+'.png')});
    // Draft-only key is not a send key.
    const denied=await fetch(st.origin+'/api/drafts/'+d.id+'/send',{method:'POST',headers:auth,body:JSON.stringify({revision:d.revision})});
    assert.equal(denied.status,403);
    await page.getByRole('button',{name:'Send',exact:true}).last().click();
    await page.waitForTimeout(2500);
    assert.equal((await drafts()).filter(x=>x.id===d.id).length,0,'draft removed only after owner send succeeded');
    assert.deepEqual(errors,[]);
    await ctx.close();
  }
  await browser.close(); console.log('PASS owner composer: autosave, agent edit, image persistence, reload, owner-only send, mobile and desktop');
})().catch(e=>{console.error(e);process.exitCode=1});
