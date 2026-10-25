"""TEST-ONLY fixture authority. No provider adapter, execution or URL proxy."""
import hashlib
import json
import os
import socketserver
import threading
from pathlib import Path

ROOT = Path('/state')
LOCK = threading.RLock()
MODES = ('no-access', 'read-only', 'draft-only')
MAX = 16384


def digest(d):
    return hashlib.sha256(json.dumps({k: d[k] for k in ('recipient', 'body', 'revision')}, sort_keys=True).encode()).hexdigest()


class Authority:
    def __init__(self):
        self.path = ROOT / 'fixture.json'
        self.state = json.loads(self.path.read_text()) if self.path.exists() else {
            'mode': 'no-access', 'drafts': {}, 'ledger': [],
            'messages': [{'id': 'fixture-inbound-1', 'body': 'TEST ONLY inbound message'}]}
        # Fail closed even after a previously enabled session/restart.
        self.state['mode'] = 'no-access'
        self.save()

    def save(self):
        tmp = self.path.with_suffix('.tmp')
        tmp.write_text(json.dumps(self.state, sort_keys=True))
        os.replace(tmp, self.path)

    def call(self, q, owner=False):
        with LOCK:
            return self._call(q, owner)

    def _call(self, q, owner):
        if not isinstance(q, dict):
            raise ValueError('object required')
        op = q.get('op')
        schemas = {'read': {'op'}, 'create': {'op', 'recipient', 'body'},
                   'update': {'op', 'id', 'revision', 'recipient', 'body'}}
        if owner:
            schemas.update({'policy': {'op', 'mode'}, 'inspect': {'op'},
                            'freeze': {'op', 'id', 'revision', 'digest'},
                            'approve': {'op', 'id', 'digest'}})
        if op not in schemas or set(q) != schemas[op]:
            raise PermissionError('operation/schema denied on this channel')
        s = self.state
        if op == 'policy':
            if q['mode'] not in MODES:
                raise ValueError('unsupported mode; full access intentionally absent')
            s['mode'] = q['mode']
            self.save()
            return {'mode': s['mode']}
        if op == 'inspect':
            return json.loads(json.dumps(s))
        if op in ('freeze', 'approve'):
            d = s['drafts'][q['id']]
            if digest(d) != q['digest']:
                raise ValueError('exact content digest mismatch')
            if op == 'freeze':
                if d['revision'] != q['revision'] or d['status'] != 'draft':
                    raise ValueError('revision/status mismatch')
                d['status'] = 'frozen'
            else:
                if d['status'] == 'sent':
                    return {'draft': d, 'already_sent': True}
                if d['status'] != 'frozen':
                    raise ValueError('must freeze exact draft before approval')
                # Fixture-only send ledger: secret is outside worker filesystem.
                if not (ROOT / 'fixture-provider-key').read_text().startswith('TEST-ONLY-'):
                    raise ValueError('fixture key required')
                s['ledger'].append({'id': q['id'], 'recipient': d['recipient'], 'body': d['body'],
                                    'revision': d['revision'], 'digest': q['digest'], 'authority': 'owner-socket'})
                d['status'] = 'sent'
            self.save()
            return {'draft': d}
        if s['mode'] == 'no-access':
            raise PermissionError('owner policy: no access')
        if op == 'read':
            return {'messages': s['messages'], 'drafts': s['drafts']}
        if s['mode'] != 'draft-only':
            raise PermissionError('owner policy: read only')
        for k, size in [('recipient', 256), ('body', 8192)]:
            if not isinstance(q[k], str) or not 0 < len(q[k]) <= size:
                raise ValueError('invalid ' + k)
        if op == 'create':
            ident = str(len(s['drafts']) + 1)
            d = {'recipient': q['recipient'], 'body': q['body'], 'revision': 1, 'status': 'draft'}
            s['drafts'][ident] = d
        else:
            ident = q['id']
            d = s['drafts'][ident]
            if d['status'] != 'draft' or type(q['revision']) is not int or d['revision'] != q['revision']:
                raise ValueError('frozen/sent or stale revision')
            d.update(recipient=q['recipient'], body=q['body'], revision=d['revision'] + 1)
        self.save()
        return {'id': ident, 'draft': d, 'digest': digest(d)}


class Handler(socketserver.StreamRequestHandler):
    def handle(self):
        self.connection.settimeout(3)
        try:
            raw = self.rfile.readline(MAX + 1)
            if len(raw) > MAX or not raw.endswith(b'\n'):
                raise ValueError('request limit')
            out = {'ok': True, 'result': self.server.authority.call(json.loads(raw), self.server.owner)}
        except (ValueError, KeyError, TypeError, PermissionError, TimeoutError) as e:
            out = {'ok': False, 'error': str(e)}
        self.wfile.write(json.dumps(out).encode() + b'\n')


if __name__ == '__main__':
    authority = Authority()
    servers = []
    for path, owner in [('/agent/broker.sock', False), ('/owner/control.sock', True)]:
        Path(path).unlink(missing_ok=True)
        server = socketserver.ThreadingUnixStreamServer(path, Handler)
        server.daemon_threads = True
        server.authority, server.owner = authority, owner
        os.chmod(path, 0o600 if owner else 0o666)
        threading.Thread(target=server.serve_forever, daemon=True).start()
        servers.append(server)
    threading.Event().wait()
