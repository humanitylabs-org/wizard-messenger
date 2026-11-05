# Independent Signal album slice (not activated by the attachment-controller fix)

## Verified source boundary

Messenger live engine image config ID `sha256:75dde49255cdb88b789103170b69c68517a7acc6a8523fec3ee0f2174235b84e`, OCI source `4566306576d3a6805da1ba531da3a89214dfd7af`, pins **unmodified** mautrix-signal v0.2610.0 in `plumbing/connectors-provenance.json`:

- Signal source commit `d129f0ecc6bd29cfb5e54b18e025bd0c8a20a4bf`.
- Signal binary SHA256 `13867e87604464b7ca848bd0e4b6afdb013710f021cc7477007629d1585f3b5f`.
- Signal image manifest `dock.mau.dev/mautrix/signal@sha256:39afa721aa69472b2e91c75bd7d81a739e47f7e480fc0ff5ac8247af28eb2d0a`.
- bridgev2 dependency mautrix v0.32.0, source commit `aae5273d1463cd69dd2f95eb2dd62e8bd9084c4d`.

No live Signal message, media or database was read. Public pinned bridge source was inspected only.

## Exact causal state

`pkg/msgconv/from-signal.go:175-218` converts each attachment of ONE DataMessage into a separate `ConvertedMessagePart`, then assigns `MakeMessagePartID(i)`. `cm.MergeCaption()` merges only exactly two parts (`bridgev2/networkinterface.go:142-159`), so three images plus caption remain four events. `bridgev2/portal.go:3031-3065` emits each part as a distinct Matrix event. The native Signal message ID and part ID are only in bridge database metadata; `bridgev2/matrix/intent.go:48-92` does NOT publish them as a Matrix content grouping field. Messenger `unified.py:1303-1306` consumes only `fi.mau.telegram.grouped_id`; `albumPosts` is already network-neutral.

Therefore an app-only timestamp/sender grouping "fix" would invent associations between independent Signal sends. Do not do it. Nor can previously ingested events with no group metadata be safely repaired without a separate, authorized source-ID migration. This slice must ship the bridge metadata and Messenger consumer together; it is broader than the original static-controller repair.

## Exact implementation slice

1. Pinned Signal `MessageConverter.ToMatrix`, immediately after `cm.MergeCaption()` and before part IDs are assigned:
   - Skip view-once and any DataMessage with fewer than 2 attachment pointers.
   - Require all converted parts to be `event.MsgImage`, except optionally one final `event.MsgText` originating from this **same** DataMessage. Require image count equals attachment-pointer count. For mixed image/file/video, contact, failed conversion, payment or other notice, leave existing behavior untouched.
   - If that optional text exists, call the already exported `bridgev2.MergeCaption(textPart, firstPhoto)` once; replace firstPhoto, drop just the trailing textPart. This preserves formatted body, mentions, link previews, existing per-image caption, and filenames.
   - Let `group = string(signalid.MakeMessageID(sender, dm.GetTimestamp()))`, a native explicit source identity, not a time window. For every photo part i merge into its existing `Extra` map (do not overwrite GIF metadata):

```go
part.Extra["org.wizard.signal.album"] = map[string]any{
    "id": group, "index": i, "count": len(cm.Parts),
}
```

   Keep the normal PartID assignment and bridge database mappings; do not coalesce the native Matrix events or replace bridgev2's mappings.

2. Messenger `UnifiedInbox.ingest`, by the current grouped_id extraction:
   - Only for `identity['network'] == 'signal'` and `msgtype == 'm.image'`, validate `content['org.wizard.signal.album']` is a dict, nonempty string id <= 200 characters, exact non-bool integer index/count, `2 <= count <= 100`, `0 <= index < count`, and valid existing media.
   - Set `album = 'signal:' + group['id']`; retain part ordinal/count in the media object (`album_index`, `album_count`). Existing scoping by identity/sender/direction and existing message IDs remain authoritative. Do not trust the marker on other networks or text events.
   - Use the existing persistence path and generic album renderer. Sort known explicit Signal parts by album_index within the already adjacent/scoped photo post; preserve unmarked Telegram ordering. Never group across a non-photo/text boundary. Keep all existing per-part IDs for viewer/reactions, selection, forward, delete and save.
   - Ensure captions on more than one image cannot disappear: existing `albumPosts` takes only the first nonempty caption. A pure DataMessage body belongs on item zero; retain any distinct per-photo captions as tile metadata, or explicitly return the independent caption event unchanged rather than silently discard it.

3. Package a pinned `plumbing/signal-bridge/` AGPL source patch + upstream LICENSE + Dockerfile, mirroring existing Telegram patch packaging. Update ONLY the Signal image/provenance and Messenger consumer, not Synapse, Telegram, WhatsApp, account configuration or owner data. Build on forum, never fetch a mutable image tag. Reuse the installed Signal configuration and volumes through the existing app lifecycle.

## Required synthetic acceptance (independent queued heavy job)

- Construct ONE synthetic Signal `DataMessage{Timestamp: fixed, Attachments: [red,green,blue], Body: "Three photos"}` and record the actual patched converter's three Matrix content parts. Assert one explicit group ID, indices 0/1/2, exactly one caption, unchanged filenames and three original Matrix mappings. No fake hand-authored grouping may stand in for converter output.
- Feed that recorded output to real `UnifiedInbox.ingest` in a temporary store. Assert three persisted media rows, one post through the existing `albumPosts`, exact tile order/caption after refresh/reaction/restart. Test delayed/reordered deliveries explicitly; do not rely on random event ID sort.
- Same timestamp independent DataMessages with distinct native IDs, different sender/conversation/identity/direction, single image, image/text/image, mixed video/file, bad later conversion, invalid/missing markers and view-once must remain separate/unchanged. No time-window heuristic.
- Test viewer for each tile, one-post selection, forwarding all three with caption once, reaction to the correct native part and deletion of each mapped native part.
- Run existing `test_photo_albums.py`, `test_album_projection.cjs` if present (discover exact filename), Signal converter tests/vet, runtime `--version` and binary dependency smoke. Retain baseline three independent events vs candidate grouped post from the **same converter fixture**.
- Two-skin synthetic hosted screenshots + standalone dark; preserve all existing live app features and source image parity. Do not inspect or send from an owner account.

## Admission

Queue Linux/amd64 converter tests/build on `host=forum`, normal heavy lane if a Go/native bridge build is required. This source-only slice deliberately is NOT represented as a fixed or delivered Signal album feature. Parent owns whether to split it to a second repair branch/PR and final lifecycle activation. Attachment controller source changes do not depend on it.
