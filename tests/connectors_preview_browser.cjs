// Real isolated-stack proof. No mocked routes; requires an explicit loopback URL and disposable owner session.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const {chromium} = require('playwright');
(async () => {
  const base = process.env.MESSENGER_PREVIEW_URL;
  assert(base && /^http:\/\/127\.0\.0\.1:\d+$/.test(base), 'explicit loopback preview required');
  const session = JSON.parse(fs.readFileSync(process.env.MESSENGER_PREVIEW_SESSION, 'utf8'));
  const out = process.env.MESSENGER_PREVIEW_EVIDENCE; assert(out); fs.mkdirSync(out, {recursive:true});
  const browser = await chromium.launch({headless:true, args:['--no-sandbox']});
  const context = await browser.newContext({viewport:{width:360,height:640}, deviceScaleFactor:1, isMobile:true, hasTouch:true});
  const [name, ...value] = session.cookie.split('=');
  await context.addCookies([{name,value:value.join('='),url:base,httpOnly:true,sameSite:'Strict'}]);
  const page = await context.newPage(), errors = [], captured = {};
  page.on('pageerror', e => errors.push(e.message));
  page.on('response', async response => {
    const m = new URL(response.url()).pathname.match(/\/connectors\/(whatsapp|signal)\/start$/);
    if (!m || response.status() !== 200) return;
    const data = await response.json();
    assert(data.ok && data.result.type === 'display_and_wait' && data.result.display_and_wait.type === 'qr');
    captured[m[1]] = {response:data,headers:response.headers()};
  });
  const evidence = {base, viewport:{width:360,height:640}, real_bridges:true, networks:{}, page_errors:errors};
  try {
    await page.goto(base); await page.locator('#inbox-tabs').waitFor({state:'visible',timeout:30000});
    // Dismiss the fresh Messenger account's contact-address sheet without touching account settings.
    if (await page.locator('#u-overlay').count()) await page.getByRole('button',{name:'Close',exact:true}).click();
    for (const network of ['whatsapp','signal']) {
      await page.getByRole('button',{name:'Settings',exact:true}).click();
      const label = network === 'whatsapp' ? 'WhatsApp' : 'Signal';
      const card = page.locator('.u-connector-card').filter({has:page.locator('strong',{hasText:label})});
      await card.waitFor();
      const enable = card.getByRole('button',{name:'Enable '+label,exact:true});
      if (await enable.count()) await enable.click();
      await card.getByRole('button',{name:'Show QR code for '+label,exact:true}).waitFor({timeout:60000});
      await card.getByRole('button',{name:'Show QR code for '+label,exact:true}).click();
      const qr = page.locator('.u-connectors canvas.u-qr');
      await qr.waitFor({state:'visible',timeout:60000});
      assert(captured[network], 'real bridge QR API response recorded');
      const raw = captured[network].response.result.display_and_wait.data;
      assert(typeof raw === 'string' && raw.length > 20);
      assert.equal(captured[network].headers['cache-control'],'no-store');
      assert(await page.getByRole('dialog',{name:'Settings',exact:true}).isVisible());
      const box = await qr.boundingBox(); assert(box.x >= 0 && box.y >= 0 && box.x+box.width <= 360 && box.y+box.height <= 640);
      const screenshot = path.join(out,network+'-settings-360x640-dark.png');
      await page.screenshot({path:screenshot});
      await qr.screenshot({path:path.join(out,network+'-qr.png')});
      // Verify the existing sheet consumes the platform's shared skin variables.
      await page.evaluate(() => {
        const skin = {'--wz-canvas':'#f5f6f8','--wz-surface':'#ffffff','--wz-surface-raised':'#eef0f4','--wz-text':'#15171b','--wz-text-secondary':'#535862','--wz-text-muted':'#6b7280','--wz-border':'#d4d8df','--wz-accent':'#315bd6','--wz-on-accent':'#ffffff'};
        for (const [key,value] of Object.entries(skin)) document.documentElement.style.setProperty(key,value);
      });
      await page.evaluate(async () => {
        await new Promise(requestAnimationFrame);
        await Promise.all(document.getAnimations().filter(animation => animation.effect.getComputedTiming().endTime !== Infinity).map(animation => animation.finished.catch(() => {})));
      });
      await page.screenshot({path:path.join(out,network+'-settings-360x640-light.png')});
      const cancelResponse = page.waitForResponse(r => r.url().endsWith('/connectors/'+network+'/cancel') && r.request().method()==='POST');
      await page.getByRole('button',{name:'Cancel',exact:true}).click();
      const cancelled = await cancelResponse; assert.equal(cancelled.status(),200);
      await page.getByRole('dialog',{name:'Settings',exact:true}).waitFor({state:'hidden'});
      evidence.networks[network] = {qr_shown:true,qr_length:raw.length,qr_sha256:crypto.createHash('sha256').update(raw).digest('hex'),screenshot,cancel_status:cancelled.status(),qr_box:box,api_response:captured[network].response};
      await page.evaluate(() => { for (const key of [...document.documentElement.style]) if (key.startsWith('--wz-')) document.documentElement.style.removeProperty(key); });
    }
    assert.deepEqual(errors,[]);
    fs.writeFileSync(path.join(out,'evidence.json'),JSON.stringify(evidence,null,2),{mode:0o600});
    console.log(JSON.stringify({whatsapp_qr_shown:true,signal_qr_shown:true,evidence:path.join(out,'evidence.json'),page_errors:errors}));
  } catch(e) {
    await page.screenshot({path:path.join(out,'failure.png')});
    fs.writeFileSync(path.join(out,'failure.json'),JSON.stringify({error:e.message,errors,body:await page.locator('body').innerText()},null,2),{mode:0o600});
    throw e;
  } finally { await browser.close(); }
})().catch(e => {console.error(e);process.exitCode=1;});
