"""Issue 209 (switch box-translate): the translator that runs on the box, with no text going to Tinfoil."""
import hashlib
import io
import json
import tempfile
import time
import unittest
import zipfile
from pathlib import Path
from unittest.mock import patch

import private_translation as pt
import translation


def package(inner='translate-th_en-1_9', extra=None):
    buf = io.BytesIO()
    with zipfile.ZipFile(buf, 'w') as z:
        z.writestr(inner + '/sentencepiece.model', b'spm')
        z.writestr(inner + '/model/model.bin', b'bin')
        z.writestr(inner + '/metadata.json', '{}')
        for name, data in (extra or {}).items():
            z.writestr(name, data)
    return buf.getvalue()


class Hyp:
    def __init__(self, tokens): self.hypotheses = [tokens]


class FakeTranslator:
    calls = []
    def __init__(self, folder, **kw): self.folder = folder
    def translate_batch(self, batch, **kw):
        FakeTranslator.calls.append(batch)
        return [Hyp(['\u2581EN:'] + ['\u2581' + ''.join(t)]) for t in batch]


class FakeTokenizer:
    def __init__(self, model_file): self.model_file = model_file
    def encode(self, text, out_type=str): return [text]


class FakeCT2:
    Translator = FakeTranslator


class FakeSPM:
    SentencePieceProcessor = FakeTokenizer


def runtime():
    return FakeCT2, FakeSPM


class EngineTest(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.urls = []
        self.blob = package()

    def fetch(self, url):
        self.urls.append(url)
        return io.BytesIO(self.blob)

    def engine(self):
        return pt.Engine(self.tmp.name, fetch=self.fetch, runtime=runtime)

    def wait(self, eng):
        for _ in range(200):
            if not eng.downloading:
                return
            time.sleep(0.01)

    def test_first_use_downloads_both_ways_then_translates_on_the_box(self):
        eng = self.engine()
        digest = hashlib.sha256(self.blob).hexdigest()
        with patch.dict(pt.MODELS, {('th', 'en'): ('th.argosmodel', digest), ('en', 'th'): ('en.argosmodel', digest)}):
            first = pt.translate('สวัสดี', 'en', 'th', eng=eng)
            self.assertTrue(first['preparing'])
            self.assertIn('Thai translator', first['error'])
            self.assertEqual(first['text'], 'สวัสดี')
            self.wait(eng)
            self.assertEqual(sorted(self.urls), [pt.BASE + 'en.argosmodel', pt.BASE + 'th.argosmodel'])
            self.assertTrue((Path(self.tmp.name) / 'th_en' / 'model' / 'model.bin').is_file())
            self.assertTrue((Path(self.tmp.name) / 'en_th' / 'sentencepiece.model').is_file())
            out = pt.translate('สวัสดี\nขอบคุณ', 'en', 'th', eng=eng)
            self.assertEqual(out, {'text': 'EN: สวัสดี\nEN: ขอบคุณ', 'error': None})
            self.assertEqual(pt.translate('Hello', 'th', None, eng=eng)['text'], 'EN: Hello')
        self.assertEqual(len(self.urls), 2)  # never downloaded again

    def test_wrong_checksum_is_never_used(self):
        eng = self.engine()
        with patch.dict(pt.MODELS, {('th', 'en'): ('th.argosmodel', '0' * 64), ('en', 'th'): ('en.argosmodel', '0' * 64)}):
            for _ in range(3):
                pt.translate('สวัสดี', 'en', 'th', eng=eng)
                self.wait(eng)
            self.assertFalse(eng.ready(('th', 'en')))
            out = pt.translate('สวัสดี', 'en', 'th', eng=eng)
            self.assertNotIn('preparing', out)
            self.assertIn('not available', out['error'])
        self.assertEqual(list(Path(self.tmp.name).iterdir()), [])

    def test_archive_paths_outside_the_folder_are_refused(self):
        self.blob = package(extra={'../escape.txt': 'x'})
        eng = self.engine()
        digest = hashlib.sha256(self.blob).hexdigest()
        with patch.dict(pt.MODELS, {('th', 'en'): ('th.argosmodel', digest)}):
            with self.assertRaises(pt.Unavailable):
                eng.download(('th', 'en'))
        self.assertFalse((Path(self.tmp.name).parent / 'escape.txt').exists())
        self.assertFalse(eng.ready(('th', 'en')))

    def test_source_comes_from_the_chat_or_a_certain_script(self):
        self.assertEqual(pt.guess_source('สวัสดี'), 'th')
        self.assertEqual(pt.guess_source('こんにちは'), 'ja')
        self.assertEqual(pt.guess_source('你好'), 'zh')
        self.assertIsNone(pt.guess_source('Hola'))
        self.assertIn('could not tell', pt.translate('Hola', 'en', None, eng=self.engine())['error'])
        self.assertIn('not available', pt.translate('Hola', 'en', 'ko', eng=self.engine())['error'])

    def test_sentences_keep_lines(self):
        self.assertEqual(pt.sentences('Hi! Are you free?\n\nSee you.'), [['Hi!', 'Are you free?'], [], ['See you.']])
        self.assertEqual(pt.sentences('元気？今夜は'), [['元気？', '今夜は']])
        self.assertEqual(pt.detokenize(['\u2581Hi', '.', '\u2581You', '\u2581free?']), 'Hi. You free?')

    def test_models_are_pinned_for_every_messenger_language_both_ways(self):
        for code in translation.LANGUAGES:
            if code != 'en':
                self.assertIn((code, 'en'), pt.MODELS)
                self.assertIn(('en', code), pt.MODELS)
        for name, digest in pt.MODELS.values():
            self.assertRegex(digest, r'^[0-9a-f]{64}$')
            self.assertTrue(name.endswith('.argosmodel'))


class WorkerRouteTest(unittest.TestCase):
    def post(self, body):
        handler = translation.Handler.__new__(translation.Handler)
        raw = json.dumps(body).encode()
        handler.headers = {'Authorization': 'Bearer tok', 'Content-Length': str(len(raw))}
        handler.path = '/translate'
        handler.rfile = io.BytesIO(raw)
        handler.connection = type('C', (), {'settimeout': lambda self, t: None})()
        replies = []
        handler.reply = lambda status, out: replies.append((status, out))
        with patch.object(translation, 'Path') as P:
            P.return_value.read_text.return_value = json.dumps({'translation_token': 'tok'})
            handler.do_POST()
        return replies[0]

    def test_box_engine_never_calls_tinfoil(self):
        with patch.object(translation, 'urlopen') as tinfoil, \
             patch.object(pt, 'translate', return_value={'text': 'Hello', 'error': None}) as box:
            self.assertEqual(self.post({'text': 'สวัสดี', 'language': 'en', 'engine': 'box', 'source': 'th'}), (200, {'text': 'Hello', 'error': None}))
            box.assert_called_once_with('สวัสดี', 'en', 'th')
            self.assertEqual(self.post({'text': 'x', 'language': 'en', 'engine': 'box', 'source': 'xx'})[0], 400)
            tinfoil.assert_not_called()

    def test_without_the_box_engine_tinfoil_is_used_as_before(self):
        with patch.object(translation, 'translate', return_value={'text': 'Hello', 'error': None}) as tinfoil, \
             patch.object(pt, 'translate') as box:
            self.assertEqual(self.post({'text': 'สวัสดี', 'language': 'en'})[0], 200)
            tinfoil.assert_called_once_with('สวัสดี', 'en')
            box.assert_not_called()


if __name__ == '__main__':
    unittest.main()
