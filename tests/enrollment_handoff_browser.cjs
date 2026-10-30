// A preview must not spend the owner's one-use setup capability.
const {chromium} = require(process.env.PLAYWRIGHT_MODULE || 'playwright');
const fs = require('node:fs'), path = require('node:path'), assert = require('node:assert/strict');
const root = path.resolve(process.argv[2] || path.join(__dirname, '../static'));
const types = {'.js':'application/javascript','.html':'text/html','.css':'text/css','.svg':'image/svg+xml'};
(async () => {
  const browser = await chromium.launch();
  let exchanges = 0;
  async function context() {
    const ctx = await browser.newContext();
    await ctx.addInitScript(() => {
      const noop = () => {};
      window.WizardApp = {ready:noop,update:{hold:()=>noop},back:{register:noop},on:noop,nav:{},toast:noop};
    });
    await ctx.route('http://messenger.test/**', async route => {
      const req=route.request(), p=new URL(req.url()).pathname;
      const reply=(status,result,headers={}) => route.fulfill({status,contentType:'application/json',headers,body:JSON.stringify(status===200?{ok:true,result}:{ok:false,error:{code:'setup_link_required',message:'Setup link required'}})});
      if (p==='/api/view/session') {
        if (req.method()==='POST') {
          assert.equal(req.postDataJSON().ticket,'fixture-owner-enrollment');
          assert.equal(exchanges,0,'single-use fixture is not replayed'); exchanges++;
          return reply(200,{authenticated:true,csrf_token:'fixture-csrf'},{'Set-Cookie':'messenger_fixture=1; Path=/; HttpOnly; SameSite=Strict'});
        }
        return (req.headers().cookie||'').includes('messenger_fixture=1') ? reply(200,{authenticated:true,csrf_token:'fixture-csrf'}) : reply(401,{});
      }
      if (p==='/api/status') return reply(200,{state:'setup_required',account_configured:false});
      if (p.startsWith('/api/')) return reply(200,{});
      const file=path.join(root,p==='/'?'index.html':p);
      if (!file.startsWith(root) || !fs.existsSync(file)) return route.fulfill({status:404,body:''});
      return route.fulfill({status:200,contentType:types[path.extname(file)]||'application/octet-stream',body:fs.readFileSync(file)});
    });
    return ctx;
  }
  const preview=await context(), user=await context();
  const p=await preview.newPage();
  await p.goto('http://messenger.test/#ticket=fixture-owner-enrollment');
  await p.getByRole('button',{name:'Continue setup',exact:true}).waitFor();
  await p.waitForTimeout(250);
  assert.equal(exchanges,0,'automatic preview leaves capability unused');
  assert.equal(new URL(p.url()).hash,'','capability is removed from browser history');
  const page=await user.newPage();
  await page.goto('http://messenger.test/#ticket=fixture-owner-enrollment');
  await page.getByRole('button',{name:'Continue setup',exact:true}).waitFor();
  await preview.close();
  assert.equal(exchanges,0,'a second browser context can still use the original link');
  await page.getByRole('button',{name:'Continue setup',exact:true}).click();
  await page.locator('#setup-form').waitFor({state:'visible'});
  assert.equal(exchanges,1,'only explicit owner continuation redeems it');
  await page.reload();
  await page.locator('#setup-form').waitFor({state:'visible'});
  assert.equal(exchanges,1,'existing cookie recovers setup after reload');
  assert.doesNotMatch(await page.locator('#gate-description').innerText(),/Ask your Wizard/);
  await browser.close();
  console.log('PASS enrollment_handoff_browser: preview, cross-context handoff, owner click, cookie recovery');
})().catch(e=>{console.error(e);process.exit(1)});
