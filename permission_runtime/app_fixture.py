"""TEST ONLY: normal Messenger HTTP, real drafts/unified sender, fixture mx callback.
No real accounts, providers, or external network. Not a broker backend.
"""
import json
from pathlib import Path
import sys
sys.path.insert(0, '/app')
from web import ViewServer
from unified import UnifiedInbox
from drafts import Drafts
sys.path.insert(0, '/app/tests')
from test_web import FakeEngine

root = Path('/state')
token = (root/'token').read_text()
engine = FakeEngine()
server = ViewServer(('0.0.0.0',8765), engine, token, ['http://owner.test'])
inbox = UnifiedInbox(root, engine)
server.unified = inbox
server.drafts = Drafts(root)
a = inbox.store.identity('telegram', '!alice', 'Alice')
def provider(path, method='GET', body=None, **kwargs):
    with (root/'ledger.jsonl').open('a') as f:
        f.write(json.dumps({'path':path,'method':method,'body':body})+'\n')
    return {'event_id':'$fixture-sent'}
inbox.mx = provider
cookie, session = server.auth.create()
(root/'owner.json').write_text(json.dumps({'Cookie':'wizard_messenger_session='+cookie, 'Origin':'http://owner.test','X-Messenger-CSRF':session['csrf']}))
(root/'recipient.json').write_text(json.dumps(a))
server.serve_forever()
