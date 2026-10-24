# Beeper migration readiness foundations

**Keep Beeper. This is not network parity or an installed release.** Baseline: `490abc8`
(`0.2.0-unified.10`). Only `readiness/` is changed by this lane. No accounts,
provider endpoints, translation models, credentials, real messages, deployment,
PR, or push are used.

## Run executable acceptance checks

From repository root, Python 3 with SQLite FTS5 (no third-party dependencies):

```sh
python3 -m unittest discover -s readiness/tests -v
python3 -m readiness.check --output "$HOME/.hermes/cache/scratch/messenger-proof-new"
python3 -m readiness.check --require-migration-ready --output "$HOME/.hermes/cache/scratch/messenger-gate-new"
```

Output directory must not already exist. `report.json` includes source revision,
SHA-256 of exercised source/test files, command, exit status, elapsed time, and
hashed test logs. Static `manifest.json` is an inspected capability inventory,
not an attestation. Generated reports promote only narrowly tested **components**,
never networks. Exit 0 = local tests passed; 1 = local failure; 2 = invalid
configuration/output; 3 = migration gate closed. The gate is deliberately closed
until the owner/provider campaign is implemented and verified; it cannot be
opened with a CLI flag or a hand-written "proven" entry.

The suite visibly retains one **expected failure**: existing timestamp-only
unified history pagination loses rows sharing the page boundary timestamp. A
successful overall local run does not erase this migration blocker. Once core
is fixed, remove `expectedFailure` and adjust this spec to the new composite
cursor. An unexpected success fails unittest, forcing inventory review.

Optional disposable endpoint liveness probes accept a JSON list:

```json
[
  {"id":"disposable-matrix","base_url":"http://127.0.0.1:18799","kind":"matrix_versions","disposable":true},
  {"id":"disposable-health","base_url":"http://127.0.0.1:18800","kind":"health","disposable":true}
]
```

```sh
python3 -m readiness.check --endpoints /owned/config.json --output /owned/new-proof-directory
```

Only literal `127.0.0.1`/`[::1]`, HTTP, explicit ports, and exact probe kinds are
accepted. Point these **only at processes you created for this disposable test**;
the declaration is a scope contract, not proof the listener is disposable.
All targets are validated before any probe is run. Requests are GET-only,
proxy-free, no redirects/auth/cookies, 3-second socket timeout, 64 KiB response
cap. Matrix requires nonempty recognizable `versions`; health requires JSON
`ok: true`. Raw endpoint bodies are never saved, only status, bytes and hash.
A healthy Matrix endpoint proves neither Telegram login nor feature support.
Without endpoint config, no external endpoint is probed; tests create their own
short-lived loopback fixtures.

## What inspection actually found

| Feature | Existing implementation / evidence | Remaining gap |
|---|---|---|
| Photos | `UnifiedInbox.upload/media/send`, `message_parts`; existing media tests exercised | Telegram-only transport, no real account/phone send, receive, thumbnail/codec proof |
| Voice notes | Matrix voice metadata, waveform, recorder/playback in `static/unified.js`; ingestion/proxy tests | Baseline recorder uses browser MediaRecorder; later voice branch fixes Ogg/shared capture/music behavior; mobile/provider not proven |
| Replies/reactions | Ingest, reply-target check, reaction replacement/redaction and UI; selected existing tests run | Telegram only; no cross-provider verification |
| History | SQLite durable mirror, limited-sync warning, local older paging, recent bridge import | Import only 50 chats × 50 messages; backward backfill off; media revisit ≤3×100 events; **timestamp tie pagination loses messages** |
| Search | `static/unified.js` list/directory/name filtering only; no message-content API or FTS | New standalone FTS module supplied here; no UI/API integration yet |
| Notifications | Local unread badges, change-feed/UI refresh | No background phone push/OS notification implementation found in baseline; unread badge branch is not push |
| Reconnect | Background sync retries after failures and stores cursor; browser change-feed retries | New real local HTTP outage/restart/replay tests pass; expired provider login, network outage recovery and daily use remain owner tests |

`SignalMvpTests`, `feature/signal-mvp`, and “Signal UX” refer to a **Signal-style
interface**, not a Signal account connector. WhatsApp, Signal, LINE, Kakao and
Slack are unsupported at this baseline; do not reinterpret later connector
scaffolding as functional support. `UNIFIED-INBOX.md` has historical “text only”
statements superseded by current source—this inventory follows executable source.

Baseline regression commands passed locally: Python suite (96 tests) and Node
view suite (51 tests). Python baseline emits pre-existing SQLite resource warnings
and occasional harmless fixture BrokenPipe tracebacks on this Python runtime.
The new outage test also exposes production `http()` not explicitly closing an
HTTPError body. These are recorded, not silently represented as warning-free.

## Standalone message search: smallest parent integration

`readiness.search.SearchStore` is a persistent SQLite FTS5 mirror, not an HTTP
server and not a provider client. It does not touch the existing app DB/schema.

```python
from readiness.search import SearchStore
index = SearchStore('/owned-data/unified/search.sqlite3')
index.upsert(account='installation-owner', network=identity['network'],
             thread=identity['id'], message_id=message['id'],
             timestamp=message['timestamp'], original=message['original'],
             translated=message.get('translated') or '', deleted=bool(message['deleted']))
page = index.search(account='installation-owner', thread=identity['id'],
                    network=identity['network'], query='meeting tomorrow', limit=50)
# page: messages, next_cursor, has_more
index.close()
```

Parent's smallest coherent integration:

1. Instantiate one store under owner-protected app data; no new public listener.
   Derive account scope server-side from the authenticated owner, **never payload**.
   Retain existing owner-session / agent-read-grant rules and CSRF on mutations.
2. Feed normalized committed rows after insert, edit, translation, media upgrade
   and redaction. Include outgoing and incoming rows. Tombstone via
   `deleted=True`; `forget_account` on account teardown and scoped `forget_thread`
   on thread removal. Never leave disconnected/redacted content searchable. Index update is a separate DB
   transaction: use a durable outbox or rebuild-on-restart, not a best-effort hook
   that falsely promises atomic sync. No checkpoint-only feed: `seq` is not globally
   unique per row, and disconnect deletes are not represented by `since()` rows.
3. Backfill existing history with bounded read batches into a **new** index,
   then swap after reconciliation under app ownership. Rebuilding only upserts
   does not remove stale/deleted rows. Keep old history DB untouched.
4. Add authenticated `/api/unified/search` with server-derived account, validated
   optional identity/thread scope, `limit <= 100`, and opaque `next_cursor`. Resolve
   allowed merged-person identities on the server; querying a merged person is
   not equivalent to trusting an arbitrary thread id. Render results as text and
   navigate to the correct account/thread; preserve the current UI style.
5. Fix core history pagination independently: descending `(timestamp,id)` tuple,
   both fields on the request, matching SQLite predicate/order and JS `loadOlder`.
   Search already uses `(timestamp,rowid)` so equal timestamps do not lose matches.

Search queries are literal AND-word tokens, not SQL or raw FTS grammar. Both
original and translated text are indexed; account is mandatory, network/thread
optional. Bounds: 512-character query, 32 words, 1–100 results/page, 512-character
cursor. Cursors are bound to account/network/thread/query and are pagination
positions, **not auth tokens**; WHERE isolation remains mandatory even if a cursor
is modified. Ordering is newest-first, not relevance. Edits during pagination can
change results (no snapshot promise). Plaintext stored history/index, no semantic
search, stemming, OCR, transcription, attachment-content indexing, or guaranteed
substring/CJK segmentation. Never call search support equivalent to full Beeper
search until integrated and owner tested.

## Read-only branch reuse inventory

Local refs inspected without fetch/reset/cherry-pick; tips may advance in other
lanes. Pin exact inspected commits before selecting. No branch was changed.

- `origin/fix/voice-notes` **9d4c919**: based after baseline; inspect commits
  `d9b517c` (Ogg/Web Audio), `c14ecad` (shared capture/AAC→Ogg), `c75f7cc`
  (PRF/ducking), `9d4c919` (WizardApp vault). Reusable tests:
  `tests/voice_browser.cjs`, `prf_browser.cjs`, `phone_vault_browser.cjs`.
  These sources/tests exist but were **not rerun against real phones** here.
- `origin/fix/telegram-formatting-v2` **60d3705** includes the above voice/vault
  work plus formatting in `unified.py`, `static/unified.js/.css` and
  `tests/formatting_browser.cjs`. Prefer reviewing this lineage over separately
  applying overlapping formatting v1 and voice patches. Parent owns integration.
- `origin/fix/telegram-formatting` **d7d3983**: earlier formatting-only branch;
  overlapping source, not an additional independent feature to blindly stack.
- `origin/feat/unread-badge` **8f8d1fb** (with `f20582c`): Wizard desk unread badge
  and browser regression. Not background push; inspect compatibility with v2.
- `origin/feature/signal-mvp` **c8a8b8c**, `signal-ux` **1d6590c** and private beta
  **16e245e** are older baseline ancestors; reapplying would regress current source.
- At initial inspection the three parallel local lanes (`agent-permissions`,
  `network-connectors`, `owner-send-boundary`) all pointed at `490abc8`. Their
  future commits are separate parent-owned integration, not evidence in this report.

## Owner campaign still required

After functionality is integrated, the owner must privately complete installation
and each supported network login. For each network test text and media both
ways, actual voice playback, replies, reactions, required old history and search,
logout/login-expiry, host/network restart, duplicate/out-of-order sync and alerts
with the phone locked/browser closed. Record exact app/source version and
privacy-safe outcomes. The optional independently administered draft-only sender
must be tested by its own boundary lane; this checker cannot prove host-root
separation. Keep Beeper through parallel daily use and explicit owner acceptance.
