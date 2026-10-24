import json
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest


class RunnerTests(unittest.TestCase):
    def run_target(self, target):
        with tempfile.TemporaryDirectory() as directory:
            result_path = Path(directory) / 'results.json'
            result = subprocess.run([sys.executable, '-m', 'readiness.runner', '--result', str(result_path), target],
                                    capture_output=True, timeout=10)
            return result.returncode, json.loads(result_path.read_text())

    def test_no_tests_never_proves_a_component(self):
        code, data = self.run_target('readiness.tests')
        self.assertEqual(code, 1)
        self.assertEqual(data['tests_run'], 0)
        self.assertFalse(data['successful'])

    def test_loader_errors_are_failures_not_empty_success(self):
        code, data = self.run_target('readiness.tests.no_such_module')
        self.assertEqual(code, 1)
        self.assertFalse(data['successful'])
        self.assertEqual(data['outcomes'][0]['outcome'], 'error')

    def test_passes_emit_actual_named_outcomes(self):
        code, data = self.run_target('readiness.tests.test_search.SearchTests.test_thread_teardown_does_not_delete_other_scopes')
        self.assertEqual(code, 0)
        self.assertEqual(data['passed'], 1)
        self.assertEqual(data['outcomes'][0]['outcome'], 'passed')


if __name__ == '__main__': unittest.main()
