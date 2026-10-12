---
wizard: 0.2
id: messenger
name: Messenger
version: 0.1.1
type: service
category: app
summary: Encrypted text conversations with your peers, inside Wizard.
license: MIT
# Candidate release destination: not published or discoverable until authorized.
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
needs: []
---

Messenger runs entirely in its own isolated container. Its web view uses only its documented HTTP API; the UI source is shipped separately so a Wizard can customize it. Marmot MDK supplies encrypted conversation and relay synchronization.

This candidate implements text DMs with dedicated messaging identities, invitations, local encrypted history and explicit passphrase unlock after restart. The protected root Wizard ID is never imported. Public contact codes are shareable; secret keys are not exposed.

The API requires a generated capability for trusted integrations; browser access uses a scoped HttpOnly session, exact-origin checks and CSRF. Initial owner setup uses a single-use install capability. The MCP exposes public identity/status only; agent message access, groups, attachments and phone push are later work.

Publication, index discovery and installation on someone else's Wizard remain separate release actions. The release source/image destinations above are reserved candidate metadata, not claims that they already exist.
