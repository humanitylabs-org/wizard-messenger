"""Unittest runner emitting real per-test outcomes for the readiness evidence log."""
import argparse
import json
from pathlib import Path
import unittest


class RecordedResult(unittest.TextTestResult):
    def __init__(self, *args, **kwargs):
        super().__init__(*args, **kwargs)
        self.outcomes = []

    def addSuccess(self, test):
        super().addSuccess(test)
        self.outcomes.append({'test': test.id(), 'outcome': 'passed'})

    def addFailure(self, test, err):
        super().addFailure(test, err)
        self.outcomes.append({'test': test.id(), 'outcome': 'failed'})

    def addError(self, test, err):
        super().addError(test, err)
        self.outcomes.append({'test': test.id(), 'outcome': 'error'})

    def addSkip(self, test, reason):
        super().addSkip(test, reason)
        self.outcomes.append({'test': test.id(), 'outcome': 'skipped'})

    def addExpectedFailure(self, test, err):
        super().addExpectedFailure(test, err)
        self.outcomes.append({'test': test.id(), 'outcome': 'known-failure'})

    def addUnexpectedSuccess(self, test):
        super().addUnexpectedSuccess(test)
        self.outcomes.append({'test': test.id(), 'outcome': 'unexpected-success'})


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--result', type=Path, required=True)
    parser.add_argument('targets', nargs='+')
    args = parser.parse_args()
    suite = unittest.defaultTestLoader.loadTestsFromNames(args.targets)
    result = unittest.TextTestRunner(verbosity=2, resultclass=RecordedResult).run(suite)
    assert isinstance(result, RecordedResult)
    passed = sum(x['outcome'] == 'passed' for x in result.outcomes)
    ok = result.wasSuccessful() and passed > 0 and not result.skipped
    args.result.write_text(json.dumps({'successful': ok, 'tests_run': result.testsRun,
        'passed': passed, 'known_failures': len(result.expectedFailures),
        'skipped': len(result.skipped), 'outcomes': result.outcomes}, indent=2) + '\n')
    return 0 if ok else 1


if __name__ == '__main__': raise SystemExit(main())
