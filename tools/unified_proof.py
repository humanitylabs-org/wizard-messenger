"""Run only INSIDE the disposable preview Messenger container.
Uses a simulated bridge portal and disposable Matrix users, never Telegram contacts.
"""
import hashlib
import hmac
import json
import os
from pathlib import Path
import secrets
from urllib.parse import quote
from unified import UnifiedInbox, http

if os.environ.get('UNIFIED_PREVIEW_PROOF') != '1':
    raise SystemExit('Set UNIFIED_PREVIEW_PROOF=1 only for a disposable preview')
u = UnifiedInbox('/data', None)
owner_token = u.matrix_token()
key = os.environ['MESSENGER_API_TOKEN']
def api(path, body=None):
    return http('http://127.0.0.1:8765', '/api/unified/' + path, 'GET' if body is None else 'POST', body, key, 90)['result']
def mx(token, path, method='GET', body=None):
    return http(u.matrix, '/_matrix/client/v3' + path, method, body, token, 30)
def user(name):
    nonce = http(u.matrix, '/_synapse/admin/v1/register')['nonce']
    password = secrets.token_urlsafe(32)
    mac = hmac.new(u.keys()['registration'].encode(), '\0'.join([nonce, name, password, 'notadmin']).encode(), hashlib.sha1).hexdigest()
    return http(u.matrix, '/_synapse/admin/v1/register', 'POST', {'nonce': nonce, 'username': name, 'password': password, 'admin': False, 'mac': mac})['access_token']
def room(token, name, kind='dm'):
    result = mx(token, '/createRoom', 'POST', {'name': name, 'visibility': 'private', 'preset': 'private_chat', 'invite': [u.owner], 'creation_content': {'m.federate': False}, 'initial_state': [{'type': 'm.bridge', 'state_key': 'preview', 'content': {'bridgebot': '@telegrambot:messenger.internal', 'creator': '@telegrambot:messenger.internal', 'protocol': {'id': 'telegram', 'displayname': 'Telegram'}, 'channel': {'id': secrets.token_hex(4), 'displayname': name}, 'com.beeper.room_type.v2': kind}}]})
    room_id = result['room_id']
    mx(owner_token, '/join/' + quote(room_id, safe=''), 'POST', {})
    return room_id
def say(token, room_id, body):
    return mx(token, '/rooms/' + quote(room_id, safe='') + '/send/m.room.message/' + secrets.token_hex(12), 'PUT', {'msgtype': 'm.text', 'body': body})['event_id']

report = {'simulation': 'Real Synapse clients and rooms; simulated Telegram bridge metadata. No real Telegram login or delivery.', 'dormant': api('telegram/status')}
suffix = secrets.token_hex(4)
alice = user('preview_alice_' + suffix)
r1 = room(alice, 'Mali · preview ' + suffix)
r2 = room(alice, 'Mali second identity · ' + suffix)
rg = room(alice, 'Family · preview ' + suffix, 'group')
say(alice, r1, 'สวัสดีค่ะ เจอกันพรุ่งนี้ตอนหกโมงเย็นนะคะ')
say(alice, r2, 'This is my second contact channel.')
say(alice, rg, 'Family dinner on Sunday?')
import time
for attempt in range(30):
    if api('sync', {})['state'] == 'ready':
        break
    time.sleep(0.2)
else:
    raise AssertionError('Matrix sync did not settle')
people = api('people')['people']
def person_for(room_id):
    return next(p for p in people if any(i['address'] == room_id for i in p['identities']))
a, b = person_for(r1), person_for(r2)
api('people/' + a['id'], {'language': 'th', 'display_name': 'Mali · simulated portal'})
incoming = api('people/' + a['id'])['messages'][0]
report['incoming'] = {k: incoming[k] for k in ('original', 'translated', 'translation_error', 'network')}
assert incoming['network'] == 'telegram'
preview = api('people/' + a['id'] + '/preview', {'text': 'Hello! See you tomorrow at six in the evening.', 'identity_id': a['identities'][0]['id']})
report['outgoing_preview'] = {k: preview[k] for k in ('original', 'translated', 'error', 'language')}
if preview['error']:
    report['translation_proven'] = False
    sent = api('people/' + a['id'] + '/send', {'preview_id': preview['id'], 'send_original': True})
else:
    report['translation_proven'] = bool(incoming['translated'] and incoming['translated'] != incoming['original'] and preview['translated'] != preview['original'])
    sent = api('people/' + a['id'] + '/send', {'preview_id': preview['id'], 'send_original': False})
event = mx(alice, '/rooms/' + quote(r1, safe='') + '/event/' + quote(sent['event_id'], safe=''))
assert event['content']['body'] == preview['translated']
report['matrix_roundtrip'] = True
report['sent_text_read_by_second_matrix_user'] = event['content']['body']
merged = api('people/' + a['id'] + '/merge', {'source_id': b['id']})
assert len(merged['identities']) == 2
assert len(api('people/' + a['id'])['messages']) >= 3
separate = api('people/' + a['id'] + '/unmerge', {'identity_id': b['identities'][0]['id']})
assert len(api('people/' + a['id'])['person']['identities']) == 1
api('people/' + a['id'] + '/merge', {'source_id': separate['id']})
report['merge_unmerge'] = True
groups = api('groups')['groups']
g = next(g for g in groups if any(i['address'] == rg for i in g['identities']))
api('groups/' + g['identities'][0]['id'] + '/labels', {'labels': ['Family']})
assert next(x for x in api('groups')['groups'] if x['id'] == g['id'])['labels'] == ['Family']
report['group_label'] = True
Path('/data/unified/preview-proof.json').write_text(json.dumps(report, ensure_ascii=False, indent=2))
print(json.dumps(report, ensure_ascii=False, indent=2))
