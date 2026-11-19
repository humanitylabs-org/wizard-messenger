# Instagram sign-in contract and repair

## Scope and reuse

REUSE: bridgev2 `Connectors` pending-login controller, owner-only LocalOwnerSender,
existing cookie/cURL form, existing masked input/select fields, and Add-account
placement. EXTEND: Instagram flow allowlist, approval action, redacted error
messages, synthetic account-setup acceptance mode. NEW: no provider, remote proxy,
credential collector or bridge implementation. No installed service is changed.
Existing Appearance v1 tokens/styles remain unchanged; the synthetic hosted harness
covers phone/desktop in Nebula and Signal with live skin switching.

## Exact pinned source

The Instagram image is **`dock.mau.dev/mautrix/meta:ig-v0.2610.0`**, not the
Messenger-only tag. Its pinned index is
`sha256:cfba25bf06e97412c5ea60e3c237b6e07b17a8681d2d1c2f7c97db2608fa664d`
(`plumbing/connectors-provenance.json`). This image names its Instagram executable
`/usr/bin/mautrix-meta`. Do not infer the protocol from the executable name.

Pinned upstream source revision: `3c16226686c71af64df294df0803791685064e0b`.
Instagram code is in **pkg/igconnector**, not pkg/connector (the latter is now
Facebook/Messenger only):

- [cookie flow and flow list](https://github.com/mautrix/meta/blob/v0.2610.0/pkg/igconnector/login.go)
- [native/web password state machine](https://github.com/mautrix/meta/blob/v0.2610.0/pkg/igconnector/login_native.go)
- [CAA adapter](https://github.com/mautrix/meta/blob/v0.2610.0/pkg/instameow/login_caa.go)
- [Bloks native verification steps](https://github.com/mautrix/meta/blob/v0.2610.0/pkg/messagix/bloks/selenium.go)
- [shared error definitions](https://github.com/mautrix/meta/blob/v0.2610.0/pkg/messagix/loginerrors/errors.go)

| Flow ID | Operation | Initial step |
| --- | --- | --- |
| `instagram` | Uses an already verified Instagram web session | `cookies`, `fi.mau.meta.cookies`; required `sessionid`, `csrftoken`, `ds_user_id`; optional `rur`, `shbid`, `shbts`, `mid`, `ig_did` |
| `android` | Username/password via Instagram Android API, with CAA/native verification | `user_input`, `fi.mau.meta.instagram.credentials`, `username` + `password` |
| `instagram-password` | Username/password via Instagram web API, with web verification | same credentials step |

Password flows are not single requests. They may return these steps before
`complete` (`fi.mau.meta.complete`):

- `user_input` `fi.mau.meta.instagram.web_two_factor`, `verification_code`
  (`2fa_code`). A rejected code can return this same step with updated instructions;
  it is not necessarily an HTTP error or an expired login.
- CAA/Bloks input steps: `dialog`, `captcha`, `confirmation_action`,
  `account_selection`, `password`, `otp_code`, `backup_code`, `mfa_type`, `totp`,
  `sms`, `choose_contact_point`, `whatsapp`, under the bridge-supplied step prefix.
  Fields and options, not hardcoded identifiers, drive the existing safe form.
- `display_and_wait`, Bloks `afad_wait`, display type `nothing`: approve on a
  previously signed-in device, then continue; the bridge polls for approval.
- `cookies` `fi.mau.meta.instagram.web_challenge`: complete security checks in
  Instagram and supply the resulting named session cookies to resume this login.
- `user_input` `fi.mau.meta.instagram.auth_platform.<field ID>`,
  `fi.mau.meta.instagram.account_manager`, and `fi.mau.meta.instagram.inbox_retry`
  can also occur. The generic masked/select form supports these bridge fields.
- `cookies` `fi.mau.meta.instagram.web_captcha`, with special `captcha_token`,
  and Bloks reCAPTCHA require upstream extraction JavaScript. `client_http` and
  `webauthn` also need a capable client. Messenger deliberately does **not** run
  arbitrary bridge JavaScript, proxy requests or provider-origin passkeys.
  These now offer an explicit browser-cookie restart, not an unusable paste box.

The resumed web-checkpoint cookie step is distinct from a terminal challenge
error. A terminal `RespError` has no continuation token to safely invent. For
those, finish verification on instagram.com and start the recommended cookie flow.

## Error contract

The exact pinned bridge errors below are preserved as separate owner actions.
Other than unknown Instagram diagnostic text, no raw upstream message is exposed.

| Errcode | Upstream error meaning / text |
| --- | --- |
| `FI.MAU.META_MISSING_COOKIES` | Missing cookies |
| `FI.MAU.META_CHALLENGE_ERROR` | Challenge required; check official website/app and retry |
| `FI.MAU.META_CONSENT_ERROR` | Consent required; check official website/app and retry |
| `FI.MAU.META_CHECKPOINT_ERROR` | Checkpoint required; check official website/app and retry |
| `FI.MAU.META_TOKEN_ERROR` | Got logged out immediately |
| `FI.MAU.META_AFAD_STOPPED` | Approval request expired or was denied |
| `FI.MAU.META_ACCOUNT_RECOVERY_REQUIRED` | Account Recovery required, not a two-factor code |
| `FI.MAU.META_OAUTH_MANDATORY` | Google sign-in required but unsupported |
| `FI.MAU.META_NO_SUPPORTED_MFA` | None of the available MFA methods are supported |
| `FI.MAU.META_GOOGLE_RECAPTCHA` | Google reCAPTCHA required but unsupported |
| `FI.MAU.META_NO_SMS_AVAILABLE` | Meta is refusing to send SMS codes right now |
| `FI.MAU.META_PASSKEY_MANDATORY` | Passkey sign-in required but unsupported |
| `FI.MAU.META_TOKEN_EXCHANGE_FAILED` | Temporary credential could not be exchanged for a usable session |
| `FI.MAU.META_RATE_LIMITED` | Temporarily rate-limiting login attempts from this network |
| `FI.MAU.META_ACCOUNT_SUSPENDED` | Instagram reports that this account is suspended |
| `FI.MAU.META_ACCOUNT_PENDING_DELETION` | Account scheduled for deletion; review in Instagram |
| `FI.MAU.META_INBOX_LOAD_FAILED` | Error loading messages after login |
| `FI.MAU.META_UNINFORMATIVE_ERROR` | Variable provider rejection message; underlying callsite stays internal |
| `FI.MAU.META_UNSUPPORTED_CAA_STEP` | Instagram returned a sign-in step this bridge cannot safely complete |
| `FI.MAU.META_CAA_FAILED` | Instagram couldn't complete this sign-in step. Try again. |
| `FI.MAU.META_CAA_CLIENT_HTTP_FAILED` | Instagram couldn't complete this sign-in step. Try again. |
| `FI.MAU.IG_MISSING_AUTH` | Native auth token missing after login. Please try again. |
| `FI.MAU.IG_CAA_FALLBACK_DISABLED` | Instagram returned an unexpected verification step. |
| `FI.MAU.META_UNSUPPORTED_WEB_CHECKPOINT` | Verification step unsupported; finish in Instagram then start a new login |
| `FI.MAU.META_WEB_CHECKPOINT_CAPTCHA` | Interactive CAPTCHA required; this login flow cannot display it yet |
| `FI.MAU.META_WEB_CHECKPOINT_FAILED` | Verification request did not complete; start anew when connection is stable |

`M_UNKNOWN` can be internal bridge failure. Unknown `error` text is surfaced only
for Instagram, after redacting current submitted values and previous-step secret
hash matches, URL/HTML encodings, URLs, contact identifiers, headers, cookie pairs,
long opaque tokens, long numbers, controls and markup. Structured/oversized dumps
are discarded. The owner message is capped at 300 upstream characters. Raw bridge
responses are never logged. Ephemeral hashes are scoped to the login ID, bounded,
and removed on cancellation/completion or pruned after 20 minutes of inactivity;
no submitted plaintext is retained by this redaction cache.

## Diagnosis: evidence versus hypotheses

1. **Proven local defect:** `LocalOwnerSender` discarded `error` and collapsed
   unmapped 400/401/403 login responses to the generic message James saw. The
   screenshot cannot distinguish wrong credentials from any other rejection.
2. **Strong integration gap:** our allowlist omitted `instagram`, the pinned
   bridge's browser-cookie flow. Unsafe password steps had no useful way out.
   The repaired flow offers the owner-controlled browser route first.
3. **Plausible upstream verification/login instability:** the released version
   added Android password login; later main changes improve checkpoint redirects,
   rejected web-login handoffs, CAPTCHA retries, risky-contact warnings, rate-limit
   handling and web-code instructions. These prove this area is changing, not that
   any one change explains James's rejection:
   [checkpoint](https://github.com/mautrix/meta/commit/2e7f46f1597af0e538e96c35e918b91987a8bb40),
   [rejected web login](https://github.com/mautrix/meta/commit/98c43be8707c23467cfcf71ce39e72c14bb65d7d),
   [CAPTCHA retry](https://github.com/mautrix/meta/commit/626af8b9b1b1d8289e597a681debe34f05e32a82),
   [rate limit](https://github.com/mautrix/meta/commit/06df240eb0b64a531b6112b4b005e3ce1551a4da).
4. **Unresolved possibilities:** incorrect password/code, account recovery,
   checkpoint, consent, suspension/deletion, network rate limiting or bridge-side
   failure. No owner logs, databases, environment values or login endpoints were
   inspected, and no credentials/cookies were requested or submitted.

[Issue 304](https://github.com/mautrix/meta/issues/304) concerns using the wrong
(non-`ig-`) image, not proof of this owner's problem. The repository's Instagram
pin explicitly records the correct image. [Issue 97](https://github.com/mautrix/meta/issues/97)
is from 2024 and is not evidence about v0.2610.0 password login.

## Release decision and verification

[Latest stable release](https://github.com/mautrix/meta/releases/tag/v0.2610.0)
as checked for this repair is still v0.2610.0, published 2026-10-16. No newer
stable release to pin was found. **No bridge/image/provenance bump is made.**
Do not silently substitute unversioned main/ig-latest for the audited pin.

Focused VPS execution passes: six Instagram Python tests; all 46 existing
connector Python tests; 11 synthetic JS login runtime scenarios; connector view
JS test; browser-harness syntax; whitespace checks. Broader Python discovery ran
410 tests but is not green: missing test-only pytest/PyYAML, three pre-existing
release-lifecycle four-image assumptions, and an unrelated album media fixture.
These are outside this repair; it does not edit release recipes or album code.

`INSTAGRAM_SETUP_ONLY=1 node tests/account_setup_browser.cjs <evidence-dir>` is
forum-only browser acceptance, with public-source iframe shell, synthetic API
responses, no provider navigation and no owner data. It captures phone and
desktop options, cookie instructions/draft, masked code and approval views in two
skins with live changes. It is not a real Instagram account-linking certificate.
No image, release packet, restart, update or installation is performed by this lane.
