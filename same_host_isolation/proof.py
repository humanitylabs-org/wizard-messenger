"""Reproducible, actual Docker negative/positive proof; fixture accounts only."""
import json
from deployment import Deployment, docker


def check(name, condition, evidence=None):
    if not condition:
        raise AssertionError('%s: %r' % (name, evidence))
    print('PASS ' + name, flush=True)


def main():
    d = Deployment()
    print('FIXTURE ONLY; no live providers or whole-Hermes isolation claim', flush=True)
    print('IMAGE ' + d.image, flush=True)
    print('RESOURCES ' + d.prefix, flush=True)
    try:
        d.start()
        inspect = json.loads(docker('inspect', d.names['worker']))[0]
        h = inspect['HostConfig']
        check('Docker config network=none, read-only, nonprivileged, drop ALL',
              h['NetworkMode'] == 'none' and h['ReadonlyRootfs'] and not h['Privileged'] and h['CapDrop'] == ['ALL'])
        mounts = inspect['Mounts']
        check('worker only code + agent socket mounts, both read-only',
              {m['Destination'] for m in mounts} == {'/code', '/agent'} and all(not m['RW'] for m in mounts), mounts)
        owner_mounts = json.loads(docker('inspect', d.names['owner']))[0]['Mounts']
        check('owner and agent socket volumes distinct; owner lacks agent/state mounts',
              {m['Destination'] for m in owner_mounts} == {'/code', '/owner'}
              and all(not m['RW'] for m in owner_mounts)
              and next(m['Source'] for m in mounts if m['Destination'] == '/agent')
              != next(m['Source'] for m in owner_mounts if m['Destination'] == '/owner'))
        check('worker no host PID/IPC, no devices, no extra hosts',
              h['PidMode'] != 'host' and h['IpcMode'] != 'host' and not h['Devices'] and not h['ExtraHosts'])
        r = d.rpc('owner', {'op': 'inspect'})['result']
        check('default policy no-access and ledger empty', r['mode'] == 'no-access' and r['ledger'] == [])
        for q in ({'op': 'read'}, {'op': 'create', 'recipient': 'fixture:alice', 'body': 'blocked'}):
            check('default denies ' + q['op'], not d.rpc('worker', q)['ok'])
        def policy(mode):
            check('owner sets ' + mode, d.rpc('owner', {'op': 'policy', 'mode': mode})['ok'])
            check('owner policy readback ' + mode, d.rpc('owner', {'op': 'inspect'})['result']['mode'] == mode)
        policy('read-only')
        check('read-only permits fixture read', d.rpc('worker', {'op': 'read'})['result']['messages'][0]['id'] == 'fixture-inbound-1')
        check('read-only denies create', not d.rpc('worker', {'op': 'create', 'recipient': 'fixture:alice', 'body': 'blocked'})['ok'])
        policy('draft-only')
        check('draft-only permits read', d.rpc('worker', {'op': 'read'})['ok'])
        first = d.rpc('worker', {'op': 'create', 'recipient': 'fixture:alice', 'body': 'initial draft'})['result']
        ident = first['id']
        check('create draft readback', d.rpc('worker', {'op': 'read'})['result']['drafts'][ident] == first['draft'])
        updated = d.rpc('worker', {'op': 'update', 'id': ident, 'revision': 1, 'recipient': 'fixture:bob', 'body': 'exact owner-reviewed text'})['result']
        check('update draft readback', d.rpc('worker', {'op': 'read'})['result']['drafts'][ident] == updated['draft'])
        check('stale update denied', not d.rpc('worker', {'op': 'update', 'id': ident, 'revision': 1, 'recipient': 'fixture:evil', 'body': 'stale'})['ok'])
        policy('read-only')
        check('read-only denies update existing draft', not d.rpc('worker', {'op': 'update', 'id': ident, 'revision': 2, 'recipient': 'fixture:evil', 'body': 'blocked'})['ok'])
        policy('draft-only')
        print(docker('exec', d.names['worker'], 'python3', '/code/attack.py'), flush=True)
        for q in ({'op': 'policy', 'mode': 'draft-only'}, {'op': 'approve', 'id': ident, 'digest': updated['digest']}, {'op': 'send', 'recipient': 'fixture:evil', 'body': 'not allowed'}):
            check('valid-shape worker authority attempt denied: ' + q['op'], not d.rpc('worker', q)['ok'])
        check('actual ledger has ZERO worker-caused sends', d.rpc('owner', {'op': 'inspect'})['result']['ledger'] == [])
        check('owner cannot approve unfrozen draft', not d.rpc('owner', {'op': 'approve', 'id': ident, 'digest': updated['digest']})['ok'])
        check('owner stale freeze denied', not d.rpc('owner', {'op': 'freeze', 'id': ident, 'revision': 1, 'digest': first['digest']})['ok'])
        # Owner reviews via its own channel, not a worker-rendered UI/digest.
        from broker import digest
        reviewed = d.rpc('owner', {'op': 'inspect'})['result']['drafts'][ident]
        check('owner independent review of exact recipient/body/revision', reviewed == {
            'recipient': 'fixture:bob', 'body': 'exact owner-reviewed text', 'revision': 2, 'status': 'draft'})
        owner_digest = digest(reviewed)
        check('independently computed owner digest matches', owner_digest == updated['digest'])
        frozen = d.rpc('owner', {'op': 'freeze', 'id': ident, 'revision': reviewed['revision'], 'digest': owner_digest})
        check('owner freezes exact revision+digest', frozen['ok'] and frozen['result']['draft']['status'] == 'frozen')
        check('frozen draft exact readback', d.rpc('owner', {'op': 'inspect'})['result']['drafts'][ident] == frozen['result']['draft'])
        check('worker cannot alter frozen draft', not d.rpc('worker', {'op': 'update', 'id': ident, 'revision': 2, 'recipient': 'fixture:evil', 'body': 'changed after approval'})['ok'])
        check('owner wrong digest denied', not d.rpc('owner', {'op': 'approve', 'id': ident, 'digest': '0' * 64})['ok'])
        check('owner approves exact frozen draft', d.rpc('owner', {'op': 'approve', 'id': ident, 'digest': owner_digest})['ok'])
        check('approval readback exact sent draft', d.rpc('owner', {'op': 'inspect'})['result']['drafts'][ident]['status'] == 'sent')
        check('owner approval retry idempotent', d.rpc('owner', {'op': 'approve', 'id': ident, 'digest': updated['digest']})['result']['already_sent'])
        state = d.rpc('owner', {'op': 'inspect'})['result']
        check('ledger exactly ONE owner-authorized frozen send', state['ledger'] == [{
            'id': ident, 'recipient': 'fixture:bob', 'body': 'exact owner-reviewed text', 'revision': 2,
            'digest': updated['digest'], 'authority': 'owner-socket'}], state)
        print('FIXTURE LEDGER ' + json.dumps(state['ledger'], sort_keys=True), flush=True)
        check('unsupported Full access rejected', not d.rpc('owner', {'op': 'policy', 'mode': 'full-access'})['ok'])
        policy('no-access')
        check('restored policy denies read', not d.rpc('worker', {'op': 'read'})['ok'])
        policy('draft-only')
        docker('restart', d.names['broker'])
        import time
        for _ in range(50):
            try:
                state = d.rpc('owner', {'op': 'inspect'})['result']
                break
            except RuntimeError:
                time.sleep(0.1)
        else:
            raise AssertionError('restart not ready')
        check('restart fails closed to no-access with ledger durable', state['mode'] == 'no-access' and len(state['ledger']) == 1)
        check('restart denies worker read', not d.rpc('worker', {'op': 'read'})['ok'])
        print('PROOF PASS: restricted worker, fixture-only read/draft; owner-only exact frozen approval', flush=True)
    finally:
        # Restore even on failure, then remove only recorded test names.
        restore_error = None
        if d.names['owner'] in d.containers:
            try:
                result = d.rpc('owner', {'op': 'policy', 'mode': 'no-access'})
                assert result['ok']
                assert d.rpc('owner', {'op': 'inspect'})['result']['mode'] == 'no-access'
                print('PASS final no-access restoration read-back verified', flush=True)
            except Exception as e:
                restore_error = e
                print('RESTORE ERROR (resources still torn down): ' + str(e), flush=True)
        d.cleanup()
        if restore_error is not None:
            raise RuntimeError('final restoration failed') from restore_error


if __name__ == '__main__':
    main()
