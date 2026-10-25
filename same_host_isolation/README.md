# Same-host, container-enforced read/draft-only reference

**Executable, TEST-ONLY fixture; not deployed into Messenger or Hermes.** One trusted physical server is sufficient. The trust boundary is the restricted agent's authority, not physical hardware. This candidate does not change Oscar's current permissions, service, tools, credentials, accounts or configuration.

## Trust model / deployment diagram

```text
SAME TRUSTED HOST (owner administration / Docker daemon / kernel)
│
├─ owner host console → owner-client container (UID 10001, network none)
│                       └─ OWNER volume, read-only → /owner/control.sock
│                          inspect / policy / freeze / approve
│                                        │
├─ immutable broker + TEST-ONLY sender (UID 10001, network none)
│  read-only source/root; cap-drop ALL; no-new-privileges
│  ├─ OWNER volume (0700; socket 0600) ────┘
│  ├─ AGENT volume (0755; socket 0666)
│  └─ private STATE volume (0700): fixture key, drafts, fixture ledger
│                ▲
├─ AGENT volume, read-only → /agent/broker.sock
│                │  bounded JSON: read / create / update only
└─ UNTRUSTED WORKER container (UID 10002; arbitrary Python attacker)
   network NONE; own PID/IPC namespace; read-only root/source/socket mount
   cap-drop ALL; no-new-privileges; default seccomp; CPU/RAM/PID limits
   NO owner volume, state volume, host home, Docker/SSH socket, credentials,
   owner session, provider token, host gateway, extra hosts or host network
```

The Docker host console running `deployment.py` is **trusted owner administration**, not part of the worker. The proof deliberately exercises Docker from this console to construct the boundary; restricted worker code cannot call back into that host console. The worker may read all reference source, including the owner client: source secrecy is not the enforcement mechanism. Ownership, distinct socket mounts, endpoint allowlists and absent network/admin paths are.

The broker is immutable **to the worker**, not to the trusted owner/host. Rootless Docker is the tested engine. Its socket still gives this host user the ability to mount that user's files or replace this deployment; do not grant it to the worker. Rootful Docker would carry still greater host authority. A trusted host admin intentionally changing mounts, code, ownership, policy or using Docker exec is an administrative bypass outside the boundary—not a kernel exploit. Kernel/container-runtime vulnerabilities remain a separate residual risk; no proof here establishes resistance to those, hostile co-tenants or side channels. A separate host can reduce shared-kernel risk, but is not required to enforce these application permissions against a non-admin sandbox.

## Run the real Docker proof

From the repository root, with Docker already available:

```sh
python3 same_host_isolation/proof.py
```

No builds, installs, pulls, public network, provider calls, real accounts, messages or spending. Uses the existing local `python:3.12-slim` image, resolves it once to a content-addressed image ID, and passes `--pull=never`. Override only from the **trusted owner console** with `SAME_HOST_IMAGE=<existing-local-python-image>` when necessary. The tested ID is recorded in `proof-output.txt`; a different ID needs its own evidence.

`deployment.py` is the executable topology, not a diagram-only proposal. It creates UUID-prefixed named volumes and containers, initializes namespace ownership in a throwaway no-network container, then runs broker, worker and owner client. The initializer briefly has CHOWN/FOWNER only; the worker, broker and owner client have no capabilities. No Docker socket or host home is mounted. Source is bound read-only. There is no Compose dependency or Rust build. Socket volume mounts are read-only for clients: Unix socket connection remains possible, while file replacement is forbidden.

The proof inspects the actual worker configuration and runs attacker Python **inside that container**. It verifies:

- Initial No access blocks read/create; Read-only allows fixture read but blocks create/update; Draft-only allows read/create/update. Each owner policy change and each draft mutation is read back.
- Worker send/approve/freeze/policy/inspect/exec/upload/proxy/schema-smuggling requests are denied, including correctly shaped authority requests. There is no arbitrary command, upload, URL-fetch, Matrix token or HTTP-proxy operation on the broker.
- Worker cannot read fixture key/state, host home/SSH/app paths, Docker socket or owner socket; cannot connect owner/Docker sockets; cannot write code/socket mount; has no provider/owner credential environment, sudo or Docker binary, has zero capabilities, seccomp and no-new-privileges; cannot mount or reach host gateway/metadata/Internet or host loopback services.
- Actual fixture ledger is empty after all worker attacks. Owner reads the exact draft over its **separate socket**, computes a digest independently, freezes revision/content, and approves exactly that frozen draft. Stale/wrong approvals and post-freeze worker edits fail. One owner-authored fixture ledger event is read back, with retry deduplication.
- Unsupported Full access is rejected. Policy is restored to No access, restart also fails closed to No access while retaining the fixture ledger, and exact test resource names are removed and absence read back. No global Docker prune, shared service restart or existing volume removal occurs.

`proof-output.txt` is captured real execution output, not sample output. It is fixture evidence, **not a proof of whole Hermes confinement or real provider delivery**.

## Interactive reference deployment (test-only)

```sh
python3 same_host_isolation/fixture.py
```

Enter host-console JSON (this is the independent owner session; never give its stdin to the agent):

```json
{"role":"owner","request":{"op":"inspect"}}
{"role":"owner","request":{"op":"policy","mode":"draft-only"}}
{"role":"worker","request":{"op":"create","recipient":"fixture:alice","body":"Review this exact fixture draft"}}
```

Enter `review 1` to independently read the draft via the owner socket and compute its digest. Read the recipient, body and revision yourself. Then send the following **on the host owner console only**, substituting the reviewed digest verbatim:

```json
{"role":"owner","request":{"op":"freeze","id":"1","revision":1,"digest":"<reviewed digest>"}}
{"role":"owner","request":{"op":"approve","id":"1","digest":"<same reviewed digest>"}}
{"role":"owner","request":{"op":"inspect"}}
{"role":"owner","request":{"op":"policy","mode":"no-access"}}
```

The host can additionally run the printed worker container's `/code/attack.py` via Docker exec, as in the automated proof. It is **not** an instruction to give the restricted runtime Docker access. Ctrl-D/Ctrl-C restores No access and destroys only this run's containers/volumes. On forced termination/host failure, remove only names with the printed unique `messenger-same-host-<id>` prefix after verifying them; do not prune. All fixture state is disposable. The owner socket's mount is the owner capability; no reusable bearer, password or owner secret is passed to the worker. This local owner-console authentication is not a WebAuthn/browser implementation.

## Policy and protocol

| Owner policy | Worker read | Worker create/update | Worker send/admin |
|---|---|---|---|
| `no-access` (default; reset at broker start) | deny | deny | deny |
| `read-only` | allow | deny | deny |
| `draft-only` | allow | allow unfrozen drafts | deny |
| Full access | **not implemented** | — | — |

Full access is optional and deliberately omitted. Adding it would explicitly grant the agent send capability and invalidate the read/draft-only send guarantee while enabled; it must require a separate owner-controlled opt-in, never worker self-elevation.

Both sockets accept one bounded JSON object/newline per connection (16 KiB input; 3-second read timeout); extra fields/unknown operations fail closed. Text and recipient are data only (8192/256-character limits). No attachments, remote URLs, provider accounts, execution, filesystem paths, downloads or uploads are accepted as capabilities. Fixture recipient strings are deliberately not real provider identifiers. Drafts bind exact recipient/body/revision under a lock. An owner freeze rejects stale revisions/digests; a frozen/sent draft cannot be edited. Approval takes ID plus exact digest, not replacement recipient/body. Fixture ledger append and sent status persist together before reply, so an identical owner retry returns already-sent rather than another event.

This small JSON store uses atomic file replacement, not crash-proof provider transactions. There are per-request but no aggregate storage/rate quotas. Thread/volume exhaustion remains possible; fail-closed denial is not DoS resistance. Production needs quotas, durable database/fsync semantics, request IDs for create/retry recovery, full crash/response-loss/concurrency acceptance, narrow fixed provider/account/destination adapters, and independently reviewed owner UI/session authentication. The fixture key is generated randomly in the private state volume, prefixed `TEST-ONLY-`, never printed and never provided to worker. It only gates fixture ledger insertion. There is **no live delivery backend**.

## Relationship to the preserved candidate

Base: `4c8c153e67c30d01001589653e9d4071b436ddee`. Existing `isolated_sender/` and main Messenger files remain unchanged. This reference reuses their exact-envelope/freeze/owner-approval separation concept but does not import their TLS/WebAuthn/provider stack into a small offline Docker proof. Their provider adapter is **not exercised** here. Existing documentation describing an independent physical host as mandatory assumes an agent retaining Wizard host-root/admin authority. For this restricted-runtime topology that physical-host requirement does not apply; the required condition is independent **trusted administration outside the sandbox**. See `HOST-ADMIN-PATHS.md` for the current bypass inventory and migration gates.

## Before any real cutover (not authorized / not performed)

1. Place **the entire agent and every tool executor**, not merely terminal commands, inside the restricted runtime. Use a fresh restricted profile/environment, never mount Oscar's existing home or forward its ambient environment.
2. Remove every current bypass listed in `HOST-ADMIN-PATHS.md`; revoke/move send-capable app/bridge credentials to trusted storage. No unrestricted fallback backend, SSH, browser session, delegator or cloud management route may remain reachable.
3. Keep owner console/UI and policy/session authentication outside the runtime. A browser owned by the agent is not the owner channel. Bind owner approval to trusted exact content and, for browser use, independent owner authentication/UV as appropriate.
4. Replace fixtures only with reviewed fixed-operation read and send adapters, credentials solely in trusted storage, fixed accounts/destinations, no generic provider API or provisioning proxy. Independently test live providers under separate owner authorization; do not infer provider support from this ledger.
5. Rehearse the same adversarial tests against the complete restricted Hermes tool registry and actual deployment image. Account for browser/file/network/SSH/provider/delegation tools and descendants, not only the terminal backend. A host-side tool that honors worker instructions is a confused-deputy bypass even if worker containers have no network.
6. Only then consider an explicitly approved live cutover with rollback and owner acceptance. Current Oscar remains host-admin-capable; this local candidate does not restrict it.
