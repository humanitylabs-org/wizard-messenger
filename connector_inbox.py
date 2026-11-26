"""Owner-only bridge adapter, extending the live shared inbox algorithms.

Extra networks (Slack, LINE, Instagram) reuse the shared send/upload/react paths;
this class adds provider classification, DM naming from the other participant,
own-name learning and silent first-discovery history import.
"""
from unified import *
from connectors import Connectors, MATRIX_NETWORKS, PROVIDERS, room_network, own_ghost
from unified import dm_label, dm_more, label_kind, label_rank, topic_number, MXC

# Cached room_meta written before this version may have dropped a bridged room
# (protocol.id aliases): re-read room state once for those.
META_VERSION = 4  # 4: exact joined-member IDs for identity-safe mention autocomplete
# Bridged history (bridgev2 backfill on stock Synapse) arrives through /sync with
# its original timestamps; only recent lines may notify.
LIVE_WINDOW_MS = 15 * 60 * 1000
# Issue 401: one-to-one chats still on a stand-in title are re-read this often (only those, at most a batch a pass).
DM_REPAIR_EVERY = 15 * 60
DM_REPAIR_BATCH = 40
# A one-to-one chat titled with a number is rechecked at most this often (the bridge may learn a name later).
DM_NUMBER_EVERY = 60 * 60
# Bridges that look a contact up by its own id from their local store (GET resolve_identifier/<id>): the ghost's
# localpart without the network prefix. Signal ghosts are @signal_<ACI uuid> (MakeUserID = aci.String()).
RESOLVE_BY_ID = {'signal': re.compile(r'@signal_([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}):messenger\.internal')}


def dm_sources(state, room_name, channel, members, other, own):
    """Which title sources a one-to-one chat has and what kind each is (issue 401's naming report). Only kinds
    (absent, empty, number, raw, standin, own, name) are kept, never a name or a number."""
    topic = next(((e.get('content') or {}).get('topic') for e in state if e.get('type') == 'm.room.topic'), None)
    names = next(((e.get('content') or {}).get('name') for e in state if e.get('type') == 'm.room.name'), None)
    return {'room_name': label_kind(names, own), 'channel': label_kind(channel.get('displayname'), own),
            'peers': [label_kind((e.get('content') or {}).get('displayname'), own) for e in members],
            'others': ['%s:%s' % ((e.get('content') or {}).get('membership') or '?', label_kind((e.get('content') or {}).get('displayname'), own))
                       for e in state if e.get('type') == 'm.room.member' and other(e.get('state_key'))
                       and (e.get('content') or {}).get('membership') != 'join'],
            'topic': 'number' if topic_number(topic) else ('present' if isinstance(topic, str) and topic.strip() else 'absent')}


def contact_label(entry, own):
    """A title from the bridge's own contact entry (provisioning /contacts): its name, else a username, else the
    number (tel:), never a stand-in or the owner's own name."""
    if not isinstance(entry, dict):
        return None
    ids = [i for i in entry.get('identifiers') or [] if isinstance(i, str) and ':' in i]
    found = [entry.get('name')] + [i.split(':', 1)[1] for i in ids if not i.startswith('tel:')] + \
            [i.split(':', 1)[1] for i in ids if i.startswith('tel:')]
    for rank in (2, 1):
        for name in found:
            if label_rank(name, own) == rank:
                return name.strip()
    return None
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

    def provision(self, path, method='GET', body=None, query=None, timeout=15):
        # Preserve the legacy Telegram routes, but all writes use the sender.
        return self.connectors.request('telegram', path, method, body, query=query, timeout=timeout)

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
        prior = meta or {}
        state = self.mx(self.room(room) + '/state')
        info = next((e['content'] for e in state if e['type'] in ('m.bridge', 'uk.half-shot.bridge')), None)
        network = room_network(state)
        meta = {'network': network, 'telegram': network == 'telegram', 'v': META_VERSION}
        if meta['network']:
            channel = info.get('channel', {})
            bot = '@' + network + 'bot:messenger.internal'
            joined = [e for e in state if e['type'] == 'm.room.member' and e.get('content', {}).get('membership') == 'join']
            # The owner's own ghost (no double puppeting yet) is not another participant.
            other = lambda user: user not in (self.owner, bot) and not self.is_me(user)
            members = [e for e in joined if other(e.get('state_key'))]
            # bridgev2 emits room_type in bridge info; fallback counts real participants.
            room_type = info.get('com.beeper.room_type.v2') or channel.get('fi.mau.' + network + '.type') or info.get('com.beeper.room_type')
            meta['space'] = any(e['type'] == 'm.room.create' and e.get('content', {}).get('type') == 'm.space' for e in state) or room_type in ('space', 'personal_filtering_space')
            meta['kind'] = 'person' if room_type in ('dm', 'private') or (room_type is None and len(members) == 1) else 'group'
            meta['room_type'] = room_type if isinstance(room_type, str) else None
            meta['joined'] = [e.get('state_key') for e in joined]
            meta['names'] = {e.get('state_key'): (e.get('content') or {}).get('displayname') for e in state if e['type'] == 'm.room.member' and (e.get('content') or {}).get('displayname')}
            if network == 'whatsapp' and isinstance(channel.get('id'), str):
                meta['channel_id'] = channel['id']  # the portal jid: tells the Status Broadcast chat apart
            # Profile pictures the bridges already copy in (mxc URIs stay on the box; the view gets them through a proxy).
            meta['avatars'] = {e.get('state_key'): (e.get('content') or {}).get('avatar_url') for e in joined if MXC.fullmatch((e.get('content') or {}).get('avatar_url') or '')}
            room_pic = next(((e.get('content') or {}).get('url') for e in state if e['type'] == 'm.room.avatar'), None)
            if not (isinstance(room_pic, str) and MXC.fullmatch(room_pic)):
                room_pic = None
            if meta['kind'] == 'person' and not room_pic and len(members) == 1:
                room_pic = meta['avatars'].get(members[0].get('state_key'))
            meta['avatar'] = room_pic
            label = next((e['content'].get('name') for e in state if e['type'] == 'm.room.name'), None) or channel.get('displayname')
            # A DM is titled by the other participant (name, else number), never the owner (issue 401: one rule).
            own = self.store.own_names()
            peer = self.peer_name(network, members) if meta['kind'] == 'person' else None
            if meta['kind'] == 'person' and not peer and prior.get('kind') == 'person' and isinstance(prior.get('peer_name'), str):
                peer = prior['peer_name']  # named by the bridge's contact entry or lookup earlier (see better_name)
            if peer:
                meta['peer_name'] = peer
                own = own - {peer}
            meta['label'] = dm_label(meta['kind'], label, [(e.get('content') or {}).get('displayname') for e in members],
                                     own, PROVIDERS[network].label + ' conversation', dm_more(state, other))
            if meta['kind'] == 'person':
                meta['sources'] = dm_sources(state, label, channel, members, other, own)
        old = self.rooms.get(room)
        if old is None:
            with self.store.db() as db:
                row = db.execute('SELECT json FROM room_meta WHERE room=?', (room,)).fetchone()
            old = json.loads(row[0]) if row else None
        with self.store.db() as db:
            db.execute('INSERT OR REPLACE INTO room_meta VALUES (?,?)', (room, json.dumps(meta, ensure_ascii=False)))
            # A picture that arrives (or changes) later must reach an Inbox that is already open: bump the
            # chat so the list long-poll repaints it with the new picture tag, even with no new message.
            touched = old is not None and any(old.get(k) != meta.get(k) for k in ('avatar', 'avatars', 'names', 'joined')) and \
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
        """Backfill versioned room metadata in bounded sync batches, including quiet groups.

        The old picture-only marker may already be set on v3 rooms with avatars;
        use a distinct marker so those rooms also acquire exact joined-member IDs.
        """
        marker = 'meta_members_v%d' % META_VERSION
        if self.store.get(marker):
            return
        try:
            with self.store.db() as db:
                rooms = [r[0] for r in db.execute(
                    "SELECT i.address FROM identity i LEFT JOIN room_meta m ON m.room=i.address "
                    "WHERE i.network NOT IN ('messenger','private') AND (m.json IS NULL OR m.json NOT LIKE '%\"avatars\"%' "
                    "OR COALESCE(json_extract(m.json,'$.v'),0) < ?) "
                    "AND i.address NOT IN (SELECT value FROM json_each(?)) LIMIT ?", (META_VERSION, json.dumps(sorted(self._picture_skip)), batch))]
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
                if not db.execute("SELECT 1 FROM room_meta WHERE room=? AND json LIKE '%\"avatars\"%' "
                                  "AND COALESCE(json_extract(json,'$.v'),0)>=?", (room, META_VERSION)).fetchone():
                    self._picture_skip.add(room)
        self.store.changed()

    def refresh_status_rooms(self):
        """Once: re-read the bridge info of WhatsApp chats titled like the Status Broadcast chat whose cached meta
        predates the portal id, so that chat is recognised by id (status@broadcast) rather than by its title."""
        marker = 'meta_status_channel_v1'
        if self.store.get(marker):
            return
        try:
            with self.store.db() as db:
                rooms = [r[0] for r in db.execute(
                    "SELECT i.address FROM identity i LEFT JOIN room_meta m ON m.room=i.address "
                    "WHERE i.network='whatsapp' AND i.label=? AND (m.json IS NULL OR m.json NOT LIKE '%\"channel_id\"%')", (STATUS_TITLE,))]
            for room in rooms:
                with self.store.db() as db:
                    row = db.execute('SELECT json FROM room_meta WHERE room=?', (room,)).fetchone()
                # An outdated cached copy makes room_meta re-read state; the stored row stays if that fails.
                self.rooms[room] = dict(json.loads(row[0]) if row else {}, v=0)
                try:
                    self.room_meta(room, {})
                except Exception:
                    self.rooms.pop(room, None)
                    raise
        except Exception:
            return  # retried after the next sync; the title still identifies the chat meanwhile
        self.store.put(marker, '1')
        self.store.changed()

    def refresh_dm_labels(self):
        """Issue 401: one-to-one chats still titled with a stand-in ('Signal conversation', 'Unknown user', a raw id)
        or with a number. After every start, then every DM_REPAIR_EVERY seconds, re-read those chats and retitle them
        from the room (name, peer, invited peer, topic number), the bridge's own contact entry or, on Signal, the
        bridge's lookup of the contact in its own store (which also renames the contact on the bridge), without waiting
        for a new message. A number never replaces a name. A chat titled with a number is rechecked at most every
        DM_NUMBER_EVERY seconds. A DM an older sync filed as a group becomes a one-to-one chat once the bridge says
        dm, and a list title left on a stand-in or a number takes its chat's name. Each chat that is still on a
        stand-in or a number gets one log line saying which sources exist and what kind each is: never a name or a
        number."""
        now = time.time()
        if now - getattr(self, 'dm_labels_checked', 0) < DM_REPAIR_EVERY:
            return
        self.dm_labels_checked = now
        tried = self.__dict__.setdefault('dm_number_tried', {})
        try:
            self.store.repair_person_titles()
            own = self.store.own_names()
            with self.store.db() as db:
                rows = [dict(r) for r in db.execute(
                    "SELECT i.id,i.network,i.address,i.label,i.kind,r.json AS meta FROM identity i "
                    "LEFT JOIN room_meta r ON r.room=i.address WHERE i.network NOT IN ('messenger','private')")]
            stuck = []
            for row in rows:
                if row['network'] not in MATRIX_NETWORKS:
                    continue
                try:
                    cached = json.loads(row['meta']) if row['meta'] else {}
                except ValueError:
                    cached = {}
                if cached.get('space'):
                    continue
                rank = label_rank(row['label'], own - {cached.get('peer_name')})
                if row['kind'] == 'person' and rank == 0:
                    stuck.append((0, row, cached))
                elif row['kind'] == 'person' and rank == 1 and now - tried.get(row['address'], 0) >= DM_NUMBER_EVERY:
                    stuck.append((1, row, cached))  # a number: the bridge may know a name by now
                elif row['kind'] == 'group' and ('room_type' not in cached or cached.get('room_type') in ('dm', 'private')):
                    stuck.append((2, row, cached))  # maybe a DM an older sync filed as a group; a real group is read once
            stuck.sort(key=lambda item: (item[0], tried.get(item[1]['address'], 0)))  # stand-ins first, then numbers
            contacts = {}
            for _, row, cached in stuck[:DM_REPAIR_BATCH]:
                room = row['address']
                if row['kind'] == 'person' and label_rank(row['label'], own - {cached.get('peer_name')}) == 1:
                    tried[room] = now
                self.rooms[room] = dict(cached, v=0)  # an outdated copy re-reads state
                try:
                    meta = self.room_meta(room, {})
                except Exception:
                    self.rooms.pop(room, None)
                    continue
                if meta.get('network') != row['network'] or meta.get('space'):
                    continue
                kind, label = meta.get('kind'), meta.get('label')
                if row['kind'] == 'group' and kind == 'person' and meta.get('room_type') in ('dm', 'private'):
                    self.store.set_identity_kind(row['id'], 'person')
                elif row['kind'] == 'group':
                    continue  # a real group keeps today's behaviour
                entry = looked = None
                here = own - {meta.get('peer_name')}
                if label_rank(label, here) < 2:
                    entry = self.bridge_contact(row['network'], room, meta, contacts)
                    label, here = self.better_name(row['network'], room, meta, label, here, own, entry)
                if label_rank(label, here) < 2 and row['network'] in RESOLVE_BY_ID:
                    looked = self.bridge_lookup(row['network'], meta)
                    label, here = self.better_name(row['network'], room, meta, label, here, own, looked, asked=True)
                self.store.identity(row['network'], room, label, 'person')
                if label_rank(label, here) < 2:
                    self.report_dm_label(row['network'], room, meta, entry, contacts.get(row['network']),
                                         'stuck' if label_rank(label, here) == 0 else 'number', looked, here)
            if stuck:
                self.store.repair_person_titles()
                self.store.changed()
        except Exception as error:
            print('messenger: dm-label repair failed: %s' % type(error).__name__, flush=True)

    def better_name(self, network, room, meta, label, here, own, answer, asked=False):
        """A title from the bridge's contact entry or lookup when it ranks above `label` (issue 401). The answer is
        about a different, known account when the owner's own ghost on this network is known and the answer's
        ghost is not it (a lookup is only ever asked about the chat's one other member): its name is that person's
        even when it is spelled like one of the owner's names (round 4), and is then kept as this chat's contact
        name. Returns (label, the owner's names that still count as 'me' in this chat)."""
        if not isinstance(answer, dict):
            return label, here
        mxid = answer.get('mxid')
        other = self.knows_own(network) and (isinstance(mxid, str) and mxid.startswith('@%s_' % network) and not self.is_me(mxid)
                                             or asked and not mxid)
        found = contact_label(answer, set() if other else here)
        if label_rank(found, set() if other else here) <= label_rank(label, here):
            return label, here
        if other and found in here:
            meta['peer_name'] = found
            self.rooms[room] = meta
            with self.store.db() as db:
                db.execute('UPDATE room_meta SET json=? WHERE room=?', (json.dumps(meta, ensure_ascii=False), room))
            here = own - {found}
        return found, here

    def knows_own(self, network):
        """True once the box knows the owner's own account (ghost) on this network, so that any other member is
        somebody else."""
        prefix = '@%s_' % network
        return any(isinstance(g, str) and g.startswith(prefix) for g in self.mine)

    def peer_name(self, network, members):
        """Issue 401, round 4: the name of a one-to-one chat's one other joined member when that member is a known,
        different account (the owner's own ghost on this network is known and it is not that). Such a name is the
        other person's even when it is spelled like one of the owner's names (a namesake, the owner's second
        account, a contact saved under the same name), so the owner-name rule must not throw it away."""
        if len(members) != 1 or not self.knows_own(network):
            return None
        user = members[0].get('state_key')
        name = (members[0].get('content') or {}).get('displayname')
        if not isinstance(user, str) or not user.startswith('@%s_' % network) or self.is_me(user):
            return None
        return name.strip() if label_rank(name, ()) == 2 else None

    def bridge_peers(self, network, meta):
        people = set(meta.get('joined') or []) | set(meta.get('names') or {})
        bot = '@' + network + 'bot:messenger.internal'
        return {p for p in people if isinstance(p, str) and p not in (self.owner, bot) and not self.is_me(p)}

    def bridge_contact(self, network, room, meta, contacts):
        """The bridge's own contact entry for a one-to-one chat (provisioning GET /contacts, read-only, once a pass)."""
        if network not in contacts:
            try:
                listed = self.connectors.request(network, '/contacts', timeout=20).get('contacts')
                contacts[network] = [c for c in listed if isinstance(c, dict)] if isinstance(listed, list) else []
            except Exception:
                contacts[network] = None
        people = self.bridge_peers(network, meta)
        for entry in contacts[network] or []:
            if entry.get('dm_room_mxid') == room:
                return entry
        found = [e for e in contacts[network] or [] if e.get('mxid') in people]
        return found[0] if len(found) == 1 else None

    def bridge_lookup(self, network, meta):
        """Issue 401: ask the bridge to look the chat's one peer up by its own id (GET resolve_identifier/<id>). On
        Signal that reads the bridge's local contact store only (no lookup on Signal's servers), names the contact
        with the bridge's name template (nickname, phone-book name, profile name, number) and renames the contact on
        the bridge too. Returns the answer, 'none' when the chat has no single peer, or 'unavailable'."""
        ids = [m.group(1) for m in map(RESOLVE_BY_ID[network].fullmatch, sorted(self.bridge_peers(network, meta))) if m]
        if len(ids) != 1:
            return 'none'
        try:
            found = self.connectors.request(network, '/resolve_identifier/' + quote(ids[0], safe=''), timeout=20)
        except Exception:
            return 'unavailable'
        return found if isinstance(found, dict) else 'unavailable'

    def report_dm_label(self, network, room, meta, entry, listed, state='stuck', looked=None, own=()):
        """One privacy-safe log line per chat still on a stand-in title or a number (issue 401), repeated only when it
        changes."""
        sources = meta.get('sources') or {}
        # Kinds with the owner-name check, like every other source on the line ('own' = spelled like an owner name).
        contact = 'unavailable' if listed is None else ('none' if entry is None else
                                                        label_kind(contact_label(entry, ()) or entry.get('name'), own))
        lookup = looked if isinstance(looked, str) or looked is None else label_kind(looked.get('name'), own)
        line = ('network=%s room=%s room_type=%s room_name=%s channel=%s peers=[%s] others=[%s] topic=%s contact=%s'
                % (network, hashlib.sha256(room.encode()).hexdigest()[:8], meta.get('room_type') or 'none',
                   sources.get('room_name', '?'), sources.get('channel', '?'), ','.join(sources.get('peers') or []),
                   ','.join(sources.get('others') or []), sources.get('topic', '?'), contact))
        if network in RESOLVE_BY_ID:
            line += ' lookup=%s' % (lookup or 'skipped')
        reported = self.__dict__.setdefault('dm_label_reports', {})
        if reported.get(room) != (state, line):
            reported[room] = (state, line)
            print('messenger: dm-label %s %s' % (state, line), flush=True)

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
            self.refresh_status_rooms()
            self.refresh_dm_labels()
            self.repair_rows()
            return {'state': 'ready'}
        except EngineError as error:
            self.store.put('sync_error', error.message)
            return {'state': 'unavailable', 'error': error.message}
        finally:
            self.sync_lock.release()
