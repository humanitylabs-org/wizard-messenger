# Independent Messenger owner authority

Implemented locally, **not deployed or live-provider certified**. Two explicit backends:
* `test-ledger` (default): durable SQLite fixtures; never sends anything.
* `matrix`: real fixed Matrix client-server HTTPS adapter for configured accounts and known room IDs. Sends exact text and inline media after owner approval (or explicitly owner-enabled Full access).

## Hard isolation is an independent-host gate, not a container feature

Wizard root can replace every local application, steal its tokens and bypass local approval. Another container/user/process on this VPS is **not** a boundary against it.

Required topology:
```
untrusted Wizard VPS: draft-only key, NO provider sending capability
   -> independent HTTPS authority: this package, SQLite, immutable owner UI
   -> independently controlled Matrix homeserver and bridge infrastructure
owner-controlled browser/authenticator -> bookmarked authority HTTPS origin
```

The authority **and the Matrix homeserver/bridges** must be in a trust domain independent of Wizard. A remote sender pointing at a Wizard-root-controlled homeserver/bridge is not isolation: its administrator can impersonate Matrix users or use bridge sessions directly. Matrix access tokens, application-service tokens, bridge provisioning tokens, remote-network sessions, device credentials, backups and alternate send routes **cannot remain on Wizard**. A read-only facade must expose only bounded sanitized reads, not a general Matrix token or the homeserver database. This lane ships no facade/webhook: it was unnecessary for approved sending and would broaden the boundary.

Independent means no shared Wizard cloud/admin account, SSH/deploy key, management agent, tailnet administration, DNS/TLS credential, backup, CI, vault or recovery channel; no agent-controlled owner browser/profile/authenticator. `independently_administered=true` is an owner attestation/startup interlock, not machine-verifiable proof. This source alone does not make the running Wizard strongly Draft-only. No access-control workaround, owner credential collection or live sends occurred here.

## Exact authorization

* Draft-only key can submit/read drafts, not enroll, login, approve or change policy. No generic provider URL/method/token/provisioning proxy is exposed.
* Owner console creates a one-time bootstrap token (`init-owner`); real UV WebAuthn registration consumes it. No remote reset/recovery API. Bootstrap material never belongs in chat, logs, URLs or Wizard.
* Login uses real library-verified UV WebAuthn, an exact dedicated RP/origin, expiring challenge, signature counter and Secure/HttpOnly/SameSite=Strict session. Each send/mode change needs a fresh assertion bound to immutable exact draft and policy epoch. Owner POSTs require exact Origin. No CORS, frames, external script or forwarded-header trust.
* Versioned canonical ASCII JSON sorts keys and preserves body/account/recipient characters without normalization. Attachments bind exact name, MIME, inline base64 bytes, derived size and SHA-256. No attachment URL is fetched. Limits: 8 attachments, 1 MB decoded total, 20,000 body characters. UI uses textContent/escaped JSON. Passkeys authenticate an origin/challenge, **not a trusted display proving the human read the text**; trusted independent UI and attentive review remain essential.
* Matrix envelopes additionally bind homeserver, Matrix user, exact room ID and SHA-256 of the high-entropy token (not the token itself). Token/session rotation or destination changes cannot silently move a queued operation into a new Matrix idempotency scope. Reconcile those drafts owner-locally instead.
* Producer must persist/reuse `request_id`. Same ID/same exact payload returns same draft/status; changed payload conflicts. An assertion cannot be replayed. Policy changes increment epoch and invalidate outstanding challenges and queued authorization before each next network operation. A request already in progress cannot be retracted.
* Full access requires both independently edited `allow_full_access=true` and owner-UV policy change. It explicitly gives the agent send authority for configured rooms until revoked. Default off.

## Matrix protocol and retry semantics

Only owner-local configuration specifies HTTPS origin (port 443), account user ID, private token file and room allowlist. Production resolves DNS at startup, rejects every non-global/loopback/private/link-local/CGNAT address, pins one public address until restart, uses hostname-verified public-CA TLS/SNI and never re-resolves during connection. No environment proxy, redirect following, arbitrary ports, remote media download, caller token, room alias, account creation, join/invite, provisioning or login API exists.

Allowed protocol operations are `GET /_matrix/client/v3/account/whoami`, a specific room encryption-state check, inline `POST /_matrix/media/v3/upload?filename=...`, and fixed `PUT /_matrix/client/v3/rooms/{configured-room}/send/m.room.message/{txn}`. Token identity must match the configured Matrix user. Encrypted rooms are rejected; E2EE is **not implemented**. Encryption must not be enabled concurrently during a send; this adapter is intended for independently managed unencrypted bridge portals. Configure homeserver ACLs and the least-privilege bridge account accordingly.

Text is an `m.text` event. Each attachment is an `m.file` with exact filename, MIME, size and uploaded `mxc` identifier. Images/audio/video are sent as files; rich rendering, transcoding, thumbnails, encrypted attachments and remote-network media parity are not certified. Text plus several files is several events: **not atomic as a bundle**. The exact approved envelope authorizes the full ordered set, but partial delivery is possible.

Approval/counter consumption/queue intent commit **before** network dispatch. Each upload's returned `mxc` URI commits before its message PUT. Each event uses a deterministic transaction ID derived from draft ID, exact envelope hash and part index. Returned event IDs persist per part. Socket loss/crash after remote acceptance retries the same PUT/body/URI/transaction ID, not a new send. Upload POST itself is not idempotent: a crash before saving its URI may leave an orphan upload, but no message has yet used that lost URI. No exactly-once remote-network claim is made: deduplication relies on the Matrix server's transaction semantics, unchanged access-token scope and retained server history. Do not restore old live DB snapshots or rotate tokens while ambiguous jobs remain without owner-local reconciliation.

On failure or crash the draft remains `matrix-queued`; consumed approval is not rolled back. Poll status; **do not create a new request ID**. Owner reviews the same queued draft and makes a fresh UV approval to resume; already recorded parts are skipped, ambiguous parts reuse the stable transaction. There is no background retry webhook/unauthenticated dispatch route. Policy epoch is checked under the SQLite write lock before each operation. Remote operations hold that lock with a bounded socket timeout, trading throughput for serialization. Disk/storage failure can require manual owner-local reconciliation.

`matrix-delivered` and returned event IDs mean **Matrix accepted events**, not successful bridge forwarding, remote-network receipt or recipient reading. Protocol fixtures cannot prove Telegram/WhatsApp/Signal/Slack parity.

Connector-lane inspection found owner mutations for provisioning start/step/cancel/logout. Those actions intentionally remain **unsupported here**: their arbitrary base/path/token writer contract must never be plugged directly into this adapter. Independently administered account pairing/setup and a separately designed narrow owner-authorized provisioning contract remain integration work.

## Independent owner-host runbook (not executed here)

1. Provision an independently administered host and independently controlled homeserver/bridges as above. Revoke all alternate Wizard sending sessions/routes before claiming strong mode. Confirm Matrix transaction deduplication/retention and unencrypted room behavior for the actual server/version.
2. Use Python 3.14 (locally exercised). Transfer/review only `isolated_sender/` privately, not the whole private repository. Create an unprivileged service user, root-owned source `/opt/isolated-sender/isolated_sender/`, root/service-readable `/etc/isolated-sender/`, and service-owned 0700 `/var/lib/isolated-sender/`. No Wizard administration or shared mount. Install pinned `requirements.txt` into `/opt/isolated-sender/.venv`; review dependency updates before exposure.
3. Start with `deploy/owner-config.example.json` for the test ledger. For Matrix use `deploy/owner-config.matrix.example.json`: replace every placeholder, exact independent HTTPS origin/RP, database path, draft-key digest, account/room IDs, and owner-local **0600 regular** token file. Never copy a real token/config/database to Wizard. Set `independently_administered=true` only after owner review. Leave Full access false. Matrix startup validates public DNS and token-file privacy but makes no provider authentication request until dispatch.
4. Generate a random draft key (at least 32 random bytes) independently; configure its SHA-256 and transfer only the narrow raw key to a 0600 Wizard file. The token hash in a draft is safe only for high-entropy provider tokens, never passwords.
5. Provision browser-trusted TLS on the dedicated independent origin; install chain/key service-readable at `/etc/isolated-sender/tls/{fullchain.pem,privkey.pem}`. TLS terminates directly in this service; no forwarded-proto trust, custom CA, certificate warning or verify=False in production. Renew via independent administration and restart.
6. From `/opt/isolated-sender`, at the independent owner console:
   ```sh
   .venv/bin/python -m isolated_sender.service check --config /etc/isolated-sender/config.json
   sudo -u isolated-sender .venv/bin/python -m isolated_sender.service init-owner --config /etc/isolated-sender/config.json
   ```
   Second command prints the bootstrap token to that console only. Before enrollment, running again replaces the token; after enrollment it refuses. Keep initial firewall closed until enrollment.
7. Review/install `deploy/isolated-sender.service` there (template only, not an installer). It uses direct TLS on 443, `CAP_NET_BIND_SERVICE`, read-only source and writable state only. Manual invocation:
   ```sh
   .venv/bin/python -m isolated_sender.service serve --config /etc/isolated-sender/config.json \
     --host 0.0.0.0 --port 443 \
     --tls-cert /etc/isolated-sender/tls/fullchain.pem --tls-key /etc/isolated-sender/tls/privkey.pem
   ```
8. Bookmark/verify the independent origin in an owner-controlled browser, enroll the verifying passkey and login. Exercise test-ledger first. A Matrix acceptance test requires separate explicit owner authorization; verify actual homeserver events and bridge/remote-network receipt separately. No such test happened here.
9. Before public exposure add independent firewall/rate limits, global storage/challenge/draft quotas, request deadlines, encrypted backups and monitoring. Existing per-request size limits are not global abuse protection. DB holds sensitive drafts/media/session hashes/public owner keys. Accurate clock required. Access logging is disabled; do not add token/body logs. Recovery must stop the service and reconcile prior outcomes, not restore stale anti-replay history blindly.

## Wizard client/integration

`deploy/wizard-client.disabled.json` remains disabled; preflight fails before network. The unchanged disabled drop-in template must not be treated as deployment. `wizard_client.py` accepts only exact independent HTTPS authority health for `test-ledger` or `matrix`, never redirects/proxies or local send fallback. Only draft key belongs in its config. A hostile Wizard root can bypass its own client guard; security depends on absence of local provider authority plus independent sender authentication.

Submit via stdin:
```sh
python -m isolated_sender.wizard_client submit-draft --config /etc/messenger/isolated-sender-client.json < exact-draft.json
```
Example shape (use a configured room for Matrix):
```json
{"request_id":"durable-unique-request-0001","account":"owner-telegram","recipient":"!configured-room:matrix.example.net","body":"exact text\n","attachments":[{"name":"note.txt","media_type":"text/plain","data_base64":"YQ=="}]}
```
Finish accepts only challenge ID plus credential, never substituted message fields. Link owner to bookmarked independent UI, not a Wizard approval iframe. Main-core/connector integration and removal of send-capable credentials are outside this lane. Optional read-only facade is deliberately not wired.

## Verification and remaining gates

Run from repository root, with TMPDIR in authorized scratch:
```sh
/path/to/sender-venv/bin/python -m pytest isolated_sender/tests -q
node --check isolated_sender/owner.js
/path/to/sender-venv/bin/pip check
```
`requirements-ui.txt` enables the Chromium/CDP virtual-passkey test (default `/usr/bin/google-chrome`, override `ISOLATED_SENDER_CHROME`). Existing real WebAuthn, concurrent authority, test-ledger rollback, deployment TLS subprocess and UI fixtures are preserved. Matrix tests use real loopback HTTPS sockets with a temporary test certificate, fake-Matrix server and test-only transport/DNS injection. Production exposes **no test CA/private-IP switch**. These are protocol fixtures, not live Matrix/bridge/network proof.

Remaining production blockers: genuinely independent owner host/browser/admin/DNS/TLS **and homeserver/bridges**; removal/revocation of every Wizard send-capable session; independent account/known-room provisioning; safe main-core/read-facade integration; quotas/exposure hardening; owner-attended real-server transaction/response-loss acceptance and per-network bridge/text/media verification. E2EE, connector provisioning and rich-media parity are unsupported, not silently stubbed.

Duo Labs `webauthn` (BSD-3-Clause) handles cryptography; FastAPI/Starlette/httpx/uvicorn and other pinned packages retain their own licenses. Matrix transport uses Python stdlib TLS/HTTP. No private repository source was uploaded or vendored crypto introduced. Starlette's TestClient/httpx deprecation warning concerns test tooling, not a live-provider certification.
