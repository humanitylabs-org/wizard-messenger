"""Calls (issue 445, switch `calls`): the box side of encrypted voice and video calls.

Messenger's own Synapse already speaks Matrix's call standard (MatrixRTC, Synapse 1.166). A call needs two more pieces
next to it, both pinned in the recipe: the LiveKit media server (`livekit`) and LiveKit's token service for Matrix
(`call-auth`, element-hq lk-jwt-service). Both containers start idle and run only while the owner's `calls` switch is
on: Messenger keeps the marker file `calls/enabled` in step with the switch, and each container waits for it before it
starts its program and stops the program again once the marker is gone. Neither publishes a port; they talk to
Messenger and Synapse over the app's private networks only.

Synapse's call settings (the transports endpoint, delayed events, sync `state_after`, and the token service as an
application service that answers `/_matrix/client/v1/rtc/livekit/...` through Synapse) are inert while nothing calls
them, so they are always written: the switch then works the moment it is flipped, without a restart.

Never print the files written here: they hold the LiveKit secret and the application-service tokens.
"""
import json
import os
import secrets
from pathlib import Path

SWITCH = 'calls'
SERVER_NAME = 'messenger.internal'
# The LiveKit API key's name. Not a secret; the secret next to it is.
LIVEKIT_KEY = 'messenger'
LIVEKIT_WS = 'ws://livekit:7880'
AUTH_URL = 'http://call-auth:8080'
STUN = 'stun.cloudflare.com:3478'
REGISTRATION = 'lk-jwt-registration.yaml'
# Pinned with the recipe (runtipi/docker-compose.yml) and the image (Dockerfile); tests/test_calls.py keeps them equal.
VERSIONS = {'livekit': 'v1.13.11', 'lk-jwt-service': '0.10.0', 'element-call': 'v0.29.0'}


def _write(path, text, mode=0o600):
    path.parent.mkdir(parents=True, exist_ok=True)
    tmp = path.with_name('.' + path.name + '.new')
    with tmp.open('w') as f:
        os.chmod(tmp, mode)
        f.write(text)
        f.flush()
        os.fsync(f.fileno())
    tmp.replace(path)


def _keys(folder):
    """The call secrets, made once and kept across updates: the LiveKit secret and the token service's
    application-service tokens."""
    path = folder / 'secrets.json'
    try:
        keys = json.loads(path.read_text())
    except (OSError, ValueError):
        keys = {}
    if not isinstance(keys, dict):
        keys = {}
    changed = False
    for name in ('livekit_api', 'as_token', 'hs_token'):
        if not isinstance(keys.get(name), str) or len(keys[name]) < 32:
            keys[name] = secrets.token_hex(32)
            changed = True
    if changed:
        _write(path, json.dumps(keys, indent=2))
    return keys


def registration(keys):
    """lk-jwt-service as a Synapse application service (its README, MSC4502 + MSC4512): it may ask whether a user is
    joined to a room, gets no event traffic, and Synapse forwards `/rtc/livekit/...` requests to it."""
    return {
        'id': 'livekit-jwt', 'url': None,
        'as_token': keys['as_token'], 'hs_token': keys['hs_token'],
        'sender_localpart': '_lk_jwt_service', 'rate_limited': False,
        'namespaces': {'users': [{'exclusive': False, 'regex': '.*'}], 'aliases': [], 'rooms': []},
        'io.element.msc4502.scopes': ['urn:matrix:client:io.element.msc4502:rooms:is_joined'],
        'io.element.msc4512.proxy_prefix': 'rtc/livekit',
        'io.element.msc4512.proxy_url': AUTH_URL,
    }


def livekit_config(turn_servers=None):
    """LiveKit's config. Rooms are made only by the token service for this box's own users (auto_create off); the
    media ports stay inside the container network (no published port), so media leaves the box outbound only.

    With the owner's Cloudflare TURN logins (call_cloudflare.py), LiveKit hands them to every caller and learns the
    box's public address over STUN, so a guest outside the tailnet relays its media through the owner's own Cloudflare
    account and LiveKit answers it outbound."""
    rtc = {'tcp_port': 7881, 'udp_port': 7882, 'use_external_ip': False}
    if turn_servers:
        rtc.update({'use_external_ip': True, 'stun_servers': [STUN], 'turn_servers': turn_servers})
    return {
        'port': 7880,
        'bind_addresses': ['0.0.0.0'],
        'rtc': rtc,
        'room': {'auto_create': False, 'empty_timeout': 300},
        'key_file': '/calls/livekit-keys.yaml',
        'webhook': {'api_key': LIVEKIT_KEY, 'urls': [AUTH_URL + '/sfu_webhook']},
        'logging': {'level': 'info', 'json': True},
    }


def write_livekit(root):
    """(Re)write LiveKit's config from the kept TURN logins (calls/ice.json, if any). A changed config bumps
    calls/livekit.gen, and the recipe's livekit loop restarts LiveKit on it."""
    folder = Path(root) / 'calls'
    try:
        turn = json.loads((folder / 'ice.json').read_text()).get('turn_servers')
    except (OSError, ValueError, AttributeError):
        turn = None
    text = json.dumps(livekit_config(turn if isinstance(turn, list) else None), indent=2)
    path = folder / 'livekit.yaml'
    try:
        same = path.read_text() == text
    except OSError:
        same = False
    if not same:
        _write(path, text)
        _write(folder / 'livekit.gen', secrets.token_hex(4) + '\n', 0o644)
    return not same


def prepare(root):
    """Run by unified-init at every start (as root, before files are handed to uid 1000)."""
    root = Path(root)
    folder = root / 'calls'
    folder.mkdir(mode=0o700, exist_ok=True)
    os.chmod(folder, 0o700)
    keys = _keys(folder)
    # LiveKit and lk-jwt-service both read `<key>: <secret>` (hex, so plain YAML).
    _write(folder / 'livekit-keys.yaml', f'{LIVEKIT_KEY}: {keys["livekit_api"]}\n')
    write_livekit(root)
    reg = json.dumps(registration(keys), indent=2)
    _write(folder / REGISTRATION, reg)
    _write(root / 'matrix' / REGISTRATION, reg)
    sync(root)


def synapse(config):
    """Add the call settings to Synapse's homeserver.yaml dict (Element Call's self-hosting prerequisites)."""
    files = list(config.get('app_service_config_files') or [])
    if '/data/' + REGISTRATION not in files:
        files.append('/data/' + REGISTRATION)
    config['app_service_config_files'] = files
    config['experimental_features'] = {
        **(config.get('experimental_features') or {}),
        'msc3266_enabled': True,  # room summary
        'msc4143_enabled': True,  # MatrixRTC transports endpoint
        'msc4222_enabled': True,  # sync v2 state_after
        'msc4502_enabled': True,  # application-service membership look-up (lk-jwt-service)
        'msc4512_enabled': True,  # application-service request proxying (lk-jwt-service)
    }
    # Delayed events (MSC4140): a dropped caller leaves the call instead of staying in it.
    config['max_event_delay_duration'] = '24h'
    config['rc_delayed_event_mgmt'] = {'per_second': 1, 'burst_count': 20}
    # Where clients find LiveKit. Messenger's call door rewrites it for the address the caller uses.
    config['matrix_rtc'] = {'transports': [{'type': 'm.livekit', 'url': LIVEKIT_WS}]}
    return config


def switch_on(root):
    """The owner's `calls` switch as stored by switches.SwitchStore (off when unreadable)."""
    try:
        values = json.loads((Path(root) / 'switches.json').read_text()).get('switches')
    except (OSError, ValueError, AttributeError):
        return False
    return isinstance(values, dict) and values.get(SWITCH) is True


def set_running(root, on):
    """Start (marker present) or stop (marker gone) LiveKit and the token service. Returns the new state."""
    marker = Path(root) / 'calls' / 'enabled'
    if on:
        marker.parent.mkdir(mode=0o700, parents=True, exist_ok=True)
        marker.touch(mode=0o600)
    else:
        marker.unlink(missing_ok=True)
    return bool(on)


def sync(root):
    return set_running(root, switch_on(root))


def running(root):
    return (Path(root) / 'calls' / 'enabled').exists()
