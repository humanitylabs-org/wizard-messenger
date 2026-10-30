"""Light unit checks. Real two-party proof receipts live under .hermes/."""
import http.client
import json
import os
from pathlib import Path
import tempfile
import threading
import unittest
from unittest.mock import patch
from engine import EngineError, MarmotEngine, group_id, public_key, text
from server import MessengerServer

class FakeEngine:
    def status(self): return {'state':'setup_required'}
    def identity(self): return {'identity':None}
    def setup(self,payload): raise ValueError(payload.get('vault_password'))

class BoundaryTests(unittest.TestCase):
    def setUp(self):
        self.token='unit-test-capability-'+('x'*40)
        self.server=MessengerServer(('127.0.0.1',0),FakeEngine(),self.token,['https://view.invalid'])
        self.thread=threading.Thread(target=self.server.serve_forever,daemon=True); self.thread.start()
    def tearDown(self):
        self.server.shutdown(); self.server.server_close(); self.thread.join()
    def call(self,path,body=None,token=True,origin='https://view.invalid'):
        client=http.client.HTTPConnection('127.0.0.1',self.server.server_port,timeout=3)
        headers={'Content-Type':'application/json','Origin':origin}
        if token: headers['Authorization']='Bearer '+self.token
        client.request('POST' if body is not None else 'GET',path,json.dumps(body) if body is not None else None,headers)
        response=client.getresponse(); data=json.loads(response.read()); status=response.status; client.close()
        return status,data
    def test_health_public_but_api_not_public(self):
        self.assertEqual(self.call('/healthz',token=False)[0],200)
        self.assertEqual(self.call('/api/status',token=False)[0],401)
    def test_origin_enforced_on_authenticated_write(self):
        self.assertEqual(self.call('/api/setup',{},origin='https://evil.invalid')[0],403)
    def test_authenticated_status(self):
        self.assertEqual(self.call('/api/status'),(200,{'ok':True,'result':{'state':'setup_required'}}))
    def test_mcp_only_exposes_two_public_read_tools(self):
        status,data=self.call('/mcp',{'jsonrpc':'2.0','id':1,'method':'tools/list'})
        self.assertEqual(status,200)
        self.assertEqual([t['name'] for t in data['result']['tools']],['messenger_status','messenger_public_identity'])
    def test_unknown_mcp_tool_cannot_send(self):
        _,data=self.call('/mcp',{'jsonrpc':'2.0','id':1,'method':'tools/call','params':{'name':'messages_send'}})
        self.assertEqual(data['error']['code'],-32601)
    def test_denied_bearer_setup_cannot_echo_secret(self):
        secret='this-must-not-appear-in-the-response'
        status,data=self.call('/api/setup',{'vault_password':secret})
        self.assertEqual(status,403); self.assertNotIn(secret,json.dumps(data))
    def test_empty_token_is_rejected(self):
        with self.assertRaises(ValueError): MessengerServer(('127.0.0.1',0),FakeEngine(),'',['https://view.invalid'])
    def test_empty_origin_list_means_same_host_only(self):
        server=MessengerServer(('127.0.0.1',0),FakeEngine(),self.token,[]); server.server_close()
        self.assertEqual(server.origins,frozenset())

class InputAndStorageTests(unittest.TestCase):
    def test_identifier_validation_does_not_repair_source_tokens(self):
        for invalid in ['Npub1'+'a'*58, 'f'*63, 'a'*64+' ', 'nsec1'+'q'*58]:
            with self.assertRaises(EngineError): public_key(invalid)
        self.assertEqual(public_key('a'*64),'a'*64)
        with self.assertRaises(EngineError): group_id('b'*31)
        self.assertEqual(group_id('b'*32),'b'*32)
    def test_text_is_unicode_byte_bounded(self):
        self.assertEqual(text('hello\nworld','TEXT'),'hello\nworld')
        for value in ['', '  ', '\x00', '🎩'*41]:
            with self.assertRaises(EngineError): text(value,'TEXT',160)
    def test_keychain_is_forced_and_empty_setup_creates_no_identity(self):
        with tempfile.TemporaryDirectory(dir=os.environ.get('TMPDIR')) as directory:
            with patch.dict(os.environ,{'XDG_RUNTIME_DIR':directory+'/runtime','WN_SECRET_STORE':'file'}):
                engine=MarmotEngine(directory+'/data',['wss://relay.invalid'])
            self.assertEqual(engine.env['WN_SECRET_STORE'],'keychain')
            self.assertEqual(engine.status()['state'],'setup_required')
            self.assertFalse(engine.marker.exists())
            self.assertEqual({p.name for p in Path(directory+'/data').iterdir()},{'contacts.sqlite','marmot'})
            self.assertFalse(any(p.name=='secret.json' for p in Path(directory).rglob('*')))
            with self.assertRaises(EngineError): engine.messages('b'*32)
    def test_owned_foreground_keyring_is_stopped_after_failed_unlock(self):
        from unittest.mock import MagicMock
        with tempfile.TemporaryDirectory(dir=os.environ.get('TMPDIR')) as directory:
            with patch.dict(os.environ,{'XDG_RUNTIME_DIR':directory+'/runtime'}): engine=MarmotEngine(directory+'/data',['wss://relay.invalid'])
            provider=MagicMock(); provider.poll.return_value=None
            owner=MagicMock(returncode=0)
            locked=MagicMock(returncode=0,stdout='(<true>,)')
            with patch('engine.subprocess.Popen',return_value=provider) as start, patch('engine.subprocess.run',side_effect=[owner,locked]*30), patch('engine.time.sleep'):
                with self.assertRaises(EngineError) as error: engine._unlock('dedicated-unit-test-passphrase')
            self.assertEqual(error.exception.code,'vault_unlock_failed')
            self.assertIn('--foreground',start.call_args.args[0])
            self.assertNotIn('dedicated-unit-test-passphrase',str(start.call_args.args[0]))
            provider.stdin.write.assert_called_once_with(b'dedicated-unit-test-passphrase')
            provider.stdin.close.assert_called_once()
            provider.terminate.assert_called_once()
            self.assertIsNone(engine.keyring_process)
            self.assertFalse(engine.unlocked)

    def test_request_id_replays_receipt_without_fresh_send(self):
        with tempfile.TemporaryDirectory(dir=os.environ.get('TMPDIR')) as directory:
            with patch.dict(os.environ,{'XDG_RUNTIME_DIR':directory+'/runtime'}): engine=MarmotEngine(directory+'/data',['wss://relay.invalid'])
            payload={'text':'unit test private TEXT','request_id':'unit-request-id-1234'}
            with patch.object(engine,'_require_ready'),patch.object(engine,'_dm_members'),patch.object(engine,'_execute',return_value={'message_ids':['a'*64],'published':1}) as execute:
                first=engine.send('b'*32,payload)
                replay=engine.send('b'*32,payload)
                self.assertEqual(first['message_ids'],replay['message_ids']); self.assertTrue(replay['replayed'])
                self.assertEqual(execute.call_count,1)
                with self.assertRaises(EngineError): engine.send('b'*32,{**payload,'text':'changed'})
            with engine._db() as db:
                saved=db.execute('SELECT * FROM sends').fetchall()
            self.assertNotIn(payload['text'],str(saved))

    def test_ambiguous_request_id_does_not_send_again(self):
        with tempfile.TemporaryDirectory(dir=os.environ.get('TMPDIR')) as directory:
            with patch.dict(os.environ,{'XDG_RUNTIME_DIR':directory+'/runtime'}): engine=MarmotEngine(directory+'/data',['wss://relay.invalid'])
            payload={'text':'uncertain unit TEXT','request_id':'uncertain-request-1234'}
            with patch.object(engine,'_require_ready'),patch.object(engine,'_dm_members'),patch.object(engine,'_execute',side_effect=EngineError('engine_unavailable','uncertain',503)) as execute:
                with self.assertRaises(EngineError): engine.send('b'*32,payload)
                with self.assertRaises(EngineError) as error: engine.send('b'*32,payload)
                self.assertEqual(error.exception.code,'send_outcome_unknown')
                self.assertEqual(execute.call_count,1)

    def test_rpc_never_retries_uncertain_write(self):
        with tempfile.TemporaryDirectory(dir=os.environ.get('TMPDIR')) as directory:
            with patch.dict(os.environ,{'XDG_RUNTIME_DIR':directory+'/runtime'}): engine=MarmotEngine(directory+'/data',['wss://relay.invalid'])
            with patch('engine.socket.socket') as socket_mock:
                socket_mock.return_value.__enter__.return_value.connect.side_effect=TimeoutError()
                with self.assertRaises(EngineError): engine._rpc({'Execute':{}})
                self.assertEqual(socket_mock.call_count,1)

    def test_launch_failure_stops_unlocked_provider(self):
        from unittest.mock import MagicMock
        with tempfile.TemporaryDirectory(dir=os.environ.get('TMPDIR')) as directory:
            with patch.dict(os.environ,{'XDG_RUNTIME_DIR':directory+'/runtime'}): engine=MarmotEngine(directory+'/data',['wss://relay.invalid'])
            provider=MagicMock(); provider.poll.return_value=None
            owner=MagicMock(returncode=0); unlocked=MagicMock(returncode=0,stdout='(<false>,)')
            with patch('engine.subprocess.Popen',return_value=provider), patch('engine.subprocess.run',side_effect=[owner,unlocked]), patch.object(engine,'_launch',side_effect=EngineError('engine_start_failed','x',503)):
                with self.assertRaises(EngineError) as error: engine._unlock('dedicated-unit-test-passphrase')
            self.assertEqual(error.exception.code,'engine_start_failed')
            provider.terminate.assert_called_once()
            self.assertIsNone(engine.keyring_process); self.assertFalse(engine.unlocked)

    def test_unsupported_group_invite_does_not_hide_dm_invites(self):
        with tempfile.TemporaryDirectory(dir=os.environ.get('TMPDIR')) as directory:
            with patch.dict(os.environ,{'XDG_RUNTIME_DIR':directory+'/runtime'}): engine=MarmotEngine(directory+'/data',['wss://relay.invalid'])
            invites={'invites':[{'group_id':'a'*32},{'group_id':'b'*32}]}
            def members(group):
                if group=='a'*32: raise EngineError('not_a_dm','group',409)
                return [{'npub':'x'},{'npub':'y'}]
            with patch.object(engine,'_require_ready'),patch.object(engine,'_groups',return_value=invites),patch.object(engine,'_dm_members',side_effect=members):
                result=engine.invites()
            self.assertEqual([i['group_id'] for i in result['invites']],['b'*32])
            self.assertEqual(result['unsupported_invites'],1)

    def test_vault_password_rule_is_shared_and_rejects_multiline(self):
        from engine import vault_password
        for bad in ['short','x'*15,'line-one-passphrase\nline-two','with-carriage-return\rxx','nul-byte-passphrase\x00x','é'*600]:
            with self.assertRaises(EngineError): vault_password(bad)
        self.assertEqual(vault_password('a-valid-unit-passphrase'),'a-valid-unit-passphrase')

    def test_member_public_name_comes_from_directory_and_is_cached(self):
        with tempfile.TemporaryDirectory(dir=os.environ.get('TMPDIR')) as directory:
            with patch.dict(os.environ,{'XDG_RUNTIME_DIR':directory+'/runtime'}): engine=MarmotEngine(directory+'/data',['wss://relay.invalid'])
            members={'members':[{'member_id':'a'*64,'mls_leaf':'secret-ish'},{'member_id':'b'*64}]}
            def execute(command):
                key=command['Users']['command']['Show']['pubkey']
                if key=='a'*64: return {'user':{'metadata':{'display_name':'Alex QA'}}}
                raise EngineError('marmot_operation_failed','unknown',502)
            with patch.object(engine,'_groups',return_value=members),patch.object(engine,'_execute',side_effect=execute) as ex:
                first=engine._dm_members('c'*32); engine._dm_members('c'*32)
            self.assertEqual(first[0]['display_name'],'Alex QA'); self.assertNotIn('display_name',first[1])
            self.assertNotIn('mls_leaf',first[0]); self.assertEqual(ex.call_count,2)

if __name__=='__main__': unittest.main()
