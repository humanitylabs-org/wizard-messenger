# 0.2.0-unified.15.13

EXTEND: existing shareTargetRows/newChat; no second picker.

Owner-local release from live 15.12 source eefe38a4a8b63285d3c732c7b24d91c71b8c2c14, not feature/unified-inbox.
Cherry-picks PR #45 (9a87100) without conflicts. Send to… lists recent chats first, alphabetical for ties; New chat remains A–Z. Published share targets include lastActivity for the shell's cached People row. Picking a person stages, never sends.

Packaging: tools/Dockerfile.people-recents overlays only server.py version and static/unified.js/static/app.js on the exact 15.12 carrier. Retains opt-in microphone, salvage, voice/bridge changes. Recipe version 15.13 / tipi_version 54.

Gateway constraint: /, index.html, app.js and app.css are pinned to the existing eefe38a shared view; Caddy has admin off. Keep those files byte-identical to 15.12 (including the legacy WizardApp.ready client version) so no gateway restart or pinned-directory mutation is needed. unified.js is NOT pinned: its /messenger/unified.js route proxies to the container and receives the recents change. Health, image labels, wizard.md and recipe report 15.13. A future coordinated full view release can advance the legacy client-ready version.

Promotion uses the shared messenger promotion lock, existing owner-local recipe pin and WAM lifecycle; no app data inspection. Recreating Messenger briefly drops active connections and may require owner unlock. Close and reopen an already-open Messenger window. Rollback restores the backed-up recipe/source pin and runs the same WAM update route to the retained 15.12 image.
