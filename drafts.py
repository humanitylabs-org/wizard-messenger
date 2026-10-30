"""Server-side drafts (text plus attachments). Every edit is fenced to the current revision.

One draft is the composer's text for a chat: the owner's screen autosaves into it, an agent with
Draft-only access can create, extend and attach files to it, and only the owner's signed-in screen
sends it. Attachments are kept beside the drafts file and removed with their draft."""
import copy
import json
import os
import re
from pathlib import Path
import secrets
import shutil
import tempfile
import threading
import time
from engine import EngineError

ATTACH_MAX = 25 * 1024 * 1024
ATTACH_COUNT = 10
STORAGE_MAX = 100 * 1024 * 1024  # shared cap for all server drafts, including agent uploads

class Drafts:
    def __init__(self, root=None):
        self.path = Path(root) / 'agent-drafts.json' if root else None
        self.lock = threading.RLock(); self.rows = {}
        self.files = (Path(root) if root else Path(tempfile.mkdtemp(prefix='drafts-'))) / 'draft-files'
        if self.path and self.path.exists():
            self.rows = json.loads(self.path.read_text())
    def save(self):
        if not self.path: return
        self.path.parent.mkdir(parents=True, exist_ok=True)
        tmp = self.path.with_suffix('.tmp')
        with tmp.open('w') as f:
            os.chmod(tmp, 0o600); json.dump(self.rows, f)
            f.flush(); os.fsync(f.fileno())
        os.replace(tmp, self.path)
        directory = os.open(self.path.parent, os.O_RDONLY | os.O_DIRECTORY)
        try: os.fsync(directory)
        finally: os.close(directory)
    def get(self, ident):
        if ident not in self.rows: raise EngineError('not_found', 'Draft not found', 404)
        return self.rows[ident]
    def check(self, row, payload):
        if type(payload.get('revision')) is not int or payload['revision'] != row['revision']:
            raise EngineError('draft_changed', 'Draft changed. Review it again before sending.', 409)
    def mine(self, row, actor, edit=False):
        # Agents may change or discard drafts they created; the owner may change any. An agent may also
        # extend the owner's own composer draft (edit=True), never another agent's, and never discard it.
        by = (row.get('created_by') or {}).get('id')
        if by == (actor or {}).get('id') or (edit and by == 'owner'): return
        raise EngineError('not_your_draft', 'Only the agent that wrote this draft, or the owner, can change it', 403)
    def stamp(self, row, owner, actor):
        row['revision'] += 1; row['updated'] = int(time.time() * 1000)
        row['updated_by'] = {'id': 'owner', 'name': 'You'} if owner else {'id': str(actor['id'])[:80], 'name': str(actor['name'])[:60]}
    def drop_files(self, ident):
        shutil.rmtree(self.files / ident, ignore_errors=True)
    def attachments(self, method, row, rest, payload, raw, query, owner, actor):
        ident = row['id']
        if method == 'GET' and len(rest) == 1:
            item = next((a for a in row.get('attachments', []) if a['id'] == rest[0]), None)
            if not item: raise EngineError('not_found', 'Attachment not found', 404)
            from unified import Blob, INLINE_MIME
            return Blob(self.files / ident / item['id'], item['mime'], item['name'], item['mime'] in INLINE_MIME)
        if row['state'] != 'draft' or row.get('export') or row.get('preview'):
            raise EngineError('draft_closed', 'This draft is already submitted', 409)
        if not owner: self.mine(row, actor, edit=True)
        if method == 'PUT' and not rest:
            try: revision = int((query.get('revision') or [''])[0])
            except ValueError: revision = None
            self.check(row, {'revision': revision})
            if len(row.get('attachments', [])) >= ATTACH_COUNT:
                raise EngineError('attach_limit', 'Up to 10 attachments per draft', 409)
            if not raw or len(raw) > ATTACH_MAX: raise EngineError('too_large', 'Files up to 25 MB can be attached', 413)
            # Never treat agent-supplied MIME as proof that untrusted bytes are an image.
            if raw.startswith(b'\x89PNG\r\n\x1a\n'): mime = 'image/png'
            elif raw.startswith(b'\xff\xd8\xff'): mime = 'image/jpeg'
            elif raw.startswith((b'GIF87a', b'GIF89a')): mime = 'image/gif'
            elif raw.startswith(b'RIFF') and raw[8:12] == b'WEBP': mime = 'image/webp'
            elif raw.startswith(b'%PDF-'): mime = 'application/pdf'
            else: mime = 'application/octet-stream'
            used = sum(a.get('bytes', 0) for draft in self.rows.values() for a in draft.get('attachments', []))
            if used + len(raw) > STORAGE_MAX:
                raise EngineError('draft_storage_full', 'Draft attachments have reached their storage limit', 413)
            name = re.sub(r'[\x00-\x1f/\\]', '', (query.get('name') or ['Attachment'])[0]).strip()[:120] or 'Attachment'
            aid = secrets.token_hex(8)
            folder = self.files / ident; folder.mkdir(parents=True, exist_ok=True); os.chmod(folder, 0o700)
            tmp = folder / (aid + '.tmp')
            with tmp.open('wb') as f:
                os.chmod(tmp, 0o600); f.write(raw); f.flush(); os.fsync(f.fileno())
            os.replace(tmp, folder / aid)
            row.setdefault('attachments', []).append({'id': aid, 'name': name, 'mime': mime, 'bytes': len(raw)})
            self.stamp(row, owner, actor); self.save(); return {'draft': copy.deepcopy(row)}
        if method == 'DELETE' and len(rest) == 1:
            self.check(row, payload)
            kept = [a for a in row.get('attachments', []) if a['id'] != rest[0]]
            if len(kept) == len(row.get('attachments', [])): raise EngineError('not_found', 'Attachment not found', 404)
            row['attachments'] = kept
            try: (self.files / ident / rest[0]).unlink()
            except FileNotFoundError: pass
            self.stamp(row, owner, actor); self.save(); return {'draft': copy.deepcopy(row)}
        raise EngineError('not_found', 'No such draft route', 404)
    def dispatch(self, method, suffix, payload, unified, owner=False, authority=None, remote_required=False, can_send=False, actor=None, raw=None, query=None):
        if not owner and actor is None:
            actor = {'id': 'machine', 'name': 'Wizard app key'}
        with self.lock:
            if not suffix and method == 'GET': return {'drafts': copy.deepcopy(list(self.rows.values()))}
            if not suffix and method == 'POST':
                person_id = payload.get('person_id')
                if isinstance(person_id, str) and any(r['person_id'] == person_id and r['state'] == 'draft' for r in self.rows.values()):
                    raise EngineError('draft_exists', 'This chat already has a draft. Open and update it instead.', 409)
                if len(self.rows) >= 500: raise EngineError('draft_limit', 'Remove old drafts first', 429)
                ident = secrets.token_hex(16)
                row = {'id': ident, 'revision': 0, 'state': 'draft'}
            elif suffix:
                ident = suffix[0]; row = self.get(ident)
            else: raise EngineError('not_found', 'No such draft route', 404)
            if len(suffix) >= 2 and suffix[1] == 'attachments':
                return self.attachments(method, row, suffix[2:], payload, raw, query or {}, owner, actor)
            if len(suffix) <= 1:
                if method == 'GET': return {'draft': copy.deepcopy(row)}
                if method == 'DELETE' and owner:
                    if row.get('export'):
                        raise EngineError('draft_frozen', 'Independent review outstanding; refresh independent terminal status first.', 409)
                    if row['state'] == 'sending': raise EngineError('draft_sending', 'Delivery may still be in progress', 409)
                    self.check(row, payload); del self.rows[ident]; self.save(); self.drop_files(ident); return {'deleted': True}
                if method == 'DELETE' and not owner:
                    # Discarding an unsent draft is a draft action, never a provider write.
                    self.mine(row, actor); self.check(row, payload)
                    if row['state'] != 'draft' or row.get('export') or row.get('preview'):
                        raise EngineError('draft_closed', 'The owner is reviewing or has sent this draft', 409)
                    del self.rows[ident]; self.save(); self.drop_files(ident); return {'deleted': True}
                if method == 'POST':
                    if suffix: self.check(row, payload)
                    if suffix and not owner: self.mine(row, actor, edit=True)
                    if row['state'] != 'draft': raise EngineError('draft_closed', 'This draft is already submitted', 409)
                    fields = {}
                    for key, maximum in [('person_id', 300), ('identity_id', 300), ('text', 16384)]:
                        value = payload.get(key)
                        # Text may be empty while the draft is attachments only, or the owner is mid-edit.
                        if not isinstance(value, str) or (key != 'text' and not value.strip()) or len(value) > maximum or '\x00' in value:
                            raise EngineError('invalid_draft', 'Choose a recipient, channel and message', 400)
                        fields[key] = value
                    if not suffix and not fields['text'].strip() and not owner:
                        raise EngineError('invalid_draft', 'Write the draft message', 400)
                    # No client supplied approval, preview, status, upload or send fields are ever retained.
                    created_by = row.get('created_by') or ({'id': 'owner', 'name': 'You'} if owner else
                                                           {'id': str(actor['id'])[:80], 'name': str(actor['name'])[:60]})
                    row = {**fields, 'id': ident, 'revision': row['revision'], 'state': 'draft', 'created_by': created_by,
                           'attachments': row.get('attachments', [])}
                    self.stamp(row, owner, actor)
                    self.rows[ident] = row; self.save(); return {'draft': copy.deepcopy(row)}
            if len(suffix) == 2 and method == 'POST' and (owner or (can_send and suffix[1] in ('preview', 'send'))):
                self.check(row, payload)
                if suffix[1] in ('export', 'authority-status'):
                    if authority is None:
                        raise EngineError('authority_unavailable', 'Independent authority not configured', 503)
                    if suffix[1] == 'export':
                        if row['state'] not in ('draft', 'exported'):
                            raise EngineError('draft_closed', 'This draft is already submitted', 409)
                        if not row.get('export'):
                            exact = authority.exact(row, unified)
                            # Freeze and fsync request ID/exact payload BEFORE any network call.
                            # Timeout/crash after remote commit retries identical ID and payload.
                            row['export'] = {'payload': dict(exact, request_id=secrets.token_hex(24)),
                                             'revision': row['revision'], 'authority_origin': authority.endpoint}
                            row['state'] = 'exported'; self.save()
                        update = authority.submit(row['export'])
                    else:
                        if not row.get('export', {}).get('remote_id'):
                            raise EngineError('export_retry', 'Retry export to recover its independent ID', 409)
                        update = authority.refresh(row['export'])
                    row['export'].update(update)
                    if update['remote_status'] == 'matrix-delivered':
                        row['authority_receipt'] = row.pop('export'); row['state'] = 'sent'
                    self.save()
                    return {'draft': copy.deepcopy(row), 'review_origin': update['review_origin']}
                if suffix[1] in ('preview', 'send') and (remote_required or row.get('export') or row.get('authority_receipt')):
                    raise EngineError('remote_required', 'Independent review required; no local fallback', 403)
                if suffix[1] in ('preview', 'send') and row.get('attachments') and row['state'] == 'draft':
                    raise EngineError('draft_has_attachments', 'Open the chat to send this draft with its attachments', 409)
                if suffix[1] == 'preview':
                    if row['state'] != 'draft': raise EngineError('draft_closed', 'This draft is already submitted', 409)
                    preview = unified.preview(row['person_id'], {'identity_id': row['identity_id'], 'text': row['text']})
                    row['preview'] = preview; row['preview_until'] = time.time() + 900; self.save()
                    return {'draft': copy.deepcopy(row)}
                if suffix[1] == 'send':
                    if row['state'] in ('sent', 'queued'): return {'draft': copy.deepcopy(row), 'delivery': row['delivery']}
                    if not row.get('preview'): raise EngineError('draft_review_required', 'Review this revision before clicking Send', 409)
                    if row['state'] == 'draft' and row.get('preview_until', 0) < time.time():
                        raise EngineError('preview_expired', 'Review this draft again before sending', 409)
                    if row['preview'].get('error') and payload.get('send_original') is not True:
                        raise EngineError('translation_failed', 'Explicitly choose Send original or review again', 409)
                    # Persist before crossing the provider boundary. No agent can edit an in-flight draft.
                    row['state'] = 'sending'; self.save()
                    result = unified.send(row['person_id'], {'preview_id': row['preview']['id'],
                        'send_original': payload.get('send_original') is True, 'client_id': ident})
                    row['state'] = 'queued' if result.get('state') == 'queued' else 'sent'
                    row['delivery'] = result; self.save()
                    return {'draft': copy.deepcopy(row), 'delivery': result}
            raise EngineError('not_found', 'No such draft route', 404)
