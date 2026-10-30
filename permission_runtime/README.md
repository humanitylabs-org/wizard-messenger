# Same-server scoped Messenger runtime

This is a real fixed-route HTTP adapter, not the `same_host_isolation` fixture authority. It talks to **normal Messenger** `/api/drafts` and conversation APIs using the app's machine bearer. Owner review/send continues through normal browser cookie + Origin + CSRF routes. The bearer is read only by the trusted broker; no cookie, provider token or bearer is returned to the worker.

## Runnable proof (no real messages)

From repository root, with the existing local `python:3.12-slim` image and an interpreter containing the official `mcp` SDK:

```sh
python3 permission_runtime/proof.py
```

The proof builds an offline local runtime image (no Rust build, pull, or package install), starts normal ViewServer + real Drafts/UnifiedInbox with a synthetic provider callback on an internal test network, then connects a **built-image** worker with only a read-only UDS named volume. No worker source/host bind mounts, network, host namespace, Docker socket, capabilities, owner credentials, or admin tools. Root is used only in a separate no-network volume-ownership initializer, never a worker or command relay.

It exercises official MCP SDK initialize/list/call, live reads, four policy levels, persisted drafts, denied send/react/typing/readreceipt/edit/delete/provision/approval/policy/proxy, exact owner HTTP edit/preview/click-send, wrong CSRF, live app policy stricter than broker ceiling, explicit agent Draft-and-send, exact callback readback, idempotency and revocation. It reuses the executable `same_host_isolation/attack.py` kernel/filesystem/network attacks, adding actual bearer/config/owner-file attempts. All resources are uniquely named and removed/read back. Exactly two **fixture callbacks**, not live deliveries: one owner click and one explicitly permitted agent send.

The normal app test server uses a trusted test-created cookie, not an invented public login endpoint. Independent owner enrollment/passphrase/CSRF behavior is separately exercised by the normal HTTP suites. The app fixture source is mounted only in the **trusted app container**, never worker/broker; worker and broker code are baked into the image.

## Broker protocol / scopes

One dedicated socket per agent; never share its volume with unrelated workers. Requests are JSON lines, exact `{op, arguments}`. There are no URLs, HTTP headers, methods, commands, owner flags, callbacks or arbitrary paths accepted from the worker. IDs are validated before fixed-route substitution. Request/response sizes and socket/HTTP deadlines are bounded. Errors do not reflect backend headers, bodies or credentials. Redirects are not followed. HTTPS verifies its default trust store.

`broker.example.json` holds an owner-configured **ceiling**: `no_access`, `read_only`, `draft_only`, `draft_and_send`. Unknown values deny everything. The broker reads the file on each request; an owner may atomically replace it to revoke a worker. The machine bearer still hits the app's live owner policy on every request, so either layer can deny. Expiry is enforced by the app. Configure a separate deployment/socket for each differently permitted agent. Current app policy is global; per-worker ceilings can be narrower, never broader.

Read: directory/person/conversation and drafts. Draft: create/update explicit person/channel/text/revision. Send mode: preview/send saved draft plus reaction, edit, delete, typing and read-receipt methods. No contacts/account administration, uploads, invitations, linking, setup, arbitrary request proxy or host execution. All declared tool methods use the same broker check; tools/list is a capability catalogue, not authority.

## Packaging and owner-controlled deployment

```sh
docker build --pull=false -t messenger-scoped-runtime:local permission_runtime
```

`compose.yml` supplies a broker + stdio worker using that image, separate ownership init, dedicated named socket volume, no worker network/mounts/admin credentials, and a broker-only token secret. It does **not** modify installed Messenger or join a network automatically. Owner sets:

- `MESSENGER_BROKER_CONFIG`: owner-controlled copy of `broker.example.json`; default ceiling No access.
- `MESSENGER_BROKER_TOKEN_FILE`: protected file with the existing app machine bearer, readable by broker UID 10001 (Compose file secrets do not remap file ownership).
- `MESSENGER_CONTROL_NETWORK`: existing private network containing normal Messenger. The fixed origin must resolve there. No published broker port.

The example uses plain HTTP only within the private local container network. Use HTTPS for other transport domains. This network is a trusted broker/app channel, not a place for untrusted workers. The owner browser uses the app's existing authenticated HTTPS surface. The configuration mount, app data and provider credentials never go in the worker.

No production `up` command is run by the proof. Compose worker is the actual MCP process; the supplied minimal image contains **no Hermes model runtime**. For a whole-agent deployment, bake these three client files into the approved Hermes image and use the same isolation flags/socket-only mount; do not give the worker Docker access to start its own client.

Inside an already confined Hermes worker, use supported native stdio MCP configuration (owner applies to that worker profile, not current Oscar):

```yaml
mcp_servers:
  messenger_scoped:
    command: python3
    args: [/code/mcp.py, /agent/broker.sock]
    sampling:
      enabled: false
```

No Hermes core patch/plugin is required. The executable is also directly runnable as `python3 /code/mcp.py /agent/broker.sock`. `docker exec` in the proof is an **external trusted test harness**, not an exposed helper/tool/relay and not the deployment's MCP configuration. Normal MCP tools take only scoped operation arguments.

## ACTIVE CUTOVER GATE — current Oscar is NOT confined

This branch deliberately does not alter current services, terminal backends, tools, profiles, credentials or installed Messenger. A safe deployment cutover must move the **complete actual agent and all tool/delegation runtimes** into the unprivileged runtime; remove ambient host/cloud/deploy/admin/browser-session access and all alternate network/provider send routes. Give only the dedicated socket. The supplied network-none worker needs a separately approved narrow model connection before it can run a real LLM conversation; an unrestricted host-command relay is forbidden. The current host-admin Oscar can bypass app policy and even replace containers: that remains real until owner-approved cutover removes it. A confined test worker is not proof that current Oscar or every Hermes tool is confined.

No extra physical server is required. Owner administration can remain on this server outside the worker. Login/pairing is only the future per-account provider delivery gate. Kernel vulnerabilities and malicious host owners are outside this container boundary; no claim of protection from host root.

## Integration

`permissions.py` / `drafts.py` carry the policy and local sender behavior. The targeted web/static patch is `plumbing/permission-runtime-integration.patch`; use it when integrating with another lane rather than replacing shared files. Apply **either** the integration commit or the patch, not both. App Dockerfile already packages permissions/drafts; the scoped broker/worker is separately packaged by this directory's Dockerfile. Parent connector integration must provide its reviewed LocalOwnerSender to normal ConnectorInbox; this branch does not claim live provider setup or delivery for any network.
