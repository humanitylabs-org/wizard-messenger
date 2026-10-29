# Owner ingress for Tailscale Serve (optional)

A small gateway that lets Tailscale Serve act as the authenticated outer
gateway for `TRUSTED-WIZARD-OWNER.md`, without trusting forgeable headers.

## Trust boundary

- `tools/owner_ingress.py` listens only on a Unix socket. Before parsing any
  header it requires Linux `SO_PEERCRED` UID/GID 0 and exactly the current
  `tailscaled.service` MainPID (procfs owner/comm must agree). A local process
  that forges identity headers is rejected even if it owns the socket.
- Only after that does it accept Serve's identity, pinned to one configured
  owner login and exact configured hosts. Missing, other-user or tagged-node
  identity fails closed.
- Serve's Unix proxy rewrites `Host` to `localhost` and overwrites
  `X-Forwarded-Host` with the original authority; the gateway restores the
  canonical Host only for this verified peer.
- Origin must be exact same-host HTTPS for mutations; cross-site fetches,
  duplicate Host/identity/Origin headers and any `Authorization` are denied.
  Client identity/proxy/proof headers are scrubbed and a fresh HMAC proof is
  minted per request. Nothing secret is logged.
- `owner_unix.py` adds a second Unix listener to the *same* app server state
  (vault, sessions, CSRF, inbox, permissions). The normal TCP route and its
  bearer policies are unchanged.

## Layout

```
~/.wizard-os/messenger-owner/        0700
  ingress.sock                      0600  (gateway listens)
  config.json                       0600  socket, backend_socket, proof_file, owner_login, hosts
  proof                             0600  proof key (gateway copy)
  app-secrets/                      bind read-only to /run/secrets
    messenger-owner-proof           app uid, 0400, same bytes as proof
    messenger-owner-wrap            app uid, 0400, independent random bytes
  backend/                          bind to /run/owner-hop (inside the 0700 parent)
    messenger.sock                  created by the app
```

The gateway never receives the wrapping key.

## Activation

1. Back up through the normal app lifecycle; set the env from
   `TRUSTED-WIZARD-OWNER.md` plus `MESSENGER_OWNER_SOCKET` and the two mounts.
2. Run the gateway as a user service (`UMask=0077`, `NoNewPrivileges=yes`):
   `python3 tools/owner_ingress.py --config <private>/config.json`.
3. Serving a Unix socket path needs root or a Tailscale operator:

```
sudo tailscale serve --bg --https=<port> --set-path=/messenger/ unix:$HOME/.wizard-os/messenger-owner/ingress.sock
```

4. Read back the full Serve config (only the Messenger handler changed), then
   probe forged/replayed proof, `Authorization`, bad Host/Origin and a non-root
   socket client.

Rollback: point the Serve handler back to the app's loopback port and unset the
env. Keep the vault, identity and history.

Why not WhoIs or mTLS: WhoIs cannot recover the remote peer from a loopback HTTP
hop without trusted transport metadata, and Serve does not offer client
certificates to backends.
