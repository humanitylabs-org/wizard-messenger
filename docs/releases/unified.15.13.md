# 0.2.0-unified.15.13

EXTEND: existing shareTargetRows/newChat; no second picker.

Owner-local release from live 15.12 source eefe38a4a8b63285d3c732c7b24d91c71b8c2c14, not feature/unified-inbox.
Cherry-picks PR #45 (9a87100) without conflicts. Send to… lists recent chats first, alphabetical for ties; New chat remains A–Z. Published share targets include lastActivity for the shell's cached People row. Picking a person stages, never sends.

Packaging: tools/Dockerfile.people-recents overlays only server.py version and static/unified.js/static/app.js on the exact 15.12 carrier. Retains opt-in microphone, salvage, voice/bridge changes. Recipe version 15.13 / tipi_version 54.

Promotion uses the shared messenger promotion lock, existing owner-local recipe pin and WAM lifecycle; no app data inspection. Recreating Messenger briefly drops active connections and may require owner unlock. Close and reopen an already-open Messenger window. Rollback restores the backed-up recipe/source pin and runs the same WAM update route to the retained 15.12 image.
