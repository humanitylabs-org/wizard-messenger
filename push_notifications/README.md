# Messenger background Web Push foundation — LOCAL ONLY

Nothing is mounted, scheduled, deployed, subscribed, or sent by importing this
package. No owner accounts or real push endpoints were used. Mobile/background
push is **not proven** until the owner explicitly subscribes and a real received
message produces a notification with the app closed/backgrounded.

## Parent injection contract

Install `-r push_notifications/requirements.txt` in the app image. `Store` requires
its own dedicated private directory under app data (not the shared app-data root):

```python
from push_notifications import Store, EndpointPolicy, OwnerAPI, Worker, PyWebPushTransport

# Operator-owned exact hosts. These are examples, not an automatic DNS suffix rule.
policy = EndpointPolicy({'fcm.googleapis.com', 'updates.push.services.mozilla.com',
                         'web.push.apple.com'})
push = Store('/data/private-push', policy)
api = OwnerAPI(push, authorize_owner_cookie_and_csrf)
# Server-held, push-only VAPID key, never a connector or owner login credential.
transport = PyWebPushTransport(policy, configured_vapid_key, 'mailto:operator@example.com')
worker = Worker(push, transport)
```

`authorize_owner_cookie_and_csrf(request)` is a **required** parent callback. It
must verify the existing owner cookie/session, allowed request origin AND CSRF,
and return the stable configured owner identifier or raise. Never trust an owner
ID from JSON/headers/query. This module cannot authenticate a parent session by
itself. Mount only POST mutations behind that same existing boundary:

* `/push/subscribe`: JSON browser `PushSubscription.toJSON()` →
  `api.handle(request, 'subscribe', body)`. Returns opaque subscription ID + expiry.
* `/push/unsubscribe`: JSON `{ "id": "<returned id>" }` →
  `api.handle(request, 'unsubscribe', body)`. Owner-scoped and idempotent; another
  owner's ID neither discloses nor revokes its subscription.

Parent must enforce JSON request size (recommend 8 KiB), content type, rate limits,
and sanitized mapping of PermissionError (403), InvalidSubscription/ValueError
(400). Never log request/response bodies, subscription capabilities, push key
material, or exception strings. Do not expose a generic webhook/enqueue/send API.
No custom HTTP headers/credentials are accepted from subscriptions.

### UnifiedInbox and connector receive hook

After UnifiedInbox has persisted an incoming event (Matrix `_sync`/timeline and
connector import path), invoke:

```python
push.received(stable_owner_id, stored_message.id,
              outgoing=bool(stored_message.outgoing), live=is_live_incremental_event)
```

Use the authoritative outgoing flag and stable **globally namespaced** message
ID, e.g. `matrix:<event-id>` or `<network>:<account>:<upstream-id>`. Edits,
reactions, receipts, deletes, sent echoes, initial backfill/history, and transient
local drafts are NOT incoming new message events. `live=False` suppresses history
replay; a stable ID deduplicates incremental retries per owner/subscription.
Do not pass message body/sender/thread/name into this package. New subscriptions
only receive future enqueued messages; they do not replay existing outbox rows.

Hook failures must not roll back inbox sync. The stores have separate transactions:
to avoid a crash gap, parent should reconcile a durable receive cursor after sync
using stable event IDs (or implement an application transactional event outbox).
Merely calling the hook in memory is **not** a no-miss integration guarantee.

Run `worker.run_once()` from one local supervised polling loop/timer with idle
backoff; it drains at most one due row and returns false when idle. Never attach
this worker to a public request path. Attempt timeout is 10 seconds, lease 60
seconds, five attempts maximum; exponential delays 30/60/120/240 seconds precede
remaining attempts. 408/425/429/5xx and transport exceptions retry; 404/410 revoke;
other non-2xx (including redirects) permanently fail. Errors stored are fixed
categories only. Default outbox TTL is 24h; subscriptions expire after at most
30 days, capped by the browser's expirationTime. Renew explicitly through owner
subscription flow. Revoke cancels queued work; an already-in-flight push cannot
be recalled. Lease recovery is at-least-once: a crash after service acceptance
can resend, but the stable service-worker tag collapses duplicate notifications.
No claim of exactly-once remote delivery or owner receipt is made.

Retain terminal outbox dedup tombstones for the whole possible upstream replay
window; deleting them permits old events to enqueue again. Storage is plaintext
subscription capability data in a 0700 dedicated directory and 0600 SQLite file,
with rollback journal inherited from the protected DB and directory. Parent
must supply a trusted local path with trusted ancestors and protect backups.
No message bodies are persisted. Bound parent retention/storage monitoring before
unattended release (do not erase dedup tombstones without a cursor/replay policy).

## SSRF and cryptographic boundaries

Subscriptions require HTTPS on port 443, exact operator-allowlisted host, no
userinfo/fragment/control characters, valid P-256 public-key point and 16-byte
auth secret. This validates a cryptographic subscription format, not proof that
a caller owns an arbitrary endpoint token. Only browser-issued capabilities
from the authenticated owner flow should be submitted.

The real pywebpush adapter performs AES128GCM payload encryption and VAPID signing.
The only forwarded authentication is its generated, service-audience-bound VAPID
header. Each fresh TLS connection resolves the allowed hostname, rejects any
non-global IP (including mixed public/private answers), and dials that checked
numeric address while preserving original hostname SNI/certificate verification.
No second hostname DNS lookup between checking and dialing; no redirects, proxy
environment, netrc, cookies, or owner/provider connector tokens. Exact service
host configuration is deployment-owned. No arbitrary suffix wildcard fallback.
No disabling TLS verification. Local tests use injected transports / patched
HTTP boundaries only, never live endpoints.

## Browser and gateway contract (parent wiring still required)

Serve `service-worker.js` as same-origin JavaScript at
`/apps/messenger/service-worker.js`, with registration scope `/apps/messenger/`.
`APP_PATH` is a build-time trusted constant and **must match** the actual app mount.
Do not substitute request query or notification data. A notification click opens
only that constant app URL; it never trusts payload URLs or body text. Existing
window focus is exact origin/path only. No caching/fetch handler is installed.

Gateway must pass the SW route through without login-HTML redirects, set
`Content-Type: application/javascript`, `Cache-Control: no-cache`,
`X-Content-Type-Options: nosniff`, and
`Service-Worker-Allowed: /apps/messenger/` (required if script is served below its
scope; explicit bounded header recommended in either case). Never use `/` merely
to make registration work. Preserve secure HTTPS origin, service-worker CSP
`worker-src 'self'` and applicable script policy. The app must be opened at that
same HTTPS origin; cross-origin embedded views cannot register its SW. Check for
an existing worker in scope first: merge handlers into it rather than silently
replacing an owner worker.

From an explicit owner Enable notifications click: check browser support,
register worker at the above path/scope, request Notification permission, then
`registration.pushManager.subscribe({userVisibleOnly: true,
applicationServerKey: <public VAPID key bytes>})`; POST `.toJSON()` through existing
cookie + CSRF handling and retain returned subscription ID. Disable must revoke
server subscription **and** call browser subscription.unsubscribe(); on server
failure report incomplete disable, do not claim it is revoked. Renewal should
not silently reset owner intent. No keys/accounts are provisioned by this patch.

Notifications contain only `Messenger` / `You have a new message.`; no sender,
message text, conversation names, links, or network names, even if extra fields
are maliciously added to a push payload. Browser-visible dedup tags are hashes.
This is per-message push foundation, not daily summaries/scheduling.

## Local verification

```sh
python -m pip install -r push_notifications/requirements.txt pytest
PYTHONDONTWRITEBYTECODE=1 python -m pytest -q -p no:cacheprovider push_notifications/tests
node push_notifications/tests/test_service_worker.cjs
node --check push_notifications/service-worker.js
git diff --check
```

Remaining release gates: parent cookie/CSRF adapter + receive cursor integration,
explicit VAPID provisioning, gateway SW route/headers and correct mount, owner
opt-in UI/subscription, local supervised worker and storage policy, owner-approved
real notification receipt on each intended mobile platform. iOS requires supported
OS/browser and an installed Home Screen web app; permission/OS notification
settings and background delivery remain device-dependent. No deployment/spend is
authorized by this branch. This worker runs locally; it does not solve the
independent-admin/root-proof isolated message sender gate.
