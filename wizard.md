---
wizard: 0.2
id: messenger
name: Messenger
version: 0.2.0-unified.13.0
type: service
category: app
summary: Encrypted text conversations with your peers, inside Wizard.
license: MIT
# Alpha: listed in the Wizard App Store (Alpha channel).
source: https://github.com/humanitylabs-org/wizard-messenger
icon: icon.png
runtime:
  kind: runtipi
  config: runtipi/config.json
  compose: runtipi/docker-compose.yml
api:
  path: /api
  port: 8765
  spec: API-contract.json
mcp:
  path: /mcp
  port: 8765
  transport: streamable-http
skill: skill/SKILL.md
view:
  path: /
  port: 8765
  source:
    path: static
    build: "python3 tools/build_view.py"
    dist: static
health: /healthz
provides: [messaging]
uses: [browser]
needs: []
---

Messenger runs entirely in its own isolated container. Its web view uses only its documented HTTP API; the UI source is shipped separately so a Wizard can customize it. Marmot MDK supplies encrypted conversation and relay synchronization.

This candidate implements text DMs with dedicated messaging identities, invitations, local encrypted history and explicit passphrase unlock after restart. The protected root Wizard ID is never imported. Public contact codes are shareable; secret keys are not exposed.

The API requires a generated capability for trusted integrations; browser access uses a scoped HttpOnly session, exact-origin checks and CSRF. Initial owner setup uses a single-use install capability. Without a key the MCP exposes public identity/status only. Each agent can get its own Messenger key with an owner-chosen level (Draft-only recommended) that adds chat listing, thread reading and draft tools; only the owner sends.

Private beta installation and versioned image-download instructions are in PRIVATE-BETA.md. Public indexing and recipient contact are not included.
