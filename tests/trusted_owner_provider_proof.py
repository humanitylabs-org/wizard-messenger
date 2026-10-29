"""Network-disabled packaged GNOME provider proof; synthetic vault, no account."""
import hashlib
from pathlib import Path
import secrets
import tempfile
from engine import MarmotEngine
from web import BrowserAuth
from trusted_owner import TrustedOwner

with tempfile.TemporaryDirectory() as tmp:
    root = Path(tmp); data = root/'data'
    for name in ('proof', 'wrap'):
        (root/name).write_bytes(secrets.token_bytes(32)); (root/name).chmod(0o600)
    password = 'synthetic-provider-proof-' + secrets.token_hex(16)
    auth = BrowserAuth(); auth.remember_password(password)
    trust = TrustedOwner(data, enabled=True, proof_file=root/'proof', wrap_file=root/'wrap')
    engine = MarmotEngine(data, relays=['ws://127.0.0.1:1'])
    # Isolate the actual GNOME provider; no account or network-facing MDK daemon.
    engine._launch = lambda: None
    try:
        engine._unlock(password)
        assert engine.unlocked
        trust.remember(password, auth.credential)
        engine.lock()
        assert engine.status()['state'] != 'ready'
        restarted = MarmotEngine(data, relays=['ws://127.0.0.1:1'])
        restarted._launch = lambda: None
        try:
            recalled = trust.password(auth.credential)
            auth.verify_password(recalled)
            restarted._unlock(recalled)
            assert restarted.unlocked
            assert not restarted.status()['account_configured']
            assert password.encode() not in trust.path.read_bytes()
            print('PASS real packaged GNOME encrypted provider unlock -> shutdown -> remembered decrypt -> fresh provider unlock; MDK launch stubbed, no account created, network disabled')
        finally: restarted.lock()
    finally:
        if engine.unlocked: engine.lock()
