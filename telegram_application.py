"""Owner-only initial Telegram application configuration, without host/Docker control.

The dormant Telegram process waits for its configured marker; publishing that
marker last starts only the bridge. Logging into Telegram remains an owner action.
"""
import json
import os
from pathlib import Path
import re
import tempfile

from engine import EngineError


def application_values(payload):
    if not isinstance(payload, dict) or set(payload) != {'api_id', 'api_hash'}:
        raise EngineError('invalid_telegram_application', 'Enter your Telegram application API ID and API hash.', 400)
    api_id, api_hash = payload['api_id'], payload['api_hash']
    if not isinstance(api_id, str) or not re.fullmatch(r'[1-9][0-9]{0,9}', api_id) or int(api_id) > 2147483647:
        raise EngineError('invalid_telegram_application', 'Telegram API ID must be a positive application number.', 400)
    if not isinstance(api_hash, str) or not re.fullmatch(r'[0-9a-fA-F]{32}', api_hash):
        raise EngineError('invalid_telegram_application', 'Telegram API hash must contain exactly 32 hexadecimal characters.', 400)
    return {'api_id': api_id, 'api_hash': api_hash}


def load_application(root):
    """Installer fallback: keep owner-entered app keys across app lifecycle updates."""
    path = Path(root) / 'telegram' / 'application.json'
    if not path.exists():
        return None
    return application_values(json.loads(path.read_text()))


def _write_private(path, value):
    # Fixed operator-owned paths only; fresh temporary files are never world-readable.
    path = Path(path)
    fd, name = tempfile.mkstemp(prefix='.application-', dir=path.parent)
    try:
        with os.fdopen(fd, 'w') as f:
            os.fchmod(f.fileno(), 0o600)
            json.dump(value, f, ensure_ascii=False)
            f.flush()
            os.fsync(f.fileno())
        os.replace(name, path)
        directory = os.open(path.parent, os.O_RDONLY | os.O_DIRECTORY)
        try:
            os.fsync(directory)
        finally:
            os.close(directory)
    finally:
        if os.path.exists(name):
            os.unlink(name)


def configure_application(root, payload):
    """First-time configuration only. Never replaces an existing account's keys."""
    values = application_values(payload)
    root = Path(root)
    conf_path = root / 'telegram' / 'config.yaml'
    state_path = root / 'unified' / 'configuration.json'
    connectors_path = root / 'unified' / 'connectors.json'
    try:
        config = json.loads(conf_path.read_text())
        state = json.loads(state_path.read_text())
        connectors = json.loads(connectors_path.read_text())
    except (OSError, ValueError):
        raise EngineError('telegram_plumbing_unavailable', 'Telegram installation needs repair before application setup.', 503) from None
    # application.json is the durable first-write intent. A retry may finish a
    # partially published transaction, but may never replace that intent's keys.
    try:
        saved = load_application(root)
    except (OSError, ValueError, EngineError):
        raise EngineError('telegram_plumbing_unavailable', 'Stored Telegram application setup needs repair.', 503) from None
    current = config.get('network', {})
    has_keys = bool(current.get('api_id'))
    if (saved is not None and saved != values) or (saved is None and (state.get('telegram_configured') is True or has_keys)):
        raise EngineError('telegram_already_configured', 'Telegram application is already configured. Use its account connection buttons.', 409)
    if has_keys and (current.get('api_id') != int(values['api_id']) or current.get('api_hash') != values['api_hash']):
        raise EngineError('telegram_already_configured', 'Telegram application is already configured. Use its account connection buttons.', 409)
    if saved is not None and has_keys and state.get('telegram_configured') is True and connectors.get('telegram', {}).get('enabled') is True and (root / 'telegram' / 'configured').is_file():
        return {'configured': True}
    # Mutate only the application keys and the matching dormant metadata. Never
    # regenerate registrations, provisioning keys, databases, or other networks.
    config['network']['api_id'] = int(values['api_id'])
    config['network']['api_hash'] = values['api_hash']
    state['telegram_configured'] = True
    connectors['telegram'] = {'enabled': True, 'url': 'http://telegram:29317'}
    try:
        _write_private(root / 'telegram' / 'application.json', values)
        _write_private(conf_path, config)
        _write_private(connectors_path, connectors)
        _write_private(state_path, state)
        # Publish last: the bridge cannot start with partially written config.
        _write_private(root / 'telegram' / 'configured', {'configured': True})
    except OSError:
        raise EngineError('telegram_setup_interrupted', 'Telegram setup was interrupted. Retry with the same application details.', 503) from None
    return {'configured': True}
