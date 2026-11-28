"""Issue 483: the chat list reads each chat's newest line through the message index, never every stored message.
The old whole-table query is kept here as the reference: the new people() must give exactly the same rows."""
import json
import tempfile
import unittest
from pathlib import Path

import unified
from unified import PeopleStore, OWN_SENDER, picture_tag, unavailable_media


def legacy_people(self, kind='person', chats=True, ids=None):
    """PeopleStore.people() as it was before issue 483 (ROW_NUMBER over every message)."""
    started = self.started() if chats else {}
    waiting = (self.draft_people() if started and kind == 'person' and self.draft_people else set()) or set()
    with self.db() as db:
        persons = {r['id']: dict(r) for r in db.execute('SELECT * FROM person')}
        idents = {}
        for r in db.execute('SELECT * FROM identity WHERE kind=? ORDER BY last_used DESC,id', (kind,)):
            idents.setdefault(r['person_id'], []).append(dict(r))
        labels = {}
        for r in db.execute('SELECT DISTINCT i.person_id,l.label FROM room_label l JOIN identity i ON i.id=l.identity_id ORDER BY l.label'):
            labels.setdefault(r[0], []).append(r[1])
        last = {r['person_id']: r for r in db.execute(
            'SELECT * FROM (SELECT m.original,m.outgoing,m.sender,m.timestamp,m.msgtype,m.deleted,m.media,i.person_id,m.identity_id,'
            'ROW_NUMBER() OVER (PARTITION BY i.person_id ORDER BY m.timestamp DESC,m.id DESC) rn '
            'FROM message m JOIN identity i ON i.id=m.identity_id WHERE i.kind=? AND m.deleted=0) WHERE rn=1', (kind,))}
        unread = dict(db.execute(
            'SELECT i.person_id,COUNT(*) FROM message m JOIN identity i ON i.id=m.identity_id '
            'WHERE i.kind=? AND m.outgoing=0 AND m.deleted=0 AND m.timestamp>i.last_read_ts GROUP BY i.person_id', (kind,)).fetchall())
        mentions = dict(db.execute('SELECT i.person_id,COUNT(*) FROM message m JOIN identity i ON i.id=m.identity_id '
                                   'WHERE i.kind=? AND m.outgoing=0 AND m.deleted=0 AND m.mentioned=1 AND m.timestamp>i.last_read_ts GROUP BY i.person_id', (kind,)))
        pictures = self.room_pictures(db)
        status = self.status_identities(db)
        remote = self.room_accounts(db) if kind == 'person' else {}
    result = []
    for pid, ident in idents.items():
        if pid not in persons or (ids is not None and pid not in ids):
            continue
        if chats and pid not in last and not (pid in started and (kind == 'group' or pid in waiting)):
            continue
        p = dict(persons[pid], identities=ident, labels=labels.get(pid, []))
        pic = next((pictures[i['address']] for i in ident if pictures.get(i['address'])), None)
        p['avatar'] = picture_tag(pic)
        if remote:
            p['accounts'] = [a for i in ident for a in remote.get(i['address'], [])]
        if pid in last:
            r = last[pid]
            media = json.loads(r['media']) if r['media'] else {}
            p['last'] = {'text': '' if r['deleted'] else r['original'][:140], 'outgoing': bool(r['outgoing']), 'sender': OWN_SENDER if r['outgoing'] else r['sender'], 'timestamp': r['timestamp']}
            if r['msgtype'] != 'm.text' or r['deleted'] or media.get('voice'):
                p['last'].update(msgtype=r['msgtype'], deleted=bool(r['deleted']), voice=bool(media.get('voice')))
                if media.get('gif') or (r['msgtype'] == 'm.image' and media.get('mime') == 'image/gif'):
                    p['last']['gif'] = True
                if media.get('sticker'):
                    p['last']['sticker'] = True
            elif not r['deleted']:
                gone = unavailable_media(r['original'], r['timestamp'], r['identity_id'] in status)
                if gone:
                    p['last'].update(text=gone[1][:140], unavailable=gone[0])
            p['unread'] = unread.get(pid, 0)
            p['unread_mentions'] = mentions.get(pid, 0)
            p['last_read_ts'] = max(i['last_read_ts'] for i in ident)
            p['peer_read_ts'] = max(i['peer_read_ts'] for i in ident)
        elif chats:
            p['last'] = {'text': '', 'outgoing': False, 'sender': '', 'timestamp': started[pid]}
            p.update(unread=0, unread_mentions=0, started=True,
                     last_read_ts=max(i['last_read_ts'] for i in ident), peer_read_ts=max(i['peer_read_ts'] for i in ident))
        result.append(p)
    if chats:
        result.sort(key=lambda p: -p['last']['timestamp'])
    else:
        result.sort(key=lambda p: p['display_name'].casefold())
    return result


class ChatListIndexTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.store = s = PeopleStore(Path(self.tmp.name) / 'people.db')
        s.remember_own_names('whatsapp', ['Owner'])
        def meta(room, m):
            with s.db() as db:
                db.execute('INSERT OR REPLACE INTO room_meta VALUES (?,?)', (room, json.dumps(m)))
        add = s.add_message
        # People: plain, merged across two networks (newest line on the second network, a timestamp tie), muted.
        amy = s.identity('telegram', '!amy', 'Amy')
        add('$a1', amy, '@amy', False, 'hi', 100)
        add('$a2', amy, 'me', True, 'hello', 200)
        add('$a25', amy, '@amy', False, 'are you there', 250)
        add('$a3', amy, '@amy', False, 'new one', 300, mentions=['@owner'], mentioned=True)
        mia = s.identity('telegram', '!mia', 'Mia')
        mia2 = s.identity('whatsapp', '!mia-wa', 'Mia')
        with s.db() as db:
            db.execute('UPDATE identity SET person_id=? WHERE id=?', (mia['person_id'], mia2['id']))
            db.execute('DELETE FROM person WHERE id=?', (mia2['person_id'],))
        add('$m1', mia, '@mia', False, 'tg line', 400)
        add('$m2', mia2, '@mia', False, 'wa line a', 500)
        add('$m3', mia2, '@mia', False, 'wa line b', 500)  # same timestamp across both networks: the largest message id ($m4) wins
        add('$m4', mia, '@mia', False, 'tg same time', 500)
        # Newest line deleted: the one before it shows. A chat whose every line is deleted is not listed.
        dan = s.identity('signal', '!dan', 'Dan')
        add('$d1', dan, '@dan', False, 'kept', 50)
        add('$d2', dan, '@dan', False, 'gone', 60)
        s.redact('$d2')
        gone = s.identity('signal', '!gone', 'Gone')
        add('$g0', gone, '@g', False, 'x', 70)
        s.redact('$g0')
        # Media last lines: voice, gif, sticker, an image.
        for n, (msgtype, media) in enumerate([('m.audio', {'voice': True}), ('m.image', {'mime': 'image/gif'}),
                                              ('m.image', {'sticker': True}), ('m.image', {'mime': 'image/jpeg'})]):
            who = s.identity('whatsapp', '!media%d' % n, 'Media %d' % n)
            add('$media%d' % n, who, '@w', False, 'file', 600 + n, msgtype=msgtype, media=media)
        # WhatsApp Status chat with a photo-unavailable line, a room picture and a remote account.
        status = s.identity('whatsapp', '!status', unified.STATUS_TITLE)
        meta('!status', {'network': 'whatsapp', 'kind': 'person', 'label': unified.STATUS_TITLE, 'avatar': 'mxc://x/pic'})
        add('$s1', status, '@w', False, '[photo unavailable]', 700)
        meta('!amy', {'network': 'telegram', 'kind': 'person', 'label': 'Amy', 'avatar': 'mxc://x/amy',
                      'names': {'@telegram_123:messenger.internal': 'Amy'}})
        # Read marks: Amy read up to 150 (two unread, one mention), Mia read up to 400 on one network only.
        with s.db() as db:
            db.execute('UPDATE identity SET last_read_ts=150, peer_read_ts=120 WHERE id=?', (amy['id'],))
            db.execute('UPDATE identity SET last_read_ts=400 WHERE id=?', (mia['id'],))
            db.execute('INSERT INTO room_label VALUES (?,?)', (amy['id'], 'Work'))
            db.execute('INSERT INTO room_label VALUES (?,?)', (mia2['id'], 'Family'))
            db.execute('INSERT INTO room_label VALUES (?,?)', (mia['id'], 'Work'))
        # Started chats: one with a waiting draft (listed), one without (not listed), a new group (always listed).
        new = s.identity('whatsapp', '!new', 'New Contact')
        quiet = s.identity('whatsapp', '!quiet', 'Quiet Contact')
        s.mark_started(new['person_id'])
        s.mark_started(quiet['person_id'])
        s.draft_people = lambda: {new['person_id']}
        fresh_group = s.identity('signal', '!newgroup', 'New Group', 'group')
        s.mark_started(fresh_group['person_id'])
        # Groups with unread, mentions and a label; one silent contact.
        fam = s.identity('signal', '!fam', 'Family', 'group')
        add('$f1', fam, '@x', False, 'dinner?', 800, mentions=['@owner'], mentioned=True)
        add('$f2', fam, 'me', True, 'yes', 810)
        add('$f3', fam, '@y', False, 'see you', 820, mentions=['@owner'], mentioned=True)
        with s.db() as db:
            db.execute('INSERT INTO room_label VALUES (?,?)', (fam['id'], 'Family'))
        s.identity('telegram', '!silent', 'Silent')
        self.ids = {'amy': amy['person_id'], 'mia': mia['person_id'], 'dan': dan['person_id'], 'new': new['person_id'],
                    'fam': fam['person_id'], 'gone': gone['person_id']}

    def test_same_rows_as_the_old_whole_table_query(self):
        for kind in ('person', 'group'):
            for chats in (True, False):
                self.assertEqual(self.store.people(kind, chats), legacy_people(self.store, kind, chats), (kind, chats))
        names = [p['display_name'] for p in self.store.people()]
        self.assertIn('New Contact', names)
        self.assertNotIn('Quiet Contact', names)
        self.assertNotIn('Gone', names)
        mia = next(p for p in self.store.people() if p['id'] == self.ids['mia'])
        self.assertEqual((mia['last']['text'], mia['unread'], mia['labels']), ('tg same time', 3, ['Family', 'Work']))
        amy = next(p for p in self.store.people() if p['id'] == self.ids['amy'])
        self.assertEqual((amy['unread'], amy['unread_mentions']), (2, 1))

    def test_a_live_update_gets_only_the_chats_it_touched(self):
        for kind in ('person', 'group'):
            for chosen in ({'amy', 'new'}, {'mia', 'dan', 'gone'}, {'fam'}, set(self.ids)):
                ids = {self.ids[k] for k in chosen}
                # The old list left `accounts` out when no room in the whole store had one; it is now always there.
                want = [dict(p, accounts=p.get('accounts', [])) if kind == 'person' else p for p in legacy_people(self.store, kind, True, ids)]
                self.assertEqual(self.store.people(kind, True, ids), want, (kind, chosen))
            self.assertEqual(self.store.people(kind, True, set()), [])

    def test_no_query_walks_the_whole_message_table(self):
        statements = []
        conn = self.store._conn
        conn.set_trace_callback(statements.append)
        try:
            self.store.people('person')
            self.store.people('group', True, {self.ids['fam']})
        finally:
            conn.set_trace_callback(None)
        plans = []
        with self.store.db() as db:
            for sql in statements:
                if sql.lstrip().upper().startswith('SELECT') and 'message' in sql:
                    plans += [r[3] for r in db.execute('EXPLAIN QUERY PLAN ' + sql)]
        self.assertTrue(plans)
        self.assertFalse([p for p in plans if p.startswith('SCAN m')], plans)
        self.assertIn('SEARCH m USING COVERING INDEX message_unread (identity_id=? AND outgoing=? AND deleted=? AND timestamp>?)', plans)


if __name__ == '__main__':
    unittest.main()
