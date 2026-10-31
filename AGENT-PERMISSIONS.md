# Messenger agent permissions

Settings → Agent access offers **No access** (default), **Read-only**, **Draft-only**, and **Draft-and-send**. Optional expiry is 1–1440 minutes. Only an unlocked owner browser cookie, valid Origin and matching CSRF can change policy. A machine bearer cannot enroll an owner, mint an unlocked session, change modes, link accounts, provision bridges, merge people or administer the app in any mode.

- **No access:** public status/identity only; no private reads or drafts.
- **Read-only:** allowlisted conversation/draft reads, no mutations.
- **Draft-only:** reads plus create/update text drafts. No provider callbacks, previews, sends, reactions, typing, read receipts, message edits/deletions or provisioning.
- **Draft-and-send:** additionally permits explicit conversation message operations, including draft preview/send, react/edit/delete, typing/read receipts. Not account/admin access. Media upload, contacts administration, group metadata, invites and sync remain denied.

The API accepts old `full_access` requests as a narrowed alias for `draft_and_send`; it never reports the broad label. Old **persisted** full-access grants are revoked rather than migrated. Unknown routes deny by default. Bearer plus owner cookie is still a bearer, not owner authority. Existing public MCP remains public status/identity only; the scoped UDS MCP supplies private tools.

## Per-agent keys (current)

Settings → **Agents** lists every agent with its own key and its own level: **No access**, **Read-only**, **Draft-only (Recommended)** or **Draft-and-send**. **Add agent** shows the new key once (`wzak_<id>_<secret>`; only its SHA-256 is stored in `/data/agent-keys.json`, mode 0600) and the agent starts at No access, so adding is never a grant. Removing an agent revokes its key at once. Only the owner's browser session (cookie + Origin + CSRF) can list, add, change or remove agents; every bearer is refused on `/api/view/agents*`.

The server decides each request from the presenting key's level, through the same route table for HTTP and MCP (`permissions.capability_for`): reads need `read`, own-draft create/update/discard need `draft`, every provider write needs `send`. Draft-only has no `send`, so send, retry, message edit/delete/react, read receipts, typing, translate and draft preview/send are refused server-side for that key, whatever the shared app key's level is. Agents may change or discard only drafts they wrote and only while unsent and not under owner review. Drafts record `created_by`; they appear above the composer in their chat with **Send draft**, **Edit** and **Discard**. Sending is always the owner's click: there is no auto-send and no MCP send tool.

MCP (`POST /mcp` with `Authorization: Bearer <agent key>`): `messenger_list_chats`, `messenger_read_thread` (pure read of the local mirror: no read receipts, typing, translation or media fetches), `messenger_list_drafts`, `messenger_create_draft`, `messenger_update_draft`, `messenger_delete_draft`, `messenger_attach_to_draft`, `messenger_remove_draft_attachment` (Draft-only and up, same route table as `PUT/DELETE /api/drafts/{id}/attachments`). Attachments are `{path}` inside the read-only shared folder (`MESSENGER_AGENT_FILES_DIR`, default `/attachments`; on Wizard the Files folder `Messenger/Attachments`; relative or the folder's host path from `MESSENGER_AGENT_FILES_HOST_DIR`; anything resolving outside is refused) or `{base64, name}`; all are read and validated before any draft write, and only a per-agent key gets the larger 36 MiB `/mcp` body cap. Without a key, or with the shared Wizard app key, `/mcp` still exposes only `messenger_status` and `messenger_public_identity`. The shared app key keeps its single global level (Settings → Agents → Wizard app key) for older integrations and can never mint owner sessions; agent keys cannot mint launcher tickets.

`agent_keys.py` has no Messenger imports: a future Wizard Mail reuses it with its own file name and its own route/tool → capability map. Operators can register an agent inside the container with `python3 /app/agent_keys.py add --name <name>` (prints the key once; level stays No access until the owner picks one).

Gap: the Wizard agent gateway does not yet forward a per-agent `Authorization` header to app MCP servers, so an agent reaches these tools by configuring Messenger's MCP URL with its key directly. Host-admin agents can still bypass app permissions.

## Normal owner review

Open **Review agent drafts → Review draft**, choose a recipient/channel, edit, then **Review message**. Review saves a new revision and obtains the server's exact preview; nothing is sent. A separate **Send** (or **Send original** on translation failure) posts the stored revision. Edits invalidate the visible Send action and server preview. Stale revisions fail with 409. Controls lock while preview is pending. Expired previews require review again. The recipient label and exact outgoing preview are displayed before the click.

Drafts persist atomically with mode 0600 and directory fsync. Provider submission persists `sending` first, so uncertain delivery locks edits/deletion. Completed sends return the stored receipt on retry; queued delivery is not labelled sent. The owner can delete local drafts except during ambiguous delivery or independent export. No attachment draft API was added.

## Optional independent review

Without `MESSENGER_AUTHORITY_CONFIG` / `MESSENGER_REMOTE_REQUIRED`, normal local owner review is available. Configuring an authority (even unavailable) or requiring it advertises `required:true` to the UI and denies local provider dispatch/preview/send; there is no silent local fallback. Existing export/freeze/retry/independent status UI is preserved. Missing/old authority metadata fails closed in the UI. For the full credential-free local-engine migration and disabled background/provisioning runtime, continue to set `MESSENGER_REMOTE_REQUIRED=1` as documented in REMOTE_AUTHORITY.md; configuring an endpoint alone is not proof of credential isolation.

## Real boundaries

**App-level mode checks are not kernel confinement.** Current host-admin Oscar can inspect/alter app state, owner sessions, provider credentials and deployments. This change does not confine the current agent or change any installed service/tool/config.

`permission_runtime/` packages the same-server route: fixed-route broker → normal Messenger HTTP, with the machine credential outside a nonroot/no-network/read-only worker. Every MCP operation is checked against an owner-owned per-worker ceiling and the live app policy. Only one UDS volume is shared. The broker is not a host-tool relay and has no exec/proxy/admin method. See its README for the actual executable proof, deployment example, and **active cutover gate**. No second physical server is necessary.

Owner account login/pairing is a future per-account delivery gate, not a prerequisite for safe no-message local verification. The provider callback tests are synthetic, not evidence of any live network/account delivery. The parent connector lane owns supported network adapters and LocalOwnerSender integration.

## Verification

```sh
python -m pytest -q tests/test_agent_permissions.py tests/test_permission_runtime.py tests/test_remote_authority.py tests/test_web.py
node --test tests/test_agent_permissions_view.cjs
python3 permission_runtime/proof.py
```

The HTTP suites exercise actual loopback normal-app handlers and independent TLS authority fixtures, cookie/CSRF/Origin checks, denied machine operations, revision fencing, expiry and uncertain delivery. JS executes the shipping view with a lightweight DOM, not a full browser rendering. The Docker proof runs the real scoped adapter against normal app HTTP + UnifiedInbox with a test provider callback, not the old fixture authority backend. It also exercises the official MCP SDK and actual restricted-container attacks. SQLite ResourceWarnings / the Starlette testclient deprecation are pre-existing test environment warnings.

## The Wizard's own agents (no keys)

Settings → Agents lists the agents this Wizard already has (its main agent first) with one picker each: No access, Read-only or Draft-only. Picking a level is the whole setup. The Wizard Agent Service calls Messenger's `/mcp` with its app grant key in `X-Wizard-Grant` (wizard-os `spec/PERMISSIONS.md` layer 2: the App Manager keeps the key in the gateway's `grants/agent-service.json` and only its hash in Messenger's own grants file, `$WIZARD_GRANTS_FILE`, as `from: host:agent-service`, outside the app-ID namespace) and names the agent each call speaks for in `X-Wizard-Agent`; the gateway authenticates every agent with that agent's own token, so one agent cannot speak as another. That holds for agents that cannot read the box's Wizard files (agents in their own containers); an agent running as the Agent Service's own user can read the gateway's keys and tokens, so for it these levels are defense in depth until privilege separation lands. The key works on `/mcp` only (elsewhere a request carrying it is refused, even beside an owner cookie), an agent header without it names nobody, unknown agents start at No access, and only the owner's signed-in screen changes a level. Wizard agents can never get Draft-and-send. Messenger ignores the grants file's `enforce` flag (not enforce-ready): callers without a credential still get the public tools. Older per-agent keys keep working and are shown folded under "Older agent keys"; new ones are no longer offered in the screen.
