"""New group from New message (issue 397, switch `new-group`, off by default).

The owner picks a network, two or more people from that network and a name (optional photo); the box asks that
network's bridge to create the group on the real network, joins its room and lists it in the Inbox at once.

Per network (pinned bridgev2 bridges, mautrix-go v0.32 provisioning v3):
- GET /capabilities -> provisioning.group_creation lists the group types a bridge can create, with the name and
  member rules. Only networks that list one are offered, so there is never a dead button. Today that is WhatsApp
  (type 'group', name up to 100, 1+ others, takes an avatar) and Telegram ('group', name required, 1-200 others).
- POST /create_group/<type> {participants, name, avatar} creates it (owner sender, one fixed route).
Wizard-to-Wizard chats (Marmot) are offered only once the engine stops listing 'group_chats' as unsupported.

Owner only: these routes sit under /api/unified/new-group, which permissions.capability_for maps to no agent
capability, and there is no MCP tool, so no agent can create a group at any access level.
"""
import json
import re
import secrets
import threading
import time
from typing import NoReturn
from urllib.parse import quote

from engine import EngineError

SWITCH = 'new-group'
CLIENT_ID = re.compile(r'[A-Za-z0-9_-]{8,64}\Z')
PHOTO_MAX = 5 * 1024 * 1024
PHOTO_TYPES = {'image/jpeg': 'photo.jpg', 'image/png': 'photo.png', 'image/webp': 'photo.webp'}
# Bridges whose CreateGroup itself takes the avatar (mautrix/whatsapp startchat.go). Elsewhere the picture is set
# as the room's picture right after, which the bridge forwards (HandleMatrixRoomAvatar; Telegram makes the creator
# an admin, so the owner may set it).
AVATAR_IN_CREATE = ('whatsapp',)
OPTIONS_TTL = 120
PEOPLE_TTL = 30 * 60
KEEP_CREATED = 50


def _fail(code, message, status=400) -> NoReturn:
    raise EngineError(code, message, status)


def _state(inbox):
    st = inbox.__dict__.get('_new_group')
    if st is None:
        st = inbox.__dict__.setdefault('_new_group', {'lock': threading.Lock(), 'options': None, 'people': {},
                                                       'photos': {}})
    return st


def _require_on(inbox):
    if not inbox.switch_on(SWITCH):
        _fail('feature_off', 'New group is not switched on', 404)
    if getattr(inbox, 'connectors', None) is None:
        _fail('unsupported_network', 'New groups need the connected networks of this Messenger', 409)


def default_name(names, limit=100):
    """'Ann, Bob and Cy' (first names), '+N' when long. Pure."""
    firsts = [(n or '').strip().split()[0] for n in names if (n or '').strip()]
    if not firsts:
        return 'New group'
    if len(firsts) == 1:
        text = firsts[0]
    elif len(firsts) <= 3:
        text = ', '.join(firsts[:-1]) + ' and ' + firsts[-1]
    else:
        text = ', '.join(firsts[:3]) + ' +' + str(len(firsts) - 3)
    return text[:limit]


def group_type(caps):
    """(type id, its rules) a bridge's /capabilities offers for a plain group, or None. Pure."""
    kinds = ((caps or {}).get('provisioning') or {}).get('group_creation') or {}
    if not isinstance(kinds, dict) or not kinds:
        return None
    key = 'group' if 'group' in kinds else sorted(kinds)[0]
    spec = kinds[key] if isinstance(kinds[key], dict) else {}
    return key, spec


def option(network, label, caps):
    """What New group shows for one network, from its bridge's capabilities. Pure."""
    found = group_type(caps)
    if not found:
        return None
    key, spec = found
    name, members = spec.get('name') or {}, spec.get('participants') or {}
    most = members.get('max_length') or 0
    # The issue asks for two or more people (a group, not a one-to-one chat).
    least = max(2, members.get('min_length') or 0)
    if most and most < least:
        return None
    return {'network': network, 'label': label, 'type': key,
            'name_required': bool(name.get('required')), 'name_max': name.get('max_length') or 100,
            'min': least, 'max': most or None,
            # The picture goes in the create call where the bridge takes it, else onto the room right after.
            'photo': True}


def options(inbox, fresh=False):
    """Networks where New group can create a group now: connected, and its bridge says it can."""
    _require_on(inbox)
    st = _state(inbox)
    cached = st['options']
    if cached and not fresh and time.time() - cached[0] < OPTIONS_TTL:
        return {'networks': cached[1]}
    from connectors import PROVIDERS
    out = []
    for network, provider in PROVIDERS.items():
        if not provider.supported:
            continue
        try:
            if (inbox.connectors.status(network) or {}).get('state') != 'connected':
                continue
            caps = inbox.connectors.request(network, '/capabilities', timeout=10)
        except EngineError:
            continue
        found = option(network, provider.label, caps)
        if found:
            out.append(found)
    # Wizard-to-Wizard (Marmot): only when the engine can make groups.
    try:
        unsupported = (inbox.engine.status() or {}).get('unsupported') or []
    except Exception:
        unsupported = ['group_chats']
    if 'group_chats' not in unsupported and hasattr(inbox.engine, 'create_group'):
        out.append({'network': 'messenger', 'label': 'Wizard', 'type': 'group', 'name_required': False,
                    'name_max': 100, 'min': 2, 'max': None, 'photo': False})
    st['options'] = (time.time(), out)
    return {'networks': out}


def _option(inbox, network):
    found = next((o for o in options(inbox)['networks'] if o['network'] == network), None)
    if not found:
        found = next((o for o in options(inbox, fresh=True)['networks'] if o['network'] == network), None)
    if not found:
        _fail('group_unsupported', 'New groups cannot be created on that network here', 409)
    return found


def _domain(inbox):
    owner = getattr(inbox, 'owner', '') or '@owner:messenger.internal'
    return owner.split(':', 1)[1] if ':' in owner else 'messenger.internal'


def ghost_for(network, user_id, domain):
    """The bridge ghost (Matrix id) of a network user, the form create_group accepts for participants. Pure."""
    if not isinstance(user_id, str) or not user_id or len(user_id) > 200:
        return None
    if user_id.startswith('@'):
        return user_id if user_id.startswith('@' + network + '_') and user_id.endswith(':' + domain) else None
    return None


def people(inbox, network):
    """Who can be added on one network: its bridge's contact list plus Messenger's one-to-one chats there.
    Read only (provisioning GET /contacts and the local store). Each entry's id is that person's bridge ghost."""
    _require_on(inbox)
    _option(inbox, network)
    domain, found = _domain(inbox), {}
    mine = set()
    try:
        mine = set(json.loads(inbox.store.get('own_ghosts') or '[]'))
    except (ValueError, TypeError):
        pass
    try:
        listed = (inbox.connectors.request(network, '/contacts', timeout=20) or {}).get('contacts')
    except EngineError:
        listed = None
    try:
        from connector_inbox import contact_label
    except Exception:  # pragma: no cover - the module is always there on a box
        contact_label = lambda entry, own: entry.get('name')  # noqa: E731
    for entry in listed if isinstance(listed, list) else []:
        if not isinstance(entry, dict):
            continue
        ghost = ghost_for(network, entry.get('mxid'), domain)
        name = contact_label(entry, ()) or entry.get('name')
        if ghost and ghost not in mine and isinstance(name, str) and name.strip():
            found[ghost] = {'id': ghost, 'name': name.strip()[:160]}
    # Chats already in Messenger: the other person's ghost per one-to-one room (the Contacts lookup).
    store = inbox.store
    with store.db() as db:
        accounts = store.room_accounts(db)
    for person in store.people('person', chats=False):
        for ident in person.get('identities') or []:
            if ident.get('network') != network:
                continue
            for account in accounts.get(ident.get('address')) or []:
                ghost = '@%s_%s:%s' % (network, account.get('value'), domain)
                if account.get('value') and ghost not in mine:
                    found[ghost] = {'id': ghost, 'name': person.get('display_name') or account.get('label') or ghost,
                                    'chat_id': person['id']}
    rows = sorted(found.values(), key=lambda r: r['name'].casefold())
    _state(inbox)['people'][network] = (time.time(), {r['id']: r['name'] for r in rows})
    return {'network': network, 'people': rows}


def _offered(inbox, network):
    cached = _state(inbox)['people'].get(network)
    if not cached or time.time() - cached[0] > PEOPLE_TTL:
        people(inbox, network)
        cached = _state(inbox)['people'][network]
    return cached[1]


def photo(inbox, raw):
    """The group's picture, uploaded before Create. Returns an id Create takes."""
    _require_on(inbox)
    if not isinstance(raw, (bytes, bytearray)) or not 0 < len(raw) <= PHOTO_MAX:
        _fail('invalid_upload', 'Choose a photo up to 5 MB', 413)
    from unified import sniff
    mime = sniff(bytes(raw))
    if mime not in PHOTO_TYPES:
        _fail('invalid_upload', 'Choose a JPEG, PNG or WebP photo', 415)
    mxc = (inbox.matrix_upload(bytes(raw), PHOTO_TYPES[mime], mime) or {}).get('content_uri')
    if not isinstance(mxc, str) or not mxc.startswith('mxc://'):
        _fail('upstream_unavailable', 'Upload failed. Please try again.', 503)
    photos = _state(inbox)['photos']
    now = time.time()
    for key in [k for k, v in photos.items() if v[1] < now]:
        photos.pop(key, None)
    key = secrets.token_hex(16)
    photos[key] = (mxc, now + 3600)
    return {'photo': key}


def _created(inbox):
    try:
        rows = json.loads(inbox.store.get('created_groups') or '{}')
        return rows if isinstance(rows, dict) else {}
    except (ValueError, TypeError):
        return {}


def create(inbox, payload):
    """Create the group on the real network. A repeated client_id returns the first answer (no second group)."""
    _require_on(inbox)
    payload = payload if isinstance(payload, dict) else {}
    client_id = payload.get('client_id')
    if not isinstance(client_id, str) or not CLIENT_ID.fullmatch(client_id):
        _fail('invalid_request', 'Missing request id')
    st = _state(inbox)
    with st['lock']:  # one create at a time: a double tap waits, then gets the same group
        done = _created(inbox).get(client_id)
        if done:
            return dict(done, repeated=True)
        network = (payload.get('network') or '').strip().lower() if isinstance(payload.get('network'), str) else ''
        opt = _option(inbox, network)
        picked = payload.get('people')
        if not isinstance(picked, list) or not all(isinstance(p, str) for p in picked):
            _fail('invalid_people', 'Pick the people for the group')
        picked = list(dict.fromkeys(picked))
        offered = _offered(inbox, network)
        if any(p not in offered for p in picked):
            # Only people this network listed: a typed or foreign id never reaches the bridge.
            _fail('invalid_people', 'Pick people from the ' + opt['label'] + ' list')
        if len(picked) < opt['min']:
            _fail('too_few_people', 'Pick at least %d people' % opt['min'])
        if opt['max'] and len(picked) > opt['max']:
            _fail('too_many_people', '%s groups can start with up to %d people' % (opt['label'], opt['max']))
        name = payload.get('name') if isinstance(payload.get('name'), str) else ''
        name = ' '.join(name.split())[:opt['name_max']] or default_name([offered[p] for p in picked], opt['name_max'])
        mxc = None
        if payload.get('photo'):
            held = st['photos'].get(payload.get('photo')) if isinstance(payload.get('photo'), str) else None
            if not held or held[1] < time.time():
                _fail('photo_expired', 'Choose the photo again')
            mxc = held[0]
        body = {'participants': picked, 'name': {'name': name}}
        if mxc and network in AVATAR_IN_CREATE:
            body['avatar'] = {'url': mxc}
        created = inbox.connectors.request(network, '/create_group/' + quote(opt['type'], safe=''), 'POST', body)
        room = created.get('mxid') if isinstance(created, dict) else None
        if not isinstance(room, str) or not room.startswith('!'):
            _fail('group_not_created', opt['label'] + ' could not create the group. Try again.', 502)
        try:
            # The bridge has invited the owner; joining is a Matrix write on the owner's side only.
            inbox.mx('/join/' + quote(room, safe=''), 'POST', {})
        except EngineError:
            pass  # the next sync joins the bridge's invitation
        photo_state = None
        if mxc:
            photo_state = 'set'
            if network not in AVATAR_IN_CREATE:
                try:
                    inbox.mx('/rooms/' + quote(room, safe='') + '/state/m.room.avatar/', 'PUT', {'url': mxc})
                except EngineError:
                    photo_state = 'failed'
            st['photos'].pop(payload.get('photo'), None)
        identity = inbox.store.identity(network, room, name, 'group')
        inbox.store.mark_started(identity['person_id'])
        failed = created.get('failed_participants') if isinstance(created.get('failed_participants'), dict) else {}
        result = {'chat_id': identity['person_id'], 'channel_id': identity['id'], 'network': opt['label'],
                  'name': identity['label'] or name, 'created': int(time.time() * 1000),
                  # People the network would not add straight away (WhatsApp privacy: it sends them an invite).
                  'not_added': sorted(offered.get(k) or offered.get('@%s_%s:%s' % (network, k, _domain(inbox))) or 'Someone'
                                      for k in failed),
                  'photo': photo_state}
        rows = _created(inbox)
        rows[client_id] = result
        keep = dict(sorted(rows.items(), key=lambda kv: -kv[1].get('created', 0))[:KEEP_CREATED])
        inbox.store.put('created_groups', json.dumps(keep))
        inbox.store.changed()
        return result


def dispatch(inbox, method, suffix, payload, query, raw):
    if method == 'GET' and suffix == []:
        return options(inbox)
    if method == 'GET' and suffix == ['people']:
        network = ((query or {}).get('network') or [''])[0]
        return people(inbox, network.strip().lower())
    if method == 'PUT' and suffix == ['photo']:
        return photo(inbox, raw)
    if method == 'POST' and suffix == []:
        return create(inbox, payload)
    _fail('not_found', 'Unknown New group route', 404)
