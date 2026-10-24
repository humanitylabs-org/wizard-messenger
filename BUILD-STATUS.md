# Messenger five-network release candidate

This local candidate extends James's merged 97cb0a5 Messenger (unified.11.7/restart recovery). Keep Beeper until owner-account acceptance is complete; dependency health is not message delivery.

## Integrated behavior

- Personal Slack email/code/workspace/MFA login, Telegram, WhatsApp, LINE and Instagram adapters, private owner login UI, pinned upstream images/templates. LINE reuses public MIT beeper/line source 72c7a51a44f344966b916bd2f42a734381061186. Optional Signal remains available.
- Reviewed fixed-origin, fixed-route LocalOwnerSender enables normal owner operations. It is never selected in explicitly required independent-authority mode.
- Owner settings: No access, Read-only, Draft-only, Draft-and-send. Default No access. Draft-only reads/saves drafts but cannot send, react, type, mark read, edit/delete messages, link accounts, change policy or obtain owner authority. Draft-and-send is explicit and still cannot administer accounts or policy.
- Normal owner draft edit → review → separate click Send works through cookie/Origin/CSRF. Configured/required independent authority uses secure export instead and never silently falls back locally.
- James's phone vault, voice capture/playback speed, badges/mute, boot/restart recovery are retained. Shared transactional FTS/history paging, incoming-notification intents and optional Web Push remain integrated. Web Push dependencies and owner subscription remain opt-in.
- New connectors share base thread-scoped edit/reaction/redaction/tombstone rules and voice-note warming; cross-thread mutations cannot bypass search/history isolation.
- Trusted local install provisioning can issue an initial owner enrollment file; ordinary bearer tickets remain launch-only and cannot mint a configured-account owner session.

## Evidence boundaries

Parent combined Python tests and Node tests pass; exact final totals belong to the release receipt, not this evolving file. The five-network lane exercised real no-egress Synapse + required bridge processes: liveness 200, authenticated provisioning 200, unauthenticated provisioning 401, and Slack/Instagram/LINE input-descriptor login-start/cancel 200. No real owner account was authenticated or message sent.

The same-server permission runtime exercised a built-image worker → Unix socket broker → real normal Messenger HTTP API → synthetic provider callbacks. Worker filesystem/network/admin attacks were denied, Draft-only rejected writes, and only an owner click or explicitly permitted agent send reached the fixture callback. The worker is an actual MCP runtime, not a running full Hermes model conversation.

## Remaining owner/production gates

- Owner must create/unlock Messenger and connect the five accounts. Telegram needs the owner's application API ID/hash in private app settings. Passwords, session values, QR/PIN/code/MFA stay in the private UI, not chat. CAPTCHA/SSO/browser-only challenges stop explicitly.
- Real send/receive, account-history completeness, phone media/notifications and reconnect behavior must be checked per account before switching away from Beeper.
- API permission enforcement is not a sandbox against current host-admin Oscar. Current Oscar retains Docker/file/cloud/tool authority. Whole-agent restriction requires confining all actual tool/delegation runtimes and removing alternate provider/admin/browser channels; the tested MCP worker alone does not apply that cutover. No second physical server is inherently required.
- Optional remote-required mode still lacks live restricted reading; do not select it expecting a working live inbox. Pending independent exports remain frozen until independently completed (terminal cancellation not implemented).
- KakaoTalk is not in this release. Personal Slack may be constrained by workspace policy. LINE and Instagram authentication can require phone approval and provider security challenges. Open-source bridges are not endorsed by those networks.

No source has been publicly pushed by this task. This branch/image can be installed locally with supported per-app WAM user configuration while retaining the live app data and a rollback override.

## Reproduce

Use the combined disposable test environment (isolated_sender/requirements-ui.txt, push_notifications/requirements.txt, PyYAML and MCP SDK for the broker proof). No owner credentials are needed for fixtures.

```
python -m pytest -q
node --test tests/test*.cjs tests/*.test.cjs tests/remote_authority_ui.cjs push_notifications/tests/*.cjs
python permission_runtime/proof.py
python -m readiness.check --require-migration-ready --output <new-disposable-directory>
```

The migration command remains a fail-closed gate, not a target to turn green without real owner acceptance. See CONNECTORS.md, AGENT-PERMISSIONS.md, permission_runtime/README.md and INTEGRATION-RELEASE.md.
