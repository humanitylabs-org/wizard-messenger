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

def group_id(value):
    if not isinstance(value, str) or not GROUP.fullmatch(value):
        raise EngineError('invalid_group_id', 'Invalid group identifier', 400)
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

    def status(self):
        ready = self.unlocked and self.daemon is not None and self.daemon.poll() is None
        state = 'ready' if ready else ('locked' if self.marker.exists() else 'setup_required')
        return {'state': state, 'engine': 'marmot', 'mdk_version': '0.12.0', 'mdk_revision': MDK_REV, 'secret_store': 'keychain', 'vault_provider': 'gnome-secret-service', 'requires_unlock_after_restart': True, 'account_configured': self.marker.exists(), 'capabilities': ['encrypted_text', 'invites', 'dm'], 'unsupported': ['attachments', 'notifications', 'group_chats', 'key_export']}

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

    def _execute(self, command, *, account=None, import_nsec=None):
        cli = {'home':str(self.home), 'socket':None, 'relay':None, 'secret_store':'Keychain', 'keychain_service':self.service, 'account':account, 'json':True, 'command':command}
        request = {'cli':cli}
        if import_nsec is not None:
            request['import_nsec'] = import_nsec
        data = json.loads(self._rpc({'Execute':request}))
        if not data.get('ok'):
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
        if not isinstance(password, str) or len(password) < 16 or len(password.encode()) > 1024 or '\x00' in password:
            raise EngineError('invalid_vault_password', 'Use a dedicated vault passphrase of at least 16 characters', 400)
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
                self._stop_keyring()
                raise EngineError('vault_unlock_failed', 'The messaging vault remains locked', 423)
            self._launch()
            self.unlocked = True
        except (OSError, subprocess.TimeoutExpired):
            self._stop_keyring()
            raise EngineError('vault_unavailable', 'The encrypted messaging vault is unavailable', 503) from None

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
        with self.mutex:
            action = payload.get('action')
            if action == 'lock':
                self.lock()
                return self.status()
            if action not in ['unlock','create','import']:
                raise EngineError('invalid_setup_action', 'Use unlock, create, import or lock', 400)
            name=text(payload['display_name'],'display name') if payload.get('display_name') is not None else None
            if not self.unlocked or self.daemon is None or self.daemon.poll() is not None:
                self._unlock(payload.get('vault_password'))
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
            return {**self.status(), **self.identity()}

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
        return [{k:v for k,v in member.items() if k in ['account_id','member_id','npub','display_name','profile']} for member in members]

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
            return {'invites':[self._group(g,self._dm_members(g['group_id'])) for g in self._groups('Invites')['invites']]}

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
            command={'List':{'group_id':group,'group':None,'kinds':[9],'before':before,'before_message_id':before_message_id,'after':None,'after_message_id':None,'limit':limit}}
            result=self._execute({'Messages':{'command':command}})
            rows=[{'message_id':m['message_id'],'group_id':m['group_id'],'author':m['from'],'author_name':m.get('from_display_name',''),'text':m['plaintext'],'direction':m['direction'],'created_at':m['received_at']} for m in result['messages']]
            cursor={'before':rows[0]['created_at'],'before_message_id':rows[0]['message_id']} if len(rows)==limit else None
            return {'messages':rows,'next_cursor':cursor}

    def retry(self, group, payload):
        with self.mutex:
            self._require_ready()
            self._dm_members(group)
            event_id=payload.get('message_id')
            if event_id is not None and (not isinstance(event_id,str) or not re.fullmatch('[0-9a-f]{64}',event_id)):
                raise EngineError('invalid_message_id','Invalid message identifier',400)
            result=self._execute({'Messages':{'command':{'Retry':{'group_id':group,'event_id':event_id}}}})
            return {k:result[k] for k in ['group_id','target_event_id','retry_scope','published','message_ids','maintenance_disposition']}

    def send(self, group, payload):
        with self.mutex:
            self._require_ready()
            self._dm_members(group)
            body=text(payload.get('text'),'TEXT message',16384)
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
            result=self._execute({'Messages':{'command':{'Send':{'group_flag':group,'reply_to':None,'args':[body]}}}})
            receipt={'group_id':group,'message_ids':result['message_ids'],'published':result['published'],'delivery':'published_not_receipt'}
            if request_id is not None:
                receipt['request_id']=request_id
                with self._db() as db:
                    db.execute('UPDATE sends SET state=\'accepted\',result_json=? WHERE request_id=?',(json.dumps(receipt),request_id))
            return receipt
