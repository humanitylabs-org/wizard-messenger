"""Behavioral regression for normal optional modes; never contacts providers."""
import json
from pathlib import Path
import tempfile
import unittest
from unittest.mock import Mock
from test_agent_permissions import DraftHTTP, HTTPFixture
from permissions import AgentAccess, LABELS
from permission_runtime.broker import Adapter, OPS

class OptionalModeHTTP(DraftHTTP):
    def test_explicit_agent_send_and_revocation_but_never_owner_authority(self):
        draft = self.create(); path = '/api/drafts/'+draft['id']
        self.policy('draft_and_send')
        self.assertEqual(self.request('POST',path+'/preview',{'revision':1},self.bearer)[0],200)
        self.inbox.mx.assert_not_called()
        self.policy('draft_only')
        self.assertEqual(self.request('POST',path+'/send',{'revision':1},self.bearer)[0],403)
        self.inbox.mx.assert_not_called()
        self.policy('draft_and_send')
        self.assertEqual(self.request('POST',path+'/send',{'revision':1},self.bearer)[0],200)
        self.assertEqual(self.inbox.mx.call_count,1)
        self.assertEqual(self.request('POST',path+'/send',{'revision':1},self.bearer)[0],200)
        self.assertEqual(self.inbox.mx.call_count,1)
        for route in ('/api/setup','/api/contacts','/api/dms','/api/unified/people/p/merge','/api/unified/sync','/api/view/agent-access',path+'/export',path+'/authority-status'):
            with self.subTest(route=route): self.assertEqual(self.request('POST',route,{},self.bearer)[0],403)
        self.assertEqual(self.request('GET',path,headers=self.bearer)[2]['result']['draft']['state'],'sent')

    def test_configured_remote_down_never_local_preview_send_or_direct_dispatch(self):
        draft=self.create(); path='/api/drafts/'+draft['id']
        self.server.remote_authority.endpoint='https://fixture-authority.invalid'
        self.server.remote_authority.state=Mock(return_value={'ready':False,'reason':'unavailable'})
        self.assertTrue(self.request('GET','/api/view/authority',headers=self.owner)[2]['result']['required'])
        for required in (False,True):
            self.server.remote_required=required
            for headers in (self.owner,self.bearer):
                for route in (path+'/preview',path+'/send','/api/unified/people/p/send','/api/dms/d/messages'):
                    self.assertEqual(self.request('POST',route,{'revision':1},headers)[0],403)
        self.inbox.mx.assert_not_called()

class BrokerSchemas(unittest.TestCase):
    def test_every_method_owner_ceiling_default_denies_no_proxy_or_role_smuggling(self):
        with tempfile.TemporaryDirectory() as root:
            p=Path(root);(p/'token').write_text('T'*48)
            c={'origin':'http://127.0.0.1:1','token_file':str(p/'token'),'mode':'no_access'}
            (p/'config').write_text(json.dumps(c));a=Adapter(p/'config')
            for mode in LABELS:
                c['mode']=mode;(p/'config').write_text(json.dumps(c))
                for op in OPS:
                    # Missing mandatory fields or minimum role is denied before transport.
                    args={k:'x' for k in OPS[op][3]};args['owner']=True
                    with self.subTest(mode=mode,op=op),self.assertRaises(PermissionError):a.call({'op':op,'arguments':args})
                for op in ('policy','owner_session','approve','provision','exec','http'):
                    with self.assertRaises(PermissionError):a.call({'op':op,'arguments':{}})
            c['mode']='draft_and_send';(p/'config').write_text(json.dumps(c))
            for ident in ('../owner','a/b','%2f','a?b','a#b','a\n'):
                with self.assertRaises(ValueError):a.call({'op':'draft','arguments':{'id':ident}})

    def test_labels_and_legacy_alias_are_narrow_and_old_persisted_full_grants_revoked(self):
        p=AgentAccess();p.configure({'mode':'full_access'})
        self.assertEqual(p.state()['mode'],'draft_and_send');self.assertEqual(p.state()['label'],'Draft-and-send')
        for method,path in [('POST','/api/setup'),('POST','/api/contacts'),('POST','/api/dms'),('POST','/api/unified/people/p/merge'),('POST','/api/unified/sync')]:
            self.assertFalse(p.permits(method,path))
        with tempfile.TemporaryDirectory() as root:
            (Path(root)/'agent-access.json').write_text('{"version":2,"mode":"full_access","until":null}')
            self.assertEqual(AgentAccess(root).effective_mode(),'no_access')

if __name__=='__main__':unittest.main()
