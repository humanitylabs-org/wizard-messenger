"""Browser boundary (wizard-os issue 133): a Messenger window the Wizard sandboxes has an opaque origin, so its
<img>/<video>/<audio> loads arrive cross-site with no session cookie and no Origin. They carry the session's media
ticket (?t=) instead. The ticket opens only GET of media, picker previews and profile pictures, and dies with its
session."""
import unittest
from unittest.mock import Mock
import test_web as fx

CROSS = {'Sec-Fetch-Site': 'cross-site', 'Sec-Fetch-Dest': 'image'}


class MediaTicket(unittest.TestCase):
    setUp = fx.ViewBoundary.setUp
    tearDown = fx.ViewBoundary.tearDown
    request = fx.ViewBoundary.request
    session = fx.ViewBoundary.session

    def owner_ticket(self):
        self.server.engine.ready = True
        cookie, _ = self.session()
        status, _, body = self.request('GET', '/api/view/session', headers={'Cookie': cookie})
        self.assertEqual(status, 200)
        ticket = body['result']['media_ticket']
        self.assertRegex(ticket, r'^[A-Za-z0-9_-]{32,128}$')
        # The same session keeps the same ticket (addresses stay cacheable).
        self.assertEqual(self.request('GET', '/api/view/session', headers={'Cookie': cookie})[2]['result']['media_ticket'], ticket)
        return cookie, ticket

    def unified(self):
        unified = Mock()
        unified.dispatch.return_value = {'ok': 1}
        self.server.unified = unified
        return unified

    def test_ticket_opens_media_from_a_sandboxed_window(self):
        unified = self.unified()
        _, ticket = self.owner_ticket()
        for path in ('/api/unified/media/%24photo?t=' + ticket + '&kind=thumb',
                     '/api/unified/media/%24gif?t=' + ticket,
                     '/api/unified/picker/media/123?t=' + ticket,
                     '/api/unified/people/p1/avatar?t=' + ticket + '&v=abc'):
            self.assertEqual(self.request('GET', path, headers=CROSS)[0], 200, path)
            self.assertEqual(self.request('GET', path, headers={**CROSS, 'Origin': 'null'})[0], 200, path)
        self.assertEqual(unified.dispatch.call_count, 8)
        self.assertEqual(unified.dispatch.call_args_list[0].args[3]['kind'], ['thumb'])

    def test_without_a_ticket_the_window_is_still_refused(self):
        unified = self.unified()
        _, ticket = self.owner_ticket()
        self.assertEqual(self.request('GET', '/api/unified/media/%24photo', headers=CROSS)[0], 403)
        self.assertEqual(self.request('GET', '/api/unified/media/%24photo?t=' + 'x' * 43, headers=CROSS)[0], 403)
        self.assertEqual(self.request('GET', '/api/unified/media/%24photo?t=' + ticket[:-1] + ('A' if ticket[-1] != 'A' else 'B'), headers=CROSS)[0], 403)
        unified.dispatch.assert_not_called()

    def test_ticket_opens_nothing_else(self):
        unified = self.unified()
        _, ticket = self.owner_ticket()
        for method, path in (('GET', '/api/unified/people?t='), ('GET', '/api/unified/people/p1?t='), ('GET', '/api/unified/updates?t='),
                             ('GET', '/api/drafts?t='), ('GET', '/api/identity?t='), ('GET', '/api/view/session?t='),
                             ('GET', '/api/unified/media/a/b?t='), ('POST', '/api/unified/media/%24photo?t='),
                             ('POST', '/api/unified/people/p1/send?t=')):
            status = self.request(method, path + ticket, {} if method == 'POST' else None, CROSS)[0]
            self.assertIn(status, (401, 403, 404), method + ' ' + path)
        unified.dispatch.assert_not_called()

    def test_a_real_other_site_is_refused_even_with_the_ticket(self):
        unified = self.unified()
        _, ticket = self.owner_ticket()
        self.assertEqual(self.request('GET', '/api/unified/media/%24photo?t=' + ticket, headers={**CROSS, 'Origin': 'https://evil.example'})[0], 403)
        unified.dispatch.assert_not_called()

    def test_ticket_dies_with_its_session(self):
        unified = self.unified()
        _, ticket = self.owner_ticket()
        with self.server.auth.lock:
            self.server.auth.sessions.clear()  # Lock on a trusted Wizard, or expiry
        self.assertEqual(self.request('GET', '/api/unified/media/%24photo?t=' + ticket, headers=CROSS)[0], 403)
        unified.dispatch.assert_not_called()

    def test_setup_only_sessions_get_no_ticket(self):
        token, session = self.server.auth.create(owner_setup=True)
        self.assertIsNone(self.server.auth.media_ticket(session))
        session['media'] = 'y' * 43  # even a stray value never opens media for a setup-only session
        self.assertIsNone(self.server.auth.media_session('y' * 43))


if __name__ == '__main__':
    unittest.main()
