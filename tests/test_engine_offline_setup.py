"""Issue 288: creating a Messenger address while the chat relays are out of reach.

wnd makes the identity on this Wizard first and then publishes it; offline the publish fails ("relay_transport"), so
setup used to answer marmot_operation_failed ("Couldn't connect") and leave a half-made address behind that Try again
could not finish. Now the address is kept, setup succeeds, and its keys are published once the relays answer.
"""
import json, os, sys, tempfile, unittest
sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
os.environ['MESSENGER_WND_GUARD'] = '0'
import engine


class Alive:
    def poll(self): return None


class FakeWnd(engine.MarmotEngine):
    """The wnd daemon as seen through _rpc: local identity work always succeeds, relay work only when online."""
    def __init__(self, data):
        super().__init__(data)
        self.online = False
        self.accounts = []
        self.calls = []

    def _unlock(self, password):
        engine.vault_password(password)
        self.daemon = Alive(); self.unlocked = True

    def _rpc(self, request, timeout=90):
        command = request['Execute']['cli']['command']
        name = command if isinstance(command, str) else next(iter(command))
        self.calls.append(name)
        def answer(ok, result=None, code='relay_transport'):
            out = {'ok': True, 'result': result} if ok else {'ok': False, 'error': {'code': code, 'message': 'publish failed: connect relay failed'}}
            return json.dumps(out)
        if name == 'Whoami':
            return answer(True, {'accounts': self.accounts})
        if name == 'CreateIdentity':
            account = {'account_id': 'a' * 64, 'npub': 'npub1' + 'q' * 58, 'profile': {'display_name': 'Ruby Rhino'}}
            self.accounts = [account]  # made locally before the publish is tried
            return answer(self.online, account)
        if name == 'Keys':
            return answer(self.online, {'key_package_bytes': 470})
        if name == 'Profile':
            if self.online:
                self.accounts[0]['profile'] = {'display_name': command['Profile']['command']['Update']['display_name']}
            return answer(self.online, {}, code='profile_update_inconclusive')
        raise AssertionError(name)


PASS = 'a-long-test-passphrase-288'


class OfflineSetup(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.e = FakeWnd(self.tmp.name)

    def tearDown(self):
        self.tmp.cleanup()

    def test_create_offline_keeps_the_address_and_succeeds(self):
        result, proved = self.e.setup_with_proof({'action': 'create', 'vault_password': PASS, 'display_name': 'Jan'})
        self.assertTrue(proved)
        self.assertEqual(result['state'], 'ready')
        self.assertTrue(result['account_configured'])
        self.assertEqual(result['identity']['account_id'], 'a' * 64)
        self.assertTrue(self.e.keys_pending.exists(), 'its keys still wait for the relays')

    def test_pending_keys_are_published_once_the_relays_answer(self):
        self.e.setup_with_proof({'action': 'create', 'vault_password': PASS, 'display_name': 'Jan'})
        start = self.e.keys_retry_at
        self.assertFalse(self.e.publish_pending_keys(now=start - 1), 'waits before the first retry')
        self.assertFalse(self.e.publish_pending_keys(now=start), 'still offline')
        self.assertTrue(self.e.keys_pending.exists())
        self.assertEqual(self.e.keys_retry_at, start + 30)
        self.assertEqual(self.e.keys_retry_wait, 60)
        self.e.online = True
        self.assertTrue(self.e.publish_pending_keys(now=start + 30))
        self.assertFalse(self.e.keys_pending.exists())
        before = len(self.e.calls)
        self.assertFalse(self.e.publish_pending_keys(now=start + 10_000), 'nothing left to publish')
        self.assertEqual(len(self.e.calls), before)

    def test_a_locked_engine_does_not_publish(self):
        self.e.setup_with_proof({'action': 'create', 'vault_password': PASS})
        self.e.online = True; self.e.unlocked = False
        self.assertFalse(self.e.publish_pending_keys(now=self.e.keys_retry_at + 1))
        self.assertTrue(self.e.keys_pending.exists())

    def test_online_create_publishes_at_once(self):
        self.e.online = True
        result, _ = self.e.setup_with_proof({'action': 'create', 'vault_password': PASS, 'display_name': 'Jan'})
        self.assertEqual(result['identity']['display_name'], 'Jan')
        self.assertFalse(self.e.keys_pending.exists())

    def test_online_name_failure_still_reports(self):
        # Only the offline case is forgiven: a refused name with the relays up is still an error, as before.
        self.e.online = True
        real = self.e._rpc
        def refuse_name(request, timeout=90):
            if 'Profile' in str(request['Execute']['cli']['command']):
                return json.dumps({'ok': False, 'error': {'code': 'profile_update_inconclusive', 'message': 'x'}})
            return real(request, timeout)
        self.e._rpc = refuse_name
        with self.assertRaises(engine.EngineError):
            self.e.setup_with_proof({'action': 'create', 'vault_password': PASS, 'display_name': 'Jan'})

    def test_unlock_of_a_half_made_address_publishes_its_keys(self):
        # A Wizard where the first setup broke off before this fix: the account exists, the marker does not.
        self.e.accounts = [{'account_id': 'b' * 64, 'npub': 'npub1' + 'p' * 58, 'profile': {}}]
        self.assertFalse(self.e.marker.exists())
        result, _ = self.e.setup_with_proof({'action': 'unlock', 'vault_password': PASS})
        self.assertTrue(result['account_configured'])
        self.assertTrue(self.e.keys_pending.exists())
        self.e.online = True
        self.assertTrue(self.e.publish_pending_keys(now=self.e.keys_retry_at))
        # A normal unlock later (marker present) never queues a publish.
        self.e.setup_with_proof({'action': 'unlock', 'vault_password': PASS})
        self.assertFalse(self.e.keys_pending.exists())


if __name__ == '__main__':
    unittest.main()
