"""Pinned MDK v0.12.0 adapter. No cryptography or signing implementation.

All account secrets stay in upstream's OS keychain backend. The headless
Secret Service vault is encrypted by GNOME Keyring and unlocked via stdin.
Messages and imported keys cross only the private wnd Unix socket, never argv.
"""
from __future__ import annotations
import json
from contextlib import contextmanager
import hashlib
import os
from pathlib import Path
import re
import socket
import sqlite3
import subprocess
import threading
import time

MDK_REV = '122bd90ffac60bb6311346e228d0f609a18521ee'
PUBLIC = re.compile(r'(?:[0-9a-f]{64}|npub1[023456789acdefghjklmnpqrstuvwxyz]{58})\Z')
GROUP = re.compile(r'(?:[0-9a-f]{2}){16,64}\Z')

class EngineError(Exception):
    def __init__(self, code, message, status=409):
        super().__init__(message)
        self.code, self.message, self.status = code, message, status

def text(value, field, maximum=160):
    if not isinstance(value, str) or not value.strip() or len(value.encode('utf-8')) > maximum or '\x00' in value:
        raise EngineError('invalid_input', f'Invalid {field}', 400)
    return value

def public_key(value):
    if not isinstance(value, str) or not PUBLIC.fullmatch(value):
        raise EngineError('invalid_public_key', 'Use a lowercase npub or 64-character hex public key', 400)
    return value

def timeline_row(m, me):
    """One materialized Marmot message as the view's row: text, edits, delete tombstone, reactions, reply quote."""
    by=(m.get('reactions') or {}).get('by_emoji') or {}
    reactions=[{'key':k,'count':len(v) if isinstance(v,list) else int(v or 0),'mine':isinstance(v,list) and me in v} for k,v in by.items()]
    reactions=[r for r in reactions if r['count']>0]
    preview=m.get('reply_preview') or None
    reply=None
    if m.get('reply_to_message_id'):
        reply={'message_id':m['reply_to_message_id'],'text':(preview or {}).get('plaintext') or '','deleted':bool((preview or {}).get('deleted')),
               'outgoing':bool(preview) and preview.get('sender')==me,'missing':preview is None}
    return {'message_id':m['message_id'],'group_id':m['group_id'],'author':m['from'],'author_name':m.get('from_display_name',''),
            'text':'' if m.get('deleted') else m.get('plaintext',''),'direction':m['direction'],'created_at':m.get('timeline_at') or m.get('received_at'),
            'edited':bool(m.get('edit')),'deleted':bool(m.get('deleted')),'reactions':reactions,'reply':reply,
            'attachments':[] if m.get('deleted') else timeline_attachments(m)}

HEX64 = re.compile(r'[0-9a-f]{64}\Z')

def timeline_attachments(m):
    """Encrypted-media (MIP-04) references carried as `imeta` tags on a kind-9 message.
    Only the display fields leave the engine; locators, nonces and ciphertext hashes stay inside wnd,
    which resolves them again from the group history when a file is downloaded by its plaintext hash."""
    out=[]
    for tag in ((m.get('media') or {}).get('imeta') or [])[:32]:
        if not isinstance(tag,list): continue
        fields={}
        for f in tag[1:]:
            if isinstance(f,str) and ' ' in f:
                k,v=f.split(' ',1); fields.setdefault(k,v)
        digest=fields.get('plaintext_sha256','')
        if not HEX64.fullmatch(digest): continue
        mime=fields.get('m','').strip().lower()
        if not re.fullmatch(r'[a-z0-9.+-]+/[a-z0-9.+-]+',mime): mime='application/octet-stream'
        item={'sha256':digest,'mime':mime,'filename':fields.get('filename','')[:200]}
        dim=re.fullmatch(r'(\d{1,6})x(\d{1,6})',fields.get('dim',''))
        if dim and all(0<int(x)<10**6 for x in dim.groups()): item['w'],item['h']=int(dim.group(1)),int(dim.group(2))
        out.append(item)
    return out


def group_id(value):
    if not isinstance(value, str) or not GROUP.fullmatch(value):
        raise EngineError('invalid_group_id', 'Invalid group identifier', 400)
    return value

def vault_password(value):
    """The single passphrase rule shared by the vault and the browser verifier."""
    if (not isinstance(value, str) or len(value) < 16 or len(value.encode('utf-8')) > 1024
            or any(c in value for c in '\x00\r\n')):
        raise EngineError('invalid_vault_password', 'Use a passphrase of at least 16 characters, on one line', 400)
    return value

class MarmotEngine:
    def __init__(self, data='/data', relays=None):
        self.data = Path(data)
        self.home = self.data / 'marmot'
        self.runtime = Path(os.environ.get('XDG_RUNTIME_DIR', '/run/messenger'))
        self.socket = self.runtime / 'wnd.sock'
        self.service = 'org.wizardos.messenger.marmot.v1'
        self.relays = relays or os.environ.get('MESSENGER_RELAYS', 'wss://relay.eu.whitenoise.chat,wss://relay.us.whitenoise.chat').split(',')
        self.data.mkdir(parents=True, exist_ok=True, mode=0o700)
        self.runtime.mkdir(parents=True, exist_ok=True, mode=0o700)
        self.home.mkdir(exist_ok=True, mode=0o700)
        self.mutex = threading.RLock()
        self.daemon = None
        self.keyring_process = None
        self.unlocked = False
        self.marker = self.data / 'identity-public.json'
        self.env = os.environ.copy()
        self.env.update(WN_HOME=str(self.home), WN_SOCKET=str(self.socket), WN_SECRET_STORE='keychain', WN_KEYCHAIN_SERVICE=self.service, XDG_DATA_HOME=str(self.data), XDG_RUNTIME_DIR=str(self.runtime), GNOME_KEYRING_CONTROL=str(self.runtime / 'keyring'), RUST_LOG='off')
        # Never inherit a development file-store switch or inject one.
        self.env.pop('WN_DEV_SETTLEMENT_QUIESCENCE_MS', None)
        if os.environ.get('MESSENGER_WND_GUARD', '1') == '1':
            threading.Thread(target=self._guard_memory, name='wnd-memory-guard', daemon=True).start()
        with self._db() as db:
            db.execute('CREATE TABLE IF NOT EXISTS contacts (pubkey TEXT PRIMARY KEY, label TEXT NOT NULL)')
            db.execute('CREATE TABLE IF NOT EXISTS sends (request_id TEXT PRIMARY KEY, group_id TEXT NOT NULL, body_sha256 TEXT NOT NULL, state TEXT NOT NULL, result_json TEXT)')

    @contextmanager
    def _db(self):
        connection = sqlite3.connect(self.data / 'contacts.sqlite', timeout=10)
        try:
            with connection:
                yield connection
        finally:
            connection.close()

    def daemon_memory_mb(self):
        daemon = self.daemon
        if daemon is None or daemon.poll() is not None:
            return 0.0
        try:
            with open(f'/proc/{daemon.pid}/status') as status:
                return sum(int(line.split()[1]) for line in status if line.startswith(('VmRSS:', 'VmSwap:'))) / 1024
        except (OSError, ValueError, IndexError):
            return 0.0

    def recycle_if_bloated(self, limit_mb=None):
        """wnd grows a few MB a second even on a tiny account until the container's memory limit swaps everything
        and the kernel kills it, which slows every Messenger request long before that (31 Oct 2026). Restart only
        the daemon, and only between operations: every RPC holds the mutex, so no send is ever cut in half.
        If the relaunch fails the engine reads as locked and keep_unlocked opens it again."""
        limit = limit_mb or float(os.environ.get('MESSENGER_WND_MAX_MB', '600'))
        if self.daemon_memory_mb() < limit:
            return False
        with self.mutex:
            if not self.unlocked or self.daemon_memory_mb() < limit:
                return False
            daemon = self.daemon
            try: self._rpc('Shutdown', timeout=5)
            except EngineError: daemon.terminate()
            try: daemon.wait(timeout=10)
            except subprocess.TimeoutExpired: daemon.kill(); daemon.wait()
            self.daemon = None
            try:
                self._launch()
            except EngineError:
                if self.daemon is not None and self.daemon.poll() is None: self.daemon.kill()
                self.daemon, self.unlocked = None, False
                self._stop_keyring()
            return True

    def _guard_memory(self):
        while True:
            time.sleep(15)
            try: self.recycle_if_bloated()
            except Exception: pass

    def status(self):
        ready = self.unlocked and self.daemon is not None and self.daemon.poll() is None
        state = 'ready' if ready else ('locked' if self.marker.exists() else 'setup_required')
        return {'state': state, 'engine': 'marmot', 'mdk_version': '0.12.0', 'mdk_revision': MDK_REV, 'secret_store': 'keychain', 'vault_provider': 'gnome-secret-service', 'requires_unlock_after_restart': True, 'account_configured': self.marker.exists(), 'capabilities': ['encrypted_text', 'invites', 'dm', 'attachments'], 'unsupported': ['voice_notes', 'notifications', 'group_chats', 'key_export']}

    def _require_ready(self):
        if self.status()['state'] != 'ready':
            raise EngineError('vault_locked', 'Unlock the dedicated messaging vault first', 423)

    def _rpc(self, request, timeout=90):
        # No automatic write retry: a timed-out operation may already have published.
        try:
            with socket.socket(socket.AF_UNIX) as stream:
                stream.settimeout(timeout)
                stream.connect(str(self.socket))
                stream.sendall(json.dumps(request, ensure_ascii=False).encode()+b'\n')
                with stream.makefile('rb') as reader:
                    frame = reader.readline(8*1024*1024+1)
            if not frame.endswith(b'\n') or len(frame) > 8*1024*1024:
                raise EngineError('invalid_engine_response', 'Marmot response exceeded the safe frame limit', 502)
            outer = json.loads(frame)
            if outer['code'] != 0:
                raise EngineError('marmot_operation_failed', 'Marmot could not complete this operation', 502)
            return outer['stdout']
        except (OSError, ValueError, KeyError, TypeError):
            raise EngineError('engine_unavailable', 'Marmot is unavailable; inspect status before retrying a send', 503) from None

    def _execute(self, command, *, account=None, import_nsec=None, timeout=90, failure=None):
        cli = {'home':str(self.home), 'socket':None, 'relay':None, 'secret_store':'Keychain', 'keychain_service':self.service, 'account':account, 'json':True, 'command':command}
        request = {'cli':cli}
        if import_nsec is not None:
            request['import_nsec'] = import_nsec
        data = json.loads(self._rpc({'Execute':request}, timeout))
        if not data.get('ok'):
            error = data.get('error') if isinstance(data.get('error'), dict) else {}
            if failure: failure(str(error.get('code') or ''), str(error.get('message') or ''))
            raise EngineError('marmot_operation_failed', 'Marmot could not complete this operation', 502)
        return data['result']

    def _groups(self, command):
        return self._execute({'Groups':{'command':command}})

    def _launch(self):
        self.socket.unlink(missing_ok=True)
        args = ['wnd','--home',str(self.home),'--socket',str(self.socket),'--secret-store','keychain','--keychain-service',self.service,'--discovery-relays',','.join(self.relays),'--default-account-relays',','.join(self.relays)]
        self.daemon = subprocess.Popen(args, env=self.env, stdin=subprocess.DEVNULL, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
        for _ in range(60):
            if self.daemon.poll() is not None:
                raise EngineError('engine_start_failed', 'Marmot daemon could not start', 503)
            if self.socket.exists():
                try:
                    self._rpc('Status', timeout=2)
                    return
                except EngineError:
                    pass
            time.sleep(.1)
        raise EngineError('engine_start_failed', 'Marmot daemon startup timed out', 503)

    def _stop_keyring(self):
        if self.keyring_process is not None and self.keyring_process.poll() is None:
            self.keyring_process.terminate()
            try: self.keyring_process.wait(timeout=5)
            except subprocess.TimeoutExpired: self.keyring_process.kill(); self.keyring_process.wait()
        self.keyring_process = None

    def _unlock(self, password):
        vault_password(password)
        self._stop_keyring()
        try:
            # Own the provider process. A failed first unlock must not leave a
            # background daemon whose login-unlock state poisons later attempts.
            self.keyring_process = subprocess.Popen(['gnome-keyring-daemon','--foreground','--unlock','--components=secrets','--control-directory',str(self.runtime / 'keyring')],stdin=subprocess.PIPE,stdout=subprocess.DEVNULL,stderr=subprocess.DEVNULL,env=self.env)
            assert self.keyring_process.stdin is not None
            self.keyring_process.stdin.write(password.encode())
            self.keyring_process.stdin.close()
            unlocked = False
            for _ in range(30):
                if self.keyring_process.poll() is not None:
                    raise EngineError('vault_unavailable', 'The encrypted messaging vault provider could not start', 503)
                # Query the bus itself first: do not auto-activate a competing
                # provider while our foreground daemon is still starting.
                owner = subprocess.run(['gdbus','call','--session','--dest','org.freedesktop.DBus','--object-path','/org/freedesktop/DBus','--method','org.freedesktop.DBus.GetNameOwner','org.freedesktop.secrets'],env=self.env,capture_output=True,timeout=3)
                if owner.returncode:
                    time.sleep(.1)
                    continue
                # --unlock can succeed at the process level with a wrong password.
                locked = subprocess.run(['gdbus','call','--session','--dest','org.freedesktop.secrets','--object-path','/org/freedesktop/secrets/collection/login','--method','org.freedesktop.DBus.Properties.Get','org.freedesktop.Secret.Collection','Locked'],env=self.env,capture_output=True,text=True,timeout=3)
                if locked.returncode == 0 and locked.stdout.strip() == '(<false>,)':
                    unlocked = True
                    break
                time.sleep(.1)
            if not unlocked:
                raise EngineError('vault_unlock_failed', 'The messaging vault remains locked', 423)
            self._launch()
            self.unlocked = True
        except EngineError:
            self._abort_start()
            raise
        except (OSError, subprocess.TimeoutExpired):
            self._abort_start()
            raise EngineError('vault_unavailable', 'The encrypted messaging vault is unavailable', 503) from None

    def _abort_start(self):
        """Every failed unlock/start leaves neither provider nor daemon running."""
        self.unlocked = False
        if self.daemon is not None and self.daemon.poll() is None:
            self.daemon.terminate()
            try: self.daemon.wait(timeout=10)
            except subprocess.TimeoutExpired: self.daemon.kill(); self.daemon.wait()
        self.daemon = None
        self._stop_keyring()

    @staticmethod
    def _identity(account):
        profile = account.get('profile') or {}
        return {'account_id':account['account_id'], 'npub':account['npub'], 'display_name':profile.get('display_name') or profile.get('name') or '', 'dedicated_messaging_identity':True}

    def identity(self):
        with self.mutex:
            self._require_ready()
            accounts = self._execute('Whoami')['accounts']
            if not accounts:
                return {'identity':None}
            if len(accounts) != 1:
                raise EngineError('account_invariant_failed', 'This app supports exactly one dedicated messaging identity', 409)
            return {'identity':self._identity(accounts[0])}

    def setup(self, payload):
        return self.setup_with_proof(payload)[0]

    def setup_with_proof(self, payload):
        """Return (result, proved): proved is True only when THIS call's
        passphrase is the one that just unlocked the encrypted provider."""
        with self.mutex:
            action = payload.get('action')
            if action == 'lock':
                self.lock()
                return self.status(), False
            if action not in ['unlock','create','import']:
                raise EngineError('invalid_setup_action', 'Use unlock, create, import or lock', 400)
            name=text(payload['display_name'],'display name') if payload.get('display_name') is not None else None
            proved = False
            if not self.unlocked or self.daemon is None or self.daemon.poll() is not None:
                self._unlock(payload.get('vault_password'))
                proved = True
            accounts = self._execute('Whoami')['accounts']
            if action == 'import' and accounts:
                raise EngineError('identity_exists', 'A dedicated messaging identity already exists', 409)
            if action == 'create':
                if len(accounts)>1:
                    raise EngineError('account_invariant_failed', 'Multiple messaging accounts are not supported', 409)
                if accounts:
                    account=accounts[0]
                    # Repair the existing stable KeyPackage slot, not the key.
                    self._execute({'Keys':{'command':'Publish'}})
                else:
                    account = self._execute('CreateIdentity')
            elif action == 'import':
                secret = payload.get('nsec')
                if not isinstance(secret, str) or not secret.startswith('nsec1') or len(secret) != 63:
                    raise EngineError('invalid_nsec', 'Supply a dedicated messaging nsec; never use your Wizard root key', 400)
                account = self._execute({'Login':{'identity':None,'nsec_stdin':True,'relay':None}},import_nsec=secret)
            else:
                account = accounts[0] if len(accounts) == 1 else None
                if len(accounts) > 1:
                    raise EngineError('account_invariant_failed', 'Multiple messaging accounts are not supported', 409)
            if account is not None:
                identity = self._identity(account)
                temporary = self.marker.with_suffix('.new')
                temporary.write_text(json.dumps(identity))
                temporary.replace(self.marker)
                if name is not None:
                    self._execute({'Profile':{'command':{'Update':{'name':None,'display_name':name,'about':None,'picture':None,'nip05':None,'lud16':None}}}})
                    # Persist only public presentation metadata after upstream
                    # publication; any failure leaves the identity intact.
                    self.marker.write_text(json.dumps(self.identity()['identity']))
            return {**self.status(), **self.identity()}, proved

    def lock(self):
        with self.mutex:
            self.unlocked = False
            if self.daemon is not None and self.daemon.poll() is None:
                try: self._rpc('Shutdown', timeout=5)
                except EngineError: self.daemon.terminate()
                try: self.daemon.wait(timeout=10)
                except subprocess.TimeoutExpired: self.daemon.kill(); self.daemon.wait()
            self.daemon = None
            try:
                subprocess.run(['gdbus','call','--session','--dest','org.freedesktop.secrets','--object-path','/org/freedesktop/secrets','--method','org.freedesktop.Secret.Service.Lock',"['/org/freedesktop/secrets/collection/login']"],env=self.env,capture_output=True,timeout=5)
            except (OSError, subprocess.TimeoutExpired):
                pass
            self._stop_keyring()

    def contacts(self):
        self._require_ready()
        with self._db() as db:
            return {'contacts':[{'pubkey':p,'label':l} for p,l in db.execute('SELECT pubkey,label FROM contacts ORDER BY label COLLATE NOCASE,pubkey')]}

    def save_contact(self, payload):
        with self.mutex:
            self._require_ready()
            key = public_key(payload.get('pubkey'))
            label = text(payload.get('label'), 'contact label')
            with self._db() as db:
                db.execute('INSERT INTO contacts VALUES (?,?) ON CONFLICT(pubkey) DO UPDATE SET label=excluded.label',(key,label))
            return {'contact':{'pubkey':key,'label':label}, 'publication':'local_only'}

    def delete_contact(self, key):
        with self.mutex:
            self._require_ready()
            public_key(key)
            with self._db() as db: db.execute('DELETE FROM contacts WHERE pubkey=?',(key,))
            return {'deleted':True}

    @staticmethod
    def _group(group, members=None):
        return {'group_id':group['group_id'], 'name':group.get('name') or group.get('profile',{}).get('name',''), 'pending_confirmation':group.get('pending_confirmation',False), 'welcomer_account_id':group.get('welcomer_account_id'), 'members':members or []}

    def _dm_members(self, group):
        group_id(group)
        members = self._groups({'Members':{'group_id':group}})['members']
        if len(members) != 2:
            raise EngineError('not_a_dm', 'Only two-member direct messages are supported', 409)
        # Only public identity fields; discard MLS cryptographic metadata.
        result=[{k:v for k,v in member.items() if k in ['account_id','member_id','npub','display_name','profile']} for member in members]
        for member in result:
            if not member.get('display_name'):
                name=self._public_name(member.get('npub') or member.get('member_id') or member.get('account_id'))
                if name: member['display_name']=name
        return result

    def _public_name(self, key):
        """Best-effort public profile name from upstream's local user directory (cached)."""
        if not isinstance(key,str) or not PUBLIC.fullmatch(key): return ''
        cache=getattr(self,'_names',None)
        if cache is None: cache=self._names={}
        hit=cache.get(key)
        if hit and hit[1]>time.monotonic(): return hit[0]
        name=''
        try:
            found=self._execute({'Users':{'command':{'Show':{'pubkey':key}}}})
            stack=[found]
            while stack and not name:
                item=stack.pop()
                if isinstance(item,dict):
                    for field in ['display_name','name']:
                        value=item.get(field)
                        if isinstance(value,str) and value.strip() and len(value.encode())<=160 and '\x00' not in value:
                            name=value.strip(); break
                    stack.extend(v for v in item.values() if isinstance(v,(dict,list)))
                elif isinstance(item,list): stack.extend(item)
        except EngineError: pass
        cache[key]=(name,time.monotonic()+(300 if name else 30))
        return name

    def dms(self):
        with self.mutex:
            self._require_ready()
            result=[]
            for group in self._groups('List')['groups']:
                if any(group.get(k) for k in ['archived','disbanded','unrecoverable','pending_confirmation']): continue
                try: members=self._dm_members(group['group_id'])
                except EngineError as e:
                    if e.code=='not_a_dm': continue
                    raise
                result.append(self._group(group,members))
            return {'dms':result}

    def create_dm(self, payload):
        with self.mutex:
            self._require_ready()
            key=public_key(payload.get('pubkey'))
            own=self.identity()['identity']
            if own is None: raise EngineError('identity_required','Create a dedicated messaging identity first',409)
            if key in [own['account_id'],own['npub']]: raise EngineError('cannot_invite_self','Choose another Marmot identity',400)
            for existing in self.dms()['dms']:
                if any(key in [member.get('member_id'),member.get('npub')] for member in existing['members']):
                    return {'dm':existing, 'invite_sent':False, 'reused':True}
            name=text(payload.get('name','Direct message'),'conversation name')
            group=self._groups({'Create':{'name':name,'members':[key],'description':None,'retention':None,'image':None,'image_media_type':None}})
            # DM creation sends an encrypted welcome. Receiving peer must accept.
            return {'dm':self._group(group,self._dm_members(group['group_id'])), 'invite_sent':True}

    def invites(self):
        with self.mutex:
            self._require_ready()
            result=[]; unsupported=0
            for g in self._groups('Invites')['invites']:
                # A remote group invitation must not hide valid DM invitations.
                try: result.append(self._group(g,self._dm_members(g['group_id'])))
                except EngineError as e:
                    if e.code!='not_a_dm': raise
                    unsupported+=1
            return {'invites':result,'unsupported_invites':unsupported}

    def invite_action(self, group, action):
        with self.mutex:
            self._require_ready()
            group_id(group)
            if action not in ['accept','decline']: raise EngineError('invalid_action','Use accept or decline',400)
            if action == 'accept': self._dm_members(group)
            self._groups({action.title():{'group_id':group}})
            return {'group_id':group,'action':action,'completed':True}

    def messages(self, group, limit=100, before=None, before_message_id=None):
        with self.mutex:
            self._require_ready()
            self._dm_members(group)
            if not isinstance(limit,int) or isinstance(limit,bool) or not 1 <= limit <= 200:
                raise EngineError('invalid_limit','Use a message limit between 1 and 200',400)
            if (before is None) != (before_message_id is None): raise EngineError('invalid_cursor','Supply both before and before_message_id',400)
            if before is not None and (not isinstance(before,int) or before < 0 or not re.fullmatch('[0-9a-f]{64}', before_message_id)):
                raise EngineError('invalid_cursor','Invalid message cursor',400)
            # The materialized timeline folds edits, delete tombstones, reactions and replies into each message.
            command={'Timeline':{'command':{'List':{'group_id':group,'group':None,'before':before,'before_message_id':before_message_id,'after':None,'after_message_id':None,'limit':limit}}}}
            result=self._execute({'Messages':{'command':command}})
            me=result.get('account_id') or ''
            rows=[timeline_row(m,me) for m in result['messages'] if m.get('kind',9)==9 and not m.get('group_system')]
            raw=result['messages']
            cursor={'before':raw[0]['timeline_at'],'before_message_id':raw[0]['message_id']} if raw and (len(raw)==limit or result.get('has_more_before')) else None
            return {'messages':rows,'next_cursor':cursor}

    def _message_target(self, group, payload):
        message_id=payload.get('message_id')
        if not isinstance(message_id,str) or not re.fullmatch('[0-9a-f]{64}',message_id):
            raise EngineError('invalid_message_id','Invalid message identifier',400)
        return message_id

    def edit(self, group, payload):
        with self.mutex:
            self._require_ready()
            self._dm_members(group)
            message_id=self._message_target(group,payload)
            body=text(payload.get('text'),'TEXT message',16384)
            result=self._execute({'Messages':{'command':{'Edit':{'group_id':group,'message_id':message_id,'text':[body]}}}})
            return {'group_id':group,'message_id':message_id,'message_ids':result.get('message_ids',[]),'published':result.get('published')}

    def delete(self, group, payload):
        with self.mutex:
            self._require_ready()
            self._dm_members(group)
            message_id=self._message_target(group,payload)
            result=self._execute({'Messages':{'command':{'Delete':{'group_id':group,'message_id':message_id}}}})
            return {'group_id':group,'message_id':message_id,'message_ids':result.get('message_ids',[]),'published':result.get('published')}

    def react(self, group, payload):
        with self.mutex:
            self._require_ready()
            self._dm_members(group)
            message_id=self._message_target(group,payload)
            if payload.get('remove') is True:
                result=self._execute({'Messages':{'command':{'Unreact':{'group_id':group,'message_id':message_id}}}})
            else:
                emoji=payload.get('emoji')
                if not isinstance(emoji,str) or not emoji.strip() or len(emoji)>32 or any(c in emoji for c in '\r\n\t'):
                    raise EngineError('invalid_input','Choose a reaction',400)
                result=self._execute({'Messages':{'command':{'React':{'group_id':group,'message_id':message_id,'emoji':emoji}}}})
            return {'group_id':group,'message_id':message_id,'message_ids':result.get('message_ids',[]),'published':result.get('published')}

    def retry(self, group, payload):
        with self.mutex:
            self._require_ready()
            self._dm_members(group)
            event_id=payload.get('message_id')
            if event_id is not None and (not isinstance(event_id,str) or not re.fullmatch('[0-9a-f]{64}',event_id)):
                raise EngineError('invalid_message_id','Invalid message identifier',400)
            result=self._execute({'Messages':{'command':{'Retry':{'group_id':group,'event_id':event_id}}}})
            return {k:result[k] for k in ['group_id','target_event_id','retry_scope','published','message_ids','maintenance_disposition']}

    # Failures wnd reports before anything is published: the encrypted blob never reached a Blossom
    # server, or the reference was refused locally. Only these release the send intent for a retry.
    MEDIA_PRE_PUBLISH = ('invalid_media_attachment','invalid_encrypted_media','media_reference_stale_epoch',
                         'media_reference_epoch_unsettled','io_error')

    def send_media(self, group, payload):
        """Encrypt each file with the group's MIP-04 media key, upload the ciphertext to the group's
        Blossom endpoints (engine defaults) and publish one kind-9 message carrying every imeta tag."""
        with self.mutex:
            self._require_ready()
            self._dm_members(group)
            paths=payload.get('paths')
            if not isinstance(paths,list) or not 1 <= len(paths) <= 10 or not all(isinstance(p,str) and os.path.isfile(p) for p in paths):
                raise EngineError('invalid_upload','Attach the file again',400)
            caption=payload.get('text') or None
            if caption is not None: caption=text(caption,'caption',16384)
            request_id=payload.get('request_id')
            if not isinstance(request_id,str) or not re.fullmatch('[a-zA-Z0-9_-]{16,128}',request_id):
                raise EngineError('invalid_request_id','Use a unique 16..128 character client request id',400)
            digest=hashlib.sha256()
            for p in paths:
                with open(p,'rb') as f: digest.update(hashlib.sha256(f.read()).digest())
            digest.update((caption or '').encode()); digest=digest.hexdigest()
            with self._db() as db:
                previous=db.execute('SELECT group_id,body_sha256,state,result_json FROM sends WHERE request_id=?',(request_id,)).fetchone()
                if previous:
                    if previous[0]!=group or previous[1]!=digest:
                        raise EngineError('request_id_conflict','A request id cannot be reused for different message content',409)
                    if previous[2]=='accepted':
                        return {**json.loads(previous[3]),'replayed':True}
                    raise EngineError('send_outcome_unknown','Refresh history before resolving this send; it will not be automatically duplicated',409)
                db.execute('INSERT INTO sends VALUES (?,?,?,\'pending\',NULL)',(request_id,group,digest))
            def release(code, message):
                if code in self.MEDIA_PRE_PUBLISH or (code=='command_failed' and message.startswith('blob store request failed')):
                    with self._db() as db: db.execute('DELETE FROM sends WHERE request_id=? AND state=\'pending\'',(request_id,))
                    raise EngineError('media_upload_failed','The attachment could not be uploaded. Try again.',502)
            result=self._execute({'Media':{'command':{'Upload':{'group':group,'file_paths':paths,'send':True,'message':caption,'media_type':None,'server':None}}}},
                                 timeout=300,failure=release)
            sent=result.get('sent') or {}
            if not sent.get('message_ids'):
                raise EngineError('send_outcome_unknown','Refresh history before resolving this send; it will not be automatically duplicated',409)
            receipt={'group_id':group,'message_ids':sent['message_ids'],'published':sent.get('published'),'delivery':'published_not_receipt','request_id':request_id,
                     'attachments':[{'sha256':a['media']['plaintext_sha256'],'mime':a['media'].get('media_type') or 'application/octet-stream','filename':a['media'].get('file_name') or ''}
                                    for a in result.get('attachments',[])]}
            with self._db() as db:
                db.execute('UPDATE sends SET state=\'accepted\',result_json=? WHERE request_id=?',(json.dumps(receipt),request_id))
            return receipt

    def media_download(self, group, sha256, output):
        """Fetch one attachment's ciphertext from Blossom and decrypt it with the group key into `output`."""
        with self.mutex:
            self._require_ready()
            self._dm_members(group)
            if not isinstance(sha256,str) or not HEX64.fullmatch(sha256):
                raise EngineError('not_found','No media on that message',404)
            def missing(code, message):
                if code=='media_attachment_not_found': raise EngineError('not_found','No media on that message',404)
                raise EngineError('upstream_unavailable','Could not load that media. Try again.',503)
            result=self._execute({'Media':{'command':{'Download':{'group':group,'file_hash':sha256,'output':str(output)}}}},timeout=300,failure=missing)
            return {'size':result.get('size_bytes'),'mime':(result.get('media') or {}).get('media_type')}

    def send(self, group, payload):
        with self.mutex:
            self._require_ready()
            self._dm_members(group)
            body=text(payload.get('text'),'TEXT message',16384)
            reply_to=payload.get('reply_to')
            if reply_to is not None and (not isinstance(reply_to,str) or not re.fullmatch('[0-9a-f]{64}',reply_to)):
                raise EngineError('invalid_message_id','Invalid reply target',400)
            request_id=payload.get('request_id')
            if request_id is not None:
                if not isinstance(request_id,str) or not re.fullmatch('[a-zA-Z0-9_-]{16,128}',request_id):
                    raise EngineError('invalid_request_id','Use a unique 16..128 character client request id',400)
                digest=hashlib.sha256(body.encode()).hexdigest()
                with self._db() as db:
                    previous=db.execute('SELECT group_id,body_sha256,state,result_json FROM sends WHERE request_id=?',(request_id,)).fetchone()
                    if previous:
                        if previous[0]!=group or previous[1]!=digest:
                            raise EngineError('request_id_conflict','A request id cannot be reused for different message content',409)
                        if previous[2]=='accepted':
                            return {**json.loads(previous[3]),'replayed':True}
                        # Persisted intent with no receipt is ambiguous after a
                        # crash/timeout. Never fresh-encrypt/send the body again.
                        raise EngineError('send_outcome_unknown','Refresh history before resolving this send; it will not be automatically duplicated',409)
                    db.execute('INSERT INTO sends VALUES (?,?,?,\'pending\',NULL)',(request_id,group,digest))
            result=self._execute({'Messages':{'command':{'Send':{'group_flag':group,'reply_to':reply_to,'args':[body]}}}})
            receipt={'group_id':group,'message_ids':result['message_ids'],'published':result['published'],'delivery':'published_not_receipt'}
            if request_id is not None:
                receipt['request_id']=request_id
                with self._db() as db:
                    db.execute('UPDATE sends SET state=\'accepted\',result_json=? WHERE request_id=?',(json.dumps(receipt),request_id))
            return receipt
