"""Opt-in bridge config, generated from verified upstream binaries; offline only."""
import json
import os
from pathlib import Path
import secrets
from unified_setup import write

EXTRA_NETWORKS = ('whatsapp', 'signal', 'slack', 'line', 'instagram', 'facebook', 'twitter', 'linkedin', 'gmessages', 'dots')

# bridgev2 backfill (pinned mautrix-go v0.32.0 keys). Forward backfill fills each
# NEW portal and catches up after restarts on stock Synapse. The backward queue
# needs Beeper batch sending ("Matrix server doesn't support batch sending"), so it
# stays off. Messages older than unread_hours_threshold arrive already read.
BACKFILL = {'enabled': True, 'max_initial_messages': 100, 'max_catchup_messages': 500,
            'unread_hours_threshold': 720}


def apply_history_settings(name, config):
    """Regenerated on every connector-init run; secrets come from connector-secrets.json."""
    config['backfill'].update(BACKFILL)
    config['backfill']['threads']['max_initial_messages'] = 50
    config['backfill']['queue']['enabled'] = False
    if name == 'whatsapp':
        # WhatsApp sends history only while pairing, and the bridge drops those
        # payloads unless backfill is enabled: existing links must re-pair once.
        # Full sync asks the phone for ~1 year instead of ~3 months.
        config['network']['history_sync'].update(max_initial_conversations=-1, request_full_sync=True)
    return config


def setup_connectors(root, enabled=()):
    root = Path(root)
    enabled = set(enabled)
    if not enabled <= set(EXTRA_NETWORKS):
        raise ValueError('Unknown optional connector')
    # Existing Telegram configuration/keys remain untouched.
    secret_path = root / 'unified' / 'connector-secrets.json'
    try:
        keys = json.loads(secret_path.read_text())
    except FileNotFoundError:
        keys = {}
    # Reuse the existing owner-only Matrix double-puppet registration. This is
    # functional parity, NOT a root-resistant secret boundary.
    old_keys = json.loads((root / 'unified' / 'secrets.json').read_text())
    matrix_path = root / 'matrix' / 'homeserver.yaml'
    matrix = json.loads(matrix_path.read_text())
    registrations = [p for p in matrix['app_service_config_files'] if not any(p.endswith('/' + n + '-registration.yaml') for n in EXTRA_NETWORKS)]
    configs = {}
    for name in EXTRA_NETWORKS:
        folder = root / name
        folder.mkdir(mode=0o700, exist_ok=True)
        os.chmod(folder, 0o700)
        marker = folder / 'configured'
        if name not in keys:
            keys[name] = {k: secrets.token_urlsafe(48) for k in ('as_token', 'hs_token', 'provisioning')}
        private = keys[name]
        config = json.loads((Path(__file__).parent / 'plumbing' / (name + '-template.json')).read_text())
        port = config['appservice']['port']
        url = 'http://%s:%s' % (name, port)
        config['homeserver'].update(address='http://matrix:8008', domain='messenger.internal')
        config['appservice'].update(address=url, public_address='', hostname='0.0.0.0', as_token=private['as_token'], hs_token=private['hs_token'])
        config['appservice']['bot']['avatar'] = ''
        # Match generated registration and trusted-inviter namespaces exactly.
        config['appservice']['id'] = name
        config['appservice']['bot']['username'] = name + 'bot'
        config['appservice']['username_template'] = name + '_{{.}}'
        if name == 'line':
            config['network']['qr_login'] = True
        if name in ('whatsapp', 'twitter', 'linkedin'):
            # No "(WA)"/"(Twitter)"/"(LinkedIn)" tag on every name: the Inbox shows the network's icon.
            tpl = config['network'].get('displayname_template') or ''
            for tag in (' (WA)', ' (Twitter)', ' (LinkedIn)'):
                tpl = tpl.replace(tag, '')
            config['network']['displayname_template'] = tpl
        if name == 'twitter':
            config['network']['x'] = True  # call it X in bridge notices; the protocol id stays 'twitter'
        if name == 'dots':
            # Upstream refuses to start otherwise (chatgpt-dots docs/README.md).
            config['bridge'].update(split_portals=True, async_events=False, portal_event_buffer=0)
        if name == 'gmessages':
            config['network']['device_meta']['os'] = 'Wizard'  # the name on the phone's paired devices
        config['database'].update(type='sqlite3-fk-wal', uri='file:/data/%s.db?_txlock=immediate' % name, max_open_conns=1, max_idle_conns=1)
        config['bridge']['permissions'] = {'*': 'block', '@owner:messenger.internal': 'admin'}
        config['matrix']['federate_rooms'] = False
        config['provisioning'].update(shared_secret=private['provisioning'], allow_matrix_auth=False, debug_endpoints=False, enable_session_transfers=False)
        # Private plaintext Matrix is the existing app contract, not end-to-end to the browser.
        config['encryption'].update(allow=False, default=False, require=False)
        config['double_puppet'].update(servers={}, secrets={'messenger.internal': 'as_token:' + old_keys['doublepuppet']})
        config['logging'] = {'min_level': 'error', 'writers': [{'type': 'stdout', 'format': 'json'}]}
        apply_history_settings(name, config)
        write(folder / 'config.yaml', config)
        write(root / 'matrix' / (name + '-registration.yaml'), {
            'id': name, 'url': url, 'as_token': private['as_token'], 'hs_token': private['hs_token'],
            'sender_localpart': name + 'bot', 'rate_limited': False,
            'namespaces': {'users': [{'exclusive': True, 'regex': '^@' + name + 'bot:messenger\\.internal$'}, {'exclusive': True, 'regex': '^@' + name + '_.*:messenger\\.internal$'}], 'aliases': [], 'rooms': []},
            'de.sorunome.msc2409.push_ephemeral': True,
        })
        registrations.append('/data/' + name + '-registration.yaml')
        configs[name] = {'enabled': name in enabled, 'url': url}
        if name in enabled:
            marker.touch(mode=0o600)
        else:
            marker.unlink(missing_ok=True)
    matrix['app_service_config_files'] = registrations
    write(matrix_path, matrix)
    # Telegram uses its existing provisioning secret; this adds a common provider view.
    old_keys = json.loads((root / 'unified' / 'secrets.json').read_text())
    old_conf = json.loads((root / 'unified' / 'configuration.json').read_text())
    keys['telegram'] = {'provisioning': old_keys['provisioning']}
    configs['telegram'] = {'enabled': old_conf.get('telegram_configured') is True, 'url': 'http://telegram:29317'}
    write(secret_path, keys)
    write(root / 'unified' / 'connectors.json', configs)
    if os.getuid() == 0:
        for folder in (root / 'matrix', root / 'unified', *(root / n for n in EXTRA_NETWORKS)):
            for p in (folder, *folder.rglob('*')):
                os.chown(p, 1000, 1000)


if __name__ == '__main__':
    os.umask(0o077)
    # Explicit opt-in only. Merely installing does not contact account services.
    root = Path(os.environ.get('MESSENGER_DATA', '/data'))
    try:
        saved = json.loads((root / 'unified' / 'connectors.json').read_text())
    except (OSError, ValueError):
        saved = {}
    enabled = {n for n in EXTRA_NETWORKS if saved.get(n, {}).get('enabled') is True}
    enabled.update(filter(None, os.environ.get('MESSENGER_CONNECTORS', '').split(',')))
    setup_connectors(root, enabled)
