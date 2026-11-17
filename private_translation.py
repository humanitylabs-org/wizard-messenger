"""Private translation on the box itself (issue 209, on for everyone).

Argos Translate's open models (OPUS data, CTranslate2 format) run here in the translation worker, so a phone whose
browser has no built-in translator still gets Auto-translate, the send preview and Translate without any text going
to Tinfoil. Only the model files are downloaded (once per language pair, about 70-130 MB each, pinned by sha256);
no message text ever leaves the box. Messenger only translates between English and one other language, so only the
English pairs are listed.

Runtime: ctranslate2 + sentencepiece live in their own folder in the image (/opt/argos); this module imports them
lazily, so the rest of the worker (and every test) runs without them.
"""
import glob
import hashlib
import os
import re
import shutil
import sys
import tempfile
import threading
import zipfile
from pathlib import Path
from urllib.request import Request, urlopen

BASE = 'https://argos-net.com/v1/'
# (source, target) -> (package file, sha256 of the .argosmodel zip). Checked when each is downloaded.
MODELS = {
    ('th', 'en'): ('translate-th_en-1_9.argosmodel', 'b6642c07389b156f568aa08c64140243bc1b1926f82df2559a2eae08316f84ce'),
    ('en', 'th'): ('translate-en_th-1_9.argosmodel', 'b0fd94eceb04b967b91c2c7d8d1f7b5493c25362e43027a52649242385d0b2a3'),
    ('ja', 'en'): ('translate-ja_en-1_1.argosmodel', '623e3477959a815eb0a5ef53e09079ae8f1f9d3bbcd230473baf28c03fb83335'),
    ('en', 'ja'): ('translate-en_ja-1_1.argosmodel', '16300cc4eaa85320520cabcf433b63d01be40ef6966251de72043a083408f716'),
    ('zh', 'en'): ('translate-zh_en-1_9.argosmodel', '62e7af5a3a48b530e47b7b3e5c78c2de79073ecd815750d2bf3ab35b4a67da2d'),
    ('en', 'zh'): ('translate-en_zh-1_9.argosmodel', '433e7c4f034d87fbe2353161e05f18646d7999452f801a4e1f0378522b9850ab'),
    ('es', 'en'): ('translate-es_en-1_0.argosmodel', '1b963aa0e0cb6e5ce874f0aa1a1949a19bc4d762e833532239a8834340f6b378'),
    ('en', 'es'): ('translate-en_es-1_0.argosmodel', 'd698d0ef87ad70d5d184b7fa6965905bf4368f09a2bb9ffb165a79bac96af0c4'),
    ('fr', 'en'): ('translate-fr_en-1_9.argosmodel', '3b3052fee6bb1e8e8e632a26a723eb2a2c7710dfe73ba61ffd9b83e85d4f14c1'),
    ('en', 'fr'): ('translate-en_fr-1_9.argosmodel', '3a65ed83364f4e7b06e30f9dd823db1934899ed3ce839e63f46dc7b09dc797b4'),
    ('de', 'en'): ('translate-de_en-1_3.argosmodel', 'becc2b0011f8249fcb89be9ecb75ba0d876b1fab93c28ee6ff0420936897d637'),
    ('en', 'de'): ('translate-en_de-1_3.argosmodel', '6cd847f0c06c9c66013e6b0932e07fd54a6d90894659c02bf6c5247b72fb25b1'),
}
FOLDERS = {pair: pair[0] + '_' + pair[1] for pair in MODELS}
AGENT = 'WizardMessenger/1 (+https://github.com/humanitylabs-org/wizard-messenger)'
NAMES = {'th': 'Thai', 'ja': 'Japanese', 'zh': 'Chinese', 'es': 'Spanish', 'fr': 'French', 'de': 'German', 'en': 'English'}
MAX_LOADED = 2  # one language both ways; each loaded model is about 100-250 MB of memory


class Preparing(Exception):
    """The pair's model is still downloading (first use). Nothing was translated and nothing was sent anywhere."""


class Unavailable(Exception):
    pass


# Sentence ends: Latin and CJK punctuation; Thai has none, so its lines go whole (chat lines are short).
_SENTENCE = re.compile(r'(?<=[.!?。！？])\s+|(?<=[。！？])')


def sentences(text):
    """Split into lines, then sentences, keeping the separators so the result reads like the original."""
    out = []
    for line in text.split('\n'):
        parts = [p for p in _SENTENCE.split(line) if p.strip()] if line.strip() else []
        out.append(parts)
    return out


def detokenize(tokens):
    return ''.join(tokens).replace('\u2581', ' ').strip()


def guess_source(text):
    """Script-based guess for an incoming message whose chat has no language set (only scripts that are certain)."""
    if re.search(r'[\u0e00-\u0e7f]', text):
        return 'th'
    if re.search(r'[\u3040-\u30ff]', text):
        return 'ja'
    if re.search(r'[\u4e00-\u9fff]', text):
        return 'zh'
    return None


def _runtime():
    for path in glob.glob('/opt/argos/lib/python3*/site-packages'):
        if path not in sys.path:
            sys.path.append(path)
    import ctranslate2  # noqa: E402
    import sentencepiece  # noqa: E402
    return ctranslate2, sentencepiece


class Engine:
    def __init__(self, root=None, fetch=None, runtime=None):
        self.root = Path(root or os.environ.get('TRANSLATION_MODELS', '/models'))
        # The model host refuses urllib's default User-Agent (403), so say who is asking.
        self.fetch = fetch or (lambda url: urlopen(Request(url, headers={'User-Agent': AGENT}), timeout=600))
        self.runtime = runtime or _runtime
        self.lock = threading.Lock()
        self.downloading = {}
        self.failed = {}
        self.loaded = {}  # pair -> (translator, tokenizer), oldest first

    def folder(self, pair):
        # The folder name comes from the pinned list, never from the request.
        if pair not in FOLDERS:
            raise Unavailable('pair')
        return self.root / FOLDERS[pair]

    def ready(self, pair):
        if pair not in FOLDERS:
            return False
        return (self.folder(pair) / 'model' / 'model.bin').is_file() and (self.folder(pair) / 'sentencepiece.model').is_file()

    def download(self, pair):
        name, digest = MODELS[pair]
        self.root.mkdir(parents=True, exist_ok=True)
        tmp = Path(tempfile.mkdtemp(prefix='.get-', dir=self.root))
        try:
            archive = tmp / 'model.zip'
            h = hashlib.sha256()
            with self.fetch(BASE + name) as response, archive.open('wb') as f:
                while True:
                    chunk = response.read(1 << 20)
                    if not chunk:
                        break
                    h.update(chunk)
                    f.write(chunk)
            if h.hexdigest() != digest:
                raise Unavailable('checksum')
            unpacked = tmp / 'unpacked'
            with zipfile.ZipFile(archive) as z:
                for member in z.namelist():
                    target = (unpacked / member).resolve()
                    if not str(target).startswith(str(unpacked.resolve()) + os.sep) and target != unpacked.resolve():
                        raise Unavailable('archive')
                z.extractall(unpacked)
            inner = next((p.parent for p in unpacked.rglob('sentencepiece.model') if (p.parent / 'model' / 'model.bin').is_file()), None)
            if inner is None:
                raise Unavailable('archive')
            final = self.folder(pair)
            shutil.rmtree(final, ignore_errors=True)
            os.replace(inner, final)
        finally:
            shutil.rmtree(tmp, ignore_errors=True)

    def prepare(self, pair):
        """Start the download of pair (and its way back) in the background; True once it is on disk."""
        if self.ready(pair):
            return True
        for p in (pair, (pair[1], pair[0])):
            with self.lock:
                if p not in MODELS or self.ready(p) or p in self.downloading:
                    continue
                if self.failed.get(p, 0) >= 3:
                    continue

                def run(p=p):
                    try:
                        self.download(p)
                    except Exception:
                        with self.lock:
                            self.failed[p] = self.failed.get(p, 0) + 1
                    finally:
                        with self.lock:
                            self.downloading.pop(p, None)
                thread = threading.Thread(target=run, name='argos-' + '_'.join(p), daemon=True)
                self.downloading[p] = thread
                thread.start()
        return False

    def model(self, pair):
        with self.lock:
            if pair in self.loaded:
                self.loaded[pair] = self.loaded.pop(pair)
                return self.loaded[pair]
        ct2, spm = self.runtime()
        folder = self.folder(pair)
        threads = max(1, min(2, os.cpu_count() or 1))
        loaded = (ct2.Translator(str(folder / 'model'), device='cpu', compute_type='int8', inter_threads=1, intra_threads=threads),
                  spm.SentencePieceProcessor(model_file=str(folder / 'sentencepiece.model')))
        with self.lock:
            self.loaded[pair] = loaded
            while len(self.loaded) > MAX_LOADED:
                self.loaded.pop(next(iter(self.loaded)))
        return loaded

    def translate(self, text, source, target):
        pair = (source, target)
        if pair not in MODELS:
            raise Unavailable('pair')
        if not self.prepare(pair):
            with self.lock:
                failed = self.failed.get(pair, 0) >= 3 and pair not in self.downloading
            if failed:
                raise Unavailable('download')
            raise Preparing(pair)
        translator, tokenizer = self.model(pair)
        lines = sentences(text)
        flat = [s for parts in lines for s in parts]
        if not flat:
            return text
        results = translator.translate_batch([tokenizer.encode(s, out_type=str) for s in flat], beam_size=2,
                                             max_decoding_length=512, max_batch_size=16)
        done = iter(detokenize(r.hypotheses[0]) for r in results)
        glue = '' if target in ('ja', 'zh') else ' '
        return '\n'.join(glue.join(next(done) for _ in parts) for parts in lines).strip()


_ENGINE = None


def engine():
    global _ENGINE
    if _ENGINE is None:
        _ENGINE = Engine()
    return _ENGINE


def translate(text, target, source=None, eng=None):
    """{'text', 'error'[, 'preparing']} like translation.translate, but on the box. Never calls Tinfoil."""
    eng = eng or engine()
    if target != 'en':
        source = 'en'
    elif not source or source == 'en':
        source = guess_source(text)
    if not source:
        return {'text': text, 'error': 'The translator on your Wizard could not tell which language this is.'}
    try:
        return {'text': eng.translate(text, source, target), 'error': None}
    except Preparing:
        other = NAMES.get(source if target == 'en' else target, 'this language')
        return {'text': text, 'preparing': True,
                'error': 'Your Wizard is getting its ' + other + ' translator ready (first use, about a minute). Try again shortly.'}
    except Exception:
        return {'text': text, 'error': 'The translator on your Wizard is not available. You can send the original instead.'}
