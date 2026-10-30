"""Private carrier HTTP checks; called only by prove_connector_stack.py."""
import json
import sys
from unittest.mock import Mock
from urllib.error import HTTPError
from urllib.request import urlopen
sys.path.insert(0, '/app')
from connector_inbox import ConnectorInbox
from connector_sender import LocalOwnerSender
from connectors import Connectors


def main():
    inbox = ConnectorInbox('/data', Mock(), LocalOwnerSender())
    outcomes = {'services': {}}
    try:
        inbox.matrix_token()
        assert inbox.mx('/account/whoami')['user_id'] == '@owner:messenger.internal'
        outcomes['owner_bootstrap'] = {'registered_local_test_owner': True, 'matrix_whoami': True}
        for name in ('slack', 'telegram', 'whatsapp', 'line', 'instagram', 'signal'):
            base, _ = inbox.connectors.config(name)
            try:
                urlopen(base + '/_matrix/provision/v3/whoami?user_id=%40owner%3Amessenger.internal', timeout=5)
                raise AssertionError('Provisioning permitted without private token')
            except HTTPError as error:
                assert error.code in (401, 403)
                denied = error.code
                error.close()
            status = inbox.connectors.status(name)
            assert status['state'] == 'disconnected', (name, status['state'])
            assert status['capabilities']['bridge_live']
            outcomes['services'][name] = {'state': status['state'], 'account_connected': False, 'authenticated_whoami_http': 200, 'unauthenticated_provisioning_http': denied, 'advertised_owner_flows': status['flows']}
        # These starts only return local input descriptors: no provider I/O.
        for name, flow in [('slack', 'email'), ('instagram', 'android'), ('line', 'dev.highest.matrix.line.email_login')]:
            step = inbox.connectors.dispatch('POST', [name, 'start'], {'flow': flow})
            assert step['type'] == 'user_input'
            outcomes['services'][name]['owner_login_start'] = {'http': 200, 'type': step['type'], 'field_ids': [f['id'] for f in step['user_input']['fields']]}
            inbox.connectors.dispatch('POST', [name, 'cancel'], {'login_id': step['login_id']})
            assert not inbox.connectors.pending.get(name)
            outcomes['services'][name]['cancel_http'] = 200
        assert 'next_batch' in inbox.mx('/sync?timeout=0')
        outcomes['matrix_empty_sync_http'] = 200
        print(json.dumps(outcomes))
    finally:
        inbox.close()
        if inbox.store._conn is not None:
            inbox.store._conn.close()


if __name__ == '__main__': main()
