"""Issue 356: Messenger was slow to open because every DM list, message read and unread count asked the messaging
daemon once per chat, one call at a time behind one engine-wide lock. A fake daemon with 30 DMs counts the calls."""
import os
import tempfile
import threading
import time
import unittest
from unittest.mock import patch

import engine as engine_module
from engine import MarmotEngine
from private_unread import PrivateUnread


def gid(n):
    return '%032x' % (n + 1)


def mid(n):
    return '%064x' % (n + 1)


class FakeDaemonEngine(MarmotEngine):
    """The real engine with the daemon replaced: `_execute` answers like wnd and records every call."""

    def __init__(self, directory, chats=30):
        with patch.dict(os.environ, {'XDG_RUNTIME_DIR': directory + '/runtime', 'MESSENGER_WND_GUARD': '0'}):
            super().__init__(directory + '/data', ['wss://relay.invalid'])
        self.calls = []
        self.calls_lock = threading.Lock()
        self.slow = 0.0
        self.newest = {gid(n): (mid(n), 'received') for n in range(chats)}

    def status(self):
        return {'state': 'ready'}

    def _execute(self, command, **kwargs):
        name = next(iter(command)) if isinstance(command, dict) else command
        inner = command[name] if isinstance(command, dict) else None
        sub = inner.get('command') if isinstance(inner, dict) else None
        label = name + ('.' + (sub if isinstance(sub, str) else next(iter(sub))) if sub else '')
        with self.calls_lock:
            self.calls.append(label)
        if self.slow:
            time.sleep(self.slow)
        if label == 'Groups.List':
            return {'groups': [{'group_id': g, 'name': ''} for g in self.newest]}
        if label == 'Groups.Members':
            g = sub['Members']['group_id']
            return {'members': [{'account_id': 'a' * 64, 'npub': 'npub1me', 'display_name': 'Me'},
                                {'account_id': g * 2, 'npub': 'npub1' + g, 'display_name': 'Friend ' + g[-2:]}]}
        if label == 'Messages.Timeline':
            g = sub['Timeline']['command']['List']['group_id']
            message_id, direction = self.newest[g]
            sender = 'a' * 64 if direction == 'sent' else g * 2
            return {'account_id': 'a' * 64, 'messages': [{
                'message_id': message_id, 'group_id': g, 'kind': 9, 'plaintext': 'hi', 'timeline_at': 1,
                'from': sender, 'direction': direction}]}
        if label == 'Messages.Send':
            return {'message_ids': ['f' * 64], 'published': 1}
        raise AssertionError('unexpected daemon call ' + label)

    def take(self):
        with self.calls_lock:
            calls, self.calls = self.calls, []
        return calls


class ReadCache(unittest.TestCase):
    def setUp(self):
        self.dir = tempfile.TemporaryDirectory(dir=os.environ.get('TMPDIR'))
        self.engine = FakeDaemonEngine(self.dir.name)

    def tearDown(self):
        self.dir.cleanup()

    def test_dm_list_makes_one_daemon_call_once_warm(self):
        first = self.engine.dms()['dms']
        self.assertEqual(len(first), 30)
        self.assertEqual(self.engine.take().count('Groups.Members'), 30)  # first open: each chat's members once
        again = self.engine.dms()['dms']
        self.assertEqual(self.engine.take(), ['Groups.List'])  # nothing changed: one call, not 31
        self.assertEqual(again, first)
        self.assertEqual(again[3]['members'][1]['display_name'], 'Friend ' + gid(3)[-2:])

    def test_a_message_read_is_one_daemon_call_once_warm(self):
        self.engine.dms(); self.engine.take()
        rows = self.engine.messages(gid(5), 50)['messages']
        self.assertEqual(len(rows), 1)
        self.assertEqual(self.engine.take(), ['Messages.Timeline'])

    def test_a_kept_answer_is_not_changed_by_its_reader(self):
        members = self.engine._dm_members(gid(1))
        members[0]['display_name'] = 'changed'
        self.assertEqual(self.engine._dm_members(gid(1))[0]['display_name'], 'Me')

    def test_an_old_member_list_is_served_and_refreshed_in_the_background(self):
        self.engine.dms(); self.engine.take()
        with self.engine._cache_lock:
            for g, (fresh, members) in list(self.engine._members.items()):
                self.engine._members[g] = (0.0, members)
        started = time.monotonic()
        self.engine.dms()  # answered from the kept members
        self.assertLess(time.monotonic() - started, 1.0)
        deadline = time.monotonic() + 5
        while time.monotonic() < deadline:
            with self.engine._cache_lock:
                if not self.engine._refreshing and all(f > time.monotonic() for f, _ in self.engine._members.values()):
                    break
            time.sleep(0.02)
        with self.engine._cache_lock:
            self.assertTrue(all(fresh > time.monotonic() for fresh, _ in self.engine._members.values()))
        self.assertEqual(self.engine.take().count('Groups.Members'), 30)  # refreshed off the request

    def test_a_not_a_dm_answer_is_kept_too(self):
        real = self.engine._execute
        def group_of_three(command, **kwargs):
            if isinstance(command, dict) and 'Groups' in command and 'Members' in command['Groups']['command']:
                self.engine.calls.append('Groups.Members')
                return {'members': [{'npub': 'x'}, {'npub': 'y'}, {'npub': 'z'}]}
            return real(command, **kwargs)
        with patch.object(self.engine, '_execute', side_effect=group_of_three):
            for _ in range(3):
                with self.assertRaises(engine_module.EngineError) as e:
                    self.engine._dm_members(gid(2))
                self.assertEqual(e.exception.code, 'not_a_dm')
        self.assertEqual(self.engine.take(), ['Groups.Members'])

    def test_lock_forgets_the_kept_members(self):
        self.engine._dm_members(gid(1))
        self.engine.unlocked = False
        with patch('subprocess.run'):
            self.engine.lock()
        self.assertEqual(self.engine._members, {})


class UnreadFromTheSnapshot(unittest.TestCase):
    def setUp(self):
        self.dir = tempfile.TemporaryDirectory(dir=os.environ.get('TMPDIR'))
        self.engine = FakeDaemonEngine(self.dir.name)
        self.unread = PrivateUnread(os.path.join(self.dir.name, 'private-seen.json'))

    def tearDown(self):
        self.dir.cleanup()

    def test_the_unread_count_makes_no_extra_daemon_calls(self):
        self.engine.dms()  # the view opened: the DM list is warm
        self.engine.take()
        self.assertEqual(self.unread.count(self.engine), 30)
        first = self.engine.take()
        self.assertEqual(first.count('Groups.List'), 1)
        self.assertEqual(first.count('Groups.Members'), 0)  # was 30 more before (members on every read)
        self.assertEqual(first.count('Messages.Timeline'), 30)
        for _ in range(5):
            self.assertEqual(self.unread.count(self.engine), 30)
        self.assertEqual(self.engine.take(), [])  # 0 extra calls while nothing changed
        # Opening a chat marks it seen: the next count still makes no daemon call.
        self.unread.mark({'marks': [{'group': gid(0), 'seen': mid(0), 'quiet': False},
                                    {'group': gid(1), 'seen': None, 'quiet': True}]}, engine_module.group_id)
        self.assertEqual(self.unread.count(self.engine), 28)
        self.assertEqual(self.engine.take(), [])

    def test_a_newer_message_the_view_marked_counts_as_read_at_once(self):
        self.unread.count(self.engine)
        self.engine.newest[gid(4)] = (mid(99), 'received')  # arrived after the snapshot; the view showed it
        self.unread.mark({'marks': [{'group': gid(4), 'seen': mid(99), 'quiet': False}]}, engine_module.group_id)
        self.assertEqual(self.unread.count(self.engine), 29)

    def test_an_old_snapshot_is_answered_at_once_and_read_again_in_the_background(self):
        self.unread.count(self.engine); self.engine.take()
        self.engine.newest[gid(7)] = (mid(7), 'sent')  # the owner answered from another device
        self.engine.slow = 0.05  # 31 calls would take over 1.5 s
        self.unread.cache = (self.unread.cache[0], 0.0)
        started = time.monotonic()
        self.assertEqual(self.unread.count(self.engine), 30)  # the old number, without waiting
        self.assertLess(time.monotonic() - started, 0.5)
        deadline = time.monotonic() + 10
        while self.unread.refreshing and time.monotonic() < deadline:
            time.sleep(0.05)
        self.assertEqual(self.unread.count(self.engine), 29)
        self.assertEqual(self.unread.last, 29)


class ReadsRunSideBySide(unittest.TestCase):
    def setUp(self):
        self.dir = tempfile.TemporaryDirectory(dir=os.environ.get('TMPDIR'))
        self.engine = FakeDaemonEngine(self.dir.name, chats=4)
        self.engine.dms(); self.engine.take()

    def tearDown(self):
        self.dir.cleanup()

    def test_reads_do_not_queue_behind_each_other(self):
        self.engine.slow = 0.4
        threads = [threading.Thread(target=self.engine.messages, args=(gid(n), 20)) for n in range(4)]
        started = time.monotonic()
        for t in threads: t.start()
        for t in threads: t.join()
        self.assertLess(time.monotonic() - started, 1.2)  # one after another it would be 1.6 s

    def test_a_write_waits_for_running_reads_and_reads_wait_for_a_write(self):
        order = []
        self.engine.slow = 0.3
        reader = threading.Thread(target=lambda: (self.engine.messages(gid(0), 20), order.append('read')))
        reader.start(); time.sleep(0.1)
        self.engine.send(gid(1), {'text': 'hello'}); order.append('write')
        reader.join()
        self.assertEqual(order, ['read', 'write'])
        # While a write holds the engine (e.g. a daemon restart), a read waits for it.
        order.clear(); self.engine.slow = 0
        with self.engine._writing():
            later = threading.Thread(target=lambda: (self.engine.dms(), order.append('read')))
            later.start(); time.sleep(0.2)
            order.append('write done')
        later.join()
        self.assertEqual(order, ['write done', 'read'])

    def test_a_read_inside_a_write_and_a_write_inside_a_read_do_not_deadlock(self):
        done = []
        def nested():
            with self.engine._writing():
                self.engine.dms()
            with self.engine._reading():
                with self.engine._writing():
                    done.append(True)
        t = threading.Thread(target=nested); t.start(); t.join(5)
        self.assertEqual(done, [True])


if __name__ == '__main__':
    unittest.main()
