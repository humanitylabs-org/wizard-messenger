"""Repeat taps on one file never fetch it from the homeserver twice at once (issue 157)."""
from pathlib import Path
import tempfile
import threading
import time
import unittest
from unittest.mock import patch

import unified
from unified import UnifiedInbox

PDF = b'%PDF-1.7\n' + b'x' * 200_000


class SlowResponse:
    def __init__(self, data):
        self.data, self.headers = data, {'Content-Type': 'application/pdf'}

    def __enter__(self):
        return self

    def __exit__(self, *exc):
        return False

    def read(self, n):
        time.sleep(0.01)  # a slow homeserver: long enough for every tap to arrive while the first fetch runs
        chunk, self.data = self.data[:n], self.data[n:]
        return chunk


class MediaDownloadOnce(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.inbox = UnifiedInbox.__new__(UnifiedInbox)
        self.inbox.root = Path(self.tmp.name)
        self.inbox.matrix = 'http://homeserver.invalid'
        self.inbox.matrix_token = lambda: 'token'
        self.inbox.timing = lambda *a: None
        self.fetches = 0

    def tearDown(self):
        self.tmp.cleanup()

    def fake_urlopen(self, req, timeout=60):
        self.fetches += 1
        return SlowResponse(PDF)

    def test_concurrent_requests_for_one_file_fetch_it_once(self):
        got, errors = [], []

        def tap():
            try:
                blob = self.inbox.media_blob('mxc://example.org/abcDEF123', 'application/pdf', 'report.pdf')
                got.append(blob.path.read_bytes())
            except Exception as e:  # pragma: no cover - surfaced below
                errors.append(e)
        with patch.object(unified, 'urlopen', self.fake_urlopen):
            taps = [threading.Thread(target=tap) for _ in range(5)]
            for t in taps:
                t.start()
            for t in taps:
                t.join()
        self.assertEqual(errors, [])
        self.assertEqual(self.fetches, 1)
        self.assertEqual(got, [PDF] * 5)
        parts = [p.name for p in (self.inbox.root / 'media-cache').iterdir() if '.part-' in p.name]
        self.assertEqual(parts, [])

    def test_different_files_still_download(self):
        with patch.object(unified, 'urlopen', self.fake_urlopen):
            self.inbox.media_blob('mxc://example.org/one', 'application/pdf', 'a.pdf')
            self.inbox.media_blob('mxc://example.org/two', 'application/pdf', 'b.pdf')
        self.assertEqual(self.fetches, 2)


if __name__ == '__main__':
    unittest.main()
