"""Messenger's link to the Contacts app, made by the box (wizard-os issue 133, the browser boundary).

The view reads names from Contacts and saves people to it (Add to Contacts, My card). In a window the Wizard
sandboxes, the view's own fetch to /contacts/ leaves with Origin: null and the browser blocks the answer, so in that
window the view asks Messenger here instead and Messenger calls Contacts itself.

Messenger declares `uses: [contacts]` in wizard.md. Once that connection is granted, the App Manager writes where
Contacts answers and Messenger's key for it into WIZARD_GRANTS_FILE (wizard-os spec/PERMISSIONS.md):
`provider_endpoints["slot:contacts" | "contacts"]` and `outgoing[...]`, sent as `X-Wizard-Grant`. No grant, no
endpoint: Contacts is reported unavailable, the same as a box without Contacts. Only these three calls go through,
for the owner's own browser session (web.py), never for an agent key.
"""
import json
import os
import urllib.error
import urllib.request
from urllib.parse import urlsplit

from engine import EngineError

GRANT_KEYS = ('slot:contacts', 'contacts')
# (method, sub-path under /api/view/contacts/) -> Contacts route. Nothing else is forwarded.
ROUTES = {
    ('GET', 'contacts'): '/api/contacts',
    ('POST', 'save'): '/api/save',
    ('POST', 'me/connected'): '/api/me/connected',
}
GRANTS_MAX = 256 * 1024
ANSWER_MAX = 8 * 1024 * 1024
TIMEOUT = 10


class _NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, *args, **kwargs):
        return None


_OPENER = urllib.request.build_opener(_NoRedirect)


def _endpoint(value):
    if not isinstance(value, str) or not value or len(value) > 512 or any(c.isspace() for c in value):
        return None
    try:
        u = urlsplit(value)
    except ValueError:
        return None
    if u.scheme not in ('http', 'https') or not u.hostname or u.username or u.password or u.query or u.fragment:
        return None
    return value.rstrip('/')


class ContactsLink:
    def __init__(self, path=None):
        self.path = os.environ.get('WIZARD_GRANTS_FILE', '') if path is None else path

    def target(self):
        """(base URL, grant key) of the granted Contacts, or None."""
        if not self.path:
            return None
        try:
            with open(self.path, 'rb') as f:
                raw = f.read(GRANTS_MAX + 1)
            doc = json.loads(raw) if len(raw) <= GRANTS_MAX else None
        except (OSError, ValueError):
            return None
        if not isinstance(doc, dict):
            return None
        endpoints = doc.get('provider_endpoints') if isinstance(doc.get('provider_endpoints'), dict) else {}
        keys = doc.get('outgoing') if isinstance(doc.get('outgoing'), dict) else {}
        for name in GRANT_KEYS:
            base = _endpoint(endpoints.get(name))
            if base:
                key = keys.get(name)
                return base, key if isinstance(key, str) and key.isascii() and key.isprintable() and len(key) <= 256 else ''
        return None

    def call(self, method, sub, body=None):
        route = ROUTES.get((method, sub))
        if route is None:
            raise EngineError('not_found', 'No such Contacts route', 404)
        target = self.target()
        if target is None:
            raise EngineError('contacts_unavailable', 'Contacts is not connected to Messenger', 404)
        base, key = target
        headers = {'Accept': 'application/json'}
        data = None
        if method == 'POST':
            data = json.dumps(body if isinstance(body, dict) else {}).encode()
            headers['Content-Type'] = 'application/json'
        if key:
            headers['X-Wizard-Grant'] = key
        request = urllib.request.Request(base + route, data=data, method=method, headers=headers)
        try:
            with _OPENER.open(request, timeout=TIMEOUT) as response:
                raw = response.read(ANSWER_MAX + 1)
        except urllib.error.HTTPError as e:
            message = 'Contacts could not do that'
            try:
                detail = json.loads(e.read(64 * 1024) or b'{}')
                if isinstance(detail, dict) and isinstance(detail.get('error'), str):
                    message = detail['error'][:300]
            except (OSError, ValueError):
                pass
            status = e.code if 400 <= e.code < 500 and e.code not in (401, 407) else 502
            raise EngineError('contacts_refused', message, status) from None
        except (urllib.error.URLError, OSError, ValueError):
            raise EngineError('contacts_unavailable', 'Contacts did not answer', 503) from None
        if len(raw) > ANSWER_MAX:
            raise EngineError('contacts_unavailable', 'Contacts answered too much', 502)
        try:
            answer = json.loads(raw)
        except ValueError:
            raise EngineError('contacts_unavailable', 'Contacts answered something Messenger could not read', 502) from None
        if not isinstance(answer, dict):
            raise EngineError('contacts_unavailable', 'Contacts answered something Messenger could not read', 502)
        return answer
