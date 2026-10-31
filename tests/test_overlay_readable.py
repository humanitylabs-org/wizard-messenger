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

    def test_directories_created_by_copy_get_their_x_bit(self):
        # 15.8 first boot (31 Oct 2026): COPY --chmod=0644 made new dirs 0644; uid 1000 could not import readiness.
        text = (pathlib.Path(__file__).resolve().parents[1] / 'Dockerfile.overlay').read_text()
        dirs = {l.split()[-1].rstrip('/') for l in text.splitlines() if l.startswith('COPY ') and l.split()[-1].endswith('/')}
        fix = [l for l in text.splitlines() if l.startswith('RUN chmod 0755 ')]
        self.assertTrue(fix, 'overlay must chmod 0755 the directories it copies into')
        self.assertEqual(dirs - set(fix[-1].split()[3:]), set())
        self.assertEqual(text.strip().splitlines()[-1], 'USER 1000:1000')

if __name__ == '__main__':
    unittest.main()
