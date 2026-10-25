"""First-start private Matrix plumbing. Never print credentials or full config."""
import json
import os
from pathlib import Path
import secrets


def write(path, value):
    path.parent.mkdir(parents=True, exist_ok=True)
    tmp = path.with_suffix('.new')
    with tmp.open('w') as f:
        os.chmod(tmp, 0o600)
        json.dump(value, f, indent=2, ensure_ascii=False)
        f.flush()
        os.fsync(f.fileno())
    tmp.replace(path)


def setup(root):
    root = Path(root)
    root.mkdir(parents=True, exist_ok=True)
    os.chmod(root, 0o700)
    for name in ('matrix', 'telegram', 'unified', 'translation'):
        (root / name).mkdir(mode=0o700, exist_ok=True)
        os.chmod(root / name, 0o700)
    private = root / 'unified' / 'secrets.json'
    if private.exists():
        keys = json.loads(private.read_text())
        if 'doublepuppet' not in keys:
            keys['doublepuppet'] = secrets.token_urlsafe(48)
            write(private, keys)
    else:
        keys = {k: secrets.token_urlsafe(48) for k in ('as_token', 'hs_token', 'provisioning', 'registration', 'owner_password', 'translation_token', 'doublepuppet')}
        write(private, keys)
    write(root / 'translation' / 'auth.json', {'translation_token': keys['translation_token']})
    registration = {
        'id': 'telegram', 'url': 'http://telegram:29317',
        'as_token': keys['as_token'], 'hs_token': keys['hs_token'],
        'sender_localpart': 'telegrambot', 'rate_limited': False,
        'namespaces': {'users': [{'exclusive': True, 'regex': '@telegram_.*:messenger\\.internal'}], 'aliases': [], 'rooms': []},
        'de.sorunome.msc2409.push_ephemeral': True,
    }
    write(root / 'matrix' / 'telegram-registration.yaml', registration)
    # Double puppeting: what the owner does in the Telegram app itself (messages sent,
    # chats read) arrives as the owner, not as their Telegram ghost. Owner only, no URL.
    write(root / 'matrix' / 'doublepuppet-registration.yaml', {
        'id': 'doublepuppet', 'url': None, 'as_token': keys['doublepuppet'], 'hs_token': secrets.token_urlsafe(32),
        'sender_localpart': 'doublepuppet-' + keys['doublepuppet'][:8].lower().replace('-', 'x').replace('_', 'x'), 'rate_limited': False,
        'namespaces': {'users': [{'exclusive': False, 'regex': '@owner:messenger\\.internal'}], 'aliases': [], 'rooms': []},
    })
    write(root / 'matrix' / 'homeserver.yaml', {
        'server_name': 'messenger.internal', 'pid_file': '/tmp/synapse.pid',
        'listeners': [{'port': 8008, 'type': 'http', 'tls': False, 'bind_addresses': ['0.0.0.0'], 'resources': [{'names': ['client'], 'compress': False}]}],
        'database': {'name': 'sqlite3', 'args': {'database': '/data/homeserver.db'}},
        'media_store_path': '/data/media', 'signing_key_path': '/data/signing.key',
        'report_stats': False, 'enable_registration': False,
        'registration_shared_secret': keys['registration'],
        'app_service_config_files': ['/data/telegram-registration.yaml', '/data/doublepuppet-registration.yaml'],
        'federation_domain_whitelist': [], 'allow_public_rooms_over_federation': False,
        'trusted_key_servers': [], 'suppress_key_server_warning': True,
        'url_preview_enabled': False, 'enable_metrics': False,
        # One owner on a private homeserver: Synapse's public-server defaults (0.2 msg/s) throttle fast chatting.
        'rc_message': {'per_second': 50, 'burst_count': 300},
        'log_config': '/data/log.yaml',
    })
    write(root / 'matrix' / 'log.yaml', {'version': 1, 'handlers': {'null': {'class': 'logging.NullHandler'}}, 'root': {'handlers': ['null'], 'level': 'WARNING'}, 'disable_existing_loggers': False})
    # Template is the pinned official binary's generated example, with no credentials.
    config = json.loads((Path(__file__).parent / 'plumbing' / 'telegram-template.json').read_text())
    api_id, api_hash = os.environ.get('TELEGRAM_API_ID', ''), os.environ.get('TELEGRAM_API_HASH', '')
    if not api_id and not api_hash:
        from telegram_application import load_application
        saved_application = load_application(root)
        if saved_application:
            api_id, api_hash = saved_application['api_id'], saved_application['api_hash']
    configured = bool(api_id and api_hash)
    if configured and (not api_id.isdecimal() or int(api_id) <= 0 or len(api_hash) != 32):
        raise ValueError('Telegram configuration requires a positive API ID and 32-character API hash')
    config['network']['api_id'] = int(api_id) if configured else 0
    config['network']['api_hash'] = api_hash if configured else ''
    config['homeserver'].update(address='http://matrix:8008', domain='messenger.internal')
    config['appservice'].update(address='http://telegram:29317', hostname='0.0.0.0', as_token=keys['as_token'], hs_token=keys['hs_token'])
    config['appservice']['bot']['avatar'] = ''
    config['database'].update(type='sqlite3-fk-wal', uri='file:/data/telegram.db?_txlock=immediate', max_open_conns=1, max_idle_conns=1)
    config['bridge']['permissions'] = {'*': 'block', '@owner:messenger.internal': 'admin'}
    # Disconnect clears the bridged copies (Telegram itself is untouched), so a reconnect rebuilds every chat with recent history.
    config['bridge']['cleanup_on_logout'] = {'enabled': True, 'manual': {k: 'delete' for k in ('private', 'relayed', 'shared_no_users', 'shared_has_users')}, 'bad_credentials': {k: 'nothing' for k in ('private', 'relayed', 'shared_no_users', 'shared_has_users')}}
    config['matrix']['federate_rooms'] = False
    config['provisioning'].update(shared_secret=keys['provisioning'], allow_matrix_auth=False)
    config['double_puppet'].update(servers={}, secrets={'messenger.internal': 'as_token:' + keys['doublepuppet']})
    config['logging'] = {'min_level': 'error', 'writers': [{'type': 'stdout', 'format': 'json'}]}
    # Bring recent history into each new or quiet chat (forward backfill works on stock Synapse),
    # and bridge the owner's 50 most recent dialogs on login instead of 15. Older history
    # (backfill.queue) needs Beeper batch sending, unavailable on stock Synapse: keep it off.
    config['backfill'].update(enabled=True, max_initial_messages=200, max_catchup_messages=500, unread_hours_threshold=720)
    config['backfill']['queue']['enabled'] = False
    config['network']['sync'].update(create_limit=50, login_sync_limit=50)
    write(root / 'telegram' / 'config.yaml', config)
    write(root / 'unified' / 'configuration.json', {'telegram_configured': configured})
    marker = root / 'telegram' / 'configured'
    if configured:
        marker.touch(mode=0o600)
    else:
        marker.unlink(missing_ok=True)
    # Each runtime is uid 1000, including Synapse (explicit compose override).
    if os.getuid() == 0:
        for p in [root, *root.rglob('*')]:
            os.chown(p, 1000, 1000)


if __name__ == '__main__':
    os.umask(0o077)
    setup(os.environ.get('MESSENGER_DATA', '/data'))
