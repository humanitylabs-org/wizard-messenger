"""Start a chat with someone the owner has never chatted with, without sending anything (issue 176).

Behind the off-by-default switch `new-contact-drafts`. The bridge resolves the contact and opens an empty chat
room on the owner's side; no message, friend request or attachment goes to the contact. The first message is the
draft the owner later sends from Messenger.

Per network (pinned bridgev2 bridges, provisioning v3):
- WhatsApp: GET resolve_identifier/<E.164> asks WhatsApp's server whether the number has an account (a lookup the
  contact never sees), then POST create_dm/<number> opens the empty chat on the owner's side.
- Telegram: GET resolve_identifier/@username looks the public username up; create_dm opens the empty chat.
- LINE: POST search_users {query: LINE ID} looks the ID up (findContactByUserid; no friend request), then
  create_dm/<LINE user id> opens the empty chat on the owner's side.
Nothing here ever calls a send route, so there is no send-as-fallback.
"""
import re
import time
from urllib.parse import quote

from engine import EngineError

SWITCH = 'new-contact-drafts'
NETWORKS = ('whatsapp', 'telegram', 'line')
LABELS = {'whatsapp': 'WhatsApp', 'telegram': 'Telegram', 'line': 'LINE'}
NOT_FOUND = {'whatsapp': "This number isn't on WhatsApp", 'telegram': 'Telegram username not found',
             'line': 'LINE ID not found'}
HINT = {'whatsapp': 'Use the full phone number with its country code, e.g. +44 20 7946 0000',
        'telegram': 'Use a Telegram @username (5 to 32 letters, digits or _)',
        'line': 'Use a LINE ID or an official account id such as @propertyscout'}


def _fail(code, message, status=400):
    raise EngineError(code, message, status)


def identifier(network, to):
    """The bridge identifier for what the owner or agent typed, or a clear error. Pure: no I/O."""
    network = (network or '').strip().lower()
    if network not in NETWORKS:
        _fail('unsupported_network', 'New chats can be started on WhatsApp, Telegram or LINE')
    if not isinstance(to, str) or not to.strip() or len(to) > 80:
        _fail('invalid_contact', HINT[network])
    value = to.strip()
    if network == 'whatsapp':
        digits = re.sub(r'[\s().-]', '', value)
        if digits.startswith('00'):
            digits = '+' + digits[2:]
        if not re.fullmatch(r'\+[1-9][0-9]{6,14}', digits):
            _fail('invalid_contact', HINT[network])
        return digits
    if network == 'telegram':
        name = re.sub(r'^(?:https?://)?t\.me/', '', value, flags=re.I).removeprefix('@')
        # Same shape the Telegram bridge accepts as a username (5 to 32 characters, no double underscore).
        if not re.fullmatch(r'[A-Za-z][A-Za-z0-9_]{3,30}[A-Za-z0-9]', name) or '__' in name:
            _fail('invalid_contact', HINT[network])
        return '@' + name
    # LINE IDs: letters, digits, '.', '-', '_' (an official account starts with @).
    if not re.fullmatch(r'@?[A-Za-z0-9._-]{2,40}', value) or '..' in value:
        _fail('invalid_contact', HINT[network])
    return value.lower()


def _missing(error):
    return isinstance(error, EngineError) and 'M_NOT_FOUND' in (error.message or '')


def resolve(connectors, network, ident):
    """(bridge user id or identifier for create_dm, name). Read-only lookups; nothing reaches the contact."""
    if network == 'line':
        try:
            found = connectors.request('line', '/search_users', 'POST', {'query': ident})
        except EngineError as error:
            if _missing(error):
                _fail('contact_not_found', NOT_FOUND[network], 404)
            raise
        results = [r for r in (found or {}).get('results') or [] if isinstance(r, dict) and r.get('id')]
        if not results:
            _fail('contact_not_found', NOT_FOUND[network], 404)
        return str(results[0]['id']), results[0].get('name') or ident
    try:
        found = connectors.request(network, '/resolve_identifier/' + quote(ident, safe=''))
    except EngineError as error:
        if _missing(error):
            _fail('contact_not_found', NOT_FOUND[network], 404)
        raise
    if not isinstance(found, dict) or not found.get('id'):
        _fail('contact_not_found', NOT_FOUND[network], 404)
    return ident, found.get('name') or ident


def start(inbox, network, to):
    """Resolve the contact, open the empty chat and file it in the people store. Returns the chat."""
    if not inbox.switches.is_on(SWITCH):
        _fail('feature_off', 'Starting new chats is off. The owner can turn on Settings > Drafts to new contacts.', 403)
    ident = identifier(network, to)
    network = network.strip().lower()
    connectors = inbox.connectors
    status = connectors.status(network)
    if status.get('state') != 'connected':
        _fail('network_not_connected', LABELS[network] + ' is not connected in Messenger', 409)
    target, name = resolve(connectors, network, ident)
    created = connectors.request(network, '/create_dm/' + quote(str(target), safe=''), 'POST', {})
    room = (created or {}).get('dm_room_mxid') if isinstance(created, dict) else None
    if not isinstance(room, str) or not room.startswith('!'):
        _fail('chat_not_created', LABELS[network] + ' could not open the chat. Nothing was sent.', 502)
    name = (created.get('name') if isinstance(created, dict) else None) or name
    try:
        # The bridge has already invited the owner; joining is a Matrix write on the owner's side only.
        inbox.mx('/join/' + quote(room, safe=''), 'POST', {})
    except EngineError:
        pass  # the next sync joins the bridge's invitation
    identity = inbox.store.identity(network, room, name, 'person')
    inbox.store.mark_started(identity['person_id'])
    return {'chat_id': identity['person_id'], 'channel_id': identity['id'], 'network': LABELS[network],
            'name': identity['label'] or name, 'started': int(time.time() * 1000)}
