"""Received videos are kept with their index (moov) in front, so they start streaming at once (issue 343)."""
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch

import unified
from unified import UnifiedInbox, faststart, mp4_atoms


def atom(kind, body):
    return (8 + len(body)).to_bytes(4, 'big') + kind + body


def table(kind, offsets):
    wide = 8 if kind == b'co64' else 4
    return atom(kind, b'\0\0\0\0' + len(offsets).to_bytes(4, 'big') + b''.join(o.to_bytes(wide, 'big') for o in offsets))


def slow_mp4(kind=b'stco', extra_after=b''):
    """ftyp, free, mdat (two chunks), moov at the end: the layout a phone recorder writes."""
    ftyp = atom(b'ftyp', b'isom\0\0\x02\0isomiso2mp41')
    free = atom(b'free', b'')
    chunks = [b'A' * 1000, b'B' * 500]
    mdat_at = len(ftyp) + len(free)
    offsets = [mdat_at + 8, mdat_at + 8 + len(chunks[0])]
    mdat = atom(b'mdat', b''.join(chunks))
    stbl = atom(b'stbl', atom(b'stsd', b'\0' * 8) + table(kind, offsets))
    trak = atom(b'trak', atom(b'tkhd', b'\0' * 84) + atom(b'mdia', atom(b'minf', stbl)))
    moov = atom(b'moov', atom(b'mvhd', b'\0' * 100) + trak)
    return ftyp + free + mdat + moov + extra_after, chunks


def chunk_offsets(data):
    """Every stco/co64 offset in the file."""
    out, kinds = [], (b'stco', b'co64')
    for kind in kinds:
        at = data.find(kind)
        while at != -1:
            wide = 8 if kind == b'co64' else 4
            count = int.from_bytes(data[at + 8:at + 12], 'big')
            out += [int.from_bytes(data[at + 12 + i * wide:at + 12 + (i + 1) * wide], 'big') for i in range(count)]
            at = data.find(kind, at + 1)
    return out


def order(path):
    with open(path, 'rb') as f:
        return [a[0] for a in mp4_atoms(f, Path(path).stat().st_size)]


class Faststart(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.dir = Path(self.tmp.name)

    def tearDown(self):
        self.tmp.cleanup()

    def check(self, data, chunks):
        src, dst = self.dir / 'in.mp4', self.dir / 'out.mp4'
        src.write_bytes(data)
        self.assertTrue(faststart(src, dst))
        out = dst.read_bytes()
        self.assertEqual(len(out), len(data))
        self.assertEqual(order(dst)[:4], [b'ftyp', b'free', b'moov', b'mdat'])
        self.assertLess(out.index(b'moov'), out.index(b'mdat'))
        # Every chunk offset still points at the same media bytes.
        for offset, chunk in zip(chunk_offsets(out), chunks):
            self.assertEqual(out[offset:offset + len(chunk)], chunk)
        return out

    def test_moov_moves_in_front_and_offsets_follow(self):
        data, chunks = slow_mp4()
        self.check(data, chunks)

    def test_64_bit_offsets_follow_too(self):
        data, chunks = slow_mp4(b'co64')
        self.check(data, chunks)

    def test_atoms_after_moov_are_kept(self):
        data, chunks = slow_mp4(extra_after=atom(b'udta', b'xyz'))
        out = self.check(data, chunks)
        self.assertEqual(order(self.dir / 'out.mp4')[-1], b'udta')
        self.assertTrue(out.endswith(atom(b'udta', b'xyz')))

    def test_an_already_fast_file_is_left_alone(self):
        data, chunks = slow_mp4()
        src, dst, again = self.dir / 'in.mp4', self.dir / 'fast.mp4', self.dir / 'again.mp4'
        src.write_bytes(data)
        self.assertTrue(faststart(src, dst))
        self.assertFalse(faststart(dst, again))
        self.assertFalse(again.exists())

    def test_fragmented_broken_and_non_mp4_files_are_left_alone(self):
        data, _ = slow_mp4()
        cases = {
            'fragmented': data + atom(b'moof', b'') + atom(b'mdat', b'C'),
            'cut': data[:-10],
            'webm': b'\x1a\x45\xdf\xa3' + b'\0' * 100,
            'compressed': data.replace(b'trak', b'cmov'),
        }
        for name, body in cases.items():
            src, dst = self.dir / (name + '.in'), self.dir / (name + '.out')
            src.write_bytes(body)
            self.assertFalse(faststart(src, dst), name)
            self.assertFalse(dst.exists(), name)


class Response:
    def __init__(self, data):
        self.data, self.headers = data, {'Content-Type': 'video/mp4'}

    def __enter__(self):
        return self

    def __exit__(self, *exc):
        return False

    def read(self, n):
        chunk, self.data = self.data[:n], self.data[n:]
        return chunk


class BoxKeepsVideosFast(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.inbox = UnifiedInbox.__new__(UnifiedInbox)
        self.inbox.root = Path(self.tmp.name)
        self.inbox.matrix = 'http://homeserver.invalid'
        self.inbox.matrix_token = lambda: 'token'
        self.inbox.timing = lambda *a: None

    def tearDown(self):
        self.tmp.cleanup()

    def test_a_received_video_is_cached_with_moov_first(self):
        data, chunks = slow_mp4()
        with patch.object(unified, 'urlopen', lambda req, timeout=60: Response(data)):
            blob = self.inbox.media_blob('mxc://example.org/vid123', 'video/mp4', 'clip.mp4')
        out = blob.path.read_bytes()
        self.assertEqual(blob.mime, 'video/mp4')
        self.assertLess(out.index(b'moov'), out.index(b'mdat'))
        for offset, chunk in zip(chunk_offsets(out), chunks):
            self.assertEqual(out[offset:offset + len(chunk)], chunk)
        self.assertEqual(sorted(p.name for p in blob.path.parent.iterdir() if '.part-' in p.name), [])

    def test_thumbnails_and_other_files_are_untouched(self):
        data, _ = slow_mp4()
        with patch.object(unified, 'urlopen', lambda req, timeout=60: Response(data)):
            blob = self.inbox.media_blob('mxc://example.org/vid123', 'video/mp4', 'clip.mp4', raw_thumb=True)
        self.assertEqual(blob.path.read_bytes(), data)


if __name__ == '__main__':
    unittest.main()
