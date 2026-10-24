# Isolated Messenger owner authority — executable TEST backend

**Status:** implemented, locally exercised, not installed, not deployed, not integrated into the existing Messenger core. Existing UI/core is untouched. This release has **only `test-ledger`**, a durable local provider-test backend: it never sends a real message, logs into an account or contacts a provider. Do not call a ledger result a Matrix/provider delivery. No production send credentials are accepted in this release.

## What “the AI cannot send” can and cannot mean

Wizard root can replace any local application, change its policy, mint its view tickets, steal locally held secrets and bypass local approval buttons. A second container, user, process, passkey page or service on that same VPS is **not** an isolation boundary against it.

The required topology is:

```
untrusted Wizard VPS (agent has root)
  - narrow draft-submission key, NO provider send capability
  - optional wizard_client.py; shipped config DISABLED
            │ HTTPS /agent/drafts only
            ▼
independently administered owner host/device
  - this service + SQLite authority + immutable review UI
  - separately controlled DNS, TLS keys, updates, backups and host admin
  - owner passkey PUBLIC key only; private key stays with owner authenticator
  - future provider send credential / fixed adapter ONLY here
            ▲
owner browser → bookmarked independent HTTPS origin
  - UV WebAuthn login; fresh UV assertion for each exact send or mode change
```

**An independently deployed topology is still an owner-only trust gate.** The `independently_administered` and client `owner_verified_independent_host` flags are startup interlocks/attestations, not proofs of independence. The agent can edit its local client/guard, but that cannot grant authority on the genuinely independent service. Do not enable these flags merely because a process runs at another URL.

The owner host must not share the Wizard cloud/admin account, SSH keys, management agents, tailnet ACL administration, DNS/TLS credentials, backups, storage, CI/deploy keys, remote browser/desktop, password vault or recovery channel accessible to Wizard root. Use a separate domain or delegation whose TLS/DNS cannot be changed with Wizard-held credentials. The owner browser/profile/authenticator must also be outside agent control. Passkeys verify the origin and user verification; **they do not have a trusted display that independently proves the human read the transaction text**. The trusted independent UI supplies that review. A tricked owner can still explicitly authorize an unwanted action; denial of service/draft flooding and draft confidentiality from Wizard are not prevented.

Before a literal production claim, the owner must additionally remove/revoke **every** provider sending session/token/device and alternate connector route on Wizard, provision/review a real fixed provider adapter on the independent host, deploy this boundary there, and perform an owner-attended test. None of those steps happened here. This repository alone does not turn the live Wizard into strong Draft-only mode.

## Authorization and exact bytes

* Draft key: `POST /agent/drafts`, `GET /agent/drafts/{id}`. It cannot enroll the owner, make owner sessions, approve, set mode, or invoke a generic provider proxy. `/agent/full-send/{id}` is denied unless both an independently edited `allow_full_access=true` config **and** a fresh owner-UV mode change enable Full access.
* Owner enrollment: one-time high-entropy bootstrap token generated only at the independent host console, then a real UV WebAuthn registration. It is hashed in SQLite, consumed on successful enrollment, cannot reset an enrolled owner, and is never exposed by an API. Keep it out of Wizard/browser logs, URLs and chat. Browser input is cleared immediately. Replacement/recovery requires owner-local maintenance; there is no agent recovery API.
* Login: fresh expiring WebAuthn assertion; secure HttpOnly SameSite=Strict 15-minute cookie. All owner POSTs require the exact configured `Origin`. No CORS, iframe embedding, external scripts or forwarded-header trust.
* Approval: owner sees the immutable canonical payload returned by the independent authority, then invokes a **fresh user-verifying** assertion. The vetted `webauthn` library validates signature, registered credential, RP ID hash, exact HTTPS origin, challenge, UP/UV and signature counter semantics (including authenticators with zero counters).
* Canonical payload v1: ASCII JSON, lexically sorted keys, compact separators; no body/recipient/account normalization. Attachments contain fixed inline bytes (base64), exact filename/media type, derived size and SHA-256. No external URL can change attachment content after approval. At most 8 attachments / 1 MB decoded total / 20,000 body characters. UI renders all content with `textContent` and escaped non-ASCII/control characters, not HTML; review includes exact bytes and hashes, not untrusted display names alone.
* Challenge: random 256-bit nonce followed by SHA-256 of the versioned action/payload/policy-epoch binding; expires after 120 seconds by default (15–300 configurable). Its authoritative server record binds exact account, recipient, body, attachment bytes/hashes, draft ID and policy epoch. Finish accepts **only challenge ID + credential**, not replacement message fields.
* Atomicity: SQLite `BEGIN IMMEDIATE` serializes challenge verification/counter update/consumption/payload comparison/test delivery. A consumed, expired or policy-invalidated challenge cannot be reused. Two challenges for the same draft cannot create two deliveries. `test_deliveries.draft_id` is UNIQUE. Mode changes advance the policy epoch and invalidate outstanding send/login/mode challenges, including across restarts. Sends and mode changes serialize at the same durable lock.
* Retry/restart: producer supplies `request_id` (16–128 chars) and must persist/reuse it. Same ID + exact same payload returns the same draft and status; changed payload returns 409. Approval replay returns 403, not another send. A test-delivery transaction interrupted before commit rolls back the counter, consumed flag and delivery; retry can complete it. A committed transaction survives response loss/restart. Poll the draft status rather than making a new request ID.
* Full access is an explicit exception to strong Draft-only, default off, only reachable after both operator config and owner passkey authorization. The independent UI labels it accordingly. Returning to Draft-only revokes future agent sends and invalidates in-flight outstanding approvals; it cannot retract a delivery committed before the mode change.

This transaction strategy proves idempotency for the **local test backend**, not a distributed provider. A future Matrix adapter needs fixed account/room mapping and Matrix transaction IDs durably bound to this operation, no generic URL/method proxy, credential isolation, response-loss reconciliation, and crash/retry tests across the remote send boundary. Do not drop an HTTP POST into this SQLite transaction and claim exactly-once delivery.

## Independent host install/runbook (owner performs; not executed here)

Use an independently controlled Linux host and Python 3.14 (the exercised runtime). Other Python versions are not certified by this result. Do not copy the private main repository to a public service: transfer/review only this directory over an owner-authorized private channel. Runtime packages are external open-source dependencies from the Python package index; no repository source was uploaded.

1. Create an unprivileged `isolated-sender` user, `/opt/isolated-sender/isolated_sender/`, `/etc/isolated-sender/`, and `/var/lib/isolated-sender/` (0700, service-user owned). Place this directory at that package path. Keep source and config owner/root-writable only, not service-user-writable; the DB/state is the only writable application directory. No Wizard agent, SSH credential, deploy runner or shared mount may administer this machine.
2. Create `/opt/isolated-sender/.venv` and install `isolated_sender/requirements.txt`. Versions including transitives are pinned; review/update dependencies before external exposure. Optional UI testing uses `requirements-ui.txt` with an existing Chrome, not a browser image build.
3. Copy `deploy/owner-config.example.json` to `/etc/isolated-sender/config.json` (0640 root/service-group). Replace origin/RP with the **same exact dedicated HTTPS hostname**, no path or non-443 origin port. Configure account IDs; this release's IDs are test identifiers, not provider sessions. Leave `backend=test-ledger` and `allow_full_access=false`. Only the owner may attest `independently_administered=true` after verifying the topology above.
4. Generate at least 32 bytes of random draft-key material on the independent host. Put its **SHA-256 hex digest** in `agent_key_sha256`. Transfer only the narrow raw draft key to Wizard, not config/DB/bootstrap token/owner session/TLS key/provider credentials. Store the raw key in a 0600 file on Wizard. Rotating this config digest immediately rejects the old draft key. Draft secrets may be stolen by Wizard root by design; they still cannot approve.
5. Provision a browser-trusted TLS certificate for that separately controlled origin. Place the chain and private key at `/etc/isolated-sender/tls/{fullchain.pem,privkey.pem}` with service read permission and no Wizard access. Renew through the independent administration channel; restart the service to load renewed keys. Never use `verify=False`, install a test CA, accept a certificate warning or trust an `X-Forwarded-Proto` header in production. This service terminates TLS itself. A pure TCP pass-through is possible; do not terminate into plaintext HTTP. Use only trusted exact Host/Origin and no public content/CDN at this origin.
6. On the independent host console, run from `/opt/isolated-sender`:

   ```sh
   .venv/bin/python -m isolated_sender.service check --config /etc/isolated-sender/config.json
   # As the service user, to avoid root-owned database files:
   sudo -u isolated-sender .venv/bin/python -m isolated_sender.service init-owner --config /etc/isolated-sender/config.json
   ```

   The second command prints the bootstrap token **to this owner console only**. Until enrollment, a new invocation replaces the old token. After enrollment it refuses. Do not paste this token into an agent/chat/URL. Expire a lost unused bootstrap by invoking again at the console; keep the service firewall closed during initial setup. There is no automatic first-user enrollment.
7. Install/review `deploy/isolated-sender.service` on the **independent** host and start it using that owner's systemd administrator. It runs TLS on 443 with only `CAP_NET_BIND_SERVICE`, a read-only source filesystem and one writable state directory. The unit is a template, not an executed installer. For manual owner-host execution:

   ```sh
   .venv/bin/python -m isolated_sender.service serve --config /etc/isolated-sender/config.json \
     --host 0.0.0.0 --port 443 \
     --tls-cert /etc/isolated-sender/tls/fullchain.pem --tls-key /etc/isolated-sender/tls/privkey.pem
   ```

8. Open/bookmark the independent HTTPS origin in an owner-controlled browser; verify the hostname and trusted certificate. Paste console token into Owner setup, enroll a verifying passkey, sign in. There are no real provider sends in this release. Test the exact draft-review flow and read back `test-delivered`; UI and API both explicitly say TEST backend.
9. Add independently controlled firewall/rate limits, disk/challenge/draft quotas, request timeouts, encrypted backups and monitoring before public exposure. Current service has per-request size bounds, not global storage quotas or challenge-rate protection. Avoid request/body/access logs; access logging is off. DB contains sensitive drafts/attachments and owner public credentials/session hashes. Use an accurately maintained system clock; challenge expiry depends on it. Do not restore an old live DB snapshot as an active authority without invalidating sessions/challenges and reconciling deliveries; restoring old state can defeat anti-replay history. Recovery is owner-only, service stopped, backed-up state reviewed.
10. For actual production usefulness, design/review a real fixed adapter and its credentials, independently deploy it, revoke all sending paths on Wizard and perform an attended owner-only acceptance test. The shipped backend and client **reject unknown/production backend names**, so an undocumented adapter cannot be silently enabled by config.

## Wizard-side fail-closed deployment contract

`deploy/wizard-client.disabled.json` deliberately has no endpoint/key/independence attestation. The executable preflight exits nonzero with it, before any network access:

```sh
python -m isolated_sender.wizard_client preflight --config isolated_sender/deploy/wizard-client.disabled.json
# exits 1: Isolated sender unavailable; no local fallback
```

The owner/integration lane can copy it to `/etc/messenger/isolated-sender-client.json` and set the trusted independent origin, actual Wizard origin, absolute narrow-key file and verified-independence attestation. `deploy/wizard-messenger-preflight.conf` is an **unapplied** systemd drop-in example for the main service. Its `ExecStartPre` blocks startup until configuration and a valid CA-verified `/health` succeed. Runtime client never follows redirects, trusts environment proxies, uses owner tickets/sessions, or falls back to a local provider sender.

Submit one draft via stdin:

```sh
python -m isolated_sender.wizard_client submit-draft --config /etc/messenger/isolated-sender-client.json < exact-draft.json
```

`exact-draft.json`:

```json
{"request_id":"durable-unique-request-0001","account":"test-owner","recipient":"test-recipient","body":"exact text\n","attachments":[{"name":"note.txt","media_type":"text/plain","data_base64":"YQ=="}]}
```

Success returns `id`, `request_id`, exact canonical `payload`, `hash`, `status`. Link the owner to their **bookmarked independent origin**, not an approval iframe/script served by Wizard. Current owner UI lists the latest 100 drafts after passkey login. No local ticket exchange exists.

**Integration is deliberately separate:** main core remains unchanged under this lane's ownership rules. Applying the drop-in/client alone cannot neutralize old connectors with send-capable credentials. The application/connector lanes must remove all local send paths and capability-bearing credentials before reporting strong mode. A hostile root can bypass its own startup guard; only the independent sender's authentication plus missing local provider capability makes that bypass harmless for sending.

## Local verification (synthetic fixtures only)

From the repository root, with `TMPDIR` pointing at the authorized scratch directory:

```sh
python -m venv /path/to/scratch/sender-venv
/path/to/scratch/sender-venv/bin/pip install -r isolated_sender/requirements-ui.txt
/path/to/scratch/sender-venv/bin/python -m pytest isolated_sender/tests -q
node --check isolated_sender/owner.js
```

Tests exercise real library verification against generated EC registration/assertions, wrong credential/signature/origin/RP/challenge, missing UV, payload tampering for account/recipient/body/attachments, expired/consumed/duplicate approvals, eight concurrent service instances sharing one DB, restart/response-loss retries, rollback after delivery before commit, exact-request idempotency/conflicts, owner-only mode changes/policy invalidation, direct trusted-fixture HTTPS subprocess, disabled deployment, and a real Chromium/CDP virtual passkey enrollment → login → immutable escaped review → test delivery → logout. UI test is optional without `requirements-ui.txt` and defaults to `/usr/bin/google-chrome` (override `ISOLATED_SENDER_CHROME`). Its ASGI routing aborts any unexpected URL; it is **not** independent-host deployment proof. TLS socket test binds loopback only, generates a temporary test certificate and removes the subprocess; it does not install any root CA or contact a provider.

Dependencies: Duo Labs `webauthn` (BSD-3-Clause) handles WebAuthn cryptography; FastAPI/Starlette/httpx/uvicorn and their dependencies are separately licensed packages. No vendored crypto or existing Messenger passkey/session/ticket code is used. A current Starlette TestClient/httpx deprecation warning is test tooling only; `pip check` passes. Dependency pins are tested versions, not a blanket security certification.
