# Optional Messenger push integration (local staging only)

Default: **off**. With `MESSENGER_PUSH_ENABLED` unset or `0`, core does not import
push_notifications, pywebpush or cryptography, create push storage, register a
service worker or start a push worker. Existing baseline images need no new deps.

Build optional dependencies with Docker build arg `MESSENGER_BUILD_PUSH=1`.
Pinned dependencies are in `push_notifications/requirements.txt`; optional venv is
`/opt/push`. The default image only copies the dormant package.

Operator-provided environment (no values or keys provisioned by this change):

- `UNIFIED_ENABLED=1`
- `MESSENGER_PUSH_ENABLED=1`
- `MESSENGER_PUSH_PUBLIC_KEY`: browser-safe base64url VAPID public key
- `MESSENGER_PUSH_PRIVATE_KEY`: push-only VAPID private key or protected PEM path
- `MESSENGER_PUSH_SUBJECT`: operator mailto contact
- `MESSENGER_PUSH_HOSTS`: comma-separated exact trusted push-service hostnames
- `MESSENGER_PUBLIC_PATH`: existing trusted gateway mount, ending in `/`

No automatic host allowlist, key generation, subscriptions, test-send endpoint,
network migration or production deployment. Missing explicit configuration fails
enabled startup; disabled startup never requires these values.

## Runtime contract

Settings mounts notification controls alongside existing account/agent controls.
Enable is an explicit owner gesture, requests browser permission, refuses a
conflicting service worker, subscribes userVisibleOnly and posts the capability
through existing cookie + Origin + CSRF handling. Disable revokes server authority
before browser unsubscribe, with failures shown honestly. After page reload, use
Enable to explicitly renew/re-associate the existing browser subscription before
Disable; no subscription intent is silently renewed on page open.

`GET /api/view/push` returns disabled state or public-key/path configuration.
`POST /api/view/push/subscribe` and `/unsubscribe` are owner-only JSON mutations,
8 KiB capped. Machine bearer credentials are denied even with Full access. Setup
cookies cannot configure notifications. No endpoint accepts owner ID or enqueue.

`/push-service-worker.js` is public JavaScript (no private contents), no-store,
nosniff, and `Service-Worker-Allowed` is the exact configured app path. The gateway
must strip its app prefix just as for the existing API/assets, preserve these
headers and allow the script through without a login-HTML redirect. The generated
constant click destination is that same app mount. Notification data never
controls targets, text, icons or external URLs. There is no fetch/cache handler.
Root `/` is used only if explicitly running Messenger at its existing root mount,
not to broaden a nested app's scope.

Both Matrix receive loops pass `live=bool(since)` only for incremental sync;
initial history, manual/backfill reads, reactions, edits, redactions, media upgrades
and authoritative self echoes do not enqueue. New non-self inserts create a
body-free durable push intent inside the inbox message transaction. The Marmot
mirror first establishes a durable per-identity timestamp baseline, then only new
insertions at/after its watermark with explicit `direction=received` qualify.
Older history and unknown directions are suppressed. Bounded Marmot polling and
upstream sync gaps cannot guarantee retrieval of every upstream message.

A supervised local thread reconciles intents to subscription-specific outbox rows,
then acknowledges intents. Crash between stores replays safely via unique message
IDs. Subscription creation timestamps prevent new opt-ins receiving an old
unreconciled backlog; original enqueue time caps delivery TTL at 24h. No active
owner subscription means no transport call. Worker starts only when explicitly
configured and stops with ViewServer before inbox shutdown. Failures retry with
fixed sanitized categories and no capability-bearing logs. Existing lease/attempt/
expiry/revocation rules apply. Remote acceptance is at-least-once; SW tags collapse
replays, not proof of device receipt. Retain durable intent/outbox tombstones until
a bounded replay/retention policy exists.

## Local evidence and gates

- Real loopback HTTP: cookie/Origin/CSRF, Full-access machine denial, invalid
  subscriptions, subscription/revocation readback, generated SW headers/scope.
- Runtime receive fixtures: both shipping sync loops, initial vs live, self, edit,
  replay, media upgrade; durable crash-after-enqueue reconciliation; Marmot mirror.
- Configured ViewServer lifecycle and fresh-process dormant import proof with
  optional imports blocked; fake transport proves no subscriptions means no send.
- Synthetic DOM exercises gesture-only permission, enable/disable, incomplete
  revoke, conflicting worker, dormant UI and sibling preservation. This is not a
  physical-device browser test.
- Existing transport fixtures cover pywebpush encryption/request contract,
  DNS-pinned HTTPS, retry/revoke handling and no live endpoint use.

Real secure-origin gateway registration and owner-approved physical-device
receipt remain release gates (including supported iOS Home Screen setup). No real
push endpoints, owner credentials, production data or actual notifications used.
Full Docker/Rust image build was not run in this lane; parent owns combined
packaging and final integration verification. Beeper remains untouched. This does
not establish independent-admin/root-proof isolation.
