# WhatsApp / Signal connector port

Base: live Messenger `9c3025de4c7fbf2a6bb841144087a87c4f2448c3`. Extract selected components from Oscar's PRs #12/#13; never merge their older app tree. No live deployment or real account linking is authorized.

Reuse:
- bridge adapters / restricted owner transport: REUSE Oscar connectors.py, connector_*.py and generated templates, narrowed to Telegram, WhatsApp, Signal.
- Settings, buttons, account linking and QR drawing: EXTEND unified Settings `overlay` / `button` / `.u-sheet`, Telegram provisioning path and its qrcode canvas pattern. Oscar's controller supplies one shared scan/wait/cancel implementation for all three networks; no second styling system.
- existing sends, albums, voice, forwarding, contact QR, sharing: REUSE live UnifiedInbox and view; generalize Matrix-network checks rather than overwrite with older connector implementations.
- platform components: REUSE WizardApp appearance/back/capture/share integration already in the live app.
- NEW: none in web/core.

Acceptance: existing Python + browser tests, focused connector tests, real isolated Synapse + pinned WhatsApp/Signal bridge QR responses, 360x640 Settings QR screenshots, cancellation and stack teardown. No login proceeds beyond QR display. Machine keys never administer linking, even with a message grant.

Oscar's inbox assumes APIs absent from live (weak_label, store FTS/history/read/name helpers) and duplicates send methods that predate albums. Retain only its adapter/metadata/identity intent and extend the live shared methods. Do not import unrelated search, authority, trusted unlock, providers or style changes.
