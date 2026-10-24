# Multi-network connector handoff (offline candidate)

This branch adds real adapters for maintained upstream Matrix bridges. It does
**not** connect any personal account, deploy a service, or prove message parity.
The default running application is unchanged until the integration patches below
are applied. Existing `web.py`, `unified.py`, `static/unified.js` are untouched.

## What is implemented

| Network | Adapter | Login implemented | Current gate |
| --- | --- | --- | --- |
| Telegram | Existing mautrix bridge preserved; generic bridgev2 adapter added | QR / phone, step / cancel / disconnect | Existing account remains untouched; opt-in inbox requires owner bootstrap/sender |
| WhatsApp | Official-maintained mautrix/whatsapp bridgev2 v0.2610.0 | Linked-device QR or phone pairing code | Owner's mobile WhatsApp account, prepared private Matrix, authorized sender |
| Signal | Official-maintained mautrix/signal bridgev2 v0.2610.0 | Linked-device QR | Owner's mobile Signal account, prepared private Matrix, authorized sender |
| Slack | Official-maintained mautrix/slack bridgev2 v0.2610.0 | **Slack app** flow, bot token + app token | Workspace app/scopes/approval; this is bot identity, **not personal Slack parity** |
| LINE | None selected | None | Unsupported; no fake switch |
| KakaoTalk | None selected | None | Unsupported; no fake switch |

“Official-maintained” means the bridge's upstream project, not an endorsement by
WhatsApp, Signal or Slack. WhatsApp is a linked-device bridge, **not a native
mobile WhatsApp app running on this Linux server**. No new protocol implementation
or third-party model was used.

`ConnectorInbox` extends the existing private Matrix/PeopleStore pipeline to all
four supported network IDs. It reuses text/media, replies, reactions, edits,
redactions, receipts and typing algorithms, but network-specific acceptance,
history completeness, native-device self echoes and delivery must be verified
with the owner later. “sent” remains the existing UI's Matrix acceptance marker,
**not proof the remote service delivered anything**. Supported capabilities are
not advertised as live-verified (`live_parity_verified: false`).

## Parent integration — apply together, then supply the sender

1. Cherry-pick this commit. `Dockerfile` already includes the new modules and
   generated templates; no sustained build was run here.
2. Apply `plumbing/connectors-web-integration.patch` to select `ConnectorInbox`
   and `ConnectorViewHandler` when `CONNECTORS_ENABLED=1`, and serve the JS asset.
   The patch deliberately injects **`sender=None`**, so it cannot silently start
   sending. Replace that injection with the owner-boundary lane's authorized
   sender callback, not `unified.http`.
3. Apply `plumbing/connectors-view-integration.patch`: load `connectors.js`, mount
   the owner-only settings controller, cancel on overlay close, and enable existing
   media/reaction controls for supported Matrix networks. The adapter wraps the
   existing `api(path, {method, body})` correctly and uses no unsafe HTML insertion.
   Both patch files pass `git apply --check` on baseline 490abc8; reconcile manually
   with sibling lanes rather than overwriting their files. Treat both patches,
   the opt-in environment, and overlay as a single integration change.
4. Merge `runtipi/connectors.compose.yml` with the existing Compose. It adds an
   offline init after `unified-init`, before Synapse, three pinned optional bridge
   services, private Matrix network access and separate bridge egress. **No host
   port is published for these bridges.** The base Telegram service is unchanged.
5. Keep `MESSENGER_CONNECTORS` empty for dormant validation. Later, explicit
   comma-separated `whatsapp,signal` (optionally `slack`) enables only those
   registrations/configured markers. Optional containers require the Compose
   `connectors` profile. Recreate Synapse after registration changes. Do not run
   production Compose as part of this handoff.
6. Initialize the owner Matrix account on the owner-controlled sender. The opt-in
   inbox does not silently register/login during GETs: an existing provisioned
   Matrix read token is required (`owner_bootstrap_required` otherwise). Baseline
   `matrix_token` is an unrestricted credential, **not a read-only capability**;
   the isolated-sender lane must supply a genuinely restricted read facade in
   strong mode, not merely rename the token or move it between local files.

### Writer callback contract and security limits

`sender(**kwargs)` receives `network`, `base`, `path`, `method`, `body`, `token`,
`timeout`; binary media upload also supplies `content_type`. Responses must be
decoded upstream JSON. All Matrix mutations (including upload, invite join,
read receipt and typing) and all provisioning mutations use this callback.
There is no default writer. No configured credentials means no provisioning I/O.

This is a transport hook, **not** an approval policy or isolation implementation.
The parent sender must authenticate the actor, authorize exact intent/destination,
bind owner approval, constrain upstream routes, validate any supplied URL against
its own registry and use its own secret storage. Do not forward arbitrary `base`,
`path`, `token` blindly. In strong mode the agent must not possess full Matrix,
bridge, double-puppet or account credentials at all. The convenience Compose
keeps credentials and history on the same host; **agent root can read them**.
It is not root-resistant and must not be described as such. Separate trust-domain
network controls/credentials must be implemented by the owner-isolation lane.
Marmot engine write isolation remains that lane's responsibility.

`ConnectorViewHandler` must be installed with `ConnectorInbox`; it forbids all
connector account admin and legacy Telegram admin routes without an owner cookie,
even when the machine agent grant is enabled. Existing Origin/CSRF checks still
run. General status never returns a pending provisioning QR. Status/QR responses
are no-store; submitted values and QR data are not persisted by the adapter.
Only pending login IDs, step IDs, transaction IDs and expiry are held in memory.
Unsupported upstream step types (e.g. WhatsApp passkey challenges) fail explicitly
instead of improvising a credential-extraction workflow.

## Provenance and evaluated alternatives

- `plumbing/connectors-provenance.json` records immutable official registry
  multi-architecture digest, amd64/arm64 manifests, release-binary SHA-256 and
  generated-template SHA-256. Registry manifest bytes were hashed and compared
  with Docker-Content-Digest. Public bearer registry challenges were resolved
  without user credentials. No images were built/pulled/run.
- All three official release binaries were downloaded to scratch only and checked
  against upstream release `sha256sums.txt`; `--version-json`, `-e`, and `-g` were
  actually run. `-e` produced the checked-in templates. `-g` parsed generated
  installation config and exited 0 for each bridge; it **regenerates tokens**, so
  it is a parser proof, not byte-identical registration evidence. Never run `-g`
  against a live configuration expecting credentials to remain unchanged.
- API/login contract verified against mautrix/go **v0.32.0**, used by these releases:
  `bridgev2/login.go`, `bridgev2/matrix/provisioning.go` and `provisioninglogin.go`;
  network flow IDs verified in each release's `pkg/connector/login*.go`.
- Upstream `origin/feature/signal-mvp` and `origin/feature/signal-ux` were inspected
  read-only. They provide Telegram/Signal-style UX work, not an actual Signal
  account connector. They were not merged over the newer baseline.
- LINE: `etnperlong/matrix-puppeteer-line` and `budyaya/matrix-puppeteer-line`
  depend on an old Chrome-extension/Puppeteer approach; their repository last-push
  metadata was 2022/2024. No maintained, compatible bridgev2 path was established.
  LINE Messaging API business bots are not the owner's personal LINE inbox.
- KakaoTalk: `sooids/mautrix-kakaotalk` exists (last-push metadata April 2026), but
  explicitly warns it is unofficial/educational, needs macOS desktop credential
  extraction and has degraded fallback when LOCO writes are unavailable. This
  does not meet the maintained, verified integration bar; not vendored/enabled.
- Slack's upstream email and browser token/cookie flows exist but are deliberately
  not exposed. The documented app flow is reusable without pretending it acts as
  the user's own Slack account. Workspace policy/scopes still require the owner.

## Verification and remaining gates

Commands exercised locally, without accounts or production changes:

```sh
python -m unittest discover -s tests -p 'test_*.py' -q
python -m py_compile connectors.py connector_setup.py connector_inbox.py connector_web.py
node --check static/connectors.js
node tests/test_connectors_view.cjs
python tools/verify_connectors.py --binary-dir <scratch-official-binaries>
APP_DATA_DIR=<scratch> APP_PORT=18799 MESSENGER_API_TOKEN=<dummy> \
  docker compose -f runtipi/docker-compose.yml -f runtipi/connectors.compose.yml \
  --profile connectors config --quiet
wam check .
git apply --check plumbing/connectors-web-integration.patch
git apply --check plumbing/connectors-view-integration.patch
```

Latest local result: **115 Python tests passed**, including 19 connector/HTTP
contracts; JS controller harness, Python compile, Compose merge validation,
approved `wam check` and both integration patch applicability checks passed.
The inherited malformed-HTTP tests emit BrokenPipeError traces and inherited
SQLite ResourceWarnings under Python 3.14; the suite still exits successfully.

Tests cover provider defaults/missing credentials, unknown/unsupported networks,
unique stable secrets and Telegram config preservation, metadata classification,
four-network sync/send contracts, upload through the sender, denied writes absent
a sender, strict login step/expiry/transaction matching, no-secret status, remote
connection versus stale login distinction, generic UI QR/continue/close behavior,
and **real loopback HTTP** unauthenticated health + owner cookie/CSRF boundaries.
The UI test is a DOM harness, not visual browser certification. Official bridge
liveness on a real Synapse deployment is not exercised; the loopback health proof
is Messenger's HTTP server with dormant connectors. Account authentication,
remote send/receive/media/history/delivery, workspace permissions, UI browser QA
and final isolated-sender integration remain explicit owner/integration gates.
