"""Real Chromium JS + CDP virtual verifying passkey, fixture-only ASGI transport.

No external URLs, browser profiles, accounts, credentials or production send calls.
Live trusted-TLS subprocess coverage lives separately in test_deployment.py.
"""
import os
from urllib.parse import urlsplit

from fastapi.testclient import TestClient
import pytest

from isolated_sender.service import Config, create_app, digest


def test_owner_ui_enroll_login_review_exact_send_and_logout(tmp_path):
    playwright = pytest.importorskip('playwright.sync_api', reason='optional UI test: install requirements-ui.txt')
    origin = 'https://owner.example.test'
    key = 'fixture-draft-only-key-no-real-accounts-0001'
    config = Config(origin=origin, rp_id='owner.example.test', database=str(tmp_path / 'db'),
                    agent_key_sha256=digest(key), accounts=['test-owner'], independently_administered=True)
    app = create_app(config)
    token = app.state.authority.bootstrap()
    client = TestClient(app, base_url=origin)
    draft = client.post('/agent/drafts', headers={'authorization': 'Bearer ' + key}, json={
        'request_id': 'browser-fixture-request-0001', 'account': 'test-owner',
        'recipient': 'fixture-recipient', 'body': 'Fixture <script>never executed</script>\n\u202e exact text',
        'attachments': [{'name': 'fixture.txt', 'media_type': 'text/plain', 'data_base64': 'YQ=='}]})
    assert draft.status_code == 200
    errors, unexpected = [], []
    with playwright.sync_playwright() as p:
        browser = p.chromium.launch(executable_path=os.environ.get('ISOLATED_SENDER_CHROME', '/usr/bin/google-chrome'),
                                    headless=True, args=['--no-sandbox'])
        try:
            context = browser.new_context()
            def dispatch(route):
                req = route.request
                url = urlsplit(req.url)
                if (url.scheme + '://' + url.netloc != origin or url.path not in (
                        '/', '/owner.js', '/owner.css', '/owner/register/begin', '/owner/register/finish',
                        '/owner/begin', '/owner/finish', '/owner/drafts', '/owner/logout')):
                    unexpected.append(req.url)
                    route.abort()
                    return
                # All browser traffic terminates in this disposable local app.
                client.cookies.clear()
                response = client.request(req.method, req.url, headers=req.all_headers(), content=req.post_data_buffer)
                route.fulfill(status=response.status_code, headers=dict(response.headers), body=response.content)
            context.route('**/*', dispatch)
            page = context.new_page()
            page.on('pageerror', lambda error: errors.append(str(error)))
            cdp = context.new_cdp_session(page)
            cdp.send('WebAuthn.enable')
            authenticator = cdp.send('WebAuthn.addVirtualAuthenticator', {'options': {
                'protocol': 'ctap2', 'transport': 'internal', 'hasResidentKey': True,
                'hasUserVerification': True, 'isUserVerified': True, 'automaticPresenceSimulation': True,
            }})['authenticatorId']
            page.goto(origin)
            page.wait_for_load_state('networkidle')
            page.locator('#bootstrap').fill(token)
            page.locator('#enroll').click()
            playwright.expect(page.locator('#status')).to_have_text('Completed.')
            assert page.locator('#bootstrap').input_value() == ''
            credentials = cdp.send('WebAuthn.getCredentials', {'authenticatorId': authenticator})['credentials']
            assert len(credentials) == 1 and credentials[0]['rpId'] == config.rp_id
            page.locator('#login').click()
            page.wait_for_selector('#drafts article')
            assert any(cookie['name'] == 'owner' and cookie['httpOnly'] and cookie['secure'] for cookie in context.cookies())
            assert page.locator('#fullMode').is_hidden()
            assert '\\u202e' in page.locator('#drafts').inner_text()
            assert page.locator('#drafts script').count() == 0
            page.get_by_role('button', name='Review this exact draft').click()
            page.wait_for_selector('#review[open]')
            binding = page.locator('#binding').inner_text()
            assert 'fixture-recipient' in binding and 'test-owner' in binding and 'sha256' in binding
            assert '\\u202e' in binding
            page.locator('#confirm').click()
            playwright.expect(page.locator('#drafts')).to_contain_text('test-delivered')
            with app.state.authority.transaction() as db:
                assert db.execute('SELECT COUNT(*) FROM test_deliveries').fetchone()[0] == 1
                assert db.execute('SELECT payload FROM test_deliveries').fetchone()[0] == draft.json()['payload']
            page.locator('#logout').click()
            playwright.expect(page.locator('#mode')).to_have_text('Signed out')
            assert not any(cookie['name'] == 'owner' for cookie in context.cookies())
            assert not errors and not unexpected
        finally:
            browser.close()
