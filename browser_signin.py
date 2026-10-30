"""Sign in to a network inside the shared Wizard Browser, like Beeper's built-in browser.

The owner drives a private, throw-away browser context (its own cookies, never the agent's sessions)
through a live picture of the page in Messenger. When the page holds the login, the values the bridge
needs are read over the browser's DevTools connection, handed to the bridge's own login step, and the
context is destroyed. Nothing is written to disk and nothing is logged.

Only the owner's authenticated view reaches this (no agent capability maps to these routes).
Requires the app manifest's `uses: [browser]` (Docker network to http://browser:9222).
"""
import base64
import json
import re
import os
import secrets
import socket
import struct
import threading
import time
from urllib.parse import unquote, urlsplit
from urllib.request import urlopen

from engine import EngineError

BROWSER = os.environ.get('MESSENGER_BROWSER_DEVTOOLS', 'http://browser:9222')
IDLE_SECONDS = 15 * 60


def fail(code, message, status=400):
    raise EngineError(code, message, status)


class CDP:
    """Minimal DevTools client over one websocket (stdlib only): calls by id, events to a callback."""

    def __init__(self, ws_url, on_event):
        u = urlsplit(ws_url)
        self.sock = socket.create_connection((u.hostname, u.port or 80), timeout=10)
        key = base64.b64encode(secrets.token_bytes(16)).decode()
        req = ('GET %s HTTP/1.1\r\nHost: %s:%d\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n'
               'Sec-WebSocket-Key: %s\r\nSec-WebSocket-Version: 13\r\n\r\n') % (u.path or '/', u.hostname, u.port or 80, key)
        self.sock.sendall(req.encode())
        head = b''
        while b'\r\n\r\n' not in head:
            chunk = self.sock.recv(4096)
            if not chunk:
                raise OSError('handshake closed')
            head += chunk
        if b' 101 ' not in head.split(b'\r\n', 1)[0]:
            raise OSError('handshake refused')
        self.buf = head.split(b'\r\n\r\n', 1)[1]
        self.sock.settimeout(None)
        self.on_event, self.lock, self.next_id = on_event, threading.Lock(), 0
        self.waiting, self.closed = {}, False
        threading.Thread(target=self._reader, daemon=True, name='cdp').start()

    def _recv(self, n):
        while len(self.buf) < n:
            chunk = self.sock.recv(1 << 20)
            if not chunk:
                raise OSError('closed')
            self.buf += chunk
        out, self.buf = self.buf[:n], self.buf[n:]
        return out

    def _frame(self):
        b1, b2 = self._recv(2)
        n = b2 & 0x7f
        if n == 126:
            n = struct.unpack('>H', self._recv(2))[0]
        elif n == 127:
            n = struct.unpack('>Q', self._recv(8))[0]
        mask = self._recv(4) if b2 & 0x80 else None
        data = self._recv(n)
        if mask:
            data = bytes(c ^ mask[i % 4] for i, c in enumerate(data))
        return b1 & 0x0f, b1 & 0x80, data

    def _reader(self):
        parts = b''
        try:
            while True:
                op, fin, data = self._frame()
                if op == 8:
                    break
                if op in (0, 1, 2):
                    parts += data
                    if not fin:
                        continue
                    msg, parts = json.loads(parts), b''
                    if 'id' in msg and msg['id'] in self.waiting:
                        box = self.waiting.pop(msg['id'])
                        box['msg'] = msg
                        box['ev'].set()
                    elif 'method' in msg:
                        try:
                            self.on_event(msg)
                        except Exception:
                            pass
        except Exception:
            pass
        self.closed = True
        for box in list(self.waiting.values()):
            box['ev'].set()

    def send(self, method, params=None, session=None, timeout=15):
        if self.closed:
            raise OSError('browser connection closed')
        with self.lock:
            self.next_id += 1
            i = self.next_id
            box = {'ev': threading.Event()}
            self.waiting[i] = box
            msg = {'id': i, 'method': method, 'params': params or {}}
            if session:
                msg['sessionId'] = session
            payload = json.dumps(msg).encode()
            head = bytes([0x81])
            n = len(payload)
            head += bytes([0x80 | n]) if n < 126 else (bytes([0x80 | 126]) + struct.pack('>H', n) if n < 65536 else bytes([0x80 | 127]) + struct.pack('>Q', n))
            mask = secrets.token_bytes(4)
            self.sock.sendall(head + mask + bytes(c ^ mask[k % 4] for k, c in enumerate(payload)))
        if not box['ev'].wait(timeout) or 'msg' not in box:
            self.waiting.pop(i, None)
            raise OSError('browser did not answer')
        if 'error' in box['msg']:
            raise OSError(box['msg']['error'].get('message', 'browser error'))
        return box['msg'].get('result', {})

    def close(self):
        self.closed = True
        try:
            self.sock.close()
        except OSError:
            pass


# Per network: where to sign in and how to read the finished login out of the page.
SLACK_TEAMS_JS = r'''(() => { try {
  if (location.hostname !== 'app.slack.com') return null;
  const c = JSON.parse(localStorage.getItem('localConfig_v2') || 'null'); if (!c || !c.teams) return null;
  return JSON.stringify(Object.values(c.teams).filter(t => typeof t.token === 'string' && t.token.startsWith('xoxc-'))
    .map(t => ({id: t.id, name: t.name || t.domain || t.id, token: t.token})));
} catch (e) { return null; } })()'''

NETWORKS = {'slack': {'url': 'https://app.slack.com/signin', 'title': 'Slack'}}
# Every other network runs the bridge's own browser step (bridgev2 "cookies"), like Beeper's built-in browser.
GENERIC = {'twitter': ('cookies', 'X'), 'linkedin': ('cookies', 'LinkedIn'), 'facebook': ('facebook', 'Facebook'),
           'dots': ('cookies', 'ChatGPT'), 'gmessages': ('google', 'Google')}
# Slack's last page asks to open the desktop app; the browser client is where the login lives.
SLACK_APP_PROMPT = re.compile(r'^https://[a-z0-9-]+\.slack\.com/(?:ssb/redirect|checkcookie|signin/confirmed|workspace-signin.*redir)', re.I)


class Session:
    def __init__(self, network, width, height, mobile, url=None, user_agent=None, step=None):
        self.id = secrets.token_urlsafe(18)
        self.network = network
        self.frame, self.frame_seq, self.cond = None, 0, threading.Condition()
        self.url, self.state, self.message, self.result = '', 'starting', '', None
        self.touched = time.time()
        self.width, self.height = width, height
        self.step, self.requests, self.ids, self.extracted, self.last_extract = step, [], {}, {}, 0.0
        # Chrome's DevTools only accepts an IP or localhost in the Host header: resolve the app name first.
        b = urlsplit(BROWSER)
        ip = socket.gethostbyname(b.hostname)
        base = 'http://%s:%d' % (ip, b.port or 80)
        version = json.load(urlopen(base + '/json/version', timeout=5))
        ws = 'ws://%s:%d%s' % (ip, b.port or 80, urlsplit(version['webSocketDebuggerUrl']).path)
        self.cdp = CDP(ws, self._event)
        self.context = self.cdp.send('Target.createBrowserContext', {'disposeOnDetach': True})['browserContextId']
        target = self.cdp.send('Target.createTarget', {'url': 'about:blank', 'browserContextId': self.context})['targetId']
        self.target = target
        self.session = self.cdp.send('Target.attachToTarget', {'targetId': target, 'flatten': True})['sessionId']
        s = self.session
        self.cdp.send('Page.enable', session=s)
        self.cdp.send('Network.enable', {}, session=s)
        if not user_agent:
            ua = self.cdp.send('Browser.getVersion').get('userAgent', '')
            user_agent = ua.replace('HeadlessChrome', 'Chrome') if ua else None
        if user_agent:
            self.cdp.send('Emulation.setUserAgentOverride', {'userAgent': user_agent}, session=s)
        self.cdp.send('Emulation.setDeviceMetricsOverride', {'width': width, 'height': height, 'deviceScaleFactor': 1, 'mobile': mobile}, session=s)
        if mobile:
            self.cdp.send('Emulation.setTouchEmulationEnabled', {'enabled': True, 'maxTouchPoints': 1}, session=s)
        self.cdp.send('Page.startScreencast', {'format': 'jpeg', 'quality': 62, 'maxWidth': width, 'maxHeight': height, 'everyNthFrame': 1}, session=s)
        self.cdp.send('Page.navigate', {'url': url or NETWORKS[network]['url']}, session=s)
        self.state = 'signing_in'

    def _event(self, msg):
        if msg.get('sessionId') != getattr(self, 'session', None):
            return
        if msg['method'] == 'Page.screencastFrame':
            p = msg['params']
            with self.cond:
                self.frame = p['data']
                self.frame_seq += 1
                self.cond.notify_all()
            threading.Thread(target=lambda: self._ack(p['sessionId']), daemon=True).start()
        elif msg['method'] == 'Page.frameNavigated' and not msg['params']['frame'].get('parentId'):
            self.url = msg['params']['frame'].get('url', '')
        elif msg['method'] == 'Network.requestWillBeSent':
            r = msg['params'].get('request') or {}
            self.ids[msg['params'].get('requestId')] = r.get('url', '')
            self._keep(r.get('url', ''), r.get('headers') or {}, r.get('postData') or '')
        elif msg['method'] == 'Network.requestWillBeSentExtraInfo':
            # The full headers (Cookie included) arrive here.
            self._keep(self.ids.get(msg['params'].get('requestId'), ''), msg['params'].get('headers') or {}, '')

    def _keep(self, url, headers, body):
        if not url.startswith('https://'):
            return
        self.requests.append((url, {str(k).lower(): str(v) for k, v in headers.items()}, body[:65536]))
        del self.requests[:-400]
        if len(self.ids) > 2000:
            self.ids.clear()

    def _ack(self, frame_session):
        try:
            self.cdp.send('Page.screencastFrameAck', {'sessionId': frame_session}, session=self.session, timeout=5)
        except OSError:
            pass

    def wait_frame(self, after, hold=8.0):
        self.touched = time.time()
        with self.cond:
            if self.frame_seq <= after and self.state == 'signing_in':
                self.cond.wait(hold)
            host = urlsplit(self.url).hostname or ''
            return {'seq': self.frame_seq, 'frame': self.frame if self.frame_seq > after else None, 'state': self.state,
                    'message': self.message, 'host': host, 'result': self.result}

    def input(self, payload):
        self.touched = time.time()
        s, kind = self.session, payload.get('type')
        x = max(0.0, min(1.0, float(payload.get('x', 0)))) * self.width
        y = max(0.0, min(1.0, float(payload.get('y', 0)))) * self.height
        if kind == 'tap':
            for t in ('mousePressed', 'mouseReleased'):
                self.cdp.send('Input.dispatchMouseEvent', {'type': t, 'x': x, 'y': y, 'button': 'left', 'clickCount': 1}, session=s)
        elif kind == 'scroll':
            dy = max(-3000, min(3000, float(payload.get('dy', 0))))
            self.cdp.send('Input.dispatchMouseEvent', {'type': 'mouseWheel', 'x': x, 'y': y, 'deltaX': 0, 'deltaY': dy}, session=s)
        elif kind == 'text':
            text = str(payload.get('text', ''))[:2000]
            if text:
                self.cdp.send('Input.insertText', {'text': text}, session=s)
        elif kind == 'key':
            key = payload.get('key')
            codes = {'Enter': 13, 'Backspace': 8, 'Tab': 9, 'Escape': 27, 'ArrowDown': 40, 'ArrowUp': 38}
            if key not in codes:
                fail('invalid_input', 'Unsupported key')
            for t in ('rawKeyDown', 'keyUp'):
                ev = {'type': t, 'key': key, 'code': key, 'windowsVirtualKeyCode': codes[key], 'nativeVirtualKeyCode': codes[key]}
                if key == 'Enter' and t == 'rawKeyDown':
                    self.cdp.send('Input.dispatchKeyEvent', dict(ev, type='keyDown', text='\r'), session=s)
                    continue
                self.cdp.send('Input.dispatchKeyEvent', ev, session=s)
        elif kind == 'back':
            self.cdp.send('Runtime.evaluate', {'expression': 'history.back()'}, session=s)
        else:
            fail('invalid_input', 'Unsupported input')
        return {'ok': True}

    def slack_login(self):
        """(teams, d cookie) once the page holds a signed-in Slack, else None."""
        r = self.cdp.send('Runtime.evaluate', {'expression': SLACK_TEAMS_JS, 'returnByValue': True}, session=self.session)
        raw = (r.get('result') or {}).get('value')
        if not raw:
            return None
        teams = json.loads(raw)
        cookies = self.cdp.send('Network.getCookies', {'urls': ['https://app.slack.com']}, session=self.session).get('cookies') or []
        # The browser keeps the d cookie percent-encoded (%2F, %3D); the bridge only accepts the decoded form.
        d = next((unquote(c['value']) for c in cookies if c.get('name') == 'd' and str(c.get('value', '')).startswith('xoxd-')), None)
        return (teams, d) if teams and d else None

    def bridge_fields(self):
        """Values for the bridge's cookies step, read the way Beeper's browser does, or None while incomplete."""
        params = (self.step or {}).get('cookies') or {}
        pattern = params.get('wait_for_url_pattern')
        if pattern:
            try:
                if not re.search(pattern, self.url or ''):
                    return None
            except re.error:
                pass
        s = self.session
        if params.get('extract_js') and time.time() - self.last_extract > 4:
            self.last_extract = time.time()
            try:
                r = self.cdp.send('Runtime.evaluate', {'expression': params['extract_js'], 'awaitPromise': True, 'returnByValue': True}, session=s, timeout=30)
                value = (r.get('result') or {}).get('value')
                if isinstance(value, str):
                    try:
                        value = json.loads(value)
                    except ValueError:
                        value = None
                if isinstance(value, dict):
                    self.extracted.update({str(k): v if isinstance(v, str) else json.dumps(v) for k, v in value.items() if v is not None})
            except OSError:
                pass
        host = urlsplit(params.get('url') or self.url or '').hostname or ''
        jar = {}

        def cookies(domain):
            if domain not in jar:
                d = (domain or host).lstrip('.')
                urls = ['https://' + d, 'https://www.' + d] if d.count('.') == 1 else ['https://' + d]
                try:
                    jar[domain] = self.cdp.send('Network.getCookies', {'urls': urls}, session=s).get('cookies') or []
                except OSError:
                    jar[domain] = []
            return jar[domain]

        out = {}
        for field in params.get('fields') or []:
            fid, pat = field.get('id'), field.get('pattern')
            found = None
            for src in field.get('sources') or []:
                kind, name = src.get('type'), src.get('name') or ''
                candidates = []
                if kind == 'cookie':
                    candidates = [c.get('value', '') for c in cookies(src.get('cookie_domain')) if c.get('name') == name]
                elif kind == 'local_storage':
                    try:
                        r = self.cdp.send('Runtime.evaluate', {'expression': 'localStorage.getItem(%s)' % json.dumps(name), 'returnByValue': True}, session=s)
                        v = (r.get('result') or {}).get('value')
                        candidates = [v] if isinstance(v, str) else []
                    except OSError:
                        candidates = []
                elif kind in ('request_header', 'request_body'):
                    try:
                        rx = re.compile(src.get('request_url_regex') or '.')
                    except re.error:
                        rx = re.compile('.')
                    for url, headers, body in reversed(self.requests):
                        if not rx.search(url):
                            continue
                        if kind == 'request_header' and name.lower() in headers:
                            candidates.append(headers[name.lower()])
                        elif kind == 'request_body' and body:
                            m = re.search(r'(?:^|[&\s"])' + re.escape(name) + r'(?:=|"\s*:\s*")([^&"\s]+)', body)
                            if m:
                                candidates.append(unquote(m.group(1)))
                elif kind == 'special':
                    v = self.extracted.get(name)
                    candidates = [v] if v else []
                for v in candidates:
                    for value in (v, unquote(v)):
                        try:
                            ok = not pat or re.search(pat, value)
                        except re.error:
                            ok = True
                        if value and ok:
                            found = value
                            break
                    if found:
                        break
                if found:
                    break
            if found:
                out[fid] = found
            elif field.get('required', True):
                return None
        return out

    def close(self):
        self.state = 'closed' if self.state == 'signing_in' else self.state
        try:
            self.cdp.send('Target.disposeBrowserContext', {'browserContextId': self.context}, timeout=5)
        except Exception:
            pass
        self.cdp.close()
        with self.cond:
            self.cond.notify_all()


class BrowserSignIn:
    """Owner-only: one live sign-in per network at a time."""

    def __init__(self, connectors):
        self.connectors = connectors
        self.sessions, self.lock = {}, threading.Lock()
        threading.Thread(target=self._watch, daemon=True, name='browser-signin').start()

    def _watch(self):
        while True:
            time.sleep(1.5)
            for sess in list(self.sessions.values()):
                try:
                    if sess.state != 'signing_in':
                        if time.time() - sess.touched > 120:
                            self.sessions.pop(sess.id, None)
                        continue
                    if time.time() - sess.touched > IDLE_SECONDS or sess.cdp.closed:
                        sess.state, sess.message = 'expired', 'The sign-in window closed. Start again.'
                        sess.close()
                        continue
                    if sess.network == 'slack':
                        found = sess.slack_login()
                        if found:
                            self._finish_slack(sess, *found)
                        elif SLACK_APP_PROMPT.match(sess.url or '') and time.time() - getattr(sess, 'nudged', 0) > 6:
                            # "Open the Slack app?" page: go to Slack in the browser, where the login lands.
                            sess.nudged = time.time()
                            sess.cdp.send('Page.navigate', {'url': 'https://app.slack.com/client'}, session=sess.session)
                    else:
                        fields = sess.bridge_fields()
                        if fields:
                            self._finish_generic(sess, fields)
                except Exception:
                    continue

    def _finish_generic(self, sess, fields):
        sess.state = 'connecting'
        with sess.cond:
            sess.cond.notify_all()
        why = ''
        try:
            raw, clean = self.connectors.raw_step(sess.network, fields)
        except EngineError as e:
            raw, clean, why = None, None, getattr(e, 'message', '') or str(e)
        except Exception as e:
            raw, clean, why = None, None, type(e).__name__
        fields.clear()
        kind = (raw or {}).get('type')
        print('browser sign-in %s: step=%s %s' % (sess.network, kind or 'failed', why[:200]), flush=True)
        if kind == 'cookies':
            # Another page step (X's browser check): run it in the same private window.
            sess.step, sess.extracted, sess.last_extract = raw, {}, 0.0
            url = (raw.get('cookies') or {}).get('url')
            if url:
                sess.cdp.send('Page.navigate', {'url': url}, session=sess.session)
            sess.state = 'signing_in'
            return
        if kind == 'complete':
            sess.state, sess.message, sess.result = 'done', 'Connected', {'connected': [GENERIC[sess.network][1]], 'failed': []}
        elif kind in ('user_input', 'display_and_wait'):
            # A code or confirmation: the normal sign-in screen takes over.
            sess.state, sess.message, sess.result = 'continue', '', {'next': clean}
        else:
            sess.state, sess.message = 'failed', 'The sign-in was not accepted' + (': ' + why if why else '') + '. Start again.'
        sess.close()

    def _finish_slack(self, sess, teams, cookie):
        sess.state = 'connecting'
        with sess.cond:
            sess.cond.notify_all()
        done, failed, why = [], [], ''
        for team in teams:
            try:
                step = self.connectors.dispatch('POST', ['slack', 'start'], {'flow': 'token'})
                if step.get('type') == 'cookies':
                    pending = self.connectors.pending.get('slack')
                    step = self.connectors.advance('slack', pending, pending[1], {'auth_token': team['token'], 'cookie_token': cookie}, pending[2])
                    for _ in range(240):
                        if step.get('type') != 'pending':
                            break
                        time.sleep(0.5)
                        step = self.connectors.advance('slack', pending, pending[1], {}, pending[2])
                (done if step.get('type') == 'complete' else failed).append(team.get('name') or 'workspace')
            except EngineError as e:
                failed.append(team.get('name') or 'workspace'); why = getattr(e, 'message', '') or str(e)
            except Exception as e:
                failed.append(team.get('name') or 'workspace'); why = type(e).__name__
            finally:
                try:
                    pending = self.connectors.pending.get('slack')
                    if pending and team is not teams[-1]:
                        self.connectors.dispatch('POST', ['slack', 'cancel'], {'login_id': pending[1][0]})
                except Exception:
                    pass
        # Kept for the owner's monitor: the bridge's reason, never the token values.
        print('browser sign-in slack: connected=%d failed=%d %s' % (len(done), len(failed), why[:200]), flush=True)
        team = cookie = None
        sess.result = {'connected': done, 'failed': failed}
        sess.state = 'done' if done else 'failed'
        sess.message = ('Connected ' + ', '.join(done)) if done else ('Slack did not accept this sign-in' + (': ' + why if why else '') + '. Start again.')
        sess.close()

    def dispatch(self, method, suffix, payload, query):
        if suffix == ['start'] and method == 'POST':
            network = payload.get('network')
            if network not in NETWORKS and network not in GENERIC:
                fail('invalid_network', 'This network has no browser sign-in')
            try:
                width = max(320, min(1280, int(payload.get('width', 400))))
                height = max(480, min(1400, int(payload.get('height', 720))))
            except (TypeError, ValueError):
                fail('invalid_input', 'Invalid size')
            with self.lock:
                for old in [x for x in self.sessions.values() if x.network == network and x.state == 'signing_in']:
                    old.close()
                    self.sessions.pop(old.id, None)
                try:
                    if network in GENERIC:
                        flow = payload.get('flow') or GENERIC[network][0]
                        raw, _ = self.connectors.raw_start(network, flow)
                        if raw.get('type') != 'cookies':
                            fail('invalid_flow', 'This sign-in does not use a browser page')
                        params = raw.get('cookies') or {}
                        # Desktop layout: the bridges wait for the desktop site's address.
                        sess = Session(network, width, height, False, url=params.get('url'), user_agent=params.get('user_agent'), step=raw)
                    else:
                        sess = Session(network, width, height, bool(payload.get('mobile')))
                except (OSError, ValueError, KeyError):
                    fail('browser_unavailable', 'The Wizard Browser is not reachable. Check that the Browser app is installed and running.', 503)
                self.sessions[sess.id] = sess
            return {'id': sess.id, 'title': (NETWORKS.get(network) or {'title': GENERIC.get(network, ('', network))[1]})['title']}
        if len(suffix) == 2:
            sess = self.sessions.get(suffix[0])
            if sess is None:
                fail('not_found', 'This sign-in has ended. Start again.', 404)
            if suffix[1] == 'frame' and method == 'GET':
                try:
                    after = int((query.get('after') or ['0'])[0])
                except ValueError:
                    after = 0
                return sess.wait_frame(after)
            if suffix[1] == 'input' and method == 'POST':
                if sess.state != 'signing_in':
                    return {'ok': False}
                try:
                    return sess.input(payload)
                except OSError:
                    fail('browser_unavailable', 'The sign-in window closed. Start again.', 503)
            if suffix[1] == 'cancel' and method == 'POST':
                sess.close()
                self.sessions.pop(sess.id, None)
                return {'cancelled': True}
        fail('not_found', 'Unknown browser sign-in route', 404)
