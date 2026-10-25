# Beeper migration readiness

**Keep Beeper. Local tests are not provider parity or an installed release.**
No real accounts, provider credentials, messages, deployment, PR or push were used.
The original inspected baseline was `490abc8`; this implementation follows
`8ce564d` and the permissions schema from `dc2672872599644acc42934e7f2c242c300b89dc`.

## Run executable acceptance checks

From repository root, Python 3 with SQLite FTS5 and Node.js:

```sh
python3 -m unittest discover -s readiness/tests -v
python3 -m unittest discover -s tests -v
node --test tests/test*.cjs
python3 -m readiness.check --output "$HOME/.hermes/cache/scratch/messenger-proof-new"
python3 -m readiness.check --require-migration-ready --output "$HOME/.hermes/cache/scratch/messenger-gate-new"
```

Output must not already exist. Reports contain source revision, exercised file
SHA-256 hashes, actual commands, status and logs. `manifest.json` is an inventory,
not an attestation. Only narrowly tested components can be promoted to `proven`;
networks remain unverified. Exit 0 means local tests passed, 1 local failure,
2 invalid configuration/output, 3 migration gate closed. No CLI flag or hand-written
status can open the owner/provider campaign gate.

The former expected-failing timestamp-tie regression is now an ordinary passing
requirement. `test_history_search.py` exercises production SQLite and real loopback
HTTP handlers. Its Node subprocess executes the shipping JS with synthetic API/DOM
contracts: this is **not rendered-browser, phone or provider evidence**.

## Implemented history and search

- `PeopleStore.messages` pages in `(timestamp,id)` order. The server returns an
  opaque, person-bound `next_cursor`; JS sends `cursor`, never just the timestamp.
  Legacy `before=timestamp` remains an explicit cutoff, not lossless paging.
- `SearchStore` shares the unified database connection and lock. SQL triggers mirror
  inserts, edits, translations, media upgrades, deletes and redactions atomically;
  no after-commit best-effort hook or checkpoint-only feed is used.
- Startup reconciliation removes orphaned/wrong-scope/deleted mirror rows, upserts
  authoritative live history, and rebuilds FTS. Existing rowids survive reconciliation
  and edits. History itself is not rewritten. The index is plaintext like history.
- Each data-directory database belongs to one installation owner. Account scope is
  the server-owned constant `owner`; network and immutable identity id define a
  thread, independently of person merges/unmerges. Account cannot be supplied by HTTP.
- `GET /api/unified/search?q=...&network=...&thread=...&limit=50&cursor=...`
  goes through the existing authenticated unified dispatcher in `web.py` (no new
  listener or auth bypass). `thread` means identity id. Unknown/duplicate parameters
  are rejected; network/thread mismatch fails closed. Machine-agent search remains
  denied by the current permissions allowlist; parent owns any explicit policy change.
- Search in the Chats/Groups header queries **all stored message text**, including
  originals and translations, with paged results, literal DOM text and stale-query
  suppression. A result opens its person and pages stored history to the message.
  Search state is erased on signout. Directory search remains name-only.
- Search queries are literal AND-word tokens, not SQL/FTS grammar. Bounds: 512 query
  characters, 32 words, 1–100 results. Search cursors bind account/network/thread/query
  and order by `(timestamp,rowid)`. Cursors are positions, not authorization. Concurrent
  content changes may alter results; no snapshot guarantee is made.

No attachment-content indexing, OCR, transcription, semantic/substring search,
guaranteed CJK segmentation, or search of unimported remote history is claimed.

## Remaining gates

| Feature | Local implementation/evidence | Remaining gap |
|---|---|---|
| Photos/voice | Upload/media proxy, Matrix metadata, recorder/player; existing tests | Real provider send/receive, phone playback/codecs |
| Replies/reactions | Ingestion, reply target checks, edit/redaction UI | Per-network real-account tests |
| History | Durable SQLite, limited-sync warnings, fixed stored-history paging | Initial Telegram import 50 chats × 50 messages; backward backfill disabled; media revisit ≤3×100 |
| Search | Unified FTS/API/UI and local SQL/HTTP/JS tests | Rendered browser, real accounts and required remote-history coverage |
| Reconnect | Local HTTP outage/restart/replay tests | Provider login expiry and real network restart |
| Notifications | Local unread/change-feed | No background phone push/OS proof |

Only Telegram is bridged at this branch baseline. Signal MVP means Signal-style UI,
not a Signal connector. WhatsApp, Signal, LINE, Kakao and Slack remain unsupported
here; parent connector work is separate, not local proof of support.

Optional disposable liveness probes accept only declared loopback HTTP listeners:

```json
[{"id":"local-health","base_url":"http://127.0.0.1:18800","kind":"health","disposable":true}]
```

```sh
python3 -m readiness.check --endpoints /owned/config.json --output /owned/new-proof-directory
```

Only literal loopback IPs, explicit ports, GET-only exact `health`/`matrix_versions`
probes, no redirects/proxy/auth/cookies, a 3-second socket timeout and 64 KiB cap.
Use only listeners created for the test. Liveness cannot prove provider support.

The owner must privately unlock and voluntarily connect each supported network,
then test text/media both ways, actual playback, replies/reactions, required history
and search, login expiry/restart recovery, and alerts with browser closed/phone
locked. Record privacy-safe outcomes against exact source versions. Keep Beeper
through parallel daily use and explicit acceptance. Local fixtures cannot certify
host-root isolation or independent draft-sender security.
