# Local integration: James unified inbox + permission candidate

Upstream merge target: `97cb0a59e0f3a14a7076a4866b203f543629fb5b`.
Candidate base: `f5e4f6b`.

## Conflict decisions

- `static/app.js`, unauthorized message: same-question/different-answer; use James's restart-aware signed-out copy; retain the candidate's owner-enrollment explanation.
- `static/app.js`, setup submission: superseded duplicated implementation; use James's shared `unlockWith` for typed/phone-vault/PRF passwords, and retain explicit passphrase verification through `/api/view/unlock` inside that helper. A setup ticket never becomes an owner session.
- `static/unified.js`, close overlay: disjoint intents; close connector flows AND resolve an outstanding confirmation as cancelled.
- `static/unified.js`, exported controller: disjoint intents; retain settings, native unread badges and James's shared interaction helpers.
- `static/unified.js`, signout: disjoint intents; clear pending search generation/results AND all unread/badge state.
- `unified.py`, incoming ingestion: disjoint intents; preserve live-only durable push intents AND warm recent incoming voice media.

Two synthetic DOM fixtures were extended with browser APIs newly used by the shipping source (`addEventListener`, `querySelector`); no assertions were removed or skipped.

## Trusted first-run provisioning

An operator may enable `MESSENGER_PROVISION_OWNER_ENROLLMENT=1` in the app's owner-controlled runtime configuration for the first start. This is **not** an HTTP, MCP or agent-bearer operation. With no existing account/verifier, startup persists a bootstrap ticket and writes `/data/owner-enrollment.json` with mode 0600. Retrieve that file through trusted local provisioning and append its `fragment` to the owner's normal Messenger URL. It expires after seven days and can be exchanged once. Existing artifacts are not overwritten on restart, and configured accounts never get another enrollment token. Disable the flag after handoff and remove this secret artifact through the trusted operator path once used. Reissuing an expired unused link requires operator removal of only that artifact before restarting with the flag enabled.

The real loopback HTTP regression exercises provision → auth reload → ticket exchange → setup → rejection of the setup-only cookie for owner settings → passphrase unlock → owner access. It also checks configured-account bearer denial and that the artifact is not web-served. Providers are fake in this test; no actual account was created, paired or sent to.

## Verification and boundaries

Run Python with the shared `isolated-sender-venv/bin/python -m pytest -q` and JS with `node --test tests/test*.cjs tests/*.test.cjs tests/remote_authority_ui.cjs push_notifications/tests/*.cjs`.

`tests/boot_restart_browser.cjs` is a standalone Chromium route-fixture test. The other `*_browser.cjs` scripts require a disposable running provider preview and several also require existing Telegram media, live send commands, physical phone-vault or preview-container restarts. They are not certification of this local merge merely because they are present. They must not be aimed at the owner's installed app as part of integration.

The sibling permission/runtime lane owns optional safe local owner review and mode wiring. This merge deliberately does not implement that UI again. No deployed worker confinement is established here; draft-only's hard security guarantee depends on actually confining the worker and removing host-admin/provider credential bypasses. Existing isolation proofs are fixtures, not claims about this machine's deployed agent.
