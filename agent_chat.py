"""The owner's agent chat (issue 265, switch agent-chat).

One pinned chat with the owner's own agent, kept on the box (people store kv `agent_chat`), never on a network.

- A note: anything the owner writes there is a note to self. The agent never answers it with text. It marks the note
  with a check (seen) once it picked it up (messenger_agent_chat_ack) and works on it in the background.
- Sweep: the owner taps Sweep. The agent answers that one request with ONE post: a numbered list of only what needs
  the owner since the last sweep, each item with the agent's recommendation and up to four buttons (label + value).
  A tap answers that item; the agent carries it out and collapses the item to its result (messenger_agent_chat_done).
- Urgent ping: one line (with an optional link), only for something time-sensitive. It makes the chat unread and
  counts on Messenger's badge.
- Report: a longer write-up. Reports stay out of the chat itself and show under its Reports button.

Quiet-mode guarantee: there is no reply kind. A ping is one short line, a sweep needs an open Sweep request (and
answers it), a report goes to Reports. So a note can never get a text reply in the chat.
"""
from __future__ import annotations

import json
import time
from typing import NoReturn
from urllib.parse import urlsplit

from engine import EngineError

SWITCH = 'agent-chat'
KEY = 'agent_chat'
MAX_ENTRIES = 400
SHOWN = 200
NOTE_MAX = 4000
PING_MAX = 200
REPORT_MAX = 16000
ITEM_MAX = 600
REC_MAX = 300
RESULT_MAX = 300
ITEMS_MAX = 20
BUTTONS_MAX = 4
LABEL_MAX = 24
VALUE_MAX = 64
KINDS = ('ping', 'sweep', 'report')


def _now():
    return int(time.time() * 1000)


def _bad(code, message, status=400) -> NoReturn:
    raise EngineError(code, message, status)


def _load(store):
    try:
        raw = json.loads(store.get(KEY) or 'null')
    except (ValueError, TypeError):
        raw = None
    raw = raw if isinstance(raw, dict) else {}
    entries = raw.get('entries') if isinstance(raw.get('entries'), list) else []
    return {'seq': raw.get('seq') if type(raw.get('seq')) is int else 0,
            'read_at': raw.get('read_at') if type(raw.get('read_at')) is int else 0,
            'reports_read_at': raw.get('reports_read_at') if type(raw.get('reports_read_at')) is int else 0,
            'entries': [e for e in entries if isinstance(e, dict) and isinstance(e.get('id'), str)]}


def _save(store, data):
    data['entries'] = data['entries'][-MAX_ENTRIES:]
    store.put(KEY, json.dumps(data, ensure_ascii=False))


def _new_id(data, prefix):
    data['seq'] += 1
    return prefix + str(data['seq'])


def _text(value, name, maximum, required=True, one_line=False):
    if value is None and not required:
        return None
    if not isinstance(value, str) or '\x00' in value:
        _bad('invalid_' + name, name.capitalize() + ' must be text')
    value = value.strip()
    if one_line:
        value = ' '.join(value.split())
    if not value:
        if required:
            _bad('invalid_' + name, name.capitalize() + ' is empty')
        return None
    if len(value) > maximum:
        _bad('invalid_' + name, '%s is too long (up to %d characters)' % (name.capitalize(), maximum))
    return value


def _link(value):
    if value in (None, ''):
        return None
    if not isinstance(value, str) or len(value) > 2000 or any(ord(c) <= 32 for c in value):
        _bad('invalid_link', 'link must be an http(s) address')
    try:
        parts = urlsplit(value)
    except ValueError:
        _bad('invalid_link', 'link must be an http(s) address')
    if parts.scheme not in ('http', 'https') or not parts.hostname or parts.username or parts.password:
        _bad('invalid_link', 'link must be an http(s) address')
    return value


def _items(raw):
    if raw is None:
        return []
    if not isinstance(raw, list) or len(raw) > ITEMS_MAX:
        _bad('invalid_items', 'items must be a list of up to %d' % ITEMS_MAX)
    out = []
    for i, item in enumerate(raw, 1):
        if not isinstance(item, dict):
            _bad('invalid_items', 'Each item must be an object')
        buttons = item.get('buttons') or []
        if not isinstance(buttons, list) or len(buttons) > BUTTONS_MAX:
            _bad('invalid_items', 'Each item has up to %d buttons' % BUTTONS_MAX)
        seen, clean = set(), []
        for b in buttons:
            if not isinstance(b, dict):
                _bad('invalid_items', 'A button is {"label", "value"}')
            label = _text(b.get('label'), 'label', LABEL_MAX, one_line=True)
            value = _text(b.get('value') if b.get('value') is not None else label, 'value', VALUE_MAX, one_line=True)
            if value in seen:
                _bad('invalid_items', 'Two buttons of one item have the same value')
            seen.add(value)
            clean.append({'label': label, 'value': value})
        out.append({'n': i, 'text': _text(item.get('text'), 'item', ITEM_MAX),
                    'recommendation': _text(item.get('recommendation'), 'recommendation', REC_MAX, required=False),
                    'buttons': clean, 'answer': None, 'result': None})
    return out


def _find(data, entry_id):
    for e in data['entries']:
        if e['id'] == entry_id:
            return e
    return None


def _open_sweep(data):
    for e in reversed(data['entries']):
        if e.get('kind') == 'ask' and not e.get('done'):
            return e
    return None


def _last_sweep_at(data):
    for e in reversed(data['entries']):
        if e.get('kind') == 'sweep':
            return e['at']
    return None


# ---- owner (Messenger view; no agent capability maps to /api/unified/agent-chat) ----
def state(unified):
    data = _load(unified.store)
    entries = data['entries']
    posts = [e for e in entries if e.get('by') == 'agent' and e.get('kind') != 'report']
    unread = [e for e in posts if e['at'] > data['read_at']]
    reports = [e for e in entries if e.get('kind') == 'report']
    return {'entries': entries[-SHOWN:], 'unread': len(unread), 'urgent': any(e['kind'] == 'ping' for e in unread),
            'reports_unread': sum(1 for e in reports if e['at'] > data['reports_read_at']),
            'sweep_open': _open_sweep(data) is not None, 'read_at': data['read_at']}


def note(unified, payload):
    body = _text((payload or {}).get('text'), 'note', NOTE_MAX)
    store = unified.store
    with store.lock:
        data = _load(store)
        entry = {'id': _new_id(data, 'n'), 'kind': 'note', 'by': 'owner', 'text': body, 'at': _now(), 'seen': None}
        data['entries'].append(entry)
        data['read_at'] = max(data['read_at'], entry['at'])
        _save(store, data)
    return state(unified)


def sweep(unified):
    store = unified.store
    with store.lock:
        data = _load(store)
        if _open_sweep(data) is None:
            at = _now()
            data['entries'].append({'id': _new_id(data, 's'), 'kind': 'ask', 'ask': 'sweep', 'by': 'owner', 'at': at,
                                    'since': _last_sweep_at(data), 'seen': None, 'done': None})
            data['read_at'] = max(data['read_at'], at)
            _save(store, data)
    return state(unified)


def answer(unified, payload):
    payload = payload or {}
    post_id, n, value = payload.get('post_id'), payload.get('item'), payload.get('value')
    if not isinstance(post_id, str) or type(n) is not int or not isinstance(value, str):
        _bad('invalid_answer', 'Choose one of the item\'s buttons')
    store = unified.store
    with store.lock:
        data = _load(store)
        post = _find(data, post_id)
        item = next((i for i in (post or {}).get('items') or [] if i.get('n') == n), None)
        if post is None or post.get('by') != 'agent' or item is None:
            _bad('not_found', 'That item is gone', 404)
        button = next((b for b in item.get('buttons') or [] if b.get('value') == value), None)
        if button is None:
            _bad('invalid_answer', 'Choose one of the item\'s buttons')
        if item.get('result') or (item.get('answer') or {}).get('seen'):
            _bad('already_answered', 'Your agent is already on it', 409)
        item['answer'] = {'label': button['label'], 'value': value, 'at': _now(), 'seen': None}
        _save(store, data)
    return state(unified)


def read(unified, payload=None):
    reports = (payload or {}).get('reports') is True
    store = unified.store
    with store.lock:
        data = _load(store)
        data['reports_read_at' if reports else 'read_at'] = _now()
        _save(store, data)
    return state(unified)


def dispatch(unified, method, suffix, payload):
    if not unified.switch_on(SWITCH):
        _bad('feature_off', 'The agent chat is not switched on in this Messenger', 409)
    if suffix == [] and method == 'GET':
        return state(unified)
    if suffix == [] and method == 'POST':
        return note(unified, payload)
    if suffix == ['sweep'] and method == 'POST':
        return sweep(unified)
    if suffix == ['answer'] and method == 'POST':
        return answer(unified, payload)
    if suffix == ['read'] and method == 'POST':
        return read(unified, payload)
    _bad('not_found', 'No such agent chat route', 404)


# ---- agent (MCP tools, switched on agent-chat) ----
def inbox(unified):
    data = _load(unified.store)
    notes, sweeps, answers = [], [], []
    for e in data['entries']:
        if e.get('kind') == 'note' and not e.get('seen'):
            notes.append({'id': e['id'], 'text': e['text'], 'at': e['at']})
        elif e.get('kind') == 'ask' and not e.get('done'):
            sweeps.append({'id': e['id'], 'at': e['at'], 'since': e.get('since')})
        elif e.get('by') == 'agent':
            for i in e.get('items') or []:
                a = i.get('answer')
                if a and not a.get('seen') and not i.get('result'):
                    answers.append({'id': '%s/%d' % (e['id'], i['n']), 'post_id': e['id'], 'item': i['n'],
                                    'item_text': i['text'], 'answer': a['value'], 'label': a['label'], 'at': a['at']})
    return {'notes': notes, 'sweep_requests': sweeps, 'answers': answers}


def ack(unified, agent, ids):
    if not isinstance(ids, list) or not ids or not all(isinstance(x, str) for x in ids):
        _bad('invalid_arguments', 'ids: the note and answer ids to mark as picked up')
    store, marked, unknown = unified.store, [], []
    with store.lock:
        data = _load(store)
        now = _now()
        for raw in ids[:100]:
            entry_id, _, n = raw.partition('/')
            e = _find(data, entry_id)
            if e is not None and n == '' and e.get('kind') == 'note':
                if not e.get('seen'):
                    e['seen'] = {'at': now, 'by': agent}
                marked.append(raw)
                continue
            if e is not None and n.isdigit() and e.get('by') == 'agent':
                item = next((i for i in e.get('items') or [] if i.get('n') == int(n)), None)
                if item and item.get('answer'):
                    item['answer']['seen'] = item['answer'].get('seen') or now
                    marked.append(raw)
                    continue
            unknown.append(raw)
        _save(store, data)
    return {'picked_up': marked, 'unknown': unknown}


def post(unified, agent, kind, text, link=None, items=None):
    if kind not in KINDS:
        _bad('invalid_arguments', 'kind must be ping, sweep or report')
    if kind == 'ping':
        if items:
            _bad('invalid_arguments', 'An urgent ping is one line: no items')
        body = _text(text, 'text', PING_MAX, one_line=True)
        clean = []
    elif kind == 'sweep':
        body = _text(text, 'text', ITEM_MAX, required=False) or ''
        clean = _items(items)
        if not clean and not body:
            body = 'Nothing needs you right now.'
    else:
        if items:
            _bad('invalid_arguments', 'A report has no buttons')
        body = _text(text, 'text', REPORT_MAX)
        clean = []
    url = _link(link)
    store = unified.store
    with store.lock:
        data = _load(store)
        entry = {'id': _new_id(data, 'p'), 'kind': kind, 'by': 'agent', 'agent': agent, 'text': body, 'link': url,
                 'items': clean, 'at': _now()}
        if kind == 'sweep':
            ask = _open_sweep(data)
            if ask is None:
                _bad('no_sweep_asked', 'The owner has not tapped Sweep. Post a sweep only as the answer to a sweep '
                     'request; for something that cannot wait, post one urgent ping.', 409)
            ask['done'] = entry['id']
            ask['seen'] = ask.get('seen') or {'at': entry['at'], 'by': agent}
            entry['reply_to'] = ask['id']
        data['entries'].append(entry)
        _save(store, data)
    return {'posted': entry['id'], 'kind': kind}


def done(unified, post_id, n, result):
    result = _text(result, 'result', RESULT_MAX, one_line=True)
    store = unified.store
    with store.lock:
        data = _load(store)
        e = _find(data, post_id) if isinstance(post_id, str) else None
        item = next((i for i in (e or {}).get('items') or [] if i.get('n') == n), None)
        if e is None or e.get('by') != 'agent' or item is None:
            _bad('not_found', 'No such sweep item', 404)
        item['result'] = result
        if item.get('answer'):
            item['answer']['seen'] = item['answer'].get('seen') or _now()
        _save(store, data)
    return {'done': '%s/%d' % (post_id, n)}
