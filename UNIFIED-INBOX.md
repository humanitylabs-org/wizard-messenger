# Unified inbox preview (0.2.0-unified.1)

This branch adds People, Groups and Telegram to the existing Messenger UI. Matrix is **private transport**, not a second app or UI. The original Messenger tab, invitations, keyring unlock, drafts and shared Appearance/Back integration remain available.

## Baseline reconciliation

Started from `feature/private-beta-20261015` (`16e245e`), not the older MVP checkout. Compared its four view/test files with the uncommitted live-view snapshot: the only difference was the displayed version string. Thus the private-beta baseline already includes the live shared WizardApp client and Appearance work. The original checkout and live installation were not modified.

## Plumbing decision

Use **Synapse v1.163.0 with SQLite**, plus the official **mautrix-telegram Go/bridgev2 v0.2610.0 with SQLite**. Images are pinned by official multi-architecture manifest digest in `runtipi/docker-compose.yml`.

Continuwuity was considered first (the published v26.7.2 image exists), but its unattended appservice-registration/owner-bootstrap path was not proved here. Synapse provides config-file appservice registration and a documented shared-secret local user bootstrap; both are exercised by this preview. This is a conservative MVP fallback, **not a finding that Continuwuity is incompatible**. No Go or Rust build is needed for these services.

- Homeserver: registration closed, no federation listener, empty federation allowlist, no public rooms over federation, no trusted key servers, internal Compose network only, no host port. Server name is the installation-local `messenger.internal`.
- Telegram alone joins `telegram-egress`. Existing Messenger keeps its relay egress for Marmot; removing that would break the original app. Translation has a separate internal model lane and `model-egress`. These are network separations, not domain-firewall allowlists.
- A networkless first-start service generates stable appservice, provisioning, owner-bootstrap and worker-auth secrets. Files are private under this app's `/data`; no secret is committed, printed or sent to the browser. The worker mount contains only its own auth token, not Matrix/appservice secrets.
- All durable state is in `/data/{matrix,telegram,unified,translation}` alongside existing Marmot state. Synapse and bridge databases use SQLite for this single-owner preview.
- With no Telegram application credentials the bridge process stays dormant, its health check distinguishes dormancy, and the API says **Telegram not configured**. A dormant bridge is not claimed to be a connected Telegram account. Existing Telegram sessions are not started while credentials are absent.
- Configure `TELEGRAM_API_ID` and `TELEGRAM_API_HASH` at install, then recreate the stack so init re-renders config. The UI uses the bridgev2 provisioning API for QR and phone/code/password steps, cancel and logout. Only the one internal owner is permitted; provisioning secrets never enter the UI.
- Internal owner creation is separate from the Marmot identity. The homeserver is not exposed to other Matrix clients or federation.

## Chats list

The first tab is **Chats**: only conversations that have messages, newest first, each showing its latest line and time (groups prefix the sender's first name). **Groups** works the same way. The full A–Z directory of people and groups appears only behind **New chat**, with search.

**Desktop split (0.2.0-unified.15.1).** When Messenger's own window is at least 900px wide (`SPLIT_MIN` in `static/unified.js`, measured on `#messenger`, never the device), the Inbox shows the chat list (header actions, filters, search, list) on the left at 320–380px and the open chat on the right, like Chats' session list beside its thread. Opening a row only redraws the right pane, so the list keeps its scroll, filters and search; the open row is highlighted (`.selected`, `aria-current`). The thread header has no Back there; its ✕ (Close chat), Back/Escape or the New chat button clear the chat to a New message pane on the right (0.2.0-unified.15.2): a focused "To:" search, New Wizard chat, and the A–Z people list from `directory`; picking someone opens that chat in place. That pane is also what shows when nothing is open. A native Wizard thread (`#workspace`) takes the right side the same way. Crossing the width line keeps the open chat (narrow shows it alone, wide shows it beside the list), and a pending draft save is flushed rather than dropped when switching chats. Narrower windows, including phones and their title-bar tools, are unchanged. Guard: `tests/desktop_split_browser.cjs`.

## Telegram history

On login the bridge creates rooms for the owner's 50 most recent Telegram chats and copies the last 50 messages of each (forward backfill, which stock Synapse supports). Chats beyond those 50 appear when they next get a message. The chat list is fetched only at sign-in, so Disconnect deletes the bridged copies (never anything on Telegram) and the next Connect rebuilds every chat with fresh history; cards for removed rooms are dropped. Photos, video, voice, files, locations and stickers show as a short label plus any caption; group messages show the sender's name. Older history (backward backfill) needs Beeper's batch-send API and stays off.

## Agent access boundary

The app's machine key (`MESSENGER_API_TOKEN`) is held by the Wizard host, so any agent on the box can find it. With that key alone an agent can read status and identity, mint the owner's view ticket, resolve a contact address and run passphrase-proved setup. Every message, contact, People/Groups, send, sync, translate or Telegram-login route answers `403 agent_access_off`.

The owner can allow agent access for 1 hour or 24 hours from **Connected accounts → Agent access**; it turns itself off when the time ends, and only the passphrase-unlocked owner session (cookie + CSRF) can change it. Every machine-key request outside the open set is logged by route shape (`/api/unified/people/:id/send`, never ids or content) and the last 20 entries show in the same panel. This guards against accidental exfiltration; an agent with host root can still read app data or mint a view session deliberately, so the private-agent seal remains the policy boundary until Messenger and the agents run in separately administered containers.

## People, Groups, translation

A SQLite person has a display name, language and optional preferred identity. Each contact auto-creates an identity/person. Merge moves identities and their histories; Separate creates another person without deleting messages. The default reply channel is the identity with the newest incoming message; an explicit preferred identity or visible channel selector overrides it.

Telegram portal metadata determines person vs group; Matrix spaces are omitted. Every chat (people, groups, merged people) can carry owner-assigned labels, a label is a named group of chats you filter by across networks and can exist while empty (see docs/labels-groups.md). Existing Marmot supports DMs only; this change does not invent Marmot group-chat support.

Translation stays out of the way by default. Chats with no language set show the original text, send immediately and make no model calls. An incoming message containing letters outside the Latin script (Thai, Cyrillic, CJK…) gets a small **Translate** link; tapping it makes one cached model call and toggles between the English and the original. Setting a person's optional **Auto-translate** language switches that chat to the reviewed mode: incoming English is shown above the original, and outgoing English is previewed server-side, bound to the selected identity, and sent only after confirmation. Both source and sent text are retained. Confirmation uses a stable Matrix transaction ID; retries cannot change the body/channel. Failed translations offer **Send English original instead**, never silently pretend to translate. Cached translations include model and language in their key.

Only Tinfoil's `https://inference.tinfoil.sh/v1/chat/completions` is called. Configure `TINFOIL_API_KEY` and `TRANSLATION_MODEL`; default `gemma4-31b` was selected from the live `/v1/models` response and tested in both directions. The locally configured `glm-5-3-flash` name was absent from that public endpoint; no other provider was substituted. This is the requested OpenAI-compatible TLS route, **not proof of client-side enclave attestation**. Translation is assistive, not guaranteed correct: review the send preview.

### Privacy and MVP limits

The existing Marmot keyring remains encrypted, but the unified history mirror, Matrix/Telegram databases, cached translations and drafts are **plaintext on the box**. Protect the disk and backups. Telegram cloud chats are not end-to-end encrypted; Telegram secret chats are not supported. Text selected for translation leaves the box for Tinfoil. The browser uses the existing scoped Secure/HttpOnly session and Origin/CSRF boundary; no new unauthenticated private API or MCP message tools were added.

Text only. No media, edits/reactions, group creation, delivery/read receipts, remote contact discovery or phone push. Latest 2,000 local messages per merged thread are shown; initial Matrix sync is bounded, and a limited sync honestly warns that older history may be incomplete. Full historical backfill/pagination is follow-up work. Server-side Matrix sync continues while the browser is closed. Marmot ingestion/translation happens when the relevant API/view is opened.

## Wizard OS inbox feed

`GET /api/inbox` (`inbox_feed.py`) lists one item per chat the app badge counts: unread incoming messages, never muted or Low priority chats. Key `chat:<chat id>`, title = chat name, text = newest unread line (`N new · …` when more than one), time = its unix seconds, priority 3 (Messenger has no mentions yet), `open` = `#chat=<chat id>` (unified.js opens that chat on load or hashchange and drops the fragment), actions Reply (input), Draft me a reply (`ask`, handled by the shell's agent, never posted here) and Mark as read. Read-only, one SQL query.

Instant change signal (contract v1.1): the feed also carries `version` (an etag of the items) and `watch: "api/inbox/wait"`. `GET /api/inbox/wait?v=<version>` is a long poll: it answers at once with the feed (`changed: true`) when `v` is stale, otherwise it sleeps on `UnifiedInbox.cond` (the same condition every store write notifies for the view's own `api/unified/updates` long poll) and, after a write, re-reads the feed once (cached per store seq, so one query serves every waiter) and returns only when the version moved; after `hold` seconds (default and max 25) it returns `{inbox:1, changed:false, version}`. No DB work while it sleeps. At most 6 waiters (429 `busy` beyond, separate from the view's 8). Same owner-only auth as the feed; the owner ingress does not count it as activity (GET, not api/drafts), so deploy gates are unaffected.

`POST /api/inbox/act` `{key, action, text}`: `read` runs the same `people/<id>/read` route as opening the chat (badge, list and feed clear, read receipts go out); `reply` sends `text` through the view's `people/<id>/send` route (client id derived from chat + newest unread + text, so a retried tap never sends twice), then reads the chat. Anything else is 400; non-JSON is 415; body cap is the normal 64 KiB. Owner only, never a bearer: on a trusted Wizard install the authenticated ingress's per-request owner proof is the authority (the same proof that opens a view session) and writes need an allowed Origin and never `Sec-Fetch-Site: cross-site`; without trusted ingress the routes need the owner's view session plus CSRF like every other owner route. Errors use the feed contract's shape `{ok:false, error:"<message>", code}`. Wizard chats that exist only on this device (native rows without a mirrored chat, pending invites) keep their unread state in the browser and are not in the feed. Tests: `tests/test_inbox_feed.py`, `tests/inbox_link_browser.cjs`.

## Verification and preview

Light checks:

```sh
python3 -W error::ResourceWarning -m unittest discover -s tests -v
node --test tests/test_view.cjs tests/test_unified_view.cjs
python3 tools/build_view.py
```

`tools/unified_preview.py --directory <owned-empty-directory> --port <free-loopback-port>` prepares private configuration, refusing an unowned existing directory. It does not start anything or touch the installed app. A temporary `--source-mount` mode is explicitly pre-build QA, not proof of the final image.

Start with an architecture-matching loaded image:

```sh
docker compose --project-name messenger-unified-preview \
  --env-file <preview>/preview.env \
  -f runtipi/docker-compose.yml -f <preview>/override.json up -d
```

`tools/unified_preview_gateway.py` is an optional loopback HTTPS gateway fixture serving the real shared `app-client.js`; it is not a full Wizard/WAM installation. Mount its certificate and shared client read-only. The private preview contains disposable accounts only. The gateway bootstrap is appropriate only on loopback behind the tester's private connection.

`tools/unified_proof.py` runs **inside only the disposable preview**, guarded by `UNIFIED_PREVIEW_PROOF=1`. It creates real second-user Matrix rooms with explicitly simulated Telegram portal metadata, sends both directions, calls real Tinfoil, merges/separates identities, and assigns a group label. It does not authenticate Telegram or contact anyone. `tests/unified_browser.cjs` runs on the remote browser machine at 390×844, using actual API state; it checks physical Back overlay → thread → list → guarded root and saves screenshots.

Evidence boundaries: real Synapse/bridge health and registration, real bridgev2 phone-login-start with a dummy application ID, real local Matrix roundtrip and real Tinfoil calls. Portal/contact metadata is simulated. No real Telegram login, Telegram send/receive, or QR handshake is claimed; the dummy QR attempt timed out and the API returned a safe `upstream_unavailable` error. Existing unit tests are regression evidence, not a new full Marmot relay campaign.

`tools/build_unified_thales.py` is a **developer-only** source-build helper, not a recipient installer. Its name and defaults reflect the original development machine (Colima, Homebrew and an already-loaded architecture-matching MDK carrier). It verifies the carrier's committed SHA-256 values, labels the source revision and exports an image; it does not fetch or install the current Store release. Thales access and this helper are **not required** for recipients: the current public Store recipe pulls digest-pinned GHCR images. Follow [README.md](README.md) for installation. Any intentional source build runs from a pushed commit on the designated architecture-native build host via the durable worker, never on the control-plane VPS; this historical helper is not a clean-host build guarantee.

## Catch me up (0.2.0-unified.16.28)

Title-bar sparkle beside the chat menu, and "Summarize these" under the "N new messages" line, open an opaque bottom sheet with bullets (who said what, decisions, open questions, things aimed at the owner); each bullet opens its source message. Input is every unread message in the chat with no cap (if none are unread: since the owner last wrote, else the whole loaded history). When the text exceeds one pass (`SUMMARY_PART_CHARS`, 120000) it is split by time into parts, each summarized, then merged; the sheet footer says "Summarized N messages in K parts". The model call goes only through the translation worker (`POST /complete`, `TINFOIL_API_KEY`, `https://inference.tinfoil.sh`). Model choice and the 8-transcript side-by-side test: `docs/catch-me-up.md`. Tables `catchup_grant` and `catchup_summary` are created with `CREATE TABLE IF NOT EXISTS`; existing data is untouched. Permission: AGENT-PERMISSIONS.md.

## 0.2.0-unified.16.29 (single trunk, Standard release)

`main` is the one trunk (renamed from `feature/unified-inbox` on 6 Nov 2026). There is no Alpha channel for Messenger: this is the Standard release (public digest-pinned GHCR images for amd64 and arm64). It carries Catch me up (16.28) and the platform owner proof (#107): with an App Manager that provides the owner proof, Messenger accepts it and the fingerprint prompt stops repeating; without one it fails closed to the existing unlock.

## 0.2.0-unified.16.30 (profile pictures load again)

16.27 kept each profile picture hidden until it loaded but handed that hidden picture to the lazy-load observer; a hidden element never intersects, so no picture was ever requested and every chat showed initials. The observer now watches the visible avatar circle and requests its picture when the row comes near the screen, including after a repaint. Guard: `tests/avatar_refresh.test.cjs` (lazy loading watches the visible avatar circle).

## 0.2.0-unified.16.31 (PDFs and Office files save with their real type)

Downloads of attached files were always sent as `application/octet-stream`, so Android's download manager saved a PDF as `name.bin`, and the 80-character filename cut could drop the extension. PDF, zip, wav, Office and plain-text files now keep their real type (still `attachment`, sandboxed and `nosniff`); HTML, SVG and script files stay octet-stream. Long filenames keep their extension and carry an RFC 5987 `filename*`. Guards: `tests/test_download_type.py`, `tests/test_web.py`, `tests/test_unified.py`.

## 0.2.0-unified.16.32 (reading a chat in LINE's own app clears it here)

Messenger already cleared a chat when the network reported the owner's read (Telegram, WhatsApp, Signal, Slack, Instagram, Facebook, X, LinkedIn and Google Messages bridges all relay it as a Matrix read receipt from the owner). The LINE bridge did not: LINE sends "you read this chat on another device" as operation 40 (`SEND_CHAT_CHECKED`), which the pinned bridge ignored; it only handled other people's reads (operation 55). The pinned bridge now carries one patch (`plumbing/line-own-read-sync.patch`, hash in `plumbing/connectors-provenance.json`) that turns operation 40 into the owner's read receipt up to the message LINE names. Messenger side: a read receipt is also honoured when it names an edit, album tile or message Messenger holds under another id (resolved to the newest line at or before it, in that chat only), and `/api/unified/status` reports per-network `read_sync` counts (`seen`, `cleared`, `last`: numbers only) so the owner can see native reads arrive. Guards: `tests/test_native_read_sync.py` (clears that room only; later lines stay unread; badge, inbox feed and divider mark; peer receipts never clear; each network's own ghost), LINE `pkg/connector/own_read_test.go` inside the patch. Per-network matrix: `CONNECTORS.md` "Native reads".

## 0.2.0-unified.16.33 (LINE photos load; photos shared from other apps land in the chat's photo tray)

**LINE photos.** Every LINE photo showed "Photo unavailable". The LINE bridge sends a photo as a bare `m.image` (a url and the name `image.jpg`, no `info` block, so no mimetype; its stickers, files, video and audio do carry one). Messenger's picture route decided "is this a picture?" only from the mimetype, so it answered 404 "No preview" for every LINE photo. The event type now decides when the bridge sent no mimetype (`is_picture` in `unified.py`), for the list row (`media.thumb`) and the thumbnail/full routes alike. The decision is made when a photo is shown, not when it was stored, so photos already received start loading too (while their media is still in Matrix). Photos the bridge could not download from LINE never reached Matrix and are not repaired. Guards: `tests/test_incoming_media.py` `LinePhotoTests`.

**Shared photos.** Messenger now tells the Wizard share sheet it takes images as well as text and links. A photo shared to Messenger opens the chosen chat (or asks who to send it to), stages it in the same photo tray as the + picker, paste and drop, and puts any caption in the message box. It never sends by itself and is only marked as received once it is really in the tray; chats that cannot take photos, a full tray, plain files and a locked Messenger leave it waiting. Ported from #8 (written against 16.11) onto the current composer. Guard: `tests/share_image_receive.test.cjs`.

## 0.2.0-unified.16.37 (unlock fix)

Store recipe: pins the image built from main `8cafa04` (#174). A Messenger whose Wizard holds no remembered key (restart, `trusted-owner-unlock.json` missing or unreadable) now shows the unlock card once instead of sitting on "Opening your messages…"; unlocking remembers this Wizard again. Refs #162 #164.

## 0.2.0-unified.16.36 (photo-speed switches ship; all off by default)

Store recipe only: pins the image built from main `2590ec2`, which carries the photo-speed work from #163 (photos fetched on the box as they arrive, `photo-warm`), #165 (view-size copies and a thumbnail-first viewer, `photo-instant`), #167 (background photo download on the phone, `photo-prefetch`), #169 (per-stage photo timings in Settings, `photo-timings`) and #171 (ready placeholder in Wizard's viewer, `viewer-placeholder`), plus #172 (Drafts at top always on). Every photo switch is off until the owner turns it on from the Tracker. The version strings inside the image still read 16.35; the recipe version is the one the App Manager compares.

## 0.2.0-unified.16.35 (feature switches flip from the Tracker in any browser)

Messenger declares its feature switches in `wizard.md` (`switches:`), so the App Manager lists them in the box's one switch catalog next to the WizardOS core ones. With Wizard owner access on, the platform's signed owner proof alone lets the owner read and flip a switch at `/api/view/switches`: no Messenger session or unlock is needed, so the App Manager flips Drafts at top server-side when the owner taps Try it on the Tracker card, from any browser or device. Bearers and agent keys are still refused; the write still needs the box's Origin and `X-Wizard-Switch: 1`.

## 0.2.0-unified.16.34 (signing in to a network uses a normal browser, with a Paste step)

Connecting a network (Instagram, Facebook, Slack, X, LinkedIn and the others that sign in on the site itself) now opens the real site in Messenger's own normal Chromium instead of the shared Wizard Browser's stripped-down engine. The browser is a new `signin-browser` service in Messenger's recipe, using the Browser app's engine image (real Chromium on a virtual display). It sits on an internal lane that only Messenger can reach and has its own outbound network, so agents and other apps never get to it, and Messenger no longer needs the Browser app installed (`uses: []`). Each sign-in is a throw-away window: when it ends, finishes or is cancelled, its cookies are cleared and the window is destroyed. The window presents a plain desktop browser (no phone-touch emulation paired with a desktop identity, which is what sites flag as a bot).

The live view gets a **Paste** button next to Back, Tab and Enter: one tap puts what you copied (a code, an email, a link) into the field you have selected. If the phone will not hand over the clipboard, the box above still takes a long-press Paste.
