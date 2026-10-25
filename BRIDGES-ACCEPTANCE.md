# Messenger 12.0 — WhatsApp / Signal connector preview

## Outcome and release boundary

The requested base is `9c3025de4c7fbf2a6bb841144087a87c4f2448c3` (11.14).
Real pinned WhatsApp and Signal bridges each returned a linking QR through the
owner API. The actual Settings sheet rendered both on a 360×640 phone viewport,
in dark and light Wizard skins. A QR decoder read all four screenshots back to
the exact bytes of their corresponding bridge response. Both logins were
cancelled without scanning or authenticating a WhatsApp or Signal account.

**Not approved for a live update.** Read-only inspection found the installation
already running 11.15, revision `2b9c5cd165839529e25ac472c51572af9b7de328`,
including the newer photo-album implementation and patched Telegram image.
This branch intentionally remains based on the explicitly requested 11.14.
The requested-base feature inventory passes, but the current-live inventory
blocks on the album implementation/tests/Save photos action. Before any live
update, reconcile those newer album changes, keep its patched Telegram image,
advance the installer revision past the currently installed revision, and
repeat the current-live inventory and album tests. No waiver was created.
No live app, live data, Runtipi installation file, or Caddy service was changed.

## Reuse and attribution

Credit: Oscar Henry Collins (`@oscarhenrycollins`), reference PRs
[#12](https://github.com/humanitylabs-org/wizard-messenger/pull/12) and
[#13](https://github.com/humanitylabs-org/wizard-messenger/pull/13).
Neither stacked branch was merged or rebased. PRs #14/#15 were not imported.

REUSE: Oscar connectors.py/connector_*.py/connectors.js/templates.
EXTEND: unified Settings sheet + Telegram provisioning path.
NEW: none in web/core.

### Oscar files copied byte-for-byte

- `plumbing/whatsapp-template.json`
- `plumbing/signal-template.json`
- `plumbing/bridge-upstream-LICENSE` (shared upstream AGPL license; the separate LINE license is out of scope)

### Oscar files reused and adapted

| File | Adaptation |
| --- | --- |
| `connectors.py` | Extensible table restricted to Telegram/WhatsApp/Signal; owner enable marker; ephemeral Telegram phone-step resume; no QR in machine status. |
| `connector_setup.py` | Only WhatsApp/Signal templates; pre-register both dormant appservices; preserve enabled state across initialization; preserve Telegram credentials/config and registrations. |
| `connector_inbox.py` | Retain owner transport/bootstrap/provider identity behavior, but inherit live sends, uploads, multi-photo, voice, forwarding and history. Remove older duplicate implementations and dependencies on absent store APIs. |
| `connector_web.py` | Deny machine Authorization headers even when an owner cookie and active message grant are also present. |
| `connector_sender.py` | Reuse fixed-target, redirect-denying local-owner sender and bootstrap; remove error mappings for excluded providers. |
| `static/connectors.js` | Preserve generation fences, QR-first scan/auto-wait/refresh/cancel, sanitized errors and input clearing. Use unified buttons, Settings sheet, shared QR renderer, existing spinner and phone-country control; preserve Telegram resume and owner contact-code rendering. |
| `plumbing/connectors-provenance.json` | Retain only the WhatsApp/Signal entries and their upstream manifests/hashes. |
| `runtipi/connectors.compose.yml` | Only connector init + WhatsApp/Signal; no optional profile required; marker-watching dormant workers; also integrated into the normal compose file. |
| `tests/test_connectors.py` | Narrow fixtures and expected counts; add owner-enable and Telegram pending-step privacy tests. |
| `tests/test_connector_sender.py` | Supported-network transport fixtures. |
| `tests/test_connector_login_runtime.py` | Supported-network fixtures and error vocabulary. |
| `tests/test_connector_login_runtime.cjs` | Keep seven asynchronous login UI regressions; retain existing Telegram installation-key setup rather than import a parallel form. |
| `tests/test_connectors_view.cjs` | Supported-network fixtures and shared-renderer regression. |
| `tests/test_connector_history.py` | Adapt room-scoped edit/reaction/redaction and voice checks to the live store, without importing unrelated FTS; test own-ghost recovery for both networks. |

The intent of `plumbing/connectors-web-integration.patch` was applied directly
to current `web.py`, not copied as an unapplied patch. `Dockerfile`,
`Dockerfile.overlay`, normal compose, HTML asset loading, live unified backend
and Settings styles were extended. The five requested release files carry
12.0; installer revision is 35 as specified in the brief. No additional bridge
providers, trusted unlock, search, permissions UI, or alternate styling system
were imported. The existing contact-QR network choices remain unchanged.

## Compatibility/security issues fixed

- Oscar's inbox targets an older/different store (`weak_label`, FTS/history/name
  helpers) and duplicates methods that predate live multi-photo and forwarding.
  Those replacements were not used. Shared live algorithms now classify all
  three Matrix-backed networks, including room-scoped mutation checks.
- A valid machine header plus an owner cookie previously passed Oscar's
  session-only connector check and could bypass the browser's CSRF path.
  Connector administration now rejects any machine Authorization header,
  including with an active message grant. Positive owner CSRF/origin tests pass.
- Optional compose profiles and `sleep infinity` dormant workers would not
  start linking through a normal owner-enabled update. Normal compose starts
  dormant marker watchers, with Synapse registrations already in place; the
  owner enable action wakes only the chosen worker. Messenger never controls
  Docker, rewrites Runtipi files, or restarts Synapse.
- Oscar's reduced Telegram status lost profile fields used by live My QR codes;
  those suggestions and phone-step resume are preserved. Pending QR/code data
  is returned only by owner-only routes, never general machine-readable status.
- Live static serving needed the new JS allowlist entry. My QR codes and linking
  now use one exported module renderer; its export has a regression check.
- The new card UI uses the existing `.u-sheet`, overlay, button and QR classes,
  plus the platform appearance tokens with the existing dark fallback. Skin
  screenshots wait for finite transitions, not the infinite waiting spinner.

## Verification

- Python discovery in the Messenger image: **142 passed, 0 failed** with PyYAML
  supplied only as a mounted test dependency. The unmodified runtime image lacks
  PyYAML; its two existing YAML-import failures remain a baseline dependency
  issue, not a runtime requirement or changed test expectation.
- Node test runner: **54 passed, 0 failed**, including the connector view/runtime
  scripts and voice-speed checks; the login runtime script covers seven
  asynchronous UI regressions.
- Retained browser harnesses passed: My QR codes (including nested Back),
  multi-photo, share receiver (**9/9 checks**), transcribe/forward (including
  touch selection, platform Back, no update holds and two skins).
- Real isolated Synapse/WhatsApp/Signal preview: **2/2 networks show real QR**;
  **4/4 phone/skin screenshots decode exactly to the real API payload**;
  both cancel responses succeed. No fake bridge or mocked linking response.
- Both bridge binary hashes match Oscar's checked-in provenance. Compose
  validates; source whitespace and requested-base inventory checks pass.

Legacy preview harnesses that require additional seeded fixtures or destructive
restart/setup scenarios were not represented as having been run. Multi-photo
and transcribe harnesses now accept explicit preview container/API/session
inputs so they can run against this task's own stack rather than alter a
reference preview.

Private evidence contains the API QR responses, decoder results, screenshot
paths, exact image identity, test logs, cancellation readback, reuse inventory,
and preview teardown checks. QR responses were kept private and cancelled;
no credentials or QR payloads were committed or posted to GitHub.
