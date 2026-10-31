"""Owner-only bridge adapter, extending the live shared inbox algorithms.

Extra networks (Slack, LINE, Instagram) reuse the shared send/upload/react paths;
this class adds provider classification, DM naming from the other participant,
own-name learning and silent first-discovery history import.
"""
from unified import *
from connectors import Connectors, MATRIX_NETWORKS, PROVIDERS, room_network, own_ghost
from unified import weak_label, MXC

# Cached room_meta written before this version may have dropped a bridged room
# (protocol.id aliases): re-read room state once for those.
META_VERSION = 3  # 3: member and room pictures
# Bridged history (bridgev2 backfill on stock Synapse) arrives through /sync with
# its original timestamps; only recent lines may notify.
LIVE_WINDOW_MS = 15 * 60 * 1000
# WhatsApp fetches a contact's profile photo once, when the bridge first meets them. If that one request
# fails the bridge stores the photo as unknown and does not ask again until something else resyncs that
# contact, so the chat keeps its initials although WhatsApp has a photo (Parinda, 31 Oct 2026). The
# bridge's own `sync contacts` command retries exactly the unknown photos. Messenger asks for it while a
# chat on that network still has no picture: soon after a new one shows up, then backing off, because most
# missing pictures belong to people who hide theirs (the bridge remembers those and does not refetch).
PICTURE_RETRY_COMMANDS = {'whatsapp': 'sync contacts'}
PICTURE_RETRY_FIRST, PICTURE_RETRY_MIN, PICTURE_RETRY_MAX = 600, 6 * 3600, 7 * 86400
HISTORY_PAGES, HISTORY_PAGE = 5, 100


class ConnectorInbox(UnifiedInbox):
    def __init__(self, data, engine, sender=None):
        self._picture_skip = set()
        self.management_rooms = {}
        super().__init__(data, engine)
        self.importing = set()
        self.import_slots = threading.Semaphore(2)
        self.history_sync = False  # tests: import inline
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
            if self.sender is not None and hasattr(self.sender, 'bootstrap'):
                return self.sender.bootstrap(self)
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
        if parts[:4] == ['api', 'unified', 'connectors', 'browser']:
            # Owner-only live sign-in in the Wizard Browser (no agent capability maps here).
            if getattr(self, 'browser_signin', None) is None:
                from browser_signin import BrowserSignIn
                self.browser_signin = BrowserSignIn(self.connectors)
            return self.browser_signin.dispatch(method, parts[4:], payload, query or {})
        if parts[:3] == ['api', 'unified', 'connectors']:
            return self.connectors.dispatch(method, parts[3:], payload)
        if parts[:3] == ['api', 'unified', 'telegram']:
            result = self.connectors.dispatch(method, ['telegram'] + parts[3:], payload)
            if method == 'GET' and parts[3:] == ['status']:
                pending = self.connectors.telegram_resume
                result['pending_login'] = pending[1] if pending and pending[0] > time.monotonic() else None
            return result
        return super().dispatch(method, path, payload, query, raw)

    def telegram_status(self):
        # General status is available to a machine key: never include pending QR
        # provisioning data, even when the owner is currently linking a device.
        status = self.connectors.status('telegram')
        # Keep Telegram profile fields used by live My QR codes suggestions.
        if status['state'] not in ('not_configured', 'unavailable'):
            try:
                status['logins'] = self.connectors.request('telegram', '/whoami').get('logins') or []
            except EngineError:
                pass
        return status

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
        fresh = meta is not None and 'network' in meta and (meta['network'] or meta.get('v', 0) >= META_VERSION) and (not meta['network'] or meta.get('v', 0) >= META_VERSION)
        if fresh and not any(e.get('type') in self.META_TYPES for e in events):
            self.rooms[room] = meta
            return meta
        state = self.mx(self.room(room) + '/state')
        info = next((e['content'] for e in state if e['type'] in ('m.bridge', 'uk.half-shot.bridge')), None)
        network = room_network(state)
        meta = {'network': network, 'telegram': network == 'telegram', 'v': META_VERSION}
        if meta['network']:
            channel = info.get('channel', {})
            bot = '@' + network + 'bot:messenger.internal'
            joined = [e for e in state if e['type'] == 'm.room.member' and e.get('content', {}).get('membership') == 'join']
            # The owner's own ghost (no double puppeting yet) is not another participant.
            members = [e for e in joined if e.get('state_key') not in (self.owner, bot) and not self.is_me(e.get('state_key'))]
            # bridgev2 emits room_type in bridge info; fallback counts real participants.
            room_type = info.get('com.beeper.room_type.v2') or channel.get('fi.mau.' + network + '.type') or info.get('com.beeper.room_type')
            meta['space'] = any(e['type'] == 'm.room.create' and e.get('content', {}).get('type') == 'm.space' for e in state) or room_type in ('space', 'personal_filtering_space')
            meta['kind'] = 'person' if room_type in ('dm', 'private') or (room_type is None and len(members) == 1) else 'group'
            meta['names'] = {e.get('state_key'): (e.get('content') or {}).get('displayname') for e in state if e['type'] == 'm.room.member' and (e.get('content') or {}).get('displayname')}
            # Profile pictures the bridges already copy in (mxc URIs stay on the box; the view gets them through a proxy).
            meta['avatars'] = {e.get('state_key'): (e.get('content') or {}).get('avatar_url') for e in joined if MXC.fullmatch((e.get('content') or {}).get('avatar_url') or '')}
            room_pic = next(((e.get('content') or {}).get('url') for e in state if e['type'] == 'm.room.avatar'), None)
            if not (isinstance(room_pic, str) and MXC.fullmatch(room_pic)):
                room_pic = None
            if meta['kind'] == 'person' and not room_pic and len(members) == 1:
                room_pic = meta['avatars'].get(members[0].get('state_key'))
            meta['avatar'] = room_pic
            label = next((e['content'].get('name') for e in state if e['type'] == 'm.room.name'), None) or channel.get('displayname')
            own = self.store.own_names()
            if meta['kind'] == 'person' and weak_label(label, own):
                # A DM is titled by the other participant, never the owner or a raw number.
                peers = {(e.get('content') or {}).get('displayname') for e in members} - {None}
                peers = [n for n in peers if not weak_label(n, own)]
                if len(peers) == 1:
                    label = peers[0]
            if not label or (meta['kind'] == 'person' and label in own):
                label = PROVIDERS[network].label + ' conversation'
            meta['label'] = label
        old = self.rooms.get(room)
        if old is None:
            with self.store.db() as db:
                row = db.execute('SELECT json FROM room_meta WHERE room=?', (room,)).fetchone()
            old = json.loads(row[0]) if row else None
        with self.store.db() as db:
            db.execute('INSERT OR REPLACE INTO room_meta VALUES (?,?)', (room, json.dumps(meta, ensure_ascii=False)))
            # A picture that arrives (or changes) later must reach an Inbox that is already open: bump the
            # chat so the list long-poll repaints it with the new picture tag, even with no new message.
            touched = old is not None and (old.get('avatar'), old.get('avatars')) != (meta.get('avatar'), meta.get('avatars')) and \
                db.execute('UPDATE identity SET seq=? WHERE address=?', (self.store.next_seq(), room)).rowcount
        self.rooms[room] = meta
        if touched:
            self.store.changed()
        return meta

    def ingest(self, identity, meta, event, *, live=False):
        # Backfilled history keeps its original timestamp: it never notifies.
        stamp = event.get('origin_server_ts', 0)
        live = live and stamp >= time.time() * 1000 - LIVE_WINDOW_MS
        super().ingest(identity, meta, event, live=live)
        if event.get('type') in ('m.room.message', 'm.sticker') and not self.is_me(event.get('sender', '')):
            self.store.mark_history_read(identity['id'], stamp)

    def own_profiles(self):
        """The owner's own login on every connected bridge (provisioning /whoami, read-only)."""
        out = []
        for network in sorted(MATRIX_NETWORKS):
            try:
                self.connectors.config(network)
                logins = self.connectors.request(network, '/whoami').get('logins') or []
            except Exception:
                continue
            out += [(network, l) for l in logins if isinstance(l, dict)]
        return out

    def learn_me(self):
        """Own ghosts and names from every connected bridge's provisioning /whoami (read-only).

        Bridges double-puppet the owner when they can; anything sent from the
        owner's phone before that (or when it fails) arrives from their own
        ghost @<network>_<escaped login id>. Those lines are the owner's."""
        if time.time() - self.mine_checked < 300:
            return
        self.mine_checked = time.time()
        found = set()
        for network in sorted(MATRIX_NETWORKS):
            try:
                self.connectors.config(network)
                whoami = self.connectors.request(network, '/whoami')
                logins = whoami.get('logins') or []
            except EngineError:
                continue
            except Exception:
                continue
            if isinstance(whoami.get('management_room'), str) and whoami['management_room'].startswith('!'):
                self.management_rooms[network] = whoami['management_room']
            names = set()
            for login in logins:
                if not isinstance(login, dict):
                    continue
                ghost = own_ghost(network, login.get('id'))
                if ghost:
                    found.add(ghost)
                profile = login.get('profile') if isinstance(login.get('profile'), dict) else {}
                names.update(v for v in (login.get('name'), profile.get('name'), profile.get('username')) if isinstance(v, str))
            self.store.remember_own_names(network, names)
        if found - self.mine:
            self.mine |= found
            self.store.put('own_ghosts', json.dumps(sorted(self.mine)))
        for ghost in sorted(self.mine):
            if not self.store.get('own_fixed:' + ghost):
                self.store.claim_own(ghost)
                self.store.put('own_fixed:' + ghost, '1')
        self.retry_pictures()

    def rooms_without_picture(self, network):
        """Inbox chats on a network whose bridge has not given us a picture (spaces and hidden rooms excluded)."""
        out = []
        with self.store.db() as db:
            rows = db.execute('SELECT r.room,r.json FROM room_meta r JOIN identity i ON i.address=r.room WHERE i.network=?', (network,)).fetchall()
        for room, raw in rows:
            try:
                meta = json.loads(raw)
            except ValueError:
                continue
            if meta.get('network') == network and not meta.get('space') and not meta.get('avatar'):
                out.append(room)
        return sorted(set(out))

    def retry_pictures(self, now=None):
        """Ask a bridge to refetch the profile photos it failed to get (see PICTURE_RETRY_COMMANDS)."""
        now = time.time() if now is None else now
        for network, command in PICTURE_RETRY_COMMANDS.items():
            room = self.management_rooms.get(network)
            if not room or self.sender is None:
                continue
            key = 'picture_retry:' + network
            try:
                state = json.loads(self.store.get(key) or '{}')
            except ValueError:
                state = {}
            missing = self.rooms_without_picture(network)
            if not missing:
                if state:
                    self.store.put(key, '')
                continue
            new = bool(set(missing) - set(state.get('rooms') or []))
            wait = PICTURE_RETRY_FIRST if new else state.get('wait', PICTURE_RETRY_MIN)
            if now - state.get('at', 0) < wait:
                continue
            try:
                self.mx(self.room(room) + '/send/m.room.message/wizard-pictures-' + str(int(now * 1000)), 'PUT',
                        {'msgtype': 'm.text', 'body': command})
            except Exception as error:  # the next pass tries again
                print('picture retry %s: failed %s' % (network, type(error).__name__), flush=True)
                continue
            self.store.put(key, json.dumps({'at': now, 'rooms': missing,
                                            'wait': PICTURE_RETRY_MIN if new else min(wait * 2, PICTURE_RETRY_MAX)}))
            print('picture retry %s: %d chats without a picture' % (network, len(missing)), flush=True)

    def matrix_upload(self, data, filename, mime):
        if self.sender is None:
            fail('sender_required', 'An authorized owner sender is required for uploads', 403)
        return self.sender(network='matrix', base=self.matrix,
                           path='/_matrix/media/v3/upload?' + urlencode({'filename': filename}),
                           method='POST', body=data, token=self.matrix_token(),
                           content_type=mime, timeout=60)

    def refresh_pictures(self, batch=25):
        """Re-read older rooms' state a few at a time on each sync pass, so every chat gets its picture."""
        marker = 'meta_pictures_v%d' % META_VERSION
        if self.store.get(marker):
            return
        try:
            with self.store.db() as db:
                rooms = [r[0] for r in db.execute(
                    "SELECT i.address FROM identity i LEFT JOIN room_meta m ON m.room=i.address "
                    "WHERE i.network NOT IN ('messenger','private') AND (m.json IS NULL OR m.json NOT LIKE '%\"avatars\"%') "
                    "AND i.address NOT IN (SELECT value FROM json_each(?)) LIMIT ?", (json.dumps(sorted(self._picture_skip)), batch))]
        except Exception:
            return
        if not rooms:
            self.store.put(marker, '1')
            return
        for room in rooms:
            self.rooms.pop(room, None)
            try:
                self.room_meta(room, {})  # META_VERSION bump makes it re-read state; the old row stays if that fails
            except Exception:
                pass
            with self.store.db() as db:
                if not db.execute("SELECT 1 FROM room_meta WHERE room=? AND json LIKE '%\"avatars\"%'", (room,)).fetchone():
                    self._picture_skip.add(room)
        self.store.changed()

    def rescan_dropped(self):
        """Once per META_VERSION: rooms an older release cached as non-bridged (LINE,
        Instagram) only reappear in an incremental /sync when they get new activity.
        Re-read every joined room's state once and import those chats now."""
        marker = 'meta_rescan_v%d' % META_VERSION
        if self.store.get(marker):
            return
        try:
            rooms = self.mx('/joined_rooms').get('joined_rooms') or []
            with self.store.db() as db:
                known = {r[0] for r in db.execute('SELECT address FROM identity')}
            for room in rooms:
                if not isinstance(room, str) or room in known:
                    continue
                meta = self.room_meta(room, {})
                if not meta.get('network') or meta.get('space'):
                    continue
                identity = self.store.identity(meta['network'], room, meta['label'], meta['kind'])
                self.import_history(identity, meta)
        except Exception:
            return  # retried after the next sync; never blocks live delivery
        self.store.put(marker, '1')

    def import_history(self, identity, meta):
        """First sight of a bridged room (e.g. one dropped by older metadata rules):
        import what the homeserver already holds, silently (live=False)."""
        room = identity['address']
        key = 'history_imported:' + room
        if self.store.get(key) or room in self.importing:
            return
        self.importing.add(room)

        def run():
            try:
                with self.import_slots:
                    self._import_pages(identity, meta, room)
                self.store.put(key, '1')
            except Exception:
                pass
            finally:
                self.importing.discard(room)
        if self.history_sync:
            run()
        else:
            threading.Thread(target=run, name='history-import', daemon=True).start()

    def _import_pages(self, identity, meta, room):
                token = None
                for _ in range(HISTORY_PAGES):
                    query = {'dir': 'b', 'limit': HISTORY_PAGE}
                    if token:
                        query['from'] = token
                    page = self.mx(self.room(room) + '/messages?' + urlencode(query))
                    for event in reversed(page.get('chunk', [])):
                        if event.get('type') in ('m.room.message', 'm.sticker', 'm.reaction', 'm.room.redaction'):
                            self.ingest(identity, meta, event, live=False)
                    token = page.get('end')
                    if not token or not page.get('chunk'):
                        break

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
                    # ingest() also refuses to notify for backfilled (old-timestamp) lines.
                    self.ingest(identity, meta, event, live=bool(since))
                self.import_history(identity, meta)
                self.ephemeral(identity, data.get('ephemeral', {}).get('events', []))
            self.store.put('sync_token', result['next_batch'])
            self.store.put('sync_error', '')
            self.rescan_dropped()
            self.refresh_pictures()
            return {'state': 'ready'}
        except EngineError as error:
            self.store.put('sync_error', error.message)
            return {'state': 'unavailable', 'error': error.message}
        finally:
            self.sync_lock.release()
