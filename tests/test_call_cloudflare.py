"""Issue 445 (switch calls): the guests' door in the owner's own Cloudflare account (call_cloudflare.py).

A fake Cloudflare API stands in for the account: every test checks what exists IN THE ACCOUNT, not only what the box
believes, because "turning the switch off removes the tunnel and TURN key in that account" is the promise.
"""
import json
import re
import stat
import tempfile
import threading
import unittest
import uuid
from pathlib import Path

import call_cloudflare
import calls
import unified_setup
from switches import SwitchStore

ROOT = Path(__file__).resolve().parents[1]
API_TOKEN = 'cf-test-' + 'a' * 32  # a stand-in for the owner's Cloudflare token (not a real credential)


class FakeCloudflare:
    """Just enough of the Cloudflare API: accounts, zones, tunnels (+ config, token), DNS records, TURN keys."""

    def __init__(self, zones=('example.org',)):
        self.account = 'acc0123456789'
        self.zones = [{'id': 'zone%d' % i, 'name': name, 'account': {'id': self.account}} for i, name in enumerate(zones)]
        self.tunnels, self.configs, self.dns, self.turn = {}, {}, {}, {}
        self.calls = []
        self.fail = {}  # (method, path pattern) -> remaining failures

    def __call__(self, method, url, token, body=None):
        path = url.split('://', 1)[1].split('/', 1)[1]
        self.calls.append((method, path))
        for (m, pattern), left in list(self.fail.items()):
            if m == method and re.search(pattern, path) and left:
                self.fail[(m, pattern)] = left - 1
                raise call_cloudflare.CloudflareError(500, 'cloudflare_refused', 'Internal error')
        if path.startswith('v1/turn/keys/'):
            key_id = path.split('/')[3]
            if key_id not in self.turn or token != self.turn[key_id]:
                raise call_cloudflare.CloudflareError(401, 'cloudflare_refused', 'bad TURN key')
            return {'iceServers': [{'urls': ['stun:stun.cloudflare.com:3478']}, {'urls': [
                'turn:turn.cloudflare.com:3478?transport=udp', 'turn:turn.cloudflare.com:443?transport=udp',
                'turn:turn.cloudflare.com:3478?transport=tcp', 'turn:turn.cloudflare.com:80?transport=tcp',
                'turns:turn.cloudflare.com:5349?transport=tcp', 'turns:turn.cloudflare.com:443?transport=tcp'],
                'username': 'u-' + key_id, 'credential': 'c-' + str(body['ttl'])}]}
        if token != API_TOKEN:
            raise call_cloudflare.CloudflareError(403, 'cloudflare_refused', 'Invalid API Token')
        path = path[len('client/v4/'):]
        a = 'accounts/' + self.account
        if method == 'GET' and path.startswith('accounts?'):
            return {'success': True, 'result': [{'id': self.account, 'name': 'Owner'}]}
        if method == 'GET' and path.startswith('zones?'):
            return {'success': True, 'result': self.zones}
        if method == 'POST' and path == a + '/cfd_tunnel':
            tid = str(uuid.uuid4())
            self.tunnels[tid] = {'name': body['name'], 'config_src': body['config_src'], 'connections': 1}
            return {'success': True, 'result': {'id': tid, 'token': 'tok-' + tid}}
        m = re.fullmatch(a + r'/cfd_tunnel/([^/]+)(/configurations|/token|/connections)?', path)
        if m:
            tid, sub = m.groups()
            if tid not in self.tunnels:
                raise call_cloudflare.CloudflareError(404, 'cloudflare_refused', 'Tunnel not found')
            if method == 'PUT' and sub == '/configurations':
                self.configs[tid] = body['config']
                return {'success': True, 'result': {}}
            if method == 'GET' and sub == '/token':
                return {'success': True, 'result': 'tok-' + tid}
            if method == 'DELETE' and sub == '/connections':
                self.tunnels[tid]['connections'] = 0
                return {'success': True, 'result': None}
            if method == 'DELETE' and sub is None:
                if self.tunnels[tid]['connections']:
                    raise call_cloudflare.CloudflareError(400, 'cloudflare_refused', 'Tunnel has active connections')
                del self.tunnels[tid]
                self.configs.pop(tid, None)
                return {'success': True, 'result': {}}
        m = re.fullmatch(r'zones/([^/]+)/dns_records(?:/([^/]+))?', path)
        if m:
            zone, rid = m.groups()
            if method == 'POST':
                rid = uuid.uuid4().hex
                self.dns[rid] = {**body, 'zone': zone}
                return {'success': True, 'result': {'id': rid}}
            if method == 'DELETE':
                if rid not in self.dns:
                    raise call_cloudflare.CloudflareError(404, 'cloudflare_refused', 'Record not found')
                del self.dns[rid]
                return {'success': True, 'result': {'id': rid}}
        m = re.fullmatch(a + r'/calls/turn_keys(?:/([^/]+))?', path)
        if m:
            kid = m.group(1)
            if method == 'POST':
                kid = uuid.uuid4().hex
                self.turn[kid] = 'turnkey-' + kid
                return {'success': True, 'result': {'uid': kid, 'key': self.turn[kid], 'name': body['name']}}
            if method == 'DELETE':
                if kid not in self.turn:
                    raise call_cloudflare.CloudflareError(404, 'cloudflare_refused', 'Key not found')
                del self.turn[kid]
                return {'success': True, 'result': {}}
        raise AssertionError('unexpected Cloudflare call %s %s' % (method, path))

    def empty(self):
        return not (self.tunnels or self.dns or self.turn)


class CloudflareDoorTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.root = Path(self.tmp.name) / 'data'
        unified_setup.setup(self.root)
        self.cf = FakeCloudflare()
        self.busy = False
        self.keeper = call_cloudflare.Cloudflare(self.root, request=self.cf, idle=lambda: not self.busy)
        self.switches = SwitchStore(self.root / 'switches.json')
        self.old_wait = call_cloudflare.STOP_WAIT
        call_cloudflare.STOP_WAIT = 0

    def tearDown(self):
        call_cloudflare.STOP_WAIT = self.old_wait
        self.tmp.cleanup()

    def switch(self, on):
        self.switches.set('calls', on)
        calls.set_running(self.root, on)
        self.keeper.sync()

    def files(self):
        return {name for name in ('tunnel-token', 'public.json', 'ice.json') if (self.root / 'calls' / name).exists()}

    def livekit(self):
        return json.loads((self.root / 'calls' / 'livekit.yaml').read_text())

    def test_a_token_needs_an_account_with_a_domain(self):
        with self.assertRaises(call_cloudflare.CloudflareError) as e:
            self.keeper.connect('short')
        self.assertEqual(e.exception.code, 'invalid_token')
        with self.assertRaises(call_cloudflare.CloudflareError) as e:
            self.keeper.connect('cf-wrong-' + 'b' * 32)
        self.assertIn('Invalid API Token', e.exception.message)
        self.cf.zones = []
        with self.assertRaises(call_cloudflare.CloudflareError) as e:
            self.keeper.connect(API_TOKEN)
        self.assertEqual(e.exception.code, 'no_domain')
        self.assertFalse(self.keeper.status()['connected'])

    def test_switch_on_makes_the_door_in_the_owners_account_and_off_removes_it(self):
        self.switch(True)
        self.assertEqual(self.keeper.status()['reach'], 'tailnet')  # no Cloudflare yet: own devices only
        self.assertTrue(self.cf.empty())
        st = self.keeper.connect(API_TOKEN)
        self.assertEqual((st['connected'], st['zone']), (True, 'example.org'))
        self.keeper.sync()
        st = self.keeper.status()
        self.assertEqual(st['reach'], 'everyone')
        self.assertRegex(st['host'], r'^call-[0-9a-f]{6}\.example\.org$')
        # In the account: one tunnel whose ONLY route is the guests' call listener, its DNS name, one TURN key.
        (tid, tunnel), = self.cf.tunnels.items()
        self.assertEqual(tunnel['config_src'], 'cloudflare')
        self.assertEqual(self.cf.configs[tid]['ingress'], [
            {'hostname': st['host'], 'service': 'http://messenger:8790', 'originRequest': {}}, {'service': 'http_status:404'}])
        (record,) = self.cf.dns.values()
        self.assertEqual((record['type'], record['name'], record['content'], record['proxied']),
                         ('CNAME', st['host'], tid + '.cfargotunnel.com', True))
        self.assertEqual(len(self.cf.turn), 1)
        # On the box: the tunnel token for cloudflared, the public origin, LiveKit's TURN logins; owner-only files.
        folder = self.root / 'calls'
        self.assertEqual((folder / 'tunnel-token').read_text(), 'tok-' + tid)
        self.assertEqual(json.loads((folder / 'public.json').read_text()), {'origin': 'https://' + st['host']})
        for name in ('tunnel-token', 'public.json', 'ice.json', 'cloudflare.json'):
            self.assertEqual(stat.S_IMODE((folder / name).stat().st_mode), 0o600, name)
        rtc = self.livekit()['rtc']
        self.assertTrue(rtc['use_external_ip'])
        self.assertEqual(rtc['stun_servers'], ['stun.cloudflare.com:3478'])
        self.assertEqual(sorted((t['protocol'], t['port']) for t in rtc['turn_servers']), [('tcp', 3478), ('tls', 443), ('udp', 3478)])
        self.assertTrue(all(t['host'] == 'turn.cloudflare.com' and t['username'].startswith('u-') for t in rtc['turn_servers']))
        # Doing it again changes nothing in the account.
        made = len(self.cf.calls)
        self.keeper.sync()
        self.assertEqual([c for c in self.cf.calls[made:] if c[0] != 'GET'], [])
        # Off: nothing left in the account or on the box, LiveKit back to no TURN; the token stays for next time.
        gen = (folder / 'livekit.gen').read_text()
        self.switch(False)
        self.assertTrue(self.cf.empty(), (self.cf.tunnels, self.cf.dns, self.cf.turn))
        self.assertEqual(self.files(), set())
        self.assertNotIn('turn_servers', self.livekit()['rtc'])
        self.assertFalse(self.livekit()['rtc']['use_external_ip'])
        self.assertNotEqual((folder / 'livekit.gen').read_text(), gen)  # LiveKit restarts without them
        self.assertEqual(self.keeper.status()['reach'], 'tailnet')
        self.assertTrue(self.keeper.status()['connected'])
        # On again: a new door.
        self.switch(True)
        self.assertEqual((len(self.cf.tunnels), len(self.cf.dns), len(self.cf.turn)), (1, 1, 1))
        self.assertNotEqual(self.keeper.status()['host'], st['host'])

    def test_forget_removes_the_door_and_the_token(self):
        self.switch(True)
        self.keeper.connect(API_TOKEN)
        self.keeper.sync()
        self.assertFalse(self.cf.empty())
        st = self.keeper.forget()
        self.assertTrue(self.cf.empty())
        self.assertEqual((st['connected'], st['reach']), (False, 'tailnet'))
        self.assertFalse((self.root / 'calls' / 'cloudflare.json').exists())
        self.assertEqual(self.files(), set())

    def test_a_failed_step_is_finished_later_without_a_second_tunnel(self):
        self.switch(True)
        self.keeper.connect(API_TOKEN)
        self.cf.fail[('POST', r'dns_records$')] = 1
        with self.assertRaises(call_cloudflare.CloudflareError):
            self.keeper.sync()
        self.assertEqual((len(self.cf.tunnels), len(self.cf.dns)), (1, 0))
        self.assertEqual(self.keeper.status()['reach'], 'tailnet')  # no link until the door is whole
        self.keeper.sync()
        self.assertEqual((len(self.cf.tunnels), len(self.cf.dns), len(self.cf.turn)), (1, 1, 1))
        self.assertEqual(self.keeper.status()['reach'], 'everyone')
        # A removal that fails half way is finished on the next round too.
        self.cf.fail[('DELETE', r'turn_keys/')] = 1
        self.switches.set('calls', False)
        with self.assertRaises(call_cloudflare.CloudflareError):
            self.keeper.sync()
        self.assertEqual(self.files(), set())  # the box stops using it at once
        self.keeper.sync()
        self.assertTrue(self.cf.empty())

    def test_the_keeper_thread_follows_the_switch(self):
        self.keeper.connect(API_TOKEN)
        t = threading.Thread(target=self.keeper.run, kwargs={'every': 3600}, daemon=True)
        t.start()
        try:
            self.switches.set('calls', True)
            self.keeper.kick()
            for _ in range(100):
                if self.keeper.status()['reach'] == 'everyone':
                    break
                threading.Event().wait(0.05)
            self.assertEqual(self.keeper.status()['reach'], 'everyone')
            self.switches.set('calls', False)
            self.keeper.kick()
            for _ in range(100):
                if self.cf.empty():
                    break
                threading.Event().wait(0.05)
            self.assertTrue(self.cf.empty())
        finally:
            self.keeper.stop.set()
            self.keeper.kick()
            t.join(2)

    def test_turn_logins_are_renewed_only_between_calls(self):
        self.switch(True)
        self.keeper.connect(API_TOKEN)
        self.keeper.sync()
        state = json.loads((self.root / 'calls' / 'cloudflare.json').read_text())
        state['made']['ice_at'] -= call_cloudflare.TURN_REFRESH + 1
        (self.root / 'calls' / 'cloudflare.json').write_text(json.dumps(state))
        gen = (self.root / 'calls' / 'livekit.gen').read_text()
        self.busy = True
        self.keeper.sync()
        self.assertEqual((self.root / 'calls' / 'livekit.gen').read_text(), gen)  # a call is on: LiveKit untouched
        self.busy = False
        before = len(self.cf.calls)
        self.keeper.sync()
        self.assertIn('generate-ice-servers', ' '.join(p for _, p in self.cf.calls[before:]))
        self.assertEqual(json.loads((self.root / 'calls' / 'cloudflare.json').read_text())['made']['turn'],
                         state['made']['turn'])  # the same key, new logins

    def test_choosing_a_domain_when_the_account_has_several(self):
        self.cf.zones = FakeCloudflare(('a.example', 'b.example')).zones
        self.switch(True)
        st = self.keeper.connect(API_TOKEN)
        self.assertIsNone(st['zone'])
        self.keeper.sync()
        self.assertTrue(self.cf.empty())  # nothing made before the owner picks
        st = self.keeper.choose('zone1')
        self.keeper.sync()
        self.assertTrue(self.keeper.status()['host'].endswith('.b.example'))
        with self.assertRaises(call_cloudflare.CloudflareError):
            self.keeper.choose('zone9')

    def test_token_page_asks_for_exactly_the_needed_permissions(self):
        self.assertTrue(call_cloudflare.TOKEN_PAGE.startswith('https://dash.cloudflare.com/profile/api-tokens?'))
        self.assertEqual(sorted(p['key'] for p in call_cloudflare.PERMISSIONS), ['argotunnel', 'calls', 'dns', 'zone'])
        self.assertEqual({p['type'] for p in call_cloudflare.PERMISSIONS if p['key'] != 'zone'}, {'edit'})

    def test_ice_servers_map_to_livekit(self):
        self.assertEqual(call_cloudflare.ice_to_livekit([{'urls': ['stun:stun.cloudflare.com:3478']}]), [])
        self.assertEqual(call_cloudflare.ice_to_livekit([{'urls': 'turns:t.example:443?transport=tcp', 'username': 'u', 'credential': 'c'}]),
                         [{'host': 't.example', 'port': 443, 'protocol': 'tls', 'username': 'u', 'credential': 'c'}])
        self.assertEqual(call_cloudflare.ice_to_livekit(None), [])


class RecipeTests(unittest.TestCase):
    def setUp(self):
        self.compose = (ROOT / 'runtipi' / 'docker-compose.yml').read_text()

    def service(self, name):
        match = re.search(r'\n  %s:\n(.*?)(?=\n  [a-z][a-z0-9-]*:\n)' % re.escape(name), self.compose, re.S)
        self.assertIsNotNone(match, name)
        return match.group(1)

    def test_the_tunnel_runs_only_with_the_switch_and_a_tunnel_and_opens_no_port(self):
        block = self.service('call-tunnel')
        self.assertIn('until [ -f /calls/enabled ] && [ -s /calls/tunnel-token ]', block)
        self.assertIn('cloudflared tunnel --no-autoupdate', block)
        self.assertIn('run --token-file /calls/tunnel-token', block)
        for absent in ('ports:', 'network_mode', 'expose:'):
            self.assertNotIn(absent, block)
        self.assertIn('networks: [tunnel-lane, call-egress]', block)
        self.assertIn('  tunnel-lane: {internal: true}\n', self.compose)
        self.assertIn('tunnel-lane', re.search(r'\n  messenger:\n(?:.*\n)*?    networks: \[([^\]]*)\]', self.compose).group(1))
        # Nothing else is on the tunnel's lane: it reaches Messenger's guest listener and nothing of LiveKit or Synapse.
        lanes = re.findall(r'\n  ([a-z][a-z0-9-]*):\n(?:(?!\n  [a-z]).)*?networks: \[([^\]]*)\]', self.compose, re.S)
        self.assertEqual(sorted(name for name, nets in lanes if 'tunnel-lane' in nets), ['call-tunnel', 'messenger'])
        messenger_image = re.search(r'\n  messenger:\n    image: (\S+)\n', self.compose).group(1)
        self.assertIn('image: %s\n' % messenger_image, block)

    def test_livekit_restarts_on_new_turn_logins(self):
        self.assertIn('/calls/livekit.gen', self.service('livekit'))

    def test_cloudflared_is_pinned_by_digest(self):
        self.assertRegex((ROOT / 'Dockerfile').read_text(),
                         r'COPY --from=cloudflare/cloudflared:[0-9.]+@sha256:[0-9a-f]{64} /usr/local/bin/cloudflared /usr/local/bin/cloudflared\n')
        for name in ('Dockerfile', 'Dockerfile.overlay'):
            self.assertIn(' call_cloudflare.py ', (ROOT / name).read_text(), name)


if __name__ == '__main__':
    unittest.main()
