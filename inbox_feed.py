"""Wizard OS inbox feed: one item per chat the Messenger badge counts as unread.

GET  /api/inbox      -> {"inbox": 1, "items": [...]}   read-only, one query, no side effects.
POST /api/inbox/act  -> {"ok": true, ...}             'read' or 'reply' (owner's explicit action).

The feed mirrors the app badge (static/unified.js syncBadge): chats with unread
incoming messages, never muted or Low priority ones. Reading the chat anywhere
(opening it, Mark as read, this feed's 'read') moves last_read_ts past the
newest incoming message, so the item drops out by itself.
"""
import hashlib
import json
import re

from engine import EngineError

KEY = re.compile(r'chat:([A-Za-z0-9_-]{1,64})\Z')
ITEMS_MAX = 200
TEXT_MAX = 2000
REPLY_MAX = 16384
ACTIONS = [
    {'id': 'reply', 'label': 'Reply', 'input': True},
    {'id': 'draft', 'label': 'Draft me a reply',
     'ask': 'Draft a reply to this Messenger chat for me to review in Messenger. Do not send it.'},
    {'id': 'read', 'label': 'Mark as read'},
]
# Same labels the Inbox rows show (snippet() in static/unified.js).
LABELS = {'m.image': '📷 Photo', 'm.video': '🎬 Video', 'm.audio': '🎵 Audio', 'm.file': '📎 File',
          'm.sticker': 'Sticker', 'm.location': '📍 Location'}
MD_LINK = re.compile(r'\[([^\]\n]{1,300})\]\((https?://[^)\s]+)\)')
STORY = re.compile(r'^>\s*(Replied|Reacted) to @(.+?)[\'’]s story', re.S)

UNREAD_SQL = '''
SELECT * FROM (
  SELECT i.person_id, p.display_name, i.kind, m.original, m.msgtype, m.media, m.sender, m.timestamp,
         COUNT(*) OVER (PARTITION BY i.person_id) AS n,
         ROW_NUMBER() OVER (PARTITION BY i.person_id ORDER BY m.timestamp DESC, m.id DESC) AS rn
  FROM identity i
  JOIN person p ON p.id = i.person_id
  JOIN message m ON m.identity_id = i.id AND m.timestamp > i.last_read_ts
  WHERE m.outgoing = 0 AND m.deleted = 0 AND p.muted = 0 AND p.low_priority = 0
    AND i.kind IN ('person', 'group')
) WHERE rn = 1 ORDER BY timestamp DESC LIMIT ?
'''


def _plain(value):
    value = MD_LINK.sub(lambda m: m.group(1), value or '')
    value = re.sub(r'^>\s?', '', value, flags=re.M)
    return re.sub(r'\s*\n+\s*', ' ', value).strip()


def preview(row):
    """Plain-text line for the newest unread message (no HTML)."""
    original = row['original'] or ''
    story = STORY.match(original)
    if story:
        return ('❤️ ' if story.group(1) == 'Reacted' else '↩︎ ') + story.group(1) + ' to your story'
    try:
        media = json.loads(row['media']) if row['media'] else {}
    except ValueError:
        media = {}
    body = _plain(original)
    label = '🎤 Voice message' if isinstance(media, dict) and media.get('voice') else LABELS.get(row['msgtype'])
    if label:
        body = label + (' · ' + body if body and body != label else '')
    if row['kind'] == 'group' and row['sender']:
        body = row['sender'] + ': ' + body
    return body


def items(store):
    with store.db() as db:
        rows = db.execute(UNREAD_SQL, (ITEMS_MAX,)).fetchall()
    out = []
    for row in rows:
        line = preview(row)
        if row['n'] > 1:
            line = '%d new · %s' % (row['n'], line)
        out.append({
            'key': 'chat:' + row['person_id'],
            'title': (row['display_name'] or 'Chat').strip()[:200] or 'Chat',
            'text': line[:TEXT_MAX],
            'time': int(row['timestamp'] // 1000),
            'priority': 3,
            'open': '#chat=' + row['person_id'],
            'actions': ACTIONS,
        })
    return {'inbox': 1, 'items': out}


def _newest_incoming(store, person_id):
    with store.db() as db:
        row = db.execute('SELECT MAX(m.timestamp) FROM message m JOIN identity i ON i.id=m.identity_id '
                         'WHERE i.person_id=? AND m.outgoing=0', (person_id,)).fetchone()
    return row[0] if row and row[0] is not None else None


def act(unified, payload):
    """Run one owner action. Uses the very routes the Messenger view calls."""
    key, action = payload.get('key'), payload.get('action')
    if set(payload) - {'key', 'action', 'text'}:
        raise EngineError('invalid_input', 'Unknown fields', 400)
    match = KEY.fullmatch(key) if isinstance(key, str) else None
    if not match:
        raise EngineError('invalid_key', 'Unknown inbox item', 400)
    if action not in ('read', 'reply'):
        raise EngineError('unsupported_action', 'That action is not available here', 400)
    person_id = match.group(1)
    unified.store.person(person_id)  # 404 when the chat is gone
    base = '/api/unified/people/' + person_id
    result: dict = {'ok': True}
    if action == 'reply':
        text = payload.get('text')
        if not isinstance(text, str) or not text.strip() or len(text) > REPLY_MAX:
            raise EngineError('invalid_input', 'Type a reply first', 400)
        text = text.strip()
        newest = _newest_incoming(unified.store, person_id) or 0
        # A retried tap for the same unread state can never send twice (client id = Matrix txn id).
        client_id = 'ib' + hashlib.sha256(('%s|%s|%s' % (person_id, newest, text)).encode()).hexdigest()[:40]
        sent = unified.dispatch('POST', base + '/send', {'text': text, 'client_id': client_id})
        result['state'] = sent.get('state') if isinstance(sent, dict) else None
    newest = _newest_incoming(unified.store, person_id)
    if newest is not None:
        unified.dispatch('POST', base + '/read', {'timestamp': newest})
    return result
