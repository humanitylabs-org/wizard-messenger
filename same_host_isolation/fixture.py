"""Interactive TEST-ONLY owner console, run on the trusted host, not worker."""
import json
from deployment import Deployment
from broker import digest


def main():
    d = Deployment()
    try:
        d.start()
        print('TEST ONLY. Host console is the separate owner channel; worker gets no console/socket.')
        print('Worker container: ' + d.names['worker'])
        print('Enter JSON: {"role":"owner|worker", "request":{...}}')
        print('Or review ID: owner reads exact draft and computes digest; does NOT send.')
        print('Owner operations: inspect, policy, freeze, approve. Ctrl-D/Ctrl-C tears down.')
        while True:
            try:
                line = input('fixture> ')
            except EOFError:
                break
            try:
                if line.startswith('review '):
                    ident = line.split(' ', 1)[1]
                    draft = d.rpc('owner', {'op': 'inspect'})['result']['drafts'][ident]
                    print(json.dumps({'id': ident, 'draft': draft, 'digest': digest(draft)}, sort_keys=True))
                else:
                    q = json.loads(line)
                    print(json.dumps(d.rpc(q['role'], q['request']), sort_keys=True))
            except (ValueError, KeyError, AssertionError) as e:
                print('Rejected: ' + str(e))
    finally:
        try:
            if d.names['owner'] in d.containers:
                result = d.rpc('owner', {'op': 'policy', 'mode': 'no-access'})
                assert result['ok']
                assert d.rpc('owner', {'op': 'inspect'})['result']['mode'] == 'no-access'
                print('Restored no-access, read-back verified.')
        finally:
            d.cleanup()


if __name__ == '__main__':
    try:
        main()
    except KeyboardInterrupt:
        pass
