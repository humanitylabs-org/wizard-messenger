# Five personal-network connectors

This candidate reuses James's Messenger/Matrix inbox and maintained open-source
bridges. It does not pair an owner's accounts or change production. Full remote
send/receive/history parity remains **unverified** until owner pairing. Bridge
HTTP liveness is a separate claim, recorded in `evidence/five-network-real-http.json`.

| Network | Pinned bridge | Owner flow in private Messenger Settings |
| --- | --- | --- |
| Slack personal | mautrix/slack v0.2610.0 | `email`: email → emailed code → workspace → MFA if required. Not bot/app tokens. |
| Telegram | Existing pinned mautrix/telegram service | QR or phone; requires operator-supplied Telegram API ID/hash before running. |
| WhatsApp | mautrix/whatsapp v0.2610.0 | Linked-device QR or phone pairing. |
| LINE | beeper/line `72c7a51a44f344966b916bd2f42a734381061186` (MIT) | QR (`network.qr_login: true`) or email/password + phone confirmation. |
| Instagram DMs | mautrix/meta Instagram binary v0.2610.0 | `android` native login or `instagram-password` web password flow; upstream MFA/challenge steps. |

Signal remains available as an additional opt-in bridge. KakaoTalk remains
unsupported; this does **not** imply LINE is unavailable. Previous conclusions
that no maintained LINE bridge existed were wrong. beeper/line is public and
supports private Synapse. `bbctl` is Beeper-server-only and is **not used** here.

## Exact artifacts and account gates

- `plumbing/connectors-provenance.json` pins registry multi-architecture manifests,
  generated template hashes, source revisions/dependencies and local LINE build
  provenance. Upstream-maintained does not mean network-vendor-endorsed.
- Instagram's actual registry image is **`dock.mau.dev/mautrix/meta:ig-v0.2610.0`**,
  pinned to `sha256:a65249320ab4fba15587b77b9aa7d4024e4ff3e68ade1077da6000a899abbf26`.
  Its executable is **`/usr/bin/mautrix-meta`**, despite being the Instagram build.
  `dock.mau.dev/mautrix/instagram:v0.2610.0` does not exist.
- LINE release **1.2.0 has no binary assets and lacks the current QR adapter**.
  The pinned newer main commit adds QR and self-hosting fixes. Its CI registry
  is secret; no public prebuilt image was verified. The optional service uses a
  locally built `wizard-messenger-line:<source-commit>` image, not an invented
  upstream image. `tools/build_line_connector.py` downloads and checks the pinned
  source archive, then builds `plumbing/line.Dockerfile` (Go, not Rust). Use a build
  worker; the first optimized compile of upstream's 5.5 MB generated crypto file
  hit sustained Go compiler GC pressure at both 768/1536 MiB and was cancelled.
  The successful bounded build disables optimization/inlining **only** for the
  `pkg/ltsm` package (`-gcflags=github.com/beeper/line/pkg/ltsm=-N -l`); source
  code is unchanged. Pinning/this compiler flag are recorded in provenance.
  Compose defaults to the tested immutable local image ID. On another host,
  load that image or build/audit a new one and explicitly set
  `MESSENGER_LINE_IMAGE` to its immutable ID; APK repositories are not an archive
  lock, so a later rebuild is not promised byte-identical.
  `--context` reuses an operator-audited already-downloaded source tree.
- LINE permits only one Chrome Extension session: using its Chrome Extension
  invalidates the bridge session. An account email may be required for email
  login. Phone confirmation/Letter Sealing policies remain LINE-controlled.
  Logs are error-only; QR/verification data must never be logged at debug/info.
- Slack email login supports the upstream personal-account flow without browser
  cookie extraction. Workspace SSO/admin policy, CAPTCHA and unsupported embedded
  browser challenges can still block linking. This vanilla web UI deliberately
  rejects `cookies`, `client_http` and `webauthn` steps rather than execute
  upstream JavaScript, scrape cookies, build a generic proxy or bypass policies.
- Instagram provides turnkey username/password flows; no cookie extraction
  instructions are needed. Provider checkpoints, CAPTCHA, suspended accounts,
  SSO/device challenges or rate limits may require action in the official app
  and a retry, or an upstream challenge-capable owner client. Challenge-complete
  login is **not** certified by unauthenticated bridge HTTP tests.
- Enter email/password/OTP only in the authenticated private app UI; text fields
  are masked and cleared after submission. Never send secrets in chat. Selection
  fields render only upstream-provided choices as escaped text. No submitted
  fields/QR data are stored in the adapter's pending state or general status.

## Parent integration (shared files intentionally not edited in this lane)

1. Cherry-pick this commit. Apply `plumbing/connectors-web-integration.patch`
   against baseline f5e4f6b (or reconcile its **two-line sender injection** with the
   integration lane's newer web.py). The baseline already selects ConnectorInbox,
   serves connectors.js and installs the owner-only handler.
2. Normal owner app: set `CONNECTORS_ENABLED=1`, `UNIFIED_ENABLED=1`, and
   **`MESSENGER_CONNECTOR_SENDER_MODE=local-owner`**. The patch constructs
   `LocalOwnerSender(matrix=os.environ.get('MATRIX_URL', 'http://matrix:8008'))`
   and supplies it to `ConnectorInbox(data, engine, sender=sender)`.
   Missing/other sender mode means `None`, failing closed. Parent permission
   runtime must authorize actor/mode **before calling** any inbox mutation.
3. The callback only accepts fixed configured provider origins and an allowlist
   of Matrix message/media/join/receipt/typing and bridge provisioning routes.
   No request-supplied URL/base, arbitrary admin/state endpoint or redirect is
   forwarded. This is **normal same-host owner transport**, NOT root-resistant
   isolation. Parent `remote_required` mode takes precedence and must never use
   this callback. Strong mode needs its independently restricted sender/read
   facade and separate owner authority; same-host unrestricted tokens are not
   read-only capabilities.
4. Every connector bridge is part of the Store recipe `runtipi/docker-compose.yml`
   (public images pinned by digest; LINE and ChatGPT Dots are built from pinned
   upstream commits by `.github/workflows/bridges.yml`). Each bridge waits for its
   `/data/configured` marker, so an unpicked network does no work. Keep
   `MESSENGER_CONNECTORS` empty by default; networks the owner picks in Settings
   are remembered in `unified/connectors.json`.
   Explicit `whatsapp,slack,line,instagram` enables these registrations/configured
   markers. The extra `signal` value is optional. No optional bridge publishes
   host ports. Telegram retains its existing private API configuration contract.
   Recreate Synapse after changing appservice registrations. Do not run this on
   production without the parent's deployment gate.
5. Local normal-mode sender bootstraps only the fixed private Matrix owner when
   the owner starts a connection. An unconfigured read does not bootstrap. The
   external sender default continues to reject bootstrap without a separately
   provisioned read capability. Existing media/inbox routines route all Matrix
   writes (including uploads, joins, receipts and typing) through the callback.
6. Shared network control allowlists in static/unified.js must include `line` and
   `instagram` alongside telegram/whatsapp/slack/signal. Parent owns that shared
   file; the historical `connectors-view-integration.patch` is not current against
   f5e4f6b and must not overwrite permission/UI lane work.

## Runtime state contract

- `not_configured`: dormant, no provisioning I/O.
- `unavailable`: enabled but private bridge could not be reached.
- `disconnected`: real bridge responded, but no remote account login.
- `degraded`: login record exists, but remote state is not CONNECTED.
- `connected`: upstream reports CONNECTED; still not proof of message parity.
- `capabilities.bridge_live` and `account_connected` report those separate facts;
  `writer_configured` reports callback injection, never authorization/isolation.
  `live_parity_verified` stays false. LINE's upstream reaction support is
  receive-only; generic inbox actions do not imply every network accepts them.
  Matrix acceptance is not remote delivery confirmation.

## Room discovery, own messages and history

- Rooms are classified only by an `m.bridge` event whose `protocol.id` is in the
  explicit alias map (`connectors.PROTOCOL_IDS`: `instagramgo` → instagram,
  `github.com/highesttt/matrix-line-messenger` → line, `slackgo` → slack) **and**
  whose sender is that network's bridge bot. Display names never classify.
  Rooms cached by older releases with `network: null` are re-read once
  (`room_meta.v`), and a one-time `/joined_rooms` rescan imports quiet ones.
- First sight of a bridged room imports up to 500 lines the homeserver already
  holds via `/messages` (read-only), always `live=False`. Lines older than
  15 minutes never push; lines older than 720 h never count as unread.
- Owner messages: every bridge config carries the shared-secret double puppet
  (`as_token:` + doublepuppet registration), so phone-sent lines normally arrive
  as `@owner`. As a fallback, `learn_me` reads each connected bridge's
  provisioning `/whoami` (GET only) and treats `@<net>_<EncodeUserLocalpart(id)>`
  as the owner (Slack ids lowercased per `slackid.MakeUserID`), re-marking
  stored rows for that network. API rows with `outgoing` always have
  `sender: "You"`.
- Names: a synced room/peer name replaces a phone number, raw id, generic
  fallback or the owner's own name; an owner rename (`person.name_locked`) is
  never overwritten. DMs are titled by the other participant.

### Backfill per bridge (bridgev2 `backfill.*`, mautrix-go v0.32.0 keys)

Generated on every connector-init run (secrets are reused, never rotated):
`enabled: true`, `max_initial_messages: 100` (Telegram 200), `max_catchup_messages: 500`,
`unread_hours_threshold: 720`, `queue.enabled: false` (the backward queue
requires Beeper batch sending; stock Synapse cannot insert older history).

- WhatsApp: history arrives only in the pairing-time history sync and the
  bridge discards it while backfill is disabled. `history_sync.request_full_sync`
  is now true (~1 year instead of ~3 months). **Existing links must be
  unlinked and re-paired once** to receive history.
- Telegram, Instagram (mautrix/meta), Slack: forward backfill for each new
  portal and catch-up after restarts. Rooms created earlier only gain catch-up.
- LINE (beeper/line 72c7a51): fetches the newest 50 messages per chat at login
  itself; `FetchMessages` is forward-only with no older pagination.

## Verified candidate results

- Real disposable Synapse plus all five required bridge processes (and optional
  Signal): liveness **200**, authenticated provisioning `whoami` **200**, missing
  provisioning token **401**, disconnected/no remote accounts. Real Slack email,
  Instagram Android and LINE email input-descriptor starts and cancels returned
  **200**. Local Matrix owner bootstrap/whoami/empty sync passed.
- `evidence/five-network-real-http.json` contains sanitized service-level proof;
  `evidence/five-network-offline-images.json` contains binary hashes and offline
  upstream config-parser results. Instagram image binary matched its official
  release checksum. All optional configs parsed successfully using real binaries.
- Connector Python tests: **22 passed**. Full tests + push tests under the declared
  dependencies: **192 passed, 277 subtests passed** (one upstream Starlette warning).
  The stock interpreter lacked pytest; the full run used `uv run --no-project
  --with pyyaml --with-requirements isolated_sender/requirements.txt
  --with-requirements push_notifications/requirements.txt python -m pytest -q
  tests push_notifications/tests`. JS private-input/QR/selection/approval/cancel
  tests, merged Compose validation, patch applicability and diff whitespace pass.
- No proof containers/networks remain. No production changes, public push,
  provider account logins or messages were performed. Parent still owns shared
  sender/permission/UI integration, deployment and eventual owner account tests.

## Reproducible checks

```sh
python -m unittest discover -s tests -p 'test_connector*.py' -v
node --test tests/test_connectors_view.cjs
python tools/prove_connector_stack.py
git apply --check plumbing/connectors-web-integration.patch
APP_DATA_DIR=<scratch> APP_PORT=18799 MESSENGER_API_TOKEN=<test-only> MESSENGER_IMAGE=<integrated-image> \
  docker compose -f runtipi/docker-compose.yml config --quiet
```

The stack proof uses only already-present pinned images, a private scratch state
and an **internal/no-egress** disposable Docker network. It starts real Synapse
and bridge processes, checks unauthenticated provisioning rejection, authenticated
`whoami`/advertised flow discovery, local-only login input descriptors + cancel
for Slack/Instagram/LINE, local Matrix owner bootstrap and empty sync. It never
requests a provider QR, submits provider credentials, links accounts or sends
messages. Telegram uses explicitly labelled **non-account syntax fixture API
values** solely to start the disconnected process; this is not a real API-key or
account test. It removes only its own containers/network in a finally block.
No owner contacts, messages or credentials are touched. Its sanitized evidence
must not be described as successful account login or five-network delivery.
