"""Issue 445 (switch calls): the call door. Element Call from the box, guests only through a call's link, and a
guest's Matrix token reaches only what its one call needs. A recorded Synapse stands in for the real one (the rig in
the PR checks the real Synapse, LiveKit and Element Call)."""
import hashlib
import hmac
import http.client
import json
import re
import tempfile
import threading
import time
import unittest
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import unquote, urlsplit

import call_door
import calls
import test_web

REG_KEY = 'fixture-registration-key'
CALL_ROOM_PREFIX = '!call'


class FakeSynapse(ThreadingHTTPServer):
    daemon_threads = True

    def __init__(self):
        super().__init__(('127.0.0.1', 0), FakeSynapseHandler)
        self.tokens = {}       # token -> user id
        self.deactivated = set()
        self.invites = []
        self.rooms = 0
        self.state = {}        # room -> [events]
        self.seen = []         # (method, path, body)
        self.nonces = set()


class FakeSynapseHandler(BaseHTTPRequestHandler):
    protocol_version = 'HTTP/1.1'

    def log_message(self, *a):
        pass

    def reply(self, status, data):
        body = json.dumps(data).encode()
        self.send_response(status)
        self.send_header('Content-Type', 'application/json')
        self.send_header('Content-Length', str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def handle_any(self):
        s = self.server
        length = int(self.headers.get('Content-Length') or 0)
        body = json.loads(self.rfile.read(length) or b'{}') if length else {}
        path = urlsplit(self.path).path
        s.seen.append((self.command, path, body))
        if path == '/_synapse/admin/v1/register':
            if self.command == 'GET':
                nonce = 'n%d' % len(s.nonces)
                s.nonces.add(nonce)
                return self.reply(200, {'nonce': nonce})
            fields = [str(body[k]).encode() for k in ('nonce', 'username', 'pass' 'word')]
            mac = hmac.new(REG_KEY.encode(), b'\x00'.join(fields + [b'admin' if body['admin'] else b'notadmin']), hashlib.sha1).hexdigest()
            if mac != body['mac'] or body['nonce'] not in s.nonces:
                return self.reply(403, {'errcode': 'M_FORBIDDEN'})
            s.nonces.discard(body['nonce'])
            user = '@%s:messenger.internal' % body['username']
            token = 'tok-' + body['username']
            s.tokens[token] = user
            return self.reply(200, {'user_id': user, 'access_token': token, 'device_id': 'DEV' + body['username'][-4:]})
        auth = self.headers.get('Authorization', '')
        user = s.tokens.get(auth[7:]) if auth.startswith('Bearer ') else None
        if path == '/_matrix/client/versions':
            return self.reply(200, {'versions': ['v1.12']})
        if user is None or user in s.deactivated:
            return self.reply(401, {'errcode': 'M_UNKNOWN_TOKEN'})
        if path.endswith('/account/whoami'):
            return self.reply(200, {'user_id': user})
        if path.endswith('/createRoom'):
            s.rooms += 1
            room = '%s%d' % (CALL_ROOM_PREFIX, s.rooms)
            s.state[room] = []
            return self.reply(200, {'room_id': room})
        m = re.fullmatch(r'/_matrix/client/v3/rooms/([^/]+)/invite', path)
        if m:
            s.invites.append((unquote(m.group(1)), body['user_id']))
            return self.reply(200, {})
        m = re.fullmatch(r'/_matrix/client/v3/rooms/([^/]+)/state', path)
        if m and self.command == 'GET':
            return self.reply(200, s.state.get(unquote(m.group(1)), []))
        m = re.fullmatch(r'/_synapse/admin/v1/deactivate/(.+)', path)
        if m:
            s.deactivated.add(unquote(m.group(1)))
            return self.reply(200, {'id_server_unbind_result': 'success'})
        if path.endswith('/rtc/transports'):
            return self.reply(200, {'transports': [{'type': 'm.livekit', 'url': calls.LIVEKIT_WS}]})
        if path.endswith('/rtc/livekit/get_token'):
            return self.reply(200, {'jwt': 'jwt-for-' + user, 'url': body.get('url')})
        return self.reply(200, {'ok': True, 'path': path})

    do_GET = do_POST = do_PUT = do_DELETE = handle_any


class DoorCase(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.root = Path(self.tmp.name) / 'data'
        (self.root / 'matrix').mkdir(parents=True)
        (self.root / 'matrix' / ('registration_shared_' + 'secret')).write_text(REG_KEY)
        self.switch(True)
        self.app = Path(self.tmp.name) / 'element-call'
        (self.app / 'assets').mkdir(parents=True)
        (self.app / 'index.html').write_text('<!doctype html><title>Element Call</title><script src="./assets/a.js"></script>')
        (self.app / 'assets' / 'a.js').write_text('console.log(1)')
        (Path(self.tmp.name) / 'secret.txt').write_text('not for guests')
        self.hs = FakeSynapse()
        threading.Thread(target=self.hs.serve_forever, daemon=True).start()
        self.old_url = call_door.MATRIX_URL
        call_door.MATRIX_URL = 'http://127.0.0.1:%d' % self.hs.server_port
        self.door = call_door.Door(self.root, app=self.app)
        self.guests = call_door.GuestServer(self.door, ('127.0.0.1', 0))
        threading.Thread(target=self.guests.serve_forever, daemon=True).start()

    def tearDown(self):
        call_door.MATRIX_URL = self.old_url
        for server in (self.guests, self.hs):
            server.shutdown()
            server.server_close()
        self.tmp.cleanup()

    def switch(self, on):
        (self.root / 'switches.json').write_text(json.dumps({'switches': {'calls': on}}))

    def request(self, method, path, body=None, token=None, port=None):
        conn = http.client.HTTPConnection('127.0.0.1', port or self.guests.server_port, timeout=5)
        headers = {'Connection': 'close'}
        if body is not None:
            headers['Content-Type'] = 'application/json'
            body = json.dumps(body)
        if token:
            headers['Authorization'] = 'Bearer ' + token
        conn.request(method, path, body, headers)
        r = conn.getresponse()
        raw = r.read()
        conn.close()
        data = json.loads(raw) if r.getheader('Content-Type', '').startswith('application/json') and raw else raw
        return r.status, dict(r.getheaders()), data

    def guest(self, call):
        status, _, login = self.request('POST', '/k/%s/_matrix/client/v3/register' % call['key'],
                                        {'username': 'anything', 'password': 'whatever'})
        self.assertEqual(status, 200, login)
        return login


class GuestDoor(DoorCase):
    def test_off_switch_answers_nothing(self):
        call = self.door.start('Ann')
        self.switch(False)
        for path in ('/c/' + call['key'], '/k/%s/join/' % call['key'], '/k/%s/join/config.json' % call['key'],
                     '/k/%s/_matrix/client/versions' % call['key']):
            self.assertEqual(self.request('GET', path)[0], 404, path)
        self.assertEqual(self.request('POST', '/k/%s/_matrix/client/v3/register' % call['key'], {'username': 'x', 'password': 'y'})[0], 404)
        with self.assertRaises(call_door.DoorError):
            self.door.start('Ann')

    def test_link_opens_element_call_for_that_call_only(self):
        call = self.door.start('Ann')
        status, headers, _ = self.request('GET', '/c/' + call['key'])
        self.assertEqual(status, 302)
        where = headers['Location']
        self.assertTrue(where.startswith('/k/%s/join/#/' % call['key']), where)
        self.assertIn('roomId=' + call['room'].replace('!', '%21'), where)
        self.assertIn('password=' + call['password'], where)
        self.assertEqual(headers['Referrer-Policy'], 'no-referrer')
        status, headers, page = self.request('GET', '/k/%s/join/' % call['key'])
        self.assertEqual(status, 200)
        self.assertIn(b'Element Call', page)
        self.assertIn("frame-ancestors 'self'", headers['Content-Security-Policy'])
        status, _, config = self.request('GET', '/k/%s/join/config.json' % call['key'])
        self.assertEqual(config['default_server_config']['m.homeserver'],
                         {'base_url': 'http://127.0.0.1:%d/k/%s' % (self.guests.server_port, call['key']),
                          'server_name': 'messenger.internal'})
        self.assertEqual(self.request('GET', '/k/%s/join/assets/a.js' % call['key'])[2], b'console.log(1)')
        # A wrong or ended key opens nothing, and nothing outside Element Call's own files is served.
        self.assertEqual(self.request('GET', '/c/' + 'x' * 32)[0], 404)
        self.assertEqual(self.request('GET', '/k/%s/join/' % ('x' * 32))[0], 404)
        for path in ('/k/%s/join/assets/..%%2F..%%2Fsecret.txt', '/k/%s/join/../../secret.txt', '/k/%s/assets/%%2e%%2e/secret.txt'):
            self.assertNotIn(b'not for guests', self.request('GET', path % call['key'])[2], path)
        self.assertEqual(self.request('GET', '/')[0], 404)

    def test_a_guest_gets_an_account_in_that_one_call(self):
        call = self.door.start('Ann')
        status, _, probe = self.request('POST', '/k/%s/_matrix/client/v3/register' % call['key'], {})
        self.assertEqual(status, 401)  # Element Call's first question: no captcha, no terms
        self.assertEqual(probe['flows'], [{'stages': ['m.login.dummy']}])
        login = self.guest(call)
        self.assertRegex(login['user_id'], r'^@guest-[0-9a-f]{12}:messenger\.internal$')
        self.assertIn((call['room'], login['user_id']), self.hs.invites)
        self.assertEqual(self.door._load()['accounts'][login['user_id']], {
            'call': call['id'], 'owner': False, 'made': self.door._load()['accounts'][login['user_id']]['made']})
        # The account never shows up under another call's address.
        other = self.door.start('Bob')
        status, _, _ = self.request('GET', '/k/%s/_matrix/client/v3/sync' % other['key'], token=login['access_token'])
        self.assertEqual(status, 401)

    def test_a_guest_token_reads_only_its_own_call(self):
        call = self.door.start('Ann')
        tok = self.guest(call)['access_token']
        k = '/k/%s/_matrix/client' % call['key']
        room = call['room']
        allowed = [('GET', '/v3/sync'), ('GET', '/v3/account/whoami'), ('POST', '/v3/join/' + room),
                   ('GET', '/v3/rooms/%s/state' % room), ('PUT', '/v3/rooms/%s/state/org.matrix.msc3401.call.member/_x' % room),
                   ('PUT', '/unstable/org.matrix.msc4140/rooms/%s/delayed_event/org.matrix.msc3401.call.member/m1' % room),
                   ('GET', '/v1/rtc/transports')]
        for method, path in allowed:
            self.assertEqual(self.request(method, k + path, {} if method != 'GET' else None, tok)[0], 200, path)
        refused = [('GET', '/v3/rooms/!owner-chat/messages'), ('GET', '/v3/rooms/!owner-chat/state'),
                   ('POST', '/v3/join/!owner-chat'), ('POST', '/v3/rooms/!owner-chat/join'),
                   ('PUT', '/v3/rooms/!owner-chat/send/m.room.message/1'), ('POST', '/v3/createRoom'),
                   ('GET', '/v3/joined_rooms'), ('POST', '/v3/user_directory/search'), ('GET', '/v3/publicRooms'),
                   ('GET', '/v3/profile/@owner:messenger.internal'), ('POST', '/v3/rooms/%s/invite' % room),
                   ('POST', '/v3/rooms/%s/kick' % room), ('GET', '/v3/rooms/%s%%2F..%%2F!owner-chat/messages' % room)]
        before = len(self.hs.seen)
        for method, path in refused:
            self.assertEqual(self.request(method, k + path, {} if method != 'GET' else None, tok)[0], 403, path)
        self.assertEqual(self.request('POST', k + '/v3/keys/query', {'device_keys': {'@owner:messenger.internal': []}}, tok)[0], 403)
        self.assertEqual(self.request('PUT', k + '/v3/sendToDevice/m.room.encrypted/1',
                                      {'messages': {'@owner:messenger.internal': {'*': {}}}}, tok)[0], 403)
        self.assertEqual(len(self.hs.seen), before)  # no refused request reached Synapse
        self.assertEqual(self.request('GET', '/k/%s/_synapse/admin/v1/server_version' % call['key'], token=tok)[0], 404)
        self.assertEqual(self.request('GET', '/_matrix/client/v3/sync', token=tok)[0], 404)

    def test_livekit_is_reached_through_the_door(self):
        call = self.door.start('Ann')
        tok = self.guest(call)['access_token']
        k = '/k/%s/_matrix/client' % call['key']
        public = 'ws://127.0.0.1:%d/k/%s/livekit' % (self.guests.server_port, call['key'])
        self.assertEqual(self.request('GET', k + '/v1/rtc/transports', token=tok)[2]['transports'][0]['url'], public)
        status, _, got = self.request('POST', k + '/unstable/io.element.msc4195/rtc/livekit/get_token',
                                      {'url': public, 'room_id': call['room']}, tok)
        self.assertEqual(got['url'], public)
        self.assertEqual(self.hs.seen[-1][2]['url'], calls.LIVEKIT_WS)  # the token service sees its own address

    def test_an_empty_call_ends_and_its_guests_are_signed_out(self):
        call = self.door.start('Ann')
        tok = self.guest(call)['access_token']
        self.hs.state[call['room']] = [{'type': 'org.matrix.msc3401.call.member', 'content': {'focus_active': {}}}]
        self.door.sweep(now=time.time() + call_door.IDLE + 5)
        self.assertIsNone(self.door._load()['calls'][call['id']]['ended'])  # someone is in it
        self.hs.state[call['room']] = [{'type': 'org.matrix.msc3401.call.member', 'content': {}}]
        self.door.sweep(now=time.time() + 2 * call_door.IDLE + 5)
        self.assertIsNotNone(self.door._load()['calls'][call['id']]['ended'])
        self.assertEqual(self.door._load()['accounts'], {})
        self.assertEqual(self.request('GET', '/k/%s/_matrix/client/v3/sync' % call['key'], token=tok)[0], 404)
        self.assertEqual(self.request('GET', '/c/' + call['key'])[0], 404)
        self.assertEqual(len(self.hs.deactivated), 1)

    def test_switching_off_ends_every_call(self):
        call = self.door.start('Ann')
        self.guest(call)
        self.switch(False)
        self.door.sweep()
        self.assertIsNotNone(self.door._load()['calls'][call['id']]['ended'])
        self.assertEqual(len(self.hs.deactivated), 1)

    def test_a_call_holds_at_most_eight_guests(self):
        call = self.door.start('Ann')
        for _ in range(call_door.MAX_GUESTS):
            self.guest(call)
        status, _, body = self.request('POST', '/k/%s/_matrix/client/v3/register' % call['key'], {'username': 'x', 'password': 'y'})
        self.assertEqual((status, body['errcode']), (403, 'M_LIMIT_EXCEEDED'))


class OwnerDoor(DoorCase):
    """Inside Messenger (<app path>call/), only the owner's own session makes a call account."""

    def setUp(self):
        super().setUp()
        engine = test_web.FakeEngine()
        engine.data = str(self.root)
        self.view = test_web.ViewServer(('127.0.0.1', 0), engine, test_web.TOKEN, [test_web.ORIGIN])
        self.view.call_door.app = self.app
        self.server = self.view  # for test_web.ViewBoundary.session
        threading.Thread(target=self.view.serve_forever, daemon=True).start()

    def tearDown(self):
        self.view.shutdown()
        self.view.server_close()
        super().tearDown()

    def owner_request(self, method, path, body=None, cookie=None, extra=None):
        conn = http.client.HTTPConnection('127.0.0.1', self.view.server_port, timeout=5)
        headers = {'Connection': 'close', **(extra or {})}
        if cookie:
            headers['Cookie'] = cookie
        if body is not None:
            headers['Content-Type'] = 'application/json'
            body = json.dumps(body)
        conn.request(method, path, body, headers)
        r = conn.getresponse()
        raw = r.read()
        conn.close()
        return r.status, json.loads(raw) if raw[:1] == b'{' else raw

    def test_owner_starts_a_call_and_joins_from_messenger(self):
        cookie, csrf = test_web.ViewBoundary.session(self)
        owner = {'Cookie': cookie, 'Origin': test_web.ORIGIN, 'X-Messenger-CSRF': csrf}
        self.assertEqual(self.owner_request('POST', '/api/view/calls', {'title': 'Ann'}, extra={'Origin': test_web.ORIGIN})[0], 401)
        self.assertEqual(self.owner_request('POST', '/api/view/calls', {'title': 'Ann'},
                                            extra={'Authorization': 'Bearer ' + test_web.TOKEN})[0], 403)
        status, body = self.owner_request('POST', '/api/view/calls', {'title': 'Ann'}, extra=owner)
        self.assertEqual(status, 200, body)
        result = body['result']
        call = self.view.call_door._load()['calls'][result['call']]
        self.assertEqual(call['title'], 'Ann')
        self.assertTrue(result['open'].startswith('/call/k/%s/join/#/Ann?roomId=' % call['owner_key']), result['open'])
        self.assertEqual((result['link'], result['reach']), (None, 'tailnet'))  # no public door yet
        base = '/call/k/%s' % call['owner_key']
        status, page = self.owner_request('GET', base + '/join/')
        self.assertEqual(status, 200)
        self.assertIn(b'Element Call', page)
        status, config = self.owner_request('GET', base + '/join/config.json')
        self.assertTrue(config['default_server_config']['m.homeserver']['base_url'].endswith(base))
        status, login = self.owner_request('POST', base + '/_matrix/client/v3/register', {'username': 'x', 'password': 'y'})
        self.assertEqual(status, 200, login)
        self.assertRegex(login['user_id'], r'^@owner-[0-9a-f]{12}:messenger\.internal$')
        self.assertIn((call['room'], login['user_id']), self.hs.invites)
        # Each key opens only its own door: the guest key never inside Messenger, the owner key never for guests.
        self.assertEqual(self.owner_request('GET', '/call/k/%s/join/' % call['key'])[0], 404)
        self.assertEqual(self.request('GET', '/k/%s/join/' % call['owner_key'])[0], 404)
        self.assertEqual(self.request('GET', '/c/' + call['owner_key'])[0], 404)
        # With a public door the owner gets the link to send.
        (self.root / 'calls' / 'public.json').write_text(json.dumps({'origin': 'https://call.example.org'}))
        status, body = self.owner_request('POST', '/api/view/calls', {'title': 'Bob'}, extra=owner)
        key = self.view.call_door._load()['calls'][body['result']['call']]['key']
        self.assertEqual((body['result']['link'], body['result']['reach']), ('https://call.example.org/c/' + key, 'everyone'))
        # The switch off closes this door too.
        self.switch(False)
        self.assertEqual(self.owner_request('GET', base + '/join/')[0], 404)
        self.assertEqual(self.owner_request('POST', '/api/view/calls', {'title': 'Ann'}, extra=owner)[0], 404)


class Pins(unittest.TestCase):
    def test_element_call_is_pinned_with_its_checksum(self):
        root = Path(__file__).resolve().parents[1]
        dockerfile = (root / 'Dockerfile').read_text()
        self.assertRegex(dockerfile, r'ADD --checksum=sha256:[0-9a-f]{64} https://github\.com/element-hq/element-call/'
                                     r'releases/download/%s/element-call-embedded-%s\.tar\.gz ' % (
                                         calls.VERSIONS['element-call'], calls.VERSIONS['element-call'][1:]))
        self.assertIn('COPY --from=element-call /opt/element-call /opt/element-call\n', dockerfile)
        for name in ('Dockerfile', 'Dockerfile.overlay'):
            self.assertIn(' call_door.py ', (root / name).read_text(), name)


if __name__ == '__main__':
    unittest.main()
