# Messenger replacement candidate — not migration-ready

This branch is a private development candidate alongside Beeper. Nothing here proves a complete Beeper replacement or deployed root-resistant sending. The installed owner application has not been changed by this build.

## Implemented and exercised

- No access, Read-only, Draft-only and Full access agent permissions, default off; explicit owner configuration, bearer/session separation, and persistent local drafts.
- Maintained WhatsApp and Signal bridge adapters plus existing Telegram. Disposable Synapse, WhatsApp and Signal bridge liveness was exercised from the staged app network without linking an account. Slack adapter is bot/app-only, not personal-inbox parity. LINE and KakaoTalk remain unsupported.
- Lossless timestamp/ID history paging and transactional SQLite message-content search, including edits and redactions.
- Optional owner-only Web Push subscription UI/API, service worker, durable incoming-message intents and bounded retries. No real device subscription or push delivery is claimed.
- An independent HTTPS/passkey owner authority with a fixed Matrix sender, per-message user verification, durable retry IDs, exact account/room/text/attachment binding, and a narrow draft-only main-app client.
- Frozen draft export and independent review, with no local Send fallback in the secure-review UI. Explicit remote-required mode disables local providers and rejects credential-bearing data.

Parent verification after integration: 261 Python tests and 288 subtests passed, plus 59 Node tests. Chromium exercised real loopback APIs and disposable SQLite at 320/390/1280 widths; no browser send request occurred, and unconfigured independent review stayed disabled. Crypto, HTTPS and Matrix protocol fixtures are synthetic test evidence, not hardware or remote-network delivery.

## Unresolved acceptance gates

The strong mode does not yet have a live restricted read facade: its recipient directory is offline, so it is not a live inbox. The independent authority needs an independently administered host, DNS/TLS, Matrix homeserver and bridges inaccessible to Wizard root. All alternative main-host send credentials/sessions must be removed/revoked. Pending exported drafts have no terminal cancellation endpoint and remain frozen until independently completed. Public exposure quotas/rate controls and independent-host operational hardening are not certified.

No owner accounts have been linked. Actual per-network send/receive, media/history completeness, reconnect behavior, phone notifications, hardware passkeys and daily parallel use require owner-attended verification. A healthy connector or passing test does not satisfy those gates. Keep Beeper; do not recommend switching.

The ordinary single-host mode is application defense-in-depth, not protection against an agent that administers its host. A second local container or a configuration attestation does not establish independence. Review securely is disabled until a trusted independent Matrix authority is configured; it does not silently fall back to a local draft-send flow.

## Reproduce

Use a disposable Python environment with isolated_sender/requirements-ui.txt, push_notifications/requirements.txt and PyYAML installed; no owner credentials are needed for local fixtures.

```
python -m pytest tests readiness/tests isolated_sender/tests push_notifications/tests -q
node --test tests/test*.cjs
node tests/remote_authority_ui.cjs
node push_notifications/tests/test_service_worker.cjs
python tools/verify_candidate_browser.py --output <new-disposable-directory>
python -m readiness.check --require-migration-ready --output <new-disposable-directory>
```

The final readiness command must continue returning exit 3 while real migration gates remain unproven. See REMOTE_AUTHORITY.md, CONNECTORS.md, push_notifications/INTEGRATION.md and isolated_sender/README.md for the exact security and capability boundaries.
