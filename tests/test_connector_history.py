"""The real multi-network subclass must preserve base history isolation and voice warming."""
import tempfile
import time
import unittest
from unittest.mock import Mock
from connector_inbox import ConnectorInbox


class ConnectorHistory(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.inbox = ConnectorInbox(self.tmp.name, Mock())
        self.store = self.inbox.store
        self.a = self.store.identity('line', '!line:messenger.internal', 'LINE fixture')
        self.b = self.store.identity('instagram', '!ig:messenger.internal', 'Instagram fixture')

    def tearDown(self):
        self.inbox.close()
        self.store._conn.close()
        self.tmp.cleanup()

    def event(self, mid, body='needle'):
        return {'type':'m.room.message','event_id':mid,'sender':'@peer:messenger.internal',
                'origin_server_ts':int(time.time()*1000),'content':{'msgtype':'m.text','body':body}}

    def test_connector_mutations_cannot_cross_thread_and_fts_tracks_redaction(self):
        self.inbox.ingest(self.a, {}, self.event('$one'))
        edit = self.event('$edit')
        edit['content'] = {'m.relates_to':{'rel_type':'m.replace','event_id':'$one'},
                           'm.new_content':{'msgtype':'m.text','body':'replacement'}}
        self.inbox.ingest(self.b, {}, edit)
        self.assertEqual(self.store.messages(self.a['person_id'])[0]['original'],'needle')
        self.inbox.ingest(self.b, {}, {'type':'m.room.redaction','redacts':'$one'})
        self.assertEqual(len(self.store.search('needle')['messages']),1)
        self.inbox.ingest(self.a, {}, edit)
        self.assertEqual(self.store.search('needle')['messages'],[])
        self.assertEqual(len(self.store.search('replacement')['messages']),1)
        self.inbox.ingest(self.a, {}, {'type':'m.room.redaction','redacts':'$one'})
        self.assertEqual(self.store.search('replacement')['messages'],[])
        self.inbox.ingest(self.a, {}, self.event('$one'))
        self.assertEqual(self.store.search('needle')['messages'],[])

    def test_connector_reactions_cannot_cross_thread(self):
        self.inbox.ingest(self.a, {}, self.event('$one'))
        reaction = {'type':'m.reaction','event_id':'$reaction','sender':'@peer:messenger.internal',
                    'content':{'m.relates_to':{'rel_type':'m.annotation','event_id':'$one','key':'OK'}}}
        self.inbox.ingest(self.b, {}, reaction)
        self.assertEqual(self.store.messages(self.a['person_id'])[0]['reactions'],[])
        self.inbox.ingest(self.a, {}, reaction)
        self.assertEqual(len(self.store.messages(self.a['person_id'])[0]['reactions']),1)

    def test_connector_incoming_voice_uses_shared_warm_queue(self):
        event = self.event('$voice')
        event['content'] = {'msgtype':'m.audio','body':'voice.ogg','url':'mxc://fixture/voice',
                            'info':{'mimetype':'audio/ogg','size':10}}
        self.inbox.ingest(self.a, {}, event)
        self.assertEqual(self.inbox.warm_queue.get_nowait(),'$voice')


if __name__ == '__main__':
    unittest.main()
