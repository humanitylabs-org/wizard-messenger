# Wizard Messenger

Encrypted text conversations with peers, inside Wizard OS. Each installation runs its own isolated container, documented HTTP API, minimal MCP and editable web view. Marmot MDK supplies the messaging engine; Wizard supplies the interface and app integration.

## Candidate scope

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

This local candidate uses `wizard-messenger:0.1.0-candidate` with `pull_policy: never`; load the architecture-matching image before installation. The Runtipi definition maps only its own `/data`, limits resources and exposes internal port 8765. The installer supplies a generated 32+ character application capability, exact private HTTPS origin and public app path through normal app-secret/configuration mechanisms. Keep secrets out of output and URL queries.

Repository/image destinations are reserved release metadata. This candidate is not publicly indexed or published. Publication and another person's installation require their corresponding authorization.

## Privacy and limits

The Wizard box is the encryption endpoint. Relays transport encrypted conversation payloads and observe traffic metadata. After a restart the owner unlocks; closing the browser window does not stop box-side receipt. Local history and encryption state persist in app-data. A public address/signing-key backup alone is not a qualified full-history restore.

Marmot/White Noise is a developing beta ecosystem. This is a two-person MVP, not Signal-certified or large-community infrastructure.

## Verification

Lightweight checks: `python3 -W error::ResourceWarning -m unittest discover -s tests -v`. Node logic checks, remote container/browser campaigns and exact artifact/source receipts accompany each candidate. Fixture checks are separate from real engine/relay proofs; a unit suite is not proof of delivery or app-manager installation.

The sigil uses Wizard OS's house renderer. Public contact parsing uses the vendored MIT Bech32 reference implementation (bech32 1.2.0). Marmot license, lock and source provenance ship in `engine/`.
