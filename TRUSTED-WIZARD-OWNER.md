# Trusted Wizard owner unlock (optional, off by default)

On a Wizard the owner already signs in to, Messenger's own passphrase prompt is a
second password for the same person. This opt-in lets an authenticated Wizard
owner reopen Messenger without that extra password, including after a restart.
Default installs are unchanged.

## How it works

- The GNOME Secret Service vault stays encrypted by the owner's existing
  passphrase. A server-side verifier cannot decrypt it, so the owner unlocks
  **once** with the existing passphrase and ticks **Remember this Wizard**
  (unchecked by default). No reset, new identity or enrollment.
- The server verifies the passphrase, opens the original vault, then wraps that
  same passphrase with AES-256-GCM under an independent host-held wrapping key.
  The only new data file is `trusted-owner-unlock.json` (0600): nonce,
  ciphertext and tag, bound to the current browser credential record. No
  plaintext passphrase is stored.
- Afterwards each request must carry a fresh HMAC proof from the authenticated
  outer gateway (method + exact target + timestamp + one-use nonce, 30-second
  window). Messenger checks it on every non-machine API request, even when an
  app cookie exists. A valid proof plus the envelope reopens the vault.
- **Lock** deletes the envelope, clears app sessions and locks the vault; the
  next open needs the passphrase again. A wrong, tampered or missing key or
  envelope fails closed and falls back to the normal passphrase unlock.
- Bearer tokens never gain owner authority: any request with `Authorization`
  is refused on the trusted-owner, session and unlock routes, and machine
  access policies are unchanged.

## Enabling it on one install

Per-app user configuration for the `messenger` service only:

```text
MESSENGER_TRUST_WIZARD_OWNER=1
MESSENGER_OWNER_PROOF_KEY_FILE=/run/secrets/messenger-owner-proof
MESSENGER_OWNER_WRAP_KEY_FILE=/run/secrets/messenger-owner-wrap
# optional, see OWNER-INGRESS.md
MESSENGER_OWNER_SOCKET=/run/owner-hop/messenger.sock
```

Provision two **different** random 32-byte files outside `/data`, mounted
read-only and readable only by the app user. Only the proof key goes to the
gateway; the wrapping key never leaves the app. The app refuses symlinks,
overpermissive files, identical keys, keys inside its data root and
remote-authority configurations. Losing the wrapping key only means remembering
again with the existing passphrase.

## Gateway contract

The gateway must resolve the real owner with its own authentication (reject
anonymous, service, agent and auth-mode-none principals), strip any
client-supplied proof/identity headers, never sign a request that carries
`Authorization`, and sign every forwarded request with
`tools/trusted_owner_gateway.mjs:messengerOwnerHeaders`. Never derive the owner
from Tailscale identity headers, Origin, Host, a loopback peer or an app token.
`OWNER-INGRESS.md` describes a ready-made gateway for Tailscale Serve.

The replay cache is process-local: do not load-balance several app processes
with one proof key.

## Tests

- `tests/test_trusted_owner.py`: HTTP handler tests with synthetic engines,
  real AES-GCM, restart persistence, Lock, corrupt envelope and permission
  checks.
- `tests/test_trusted_owner_gateway.mjs`: signing only for a trusted principal,
  proof stripping, Authorization denial, exact method/query.
- `tests/trusted_owner_browser_fixture.py` + `tests/trusted_owner_browser.cjs`:
  real served HTML/JS through a synthetic authenticated gateway in Chromium:
  explicit remember, cleared fields, reload, backend restart, missing app
  cookie, outer logout denial.
- `tests/trusted_owner_provider_proof.py`: inside the packaged image with
  `--network=none`, the real GNOME provider survives shutdown and reopens via
  the remembered envelope (MDK stubbed; no real account).

Limits: this is application-level separation between machine and owner, not
confinement against a host administrator who can read process memory or the
host key files.
