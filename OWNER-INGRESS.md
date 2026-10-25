# Private authenticated Messenger ingress — operational handoff

**Not deployed.** This branch merges `31a0abc9e3fefb973e1f57884373cc79bd928579`
onto the observed live `b3aa45d6d6a7682d85b38946800481ee34a23e9b` baseline.
No public publication or default-install change. Preserve any later live baseline
before deploying this candidate.

## Concrete external privilege gate

Installed Tailscale **1.102.3** advertises `serve unix:/path/socket`, but the
actual daemon rejects a scoped Messenger Unix route:

```
sending serve config: 401 Unauthorized: must be root, or be an operator and able to run 'sudo tailscale' to serve a path or Unix socket
```

`sudo -n true`, `sudo -n -l`, and `sudo -n tailscale serve status --json` all
require a password. No privilege bypass was attempted. No production route,
configuration or image was changed. The attempted temporary
`/messenger/__transport_probe/` handler was never installed. Its transient user
service was stopped. This is not yet a successful live tailscaled peer proof.

A privileged operator must perform only the scoped Serve Unix route operations
below after the unprivileged service has been staged and read back. Do not
change ACLs, Funnel, operator policy, network-wide auth or the entire shell.

## Trust boundary

`tools/owner_ingress.py` listens on Unix only. Linux SO_PEERCRED must report
UID/GID 0 and exactly systemd's current `tailscaled.service` MainPID; procfs
ownership/comm must agree. The check runs before request headers are parsed.
A local caller with forged identity headers is rejected even if it is the
socket's owner. Socket and its parent are private (0600/0700).

Only after that peer is verified does the gateway accept Serve's transport
identity, pinned to the already observed Self owner login
`miguel@askmiguel.ai`, and exact hosts `oscarvps.tail6adf1a.ts.net:8444` / `:8796`.
Serve must be verified live to overwrite spoofed Tailscale identity and omit
user identity for tagged/service nodes; do not enable production on fixtures
alone. Missing/other/tag identity fails closed. Never infer identity from a
caller-supplied arbitrary header or a loopback TCP connection.

Origin is exact HTTPS same-host, mandatory for mutations; cross-site/same-site
fetches, duplicate Host/identity/Origin/fetch headers and any Authorization
header are denied. Caller identity, proxy and proof headers are scrubbed. A
fresh method/exact-target/query HMAC is minted for each forwarded request.
No password, request body, identity token or enrollment capability is logged.

`owner_unix.py` adds a separate Unix listener to the *same* ViewServer object
state: same encrypted vault, replay cache, sessions, CSRF, engine, inbox and
permission authority. It does not initialize a second account or engine.
The regular machine TCP route remains subject to unchanged bearer policies.
The host gateway talks to the app over the private Unix hop, not TCP.

Rootless Docker UID translation requires the backend socket 0666 **inside a
host-private 0700 parent**. Recommended layout:

```
~/.wizard-os/messenger-owner/             oscar:oscar 0700
  ingress.sock                          oscar:oscar 0600
  config.json                           oscar:oscar 0600
  proof                                 oscar:oscar 0600
  app-secrets/                          private; bind read-only to /run/secrets
    messenger-owner-proof               app UID1000 0400, same proof bytes
    messenger-owner-wrap                app UID1000 0400, independent random bytes
  backend/                              0777 inside private parent; bind to /run/owner-hop
    messenger.sock                      app UID1000 0666
```

Create app-owned files via the rootless container namespace without printing
secret bytes. The host gateway receives **only** the proof key; never the wrap
key. App keys remain outside `/data`. Do not put keys into source, receipts,
environment values or chat. Retain a separate private wrap-key backup.
The host administrator is trusted; this is not whole-agent confinement.

## Supported deployment sequence (not yet executed)

1. Re-read live image/revision and existing user configuration. Coordinate with
   concurrent Messenger release lanes and compare baseline again immediately
   before applying. Keep all later Inbox/history/provider changes.
2. Back up persistent app data using WAM/Runtipi lifecycle and read back the
   completed backup. Save all app/user config and current Serve JSON privately.
   Do not overlap backup and lifecycle update.
3. Build immutable source with the verified live image for both runtime/MDK
   bases; run tests plus packaged provider proof. Ensure static dirs/files are
   traversable/readable by app UID1000.
4. Provision independent keys and private hop mounts. Preserve every unrelated
   service/env/volume in supported user configuration. Add to **messenger only**:
   `MESSENGER_TRUST_WIZARD_OWNER=1`,
   `MESSENGER_OWNER_PROOF_KEY_FILE=/run/secrets/messenger-owner-proof`,
   `MESSENGER_OWNER_WRAP_KEY_FILE=/run/secrets/messenger-owner-wrap`,
   `MESSENGER_OWNER_SOCKET=/run/owner-hop/messenger.sock`.
   Apply the image through supported per-app lifecycle; never reset account data.
5. Start a user systemd gateway service with `UMask=0077`, `NoNewPrivileges=yes`,
   `Restart=on-failure`, `ExecStart=/usr/bin/python3 <immutable>/tools/owner_ingress.py
   --config <private>/config.json`. Config fields are `socket`, `backend_socket`,
   `proof_file`, `owner_login`, `hosts`; no plaintext secrets. Verify its actual
   socket modes and local spoof rejection.
6. A privileged operator first installs a temporary path under `/messenger/`
   pointing at this socket, verifies real HTTPS certificate validation, trusted
   tailscaled UID/GID/PID, actual owner acceptance and spoof scrubbing, and removes
   that temporary path. Then switches only these two handlers:

```
sudo tailscale serve --bg --https=8444 --set-path=/messenger/ unix:/home/oscar/.wizard-os/messenger-owner/ingress.sock
sudo tailscale serve --bg --https=8796 --set-path=/messenger/ unix:/home/oscar/.wizard-os/messenger-owner/ingress.sock
```

7. Read back the exact Serve config and ensure every non-Messenger handler is
   unchanged. Verify HTTPS assets against running container bytes, healthy image,
   private auth files, independent key mounts, current permission mode and
   count-only account/history state. Probe missing/forged/replayed proof,
   Authorization, bad Host/Origin/fetch metadata and nonroot socket ingress.
   Real Tailscale outer logout/other-user/tagged node checks require actual
   corresponding transport contexts, not forged headers. Never consume real
   enrollment, read passwords or send messages in QA.
8. Only after those live checks is the owner's remaining action one normal
   existing-password unlock with explicit unchecked-by-default **Remember this
   Wizard**. The original encrypted vault/history is retained. Lock forgets it.

Rollback first restores only the two prior Messenger Serve handlers, then uses
supported app lifecycle to restore prior image/config. Do not remove or overwrite
owner enrollment, identity, keyring, history or account data. This document does
not claim any of these deployment steps have been executed.

## Why WhoIs / mTLS does not remove this privilege gate

Tailscale WhoIs can authenticate a real peer's Tailscale source connection. It
cannot recover the original remote peer from the existing localhost:9245 Serve
HTTP connection without trusted transport metadata. Looking up a caller-supplied
forwarded address, or the host's own Tailscale address, would grant local agents
owner authority and is not a fallback. Serve's advertised HTTPS backend targets
do not advertise a client-certificate provisioning option; server TLS alone
does not authenticate tailscaled to the backend. A separate mTLS client/owner
credential would introduce a new external provisioning/enrollment dependency.
The supported Unix ingress is available; its activation is blocked by the
verified root-only daemon policy, not by missing integration code.
