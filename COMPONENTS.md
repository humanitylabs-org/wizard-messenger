# Messenger attachment repair: component reuse

This live legacy app had no COMPONENTS.md at revision 4566306576d3a6805da1ba531da3a89214dfd7af. No replacement component is introduced.

## Inventory

| Capability | Existing implementation | Decision |
|---|---|---|
| Canonical draft revisions, persistence, owner-only send boundary | drafts.py; web.py existing /api/drafts routes | REUSE unchanged |
| Draft tray, autosave and reconciliation | static/unified.js serverDraft | EXTEND serialize revisions; item-scoped errors; recovery |
| Attachment chips and remove action | WizardApp.attachChip.node in the shared app client | REUSE existing chips, including unavailable-item placeholders |
| Composer send latch and queued send retry IDs | static/unified.js composer / queueSend | REUSE; EXTEND retain conversation identity across asynchronous retry |
| Album projection and renderer | static/unified.js albumPosts / bubble | REUSE unchanged; Signal bridge slice is separately documented |
| Appearance v1 and standalone dark fallback | existing app.css, unified.css and shared app-client.js | REUSE unchanged; hosted proxy two-skin/browser evidence is a QA gate |

Reuse:
- draft-controller: EXTEND static/unified.js serverDraft
- attachment-chip: REUSE WizardApp.attachChip.node
- composer-send: EXTEND static/unified.js composer
- album-projection: REUSE static/unified.js albumPosts
- appearance: REUSE shared app-client Appearance v1

NEW: none.
