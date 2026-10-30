# Photos and files in Wizard-to-Wizard chats

The pinned engine (`wn`/`wnd` from MDK 0.12.0, `122bd90`) already implements Marmot encrypted media
(MIP-04, `encrypted-media-v2`). Nothing in Rust was rebuilt for this feature.

## Engine surface used

- `Media.Upload {group, file_paths, send: true, message, media_type: null, server: null}`: encrypts each file
  with a key derived from the group's MLS epoch, uploads the ciphertext to the group's Blossom endpoints
  (fallback order) and publishes one kind-9 message with one `imeta` tag per file. Result:
  `attachments[].media.{plaintext_sha256, media_type, file_name, ...}` and `sent.{message_ids, published}`.
- `Media.Download {group, file_hash, output}`: resolves the reference from group history by plaintext SHA-256,
  fetches and decrypts it, then writes `output` (0600).
- The timeline (`Timeline.List`) carries `media.imeta` on each message. `engine.timeline_attachments` passes
  only `plaintext_sha256`, `m` (mime), `filename` and `dim` to the app. Locators, nonces and ciphertext hashes stay in wnd.

## Blossom servers

New groups get the engine's built-in defaults (`DEFAULT_BLOSSOM_SERVER_URLS` in marmot-app `media/mod.rs`):
`https://blossom.divine.video`, `https://blossom.ditto.pub`, `https://cdn.hzrd149.com`. They are stored in
the group's `marmot.group.encrypted-media.v2` component, so both members use the same list. Messenger passes
`server: null` and never picks a server itself.

## Privacy

- Blossom operators only ever see ciphertext. They can still see:
  - its size and SHA-256;
  - upload and download times;
  - the Wizard server's IP address;
  - the uploader's Nostr pubkey, because the BUD-02 kind-24242 upload authorization is signed with the account key.
- File names, types and captions travel only inside the MLS-encrypted kind-9 message.
- Blobs stay on third-party servers. No delete is issued, but without the group key they cannot be decrypted.
- Messenger keeps the plaintext:
  - in `unified/marmot-outbox/<upload>/` (0700/0600) until the send succeeds or the upload expires after 1 h;
  - in the private media cache after a download, verified against the plaintext SHA-256.
- Inline display is decided by sniffed bytes, never by the sender's declared type.

## Limits and follow-ups

- Voice notes are still refused in Wizard chats. An Ogg file would send as a plain file, but there is no
  waveform/voice metadata.
- `imeta` from wn has no size or `dim`, so received photos and files show without a size until they load.
- A reply quote is not attached to media sends; the Upload command has no `reply_to`.
- The engine mutex is held for the whole upload, up to 300 s for 25 MB, so other engine calls wait meanwhile.
- The native private thread (`app.js`) still has its own composer without attachments. Media works through the
  unified Inbox thread.
