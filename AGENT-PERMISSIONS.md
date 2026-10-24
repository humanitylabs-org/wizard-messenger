# Agent policy and local drafts (candidate, not deployed)

## Owner workflow

In Settings → Agent access choose **No access** (default), **Read-only**, **Draft-only**, or **Full access**, optionally expiring after 1 or 24 hours. Save requires the owner's cookie, matching Origin and CSRF token. Full access asks for explicit confirmation. The request log contains route shapes, not recipient IDs or content.

Draft-only agents use `POST /api/drafts` and `POST /api/drafts/{id}` with explicit unified `person_id`, `identity_id`, `text`, and the current integer `revision` on updates. Reads use `GET /api/drafts` or `/api/drafts/{id}`. Creating or updating a draft never contacts the messaging provider or translator. Draft-only cannot preview, send, react, edit/delete messages, emit typing/read receipts, accept invitations, manage accounts, or change policy. Unknown routes deny by default. Full access permits conversation mutations but still cannot manage owner authentication, account linking or policy, or invoke owner-only draft confirmation routes.

The owner opens **Review agent drafts**, selects recipient/channel, edits text, and clicks **Save and review**. A separate **Send** button submits the exact server-stored preview and revision. Every edit creates a new revision and drops all previous preview state. Stale revisions fail with HTTP 409. UI edits while preview is in flight cannot restore an obsolete Send button. Translation failure requires explicit **Send original**. Expired previews require review again. Local drafts can be deleted by the owner, except while delivery may be in progress.

A send persists `sending` before crossing provider I/O. Ambiguous failures keep that state and block edits/deletion; the UI tells the owner to inspect conversation history, not create a replacement. The owner API can explicitly retry the same stored preview; unified confirmation maintains its existing transaction ID and confirmed-text checks. Successfully submitted queued delivery is shown as `queued`, not `sent`. Repeating a completed submission returns its existing receipt.

## Compatibility and authentication

- Legacy `agent-access.json` files containing only `until` fail closed to No access. No old broad grant becomes Full access.
- Legacy minutes-only enable requests are rejected; `minutes: 0` still revokes. New requests need an explicit mode, with optional `minutes: 1..1440`.
- Pre-v2 browser sessions and tickets are invalidated on upgrade because the previous version could mint owner authority from a machine bearer.
- Machine-authorized HTML never creates an owner cookie. Every machine-issued ticket is setup-only and cannot open a configured account. Setup-only cookies cannot read conversations or change policy and never upgrade themselves into owner sessions. The UI separately proves the entered passphrase through `/api/view/unlock` after setup.
- **Initial enrollment fails closed for machine callers, including unclaimed installations.** Machine-issued tickets are launcher-only; they cannot establish an owner passphrase. An independent trusted provisioning integration must issue `BrowserAuth.ticket(bootstrap=True)` before the owner can enroll. That enrollment ticket allows only first setup, never conversation reads or policy changes; the owner then proves the new passphrase separately. No bearer HTTP route issues enrollment tickets. The existing bearer-only setup-link provisioning flow therefore needs a parent-owned independent enrollment handoff; it is intentionally not retained as a key-to-owner escalation.

## Boundary and integration gates

These permissions are **application defense in depth, not protection against host root or an independently administered sender boundary**. Same-host administrators can inspect app data, browser sessions, provider credentials and code. Draft bodies and preview metadata live in plaintext `agent-drafts.json`, atomic mode 0600, like existing plaintext unified SQLite history. The current server is a single process; locks are process-local, not a multi-worker transaction protocol.

No deployment or sender files were modified. **Parent packaging must add `permissions.py` and `drafts.py` to Dockerfile line 33's explicit COPY list before an image can run this candidate.** No Rust/image build was run here. The independent sender lane must eventually replace provider authority, including all Full-access send/mutation paths; simply replacing `Drafts`' `unified.send` call would not isolate the other routes. `permissions.AgentAccess` owns the shared API-only/view bearer allowlist; `web.ViewHandler` owns owner-only policy and draft HTTP routes; `Drafts` calls existing `UnifiedInbox.preview` / `send` only on explicit authenticated owner requests.

New agent drafts are text-only unified-person/channel drafts (Telegram and Messenger identities); they do not add attachment drafting or a separate legacy-DM draft API. Existing owner composer/media/reply/translation flows remain unchanged. Browser rendering was exercised with the shipping JavaScript in a lightweight DOM fixture, not a screenshot/browser engine; Playwright is not installed in this worktree. No live provider, account, credential, message, spending, push or deployment was used.

## Local verification

```sh
PYTHONWARNINGS=ignore::ResourceWarning python -m unittest discover -s tests -p 'test_*.py' -q
node --test tests/test_agent_permissions_view.cjs tests/test_view.cjs tests/test_unified_view.cjs
python -m py_compile server.py web.py permissions.py drafts.py
node --check static/unified.js
node --check static/app.js
git diff --check
```

`tests/test_agent_permissions.py` exercises real loopback HTTP handlers with synthetic stores and mocked provider I/O, including both API-only and view handlers, the write-route denial matrix, owner-cookie/CSRF/Origin controls, persistence and expiry, ticket/session escalation, revision fencing, translated content binding, concurrent send/edit, and ambiguous delivery. The JavaScript test executes the actual settings/draft UI and confirms no send before a click and preview invalidation after edits, including an in-flight preview race. Existing Python tests produce pre-existing SQLite ResourceWarnings on Python 3.14 when warnings are not suppressed.
