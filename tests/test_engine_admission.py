"""Synthetic admission only: no real binaries, Docker, compilation or runtime proof."""
import hashlib
import json
import os
from pathlib import Path
import re
import shutil
import subprocess
import tempfile
import unittest

ROOT = Path(__file__).resolve().parents[1]
HELPER = ROOT / 'engine/admit-prebuilt.sh'
PATCH = '0001-relay-plane-drop.patch'
PATCH_SHA = '7a552464730c87883036ab971d5741e6971306ddba6a63e61506dbb8d83a6ab8'


def sha(path):
    return hashlib.sha256(path.read_bytes()).hexdigest()


class SyntheticAdmission(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory(prefix='engine-admission-', dir=os.environ.get('TMPDIR'))
        self.addCleanup(self.tmp.cleanup)
        self.root = Path(self.tmp.name)
        self.metadata = self.root / 'metadata'
        self.metadata.mkdir()
        self.patches = self.root / 'patches'
        self.patches.mkdir()
        (self.patches / PATCH).write_text('synthetic patch fixture, not an upstream artifact\n')
        self.provenance = self.metadata / 'provenance.json'
        self.provenance.write_text('{"synthetic_fixture_only": true}\n')
        self.manifest = self.metadata / 'prebuilt-manifest.txt'
        self.bins = self.root / 'bin'
        self.bins.mkdir()
        self.out = self.root / 'out'
        self.out.mkdir()
        self.hashes = {}
        for arch in ('amd64', 'arm64'):
            directory = self.root / arch
            directory.mkdir()
            self.hashes[arch] = []
            for name in ('wn', 'wnd'):
                path = directory / name
                path.write_text(f'#!/bin/sh\n# synthetic {arch} {name}; never execute\nexit 99\n')
                path.chmod(0o755)
                self.hashes[arch].append(sha(path))
        self.install_pair('amd64')
        self.write_manifest()

    def install_pair(self, arch):
        for name in ('wn', 'wnd'):
            shutil.copy2(self.root / arch / name, self.bins / name)

    def write_manifest(self, arches=('amd64', 'arm64')):
        self.manifest.write_text(
            f'provenance {sha(self.provenance)}\n'
            f'patch {PATCH} {sha(self.patches / PATCH)}\n' +
            ''.join(f'binary {arch} {self.hashes[arch][0]} {self.hashes[arch][1]}\n' for arch in arches))

    def invoke(self, arch='amd64', mode='admit'):
        self.assertTrue(HELPER.is_file(), 'Docker needs a shared fail-closed admission helper')
        args = ['sh', str(HELPER), mode, str(self.manifest), str(self.provenance), str(self.patches)]
        if mode == 'admit':
            args += [arch, str(self.bins), str(self.out)]
        return subprocess.run(args, capture_output=True, text=True, timeout=5)

    def assert_refused(self, result):
        self.assertNotEqual(result.returncode, 0, result.stdout)
        self.assertIn('source build', result.stderr)
        self.assertEqual(list(self.out.iterdir()), [], 'refusal must not copy even half a pair')

    def test_known_pair_is_copied_without_execution(self):
        result = self.invoke()
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual([sha(self.out / n) for n in ('wn', 'wnd')], self.hashes['amd64'])

    def test_old_unpatched_pair_refused(self):
        for name in ('wn', 'wnd'):
            (self.bins / name).write_text('#!/bin/sh\n# synthetic old unpatched pair\nexit 99\n')
        self.assert_refused(self.invoke())

    def test_unknown_pair_refused(self):
        for name in ('wn', 'wnd'):
            (self.bins / name).write_text('#!/bin/sh\n# synthetic unknown pair\nexit 99\n')
        self.assert_refused(self.invoke())

    def test_either_tampered_binary_refused_atomically(self):
        for name in ('wn', 'wnd'):
            with self.subTest(name=name):
                self.install_pair('amd64')
                with (self.bins / name).open('a') as stream:
                    stream.write('# tampered\n')
                self.assert_refused(self.invoke())

    def test_either_missing_or_nonexecutable_binary_refused(self):
        for name in ('wn', 'wnd'):
            for missing in (True, False):
                with self.subTest(name=name, missing=missing):
                    self.install_pair('amd64')
                    if missing:
                        (self.bins / name).unlink()
                    else:
                        (self.bins / name).chmod(0o644)
                    self.assert_refused(self.invoke())

    def test_architecture_separation_and_arm64_fixture_success(self):
        self.assert_refused(self.invoke('arm64'))
        self.install_pair('arm64')
        result = self.invoke('arm64')
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual([sha(self.out / n) for n in ('wn', 'wnd')], self.hashes['arm64'])

    def test_missing_architecture_hashes_refused(self):
        self.write_manifest(arches=('amd64',))
        self.install_pair('arm64')
        self.assert_refused(self.invoke('arm64'))

    def test_empty_or_unknown_architecture_refused(self):
        for arch in ('', 'x86_64', 'riscv64'):
            with self.subTest(arch=arch):
                self.assert_refused(self.invoke(arch))

    def test_patch_bytes_and_patch_set_are_bound(self):
        original = (self.patches / PATCH).read_bytes()
        (self.patches / PATCH).write_bytes(original + b'tampered\n')
        self.assert_refused(self.invoke())
        (self.patches / PATCH).write_bytes(original)
        extra = self.patches / '0002-unknown.patch'
        extra.write_text('not admitted\n')
        self.assert_refused(self.invoke())
        extra.unlink()
        (self.patches / PATCH).unlink()
        self.assert_refused(self.invoke())

    def test_provenance_digest_is_bound(self):
        self.provenance.write_text('{"synthetic_fixture_only": "changed"}\n')
        self.assert_refused(self.invoke())

    def test_missing_manifest_or_provenance_refused(self):
        self.manifest.unlink()
        self.assert_refused(self.invoke())
        self.write_manifest()
        self.provenance.unlink()
        self.assert_refused(self.invoke())

    def test_malformed_partial_duplicate_or_executable_manifest_refused(self):
        original = self.manifest.read_text()
        marker = self.root / 'must-not-execute'
        variants = [
            '', original.replace(self.hashes['amd64'][1], ''),
            original.replace(self.hashes['amd64'][0], 'not-a-sha256'),
            original + original.splitlines()[-2] + '\n',
            original + original.splitlines()[0] + '\n',
            original + original.splitlines()[1] + '\n',
            original.replace(PATCH, '../outside.patch'),
            original + f'$(touch {marker})\n',
        ]
        for value in variants:
            with self.subTest(value=value):
                self.manifest.write_text(value)
                self.assert_refused(self.invoke())
                self.assertFalse(marker.exists())

    def test_metadata_check_does_not_require_arm64_binary_hash(self):
        self.write_manifest(arches=('amd64',))
        result = self.invoke(mode='check')
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(list(self.out.iterdir()), [])

    def docker_run(self):
        # Optional captured proposal Dockerfile permits failing-first replay without reverting source.
        path = Path(os.environ.get('ENGINE_ADMISSION_DOCKERFILE', str(ROOT / 'Dockerfile')))
        dockerfile = path.read_text().split('FROM ${MESSENGER_RUNTIME_BASE}')[0]
        match = re.search(r'^RUN (.*)', dockerfile, re.M | re.S)
        self.assertIsNotNone(match)
        assert match is not None
        instruction = match.group(1).strip()
        instruction = re.sub(r'^--mount=\S+\s*', '', instruction)
        instruction = re.sub(r'^--mount=\S+\s*', '', instruction)
        instruction = instruction.replace('\\\n', '\n')
        for source, target in [('/engine-admission', self.metadata), ('/patches', self.patches),
                               ('/usr/local/bin', self.bins), ('/out', self.out)]:
            instruction = instruction.replace(source, str(target))
        # A refusal must never fall through to the source-build branch.
        stubdir = self.root / 'stubs'
        stubdir.mkdir(exist_ok=True)
        apt = stubdir / 'apt-get'
        apt.write_text('#!/bin/sh\nprintf source-fallback-invoked >&2\nexit 88\n')
        apt.chmod(0o755)
        shutil.copy2(HELPER, self.metadata / 'admit-prebuilt.sh')
        env = dict(os.environ, TARGETARCH='amd64', PATH=str(stubdir) + os.pathsep + os.environ['PATH'])
        result = subprocess.run(['sh', '-c', instruction], env=env, capture_output=True, text=True, timeout=5)
        self.assertNotIn('source-fallback-invoked', result.stderr)
        return result

    def test_docker_invokes_same_helper_for_good_pair(self):
        result = self.docker_run()
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(sha(self.out / 'wnd'), self.hashes['amd64'][1])

    def test_docker_refuses_unknown_or_partial_pair_without_fallback(self):
        (self.bins / 'wnd').write_text('synthetic unknown bytes\n')
        self.assert_refused(self.docker_run())
        (self.bins / 'wnd').unlink()
        self.assert_refused(self.docker_run())

    def test_docker_checks_patch_before_admission(self):
        (self.patches / PATCH).write_text('synthetic changed patch\n')
        self.assert_refused(self.docker_run())

    def test_docker_checks_patch_before_source_build(self):
        for name in ('wn', 'wnd'):
            (self.bins / name).unlink()
        (self.patches / PATCH).write_text('synthetic changed patch\n')
        self.assert_refused(self.docker_run())

    def test_symlinked_and_broken_carriers_refused(self):
        for name in ('wn', 'wnd'):
            with self.subTest(name=name):
                self.install_pair('amd64')
                (self.bins / name).unlink()
                (self.bins / name).symlink_to(self.root / 'amd64' / name)
                self.assert_refused(self.invoke())
                (self.bins / name).unlink()
                (self.bins / name).symlink_to(self.root / 'nonexistent')
                self.assert_refused(self.docker_run())
                (self.bins / name).unlink()


class RepositoryAdmissionContract(unittest.TestCase):
    def test_real_metadata_passes_same_helper_check_without_real_binaries(self):
        self.assertTrue(HELPER.is_file())
        result = subprocess.run(['sh', str(HELPER), 'check',
                                 str(ROOT / 'engine/prebuilt-manifest.txt'),
                                 str(ROOT / 'engine/provenance.json'), str(ROOT / 'engine/patches')],
                                capture_output=True, text=True, timeout=5)
        self.assertEqual(result.returncode, 0, result.stderr)

    def test_manifest_matches_patched_provenance_and_preserved_patch(self):
        provenance_path = ROOT / 'engine/provenance.json'
        provenance = json.loads(provenance_path.read_text())
        manifest = ROOT / 'engine/prebuilt-manifest.txt'
        self.assertTrue(manifest.is_file(), 'A static patched-only allowlist is required')
        rows = [line.split() for line in manifest.read_text().splitlines() if line and not line.startswith('#')]
        self.assertEqual([r for r in rows if r[0] == 'provenance'], [['provenance', sha(provenance_path)]])
        patch = provenance['patches'][0]
        self.assertEqual(sha(ROOT / patch['file']), PATCH_SHA)
        self.assertEqual(patch['sha256'], PATCH_SHA)
        self.assertEqual([r for r in rows if r[0] == 'patch'], [['patch', PATCH, PATCH_SHA]])
        binaries = provenance['patched_binaries']
        self.assertNotIn('arm64', binaries, 'There is no proven patched arm64 identity')
        self.assertEqual([r for r in rows if r[0] == 'binary'], [
            ['binary', arch, p['wn_sha256'], p['wnd_sha256']] for arch, p in binaries.items()])
        self.assertEqual(binaries['amd64']['wn_sha256'], patch['amd64_wn_sha256'])
        self.assertEqual(binaries['amd64']['wnd_sha256'], patch['amd64_wnd_sha256'])

    def test_old_evidence_is_explicitly_separate_and_runtime_unproven(self):
        provenance = json.loads((ROOT / 'engine/provenance.json').read_text())
        self.assertIn('historical_unpatched', provenance)
        old = provenance['historical_unpatched']
        for key in ('arm64', 'amd64', 'proof', 'http_proof'):
            self.assertIn(key, old)
            self.assertNotIn(key, provenance)
        self.assertEqual(old['arm64']['wn_sha256'], 'd035d1df7fc55dd77f797bf72b745aa984e23d8e980cb056d418146db39606a7')
        self.assertEqual(old['amd64']['wnd_sha256'], 'd6fa0360c0f3fb8177bf5f35b6eca06a2783a6d88dca82120798381bf0885066')
        self.assertTrue(old['proof']['two_disposable_accounts'])
        self.assertTrue(old['http_proof']['thales_arm64_two_container_campaign'])
        coverage = provenance['patched_runtime_coverage']
        self.assertFalse(coverage['native_packaged_amd64'])
        self.assertFalse(coverage['native_packaged_arm64'])
        self.assertFalse(coverage['120_request_two_account_proof'])
        self.assertTrue(coverage['merge_blocking'])

    def test_docker_source_alternative_and_build_helper_use_patched_identities(self):
        dockerfile = (ROOT / 'Dockerfile').read_text()
        self.assertIn('ARG TARGETARCH', dockerfile)
        self.assertIn('sh /engine-admission/admit-prebuilt.sh check', dockerfile)
        self.assertIn('git -c user.name=build -c user.email=build@localhost am /patches/*.patch', dockerfile)
        self.assertIn('cargo build --locked -p wn-cli --bins -j1', dockerfile)
        self.assertNotIn('python', dockerfile.split('FROM ${MESSENGER_RUNTIME_BASE}')[0])
        builder = (ROOT / 'tools/build_unified_thales.py').read_text()
        self.assertIn("['patched_binaries']", builder)
        self.assertNotIn("read_text())[a.arch]", builder)
        self.assertIn('admit-prebuilt.sh', builder)


if __name__ == '__main__':
    unittest.main()
