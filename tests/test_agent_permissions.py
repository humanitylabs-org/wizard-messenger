"""Real loopback HTTP handlers with fake provider I/O; no accounts or network providers."""
import json
from pathlib import Path
import tempfile
import time
import unittest
from unittest.mock import Mock, patch
import test_web as fixtures
from permissions import AgentAccess, MODES
from drafts import Drafts
from unified import UnifiedInbox

# Every current write surface, plus malformed/unknown routes: deny before dispatch.
MUTATIONS = [
 ('POST', '/api/setup'), ('POST', '/api/contacts'), ('DELETE', '/api/contacts/c'),
 ('POST', '/api/dms'), ('POST', '/api/dms/d/messages'), ('POST', '/api/dms/d/retry'),
 ('POST', '/api/invites/i/accept'), ('POST', '/api/invites/i/decline'),
 ('POST', '/api/unified/people/p'),
 *[('POST', '/api/unified/people/p/' + a) for a in ('merge','unmerge','preview','send','read','typing')],
 ('PUT', '/api/unified/people/p/upload'),
 *[('POST', '/api/unified/messages/m/' + a) for a in ('translate','react','edit','delete')],
 ('POST', '/api/unified/groups/g/labels'), ('POST', '/api/unified/sync'),
 *[('POST', '/api/unified/telegram/' + a) for a in ('start','step','disconnect','cancel')],
 ('POST', '/api/drafts/d/preview'), ('POST', '/api/drafts/d/send'), ('DELETE', '/api/drafts/d'),
 ('POST', '/api/resolve-contact'), ('POST', '/api/future-send'),
 ('GET', '/api/unified/telegram/status'), ('GET', '/api/unified/status'),
 ('GET', '/api/unified/people/p/send'), ('POST', '/api/unified/people/p/send/'),
 ('POST', '/api/unified/people/p/%73end'), ('POST', '/api/unified/people/p/../send')]
DRAFT_DISCARD = ('DELETE', '/api/drafts/d')
READS = ['/api/contacts', '/api/invites', '/api/dms', '/api/dms/d/messages',
 '/api/unified/people', '/api/unified/groups', '/api/unified/directory',
 '/api/unified/updates', '/api/unified/people/p', '/api/unified/media/m', '/api/drafts']
OWNER_ONLY = [('GET','/api/view/agent-access'), ('POST','/api/view/agent-access'),
 ('GET','/api/view/session'), ('POST','/api/view/session'), ('POST','/api/view/unlock'),
 ('GET','/api/view/passkey'), *[('POST','/api/view/passkey/' + a) for a in
 ('register-options','register','unlock-options','unlock','clear')]]

class HTTPFixture(unittest.TestCase):
    setUp = fixtures.ViewBoundary.setUp
    tearDown = fixtures.ViewBoundary.tearDown
    request = fixtures.ViewBoundary.request
    session = fixtures.ViewBoundary.session
    owner_headers = fixtures.ViewBoundary.owner_headers
    def policy(self, mode):
        status, _, data = self.request('POST','/api/view/agent-access', {'mode': mode}, self.owner_headers())
        self.assertEqual(status, 200, data)
    @property
    def bearer(self): return {'Authorization': 'Bearer ' + fixtures.TOKEN}

class PermissionsHTTP(HTTPFixture):
    def test_exhaustive_no_access_read_only_draft_only_denies_before_provider_dispatch(self):
        unified = Mock(); self.server.unified = unified
        for mode in ('no_access','read_only','draft_only'):
            self.policy(mode)
            for method, path in MUTATIONS + ([('GET', p) for p in READS] if mode == 'no_access' else []):
                if mode == 'draft_only' and (method, path) == DRAFT_DISCARD: continue  # own-draft discard, see AgentKeys tests
                with self.subTest(mode=mode, method=method, path=path):
                    unified.reset_mock()
                    with patch.object(self.server.engine, 'setup') as setup:
                        status, _, data = self.request(method, path, {} if method != 'GET' else None, self.bearer)
                    self.assertEqual(status, 403, data)
                    unified.dispatch.assert_not_called(); setup.assert_not_called()
            if mode != 'draft_only':
                self.assertEqual(self.request('POST','/api/drafts',{},self.bearer)[0],403)
                self.assertEqual(self.request('POST','/api/drafts/d',{},self.bearer)[0],403)
    def test_owner_surfaces_denied_for_all_modes_even_with_cookie(self):
        cookie, csrf = self.session()
        for mode in MODES:
            self.policy(mode)
            for method, path in OWNER_ONLY:
                with self.subTest(mode=mode, path=path, method=method):
                    h = {**self.bearer, 'Cookie': cookie, 'Origin': fixtures.ORIGIN, 'X-Messenger-CSRF': csrf}
                    status, headers, _ = self.request(method,path,{} if method != 'GET' else None,h)
                    self.assertEqual(status,403); self.assertNotIn('Set-Cookie',headers)
            status, headers, _ = self.request('GET','/',headers=self.bearer)
            self.assertEqual(status,200); self.assertNotIn('Set-Cookie',headers)
    def test_read_only_and_draft_only_reads_and_full_send_reach_real_dispatch(self):
        unified = Mock(); unified.dispatch.return_value = {'people': []}; self.server.unified = unified
        for mode in ('read_only','draft_only','full_access'):
            self.policy(mode)
            for path in ('/api/contacts','/api/unified/people','/api/unified/people/p','/api/drafts'):
                self.assertEqual(self.request('GET',path,headers=self.bearer)[0],200)
        self.assertEqual(self.request('POST','/api/unified/people/p/send',{'text':'explicit-full'},self.bearer)[0],200)
        unified.dispatch.assert_called_with('POST','/api/unified/people/p/send',{'text':'explicit-full'},{},None)
    def test_policy_owner_csrf_origin_invalid_legacy_and_readback(self):
        owner = self.owner_headers()
        for h in ({}, {'Cookie':owner['Cookie']}, {**owner,'X-Messenger-CSRF':'wrong'}, {**owner,'Origin':'https://evil.invalid'}):
            self.assertIn(self.request('POST','/api/view/agent-access',{'mode':'full_access'},h)[0],(401,403))
        for payload in ({'minutes':60}, {'mode':'FULL'}, {'mode':True}, {'mode':'draft_only','minutes':True}, {'mode':'draft_only','minutes':0}):
            self.assertEqual(self.request('POST','/api/view/agent-access',payload,owner)[0],400)
        self.policy('draft_only')
        self.assertEqual(self.request('GET','/api/view/agent-access',headers={'Cookie':owner['Cookie']})[2]['result']['mode'],'draft_only')
        self.assertEqual(self.request('GET','/api/contacts',headers={'Authorization':'Bearer bad',**owner})[0],401)
    def test_independent_owner_enrollment_then_passphrase_unlock_is_required(self):
        # Trusted provisioning integration, NOT the machine-bearer ticket endpoint.
        ticket = self.server.auth.ticket(bootstrap=True)
        status, headers, data = self.request('POST','/api/view/session',{'ticket':ticket},{'Origin':fixtures.ORIGIN})
        self.assertEqual(status,200)
        owner = {'Cookie':headers['Set-Cookie'].split(';')[0], 'Origin':fixtures.ORIGIN, 'X-Messenger-CSRF':data['result']['csrf_token']}
        password = 'independent-owner-fixture-passphrase'
        self.assertEqual(self.request('POST','/api/setup',{'action':'create','vault_password':password},owner)[0],200)
        self.assertEqual(self.request('GET','/api/view/agent-access',headers=owner)[0],403)
        status, headers, data = self.request('POST','/api/view/unlock',{'vault_password':password},{'Origin':fixtures.ORIGIN})
        self.assertEqual(status,200)
        self.assertIn('HttpOnly',headers['Set-Cookie']); self.assertIn('SameSite=Strict',headers['Set-Cookie']); self.assertIn('Secure',headers['Set-Cookie'])
        owner = {'Cookie':headers['Set-Cookie'].split(';')[0], 'Origin':fixtures.ORIGIN, 'X-Messenger-CSRF':data['result']['csrf_token']}
        self.assertEqual(self.request('POST','/api/view/agent-access',{'mode':'draft_only'},owner)[0],200)

    def test_api_only_handler_has_no_legacy_bearer_bypass(self):
        from server import Handler
        self.server.RequestHandlerClass = Handler
        for mode in ('no_access', 'read_only', 'draft_only'):
            self.server.agent_access.configure({'mode': mode})
            for method, path in MUTATIONS:
                if mode == 'draft_only' and (method, path) == DRAFT_DISCARD: continue
                with self.subTest(mode=mode, method=method, path=path):
                    self.assertEqual(self.request(method, path, {} if method != 'GET' else None, self.bearer)[0], 403)

    def test_machine_ticket_never_unlocks_configured_account_and_setup_cookie_is_restricted(self):
        status, _, data = self.request('POST','/api/view/ticket',{},self.bearer)
        self.assertEqual(status,200)
        ticket = data['result']['ticket']
        status, headers, _ = self.request('POST','/api/view/session',{'ticket':ticket},{'Origin':fixtures.ORIGIN})
        self.assertEqual(status,200)
        cookie = headers['Set-Cookie'].split(';')[0]
        self.assertEqual(self.request('GET','/api/contacts',headers={'Cookie':cookie})[0],403)
        csrf = self.request('GET','/api/view/session',headers={'Cookie':cookie})[2]['result']['csrf_token']
        self.assertEqual(self.request('POST','/api/setup',{'action':'create','vault_password':'attacker-chosen-passphrase'},
            {'Cookie':cookie,'Origin':fixtures.ORIGIN,'X-Messenger-CSRF':csrf})[0],403)
        self.assertIsNone(self.server.auth.credential)
        self.assertEqual(self.request('GET','/api/view/agent-access',headers={'Cookie':cookie})[0],403)
        self.server.engine.ready = True
        self.assertEqual(self.request('POST','/api/view/session',{'ticket':ticket},{'Origin':fixtures.ORIGIN})[0],401)

class DraftHTTP(HTTPFixture):
    def setUp(self):
        fixtures.ViewBoundary.setUp(self)
        self.inbox = UnifiedInbox(self.temp.name, self.server.engine)
        self.server.unified = self.inbox
        self.inbox.mx = Mock(return_value={'event_id':'$sent'})
        self.a = self.inbox.store.identity('telegram', '!alice', 'Alice')
        self.b = self.inbox.store.identity('telegram', '!bob', 'Bob')
        self.server.drafts = Drafts(self.temp.name)
        self.owner = self.owner_headers()
        self.policy('draft_only')
    def create(self):
        fields = {'person_id':self.a['person_id'], 'identity_id':self.a['id'], 'text':'Hello',
                  'state':'sent','preview_id':'forged','approval':True}
        status, _, data = self.request('POST','/api/drafts',fields,self.bearer)
        self.assertEqual(status,200,data); self.inbox.mx.assert_not_called()
        return data['result']['draft']
    def test_revision_fencing_recipient_body_edits_and_owner_only_explicit_send(self):
        draft = self.create(); path = '/api/drafts/' + draft['id']
        self.assertNotIn('approval',draft); self.assertNotIn('preview_id',draft)
        self.assertEqual(self.request('POST',path+'/send',{'revision':1},self.owner)[0],409)
        s, _, data = self.request('POST',path+'/preview',{'revision':1},self.owner)
        self.assertEqual(s,200,data); self.inbox.mx.assert_not_called()
        for fields in ({'person_id':self.a['person_id'],'identity_id':self.a['id'],'text':'Changed body'},
                       {'person_id':self.b['person_id'],'identity_id':self.b['id'],'text':'Changed recipient'}):
            rev = draft['revision']
            s, _, data = self.request('POST',path,{**fields,'revision':rev},self.bearer)
            self.assertEqual(s,200,data); draft = data['result']['draft']; self.assertNotIn('preview',draft)
            self.assertEqual(self.request('POST',path+'/send',{'revision':rev},self.owner)[0],409)
            self.assertEqual(self.request('POST',path+'/send',{'revision':draft['revision']},self.owner)[0],409)
            self.assertEqual(self.request('POST',path+'/preview',{'revision':draft['revision']},self.owner)[0],200)
        rev = draft['revision']
        self.assertEqual(self.request('POST',path+'/send',{'revision':rev},self.bearer)[0],403)
        self.assertEqual(self.request('POST',path+'/send',{'revision':rev},{'Cookie':self.owner['Cookie'],'Origin':fixtures.ORIGIN})[0],403)
        self.inbox.mx.assert_not_called()
        status, _, data = self.request('POST',path+'/send',{'revision':rev,'text':'forged','person_id':self.a['person_id']},self.owner)
        self.assertEqual(status,200,data)
        args = self.inbox.mx.call_args.args
        self.assertIn('%21bob',args[0]); self.assertEqual(args[2]['body'],'Changed recipient')
        self.assertEqual(self.request('POST',path+'/send',{'revision':rev},self.owner)[0],200)
        self.assertEqual(self.inbox.mx.call_count,1)
        self.assertEqual(self.request('GET',path,headers=self.bearer)[2]['result']['draft']['state'],'sent')
        self.assertEqual(Drafts(self.temp.name).rows[draft['id']]['state'],'sent')
        self.assertEqual((Path(self.temp.name)/'agent-drafts.json').stat().st_mode & 0o777,0o600)
    def test_preview_expiry_translation_failure_and_delete_are_fail_closed(self):
        draft = self.create(); path = '/api/drafts/' + draft['id']
        self.assertEqual(self.request('POST', path+'/preview', {}, self.owner)[0], 409)
        self.inbox.store.update(self.a['person_id'], {'language':'th'})
        self.inbox.translator.translate = Mock(return_value=('Hello', 'unavailable'))
        self.assertEqual(self.request('POST',path+'/preview',{'revision':1},self.owner)[0],200)
        self.assertEqual(self.request('POST',path+'/send',{'revision':1},self.owner)[0],409)
        self.inbox.mx.assert_not_called()
        self.assertEqual(self.server.drafts.rows[draft['id']]['state'],'draft')
        self.server.drafts.rows[draft['id']]['preview_until'] = 0
        self.assertEqual(self.request('POST',path+'/send',{'revision':1,'send_original':True},self.owner)[0],409)
        self.assertEqual(self.request('POST',path+'/preview',{'revision':1},self.owner)[0],200)
        self.assertEqual(self.request('POST',path+'/send',{'revision':1,'send_original':True},self.owner)[0],200)
        self.assertEqual(self.inbox.mx.call_args.args[2]['body'],'Hello')
        self.assertEqual(self.request('DELETE',path,{'revision':1},self.bearer)[0],409)  # sent: agents can never discard
        self.assertEqual(self.request('DELETE',path,{'revision':1},self.owner)[0],200)
        self.assertEqual(self.request('GET',path,headers=self.owner)[0],404)
        self.assertEqual(Drafts(self.temp.name).rows,{})

    def test_inflight_send_prevents_recipient_edits_and_ambiguous_replacement(self):
        import threading
        from engine import EngineError
        draft = self.create(); path = '/api/drafts/' + draft['id']
        self.assertEqual(self.request('POST',path+'/preview',{'revision':1},self.owner)[0],200)
        entered = threading.Event(); release = threading.Event(); results = {}
        def send(*args):
            entered.set(); release.wait(2)
            raise EngineError('timeout','Delivery unknown',503)
        self.inbox.mx.side_effect = send
        a = threading.Thread(target=lambda: results.update(send=self.request('POST',path+'/send',{'revision':1},self.owner)[0]))
        a.start(); self.assertTrue(entered.wait(2))
        b = threading.Thread(target=lambda: results.update(edit=self.request('POST',path,{'revision':1,'person_id':self.b['person_id'],'identity_id':self.b['id'],'text':'Changed'},self.bearer)[0]))
        b.start(); release.set(); a.join(3); b.join(3)
        self.assertEqual(results,{'send':503,'edit':409})
        self.assertEqual(self.request('GET',path,headers=self.bearer)[2]['result']['draft']['state'],'sending')
        self.assertEqual(self.request('DELETE',path,{'revision':1},self.owner)[0],409)
        self.assertEqual(self.inbox.mx.call_count,1)

    def test_persistence_translation_preview_and_stale_update(self):
        draft = self.create(); path = '/api/drafts/' + draft['id']
        self.assertEqual(Drafts(self.temp.name).rows[draft['id']]['text'],'Hello')
        self.inbox.store.update(self.a['person_id'],{'language':'th'})
        self.inbox.translator.translate = Mock(return_value=('Translated',None))
        self.assertEqual(self.request('POST',path+'/preview',{'revision':1},self.owner)[0],200)
        self.assertEqual(self.request('POST',path,{'revision':0,'text':'stale'},self.bearer)[0],409)
        self.assertEqual(self.request('POST',path+'/send',{'revision':1},self.owner)[0],200)
        self.assertEqual(self.inbox.mx.call_args.args[2]['body'],'Translated')

class PersistentPolicy(unittest.TestCase):
    def test_legacy_corrupt_and_expired_policy_fail_closed_and_new_policy_survives_restart(self):
        with tempfile.TemporaryDirectory() as root:
            path = Path(root)/'agent-access.json'
            for raw in ('{"until":99999999999}', 'null','[]','{broken', '{"version":2,"mode":"full_access","until":"bad"}'):
                path.write_text(raw)
                self.assertEqual(AgentAccess(root).state()['mode'],'no_access')
            policy = AgentAccess(root)
            policy.configure({'mode':'draft_only','minutes':60})
            self.assertEqual(AgentAccess(root).state()['mode'],'draft_only')
            with patch('permissions.time.time',return_value=time.time()+7200):
                self.assertEqual(AgentAccess(root).state()['mode'],'no_access')
            policy.configure({'minutes':0})
            self.assertEqual(AgentAccess(root).state()['mode'],'no_access')
            self.assertEqual(path.stat().st_mode & 0o777,0o600)
    def test_old_machine_minted_sessions_are_invalidated(self):
        with tempfile.TemporaryDirectory() as root:
            path=Path(root)/'auth.json'
            auth=fixtures.BrowserAuth(path); token,_=auth.create()
            data=json.loads(path.read_text()); data.pop('version'); path.write_text(json.dumps(data))
            self.assertIsNone(fixtures.BrowserAuth(path).lookup(token))
