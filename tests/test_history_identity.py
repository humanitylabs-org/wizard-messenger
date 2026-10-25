"""Offline contracts for bridged-room discovery, own-message identity, contact names
and history backfill settings. Synthetic fixtures only; never live-account evidence."""
import json
import os
from pathlib import Path
import sqlite3
import sys
import tempfile
import time
import unittest
from unittest.mock import Mock, patch
sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from engine import EngineError
from unified_setup import setup
from connector_setup import setup_connectors, EXTRA_NETWORKS
from connectors import room_network, ghost_mxid, own_ghost, ghost_network, MATRIX_NETWORKS
from connector_inbox import ConnectorInbox
from unified import PeopleStore, weak_label

SERVER = 'messenger.internal'


def bridge(protocol, network, **content):
    return {'type': 'm.bridge', 'state_key': 'x', 'sender': '@%sbot:%s' % (network, SERVER),
            'content': dict({'protocol': {'id': protocol}}, **content)}


def member(user, name=None, membership='join'):
    content = {'membership': membership}
    if name:
        content['displayname'] = name
    return {'type': 'm.room.member', 'state_key': user, 'content': content}


class RoomNetworkTests(unittest.TestCase):
    def test_real_bridgev2_protocol_ids_map_to_networks(self):
        # BeeperBridgeType values from the pinned upstream sources.
        cases = {'instagramgo': 'instagram', 'github.com/highesttt/matrix-line-messenger': 'line',
                 'slackgo': 'slack', 'whatsapp': 'whatsapp', 'telegram': 'telegram', 'signal': 'signal'}
        for protocol, network in cases.items():
            self.assertEqual(room_network([bridge(protocol, network)]), network)

    def test_refuses_wrong_bot_unknown_ambiguous_and_display_names(self):
        self.assertIsNone(room_network([bridge('instagramgo', 'whatsapp')]))  # sender mismatch
        self.assertIsNone(room_network([{'type': 'm.bridge', 'sender': '@evil:%s' % SERVER, 'content': {'protocol': {'id': 'line'}}}]))
        self.assertIsNone(room_network([bridge('facebookgo', 'instagram')]))
        self.assertIsNone(room_network([bridge('instagramgo', 'instagram'), bridge('telegram', 'telegram')]))
        self.assertIsNone(room_network([bridge('whatsapp', 'whatsapp'), {'type': 'm.bridge', 'sender': '@x:%s' % SERVER, 'content': {}}]))
        self.assertIsNone(room_network([{'type': 'm.room.name', 'content': {'name': 'Instagram'}}]))
        self.assertIsNone(room_network([bridge({'id': 'x'}, 'line')]))

    def test_ghost_escaping_matches_mautrix_encode_user_localpart(self):
        self.assertEqual(ghost_mxid('telegram', 42), '@telegram_42:' + SERVER)
        self.assertEqual(ghost_mxid('line', 'U1aB_c'), '@line__u1a_b__c:' + SERVER)
        self.assertEqual(ghost_mxid('whatsapp', 'a@b é'), '@whatsapp_a=40b=20=c3=a9:' + SERVER)
        self.assertEqual(own_ghost('slack', 'T01-U02'), '@slack_t01-u02:' + SERVER)
        self.assertIsNone(own_ghost('kakaotalk', '1'))
        self.assertIsNone(own_ghost('line', ''))
        self.assertIsNone(own_ghost('line', None))
        self.assertIsNone(own_ghost('line', True))
        self.assertEqual(ghost_network('@line__uabc:' + SERVER), 'line')
        self.assertIsNone(ghost_network('@linebot:' + SERVER))
        self.assertIsNone(ghost_network('@line_x:evil.example'))


class Base(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory(dir=os.environ.get('TMPDIR'))
        self.addCleanup(self.tmp.cleanup)
        self.root = Path(self.tmp.name)
        with patch.dict(os.environ, {'TELEGRAM_API_ID': '', 'TELEGRAM_API_HASH': ''}):
            setup(self.root)

    def inbox(self):
        engine = Mock()
        engine.status.return_value = {'state': 'dormant'}
        inbox = ConnectorInbox(self.root, engine)
        self.addCleanup(inbox.close)
        self.addCleanup(inbox.store._conn.close)
        inbox.store.put('matrix_token', 'synthetic-read-token')
        inbox.history_sync = True
        return inbox


class DiscoveryAndHistoryTests(Base):
    def test_cached_none_meta_is_reevaluated_and_history_imported_silently(self):
        inbox = self.inbox()
        inbox.store.push_enabled = True
        inbox.learn_me = lambda: None
        room = '!ig:' + SERVER
        peer = '@instagram_17:' + SERVER
        with inbox.store.db() as db:  # what the previous release cached for LINE/Instagram rooms
            db.execute('INSERT INTO room_meta VALUES (?,?)', (room, json.dumps({'network': None, 'telegram': False})))
        inbox.store.put('sync_token', 'previous')
        now = int(time.time() * 1000)
        old = now - 40 * 86400 * 1000
        history = [{'type': 'm.room.message', 'event_id': '$h%d' % i, 'sender': peer, 'origin_server_ts': old + i,
                    'content': {'msgtype': 'm.text', 'body': 'old %d' % i}} for i in range(3)]
        recent = {'type': 'm.room.message', 'event_id': '$recent', 'sender': peer, 'origin_server_ts': now - 3600 * 1000,
                  'content': {'msgtype': 'm.text', 'body': 'recent'}}

        def matrix(path, *a, **k):
            if path.startswith('/sync?'):
                return {'next_batch': 'next', 'rooms': {'join': {room: {'timeline': {'events': []}}}}}
            if path.endswith('/state'):
                return [bridge('instagramgo', 'instagram', **{'com.beeper.room_type.v2': 'dm'}),
                        {'type': 'm.room.name', 'content': {'name': 'Pat'}}, member(inbox.owner, 'owner'), member(peer, 'Pat')]
            if '/messages?' in path:
                return {'chunk': list(reversed(history + [recent])), 'end': None}
            raise AssertionError(path)
        with patch.object(inbox, 'mx', side_effect=matrix):
            self.assertEqual(inbox.sync()['state'], 'ready')
        chats = inbox.store.people()
        self.assertEqual([(c['display_name'], c['identities'][0]['network']) for c in chats], [('Pat', 'instagram')])
        self.assertEqual(len(inbox.store.messages(chats[0]['id'])), 4)
        with inbox.store.db() as db:
            self.assertEqual(db.execute('SELECT COUNT(*) FROM push_intent').fetchone()[0], 0)
        # 40-day-old history is read; the recent line (inside unread_hours) stays unread.
        self.assertEqual(chats[0]['unread'], 1)
        self.assertEqual(inbox.store.get('history_imported:' + room), '1')

    def test_quiet_dropped_rooms_are_rescanned_once_after_upgrade(self):
        inbox = self.inbox()
        inbox.learn_me = lambda: None
        inbox.store.put('sync_token', 'previous')
        line_room, other = '!line:' + SERVER, '!plain:' + SERVER
        peer = '@line_upeer:' + SERVER
        with inbox.store.db() as db:
            for room in (line_room, other):
                db.execute('INSERT INTO room_meta VALUES (?,?)', (room, json.dumps({'network': None, 'telegram': False})))
        calls = []

        def matrix(path, *a, **k):
            calls.append(path.split('?')[0])
            if path.startswith('/sync?'):
                return {'next_batch': 'n', 'rooms': {}}
            if path == '/joined_rooms':
                return {'joined_rooms': [line_room, other]}
            if path.endswith('/state'):
                if 'line' in path:
                    return [bridge('github.com/highesttt/matrix-line-messenger', 'line', **{'com.beeper.room_type.v2': 'dm'}), member(peer, 'Noi')]
                return [{'type': 'm.room.create', 'content': {}}]
            if '/messages?' in path:
                return {'chunk': [{'type': 'm.room.message', 'event_id': '$l', 'sender': peer, 'origin_server_ts': 1, 'content': {'msgtype': 'm.text', 'body': 'old'}}]}
            raise AssertionError(path)
        with patch.object(inbox, 'mx', side_effect=matrix):
            inbox.sync()
            inbox.sync()
        self.assertEqual([(p['display_name'], p['identities'][0]['network'], p['unread']) for p in inbox.store.people()], [('Noi', 'line', 0)])
        self.assertEqual(calls.count('/joined_rooms'), 1)

    def test_only_recent_lines_notify_backfilled_history_never_does(self):
        # A brand-new chat's genuinely new first message still notifies.
        inbox = self.inbox()
        inbox.store.push_enabled = True
        inbox.learn_me = lambda: None
        inbox.store.put('sync_token', 'previous')
        room, peer = '!wa:' + SERVER, '@whatsapp_1:' + SERVER
        now = int(time.time() * 1000)
        batches = [[{'type': 'm.room.message', 'event_id': '$b', 'sender': peer, 'origin_server_ts': now, 'content': {'msgtype': 'm.text', 'body': 'x'}}],
                   [{'type': 'm.room.message', 'event_id': '$live', 'sender': peer, 'origin_server_ts': now, 'content': {'msgtype': 'm.text', 'body': 'y'}},
                    {'type': 'm.room.message', 'event_id': '$late-backfill', 'sender': peer, 'origin_server_ts': now - 86400 * 1000, 'content': {'msgtype': 'm.text', 'body': 'z'}}]]

        def matrix(path, *a, **k):
            if path.startswith('/sync?'):
                return {'next_batch': 'n', 'rooms': {'join': {room: {'timeline': {'events': batches.pop(0)}}}}}
            if path.endswith('/state'):
                return [bridge('whatsapp', 'whatsapp', **{'com.beeper.room_type.v2': 'dm'}), member(peer, 'Sam')]
            if '/messages?' in path:
                return {'chunk': []}
            raise AssertionError(path)
        with patch.object(inbox, 'mx', side_effect=matrix):
            inbox.sync(); inbox.sync()
        with inbox.store.db() as db:
            self.assertEqual(sorted(r[0] for r in db.execute('SELECT message FROM push_intent')), ['matrix:$b', 'matrix:$live'])


class OwnIdentityTests(Base):
    def test_learn_me_covers_every_connected_network_and_reclaims_rows(self):
        setup_connectors(self.root, ('whatsapp', 'line', 'instagram'))
        inbox = self.inbox()
        line_ghost = ghost_mxid('line', 'Uabc_D')
        wa_ghost = ghost_mxid('whatsapp', '15550001')
        for net, ghost in (('line', line_ghost), ('whatsapp', wa_ghost)):
            room = '!%s:%s' % (net, SERVER)
            meta = {'network': net, 'v': 2, 'kind': 'person', 'label': 'James', 'names': {ghost: 'Me Myself', '@%s_peer:%s' % (net, SERVER): 'James'}}
            with inbox.store.db() as db:
                db.execute('INSERT INTO room_meta VALUES (?,?)', (room, json.dumps(meta)))
            identity = inbox.store.identity(net, room, 'James')
            inbox.ingest(identity, meta, {'type': 'm.room.message', 'event_id': '$mine-' + net, 'sender': ghost, 'origin_server_ts': 5, 'content': {'msgtype': 'm.text', 'body': 'from my phone'}})
            inbox.ingest(identity, meta, {'type': 'm.room.message', 'event_id': '$theirs-' + net, 'sender': '@%s_peer:%s' % (net, SERVER), 'origin_server_ts': 4, 'content': {'msgtype': 'm.text', 'body': 'hi'}})
        logins = {'line': [{'id': 'Uabc_D', 'name': 'Me Myself', 'profile': {}}],
                  'whatsapp': [{'id': '15550001', 'name': '+1 555', 'profile': {'name': 'Me Myself'}}],
                  'instagram': [], 'telegram': []}

        def request(network, path, *a, **k):
            self.assertEqual(path, '/whoami')
            if network not in logins:
                raise EngineError('connector_not_configured', 'x', 409)
            return {'logins': logins[network]}
        with patch.object(inbox.connectors, 'request', side_effect=request), patch.object(inbox.connectors, 'config', return_value=('u', 't' * 20)):
            inbox.learn_me()
        self.assertTrue({line_ghost, wa_ghost} <= inbox.mine)
        self.assertIn('Me Myself', inbox.store.own_names())
        for net in ('line', 'whatsapp'):
            person = inbox.store.identity(net, '!%s:%s' % (net, SERVER), 'James')['person_id']
            rows = {m['id']: m for m in inbox.store.messages(person)}
            self.assertTrue(rows['$mine-' + net]['outgoing'])
            self.assertEqual(rows['$mine-' + net]['sender'], 'You')
            self.assertFalse(rows['$theirs-' + net]['outgoing'])
        # Claims never cross networks: a LINE ghost name in a WhatsApp room is untouched.
        self.assertEqual(inbox.store.claim_own(line_ghost), 0)

    def test_learn_me_survives_bridge_errors_and_is_read_only(self):
        setup_connectors(self.root, ('whatsapp',))
        inbox = self.inbox()
        writer = Mock(side_effect=AssertionError('no writes'))
        inbox.connectors.writer = writer
        with patch.object(inbox.connectors, 'reader', side_effect=EngineError('bridge_down', 'x', 502)):
            inbox.learn_me()
        writer.assert_not_called()


class ContactNameTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.store = PeopleStore(Path(self.tmp.name) / 'people.db')
        self.addCleanup(self.store._conn.close)

    def test_weak_labels(self):
        for label in ('+66 81 234 5678', '6681234567', 'WhatsApp conversation', '', None, '@whatsapp_1:x', 'u' + 'a' * 32, 'Me'):
            self.assertTrue(weak_label(label, {'Me'}), label)
        for label in ('James', 'Family 🏠', 'Dr. Kim'):
            self.assertFalse(weak_label(label, {'Me'}), label)

    def test_synced_name_replaces_phone_label_but_never_downgrades(self):
        first = self.store.identity('whatsapp', '!r', '+1 555 0100')
        again = self.store.identity('whatsapp', '!r', 'James')
        self.assertEqual(again['label'], 'James')
        self.assertEqual(self.store.person(first['person_id'])['display_name'], 'James')
        self.store.identity('whatsapp', '!r', '+1 555 0100')
        self.store.identity('whatsapp', '!r', 'WhatsApp conversation')
        self.assertEqual(self.store.person(first['person_id'])['display_name'], 'James')
        self.store.identity('whatsapp', '!r', 'James Kim')  # a genuine contact rename follows
        self.assertEqual(self.store.person(first['person_id'])['display_name'], 'James Kim')

    def test_owner_rename_is_never_overwritten(self):
        identity = self.store.identity('whatsapp', '!r', '+1 555 0100')
        self.store.update(identity['person_id'], {'display_name': 'Jim (work)'})
        self.store.identity('whatsapp', '!r', 'James')
        self.assertEqual(self.store.person(identity['person_id'])['display_name'], 'Jim (work)')
        self.assertEqual(self.store.identity('whatsapp', '!r', 'x')['label'], 'x')

    def test_owner_own_name_is_never_a_dm_title(self):
        self.store.remember_own_names('whatsapp', ['Me Myself'])
        identity = self.store.identity('whatsapp', '!r', 'Me Myself')
        self.store.identity('whatsapp', '!r', 'Me Myself')
        self.store.identity('whatsapp', '!r', 'WhatsApp conversation')  # neutral beats "me"
        self.assertEqual(self.store.person(identity['person_id'])['display_name'], 'WhatsApp conversation')
        self.store.identity('whatsapp', '!r', 'James')
        self.assertEqual(self.store.person(identity['person_id'])['display_name'], 'James')

    def test_migration_locks_existing_manual_renames(self):
        path = Path(self.tmp.name) / 'old.db'
        store = PeopleStore(path)
        a = store.identity('telegram', '!a', 'Alice')
        b = store.identity('telegram', '!b', '+1 555')
        with store.db() as db:
            db.execute("UPDATE person SET display_name='Ally' WHERE id=?", (a['person_id'],))
        store._conn.close()
        raw = sqlite3.connect(path)
        raw.execute('ALTER TABLE person DROP COLUMN name_locked')
        raw.commit(); raw.close()
        store = PeopleStore(path)
        self.addCleanup(store._conn.close)
        store.identity('telegram', '!a', 'Alice Smith')
        store.identity('telegram', '!b', 'Bob')
        self.assertEqual(store.person(a['person_id'])['display_name'], 'Ally')
        self.assertEqual(store.person(b['person_id'])['display_name'], 'Bob')


class DmLabelTests(Base):
    def test_private_dm_named_after_owner_is_retitled(self):
        inbox = self.inbox()
        inbox.store.remember_own_names('whatsapp', ['Me Myself'])
        inbox.engine.status.return_value = {'state': 'ready'}
        inbox.engine.identity.return_value = {'identity': {'account_id': 'a' * 64, 'npub': 'npub-own', 'display_name': 'owner'}}
        dm = {'group_id': 'g1', 'name': 'Me Myself', 'members': [{'account_id': 'a' * 64}, {'npub': 'npub-peer'}]}
        inbox.engine.dms.return_value = {'dms': [dm]}
        inbox.engine.messages.return_value = {'messages': []}
        stored = inbox.store.identity('messenger', 'g1', 'Me Myself')  # what older releases stored
        inbox.marmot()
        person = inbox.store.person(stored['person_id'])
        self.assertEqual(person['display_name'], 'Messenger contact')
        dm['members'][1]['display_name'] = 'James'
        inbox.marmot()
        self.assertEqual(inbox.store.person(person['id'])['display_name'], 'James')

    def test_dm_without_room_name_uses_peer_never_owner_or_own_ghost(self):
        inbox = self.inbox()
        own = ghost_mxid('line', 'Uown')
        inbox.mine.add(own)
        inbox.store.remember_own_names('line', ['Me Myself'])
        state = [bridge('github.com/highesttt/matrix-line-messenger', 'line', **{'com.beeper.room_type.v2': 'dm'}),
                 {'type': 'm.room.name', 'content': {'name': 'Me Myself'}},
                 member(inbox.owner, 'owner'), member(own, 'Me Myself'), member('@line_upeer:' + SERVER, 'James')]
        with patch.object(inbox, 'mx', return_value=state):
            meta = inbox.room_meta('!dm', {})
        self.assertEqual((meta['network'], meta['kind'], meta['label']), ('line', 'person', 'James'))
        state[1] = {'type': 'm.room.name', 'content': {'name': '+66 81 234 5678'}}
        with patch.object(inbox, 'mx', return_value=state):
            self.assertEqual(inbox.room_meta('!dm2', {})['label'], 'James')

    def test_personal_filtering_space_is_not_a_chat(self):
        inbox = self.inbox()
        state = [bridge('instagramgo', 'instagram', **{'com.beeper.room_type.v2': 'personal_filtering_space'})]
        with patch.object(inbox, 'mx', return_value=state):
            self.assertTrue(inbox.room_meta('!space', {})['space'])


class BackfillConfigTests(Base):
    def test_templates_enable_forward_backfill_and_keep_secrets_on_rerun(self):
        setup_connectors(self.root, EXTRA_NETWORKS)
        secrets_before = (self.root / 'unified' / 'connector-secrets.json').read_bytes()
        configs = {n: json.loads((self.root / n / 'config.yaml').read_text()) for n in EXTRA_NETWORKS}
        for name, conf in configs.items():
            self.assertTrue(conf['backfill']['enabled'], name)
            self.assertEqual((conf['backfill']['max_initial_messages'], conf['backfill']['max_catchup_messages']), (100, 500))
            self.assertFalse(conf['backfill']['queue']['enabled'])  # needs Beeper batch sending
            self.assertEqual(conf['backfill']['unread_hours_threshold'], 720)
        hs = configs['whatsapp']['network']['history_sync']
        self.assertTrue(hs['request_full_sync'])
        self.assertEqual(hs['max_initial_conversations'], -1)
        self.assertFalse(hs['backwards_on_demand'])
        # An existing install (old generated config, backfill off) is upgraded by the
        # next connector-init run without rotating any credential.
        old = configs['line']
        old['backfill']['enabled'] = False
        (self.root / 'line' / 'config.yaml').write_text(json.dumps(old))
        setup_connectors(self.root, EXTRA_NETWORKS)
        self.assertEqual(secrets_before, (self.root / 'unified' / 'connector-secrets.json').read_bytes())
        again = json.loads((self.root / 'line' / 'config.yaml').read_text())
        self.assertTrue(again['backfill']['enabled'])
        self.assertEqual(again['appservice']['as_token'], old['appservice']['as_token'])
        self.assertEqual(again['provisioning']['shared_secret'], old['provisioning']['shared_secret'])
        self.assertTrue(again['double_puppet']['secrets']['messenger.internal'].startswith('as_token:'))
        template_keys = set(json.loads((Path(__file__).resolve().parents[1] / 'plumbing' / 'line-template.json').read_text())['backfill'])
        self.assertEqual(set(again['backfill']), template_keys)  # no invented keys

    def test_telegram_initial_history_raised(self):
        conf = json.loads((self.root / 'telegram' / 'config.yaml').read_text())
        self.assertEqual((conf['backfill']['enabled'], conf['backfill']['max_initial_messages']), (True, 200))
        self.assertFalse(conf['backfill']['queue']['enabled'])


if __name__ == '__main__':
    unittest.main()
