"""Explicit opt-in local app lifecycle. Never imported by the dormant app."""
import os
import threading
from pathlib import Path
from . import Store, Worker, EndpointPolicy, PyWebPushTransport

OWNER = 'messenger-owner'


class PushRuntime:
    def __init__(self, data, inbox, public_path, *, transport=None):
        if inbox is None or not data:
            raise ValueError('Push requires a durable unified inbox')
        public = os.environ.get('MESSENGER_PUSH_PUBLIC_KEY', '')
        private = os.environ.get('MESSENGER_PUSH_PRIVATE_KEY', '')
        subject = os.environ.get('MESSENGER_PUSH_SUBJECT', '')
        hosts = os.environ.get('MESSENGER_PUSH_HOSTS', '').split(',')
        if not public or not private or not subject or not all(hosts):
            raise ValueError('Explicit push keys, subject and exact hosts required')
        # Fail startup clearly if optional transport dependencies were not packaged.
        if transport is None:
            import pywebpush  # noqa: F401
        self.store = Store(Path(data) / 'private-push', EndpointPolicy(hosts))
        self.inbox = inbox.store
        self.path = public_path
        self.public_key = public
        self.worker = Worker(self.store, transport or PyWebPushTransport(self.store.policy, private, subject))
        self.stop_event = threading.Event()
        self.thread = None
        self.inbox.push_enabled = True

    def reconcile(self):
        with self.inbox.db() as db:
            rows = db.execute('SELECT message,created FROM push_intent WHERE done=0 ORDER BY created LIMIT 200').fetchall()
        for row in rows:
            self.store.received(OWNER, row['message'], outgoing=False, live=True, created=row['created'])
            with self.inbox.db() as db:
                db.execute('UPDATE push_intent SET done=1 WHERE message=?', (row['message'],))
        return len(rows)

    def start(self):
        def run():
            while not self.stop_event.is_set():
                try:
                    self.reconcile()
                    busy = self.worker.run_once()
                except Exception:
                    # No capability/credential-bearing exception logging.
                    busy = False
                self.stop_event.wait(0.1 if busy else 2)
        self.thread = threading.Thread(target=run, name='messenger-push', daemon=True)
        self.thread.start()

    def close(self):
        self.inbox.push_enabled = False
        self.stop_event.set()
        if self.thread:
            self.thread.join(timeout=15)
            if self.thread.is_alive():
                raise RuntimeError('Push worker did not stop within transport deadline')

    def config(self):
        return {'enabled': True, 'public_key': self.public_key, 'scope': self.path,
                'worker': self.path + 'push-service-worker.js'}

    def script(self):
        import json
        source = (Path(__file__).parent / 'service-worker.js').read_text()
        return source.replace("const APP_PATH = '/apps/messenger/';", 'const APP_PATH = ' + json.dumps(self.path) + ';').encode()
