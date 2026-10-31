import pathlib, re, unittest

class OverlayReadable(unittest.TestCase):
    """12.10 shipped unified.py as 0600 root; the app runs as uid 1000 and crash-looped (28 Oct 2026)."""
    def test_every_overlay_copy_forces_world_readable(self):
        text = (pathlib.Path(__file__).resolve().parents[1] / 'Dockerfile.overlay').read_text()
        copies = [l for l in text.splitlines() if l.startswith('COPY ')]
        self.assertTrue(copies)
        for line in copies:
            # Use numeric modes: symbolic chmod was ignored by the forum builder.
            # The entrypoint is the one executable: readable and executable, never owner-only.
            self.assertRegex(line, r'^COPY --chmod=0755 engine/entrypoint\.sh /app/entrypoint\.sh$' if 'entrypoint.sh' in line else r'^COPY --chmod=0644 ', line)

if __name__ == '__main__':
    unittest.main()
