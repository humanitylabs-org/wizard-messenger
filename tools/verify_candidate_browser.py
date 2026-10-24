"""Rendered Chromium check of real candidate API/UI with disposable SQLite data.

The shell-client shim and synthetic contacts are fixtures, not live Wizard/provider
proof. All browser traffic is confined to the loopback test server.
"""
import argparse
import json
import os
from pathlib import Path
import sys
import tempfile
import threading
from unittest.mock import Mock, patch
import urllib.request

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))
from web import ViewServer
from connector_inbox import ConnectorInbox
from connector_web import ConnectorViewHandler
from unified_setup import setup
from connector_setup import setup_connectors
from playwright.sync_api import sync_playwright


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--output', required=True, type=Path)
    args = parser.parse_args()
    args.output.mkdir(parents=True, exist_ok=True)
    with tempfile.TemporaryDirectory(prefix='messenger-browser-', dir=os.environ.get('TMPDIR')) as directory:
        root = Path(directory)
        with patch.dict(os.environ, {'TELEGRAM_API_ID':'', 'TELEGRAM_API_HASH':''}):
            setup(root)
        setup_connectors(root)
        engine = Mock(); engine.data = root
        engine.status.return_value = {'state':'ready', 'account_configured':True}
        with patch.dict(os.environ, {'UNIFIED_ENABLED':'0', 'MESSENGER_COOKIE_SECURE':'0', 'MESSENGER_PUBLIC_PATH':'/'}):
            server = ViewServer(('127.0.0.1',0), engine, 'fixture-key-' + 'x'*40, [])
        origin = f'http://127.0.0.1:{server.server_port}'
        server.origins = frozenset({origin})
        inbox = ConnectorInbox(root, engine, sender=None)
        server.unified = inbox
        server.RequestHandlerClass = ConnectorViewHandler
        person = inbox.store.identity('telegram', '!fixture:local', 'Fixture contact')
        inbox.store.add_message('$fixture', person, 'Fixture sender', False, 'Searchable fixture message', 100)
        token, session = server.auth.create()
        thread = threading.Thread(target=server.serve_forever, daemon=True); thread.start()
        observed = []
        try:
            with sync_playwright() as p:
                browser = p.chromium.launch(headless=True, executable_path=os.environ.get('ISOLATED_SENDER_CHROME','/usr/bin/google-chrome'), args=['--no-sandbox'])
                context = browser.new_context(viewport={'width':390,'height':844})
                context.add_cookies([{'name':'wizard_messenger_session','value':token,'url':origin,'httpOnly':True,'sameSite':'Strict'}])
                def route(request_route):
                    req = request_route.request
                    if not req.url.startswith(origin + '/'):
                        request_route.abort(); return
                    if req.url == origin + '/':
                        html = (ROOT/'static/index.html').read_text().replace('<script src="app.js" defer></script>','').replace('<script src="/wizard-os-home/core/app-client.js" defer></script>','')
                        request_route.fulfill(status=200, content_type='text/html', body=html); return
                    observed.append((req.method, req.url.removeprefix(origin)))
                    request_route.continue_()
                context.route('**/*', route)
                page = context.new_page(); errors = []
                page.on('pageerror', lambda e: errors.append(str(e)))
                page.goto(origin + '/'); page.wait_for_load_state('networkidle')
                page.evaluate('''csrf => {
                    window.WizardApp = {update:{hold:()=>({release(){}})}};
                    const api = async (path, opts={}) => {
                        const r = await fetch('/' + path, {method:opts.method||'GET', credentials:'same-origin',
                            headers:{'Content-Type':'application/json','X-Messenger-CSRF':csrf},
                            body:opts.body === undefined ? undefined : JSON.stringify(opts.body)});
                        const data = await r.json();
                        if (!r.ok) { const e = new Error(data.error?.message||'API error'); e.code=data.error?.code; throw e; }
                        return data.result;
                    };
                    document.querySelector('#gate').hidden = true;
                    window.MessengerUnified.mount({api,csrf:()=>csrf});
                    window.MessengerUnified.authenticated();
                }''', session['csrf'])
                page.get_by_text('Fixture contact', exact=True).wait_for()
                page.get_by_role('button', name='Settings', exact=True).click()
                page.get_by_label('Agent access level').select_option('draft_only')
                page.get_by_role('button',name='Save agent access',exact=True).click()
                page.get_by_text('Agents can read and save drafts. Sending needs your independent approval.', exact=True).wait_for()
                # Read back the exact configured policy; do not infer from the select.
                assert server.agent_access.effective_mode() == 'draft_only'
                body = json.dumps({'person_id':person['person_id'],'identity_id':person['id'],'text':'Draft from synthetic agent'}).encode()
                req = urllib.request.Request(origin + '/api/drafts', data=body, method='POST', headers={'Authorization':'Bearer '+server.token,'Content-Type':'application/json'})
                created = json.load(urllib.request.urlopen(req))['result']['draft']
                page.get_by_role('button',name='Review agent drafts',exact=True).click()
                page.get_by_role('button',name='Review draft',exact=True).click()
                secure_review = page.get_by_role('button',name='Review securely',exact=True)
                secure_review.wait_for()
                assert secure_review.is_disabled(), 'Unconfigured authority must fail closed'
                assert page.get_by_role('button',name='Send',exact=True).count() == 0
                page.get_by_label('Draft message').fill('Owner changes the fixture draft')
                assert secure_review.is_disabled()
                assert page.get_by_role('button',name='Send',exact=True).count() == 0
                assert server.drafts.get(created['id'])['state'] == 'draft'
                for width,height in [(390,844),(320,700),(1280,900)]:
                    page.set_viewport_size({'width':width,'height':height})
                    assert page.evaluate('document.documentElement.scrollWidth <= innerWidth'), f'overflow at {width}'
                    page.screenshot(path=str(args.output/f'draft-review-{width}.png'))
                assert not any(path.endswith('/send') for _,path in observed)
                assert not errors, errors
                browser.close()
                report = {'pass':True,'fixture_scope':'real Chromium + real loopback API + disposable SQLite; shell shim and synthetic contacts; no provider delivery',
                          'viewports':[390,320,1280],'owner_policy_readback':'draft_only','draft_state_readback':'draft',
                          'secure_review_disabled_without_authority':True,'outbound_send_requests':0,'page_errors':errors}
                (args.output/'browser-proof.json').write_text(json.dumps(report,indent=2)+'\n')
                print(json.dumps(report))
        finally:
            server.shutdown(); server.server_close(); thread.join(timeout=5)
            inbox.store._conn.close()


if __name__ == '__main__':
    main()
