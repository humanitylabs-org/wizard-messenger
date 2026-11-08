# Owner signer (one-box private gateway)

`tools/owner_signer.mjs` is the "authenticated Wizard gateway" that `TRUSTED-WIZARD-OWNER.md` asks for, for a box whose
private gateway (Caddy) already receives the real tailnet peer through Tailscale Serve's PROXY protocol, but where the
App Manager owner edge cannot run (tailscaled is not root, so `tailscale serve unix:` is refused).

```
phone / desktop -> Caddy (PROXY v1 peer) -> signer (private Unix socket, 0600) -> Messenger 127.0.0.1:<port>
```

Per request it adds one fresh `X-Wizard-App-Owner-Proof` (`wizard-app-owner-v1`, bound to app id, method and exact
target) only when ALL hold: the peer address was set by the gateway on the private socket; tailscaled whois says the node
is untagged, owned by the pinned owner login, and its **stable node id** is in `owner_nodes` (agent servers are never
listed); there is no `Authorization` header; `Sec-Fetch-Site` is not `cross-site`. Everything else is forwarded **without**
a proof, so Messenger's own fail-closed rules answer it. Client-supplied proof, identity and peer headers are always removed.
Logs hold method, path with ids masked, and the verdict only.

Files (private, `~/.wizard-os/messenger-owner/`, 0700):

| file | use |
|---|---|
| `signer.json` | `{"owner_login": "...", "owner_nodes": ["<StableID>", ...]}` (edit, then restart the unit) |
| `proof` | 32-byte signing key (signer reads it) |
| `app-secrets/proof`, `app-secrets/wrap` | what Messenger mounts read-only at `/run/owner-secrets` (proof copy + independent wrap key) |

Messenger side: `MESSENGER_TRUST_WIZARD_OWNER=1`, `MESSENGER_OWNER_PROOF_KEY_FILE`, `MESSENGER_OWNER_WRAP_KEY_FILE`
(see TRUSTED-WIZARD-OWNER.md). The first unlock after enabling uses the existing passphrase (or the existing fingerprint)
once; Messenger then remembers it for the owner's devices. Lock removes it. Same-uid host processes can read the key, exactly as
with the owner edge: this is not a boundary against them.

Rollback: remove the three env lines and the mount from the Messenger override, point the Caddy `/messenger/` upstream back
at `127.0.0.1:<port>`, stop the unit. Nothing in Messenger's data changes.
