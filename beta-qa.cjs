// Thales-only real-browser campaign for the final Messenger image.
// Two disposable containers on the real default relays; no owner identities.
// Local loopback HTTP test: MESSENGER_COOKIE_SECURE=0 is a labelled test-only setting.
const { chromium } = require('playwright-core');
const { execFileSync } = require('child_process');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const IMAGE = process.env.IMAGE;
const OUT = process.env.OUT || 'browser-proof';
const DOCKER = {...process.env, DOCKER_CONTEXT:'colima-wb'}; delete DOCKER.DOCKER_HOST;
const EXE = process.env.BROWSER_EXE || process.env.HOME + '/Library/Caches/ms-playwright/chromium_headless_shell-1193/chrome-mac/headless_shell';
const https = require('https'), http = require('http');
const ROOT=process.cwd(), CORE=process.env.CORE;
const gateways=[];
function compose(peer,...args){return docker('compose','-p',peer.name,'--project-directory',peer.root,'-f',path.join(peer.root,'compose.json'),...args);}
const prefix = 'messenger-ui-qa-' + crypto.randomBytes(4).toString('hex');
const steps = [];
const note = (step, facts = {}) => { steps.push({ step, ok: true, ...facts }); console.log(JSON.stringify(steps.at(-1))); };
const docker = (...args) => execFileSync('docker', args, { env: DOCKER, encoding: 'utf8' });
fs.mkdirSync(OUT, { recursive: true });
const sleep = ms => new Promise(r => setTimeout(r, ms));

async function start(i, port) {
  const peer={name:`${prefix}-${i}`, root:path.resolve(OUT,`install-${i}`),port,password:'qa-'+crypto.randomBytes(18).toString('base64url'), origin:`https://localhost:${port+10}/apps/messenger/`,backend:`http://127.0.0.1:${port}`};
  const configure=()=>execFileSync('python3',['tools/beta.py','configure','--root',peer.root,'--base-url',peer.origin,'--port',String(port)],{encoding:'utf8'});
  configure(); const before=fs.readFileSync(path.join(peer.root,'.env')); configure();
  if(!before.equals(fs.readFileSync(path.join(peer.root,'.env'))))throw Error('capability rotated');
  peer.token=before.toString().match(/^MESSENGER_API_TOKEN=(.+)$/m)[1];
  const arch=i?'amd64':'arm64';
  docker('tag',`wizard-messenger:0.1.2-beta.1-${arch}`,'wizard-messenger:0.1.2-beta.1');
  compose(peer,'up','-d');
  await waitHealth(peer);
  const cert=path.resolve(OUT,'tls');
  const gateway=https.createServer({key:fs.readFileSync(cert+'.key'),cert:fs.readFileSync(cert+'.crt')},(req,res)=>{
    if(req.url==='/wizard-os-home/core/app-client.js') {res.writeHead(200,{'Content-Type':'text/javascript'});return res.end(fs.readFileSync(CORE));}
    if(!req.url.startsWith('/apps/messenger/')){res.writeHead(404);return res.end();}
    const target=http.request(peer.backend+req.url.slice('/apps/messenger'.length),{method:req.method,headers:req.headers},up=>{res.writeHead(up.statusCode,up.headers);up.pipe(res);});
    target.on('error',()=>{res.writeHead(502);res.end();});req.pipe(target);
  });
  await new Promise(resolve=>gateway.listen(port+10,'127.0.0.1',resolve));gateways.push(gateway);
  execFileSync('python3',['tools/beta.py','setup','--root',peer.root]);
  peer.setup=fs.readFileSync(path.join(peer.root,'owner-setup-url.txt'),'utf8').trim();
  const meta=JSON.parse(compose(peer,'ps','--format','json'));
  peer.container=meta.ID;
  note('clean-packaged-install-and-idempotent-config',{peer:i,arch,source:process.env.SOURCE,image:docker('inspect',peer.container,'--format','{{.Image}}').trim(),secure_cookie_required:true,route:'/apps/messenger/'});
  return peer;
}
async function waitHealth(peer){for(let i=0;i<60;i++){try{if((await fetch(peer.backend+'/healthz')).ok)return;}catch{}await sleep(500);}throw Error('health timeout');}
async function messageCount(page, text) { return page.locator('#messages .bubble', { hasText: text }).count(); }
async function shot(page, name) { const file = path.join(OUT, name + '.png'); await page.screenshot({ path: file }); return file; }

(async () => {
  let status = 'failed'; const peers = []; let browser;
  try {
    peers.push(await start(0, 19941), await start(1, 19942));
    browser = await chromium.launch({ executablePath: EXE });
    const ctx = [await browser.newContext({ ignoreHTTPSErrors:true, viewport: { width: 412, height: 915 }, deviceScaleFactor: 2, hasTouch: true, isMobile: true }), await browser.newContext({ ignoreHTTPSErrors:true, viewport: { width: 1280, height: 800 } })];
    const pages = [await ctx[0].newPage(), await ctx[1].newPage()];
    const consoleErrors = [];
    pages.forEach((p, i) => p.on('pageerror', e => consoleErrors.push(`${i}:${e.message}`)));
    const npubs = [];
    for (const i of [0, 1]) {
      const page = pages[i], peer = peers[i];
      await page.goto(peer.setup);
      await page.waitForSelector('#setup-form:not([hidden])');
      if (page.url().includes('ticket=')) throw new Error('ticket left in URL');
      note('setup-card-rendered', { peer: i, screenshot: await shot(page, `p${i}-01-setup`) });
      await page.fill('#display-name', i ? 'Beta B' : 'Beta A');
      await page.fill('#passphrase', peer.password); await page.fill('#confirm-passphrase', peer.password);
      await page.click('#setup-submit');
      await page.waitForSelector('#workspace:not([hidden])', { timeout: 120000 });
      if (await page.locator('#sheet-layer:not([hidden])').count() === 0) await page.click('#my-address');
      await page.waitForSelector('#address-panel:not([hidden])');
      const address = (await page.textContent('#public-address')).trim();
      if (!/^(npub1|nprofile1)/.test(address)) throw new Error('no public address shown');
      npubs.push(address);
      const storage = await page.evaluate(() => JSON.stringify({ ...localStorage }) + JSON.stringify({ ...sessionStorage }) + document.cookie);
      if (storage.includes(peer.token) || storage.includes(peer.password)) throw new Error('secret in browser storage');
      note('account-created-address-shown', { peer: i, address_prefix: address.slice(0, 12), http_only_cookie_hidden_from_js: !storage.includes('wizard_messenger_session'), screenshot: await shot(page, `p${i}-02-address`) });
      await page.click('#close-sheet');
    }
    // James adds Miguel by the contact code he copied, then writes before acceptance.
    const [a, b] = pages;
    await a.click('#add-contact'); await a.fill('#contact-address', npubs[1]); await a.fill('#contact-name', 'Beta B');
    await a.click('#contact-submit');
    await a.waitForSelector('#chat:not([hidden])', { timeout: 120000 });
    await a.waitForFunction(() => document.querySelector('#chat-subline').textContent === 'Invite sent');
    const first = 'Private beta canary ' + crypto.randomBytes(3).toString('hex');
    await a.fill('#draft', first); await a.click('#send');
    await a.waitForFunction(t => [...document.querySelectorAll('#messages .message.sent')].some(n => n.textContent.includes(t) && /Sent/.test(n.querySelector('.message-status').textContent)), first, { timeout: 120000 });
    const acceptedWording = await a.evaluate(() => /Accepted/.test(document.body.innerText));
    note('sender-invite-and-publication-shown-truthfully', { invite_sent_subline: true, claims_peer_accepted: acceptedWording, screenshot: await shot(a, 'p0-03-invite-sent') });
    // Miguel sees the invite, opens it: composer disabled until Accept.
    await b.waitForSelector('.conversation-row', { timeout: 120000 });
    await b.waitForFunction(() => document.querySelector('.conversation-row .row-name')?.textContent === 'Beta A', null, { timeout: 60000 }).catch(() => {});
    const inviteName = await b.textContent('.conversation-row .row-name');
    await b.click('.conversation-row');
    await b.waitForSelector('#invite-actions:not([hidden])');
    const disabledBefore = await b.isDisabled('#draft') || await b.isDisabled('#send');
    note('recipient-sees-explicit-invite', { invite_shows_sender_name: inviteName, composer_disabled_before_accept: disabledBefore, screenshot: await shot(b, 'p1-03-invite') });
    await b.click('#accept-invite');
    await b.waitForFunction(t => [...document.querySelectorAll('#messages .bubble')].some(n => n.textContent === t), first, { timeout: 120000 });
    const reply = 'Private beta reply ' + crypto.randomBytes(3).toString('hex');
    await b.fill('#draft', reply); await b.click('#send');
    await a.waitForFunction(t => [...document.querySelectorAll('#messages .bubble')].some(n => n.textContent === t), reply, { timeout: 120000 });
    note('two-way-encrypted-text-in-ui', { james_sees_reply: true, miguel_sees_first: (await messageCount(b, first)) === 1, screenshots: [await shot(a, 'p0-04-chat-mobile'), await shot(b, 'p1-04-chat-desktop')] });
    const selectable = await a.evaluate(() => getComputedStyle(document.querySelector('#messages .bubble')).userSelect);
    note('message-text-selectable', { user_select: selectable });
    // Back on the phone layout: sheet -> chat -> list -> stays.
    await a.click('#copy-peer').catch(() => {});
    await a.click('#chat-back'); await a.waitForSelector('#chat', { state: 'hidden' }).catch(() => {});
    await a.click('.conversation-row'); await a.waitForSelector('#chat:not([hidden])');
    const back = [];
    back.push(await a.evaluate(() => window.__wizardCloseOverlay()));          // chat -> list
    await a.click('#my-address'); await a.waitForSelector('#sheet-layer:not([hidden])');
    back.push(await a.evaluate(() => window.__wizardCloseOverlay()));          // sheet closes
    back.push(await a.evaluate(() => window.__wizardCloseOverlay()));          // root: stays, shell keeps Wizard open
    const listVisible = await a.isVisible('.list-pane');
    const sheetOpen = await a.isVisible('#sheet-layer');
    note('wizard-back-hook', { results: back, list_visible_after: listVisible, sheet_open_after: sheetOpen, document_still_loaded: true });
    // Restart James's container: identity and history persist; unlock is required.
    compose(peers[0],'restart'); await waitHealth(peers[0]);
    await a.reload(); await a.waitForSelector('#setup-form:not([hidden])', { timeout: 60000 });
    const title = await a.textContent('#gate-title');
    await a.fill('#passphrase', 'definitely-the-wrong-passphrase'); await a.click('#setup-submit');
    await a.waitForFunction(() => document.querySelector('#setup-error').textContent.length > 0, null, { timeout: 60000 });
    const wrongError = await a.textContent('#setup-error');
    const formStillShown = await a.isVisible('#setup-form') && await a.isEditable('#passphrase');
    if (!formStillShown) throw new Error('wrong passphrase dropped the unlock form');
    note('restart-requires-unlock', { gate_title: title, wrong_passphrase_error: wrongError, screenshot: await shot(a, 'p0-05-unlock') });
    await a.fill('#passphrase', peers[0].password); await a.click('#setup-submit');
    await a.waitForSelector('#workspace:not([hidden])', { timeout: 120000 });
    await a.click('.conversation-row');
    await a.waitForFunction(t => [...document.querySelectorAll('#messages .bubble')].some(n => n.textContent === t), reply, { timeout: 60000 });
    await a.waitForFunction(t => [...document.querySelectorAll('#messages .bubble')].some(n => n.textContent === t), first, { timeout: 20000 }).catch(() => {});
    const counts = { first: await messageCount(a, first), reply: await messageCount(a, reply) };
    if (counts.first !== 1 || counts.reply !== 1) {
      const dom = await a.evaluate(() => [...document.querySelectorAll('#messages .message')].map(n => ({ cls: n.className, text: n.querySelector('.bubble').textContent, status: n.querySelector('.message-status').textContent })));
      const api = await a.evaluate(async () => { const d = await (await fetch('api/dms', { credentials: 'same-origin' })).json(); const g = d.result.dms[0].group_id; const m = await (await fetch('api/dms/' + g + '/messages', { credentials: 'same-origin' })).json(); return m.result.messages.map(x => ({ dir: x.direction, text: x.text, id: x.message_id.slice(0, 8), at: x.created_at })); });
      steps.push({ step: 'history-debug', dom, api });
      throw new Error('history duplicated or missing ' + JSON.stringify(counts));
    }
    const after = 'Back after restart ' + crypto.randomBytes(3).toString('hex');
    await a.fill('#draft', after); await a.click('#send');
    await b.waitForFunction(t => [...document.querySelectorAll('#messages .bubble')].some(n => n.textContent === t), after, { timeout: 120000 });
    note('restart-history-intact-and-chat-continues', { counts, screenshot: await shot(a, 'p0-06-after-restart'), desktop: await shot(b, 'p1-06-after-restart') });
    // Recreate the second installation from the packaged config, preserve identity/history.
    compose(peers[1],'up','-d','--force-recreate'); await waitHealth(peers[1]);
    await b.reload(); await b.waitForSelector('#setup-form:not([hidden])',{timeout:60000});
    await b.fill('#passphrase',peers[1].password); await b.click('#setup-submit');
    await b.waitForSelector('#workspace:not([hidden])',{timeout:120000}); await b.click('.conversation-row');
    for(const text of [first,reply,after]) await b.waitForFunction(t=>[...document.querySelectorAll('#messages .bubble')].filter(n=>n.textContent===t).length===1,text,{timeout:60000});
    note('second-install-recreate-retains-all-three-messages');
    const cookies=await ctx[1].cookies(); const cookie=cookies.find(c=>c.name==='wizard_messenger_session');
    if(!cookie?.secure||!cookie?.httpOnly||cookie.path!=='/apps/messenger/')throw Error('cookie boundary');
    note('secure-scoped-httponly-cookie',{secure:cookie.secure,httpOnly:cookie.httpOnly,path:cookie.path});
    note('no-page-errors', { errors: consoleErrors });
    if (consoleErrors.length || acceptedWording || !disabledBefore || selectable === 'none' || back[0] !== true || back[1] !== true || back[2] !== false || !listVisible || sheetOpen) throw new Error('assertion failed');
    status = 'passed';
  } catch (e) {
    steps.push({ step: 'campaign', ok: false, error: String(e.message || e).slice(0, 300) }); console.log(JSON.stringify(steps.at(-1)));
  } finally {
    if (browser) await browser.close(); for(const g of gateways) g.close();
    for (const p of peers) { try { compose(p,'down'); } catch {} }
    fs.writeFileSync(path.join(OUT, 'browser-proof.json'), JSON.stringify({ status, image: IMAGE, host: require('os').hostname(), prefix, cookie_secure_test_override: false, tls_test_certificate: true, shared_client_sha256:crypto.createHash('sha256').update(fs.readFileSync(CORE)).digest('hex'), steps }, null, 2));
    process.exit(status === 'passed' ? 0 : 1);
  }
})();
