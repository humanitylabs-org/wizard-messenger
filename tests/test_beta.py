import importlib.util
import json
from pathlib import Path
import tempfile
import unittest

spec = importlib.util.spec_from_file_location('beta', Path(__file__).parents[1] / 'tools/beta.py')
assert spec is not None and spec.loader is not None
beta = importlib.util.module_from_spec(spec)
spec.loader.exec_module(beta)

class InstallTests(unittest.TestCase):
    def test_repeat_preserves_secret_and_data(self):
        with tempfile.TemporaryDirectory() as d:
            root = Path(d) / 'owned'
            first = beta.configure(root, 'https://wizard.example/apps/messenger/', 19245)
            before = (root / '.env').read_bytes()
            (root / 'data').mkdir()
            (root / 'data/history').write_text('preserve')
            self.assertEqual(beta.configure(root, 'https://wizard.example/apps/messenger/', 19245), first)
            self.assertEqual((root / '.env').read_bytes(), before)
            self.assertEqual((root / 'data/history').read_text(), 'preserve')
            self.assertEqual((root / '.env').stat().st_mode & 0o777, 0o600)
            svc = json.loads((root / 'compose.json').read_text())['services']['messenger']
            self.assertEqual(svc['ports'], ['127.0.0.1:19245:8765'])
            self.assertIn('MESSENGER_COOKIE_SECURE=1', before.decode())
            self.assertIn('handle_path /apps/messenger/*', (root / 'route.caddy').read_text())
            with self.assertRaises(ValueError):
                beta.configure(root, 'https://other.example/apps/messenger/', 19245)

    def test_refuse_unowned_and_invalid_url(self):
        with tempfile.TemporaryDirectory() as d:
            root = Path(d)
            (root / 'keep').write_text('owner')
            with self.assertRaises(ValueError):
                beta.configure(root, 'https://wizard.example/apps/messenger/', 19245)
            for url in ['http://wizard.example/apps/messenger/', 'https://u:p@wizard.example/apps/messenger/',
                        'https://wizard.example/apps/../', 'https://wizard.example/apps/messenger/?secret=x']:
                with self.assertRaises(ValueError):
                    beta.configure(root / 'child', url, 19245)
            self.assertFalse((root / 'child').exists())
            self.assertEqual((root / 'keep').read_text(), 'owner')
