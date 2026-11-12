"""Normal owner-app transport, NOT an isolation boundary or public forwarding API.

Parent must authorize the actor before invoking inbox methods. Do not inject this
in secure/external-sender mode. Endpoints are fixed at construction, never taken
from an HTTP request, and redirects are refused (including credential redirects).
"""
import hashlib
import hmac
import json
import re
import socket

# Fixed messages keyed by pinned bridge contracts. Instagram unknown errors use
# a bounded, redacted owner-only fallback below; never log raw bridge responses.
LOGIN_ERRORS = {
    'FI.MAU.BRIDGE.LOGIN_CANCELLED': ('login_cancelled', 'Login was cancelled. Start again when you are ready.', 409),
    'FI.MAU.BRIDGE.LOGIN_TIMED_OUT': ('login_expired', 'Login timed out. Start a new login.', 409),
    'M_NOT_FOUND': ('login_expired', 'This login is no longer available. Start a new login.', 409),
    'M_BAD_STATE': ('invalid_step', 'Login step changed. Start a new login.', 409),
    'FI.MAU.SLACK.RATE_LIMITED': ('login_rate_limited', 'Slack is rate limiting sign-in. Wait a few minutes before starting again.', 429),
    'FI.MAU.SLACK.BROWSER_REQUIRED': ('login_challenge_required', 'Slack requires browser verification which this view cannot safely complete. Finish verification in Slack, then start again.', 409),
    'FI.MAU.META_RATE_LIMITED': ('login_rate_limited', 'Instagram is limiting sign-in attempts. Wait a few minutes before starting again.', 429),
    'FI.MAU.META_ACCOUNT_SUSPENDED': ('login_account_restricted', 'Instagram reports an account suspension. Review it in Instagram before retrying.', 409),
    'FI.MAU.META_ACCOUNT_PENDING_DELETION': ('login_account_restricted', 'Instagram reports this account is scheduled for deletion. Review it in Instagram before retrying.', 409),
    'FI.MAU.META_INBOX_LOAD_FAILED': ('login_inbox_failed', 'Instagram could not load the inbox after login. Check the official app and try again later.', 502),
    'FI.MAU.META_MISSING_COOKIES': ('login_missing_cookies', 'The copied browser request is missing Instagram sign-in cookies. Open your Instagram inbox, reload with Network open, then copy the inbox request again.', 409),
    'FI.MAU.META_TOKEN_ERROR': ('login_session_rejected', 'Instagram ended this browser session immediately. Sign in again in your browser and copy a fresh inbox request.', 409),
    'FI.MAU.META_AFAD_STOPPED': ('login_approval_rejected', 'The Instagram approval request expired or was declined. Start again and approve the new request in Instagram.', 409),
    'FI.MAU.META_NO_SMS_AVAILABLE': ('login_sms_unavailable', 'Instagram will not send a text message code right now. Choose another verification method, or try browser sign-in.', 409),
    'FI.MAU.META_TOKEN_EXCHANGE_FAILED': ('login_session_failed', 'Instagram did not provide a usable sign-in session. Try the recommended browser sign-in.', 409),
    'FI.MAU.META_CAA_FAILED': ('login_password_failed', 'Instagram could not complete username and password sign-in. Try the recommended browser sign-in instead.', 409),
    'FI.MAU.META_CAA_CLIENT_HTTP_FAILED': ('login_request_failed', 'The Instagram verification request could not complete on this device. Try browser sign-in, or start again.', 409),
    'FI.MAU.IG_MISSING_AUTH': ('login_session_failed', 'Instagram accepted a sign-in step but did not provide a messaging session. Try the recommended browser sign-in.', 409),
    'FI.MAU.META_WEB_CHECKPOINT_FAILED': ('login_verification_failed', 'Instagram verification did not complete. Start again when your connection is stable.', 502),
    'FI.MAU.SLACK.CAPTCHA_REJECTED': ('login_challenge_required', 'Slack requires a new interactive CAPTCHA. This view cannot safely complete it.', 409),
    'DEV.HIGHEST.LINE.TOO_MANY_ATTEMPTS': ('login_rate_limited', 'LINE is limiting sign-in attempts. Wait before starting again.', 429),
    'DEV.HIGHEST.LINE.LOGIN_REJECTED': ('login_rejected', 'LINE rejected this login. Review the request in LINE before starting again.', 409),
    'DEV.HIGHEST.LINE.VERIFICATION_FAILED': ('login_verification_failed', 'LINE verification did not complete. Start a new login and approve it on your phone.', 409),
    'DEV.HIGHEST.LINE.NO_KEYCHAIN': ('login_keys_unavailable', 'LINE did not provide the encryption keys required by this bridge. Review linked devices in LINE before trying again.', 409),
}
# Distinguish the actions an owner must take instead of calling every rejection
# "verification". These are terminal bridge errors, not resumable LoginSteps.
for _code, _message in {
    'FI.MAU.META_CHALLENGE_ERROR': 'Instagram needs a security check. Complete it on instagram.com, then use browser sign-in.',
    'FI.MAU.META_CHECKPOINT_ERROR': 'Instagram stopped this sign-in at a security checkpoint. Complete it on instagram.com, then use browser sign-in.',
    'FI.MAU.META_CONSENT_ERROR': 'Instagram needs you to accept an account notice. Open Instagram, review it, then use browser sign-in.',
    'FI.MAU.META_ACCOUNT_RECOVERY_REQUIRED': 'Instagram requires account recovery, not a verification code. Finish recovery in the official app or website before trying again.',
    'FI.MAU.META_WEB_CHECKPOINT_CAPTCHA': 'Instagram requires an interactive CAPTCHA. Use browser sign-in and finish the check on instagram.com.',
    'FI.MAU.META_PASSKEY_MANDATORY': 'Instagram requires a passkey. Use browser sign-in to complete it on instagram.com.',
    'FI.MAU.META_GOOGLE_RECAPTCHA': 'Instagram requires reCAPTCHA. Use browser sign-in and finish it on instagram.com.',
    'FI.MAU.META_OAUTH_MANDATORY': 'Instagram requires Google sign-in. Use browser sign-in instead.',
    'FI.MAU.META_NO_SUPPORTED_MFA': 'Instagram offered no verification method this password flow supports. Use browser sign-in instead.',
    'FI.MAU.META_UNSUPPORTED_CAA_STEP': 'Instagram returned a password sign-in step this bridge cannot safely complete. Use browser sign-in instead.',
    'FI.MAU.META_UNSUPPORTED_WEB_CHECKPOINT': 'Instagram returned a security check this bridge cannot safely complete. Finish it on instagram.com, then use browser sign-in.',
    'FI.MAU.IG_CAA_FALLBACK_DISABLED': 'Instagram returned an unexpected verification step. Complete verification on instagram.com, then use browser sign-in.',
}.items():
    LOGIN_ERRORS[_code] = ('login_challenge_required', _message, 409)
from types import MappingProxyType
from urllib.parse import parse_qs, urlsplit, quote, quote_plus
import html
import unicodedata
import hashlib
import threading
import time
from urllib.request import Request, build_opener, HTTPRedirectHandler
from urllib.error import HTTPError, URLError
from unified import fail, http
from engine import EngineError
from connectors import PROVIDERS


def sanitized_login_error(value, body=None, token='', fingerprints=()):
    """Owner-only diagnostic, never a log payload; reject structured dumps.

    Strip submitted values (including URL/JSON/HTML encodings) before clipping,
    then remove URLs, contact identifiers, headers, cookie pairs and opaque IDs.
    No upstream HTML is interpreted by the view (it uses textContent).
    """
    if not isinstance(value, str) or not value.strip() or len(value) > 4096:
        return ''
    secrets = [token] if token else []
    def collect(obj):
        if isinstance(obj, dict):
            for v in obj.values(): collect(v)
        elif isinstance(obj, (list, tuple)):
            for v in obj: collect(v)
        elif isinstance(obj, str) and obj: secrets.append(obj)
    collect(body)
    text = unicodedata.normalize('NFKC', html.unescape(value))
    for secret in sorted({unicodedata.normalize('NFKC', html.unescape(s)) for s in secrets}, key=len, reverse=True):
        for v in {secret, quote(secret, safe=''), quote_plus(secret), json.dumps(secret)[1:-1]}:
            text = re.sub(re.escape(v), '[hidden]', text, flags=re.I)
    # Previous-step credentials are held only as hashes, never plaintext.
    # Scan before clipping so a prior password echoed at a later code/approval
    # step cannot reappear in an owner-facing diagnostic.
    hidden = set()
    for size, digest in fingerprints:
        for start in range(max(0, len(text) - size + 1)):
            if hashlib.sha256(text[start:start + size].casefold().encode()).digest() == digest:
                hidden.update(range(start, start + size))
    if hidden:
        text = ''.join('[hidden]' if i in hidden and (i == 0 or i - 1 not in hidden) else '' if i in hidden else c for i, c in enumerate(text))
    # Credential headers/assignments can include values from an earlier step.
    text = re.sub(r'(?i)\b(?:authorization|cookie|set-cookie)\s*:[^\r\n]*', '[hidden]', text)
    text = re.sub(r'(?i)\b(?:password|passwd|sessionid|csrftoken|access_token|token|verification_code|username)\s*[=:]\s*[^\s,;]+', '[hidden]', text)
    text = re.sub(r'(?i)(?:https?://|www\.)[^\s<>]+', '[link removed]', text)
    text = re.sub(r'\b[^\s@]+@[^\s@]+\.[^\s@]+', '[hidden]', text)
    text = re.sub(r'\b[\w.+%-]+=[^\s,;]+', '[hidden]', text)
    text = re.sub(r'\b[\w/+=.-]{24,}\b|\b[0-9]{4,}\b', '[hidden]', text)
    text = ''.join(c for c in text if not unicodedata.category(c).startswith('C'))
    text = re.sub(r'<[^>]*>', '', text)
    text = ' '.join(text.split())
    # JSON/stack dumps are not useful owner-facing explanations.
    if any(c in text for c in '{}') or 'Traceback' in text:
        return ''
    return text[:300]


class NoRedirect(HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, msg, headers, newurl):
        return None


class LocalOwnerSender:
    """Narrow callback; not a general proxy. Bases are deployment constants."""
    def __init__(self, matrix='http://matrix:8008', *, bases=None):
        targets = {n: 'http://%s:%s' % (n, p.port) for n, p in PROVIDERS.items() if p.supported}
        targets['matrix'] = matrix
        if bases:
            if not set(bases) <= set(targets):
                raise ValueError('Unknown provider base')
            targets.update(bases)
        for value in targets.values():
            u = urlsplit(value)
            if u.scheme not in ('http', 'https') or not u.hostname or u.username or u.password or u.path or u.query or u.fragment:
                raise ValueError('A base must be an operator-pinned origin')
        self.bases = MappingProxyType(targets)
        self.opener = build_opener(NoRedirect())
        self._login_redactions = {}
        self._redaction_lock = threading.Lock()

    def __call__(self, *, network, base, path, method, body, token='', timeout=15, content_type=None):
        if base != self.bases.get(network) or method not in ('POST', 'PUT'):
            fail('sender_route_denied', 'Unapproved owner transport destination', 403)
        u = urlsplit(path)
        if u.scheme or u.netloc or u.fragment or not path.startswith('/') or '..' in path or re.search(r'%2f|%5c|%2e', path, re.I):
            # Matrix identifiers legitimately contain encoded slashes; fail closed
            # rather than let an identifier turn into a route segment.
            fail('sender_route_denied', 'Invalid owner transport route', 403)
        q = parse_qs(u.query, keep_blank_values=True)
        if network == 'matrix':
            route = u.path.removeprefix('/_matrix/client/v3')
            allowed = (
                method == 'PUT' and re.fullmatch(r'/rooms/[^/]+/(?:send/(?:m\.room\.message|m\.sticker|m\.reaction)/[^/]+|redact/[^/]+/[^/]+|typing/%40owner%3Amessenger\.internal)', route)
                or method == 'POST' and re.fullmatch(r'/(?:join/[^/]+|rooms/[^/]+/receipt/m\.read/[^/]+)', route)
                or method == 'POST' and u.path in ('/_synapse/admin/v1/register', '/_matrix/client/v3/login')
                or method == 'POST' and u.path == '/_matrix/media/v3/upload' and set(q) == {'filename'} and q['filename'] in (['photo.jpg'], ['photo.png'], ['photo.gif'], ['photo.webp'], ['voice-message.ogg'], ['voice-message.webm'], ['voice-message.m4a'], ['attachment'])
            )
            if u.path == '/_synapse/admin/v1/register' and (not isinstance(body, dict) or body.get('username') != 'owner' or body.get('admin') is not False):
                allowed = False
            if u.path == '/_matrix/client/v3/login' and (not isinstance(body, dict) or body.get('type') != 'm.login.password' or body.get('identifier') != {'type': 'm.id.user', 'user': '@owner:messenger.internal'}):
                allowed = False
            if u.path != '/_matrix/media/v3/upload' and q:
                allowed = False
            if not u.path.startswith('/_matrix/client/v3/') and u.path not in ('/_synapse/admin/v1/register', '/_matrix/media/v3/upload'):
                allowed = False
        else:
            route = u.path.removeprefix('/_matrix/provision/v3')
            allowed = method == 'POST' and u.path.startswith('/_matrix/provision/v3/') and (
                re.fullmatch(r'/login/(?:start/[A-Za-z0-9_.-]+|step/[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+/(?:user_input|display_and_wait|cookies)|cancel/[A-Za-z0-9_.-]+)', route)
                or route == '/logout/all'
                # Issue 176: open an empty chat with a new contact / look a LINE ID up. Neither sends anything.
                or re.fullmatch(r'/create_dm/[^/]+', route) or route == '/search_users')
            allowed = allowed and set(q) <= {'user_id', 'txn_id'} and q.get('user_id') == ['@owner:messenger.internal']
        if not allowed:
            fail('sender_route_denied', 'Unapproved owner transport operation', 403)
        headers = {'Accept': 'application/json'}
        if token:
            headers['Authorization'] = 'Bearer ' + token
        if isinstance(body, bytes):
            # Any-file MIME is allowed only with the fixed neutral name (James, 26 Oct 2026).
            mime_ok = content_type in ('image/jpeg', 'image/png', 'image/gif', 'image/webp', 'audio/ogg', 'audio/webm', 'audio/mp4')
            if q.get('filename') == ['attachment']:
                mime_ok = isinstance(content_type, str) and re.fullmatch(r'[a-z]+/[a-z0-9.+-]{1,80}', content_type)
            if u.path != '/_matrix/media/v3/upload' or not isinstance(content_type, str) or not mime_ok:
                fail('sender_route_denied', 'Unapproved upload', 403)
            encoded = body
            headers['Content-Type'] = content_type
        else:
            if u.path == '/_matrix/media/v3/upload' and q.get('filename') == ['attachment']:
                fail('sender_route_denied', 'Unapproved upload', 403)
            encoded = json.dumps(body).encode()
            headers['Content-Type'] = 'application/json'
        login_route = network != 'matrix' and route.startswith('/login/')
        fingerprints = ()
        redaction_key = None
        if network == 'instagram' and login_route:
            match = re.match(r'/login/(?:step|cancel)/([^/]+)', route)
            if match:
                redaction_key = match[1]
                with self._redaction_lock:
                    now = time.monotonic()
                    self._login_redactions = {k: v for k, v in self._login_redactions.items() if now - v[0] < 1200}
                    prior = self._login_redactions.get(redaction_key, (now, set()))[1]
                    if isinstance(body, dict):
                        for secret in body.values():
                            if isinstance(secret, str) and secret:
                                value = unicodedata.normalize('NFKC', html.unescape(secret)).casefold()
                                # Include the same encodings removed from current submissions.
                                for variant in {value, quote(value, safe=''), quote_plus(value), json.dumps(value)[1:-1]}:
                                    prior.add((len(variant), hashlib.sha256(variant.encode()).digest()))
                    fingerprints = tuple(prior)
                    self._login_redactions[redaction_key] = (now, prior)
                    if len(prior) > 512 or len(self._login_redactions) > 64 or route.startswith('/login/cancel/'):
                        self._login_redactions.pop(redaction_key, None)
        # Only step workers use the long bound; other owner writes retain 65s.
        limit = 620 if login_route and route.startswith('/login/step/') else 65
        try:
            with self.opener.open(Request(base + path, data=encoded, headers=headers, method=method), timeout=min(timeout, limit)) as response:
                result = json.loads(response.read(8 * 1024 * 1024))
                if redaction_key and isinstance(result, dict) and result.get('type') == 'complete':
                    with self._redaction_lock:
                        self._login_redactions.pop(redaction_key, None)
                return result
        except HTTPError as error:
            status = error.code
            code = None
            data = {}
            try:
                if login_route:
                    data = json.loads(error.read(16384))
                    code = data.get('errcode') if isinstance(data, dict) else None
            except (ValueError, OSError):
                pass
            finally:
                error.close()
            if login_route:
                mapped = LOGIN_ERRORS.get(code) if isinstance(code, str) else None
                if mapped:
                    fail(*mapped)
                if status == 429:
                    fail('login_rate_limited', 'Sign-in is rate limited. Wait before trying again.', 429)
                if network == 'instagram':
                    reason = sanitized_login_error(data.get('error') if isinstance(data, dict) else None, body, token, fingerprints)
                    if reason:
                        fail('login_failed', 'Instagram sign-in: ' + reason + ' Try browser sign-in if this keeps happening.', 409)
                if network == 'instagram' and status in (400, 401, 403):
                    # No usable reason from Instagram: name the bridge's own error code (a fixed-format id, never
                    # provider text) and point at the route that works.
                    tag = code if isinstance(code, str) and re.fullmatch(r'[A-Z0-9_.]{1,64}', code) else 'no reason given'
                    fail('login_failed', 'Instagram turned this sign-in down without saying why (' + tag + '). Use Sign in with browser (recommended) instead.', 409)
                if status in (400, 401, 403):
                    fail('login_failed', 'Bridge sign-in could not complete. Review verification in the provider app, then start again.', 409)
            fail('owner_transport_failed', 'Private owner transport failed', 502)
        except (TimeoutError, socket.timeout):
            fail('login_transport_timeout' if login_route else 'owner_transport_failed',
                 'The private bridge did not answer in time. This is not proof of an expired code or rejected credentials. Start again.' if login_route else 'Private owner transport failed', 504)
        except URLError as error:
            if login_route and isinstance(error.reason, TimeoutError):
                fail('login_transport_timeout', 'The private bridge did not answer in time. This is not proof of an expired code or rejected credentials. Start again.', 504)
            fail('owner_transport_failed', 'Private owner transport failed', 502)
        except (ValueError, OSError):
            # No raw upstream response, URL, submitted secret or QR in diagnostics.
            fail('owner_transport_failed', 'Private owner transport failed', 502)

    def bootstrap(self, inbox):
        """Local normal mode only: register or log in to the fixed private owner."""
        with inbox.lock:
            if inbox.store.get('matrix_token'):
                return inbox.store.get('matrix_token')
            keys = inbox.keys()
            nonce = http(self.bases['matrix'], '/_synapse/admin/v1/register')['nonce']
            mac = hmac.new(keys['registration'].encode(), '\0'.join([nonce, 'owner', keys['owner_password'], 'notadmin']).encode(), hashlib.sha1).hexdigest()
            try:
                result = self(network='matrix', base=inbox.matrix, path='/_synapse/admin/v1/register', method='POST', body={'nonce': nonce, 'username': 'owner', 'password': keys['owner_password'], 'admin': False, 'mac': mac})
            except EngineError:
                result = self(network='matrix', base=inbox.matrix, path='/_matrix/client/v3/login', method='POST', body={'type': 'm.login.password', 'identifier': {'type': 'm.id.user', 'user': inbox.owner}, 'password': keys['owner_password']})
            inbox.store.put('matrix_token', result['access_token'])
            return result['access_token']
