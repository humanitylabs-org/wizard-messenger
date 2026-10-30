# Miguel-only trusted Wizard owner access (private candidate)

**Not deployed. Do not enable on James/default installations.** This is an
explicit local override, not a new public default or an owner-account migration.

## Discovery and owner action

Baseline: `b9d8488f09ac710e94f006d3554c31410641a8c6`, live image
`wizard-messenger:repair-b9d8488`. Existing browser sessions last 30 days, but the
GNOME Secret Service vault is encrypted by the owner's existing passphrase and
is locked after process/container restart. Native phone-vault and WebAuthn PRF
fingerprint unlock already exist; there is no existing trusted-Wizard setting.
A server-side password verifier cannot decrypt that vault.

Consequently **one owner-controlled unlock with the existing passphrase is
necessary**. Do not reset/change the passphrase, create another identity or
consume an enrollment link. The existing encrypted keyring and history are
unchanged. Once the local feature and trusted gateway are installed, the owner
checks **Remember this Wizard** (unchecked by default) while unlocking. The
server verifies the passphrase, opens the original vault, then wraps that same
passphrase using AES-256-GCM and an independent host-held wrapping key. No
plaintext passphrase is saved. The envelope is private and credential-bound.

After that, an authenticated Wizard owner can reopen Messenger without its
extra password, including after restart and with no Messenger cookie. Lock
removes the envelope durably, clears app sessions, and locks the original vault;
the next open requires the existing passphrase again. A wrong/tampered/missing
wrapping key or envelope fails closed and permits manual unlock; nothing is reset.

## Required trusted gateway integration — deployment gate

App-only deployment is **not sufficient**. A normal proxy, arbitrary identity
headers, a loopback peer and merely being on Tailscale do not prove the owner.

The authenticated Wizard gateway must:

1. Resolve the real outer principal using its existing independent owner
   authentication. Reject anonymous/service/agent and auth-mode-none `box_only`
   principals. Preserve outer sign-in/sign-out and configured origin/host checks.
2. Strip client-supplied `X-Messenger-Owner-Proof` and identity/proxy proof headers.
   Never sign a request carrying **any** Authorization header, even alongside an
   owner session. Keep agent/MCP calls on their existing machine-capability path.
3. After stripping the `/messenger/` prefix, call
   `tools/trusted_owner_gateway.mjs:messengerOwnerHeaders` with the trusted
   resolver's `{kind:'owner', via:'proxy_proof'|'access_verifier'}` principal,
   forwarded method, exact backend target including query, filtered headers,
   and the dedicated 32-byte proof key. A client JSON/header flag must never
   construct this principal. Sign separately on every forwarded request.
4. Preserve the browser Origin and Sec-Fetch-Site. Serve the app only through
   the authenticated HTTPS Wizard route. Use a private isolated network or TLS
   on the gateway-to-app connection, with no untrusted access to the proof key
   or plaintext internal traffic. The proof signs method/target, not body bytes;
   it is an authenticated internal hop, not an internet bearer protocol.
5. Require outer owner authentication on **every** app view/API request, not
   only login. Messenger also verifies the proof on every non-machine API
   request, including those with an existing app cookie. It checks a 30-second
   timestamp window, method/target HMAC-SHA256, and a bounded one-use nonce cache.
   The cache is process-local: do not load-balance multiple app processes with
   one proof key without a shared replay cache. Gate the static route too at
   the outer proxy (Messenger static assets themselves remain public).

The helper is an integration component, not a replacement authentication server.
The actual owner Wizard gateway has **not** been changed or exercised by these
isolated tests. Its verified owner-resolution hook must be wired and reviewed
before enabling the override. Never sign directly from Tailscale identity headers,
Origin, Host, an app API token, an agent gateway principal, or `owner=true`.

## Private per-install configuration

Use supported WAM/Runtipi per-app user configuration, preserving every unrelated
`appEnv`/`dockerCompose` entry and the existing persistent mount. Do not edit
manager-generated Compose, the app registry or a public catalog.

Only Miguel's instance gets:

```text
MESSENGER_TRUST_WIZARD_OWNER=1
MESSENGER_OWNER_PROOF_KEY_FILE=/run/secrets/messenger-owner-proof
MESSENGER_OWNER_WRAP_KEY_FILE=/run/secrets/messenger-owner-wrap
```

Provision **two different random 32-byte binary files** through a private operator
path. Never put their values in env, chat, a report, source control or logs. They
must not reuse the machine token. Mount both read-only outside `/data`, readable
only by Messenger UID 1000 (0400/0600); give only the proof key to the trusted
outer gateway. The wrapping key must not be mounted in the gateway or agent.
The app refuses symlinks, overpermissive key files, same keys, keys below its data
root and remote-authority configurations. Keep wrapping-key backup separate
from app-data backups. Loss of it requires remembering again with the **existing**
passphrase, not an account reset. Rotate the proof key independently as needed.

The only new app-data artifact is `trusted-owner-unlock.json` (0600), containing
an AES-GCM nonce/ciphertext/tag, authenticated against the current browser
credential record. It contains no owner private key or plaintext password.

Build from this isolated exact revision, reusing the verified repair image for
both prebuilt MDK and runtime base to avoid an unrelated Rust/dependency upgrade:

```sh
docker build \
  --build-arg MDK_BUILD_IMAGE=wizard-messenger:repair-b9d8488 \
  --build-arg MESSENGER_RUNTIME_BASE=wizard-messenger:repair-b9d8488 \
  --label org.opencontainers.image.revision="$(git rev-parse HEAD)" \
  --label org.opencontainers.image.version=0.2.0-unified.11.7-miguel.trusted1 \
  -t wizard-messenger:trusted-owner-<revision> .
```

The explicit packaging adds `trusted_owner.py` and Debian's
`python3-cryptography`; default mode does not import its crypto dependency at
runtime. Do not use a static-assets-only image for this backend change.

Before any future deployment: backup through supported lifecycle, preserve
private user config, wire/test the real gateway hook, verify independent keys
and private mounts, then update only Miguel's immutable local image. Read back
image/revision, live asset hashes, permissions and HTTPS behavior; verify machine
No access, Read-only, Draft-only, Draft-and-send remain distinct. Actual owner
remember enrollment is an owner UI action, not an agent browser test. No
publication or deployment was authorized in this task.

Rollback: disable the local flag/remove the gateway injection and restore the
previous local image through supported lifecycle. Remove only the remembered
unlock envelope if revoking the opt-in. Keep original keyring, browser verifier,
identity and all history. Do not overwrite or delete any real enrollment file.

## Tests and limits

- `tests/test_trusted_owner.py`: actual HTTP handler tests with synthetic engines,
  independent keys, real AES-GCM, persistent restart and permission regressions.
- `tests/test_trusted_owner_gateway.mjs`: trusted-principal-only signing, client
  proof stripping, Authorization denial, exact method/query protocol.
- `tests/trusted_owner_browser_fixture.py` launches actual served Messenger
  HTML/JS and backend through an isolated synthetic authenticated gateway.
  `tests/trusted_owner_browser.cjs` exercises explicit remember, cleared fields,
  reload, backend restart, missing app cookie, and outer logout denial in Chromium.
  The outer authentication, empty inbox and shell client are explicitly fixtures,
  not proof of the owner's live Wizard gateway, provider login or messaging.
- `tests/trusted_owner_provider_proof.py` runs inside a network-none packaged
  image and exercises the actual GNOME encrypted provider across shutdown and
  remembered unlock. MDK launch is stubbed: no real account, private key,
  messages, relay or enrollment capability is created or consumed.

This preserves application-level machine/owner permission separation, **not
whole-agent confinement** against a host administrator that can read process
memory or the host wrapping/proof key files. The convenience choice deliberately
lets the owner-authorized local app process recover the vault passphrase. Disk
and host compromise remain outside the retained GNOME-at-rest encryption claim.
Do not call it hardware-backed or passwordless cryptography.
