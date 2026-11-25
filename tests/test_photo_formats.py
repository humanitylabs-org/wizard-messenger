"""Issue 404: a received photo is always served in a form a phone can draw.

The LINE bridge uploads every photo as image.jpg / image/jpeg whatever its bytes are, so an iPhone's HEIC original
reached the box that way: the homeserver could not thumbnail it (thumb route 503, a grey "Photo unavailable" bubble) and
the full route handed the HEIC bytes on (labelled video/mp4), which no phone browser draws. These tests drive
UnifiedInbox.media with a homeserver that behaves like the box's Synapse did (thumbnail 400, download 200)."""
import hashlib
import io
import json
from pathlib import Path
import shutil
import tempfile
import unittest
from unittest.mock import patch
from urllib.error import HTTPError, URLError

import unified
from engine import EngineError
from unified import UnifiedInbox

FIXTURES = Path(__file__).parent / 'fixtures'


def picture(fmt, size=(1600, 1200)):
    from PIL import Image
    out = io.BytesIO()
    Image.new('RGB', size, (40, 120, 200)).save(out, fmt)
    return out.getvalue()


class Response:
    def __init__(self, data, mime):
        self.data, self.headers = data, {'Content-Type': mime}

    def __enter__(self):
        return self

    def __exit__(self, *exc):
        return False

    def read(self, n):
        chunk, self.data = self.data[:n], self.data[n:]
        return chunk


class Store:
    def __init__(self):
        self.rows = {}

    def message(self, message_id):
        return dict(self.rows[message_id])


class PhotoFormats(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.inbox = UnifiedInbox.__new__(UnifiedInbox)
        self.inbox.root = Path(self.tmp.name)
        self.inbox.matrix = 'http://homeserver.invalid'
        self.inbox.matrix_token = lambda: 'token'
        self.inbox.timing = lambda *a: None
        self.inbox.store = Store()
        self.files, self.thumbs, self.asked = {}, {}, []
        self.down = False

    def tearDown(self):
        self.tmp.cleanup()

    def urlopen(self, req, timeout=60):
        url = req.full_url
        self.asked.append(url)
        if self.down:
            raise URLError('homeserver away')
        media_id = url.split('?')[0].rsplit('/', 1)[1]
        if '/thumbnail/' in url:
            if media_id not in self.thumbs:  # Synapse: "Unable to generate thumbnails" -> 400
                raise HTTPError(url, 400, 'Bad Request', {}, io.BytesIO(b'{"errcode":"M_UNKNOWN"}'))
            return Response(self.thumbs[media_id], 'image/jpeg')
        return Response(self.files[media_id], 'image/jpeg')  # the bridge said image/jpeg for everything

    def line_photo(self, media_id, data, thumb=None):
        """A LINE photo as the box stores it: m.image, url only (no mime, no size)."""
        self.files[media_id] = data
        if thumb is not None:
            self.thumbs[media_id] = thumb
        self.inbox.store.rows['$' + media_id] = {'id': '$' + media_id, 'network': 'line', 'msgtype': 'm.image',
                                                  'media': json.dumps({'mxc': 'mxc://messenger.internal/' + media_id})}
        return '$' + media_id

    def get(self, message_id, kind=None):
        with patch.object(unified, 'urlopen', self.urlopen):
            blob = self.inbox.media(message_id, kind)
        return blob, blob.path.read_bytes()

    def assert_jpeg(self, blob, data, longest=None):
        from PIL import Image
        self.assertEqual(blob.mime, 'image/jpeg')
        self.assertTrue(blob.inline)
        self.assertEqual(data[:3], b'\xff\xd8\xff')
        with Image.open(io.BytesIO(data)) as img:
            img.load()
            if longest:
                self.assertEqual(max(img.size), longest)
            return img.size

    def test_an_ordinary_photo_is_served_as_it_was(self):
        jpeg, thumb = picture('JPEG'), picture('JPEG', (800, 600))
        pid = self.line_photo('plain', jpeg, thumb)
        self.assertEqual(self.get(pid, 'thumb')[1], thumb)
        self.assertEqual(self.get(pid)[1], jpeg)
        self.assertEqual(self.get(pid, 'view')[1], jpeg)  # already 1600 px JPEG: no copy needed

    def test_heic_from_an_iphone_is_served_as_jpeg_everywhere(self):
        if not shutil.which('heif-convert'):
            self.skipTest('heif-convert (libheif-examples) is in the image, not on this machine')
        heic = (FIXTURES / 'photo-96x64.heic').read_bytes()
        self.assertEqual(heic[4:12], b'ftypheic')
        pid = self.line_photo('heic', heic)
        full, data = self.get(pid)
        self.assertEqual(self.assert_jpeg(full, data), (96, 64))
        thumb, tdata = self.get(pid, 'thumb')
        self.assertEqual(self.assert_jpeg(thumb, tdata), (96, 64))  # small already: the JPEG is its own thumbnail
        view, vdata = self.get(pid, 'view')
        self.assert_jpeg(view, vdata)
        # Made once: a second request is served from the box's cache, the HEIC is not converted again.
        with patch.object(unified, 'photo_as_jpeg', side_effect=AssertionError('converted twice')):
            self.assertEqual(self.get(pid)[1], data)

    def test_a_format_browsers_cant_show_is_converted_and_thumbnailed_on_the_box(self):
        tiff = picture('TIFF', (2400, 1800))
        pid = self.line_photo('tiff', tiff)
        full, data = self.get(pid)
        self.assertEqual(self.assert_jpeg(full, data), (2400, 1800))
        thumb, tdata = self.get(pid, 'thumb')
        self.assert_jpeg(thumb, tdata, longest=unified.PHOTO_THUMB_SIDE)
        self.assertTrue(Path(str(thumb.path) + '.thumb').exists(), 'kept as a thumbnail for eviction')
        view, vdata = self.get(pid, 'view')
        self.assert_jpeg(view, vdata, longest=unified.PHOTO_VIEW_SIDE)

    def test_the_box_makes_the_thumbnail_when_the_homeserver_cant(self):
        png = picture('PNG', (3000, 2000))
        pid = self.line_photo('big', png)
        thumb, data = self.get(pid, 'thumb')
        self.assert_jpeg(thumb, data, longest=unified.PHOTO_THUMB_SIDE)
        self.assertEqual(self.get(pid)[1], png, 'a PNG is shown by every phone: the photo itself is untouched')

    def test_bytes_nothing_can_read_are_honestly_unavailable(self):
        pid = self.line_photo('junk', hashlib.sha256(b'x').digest() * 2000)
        for kind in (None, 'thumb', 'view'):
            with self.subTest(kind=kind), self.assertRaises(EngineError) as raised:
                self.get(pid, kind)
            self.assertEqual((raised.exception.code, raised.exception.status), ('media_unavailable', 410))

    def test_a_homeserver_that_is_away_is_still_a_try_again(self):
        pid = self.line_photo('away', picture('JPEG'))
        self.down = True
        for kind in (None, 'thumb'):
            with self.subTest(kind=kind), self.assertRaises(EngineError) as raised:
                self.get(pid, kind)
            self.assertEqual((raised.exception.code, raised.exception.status), ('upstream_unavailable', 503))
        self.down = False
        self.assertEqual(self.get(pid)[1][:3], b'\xff\xd8\xff', 'a retry asks the homeserver again')

    def test_gifs_and_other_media_keep_their_old_path(self):
        self.files['vid'] = b'\x00\x00\x00\x18ftypmp42' + b'\x00' * 100
        self.inbox.store.rows['$vid'] = {'id': '$vid', 'network': 'line', 'msgtype': 'm.video',
                                         'media': json.dumps({'mxc': 'mxc://messenger.internal/vid', 'mime': 'video/mp4'})}
        blob, data = self.get('$vid')
        self.assertEqual(blob.mime, 'video/mp4')
        self.assertEqual(data, self.files['vid'])


if __name__ == '__main__':
    unittest.main()
