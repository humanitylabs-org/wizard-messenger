"""Private translation worker. Translation runs on the box's own model (issue 209); Catch me up calls only Tinfoil."""
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
import hmac
import json
import os
from pathlib import Path
from urllib.request import Request, urlopen
import catchup
import private_translation

LANGUAGES = {'en': 'English', 'th': 'Thai', 'ja': 'Japanese', 'zh': 'Chinese', 'es': 'Spanish', 'fr': 'French', 'de': 'German'}


COMPLETE_MAX = 4 * 1024 * 1024


def complete(model, system, user):
    """One Catch me up model call. Tinfoil is the only destination and the model must be one of catchup.MODELS."""
    key = os.environ.get('TINFOIL_API_KEY', '')
    if not key:
        return {'text': '', 'error': 'Tinfoil is not configured.', 'unconfigured': True}
    try:
        request = Request('https://inference.tinfoil.sh/v1/chat/completions', json.dumps(catchup.tinfoil_payload(model, system, user)).encode(),
                          {'Authorization': 'Bearer ' + key, 'Content-Type': 'application/json'})
        with urlopen(request, timeout=170) as response:
            result = json.load(response)['choices'][0]['message']['content']
        if not isinstance(result, str) or not result.strip():
            raise ValueError('Empty summary')
        return {'text': result, 'error': None}
    except Exception:
        # No upstream text, headers, submitted messages or key in logs or API errors.
        return {'text': '', 'error': 'Tinfoil did not answer.'}


class Handler(BaseHTTPRequestHandler):
    def log_message(self, *_): pass
    def reply(self, status, body):
        data = json.dumps(body).encode()
        self.send_response(status)
        self.send_header('Content-Type', 'application/json')
        self.send_header('Content-Length', str(len(data)))
        self.end_headers()
        self.wfile.write(data)
    def do_GET(self):
        self.reply(200 if self.path == '/healthz' else 404, {'ok': self.path == '/healthz'})
    def do_POST(self):
        try:
            token = json.loads(Path('/data/auth.json').read_text())['translation_token']
            if not hmac.compare_digest(self.headers.get('Authorization', ''), 'Bearer ' + token):
                return self.reply(401, {'error': 'Unauthorized'})
            length = int(self.headers.get('Content-Length', '0'))
            if self.path == '/complete':
                if not 0 < length <= COMPLETE_MAX or self.headers.get('Transfer-Encoding'):
                    return self.reply(400, {'error': 'Invalid request'})
                self.connection.settimeout(30)
                body = json.loads(self.rfile.read(length))
                if body.get('model') not in catchup.MODELS or not isinstance(body.get('system'), str) or not isinstance(body.get('user'), str) or not body['user'].strip():
                    return self.reply(400, {'error': 'Invalid summary input'})
                return self.reply(200, complete(body['model'], body['system'], body['user']))
            if self.path != '/translate' or not 0 < length <= 65536 or self.headers.get('Transfer-Encoding'):
                return self.reply(400, {'error': 'Invalid request'})
            self.connection.settimeout(15)
            body = json.loads(self.rfile.read(length))
            if body.get('language') not in LANGUAGES or not isinstance(body.get('text'), str) or not 0 < len(body['text']) <= 16384:
                return self.reply(400, {'error': 'Invalid translation input'})
            # Issue 209 (on for everyone): the model runs here on the box; translation never calls Tinfoil.
            if body.get('source') is not None and body.get('source') not in LANGUAGES:
                return self.reply(400, {'error': 'Invalid translation input'})
            return self.reply(200, private_translation.translate(body['text'], body['language'], body.get('source')))
        except Exception:
            self.reply(400, {'error': 'Invalid translation request'})


if __name__ == '__main__':
    ThreadingHTTPServer(('0.0.0.0', 8766), Handler).serve_forever()
