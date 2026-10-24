# Main Messenger → independent owner authority

**Implemented, not deployed. No isolation/security guarantee is claimed.**
The security boundary is a separately administered authority host and provider
credentials that the main host cannot recover. Main-host/root guards are only
application defense in depth. Existing local credentials must be revoked, bridge
sessions migrated, and the independent host actually provisioned before isolation
can be claimed. No accounts, credentials or production messages were changed.

## Opt-in draft export

`MESSENGER_AUTHORITY_CONFIG` names a host-owned JSON file (unset = disabled):

```json
{
  "independent_endpoint": "https://owner-authority.example.net",
  "wizard_origin": "https://wizard.example.net",
  "owner_verified_independent_host": true,
  "draft_key_file": "/run/secrets/authority-draft-key",
  "accounts": {"telegram": "owner-telegram", "whatsapp": "owner-whatsapp"}
}
```

This is an operator trust attestation, not automated proof of different host/admin.
Only the independent authority's draft-only bearer belongs on the main host.
Never configure owner enrollment/session/passkey credentials or Matrix/bridge
provider credentials as the draft key. The key format is 32–256 ASCII letters,
digits, `_` or `-`. Mount the configuration/key read-only outside the data root.
There is deliberately no HTTP endpoint to change config, URL, keys or account map.

Adapter dependency strategy: Python stdlib `http.client.HTTPSConnection`, mandatory
`ssl.create_default_context`, normal certificate + hostname verification. Direct
HTTPS port 443; no environment proxies, redirects, custom TLS/CA switches,
HTTP fallback, generic proxy, approval, full-send or provider operation. Runtime
packaging copies `remote_authority.py`; no additional runtime Python dependency.
Only `/health`, `/agent/drafts` and `/agent/drafts/{id}` are called. Matrix backend
health must match the known protocol. Health does not authenticate a particular
provider account, prove account ownership, prove revoked main credentials, or
prove host independence. The independent authority validates its own room map.

Owner browser API (existing owner cookie + Origin + CSRF required):

* `GET /api/view/authority` — configured/available status and clear disabled reason.
* `POST /api/drafts/{id}/export`, body `{"revision": N}` — persist exact local
  revision/account/Matrix room/text and random request ID **before** the network.
* `POST /api/drafts/{id}/authority-status`, same revision — independently read
  status. Only exact `matrix-delivered` releases the freeze into closed/sent state.

Account is derived from host-configured network mapping; room is from the exact
local person-owned unified identity. Request recipient/body/URL/token/approval
fields cannot override it. Text is exported byte-for-byte as saved, without local
translation, attachment upload, callback send or local approval. The independent
owner screen remains the definitive account/room/text review.

Retries/restarts reuse the persisted request ID, payload and authority origin.
Changing the local identity map cannot reroute an already frozen export; changing
the authority origin fails closed. A timeout may mean the remote draft exists:
**retry the same frozen draft**, never create a replacement. The standalone review
link is only the configured origin, opened in a new top-level tab, noopener,
noreferrer; no iframe, URL ticket, query secret or owner session transfer.

The main UI's **Review securely** saves current text/recipient changes before
exporting; it stays disabled with a reason unless the endpoint is owner-configured
and its health protocol matches. Exported drafts cannot be edited, previewed,
locally sent or deleted. Local machine/agent access permits only existing local
draft operations, not export/independent approval/settings.

## Explicit remote-required mode

`MESSENGER_REMOTE_REQUIRED=1` replaces the local engine with `OfflineEngine` and
uses only `CachedDirectory`, never `UnifiedInbox`/`ConnectorInbox` workers. An
allowlist runs before every legacy dispatcher, rejecting outbound contacts,
invites, sends, uploads, read receipts, typing, edits/reactions, provisioning/login
flows, and nonallowlisted GET routes. A local full-access policy does not override
this gate. Local browser authentication and owner policy configuration remain
local only; neither grants an authority send capability.

Use a **fresh credential-free data directory**, not an existing live deployment.
Only browser auth/passkeys, local drafts/policy/audit and `unified/people.sqlite3`
(+ SQLite sidecars) are accepted. Offline database `kv` must be empty; local
secrets/configuration files and Matrix/bridge environment configuration are
rejected. Provision a curated identity snapshot without provider tokens; do not
copy a production people DB wholesale. Existing local browser credentials can
be provisioned separately; there is no new remote-mode enrollment wizard.
These checks are not a root sandbox and cannot discover credentials elsewhere on
the machine or prevent a root administrator from changing code/configuration.

**Architectural blocker:** there is no restricted live Matrix/bridge read facade.
Remote-required mode has an offline recipient directory and draft export only,
not a functioning live inbox, history sync, media reading or notifications. The
normal live UI expects additional inbox routes and may show unavailable/offline
errors in this mode. A separately administered read-only facade plus snapshot
refresh contract and dedicated remote-mode onboarding/UI are required for a
complete live replacement without restoring local send-capable credentials.

**Cancellation gap:** current independent authority has no terminal cancel API.
Pending/queued exports remain frozen (even after policy changes); never locally
unfreeze or delete one on the assumption it was canceled. Add independently
verified terminal cancellation at the authority before supporting abandoned-draft
editing/deletion. Currently only independent Matrix completion releases the
freeze, to a closed, non-resendable local record.

Outside explicit remote-required mode, untouched legacy local send routes still
exist. The new exported draft path never falls back to them. This integration
alone does not make an existing credential-bearing live installation isolated.

## Evidence and scope

`tests/test_remote_authority.py` runs main HTTP requests through real TLS sockets
into the actual authority middleware/schema/SQLite/idempotency implementation and
uses the existing loopback fake Matrix protocol + real WebAuthn signature fixtures.
It covers uncertain commit/retry/restart, exact recipient/body/revision, freeze,
bearer/CSRF rejection, authority outage/redirect/wrong key and legacy route denial.
Only independent UV approval permits the fake Matrix event. These are local
fixtures, not real passkey hardware, public TLS deployment, provider delivery,
credential revocation, host independence, container build or production proof.
