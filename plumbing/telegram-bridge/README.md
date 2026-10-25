# Telegram photo albums (candidate; not deployed)

REUSE: `WizardApp.share.wizard`, the existing message selection/forward controller, media proxy, upload endpoint, photo preparation and viewer. Existing caption, reply, reaction, delete and send queue remain the owners of those behaviours.
EXTEND: Messenger's `PeopleStore` and unified send/receive adapters, unified message projection and photo bubble; upstream mautrix-telegram's Matrix-message and Telegram-message conversion adapters.
NEW: No parallel shared UI/service capability. `plumbing/telegram-bridge` contains the app-specific upstream adapter patch, its recording-API tests, license and pinned build recipe.

## Contract

- One selected photo still uses `upload_id`, one normal Matrix image event and the existing single-photo viewer. Voice and text sends are unchanged. Single animated GIFs remain animated; a GIF included in a photo album uses its still preview.
- Two to ten selected photos use one `POST people/<id>/send` with `upload_ids: [...]`, one `client_id`, optional caption and optional reply. All uploads must be live, still images owned by the same person. Media sends to Marmot/other currently unsupported networks continue to return `media_unsupported`.
- The server sends **one** Matrix `m.image`. `org.wizard.gallery` is an array of **ALL N images**, including item zero (which matches the outer event's URL). Each element is a Matrix image content object with `msgtype`, `url`, `info`, `filename`, and `body`. Caption exists only on item zero. Old bridges ignore the extension, so the matching patched bridge must accompany this Messenger version.
- The bridge finalizes each uploaded photo with `messages.uploadMedia`, then makes **one** `messages.sendMultiMedia` call. It does not fall back to separate sends. Per-item random IDs are derived from the Matrix event ID and item index, preserving Telegram deduplication on a retry. Replies/forum topics and first-item caption are retained.
- All Telegram messages returned by the multi-send must have one nonzero `grouped_id`, with the expected photo count. Each Telegram ID is recorded; each mapping carries the complete album ID list for album-wide deletion.
- Incoming Telegram parts each retain `fi.mau.telegram.grouped_id` as a decimal **string**, avoiding JavaScript precision loss. Messenger adds `telegram:<id>` to the row's generic `album` field. The rendering layer has no Telegram-specific grouping logic: adjacent rows must share album, sender, identity, network and direction.

## Why one row per photo

The existing authenticated media proxy, photo viewer and forwarding code address a message ID. Keeping one media row per photo preserves those contracts instead of adding a second media-list API. `album` and `source_event` are nullable columns added safely to existing SQLite databases. Sent gallery row IDs are the real event ID and stable `#photo:NN` child IDs; every child points to the one real Matrix `source_event`. Inserts join one explicit transaction. Sync replay, sync-before-send-receipt, restart and duplicate taps preserve `client_id` idempotency.

Delete acts on the entire grouped post, with each distinct real event redacted once. Reply/reaction on an outgoing synthetic photo resolves to the real transport event. Incoming parts retain their real IDs; reaction badges aggregate across the post, and toggling an existing own reaction addresses its actual part. Reply jumps find the grouped post even when the reply targets an inner photo. Selection/menu forwarding includes every photo and the caption once; saving from the album menu saves all photos. Tapping a tile opens that photo, not a new album viewer.

## Upstream constraint / deliberate mapping deviation

mautrix bridgev2 v0.32.0 has `UNIQUE(bridge_id, mxid)` on its message table. It cannot store N rows with the exact same real Matrix event ID. Rather than fork its database schema, the primary mapping uses the real MXID; extra mappings use bridgev2's own `SetFakeMXID()` and nonempty `wizard-gallery:N` PartIDs. All rows carry `wizard_album_root` and `wizard_album_ids` metadata. They map **every real Telegram message ID**, suppressing extra echoes without creating extra real Matrix events. The patched remove handler sends the complete recorded Telegram ID list for both normal chats and channels. This is the only deviation from literal same-MXID multipart storage.

## Build

From the repository root (Docker Engine / BuildKit):

```sh
docker build -f plumbing/telegram-bridge/Dockerfile \
  -t wizard-telegram-bridge:0.2610.0-albums1 .
```

The builder checks upstream tag `v0.2610.0` against commit `6991248e6a573489d2d38d603b5dbed1627113bc`, applies `albums.patch`, runs `go test ./pkg/connector/...` and `go vet ./pkg/connector/...`, then builds the binary. The runtime is the pinned official image plus `olm` (required by this build's CGO-linked binary). The Dockerfile executes `--version` in the **final runtime image** to catch missing shared libraries. This modified upstream bridge is AGPL-3.0-or-later; `LICENSE.upstream` accompanies the source patch. Retain source availability when distributing/serving it.

Messenger can reuse the already verified release's Marmot binaries (no Rust rebuild needed for this Python/JS change):

```sh
docker build \
  --build-arg MDK_BUILD_IMAGE=wizard-messenger:0.2.0-unified.11.13 \
  --build-arg MESSENGER_RUNTIME_BASE=wizard-messenger:0.2.0-unified.11.13 \
  -t wizard-messenger:0.2.0-unified.11.14 .
```

## Verification

- `python3 -m unittest discover -s tests -v`: album send/validation, atomic rows, schema migration, sync/restart/concurrent retry, received grouping, single photo, reply and deletion; all existing Python tests remain part of discovery.
- `node --test tests/*.test.cjs`: existing Node tests.
- `tests/photo_album_browser.cjs`: 390px phone viewport; 2/3/4/10 tiles = one bubble, one caption/footer, exact tile viewer, real touch long-press = one selected post, all-file/one-caption forwarding, incoming group and reaction targeting, sender isolation, single photo and second palette. Evidence under `voicefix/albums/photo_album/` (local, not committed).
- Existing `multi_photo_browser.cjs` now requires **one** send request with three `upload_ids`. Existing transcribe-forward, tab-badges, update-speed, phone-vault and share-receiver browser scripts remain regression requirements. All accept `PLAYWRIGHT_CHROMIUM_EXECUTABLE` for an installed Chromium revision.
- The bridge patch includes `album_test.go`: recording-API integration tests invoke the production publisher with 2/3/10 photos, assert N finalized uploads and **one** actual `MessagesSendMultiMedia` request, caption/reply preservation, stable random IDs, all-part mapping metadata, same-group/count validation and no send on upload failure. Incoming grouped-ID precision and single-message noninterference are tested.

The disposable preview Telegram database has no user login or portal, so no real Telegram/Saved Messages send is authorized/possible there. Preview image startup and the recording-API integration tests are the honest boundary; they are not a claim of a live Telegram delivery. Never log in or send to another person to obtain proof.

## Live release handoff (not executed)

Use the candidate `runtipi/config.json` (version `0.2.0-unified.11.14`, `tipi_version` 34) and `runtipi/docker-compose.yml` only after review and image verification. Required compose changes:

- `services.unified-init.image`, `services.messenger.image`, `services.translation.image`: `${MESSENGER_IMAGE:-wizard-messenger:0.2.0-unified.11.14}`.
- `services.telegram.image`: `${TELEGRAM_IMAGE:-wizard-telegram-bridge:0.2610.0-albums1}`, with `pull_policy: never` for the local build.

Check installation environment overrides: an existing `MESSENGER_IMAGE` or `TELEGRAM_IMAGE` overrides these defaults. Keep all volumes/configuration/credentials intact. Back up the SQLite database before promoting the safe additive migration. No gateway/Caddyfile or live app directory changes are required by this patch. The branch includes both the live QR-code work and the unified-inbox reuse-check workflow.
