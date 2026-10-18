---
name: messenger
description: Use when opening Messenger or checking its account and connection status.
---

# Messenger

Messenger is an installed Wizard container app. Its view opens through its `view.url` from the app registry; its APIs and MCP stay behind the box's authenticated app route. Do not install it as a host daemon or create a separate ad-hoc web service.

The unified preview additionally offers People, Groups and Telegram under the same authenticated owner UI; see UNIFIED-INBOX.md. Translation is reviewed before sending and uses only configured Tinfoil. Unified history is plaintext on the box; Telegram cloud chats are not end-to-end encrypted. Never drive an owner login, send, merge or disconnect without authorization.

The original release is encrypted text DMs with dedicated Messenger accounts, public `npub`/`nprofile` contact codes and explicit invitations. The protected root Wizard ID is separate. Existing NIP-05 handles can be resolved when adding a contact if they point to a Marmot-enabled account.

- Call `messenger_status` to inspect setup/locked/ready and connection capabilities.
- Call `messenger_public_identity` only for the public address; never request a private key.
- Open the installed view for owner-controlled account creation, passphrase unlock, invitations and sending. Never ask for a passphrase in chat.
- On container restart the account is locked. History is retained; the owner unlocks it in the view.
- Sent means relay publication, not peer read. Preserve original request/event IDs on retry. An ambiguous send must be reconciled, not blindly resent.
- Source/API/view files and build provenance ship together. The published API contract is `API-contract.json`; screen source is `static/`.

## First open: the setup link

Before an account exists, the view opened from the launcher says "Ask your Wizard for your Messenger setup link." When the owner asks for it:

1. `POST <host api>/api/view/ticket` with `Authorization: Bearer <MESSENGER_API_TOKEN>` (from the App Manager's secrets file for `messenger`) and body `{"bootstrap": true}`.
2. Give the owner `<Wizard origin><view.url>#ticket=<ticket>` (for example `https://wizard.example.ts.net/messenger/#ticket=…`). It works once, for up to seven days, and only before an account exists.

Do not paste the API token anywhere, and never put the ticket in a URL query. After setup the owner just opens Messenger; restarts ask for the passphrase.

For installation, populate the exact Wizard HTTPS origin from its current network settings and generate an application-only integration capability of at least 32 characters through the normal app-secret mechanism. Preserve app-data on updates. Owner bootstrap is a single-use capability issued by the authenticated local app API; it belongs only in the initial view fragment, never in logs or a public URL query. Existing-account sign-in uses the owner's passphrase and a scoped HttpOnly session, not an API-token field.

The MCP has no message-read/send, agent participation or root-signing tools. Groups, media, phone push and independent phone-held messaging accounts are later work. Publication/index discovery is a separate release step for this local candidate.
