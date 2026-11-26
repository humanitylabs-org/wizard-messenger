"""Add contact on the network (issue 399, switch `add-contact`, off by default).

In a chat from someone who isn't a contact on that network yet, the owner can add them as a real contact there, the
same as the native app's "Add contact" bar on a chat from someone new. Messenger then also saves them in Wizard
Contacts (the view's existing Add to Contacts), so both lists match.

Per network, only where the bridge can do it (no dead button):
- Telegram (our patched mautrix-telegram, plumbing/telegram-bridge/contacts.patch): GET /v3/wizard/contact/<user id>
  says whether they are a contact and whether they can be added (not a bot, not you, not deleted); POST adds them with
  contacts.addContact under their name. The owner's phone number is never shared with them.
- WhatsApp (contacts live in the phone's address book), Signal and the rest have no such bridge route, so nothing is
  offered there. A bridge without the route (an older image) answers 404, which also means "not offered".

Owner only: the route sits under /api/unified/people/<id>/network-contact, which permissions.capability_for maps to no
agent capability, and there is no MCP tool, so no agent can add a contact at any access level. The account comes from
the chat itself (its one-to-one room's other member), never from the request.
"""
import re
import threading
import time
from typing import NoReturn

from engine import EngineError

SWITCH = 'add-contact'
# Networks whose bridge serves the Wizard contact routes, and the form of their user ids.
NETWORKS = {'telegram': re.compile(r'[0-9]{1,20}\Z')}
STATUS_TTL = 10 * 60
NAME_MAX = 128


def _fail(code, message, status=400) -> NoReturn:
    raise EngineError(code, message, status)


def _state(inbox):
    st = inbox.__dict__.get('_network_contact')
    if st is None:
        st = inbox.__dict__.setdefault('_network_contact', {'lock': threading.Lock(), 'status': {}})
    return st


def _require_on(inbox):
    if not inbox.switch_on(SWITCH):
        _fail('feature_off', 'Add contact is not switched on', 404)
    if getattr(inbox, 'connectors', None) is None:
        _fail('unsupported_network', 'Add contact needs the connected networks of this Messenger', 409)


def split_name(name):
    """('Gil', 'Novak') from 'Gil  Novak'; first word, then the rest. Pure."""
    words = ' '.join((name or '').split())[:NAME_MAX].split(' ')
    return (words[0], ' '.join(words[1:])) if words[0] else ('', '')


def accounts(inbox, person_id):
    """The chat's network accounts that could be a contact: one-to-one rooms on a network with the contact route."""
    person = inbox.store.person(person_id)
    with inbox.store.db() as db:
        remote = inbox.store.room_accounts(db)
    out = []
    for ident in person.get('identities') or []:
        if ident.get('kind') != 'person' or ident.get('network') not in NETWORKS:
            continue
        for account in remote.get(ident.get('address')) or []:
            value = account.get('value')
            if isinstance(value, str) and NETWORKS[ident['network']].fullmatch(value):
                out.append({'network': ident['network'], 'value': value})
    return person, out


def _label(network):
    try:
        from connectors import PROVIDERS
        return PROVIDERS[network].label
    except Exception:  # pragma: no cover - always there on a box
        return network.title()


def _entry(network, value, answer):
    answer = answer if isinstance(answer, dict) else {}
    return {'network': network, 'label': _label(network), 'contact': answer.get('contact') is True,
            'can_add': answer.get('can_add') is True and answer.get('contact') is not True}


def status(inbox, person_id, fresh=False):
    """{networks: [{network, label, contact, can_add}]} for the networks where this chat's person can be a contact."""
    _require_on(inbox)
    person, found = accounts(inbox, person_id)
    st, out = _state(inbox), []
    for account in found:
        key = (account['network'], account['value'])
        cached = st['status'].get(key)
        if cached and not fresh and time.time() - cached[0] < STATUS_TTL:
            out.append(cached[1])
            continue
        try:
            if (inbox.connectors.status(account['network']) or {}).get('state') != 'connected':
                continue
            answer = inbox.connectors.request(account['network'], '/wizard/contact/' + account['value'], timeout=20)
        except EngineError:
            continue  # no route on this bridge (older image), or the network is away: nothing to offer
        entry = _entry(account['network'], account['value'], answer)
        st['status'][key] = (time.time(), entry)
        out.append(entry)
    return {'person_id': person['id'], 'networks': out}


def add(inbox, person_id, payload):
    """Add this chat's person as a contact on one network, under the name the owner gave (else the chat's name)."""
    _require_on(inbox)
    payload = payload if isinstance(payload, dict) else {}
    network = payload.get('network') if isinstance(payload.get('network'), str) else ''
    person, found = accounts(inbox, person_id)
    account = next((a for a in found if a['network'] == network), None)
    if not account:
        _fail('contact_unsupported', 'This chat cannot be added as a contact there', 409)
    name = payload.get('name') if isinstance(payload.get('name'), str) else ''
    first, last = split_name(name or person.get('display_name') or '')
    with _state(inbox)['lock']:
        answer = inbox.connectors.request(network, '/wizard/contact/' + account['value'], 'POST',
                                          {'first_name': first, 'last_name': last})
        entry = _entry(network, account['value'], answer)
        if not entry['contact']:
            _fail('contact_not_added', entry['label'] + ' did not add the contact. Try again.', 502)
        _state(inbox)['status'][(network, account['value'])] = (time.time(), entry)
    return dict(entry, person_id=person['id'])


def dispatch(inbox, method, person_id, payload, query):
    if method == 'GET':
        return status(inbox, person_id, fresh=((query or {}).get('fresh') or [''])[0] == '1')
    if method == 'POST':
        return add(inbox, person_id, payload)
    _fail('not_found', 'Unknown Add contact route', 404)
