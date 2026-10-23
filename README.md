# Wizard Messenger

## Install (Wizard App Store, Alpha)

Open **Store** in Wizard and get **Messenger**. Everything installs on your own box; nothing is shared with Humanity Labs.

- **First open:** ask your Wizard for your Messenger setup link, then choose a passphrase (16+ characters). It encrypts your private Messenger chats. After the server restarts you type it once.
- **Fingerprint unlock:** in Messenger → your address → *Unlock with fingerprint next time*. Your phone stays signed in for 30 days; *Lock Messenger* signs out at once.
- **Telegram (optional):** create your own Telegram app ID and hash at https://my.telegram.org → *API development tools*, enter them in the app's settings in Wizard, then *Connect Telegram* inside Messenger. Messages, reads and history sync both ways. Telegram cloud chats are not end-to-end encrypted, and the bridged history is stored on your box.
- **Translation (optional):** add a Tinfoil API key in the app settings.
- Your Wizard agent cannot read your messages unless you allow it for a limited time in Messenger → Connected accounts.

## Unified inbox

Messenger adds private Matrix + Telegram plumbing, People, Groups and reviewed Tinfoil translation without replacing the existing Messenger UI. See [UNIFIED-INBOX.md](UNIFIED-INBOX.md) for installation, security boundaries, exact verification scope and known limitations. **Unified history is plaintext on the box; Telegram cloud chats are not end-to-end encrypted.** The sections below describe the retained Marmot/private-beta baseline.

Encrypted text conversations with peers, inside Wizard OS. Each installation runs its own isolated container, documented HTTP API, minimal MCP and editable web view. Marmot MDK supplies the messaging engine; Wizard supplies the interface and app integration.

## Private beta

Version 0.1.2-beta.1 uses private GitHub release image archives for arm64/amd64. Follow [PRIVATE-BETA.md](PRIVATE-BETA.md) for exact installation, route configuration, first-run setup and restart checks. No package-registry login is needed beyond private repository read access.

## Retained Marmot scope

Dedicated Messenger account and public npub/nprofile contact code; contact resolution and explicit invitations; two-person encrypted text; local encrypted history; honest publication/failure state and request/event-ID retry; responsive Wizard view and drafts; explicit passphrase unlock after restart. The protected Wizard ID is separate. Groups, media, calls, private-key import, phone push and agent message access are later work.

## App format

`wizard.md` declares the current Wizard 0.2 service contract, Runtipi config/compose, health, MCP, shipped skill and view. It also supplies the proposed `api` and `view.source` metadata so the screen can be customized against the documented API. This does not claim that the whole proposed platform customization pipeline has shipped.

- API: `API-contract.json`.
- View: `static/`, unbundled, no external CDN/native-app dependency; validate with `python3 tools/build_view.py`.
- Container: non-root, read-only root, app-data only. Private D-Bus/keyring and Marmot daemon are child processes of this one app. Runtime socket directory is private (0700).
- Key custody: supported upstream keychain provider via encrypted GNOME Secret Service. No host keychain socket or development plaintext-secret fallback.
- Browser: scoped HttpOnly/Secure session, exact-origin/CSRF checks. One-use owner capability starts initial setup; later sign-in proves the dedicated passphrase. Machine API capabilities never enter the UI.
- MCP: the stock gateway can call public identity/status without per-app auth headers; private conversation read/send and signer capabilities are absent.

## Build and install

Sustained Rust/image builds and integration campaigns run on the remote build machine. The default Dockerfile builds the exact MDK source/lock. Audited matching binary carriers can be supplied using `MDK_BUILD_IMAGE`; distinguish this route from a clean default build.

This private beta uses `wizard-messenger:0.1.2-beta.1` with `pull_policy: never`; load the architecture-matching image before installation. The Runtipi definition maps only its own `/data`, limits resources and exposes internal port 8765. The installer supplies a generated 32+ character application capability, exact private HTTPS origin and public app path through normal app-secret/configuration mechanisms. Keep secrets out of output and URL queries.

This package is distributed through a private GitHub prerelease and is not publicly indexed. Recipient contact and access grants are not performed by the package.

## Privacy and limits

The Wizard box is the encryption endpoint. Relays transport encrypted conversation payloads and observe traffic metadata. After a restart the owner unlocks; closing the browser window does not stop box-side receipt. Local history and encryption state persist in app-data. A public address/signing-key backup alone is not a qualified full-history restore.

Marmot/White Noise is a developing beta ecosystem. This is a two-person MVP, not Signal-certified or large-community infrastructure.

## Verification

Lightweight checks: `python3 -W error::ResourceWarning -m unittest discover -s tests -v`. Node logic checks, remote container/browser campaigns and exact artifact/source receipts accompany each candidate. Fixture checks are separate from real engine/relay proofs; a unit suite is not proof of delivery or app-manager installation.

The sigil uses Wizard OS's house renderer. Public contact parsing uses the vendored MIT Bech32 reference implementation (bech32 1.2.0). Marmot license, lock and source provenance ship in `engine/`.
