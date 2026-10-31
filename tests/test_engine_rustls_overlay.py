"""Regression contracts for the pinned MDK rustls security overlay."""
import hashlib
import json
from pathlib import Path
import tomllib
import unittest


ROOT = Path(__file__).resolve().parents[1]
LOCK = ROOT / "engine" / "Cargo.lock"
PATCH = ROOT / "engine" / "patches" / "0001-rustls-0.23.46.patch"
PROVENANCE = ROOT / "engine" / "provenance.json"


class RustlsSecurityOverlay(unittest.TestCase):
    def test_resolved_rustls_is_patched_with_no_vulnerable_duplicate(self):
        packages = tomllib.loads(LOCK.read_text())["package"]
        rustls = [package for package in packages if package["name"] == "rustls"]
        self.assertEqual(len(rustls), 1)
        self.assertGreaterEqual(tuple(map(int, rustls[0]["version"].split("."))), (0, 23, 46))

    def test_overlay_provenance_binds_the_patch_and_generated_lock(self):
        overlay = json.loads(PROVENANCE.read_text())["security_dependency_overlay"]
        self.assertEqual(overlay["patch"], "engine/patches/0001-rustls-0.23.46.patch")
        self.assertEqual(overlay["package"], "rustls")
        self.assertEqual(overlay["minimum_version"], "0.23.46")
        self.assertEqual(overlay["sha256"], hashlib.sha256(PATCH.read_bytes()).hexdigest())
        self.assertEqual(overlay["cargo_lock_sha256"], hashlib.sha256(LOCK.read_bytes()).hexdigest())

    def test_overlay_patch_is_limited_to_the_upstream_manifest_and_lock(self):
        patch = PATCH.read_text()
        self.assertEqual(
            [line for line in patch.splitlines() if line.startswith("diff --git ")],
            ["diff --git a/Cargo.lock b/Cargo.lock", "diff --git a/Cargo.toml b/Cargo.toml"],
        )
        self.assertIn('+rustls = { version = "0.23.46",', patch)
        self.assertIn('+version = "0.23.46"', patch)

    def test_dockerfile_verifies_then_applies_the_overlay_and_refuses_prebuilts(self):
        dockerfile = (ROOT / "Dockerfile").read_text()
        self.assertIn("COPY engine/patches/0001-rustls-0.23.46.patch", dockerfile)
        self.assertIn("git apply --check /engine-patches/0001-rustls-0.23.46.patch", dockerfile)
        self.assertIn("git apply --whitespace=error /engine-patches/0001-rustls-0.23.46.patch", dockerfile)
        self.assertIn("dac950e433d49280ebb9f8c46cfe4432287e0812186115e077bf83fee953377a  Cargo.lock", dockerfile)
        self.assertIn("cargo build --locked -p wn-cli --bins -j1", dockerfile)
        self.assertIn("unproven prebuilt wn/wnd carrier refused", dockerfile)


if __name__ == "__main__":
    unittest.main()