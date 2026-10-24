"""Opt-in multi-network inbox; baseline UnifiedInbox remains unchanged.

Methods adapted from the local MIT unified.py; shared algorithms are deliberately
kept in sync with baseline 490abc8. Parent integration selects this class after
owner/agent boundary wiring. No writer means NO Matrix/provisioning writes.
"""
from unified import *
from connectors import Connectors, MATRIX_NETWORKS, PROVIDERS, room_network


class ConnectorInbox(UnifiedInbox):
    def __init__(self, data, engine, sender=None):
        super().__init__(data, engine)
        self.sender = sender
        self.connectors = Connectors(self.root, self.owner, writer=sender,
                                     ensure_owner=self.matrix_token)

    def mx(self, path, method='GET', body=None, timeout=15):
        if method == 'GET':
            # No implicit registration from a read. Bootstrap is owner-only.
            token = self.store.get('matrix_token')
            if not token:
                fail('owner_bootstrap_required', 'Owner must initialize the private Matrix account', 409)
            return http(self.matrix, '/_matrix/client/v3' + path, method, body, token, timeout)
        if self.sender is None:
            fail('sender_required', 'An authorized owner sender is required for network writes', 403)
        return self.sender(network='matrix', base=self.matrix,
                           path='/_matrix/client/v3' + path, method=method,
                           body=body, token=self.store.get('matrix_token'), timeout=timeout)

    def matrix_token(self):
        # Register/login is also a write; do not bypass the isolated sender.
        token = self.store.get('matrix_token')
        if not token:
            fail('owner_bootstrap_required', 'Initialize Matrix on the owner-controlled sender and provision its read capability separately', 409)
        return token

    def trusted_inviter(self, sender):
        if not sender.endswith(':messenger.internal'):
            return False
        for network in MATRIX_NETWORKS:
            try:
                self.connectors.config(network)
            except EngineError:
                continue
            if sender.startswith('@' + network + '_') or sender == '@' + network + 'bot:messenger.internal':
                return True
        return False

    def dispatch(self, method, path, payload, query=None, raw=None):
        parts = [unquote(p) for p in path.split('?')[0].strip('/').split('/')]
        if parts[:3] == ['api', 'unified', 'connectors']:
            return self.connectors.dispatch(method, parts[3:], payload)
        if parts[:3] == ['api', 'unified', 'telegram']:
            return self.connectors.dispatch(method, ['telegram'] + parts[3:], payload)
        return super().dispatch(method, path, payload, query, raw)

    def telegram_status(self):
        # General status is available to a machine key: never include pending QR
        # provisioning data, even when the owner is currently linking a device.
        return self.connectors.status('telegram')

    def provision(self, path, method='GET', body=None):
        # Preserve the legacy Telegram routes, but all writes use the sender.
        return self.connectors.request('telegram', path, method, body)

    def room_meta(self, room, data):
        """Room kind/label/member names, cached; full state is fetched only for new rooms or state changes."""
        meta = self.rooms.get(room)
        if meta is None:
            with self.store.db() as db:
                row = db.execute('SELECT json FROM room_meta WHERE room=?', (room,)).fetchone()
            meta = json.loads(row[0]) if row else None
        events = (data.get('state', {}).get('events') or []) + [e for e in data.get('timeline', {}).get('events', []) if 'state_key' in e]
        if meta is not None and 'network' in meta and not any(e.get('type') in self.META_TYPES for e in events):
            self.rooms[room] = meta
            return meta
        state = self.mx(self.room(room) + '/state')
        info = next((e['content'] for e in state if e['type'] in ('m.bridge', 'uk.half-shot.bridge')), None)
        network = room_network(state)
        meta = {'network': network, 'telegram': network == 'telegram'}
        if meta['network']:
            channel = info.get('channel', {})
            members = [e for e in state if e['type'] == 'm.room.member' and e.get('content', {}).get('membership') == 'join' and e.get('state_key') not in (self.owner, '@' + network + 'bot:messenger.internal')]
            # bridgev2 emits room_type in bridge info; fallback counts real participants.
            room_type = info.get('com.beeper.room_type.v2') or channel.get('fi.mau.' + network + '.type') or info.get('com.beeper.room_type')
            meta['space'] = any(e['type'] == 'm.room.create' and e.get('content', {}).get('type') == 'm.space' for e in state)
            meta['kind'] = 'person' if room_type in ('dm', 'private') or (room_type is None and len(members) == 1) else 'group'
            meta['label'] = next((e['content'].get('name') for e in state if e['type'] == 'm.room.name'), None) or channel.get('displayname') or PROVIDERS[network].label + ' conversation'
            meta['names'] = {e.get('state_key'): (e.get('content') or {}).get('displayname') for e in state if e['type'] == 'm.room.member' and (e.get('content') or {}).get('displayname')}
        with self.store.db() as db:
            db.execute('INSERT OR REPLACE INTO room_meta VALUES (?,?)', (room, json.dumps(meta, ensure_ascii=False)))
        self.rooms[room] = meta
        return meta

    def ingest(self, identity, meta, event, *, live=False):
        etype, content = event.get('type'), event.get('content') or {}
        sender = event.get('sender', '')
        outgoing = self.is_me(sender)
        relates = content.get('m.relates_to') or {}
        if etype == 'm.room.redaction':
            target = event.get('redacts') or content.get('redacts')
            if target:
                self.store.redact(target)
            return
        if etype == 'm.reaction' and relates.get('rel_type') == 'm.annotation' and isinstance(relates.get('key'), str):
            self.store.react(event['event_id'], relates.get('event_id', ''), sender, relates['key'][:32], outgoing)
            return
        if etype == 'm.room.message' and relates.get('rel_type') == 'm.replace':
            new = content.get('m.new_content') or {}
            if isinstance(new.get('body'), str) and new.get('msgtype') in ('m.text', 'm.notice', 'm.emote'):
                with self.store.db() as db:
                    ok = db.execute('SELECT 1 FROM message WHERE id=? AND (sender=? OR (outgoing=1 AND ?))', (relates.get('event_id'), meta.get('names', {}).get(sender) or sender, outgoing)).fetchone()
                if ok:
                    self.store.bump(relates.get('event_id'), ',original=?,translated=NULL,translation_error=NULL,edited=1', (new['body'],))
            return
        if sender == '@' + identity['network'] + 'bot:messenger.internal':
            # Bridge error notices are not chat lines: mark our newest recent outgoing message as failed.
            if content.get('msgtype') == 'm.notice':
                stamp = event.get('origin_server_ts', 0)
                with self.store.db() as db:
                    row = db.execute('SELECT id FROM message WHERE identity_id=? AND outgoing=1 AND timestamp BETWEEN ? AND ? ORDER BY timestamp DESC LIMIT 1',
                                     (identity['id'], stamp - 120000, stamp + 5000)).fetchone()
                if row:
                    self.store.bump(row[0], ',failed=?', (PROVIDERS[identity['network']].label + ' did not accept this message',))
            return
        parts = message_parts(event)
        if parts is None:
            return
        msgtype, body, media, reply_to = parts
        self.store.add_message(event['event_id'], identity, meta.get('names', {}).get(sender) or sender, outgoing, body,
                               event.get('origin_server_ts', 0), msgtype=msgtype, media=media, reply_to=reply_to, push_live=live)

    def ephemeral(self, identity, events):
        for event in events:
            if event.get('type') == 'm.typing':
                users = [u for u in (event.get('content') or {}).get('user_ids', []) if not self.is_me(u)]
                names = self.rooms.get(identity['address'], {}).get('names', {})
                now = [names.get(u) or 'Someone' for u in users]
                if self.typing.get(identity['person_id'], {}).get('names') != now:
                    self.typing[identity['person_id']] = {'names': now, 'until': time.time() + 30}
                    self.store.touch_identity(identity['id'])
            elif event.get('type') == 'm.receipt':
                for event_id, kinds in (event.get('content') or {}).items():
                    for kind in ('m.read', 'm.read.private'):
                        for user in (kinds.get(kind) or {}):
                            with self.store.db() as db:
                                row = db.execute('SELECT timestamp FROM message WHERE id=?', (event_id,)).fetchone()
                            if not row:
                                continue
                            if self.is_me(user):
                                self.store.touch_identity(identity['id'], last_read_ts=row[0])
                            elif user != '@' + identity['network'] + 'bot:messenger.internal':
                                self.store.touch_identity(identity['id'], peer_read_ts=row[0])

    def sync(self, timeout_ms=0):
        if not self.sync_lock.acquire(blocking=False):
            return {'state': 'syncing'}
        try:
            self.learn_me()
            since = self.store.get('sync_token')
            query = {'timeout': timeout_ms if since else 0, 'filter': json.dumps({'room': {'timeline': {'limit': 100}}})}
            if since:
                query['since'] = since
            result = self.mx('/sync?' + urlencode(query), timeout=timeout_ms / 1000 + 15)
            for room, invited in result.get('rooms', {}).get('invite', {}).items():
                events = invited.get('invite_state', {}).get('events', [])
                # Never auto-join arbitrary invitations: bridge bot/ghost namespace only.
                if any(e.get('type') == 'm.room.member' and e.get('state_key') == self.owner and self.trusted_inviter(e.get('sender', '')) for e in events):
                    self.mx('/join/' + quote(room, safe=''), 'POST', {})
            for room in result.get('rooms', {}).get('leave', {}):
                # A bridged chat that was removed (e.g. on disconnect) leaves no stale card behind.
                if any([self.store.forget(network, room) for network in MATRIX_NETWORKS]):
                    self.store.next_seq()
                    self.notify()
            for room, data in result.get('rooms', {}).get('join', {}).items():
                if data.get('timeline', {}).get('limited'):
                    self.store.put('history_gap:' + room, 'Earlier history may be incomplete')
                meta = self.room_meta(room, data)
                if not meta.get('network') or meta.get('space'):
                    continue
                identity = self.store.identity(meta['network'], room, meta['label'], meta['kind'])
                for event in data.get('timeline', {}).get('events', []):
                    self.ingest(identity, meta, event, live=bool(since))
                self.ephemeral(identity, data.get('ephemeral', {}).get('events', []))
            self.store.put('sync_token', result['next_batch'])
            self.store.put('sync_error', '')
            return {'state': 'ready'}
        except EngineError as error:
            self.store.put('sync_error', error.message)
            return {'state': 'unavailable', 'error': error.message}
        finally:
            self.sync_lock.release()

    def backfill_media(self, identity):
        """Rows stored before media support carry only "[Photo] caption"; re-read recent room history once
        and upgrade those rows in place so the pictures appear a moment after the thread opens."""
        room = identity['address']
        if room in self.backfilled or identity['network'] not in MATRIX_NETWORKS:
            return
        self.backfilled.add(room)
    
        def run():
            try:
                meta = self.room_meta(room, {})
                token = None
                for _ in range(3):
                    query = {'dir': 'b', 'limit': 100}
                    if token:
                        query['from'] = token
                    page = self.mx(self.room(room) + '/messages?' + urlencode(query))
                    for event in page.get('chunk', []):
                        if event.get('type') in ('m.room.message', 'm.sticker', 'm.reaction', 'm.room.redaction'):
                            self.ingest(identity, meta, event)
                    token = page.get('end')
                    if not token or not page.get('chunk'):
                        break
            except Exception:
                self.backfilled.discard(room)
        threading.Thread(target=run, name='media-backfill', daemon=True).start()

    def confirm(self, person_id, payload):
        with self.lock:
            with self.store.db() as db:
                row = db.execute('SELECT * FROM preview WHERE id=? AND person_id=?', (payload.get('preview_id'), person_id)).fetchone()
                if not row:
                    fail('invalid_preview', 'Preview this message before sending')
                p = dict(row)
                if p['status'] in ('sent', 'queued'):
                    return {'state': p['status'], 'event_id': p['event_id']}
                if p['status'] == 'preview' and p['expires'] < time.time():
                    fail('preview_expired', 'Preview expired. Review the text again.', 409)
                identity = db.execute('SELECT * FROM identity WHERE id=? AND person_id=?', (p['identity_id'], person_id)).fetchone()
                if not identity:
                    fail('identity_changed', 'The person’s channels changed. Preview again.', 409)
                send_original = payload.get('send_original') is True
                if p['error'] and not send_original:
                    fail('translation_failed', 'Translation failed. Explicitly choose Send original.', 409)
                if p['status'] != 'preview' and p['send_original'] != int(send_original):
                    fail('request_id_conflict', 'A retry must preserve the confirmed text.', 409)
                db.execute("UPDATE preview SET status='sending',send_original=? WHERE id=?", (int(send_original), p['id']))
            body = p['original'] if send_original else p['translated']
            reply_to = self.reply_target(identity, payload.get('reply_to'))
            # Stable transaction ID makes even ambiguous Matrix retries idempotent.
            delivery = 'sent'
            if identity['network'] in MATRIX_NETWORKS:
                content = {'msgtype': 'm.text', 'body': body}
                if reply_to:
                    content['m.relates_to'] = {'m.in_reply_to': {'event_id': reply_to}}
                result = self.mx(self.room(identity['address']) + '/send/m.room.message/' + p['id'], 'PUT', content)
                event = result['event_id']
            else:
                result = self.engine.send(identity['address'], {'text': body, 'request_id': p['id']})
                event = 'messenger:' + result['message_ids'][0]
                delivery = 'sent' if result['published'] else 'queued'
            self.store.add_message(event, identity, self.owner, True, body, int(time.time() * 1000), p['original'] if body != p['original'] else None,
                                   reply_to=reply_to, client_id=payload.get('client_id'))
            with self.store.db() as db:
                db.execute('UPDATE preview SET status=?,event_id=? WHERE id=?', (delivery, event, p['id']))
                # A sync may have received our event before the confirm receipt.
                db.execute('UPDATE message SET translated=? WHERE id=?', (p['original'] if body != p['original'] else None, event))
            return {'state': delivery, 'event_id': event, 'message': self.row(event)}

    def send(self, person_id, payload):
        """One-call send for chats that need no translation review; the client id is the Matrix
        transaction id, so a retried tap can never produce a second message."""
        if payload.get('preview_id'):
            return self.confirm(person_id, payload)
        client_id = payload.get('client_id')
        if not isinstance(client_id, str) or not re.fullmatch(r'[A-Za-z0-9_-]{8,64}', client_id):
            fail('invalid_client_id', 'Missing message id')
        with self.store.db() as db:
            done = db.execute('SELECT id FROM message WHERE client_id=?', (client_id,)).fetchone()
        if done:
            return {'state': 'sent', 'event_id': done[0], 'message': self.row(done[0])}
        person, identity = self.channel(person_id, payload.get('identity_id'))
        upload = self.uploads.get(payload.get('upload_id')) if payload.get('upload_id') else None
        if payload.get('upload_id') and (not upload or upload['person_id'] != person_id):
            fail('upload_expired', 'Attach the file again', 409)
        body = payload.get('text') or ''
        if body:
            body = text(body)
        elif not upload:
            fail('invalid_input', 'Please enter valid text')
        if body and not upload and person['language'] and person['language'] != 'en':
            fail('review_required', 'This chat translates before sending', 409)
        reply_to = self.reply_target(identity, payload.get('reply_to'))
        if identity['network'] not in MATRIX_NETWORKS:
            if upload:
                fail('media_unsupported', 'Photos and voice notes are not available on Messenger yet', 409)
            result = self.engine.send(identity['address'], {'text': body, 'request_id': client_id[:64]})
            event = 'messenger:' + result['message_ids'][0]
            self.store.add_message(event, identity, self.owner, True, body, int(time.time() * 1000), client_id=client_id)
            return {'state': 'sent' if result['published'] else 'queued', 'event_id': event, 'message': self.row(event)}
        msgtype, media = 'm.text', None
        if upload:
            msgtype, content, media = self.media_content(upload, body, payload)
        else:
            content = {'msgtype': 'm.text', 'body': body}
        if reply_to:
            content['m.relates_to'] = {'m.in_reply_to': {'event_id': reply_to}}
        started = time.time()
        result = self.mx(self.room(identity['address']) + '/send/m.room.message/' + client_id, 'PUT', content)
        self.timing('send', started)
        event = result['event_id']
        self.store.add_message(event, identity, self.owner, True, body if upload is None else (body or ''), int(time.time() * 1000),
                               msgtype=msgtype, media=media, reply_to=reply_to, client_id=client_id)
        if upload:
            self.uploads.pop(payload.get('upload_id'), None)
        return {'state': 'sent', 'event_id': event, 'message': self.row(event)}

    def upload(self, person_id, kind, data):
        """Owner upload (already size-capped by the view server) → Synapse media repo. Returns an opaque id."""
        if kind not in ('image', 'voice'):
            fail('invalid_upload', 'Choose a photo or a voice note')
        _, identity = self.channel(person_id)
        if identity['network'] not in MATRIX_NETWORKS:
            fail('media_unsupported', 'Photos and voice notes are not available on Messenger yet', 409)
        mime = sniff(data)
        if kind == 'voice' and mime == 'video/mp4':
            mime = 'audio/mp4'  # Safari records voice into an mp4 container
        ok = {'image': ('image/jpeg', 'image/png', 'image/gif', 'image/webp'), 'voice': ('audio/ogg', 'audio/webm', 'audio/mp4')}[kind]
        if mime not in ok:
            fail('invalid_upload', 'That file type is not supported here', 415)
        ext = {'image/jpeg': 'jpg', 'image/png': 'png', 'image/gif': 'gif', 'image/webp': 'webp', 'audio/ogg': 'ogg', 'audio/webm': 'webm', 'audio/mp4': 'm4a'}[mime]
        filename = ('voice-message.' if kind == 'voice' else 'photo.') + ext
        started = time.time()
        if self.sender is None:
            fail('sender_required', 'An authorized owner sender is required for uploads', 403)
        result = self.sender(network='matrix', base=self.matrix,
                             path='/_matrix/media/v3/upload?' + urlencode({'filename': filename}),
                             method='POST', body=data, token=self.store.get('matrix_token'),
                             content_type=mime, timeout=60)
        mxc = result['content_uri']
        self.timing('upload', started)
        upload_id = secrets.token_hex(16)
        now = time.time()
        self.uploads = {k: v for k, v in self.uploads.items() if v['expires'] > now}
        self.uploads[upload_id] = {'mxc': mxc, 'mime': mime, 'size': len(data), 'kind': kind, 'filename': filename, 'person_id': person_id, 'expires': now + 3600}
        return {'upload_id': upload_id, 'mime': mime, 'size': len(data)}

    def react(self, message_id, payload):
        message = self.store.message(message_id)
        key = payload.get('key')
        if not isinstance(key, str) or not key or len(key) > 32:
            fail('invalid_input', 'Choose a reaction')
        if message['network'] not in MATRIX_NETWORKS:
            fail('unsupported', 'Reactions are not available on Messenger yet', 409)
        room = self.room(message['address'])
        with self.store.db() as db:
            mine = db.execute('SELECT event_id,key FROM reaction WHERE message_id=? AND outgoing=1', (message_id,)).fetchall()
        # Telegram allows one reaction per person here: replace any previous one (Signal behaves the same).
        for row in mine:
            self.mx(room + '/redact/' + quote(row[0], safe='') + '/' + secrets.token_hex(8), 'PUT', {})
            self.store.redact(row[0])
        if payload.get('remove') is True or any(r[1] == key for r in mine):
            return {'message': self.row(message_id)}
        result = self.mx(room + '/send/m.reaction/' + secrets.token_hex(12), 'PUT',
                         {'m.relates_to': {'rel_type': 'm.annotation', 'event_id': message_id, 'key': key}})
        self.store.react(result['event_id'], message_id, self.owner, key, True)
        return {'message': self.row(message_id)}

    def edit(self, message_id, payload):
        message = self.store.message(message_id)
        new = text(payload.get('text'))
        if not message['outgoing'] or message['deleted'] or message['network'] not in MATRIX_NETWORKS or message['msgtype'] != 'm.text':
            fail('not_editable', 'Only your own text messages can be edited', 409)
        self.mx(self.room(message['address']) + '/send/m.room.message/' + secrets.token_hex(12), 'PUT',
                {'msgtype': 'm.text', 'body': '* ' + new, 'm.new_content': {'msgtype': 'm.text', 'body': new},
                 'm.relates_to': {'rel_type': 'm.replace', 'event_id': message_id}})
        self.store.bump(message_id, ',original=?,translated=NULL,edited=1', (new,))
        return {'message': self.row(message_id)}

    def delete(self, message_id, payload):
        message = self.store.message(message_id)
        everyone = payload.get('everyone') is True
        if everyone:
            if not message['outgoing'] or message['network'] not in MATRIX_NETWORKS:
                fail('not_deletable', 'Only your own messages can be deleted for everyone', 409)
            self.mx(self.room(message['address']) + '/redact/' + quote(message_id, safe='') + '/' + secrets.token_hex(8), 'PUT', {})
        self.store.redact(message_id)
        return {'message': self.row(message_id)}

    def read(self, person_id, payload):
        person = self.store.person(person_id)
        stamp = payload.get('timestamp')
        if not isinstance(stamp, int) or stamp < 0:
            fail('invalid_input', 'Missing read position')
        for identity in person['identities']:
            with self.store.db() as db:
                row = db.execute('SELECT id,timestamp FROM message WHERE identity_id=? AND outgoing=0 AND timestamp<=? ORDER BY timestamp DESC LIMIT 1',
                                 (identity['id'], stamp)).fetchone()
            if not row or row[1] <= identity['last_read_ts']:
                continue
            self.store.touch_identity(identity['id'], last_read_ts=row[1])
            if identity['network'] in MATRIX_NETWORKS:
                event_id = row[0]
    
                def receipt(address=identity['address'], event_id=event_id):
                    try:
                        self.mx(self.room(address) + '/receipt/m.read/' + quote(event_id, safe=''), 'POST', {})
                    except EngineError:
                        pass
                threading.Thread(target=receipt, daemon=True).start()
        return {'ok': True}

    def set_typing(self, person_id, payload):
        _, identity = self.channel(person_id)
        if identity['network'] in MATRIX_NETWORKS:
            on = payload.get('typing') is True
            self.mx(self.room(identity['address']) + '/typing/' + quote(self.owner, safe=''), 'PUT', {'typing': on, 'timeout': 6000} if on else {'typing': False})
        return {'ok': True}
