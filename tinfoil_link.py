"""Messenger's link to the Wizard Tinfoil app on this box (issue 251).

Translate, auto-translate, the send preview, Catch me up and transcript formatting fall back to Tinfoil when the
browser can't do the work itself. Before this link they only worked when someone pasted a TINFOIL_API_KEY into
Messenger's install form, so a box with the Tinfoil app connected still said "Tinfoil not configured".

The link works the way Search's AI overviews do: the owner's own Messenger page asks the Tinfoil app (same origin,
`POST /wizard-tinfoil/api/app-tokens`) for a Messenger-only box token and hands it to Messenger, which keeps it here
(0600). Messenger then calls Tinfoil's box-only gateway (`http://wizard-tinfoil:18804/v1`). The Tinfoil API key never
leaves the Tinfoil app, and Remove on the Tinfoil page revokes the token at once (a 401 drops the link here).

An install-form TINFOIL_API_KEY still wins: the translation worker uses it first, and only its "not configured" answer
sends a call through this link.
"""
import json
import os
import threading
import time
from pathlib import Path
from urllib.error import HTTPError
from urllib.request import HTTPRedirectHandler, ProxyHandler, Request, build_opener

TINFOIL_APP = os.environ.get('MESSENGER_TINFOIL_APP', 'http://wizard-tinfoil:18804').rstrip('/')
LINK_FILE = 'tinfoil-link.json'
TIMEOUT_CHECK = 8
ANSWER_MAX = 4 * 1024 * 1024
# Shown when neither the install key nor the Tinfoil app can answer. The view adds an Open Tinfoil link to it.
NOT_CONNECTED = 'Tinfoil isn’t connected yet. Connect it in the Tinfoil app, then try again. You can send the original instead.'


class NotLinked(Exception):
    """No usable link to the Tinfoil app (never made, or removed on the Tinfoil page)."""


# Box peers only: never through an HTTP(S)_PROXY the container may carry, and never follow a redirect.
class _NoRedirect(HTTPRedirectHandler):
    def redirect_request(self, *args, **kwargs):
        return None


_OPENER = build_opener(ProxyHandler({}), _NoRedirect)


def pick(models, *want):
    """The first wanted model the linked Tinfoil app offers, else its first model, else the first wanted."""
    for m in want:
        if m and m in models:
            return m
    return models[0] if models else next((m for m in want if m), '')


class TinfoilLink:
    def __init__(self, root, app=None, opener=None):
        self.path = Path(root) / LINK_FILE
        self.app = (app or TINFOIL_APP).rstrip('/')
        self.opener = opener or _OPENER
        self.lock = threading.Lock()

    # ---------- stored link ----------
    def _read(self):
        try:
            data = json.loads(self.path.read_text())
            return data if isinstance(data, dict) else {}
        except (OSError, ValueError):
            return {}

    def _write(self, data):
        self.path.parent.mkdir(parents=True, exist_ok=True)
        tmp = self.path.with_name(LINK_FILE + '.tmp')
        fd = os.open(tmp, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
        with os.fdopen(fd, 'w') as f:
            json.dump(data, f)
        os.replace(tmp, self.path)

    def state(self):
        """What the owner's view needs: linked, or removed on the Tinfoil page (then the view waits for a tap)."""
        d = self._read()
        return {'linked': bool(d.get('token')), 'removed': bool(d.get('removedAt')) and not d.get('token')}

    def link(self, token, models=None, recommended=None):
        """Check the token Tinfoil just issued by listing models through it, then keep it."""
        if not isinstance(token, str) or not 20 <= len(token) <= 200 or not token.isascii() or any(c.isspace() for c in token):
            raise ValueError('bad token')
        live = self._models(token)
        clean = lambda xs: [m for m in (xs if isinstance(xs, list) else []) if isinstance(m, str) and m in live][:40]
        with self.lock:
            self._write({'provider': 'tinfoil', 'token': token, 'models': clean(models) or live[:40],
                         'recommended': clean(recommended), 'linkedAt': time.strftime('%Y-%m-%dT%H:%M:%SZ', time.gmtime())})
        return self.state()

    def drop(self):
        """Tinfoil said the token is gone (Remove on its page): forget it, and remember that it was removed."""
        with self.lock:
            if self._read().get('token'):
                self._write({'provider': 'tinfoil', 'removedAt': time.strftime('%Y-%m-%dT%H:%M:%SZ', time.gmtime())})

    # ---------- calls ----------
    def _send(self, req, timeout):
        with self.opener.open(req, timeout=timeout) as r:  # nosec B310 box-only peer, fixed base
            body = r.read(ANSWER_MAX + 1)
        if len(body) > ANSWER_MAX:
            raise ValueError('answer too large')
        return json.loads(body)

    def _models(self, token):
        req = Request(self.app + '/v1/models', headers={'Authorization': 'Bearer ' + token, 'Accept': 'application/json'})
        data = self._send(req, TIMEOUT_CHECK)
        return [m.get('id') for m in data.get('data') or [] if isinstance(m, dict) and isinstance(m.get('id'), str)]

    def chat(self, payload, timeout, *want):
        """One chat completion through the Tinfoil app. `want` are preferred models; the link's own list decides.
        Returns the answer text. Raises NotLinked without a usable link, anything else on failure."""
        d = self._read()
        token = d.get('token')
        if not token:
            raise NotLinked()
        models = d.get('models') or []
        body = dict(payload, model=pick(models, payload.get('model'), *want, *(d.get('recommended') or [])), stream=False)
        req = Request(self.app + '/v1/chat/completions', data=json.dumps(body).encode(), method='POST',
                      headers={'Authorization': 'Bearer ' + token, 'Content-Type': 'application/json', 'Accept': 'application/json'})
        try:
            answer = self._send(req, timeout)
        except HTTPError as e:
            if e.code == 401:
                self.drop()
                raise NotLinked() from None
            raise
        text = answer['choices'][0]['message']['content']
        if not isinstance(text, str) or not text.strip():
            raise ValueError('empty answer')
        return text
