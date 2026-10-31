import os, subprocess, sys, tempfile, threading, time, unittest
sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
os.environ['MESSENGER_WND_GUARD'] = '0'
import engine


class FakeEngine(engine.MarmotEngine):
    launches = 0
    def _launch(self):
        FakeEngine.launches += 1
        # A child that holds ~60 MB, standing in for a bloated wnd.
        self.daemon = subprocess.Popen([sys.executable, '-c', 'import time; b = bytearray(60 * 1024 * 1024); time.sleep(60)'])
        time.sleep(0.5)
    def _rpc(self, request, timeout=90):
        raise engine.EngineError('engine_unavailable', 'fake', 503)


class MemoryGuard(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.e = FakeEngine(self.tmp.name)
        self.e._launch(); self.e.unlocked = True
    def tearDown(self):
        if self.e.daemon and self.e.daemon.poll() is None: self.e.daemon.kill(); self.e.daemon.wait()
        self.tmp.cleanup()

    def test_under_limit_leaves_daemon_alone(self):
        pid = self.e.daemon.pid
        self.assertFalse(self.e.recycle_if_bloated(limit_mb=10_000))
        self.assertEqual(self.e.daemon.pid, pid)

    def test_bloated_daemon_is_replaced_and_engine_stays_ready(self):
        old = self.e.daemon
        self.assertGreater(self.e.daemon_memory_mb(), 40)
        self.assertTrue(self.e.recycle_if_bloated(limit_mb=40))
        self.assertIsNotNone(old.poll())
        self.assertNotEqual(self.e.daemon.pid, old.pid)
        self.assertEqual(self.e.status()['state'], 'ready')
        self.assertIsNone(self.e.daemon.poll())

    def test_waits_for_an_operation_in_flight(self):
        old = self.e.daemon; done = []
        def hold():
            with self.e.mutex: time.sleep(1.0); done.append(old.poll())
        t = threading.Thread(target=hold); t.start(); time.sleep(0.1)
        self.assertTrue(self.e.recycle_if_bloated(limit_mb=40)); t.join()
        self.assertEqual(done, [None])  # the daemon was still alive for the whole operation

    def test_locked_engine_is_not_relaunched(self):
        self.e.unlocked = False
        self.assertFalse(self.e.recycle_if_bloated(limit_mb=1))


if __name__ == '__main__':
    unittest.main()
