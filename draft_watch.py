"""Agent keeps a draft ready (issue 178, switch agent-drafts).

The owner picks chats (chat ⋯ > Agent keeps a draft ready) or turns on "Draft for every unread chat". The agent asks
messenger_chats_needing_draft which of those chats wait on a reply with no fresh agent draft, and drafts there (or
updates the draft that is already waiting). Nothing is ever sent by the agent.

Learning loop: when the owner sends or discards a draft an agent wrote, the pair (what the agent drafted, what was
actually sent) is kept here, newest first, and handed back through messenger_draft_feedback, so the agent's drafts
come closer to how the owner writes. Everything lives in the people store's kv table on the box, never on a device.
"""
import json
import time

from engine import EngineError

SWITCH = 'agent-drafts'
WATCH_KEY = 'draft_watch'
FEEDBACK_KEY = 'draft_feedback'
WATCH_MAX = 500
FEEDBACK_MAX = 300
TEXT_MAX = 4000


def on(unified):
    switches = getattr(unified, 'switches', None)
    try:
        return bool(switches and switches.is_on(SWITCH))
    except Exception:
        return False


def _load(store, key, default):
    try:
        value = json.loads(store.get(key) or 'null')
    except (ValueError, TypeError):
        return default
    return value if isinstance(value, type(default)) else default


def settings(store):
    raw = _load(store, WATCH_KEY, {})
    watched = raw.get('watched')
    if not isinstance(watched, dict):
        watched = {}
    return {'watched': {k: v for k, v in watched.items() if isinstance(k, str) and isinstance(v, int)},
            'all_unread': raw.get('all_unread') is True}


def feedback(store):
    return [r for r in _load(store, FEEDBACK_KEY, []) if isinstance(r, dict)]


def stats(store):
    rows = feedback(store)
    count = lambda outcome: sum(1 for r in rows if r.get('outcome') == outcome)
    return {'sent_as_drafted': count('sent_as_drafted'), 'edited': count('edited'), 'discarded': count('discarded'),
            'total': len(rows)}


def state(unified):
    data = settings(unified.store)
    return {'on': on(unified), 'watched': sorted(data['watched']), 'all_unread': data['all_unread'],
            'stats': stats(unified.store)}


def configure(unified, payload):
    """Owner only (no agent capability maps to /api/unified/draft-watch): watch one chat, or every unread chat."""
    if not on(unified):
        raise EngineError('feature_off', 'Turn on Settings > Agent keeps drafts ready first', 403)
    if not isinstance(payload, dict):
        raise EngineError('invalid_watch', 'Choose a chat or the every-unread option', 400)
    store = unified.store
    with store.lock:
        data = settings(store)
        if 'all_unread' in payload:
            if not isinstance(payload['all_unread'], bool):
                raise EngineError('invalid_watch', 'all_unread must be true or false', 400)
            data['all_unread'] = payload['all_unread']
        elif isinstance(payload.get('person_id'), str) and isinstance(payload.get('on'), bool):
            person_id = payload['person_id']
            if payload['on']:
                store.person(person_id)  # not_found for an unknown chat
                data['watched'].setdefault(person_id, int(time.time() * 1000))
                if len(data['watched']) > WATCH_MAX:
                    raise EngineError('watch_limit', 'Up to %d chats can keep a draft ready' % WATCH_MAX, 409)
            else:
                data['watched'].pop(person_id, None)
        else:
            raise EngineError('invalid_watch', 'Choose a chat or the every-unread option', 400)
        store.put(WATCH_KEY, json.dumps(data))
    return state(unified)


def _norm(text):
    return ' '.join(str(text or '').split())


def _network(unified, row):
    try:
        _, identity = unified.channel(row.get('person_id'), row.get('identity_id') or None)
        return identity.get('network')
    except Exception:
        return None


def _title(unified, person_id):
    try:
        return unified.store.person(person_id).get('display_name')
    except Exception:
        return None


def closed(unified, row, outcome, sent_text=None):
    """The owner sent or discarded a draft. Kept only while the switch is on and an agent wrote words in it."""
    if not on(unified) or outcome not in ('sent', 'discarded'):
        return None
    drafted = row.get('agent_text')
    if not isinstance(drafted, str) or not drafted.strip():
        return None
    sent = None
    if outcome == 'sent':
        sent = sent_text if isinstance(sent_text, str) and sent_text.strip() else row.get('text')
        sent = str(sent or '')[:TEXT_MAX]
        outcome = 'sent_as_drafted' if _norm(sent) == _norm(drafted) else 'edited'
    entry = {'at': int(time.time() * 1000), 'chat_id': row.get('person_id'), 'chat': _title(unified, row.get('person_id')),
             'network': _network(unified, row), 'agent': row.get('agent_name'), 'outcome': outcome,
             'drafted': drafted[:TEXT_MAX], 'sent': sent}
    store = unified.store
    with store.lock:
        rows = [entry] + feedback(store)
        store.put(FEEDBACK_KEY, json.dumps(rows[:FEEDBACK_MAX]))
    return entry


def needing(unified, drafts, limit=20):
    """Watched chats (and, with every-unread on, unread chats that are not muted or low priority) whose newest message
    is from someone else and which have no agent draft written since that message. A chat where the owner is writing
    his own draft is left alone."""
    store = unified.store
    data = settings(store)
    waiting = {}
    for d in drafts:
        if d.get('state') != 'draft':
            continue
        old = waiting.get(d.get('person_id'))
        if old is None or (d.get('updated') or 0) > (old.get('updated') or 0):
            waiting[d.get('person_id')] = d
    out = []
    for p in store.people('person') + store.people('group'):
        watched = p['id'] in data['watched']
        busy_unread = data['all_unread'] and p.get('unread') and not p.get('muted') and not p.get('low_priority')
        if not (watched or busy_unread):
            continue
        last = p.get('last') or {}
        if not last or last.get('outgoing') or p.get('started'):
            continue
        draft = waiting.get(p['id'])
        if draft:
            by = (draft.get('updated_by') or draft.get('created_by') or {}).get('id')
            if by == 'owner' or (draft.get('updated') or 0) >= (last.get('timestamp') or 0):
                continue
        out.append((p, draft, 'watched' if watched else 'unread'))
    out.sort(key=lambda x: -((x[0].get('last') or {}).get('timestamp') or 0))
    return out[:limit], len(out)
