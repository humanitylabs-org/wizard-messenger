"""Connector pairing labels are product names, not internal bridge names."""
import json
from pathlib import Path
import unittest

ROOT = Path(__file__).resolve().parents[1] / 'plumbing'


class DeviceLabels(unittest.TestCase):
    def test_all_template_device_labels_are_branded(self):
        label_keys = {'os_name', 'device_name', 'device_model', 'browser_name'}

        def walk(value, path=()):
            if isinstance(value, dict):
                for key, item in value.items():
                    here = (*path, key)
                    if key in label_keys or (key == 'os' and 'device_meta' in path):
                        with self.subTest(path='.'.join(here)):
                            self.assertIsInstance(item, str)
                            self.assertNotIn('mautrix', item.lower())
                    walk(item, here)
            elif isinstance(value, list):
                for item in value:
                    walk(item, path)

        for template in ROOT.glob('*-template.json'):
            walk(json.loads(template.read_text()), (template.name,))

    def test_generated_pairing_labels(self):
        import tempfile
        from unified_setup import setup
        from connector_setup import setup_connectors

        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            setup(root)
            setup_connectors(root, enabled=())
            for network, keys in {
                'whatsapp': ('os_name',), 'signal': ('device_name',),
                'telegram': ('device_info', 'device_model'),
                'gmessages': ('device_meta', 'os'),
            }.items():
                value = json.loads((root / network / 'config.yaml').read_text())['network']
                for key in keys:
                    value = value[key]
                with self.subTest(network=network):
                    self.assertEqual(value, 'Wizard')

    def test_network_pairing_labels(self):
        expected = {
            'whatsapp': ('os_name',), 'signal': ('device_name',),
            'telegram': ('device_info', 'device_model'),
            'gmessages': ('device_meta', 'os'),
        }
        for network, keys in expected.items():
            value = json.loads((ROOT / f'{network}-template.json').read_text())['network']
            for key in keys:
                value = value[key]
            with self.subTest(network=network):
                self.assertEqual(value, 'Wizard')


if __name__ == '__main__':
    unittest.main()
