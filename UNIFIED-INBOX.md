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

Since issue 209 (on for everyone) every translation the box makes (auto-translate, the send preview and a tapped Translate the browser can't do itself) runs on the box's own model: Argos Translate packages on CTranslate2 in the translation worker (`private_translation.py`), downloaded once per language pair on first use into `data/translation-models`. No message text goes to Tinfoil for translation. The Tinfoil notes below now apply to Catch me up and transcript formatting only.

Only Tinfoil's `https://inference.tinfoil.sh/v1/chat/completions` is called. Configure `TINFOIL_API_KEY` and `TRANSLATION_MODEL`; default `gemma4-31b` was selected from the live `/v1/models` response and tested in both directions. The locally configured `glm-5-3-flash` name was absent from that public endpoint; no other provider was substituted. This is the requested OpenAI-compatible TLS route, **not proof of client-side enclave attestation**. Translation is assistive, not guaranteed correct: review the send preview.

Without an install-form `TINFOIL_API_KEY` (a normal App Store install), Catch me up and transcript formatting go through the Wizard Tinfoil app on the same box (issue 251, `tinfoil_link.py`): the owner's Messenger page asks Tinfoil for a Messenger-only box token (`POST /wizard-tinfoil/api/app-tokens`, as Search's AI overviews do), Messenger keeps it 0600 in `unified/tinfoil-link.json` and calls `http://wizard-tinfoil:18804/v1` (override with `MESSENGER_TINFOIL_APP`). The Tinfoil key never leaves the Tinfoil app; Remove on the Tinfoil page revokes the token. An install-form key still wins. With neither, the error says Tinfoil isn't connected and offers Open Tinfoil.

A tapped **Translate** first uses (issue 199, on for everyone) the browser's own built-in translator (Chrome's `Translator` and `LanguageDetector` APIs, on-device language packs), so that text never leaves the device and is not cached on the box. Where the browser has no built-in translator (Safari, Firefox, phones today), the language is unknown or the pack can't be fetched, Translate falls back to Tinfoil as above. Auto-translate chats and the send preview also translate on the device (issue 204, on for everyone): a browser with a built-in translator opens auto-translate chats with `?translate=device`, so the box queues nothing for Tinfoil, translates incoming messages to English itself (a message it can't read goes to the one-message translate route, i.e. Tinfoil), and sends its own translation of a reply to the preview (`translated`, `on_device: true`), which the box binds to that preview like a Tinfoil result (the mention check still applies). Browsers without one (Safari, Firefox, phones today) use Tinfoil as before.

Holding a chat in the list (or right-clicking it on a computer) offers **Agent keeps a draft ready** / **Stop keeping a draft ready** (issue 201, on for everyone), for people and groups, without opening the chat. An open chat shows a one-tap **Drafts** pill next to Catch me up (filled dot = on), which replaced the old ⋯ menu item.

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

## 0.2.0-unified.16.124

- The Telegram-style emoji panel is on for everyone (issue 349): a category bar that jumps to a section and lights the one on screen, a bottom strip with Emoji/GIFs/Stickers and a delete key (hold to keep deleting, the phone keyboard stays down), a keyboard button that swaps back to typing with the caret kept, skin tones on a long press that stick, Recent ranked by use, and on a phone the keyboard's own height. The `telegram-emoji` switch is removed and a stored value for it is ignored. Guards: `tests/telegram_emoji_browser.cjs`, `tests/test_telegram_emoji.cjs`, `tests/test_switches.py`. Image built from main dd05f97 (PR #433): `sha-dd05f973abc7095e8da2bbd3f28fc1364ba3295a@sha256:b46b1964a6eb30998ef8f5ea3e27dd8f2baf05515ac1bef9337356ba6b785746`.

## 0.2.0-unified.16.123

- Agent chat through your agent inbox is on for everyone (issue 325): when Messenger has its Agent Service app token and the box's agent inbox is on (`wizard/agent-inbox`, now the only off switch), each note becomes a task in the box's inbox, Sweep shows the same card as Daily with one-tap answers, and urgent alerts arrive as one-line pings. The door now runs on the box itself every 15 s, so pings (unread, badge, phone notification) come with Messenger closed too. Any probe answer other than 200 `on: true`, or no token, keeps today's Agent chat. The `agent-inbox-door` switch is removed and a stored value for it is ignored. Guards: `tests/test_agent_inbox_door.py`, `tests/agent_inbox_door_browser.cjs`. Image built from main e5d50b9 (PR #431): `sha-e5d50b964e34a8dd40534b9228c2d6fa8dcb26ea@sha256:b5be25ea2df13f613b562742d6deffc67926dcce0a0243bbecc30ce2af5afdbe`.

## 0.2.0-unified.16.122

- Background video download is on for everyone (issue 320): the phone downloads videos up to 25 MB (3 per chat, after the photos) from the newest chats while Messenger is open, on Wi-Fi only unless this device chose Always, and the bubble plays the kept copy, so one tap starts it at once. Bigger videos stream on tap; GIFs and stickers are left alone. The `video-prefetch` switch is removed and a stored value for it is ignored. Guard: `tests/video_prefetch_browser.cjs`. Image built from main 3ede32d (PR #429): `sha-3ede32d8db1c4c83949debf21931ab5008c12ede@sha256:25bd89b6191ab115075dc6b6e8f13f0fd59de0d10b6d42516282bd51146545ea`.

## 0.2.0-unified.16.121

- Share files to Messenger is on for everyone (issue 314): Messenger always tells Wizard's share sheet it takes files as well as text, links and photos. A shared file (a PDF, an .md from a chat) opens the chosen chat, or the Send to… picker, with the file as an attachment in the message box, kept in the chat's draft until you tap Send; over 25 MB says it is too big. The `share-files` switch is removed and a stored value for it is ignored. Image built from main fe4a584 (PR #427): `sha-fe4a5846b057178afe2c16992ceea72b7b899ef1@sha256:057308d4f4427243e3c40e253f44ac6fb036c53ae59928a0e914bf00ff292a0c`.

## 0.2.0-unified.16.120

- Unread count on the phone icon is on for everyone (issue 296, with issue 302's private chats): `GET /api/unread` and `POST /api/view/private-seen` always answer (owner only, as before), so the Wizard phone app can show how many chats are unread on the Messenger icon. The `unread-count` switch is removed and a stored value for it is ignored. Image built from main b276376 (PR #425): `sha-b27637688d8b1887d211ea5ddaa7aae1024be28c@sha256:1c460a7c8014eb072ca38834e0fdd79760fa05395011dc77d8de1871b8a9102e`.

## 0.2.0-unified.16.119

- Signal chat names, second round (issue 401): one-to-one chats no longer stay on "Signal conversation". Besides the room name and the joined contact, Messenger now also reads a contact who is only invited, the number in the bridge's topic and the bridge's own contact list (name, else username, else number). It treats the bridge's "Unknown user" and a contact's raw id as stand-ins, not names. Chats that are still stuck are re-read after every start and then every 15 minutes. A one-to-one chat an older version filed as a group moves back. Each chat that is still stuck writes one log line (`messenger: dm-label stuck ...`) that lists which name sources exist and what kind each is, with no names or numbers. Image built from main 738dfb9 (PR #423): `sha-738dfb959258e627d25165782b0ac772695b3041@sha256:fe74572031fbea0c9c521a8265dd85958d90bd5794f8d6e832f4b5c0b33565db`.

## 0.2.0-unified.16.118

- Tap beside a message for its menu, on for everyone (issue 182): James said yes at show-and-tell, so the `row-tap-menu` switch is gone. On a phone, tapping the empty space to the right of someone's photo, video, album or text opens that message's menu (the same one holding it opens); tapping the photo still opens the viewer, and dragging still scrolls. A stored value for the old switch is ignored and cleared. Image built from main 127b1fa (PR #421): `sha-127b1fa3e262383d875d2d01f018f666deb542dd@sha256:8ac412b1b62524760af28afffb20ff7330b21feb55ea0f91043484626e6b3a71`.

## 0.2.0-unified.16.117

- Desktop Inbox row and bottom filter rows (issue 409): on the desktop, QR, Search and Settings stay in Messenger's own Inbox row at every window width (they no longer move into the window title bar, which holds the width buttons), and the filter rows (All / Unread / Medium / Low and the network icons) always sit at the bottom of the chat list, so nothing jumps when the window is resized. The phone keeps its title-bar tools. Image built from main 1416772 (PR #419): `sha-14167729efeaa6abac847cc46dc985e1d67110fd@sha256:ba37cf9059501c2ec1946bf668f38a7a4eebb575e9612cb66ee2cb68dee69539`.

## 0.2.0-unified.16.116

- Received photos always show and open (issue 404): a photo in a format phones can't show (an iPhone HEIC photo that LINE passes on as image.jpg) is turned into a JPEG on the box, and the box makes the thumbnail itself when the homeserver can't. A photo nothing can read says "📷 Photo not available · Tap to try again" in its bubble, and a tap asks the box again instead of opening an empty viewer. The image now carries libheif-examples (heif-convert). Image built from main 5b1fbb4 (PR #417): `sha-5b1fbb479cc4ce797df9c91f97c09b1a2f43865c@sha256:373086717b04b89b7865aba64ae5191f06a41e9945c9839a5ea0bb3407d14475`.

## 0.2.0-unified.16.115

- Messenger opens with Wizard's browser boundary on behind an owner ingress (issue 413): the App Manager's owner edge (wizard-app-manager#1045) and Messenger's own `tools/owner_ingress.py` let the sandboxed window's own page files and media through unsigned, a ticketed photo/video/avatar read no longer needs the owner proof on a trusted Wizard, and the own ingress keeps `X-Messenger-CSRF` so drafts save through it. Image `sha-e709f19bf966197695b67df3fd7c484c3273c36e@sha256:77409c8f9e127c02fbcc209a5703b6bd8657dcf82c565c435ae23c846c6a0632`.

## 0.2.0-unified.16.114

Videos you send go out as real videos (issue 402): a video picked with + → "Photo or video" shows its first frame, a play badge and its length in the tray, sends as a video (with that frame as its thumbnail) on LINE, WhatsApp, Signal, Telegram and the other networks and in Wizard chats, and plays inline in the thread. "File" still sends a video as a file. Image built from main 162407e (PR #412).

## 0.2.0-unified.16.113

Store recipe: pins the image built from main `6a949e9`. Ships #410 (Refs humanitylabs-org/wizard-messenger#401). Signal one-to-one chats are now titled with the contact's name, or their number when they have no Signal profile name, and never "Signal conversation" or the owner's own name. A chat first seen before the bridge had a name for the contact used to keep the stand-in for good, because a number was never allowed to replace it. Both room-naming paths now share one rule (`dm_label`), and a one-time pass after the update retitles chats that are already stuck. Groups are unchanged. Bug fix, no switch. Guard: `tests/test_history_identity.py` SignalDmLabelTests.

## 0.2.0-unified.16.112

Store recipe: pins the image built from main `0f55939`. Ships #407 (Refs humanitylabs-org/wizard-messenger#336): the Unread list no longer changes on its own. Each refresh Wizard sends (focus, coming back, every minute) reloads the whole chat list, and an answer that arrived after the live feed had moved some chats on put their older copies back, so chats, previews, badges and the Unread count stepped back and then forward again, and a chat just read could show as unread for a moment. A reload now keeps the newer copy of every chat the feed or this device changed after the reload was asked, and the box reads the list position before the list. Bug fix, no switch. Guard: `tests/test_list_snapshot.cjs`, `tests/unread_list_steady_browser.cjs`.

## 0.2.0-unified.16.111

Store recipe: pins the image built from main `7b629b9`. Ships #405 (Refs humanitylabs-org/wizard-messenger#284): a sign-in page the network refuses with HTTP 429 ("too many requests", as Instagram does for its login page from some server addresses) no longer leaves the owner on Chrome's "This page isn't working" picture. Messenger closes that sign-in window at once and says in plain words that the network is limiting sign-ins from this Wizard's connection for now, that it is not a problem with the account, and offers Start again (held for 30 seconds so it can't hammer the network) or Username and password. Nothing retries on its own. Bug fix, no switch.

## 0.2.0-unified.16.110

Store recipe: pins the image built from main `b5701f5`. Ships #400 (Refs humanitylabs-org/wizard-messenger#282, #283): a passkey prompt no longer freezes a network's sign-in page. Each sign-in window in Messenger's own Chromium now runs Chromium's WebAuthn test environment (no hidden native passkey window) with an empty key on every transport whose user check always fails, so a passkey request (Facebook's "confirm it's you", Google's "Verifying it's you") ends at once with NotAllowedError, like a person cancelling the prompt; the site then offers its other ways to sign in, and the page keeps taking taps. Nothing is created or signed. Bug fix, no switch. Guard: `tests/test_signin_passkeys.py`.

## 0.2.0-unified.16.109

Store recipe: pins the image built from main `3c033fb`. Ships #396 (Refs humanitylabs-org/wizard-os#634): the Agent chat wakes the owner's agent through the box. When the Wizard offers app wake events (wizard-os spec/APP_WAKE.md, `wizard.app-wake/1`, the Agent Service's switch `wizard/app-wake`), a note, a Sweep tap or an answer wakes every Wizard agent the owner gives Draft-only access, with no Hermes webhook subscription and no `messenger_agent_chat_wake_me` setup; the event carries counts only, never the words. The Agent chat header then reads "Your agent hears about each note within seconds". With the box's switch off (404) the wake is exactly as before. No Messenger switch. Guards: `tests/test_agent_chat.py`.

## 0.2.0-unified.16.108

Store recipe: pins the image built from main `5cd635b`. Ships #393 (Refs humanitylabs-org/wizard-messenger#392, #348): photos are on the phone on mobile data too. Background photo download now runs on any network unless the device chose Wi-Fi only (videos still wait for Wi-Fi), inside the 300 MB cap, and the chat you open goes first; a bubble paints from the phone's kept thumbnail; with "Photos open instantly" on, Wizard's viewer loads the 1600 px screen copy (the phone's when kept) with the on-screen thumbnail as stand-in instead of the original, so no loading wheel waits on a several-MB file; and the box warms the original and screen copy of any photo whose thumbnail the phone asks for. Bug fix, no switch. Guards: `tests/photos_ready_mobile_browser.cjs`, `tests/test_viewer_items.cjs`, `tests/test_unified.py`.

## 0.2.0-unified.16.107

Store recipe: pins the image built from main `58a3ed9`. Ships #390 (Refs humanitylabs-org/wizard-ux#1745): when Forward to Wizard does not send, the toast says why instead of "Sharing unavailable" for every case: Send to Wizard can't open in this window (an older Wizard, or another share still open), couldn't send, or the receipt by name; the selection is always kept. The cause of the failure itself, the Send to Wizard sheet never opening in Messenger opened from its own home-screen icon, is fixed in the Wizard shell (humanitylabs-org/wizard-ux#1770). Bug fix, no switch. Guard: `tests/test_forward_problem.cjs`.

## 0.2.0-unified.16.106

Store recipe: pins the image built from main `7763fb7`. Ships #367 (Refs humanitylabs-org/wizard-messenger#348): a tapped photo is handed to Wizard's shared viewer in the tap itself. The screen copies this phone already downloaded are kept ready in memory (read ahead when a chat shows its photos and on the finger's touch), so there is no wait on the phone's photo cache first; hand-over is 2-3x faster, and Messenger's own full-size view never shows a black first frame. Bug fix, no switch. Guards: `tests/test_ready_copies.cjs`, `tests/photo_tap_instant_browser.cjs`.

## 0.2.0-unified.16.105

Store recipe: pins the image built from main `ba32d74`. Ships #386 (Refs humanitylabs-org/wizard-messenger#379): full-screen videos behind the off-by-default switch `video-fullscreen` ("Videos open full screen"). With it on, one tap on a video opens it full screen on black, already playing with sound, with Messenger's own controls (tap to show or hide: play/pause, scrubber, Close); Back, Esc, Close or a swipe down returns to the chat where it was. GIFs and stickers still loop in the chat; switch off keeps playing in the bubble. Tap to first moving frame is timed as `video_first_frame` with Photo timings on. Guards: `tests/video_fullscreen_browser.cjs`, `tests/test_video_swipe.cjs`, `tests/test_switches.py`.

## 0.2.0-unified.16.104

Store recipe: pins the image built from main `7c0801d`. Ships #384 (Refs humanitylabs-org/wizard-messenger#353): stacked drafts behind the off-by-default switch `stacked-drafts` ("Several drafts in one chat"). With it on, an agent can line up to 5 drafts in one chat (`draft_stack_full` after that); with two or more, the message box stays empty and they wait as stacked bubbles above it, oldest first, each with Send, Edit and Remove. One draft works as before; switch off keeps one draft per chat (`draft_exists`). Also: the phone-notify worker no longer reads the store (CI sqlite segfault in teardown). Guards: `tests/test_stacked_drafts.py`, `tests/test_stacked_drafts.cjs`, `tests/stacked_drafts_browser.cjs`, `tests/test_switches.py`.

## 0.2.0-unified.16.103

Store recipe: pins the image built from main `f09aa90`. Ships #382 (Refs humanitylabs-org/wizard-messenger#368, Refs humanitylabs-org/wizard-messenger#223): the dropped draft wake is removed. The `agent-wake` switch, the `messenger_wake_me` agent tool, `draft_wake.py` and the "Drafts paused" line are gone, and the stored wake list (agents' event-inbox urls and secrets) is deleted on start. Agents keep drafts ready by checking `messenger_chats_needing_draft` as before; the Agent chat wake is unchanged. Guards: `tests/test_draft_watch.py`, `tests/test_agent_chat.py`, `tests/test_switches.py`.

## 0.2.0-unified.16.102

Store recipe: pins the image built from main `06b718b`. Ships #380 (Refs humanitylabs-org/wizard-messenger#343): received videos start sooner. The box keeps a received MP4/MOV with its index (moov) in front, moved once on arrival with no re-encode, so the player streams from the first bytes; on Wi-Fi or wired, a video bubble near the screen buffers its first seconds before the tap. Guards: `tests/test_video_faststart.py`, `tests/test_video_preload.cjs`, `tests/video_stream_start_browser.cjs`.

## 0.2.0-unified.16.101

Store recipe: pins the image built from main `7528425`. Ships #377 (Refs humanitylabs-org/wizard-messenger#342): Agent levels in Connected accounts is on for everyone; `GET/POST /api/agent-levels` always answers (owner only, as before), so Connected accounts' Agent access screen always lists Messenger's chat accounts and each agent's Messenger level, and the `connected-accounts-levels` switch is removed. Guards: `tests/test_agent_levels_route.py`, `tests/test_switches.py`.

## 0.2.0-unified.16.100

Store recipe: pins the image built from main `d2e35b5`. Ships #375 (Refs humanitylabs-org/wizard-messenger#308): Messages on your phone is on for everyone; new incoming messages and urgent Agent chat pings always go to the Notifications app, and the `phone-notifications` switch is removed. Guards: `tests/test_phone_notify.py`, `tests/test_switches.py`, `tests/phone_notify_browser.cjs`.

## 0.2.0-unified.16.99

Store recipe: pins the image built from main `246df33`. Ships #373 (Refs humanitylabs-org/wizard-messenger#291): the Hide/Show Agent and Reports button beside My QR codes is on for everyone; the `agent-rows-toggle` switch is removed. Guards: `tests/test_switches.py`, `tests/agent_rows_toggle_browser.cjs`.

## 0.2.0-unified.16.98

Store recipe: pins the image built from main `95e1620`. Ships #371 (Refs humanitylabs-org/wizard-messenger#276): Notifications in Reports is on for everyone; the `reports-notifications` switch is removed. Also fixes the 16.97 image pin, which had a doubled `sha256:` in its digest. Guards: `tests/test_agent_chat.py`, `tests/test_switches.py`, `tests/reports_notifications_browser.cjs`.

## 0.2.0-unified.16.97

Store recipe: pins the image built from main `7b2ba40`. Ships #369 (Refs #201): Draft ready from the chat list is on for everyone (switch `list-draft-ready` removed). Holding or right-clicking a chat offers Agent keeps a draft ready / Stop keeping a draft ready, and an open chat always shows the one-tap Drafts pill next to Catch me up.

## 0.2.0-unified.16.96 (Saved photos keep their file name for everyone)

Store recipe: pins the image built from main `8b37f67`. Ships #365 (Refs humanitylabs-org/wizard-messenger#337): the `photo-file-names` switch is removed (approved), so Save on a photo or video in Wizard's media viewer or a message's menu always keeps the photo's own file name, else a dated name like "Messenger photo 2026-11-20 14.03.jpg", never the sender's name. Guards: `tests/test_saved_media_name.cjs`, `tests/test_switches.py`.

## 0.2.0-unified.16.95 (Agent chat always shows your agent's name)

Store recipe: pins the image built from main `4356903`. Ships #363 (Refs humanitylabs-org/wizard-messenger#277): the `agent-chat-name` switch is removed (approved), so the pinned Agent chat always shows your agent's own name and hat picture in its colour ("Agent" when no agent is known). Guards: `tests/test_agent_chat_name.cjs`, `tests/agent_chat_name_browser.cjs`.

## 0.2.0-unified.16.94 (Draft photos open full size)

Store recipe: pins the image built from main `3236013`. Ships #360 (Refs humanitylabs-org/wizard-messenger#354), a bug fix with no switch: tapping a photo staged in the composer (picked, pasted, shared in or restored from a saved draft) opens it full size in Wizard's media viewer (pinch to zoom, swipe through the draft's photos), or Messenger's own full-size view when Wizard's viewer is not around; Remove still only removes. A photo still sending also opens from the phone's own copy. Guards: `tests/test_open_media.cjs`, `tests/draft_photo_open_browser.cjs`.

## 0.2.0-unified.16.93 (Messenger opens faster)

Store recipe: pins the image built from main `de25932`. Ships #358 (Refs humanitylabs-org/wizard-messenger#356), a bug fix with no switch: private (Marmot) chats no longer ask the messaging daemon for each chat's members on every list, read and send (they are kept and refreshed in the background), reads run side by side instead of queueing behind one engine lock (writes and the daemon restart still run alone), and the phone icon's private unread count comes from a snapshot of each chat's newest message, so asking for it makes no daemon call. Guards: `tests/test_engine_read_cache.py`, `tests/test_unread_count.py`, `tests/test_engine_memory_guard.py`.

## 0.2.0-unified.16.92 (Transcripts in paragraphs for everyone)

Store recipe: pins the image built from main `3c0a53b`. Ships #355 (Refs humanitylabs-org/wizard-messenger#248): the `transcript-paragraphs` switch is removed, so Transcribe on a voice note always gives the saved transcript paragraph breaks, punctuation and capitals (the raw text is saved when the words would change or the call fails). A stored value for the old switch is ignored. Guards: `tests/test_unified.py`, `tests/test_switches.py`, `tests/transcript_paragraphs_browser.cjs`.

## 0.2.0-unified.16.91 (Emoji panel like Telegram, switch off)

Store recipe: pins the image built from main `6eca887`. Ships #350 (Refs humanitylabs-org/wizard-messenger#349), behind switch `telegram-emoji` (off by default): the emoji panel gets a category bar that jumps to a section and lights the one on screen, a delete key in a bottom strip (hold to repeat, the phone keyboard stays down), a keyboard button that swaps the panel for the keyboard and back with the caret kept, skin tones on a long press (or right-click) that stick per emoji and show in Recent, a Recent of about three rows ranked by use, the phone keyboard's height on a phone, tabs in the bottom strip with a sideways swipe between them, and lazy section painting. Guards: `tests/test_telegram_emoji.cjs`, `tests/telegram_emoji_browser.cjs`, `tests/test_switches.py`.

## 0.2.0-unified.16.90 (Android Back from a chat lands on the chat list)

Store recipe: pins the image built from main `748085b`. Ships #346 (Refs humanitylabs-org/wizard-messenger#341), a bug fix switched on: on a phone, opening a chat while a private Wizard chat is open now closes the Wizard chat (it stayed on screen over the chat being opened), and the Wizard chats view with nothing of its own open answers Back by showing the chat list instead of handing Back to the Wizard (Home). Guard: `tests/android_back_thread_browser.cjs`.

## 0.2.0-unified.16.89 (Connected accounts can show and set agent levels, switch off)

Store recipe: pins the image built from main `693be81`. Ships #344 (Refs humanitylabs-org/wizard-messenger#342), behind switch `connected-accounts-levels` (off by default): an owner-only route `GET/POST /api/agent-levels` lets Connected accounts' Agent access screen list Messenger's connected chat accounts (names only) and show and change each Wizard agent's Messenger level. The level stays in Messenger's one store (the Settings > Agents row), so a change on either side shows on the other. Guards: `tests/test_agent_levels_route.py`, `tests/test_switches.py`.

## 0.2.0-unified.16.88 (saved photos keep their file name, switch off)

Store recipe: pins the image built from main `9d14a4e`. Ships #338 (Refs humanitylabs-org/wizard-messenger#337), behind switch `photo-file-names` (off by default): Save on a photo or video in Wizard's media viewer (and Save in the message menu) names the file after the photo, its own file name when the sender's app sent a real one, else `Messenger photo 2026-11-20 14.03.jpg`, instead of after the sender (`You.jpg`). The box keeps an incoming photo's file name as `media.source_name`. Guards: `tests/test_saved_media_name.cjs`, `tests/test_unified.py`.

## 0.2.0-unified.16.87 (agent inbox door: no lost pings, no double work, switch off)

Store recipe: pins the image built from main `62dfca8`. Ships #334 (Refs humanitylabs-org/wizard-messenger#325), still behind switch `agent-inbox-door` (off by default): urgent pings from the box are acked only after they are stored in the Agent chat (`GET .../pings?keep=1` + `POST .../pings {ack}`, wizard-agent-service#573), a note whose capture already went out is never handed to Messenger's own agent on a failed probe (it is sent again with the same item id), and the Yes to all label is centred. Guards: `tests/test_agent_inbox_door.py`, `tests/agent_inbox_door_browser.cjs`.

## 0.2.0-unified.16.86 (a restart shows plain words)

Store recipe: pins the image built from main `bdc6609`. Ships #332 (Refs humanitylabs-org/wizard-messenger#326), a bug fix, on for everyone: while Messenger restarts (every app update), the red notice line and toasts no longer show the raw code `server_restarting`. A chat or action the owner opens during the restart says "Messenger is restarting. Try again in a moment.", background refreshes stay quiet and retry, and the line clears by itself once Messenger answers again. Guards: `tests/test_restart_words.cjs`, `tests/restart_notice_browser.cjs`.

## 0.2.0-unified.16.85 (the Agent chat as a door to your agent inbox, switch off)

Store recipe: pins the image built from main `65045f8`. Ships #330 (Refs humanitylabs-org/wizard-messenger#325), a feature behind the off-by-default switch `agent-inbox-door` (Agent chat through your agent inbox). With it on and the box's agent inbox on (wizard-agent-service `wizard/agent-inbox`, app doors from issue 569), each Agent chat note goes to the box's inbox once as a background task (it gets its tick when the box has the record), Sweep shows the box's capped card (Waiting with up to 4 answer buttons, Open to confirm, Done, the counts, Yes to all when allowed) and answers go to the box, so Daily and Messenger show the same items. Urgent alerts arrive as one-line pings. The messenger service gets `MESSENGER_AGENT_INBOX_TOKEN` (Messenger's own app token, handed over by the App Manager, wizard-app-manager#804) and `MESSENGER_AGENT_SERVICE`. Without a token, with the inbox off, or with the switch off, the Agent chat works as before. Guards: `tests/test_agent_inbox_door.py`, `tests/test_agent_inbox_door_view.cjs`, `tests/agent_inbox_door_browser.cjs`.

## 0.2.0-unified.16.84 (open chat stays highlighted in Search)

Search's Chats section (Search finds chats by name, shipped in 16.79) now keeps the open chat highlighted on a wide window when the results redraw, and marks private chats too, like the Inbox row. Guard: `tests/search_chats_browser.cjs`. Issue 321, PR 328.

## 0.2.0-unified.16.83 (videos download ahead of time, switch off by default)

New switch Background video download (`video-prefetch`, off by default). With it on, the phone also downloads videos up to 25 MB from the newest messages of the newest chats (three per chat, after every photo), on Wi-Fi only unless Always is chosen for the background download, and the chat's bubble plays the kept copy, so one tap starts it at once. Bigger videos stream on tap; GIFs and stickers are not downloaded and still loop on their own. On cellular with Wi-Fi only, or on a phone that can't tell its network, nothing downloads. Guard: `tests/video_prefetch_browser.cjs`. Issue 320, PR 324.

## 0.2.0-unified.16.82 (one tap plays a video)

Tapping a received video used to open Wizard's viewer, a second screen whose plain player waited for another tap on play. Now one tap plays the video right in the chat, with sound; tap again to pause, and the corner button goes full screen. One video plays at a time and it pauses when scrolled away or when the chat is left. GIFs and stickers still loop on their own, muted. Downloading videos ahead of time is a separate feature (issue 320). Guard: `tests/video_one_tap_browser.cjs`. Issue 319, PR 322.

## 0.2.0-unified.16.81 (Create address works in the Mac window)

In the Mac window, Create address and every other change in Messenger were refused, and the screen said "Couldn't connect. Try again when your Wizard is reachable." The window's proxy shows the app another address than the page has (until try-wizard 119 reaches the Mac), and Messenger refused that mix. Messenger now also accepts a change the browser itself marks as coming from the same page (Sec-Fetch-Site: same-origin); the session and its CSRF token still guard it. Error lines now say what went wrong instead of always blaming the Wizard's connection. Guards: `tests/test_proxied_origin.py`, `tests/test_setup_error_words.cjs`. Issue 288, PR 317.

## 0.2.0-unified.16.80 (share a file to Messenger, switch off by default)

Store recipe: pins the image built from main `022ba04`. Ships #315 (Refs humanitylabs-org/wizard-messenger#314): with the new switch `share-files` on, Messenger tells Wizard's share sheet it also takes files (not only text, links and photos). A file shared from another Wizard app (an `.md` from a chat, a PDF) opens the chosen chat, or the Send to… picker, with the file as an attachment chip in the composer and in the chat's draft, exactly like one added with +; the owner taps Send. Over 25 MB says "too big"; a chat whose network can't carry files says so. Off: unchanged. Guards: `tests/share_image_receive.test.cjs`, `tests/share_file_receive_browser.cjs`.

## 0.2.0-unified.16.79 (search finds chats by name)

Store recipe: pins the image built from main `278f555`. Ships #311 (Miguel: typing a person's name in Search only found message text): Search is one field, "Search chats and messages". A Chats section comes first, drawn at once from the loaded chat list: chats and groups whose name, pre-rename name or merged account label contains the query (case- and accent-insensitive, every folder including Medium and Low), at most 5 with "Show all". The existing Messages results and paging follow. A chat result opens like its Inbox row (split pane on desktop, Back returns to the results); Enter opens the first result. No switch. Guard: `tests/search_chats_browser.cjs`.

## 0.2.0-unified.16.78 (messages on your phone, switch off by default)

Store recipe: pins the image built from main `b439b0a`. Ships #309 (Refs humanitylabs-org/wizard-messenger#308): with the new switch `phone-notifications` on, each new incoming message (and each urgent Agent chat ping, at high priority) is posted to the Notifications app tagged `app:messenger`, with the chat name, the start of the message and a link to the chat (`#chat=<id>`), so the Wizard phone app (wizard-ux `wizard/phone-app-notifications`) shows it as a Messenger notification. Muted, Medium and Low priority chats, WhatsApp Status and backlogs stay quiet. wizard.md now uses the `notifications` slot. Guards: `tests/test_phone_notify.py`, `tests/phone_notify_browser.cjs`.

## 0.2.0-unified.16.77 (voice-note notice no longer stays under the composer)

Store recipe: pins the image built from main `c667ad8`. Ships #306 (Refs humanitylabs-org/wizard-ux#1503): sending a message with no recording open clears any voice-note notice still under the composer, and a storage warning that arrives after its take closed is ignored. Bug fix, no switch. Guard: `tests/voice_live_notice_browser.cjs`.

## 0.2.0-unified.16.76 (private chats in the phone icon count, switch off by default)

Store recipe: pins the image built from main `bebf2e9`. Ships #304 (Refs humanitylabs-org/wizard-messenger#302): with the switch `unread-count` on, `GET /api/unread` also counts Messenger's own private chats whose newest message was received and not seen. The view hands the box only a seen message id and a quiet flag (muted, Medium or Low) per private chat through `POST /api/view/private-seen`; a locked engine keeps the last count. Response keys unchanged. Guards: `tests/test_unread_count.py`, `tests/test_view.cjs`.

## 0.2.0-unified.16.75 (unread count for the phone icon, switch off by default)

Store recipe: pins the image built from main `27e762e`. Ships #301 (Refs humanitylabs-org/wizard-messenger#296): new read-only `GET /api/unread` gives `{"unread_total": N}`, the number of chats and groups with an unread incoming message (box-side read mark; muted, Medium and Low priority never count), so the Wizard phone app can draw a count on the Messenger home-screen icon. A number only. Behind the new switch `unread-count` (off: 404). Private Messenger chats are humanitylabs-org/wizard-messenger#302. Guards: `tests/test_unread_count.py`.

## 0.2.0-unified.16.74 (the Agent chat is on for everyone)

Store recipe: pins the image built from main `f20a687`. Ships #299 (Refs humanitylabs-org/wizard-messenger#265): the Agent chat was approved, so its switch `agent-chat` is gone and it is on for every owner. The pinned Agent and Reports chats, notes with a tick, Sweep with one-tap answers, urgent pings, photo and voice notes and agent wake (#266) need no switch any more, and the `messenger_agent_chat_*` tools are always offered to agents. A stored value for the old switch is ignored and dropped. Notifications in Reports and the Hide Agent and Reports button keep their own switches. Guards: `tests/test_agent_chat.py`, `tests/agent_chat_browser.cjs`.

## 0.2.0-unified.16.73 (the emoji panel stays open for several emoji)

Store recipe: pins the image built from main `8c3267d`. Ships #295 (Refs humanitylabs-org/wizard-messenger#294), a bug fix with no switch: the composer's Emoji panel stays open while several emoji are picked in a row. On a phone a pick never brings the keyboard up (also on phones that report a fine pointer), and focus coming back to the text box without a tap no longer closes the panel. The smiley, a tap outside, a tap in the text box and sending still close it. Guard: `tests/emoji_stays_open_browser.cjs`.

## 0.2.0-unified.16.72 (a button to hide the pinned Agent and Reports chats)

Store recipe: pins the image built from main `98614c1`. Ships #292 (Refs humanitylabs-org/wizard-messenger#291), a feature behind the off-by-default switch `agent-rows-toggle` (Hide Agent and Reports button): a button right beside My QR codes (on a phone inside Wizard, a title-bar button after QR) hides the pinned Agent and Reports chats from the list, and a second tap shows them again. It shows only while Agent chat or Notifications in Reports is on, and the choice is remembered on the device. Guard: `tests/agent_rows_toggle_browser.cjs`.

## 0.2.0-unified.16.71 (creating an address while the chat relays are out of reach)

Store recipe: pins the image built from main `4d26372`. Ships #289 (Refs humanitylabs-org/wizard-messenger#288), a bug fix with no switch: creating a Messenger address no longer fails with "Couldn't connect" when the Wizard can't reach the chat relays at that moment. The address made on the Wizard is kept, setup finishes, and its keys are published as soon as the relays answer (also on the next unlock of a Wizard where an earlier try broke off). Try again after such a break now opens Messenger with the same passphrase. Guard: `tests/test_engine_offline_setup.py`.

## 0.2.0-unified.16.70 (attach menu on +)

Store recipe: pins the image built from main `a55803d`. Ships #286 (Refs humanitylabs-org/wizard-messenger#285), a bug fix with no switch: + in a chat's composer (and in the Agent chat) opens an attach menu like Telegram's paperclip, with Camera (touch screens only), Photo or video, and File (Agent chat: Camera, Photo, Voice note file), instead of jumping straight to the phone's photo gallery. Guards: `tests/test_attach_menu.cjs`, `tests/attach_menu_browser.cjs`.

## 0.2.0-unified.16.69 (Agent chat with your agent's name, behind a switch)

Store recipe: pins the image built from main `66f0a47`. Ships #280 (Refs humanitylabs-org/wizard-messenger#277) behind the off-by-default switch `agent-chat-name` (Agent chat with your agent's name): the pinned Agent chat shows the owner's agent's own name (for example Oscar) and its sigil, the Wizard hat mark in that agent's colour, instead of the word Agent. The agent is the one with Draft-only access in Settings > Agents (the main one if several; with none, the only agent, else the main agent); name, privacy and colour come from the Agent Service's agent list. "Agent" stays when no agent is known. Needs `agent-chat` on to show. Guards: `tests/test_agent_chat_name.cjs`, `tests/agent_chat_name_browser.cjs`.

## 0.2.0-unified.16.68 (Notifications in Reports, behind a switch)

Store recipe: pins the image built from main `9c9e401`. Ships #278 (Refs humanitylabs-org/wizard-messenger#276) behind the off-by-default switch `reports-notifications` (Notifications in Reports): the pinned Reports chat also shows a copy of every notification from the Notifications app (title, text, link), mixed with the agent's reports by time, newest at the bottom. Read-only; nothing changes in Notifications. The switch works on its own (Reports is pinned without the Agent chat). Guards: `tests/test_agent_chat_view.cjs`, `tests/test_agent_chat.py`, `tests/reports_notifications_browser.cjs`.

## 0.2.0-unified.16.67 (A stalled voice note shows Retry instead of staying on the clock)

Store recipe: pins the image built from main `4781577`. Ships #274 (Refs humanitylabs-org/wizard-messenger#273), a bug fix that is on for everyone: saving a voice note's original on the box and converting plus uploading it each get a deadline sized for a long take on a slow phone link (1 minute, plus 1 s per 64 KB, plus half the take's length; at most 10 minutes). When it passes, the stalled request is aborted, the bubble shows Retry, and later messages to the same person are sent instead of waiting behind it. Guard: `tests/test_voice_send_deadline.cjs`.

## 0.2.0-unified.16.66 (Agent chat opens like any other chat, behind a switch)

Store recipe: pins the image built from main `e2949df`. Ships #271 (Refs humanitylabs-org/wizard-messenger#265), off by default behind the switch `agent-chat`: the Agent chat and a separate Reports chat are pinned on top of Chats and open in the normal chat pane (header, bubbles, composer) instead of a sheet. The chat's first bubble says how it works, and the header says whether an agent listens.

## 0.2.0-unified.16.65 (Agent chat: photo and voice notes, and waking the agent, behind a switch)

Store recipe: pins the image built from main `d63864e`. Ships #269 (Refs humanitylabs-org/wizard-messenger#266), off by default behind the same switch `agent-chat`: the Agent chat takes a photo or a voice note as a note (kept on the box; Wizard's transcript is kept when there is one), and agents fetch it with `messenger_agent_chat_attachment`. An agent that calls `messenger_agent_chat_wake_me` is woken within seconds of a note, a Sweep tap or a button answer (a signed event with counts only, never words), so it needs no schedule.

## 0.2.0-unified.16.64 (Agent chat, behind a switch)

Store recipe: pins the image built from main `9779ba8`. Ships #267 (Refs humanitylabs-org/wizard-messenger#265), off by default behind switch `agent-chat`: a pinned Agent chat on top of Chats. Notes there are notes to self (the agent ticks them, never replies), Sweep asks the agent for one list of what needs the owner with one-tap answers, an urgent ping is one line that counts on the badge, and longer write-ups sit under Reports. Agents use the new `messenger_agent_chat_*` MCP tools while the switch is on.

## 0.2.0-unified.16.63 (Voice note storage warning no longer sticks)

Store recipe: pins the image built from main `bf28e62`. Ships #263 (Refs humanitylabs-org/wizard-messenger#262): a warning about the voice note being recorded (on-device saving failed, microphone stalled) now goes away when that recording is sent or discarded, instead of staying under the empty message box.

## 0.2.0-unified.16.62 (Try new features shows in Settings)

Store recipe: pins the image built from main `9ba03e7`. Ships #259 (Refs humanitylabs-org/wizard-os#627): the box now serves `wizard-try-features.js`, so the standard Try new features section at the bottom of Settings loads instead of staying hidden (the file used to get a 401 JSON answer from the API).

## 0.2.0-unified.16.61 (Agents read documents is on for everyone)

Store recipe: pins the image built from main `4249500`. Ships #258 (Refs #245): the approved switch **Agents read documents** (`agent-documents`) is removed, so `messenger_get_attachment` always returns a received PDF, Word file or other document up to 10 MB as the file itself (an MCP embedded resource) plus the text of PDFs and .docx files, for agents with Read-only or higher. Larger files still return details only. A stored value for the old switch is dropped.

## 0.2.0-unified.16.60 (Translate on your Wizard is on for everyone)

Store recipe: pins the image built from main `bd4b28a`. Ships #256 (Refs #209): the approved switch **Translate on your Wizard** (`box-translate`) is removed, so auto-translate, the send preview and a tapped Translate the browser can't do itself always use the translator that runs on the box (Argos models, downloaded once per language on first use), on every phone and browser. No message text goes to Tinfoil for translation any more; Catch me up and transcript formatting still use Tinfoil. A stored value for the old switch is dropped.

## 0.2.0-unified.16.59 (Auto-translate on this device is on for everyone)

Store recipe: pins the image built from main `8a0c831`. Ships #254 (Refs #204): the approved switch **Auto-translate on this device** (`device-auto-translate`) is removed, so in an auto-translate chat a browser with a built-in translator (Chrome on a computer) always translates incoming messages and the reply's send preview itself, and Tinfoil only translates what the browser can't or where it has none (Safari, Firefox, phones). A stored value for the old switch is dropped.

## 0.2.0-unified.16.58 (Translate uses the Wizard Tinfoil app)

Store recipe: pins the image built from main `bd8abe4`. Ships #252 (Refs #251), a bug fix, on for everyone: without an install-form `TINFOIL_API_KEY`, Translate, auto-translate, the send preview, Catch me up and transcript formatting now go through the connected Wizard Tinfoil app (a Messenger-only box token the owner's page gets from Tinfoil, kept 0600 in `unified/tinfoil-link.json`), instead of answering "Tinfoil not configured". With Tinfoil not connected the notice says so and offers Open Tinfoil. `wizard.md` now `uses: [contacts, tinfoil-api-key]`.

## 0.2.0-unified.16.57 (Transcripts in paragraphs, switch off)

Store recipe: pins the image built from main `a5f7674`. Ships #249 (Refs #248): new switch **Transcripts in paragraphs** (`transcript-paragraphs`, off by default). While it is on, Transcribe on a voice note sends the raw transcript through one Tinfoil formatting call (the private worker's Catch me up route) that adds paragraph breaks, punctuation and capitals. The result is kept only if its words are exactly the raw transcript's; otherwise, or on any error, the raw transcript is saved. A success is cached, so Retry never calls the model twice. Transcripts already saved stay as they are.

## 0.2.0-unified.16.56 (Agents read documents, switch off)

Store recipe: pins the image built from main `19c7a48`. Ships #246 (Refs #245): new switch **Agents read documents** (`agent-documents`, off by default). While it is on, `messenger_get_attachment` returns a received PDF, Word file or other document up to 10 MB as the file itself (an MCP embedded resource) plus the text of PDFs and .docx files, so an agent can read a contract and attach a filled copy to a draft. The image adds `python3-pypdf`.

## 0.2.0-unified.16.55 (Standard Try new features is on for everyone)

Store recipe: pins the image built from main `2386a9e`. Ships #243 (Refs #217): the approved switch **Standard Try new features** (`kit-try-features`) is removed, so Try new features at the bottom of Settings is always the shared Wizard section (On/Off and thumbs up / down per feature, kept on the box). Messenger's own older section is gone and a stored value is ignored.

## 0.2.0-unified.16.54 (Clean Settings is on for everyone)

Store recipe: pins the image built from main `27f2e44`. Ships #241 (Refs #202): the approved switch **Clean Settings** (`clean-settings`) is removed, so Settings is always Accounts, Agent access (with the drafts line), the one Agent drafts choice, then Try new features at the bottom. Inbox view and Suggested merges are always in the chat list's ⋯ menu and the Catch me up model is under the summary. The old Settings rows are gone and a stored value is ignored.

## 0.2.0-unified.16.53 (Translate on this device is on for everyone)

Store recipe: pins the image built from main `2c2fd1f`. Ships #239 (Refs #199): the approved switch **Translate on this device** (`on-device-translate`) is removed, so a tapped Translate always uses the browser's own built-in translator first and Tinfoil only where the browser has none. Its Settings row is gone and a stored value is ignored.

## 0.2.0-unified.16.52 (Drafts toggle at the top of an open chat)

Store recipe: pins the image built from main `8d3c31c`. Ships #237 (Refs #201): with the switch **Draft ready from the chat list** (`list-draft-ready`) on, an open chat shows a one-tap **Drafts** pill next to Catch me up (filled dot = your agent keeps a draft ready there), and the chat's ⋯ menu drops the old item. The chat list's hold / right-click item stays. Switch off, nothing changes.

## 0.2.0-unified.16.51 (Messenger reports its real version)

Store recipe: pins the image built from main `89f25da`. Ships #235 (Refs #234): `/healthz` and MCP `serverInfo` now report the installed version, set by this recipe as `MESSENGER_VERSION` next to config.json and wizard.md (before, they always said 16.35). A test fails CI when the three disagree.

## 0.2.0-unified.16.50 (Reading a chat can clear the chat app's Android notification)

Store recipe: pins the image built from main `66b5c32`. Ships #231 (Refs humanitylabs-org/wizard-ux#1276): when a bridged chat (LINE, WhatsApp, Telegram...) is marked read, Messenger tells Wizard its network and names through `WizardApp.notifications.chatRead`. With the Wizard switch `wizard/clear-chat-notifications` on and Android's Notification access given, the WizardOS Android app clears that app's own notification from the tray. With the switch off the call does nothing.

## 0.2.0-unified.16.49 (No stuck pending copy after sending a file with a caption)

Store recipe: pins the image built from main `a34a68a`. Ships #230 (Refs #228): a file sent with a caption (for example a PDF in a WhatsApp chat) shows as the file and the text, both sent, with no third copy stuck on the pending clock. The send's answer now also clears its pending bubble when live sync showed the sent message first. Bug fix, no switch.

## 0.2.0-unified.16.48 (Messenger wakes your agent for drafts, behind a switch)

Store recipe: pins the image built from main `3d57d16`. Ships #227 (Refs #223), switch `agent-wake` (off by default): when someone writes in a chat with drafts on, Messenger waits about 20 s and wakes the owner's agents that have Draft-only access and asked to be woken (MCP tool `messenger_wake_me`, a signed Hermes webhook event with only the chat id), so no agent needs a schedule. A chat where no agent could be woken shows "Drafts paused". The messenger service also gets `host.docker.internal` so an agent can name its event inbox on the Wizard.

## 0.2.0-unified.16.47 (Contact sheet shows the profile picture)

Store recipe: pins the image built from main `2eedd66`. Ships #225 (Refs #219): tapping a chat's header opens the Contact sheet with the person's real profile picture in the large circle, the same one the chat list and header show. People without a picture still show their initials. Bug fix, no switch.

## 0.2.0-unified.16.46 (a discarded agent draft stays discarded)

Store recipe: pins the image built from main `7693978`. Ships #222 (Refs #220): in a chat where the agent keeps a draft ready, discarding its draft (or sending it) now counts as the owner's answer, so the agent no longer drafts the same chat again at its next check. It drafts there again only after a new incoming message. Bug fix, no switch.

## 0.2.0-unified.16.45 (standard Try new features section, off by default)

Store recipe: pins the image built from main `563fdec`. Ships #218 (Refs #217): with the new switch `kit-try-features` on, Messenger's Settings ends with the shared Wizard "Try new features" section (the wizard-os kit component, `static/wizard-try-features.js`): one row per feature switch with On/Off and thumbs up / down, kept on the box. Each switch in the `wizard.app-switches/1` listing now also carries `tried` and `vote`, and the switches path takes `{id, vote}`. Off: Settings is unchanged.

## 0.2.0-unified.16.44 (fresh install opens into Create address on every Wizard)

Store recipe: pins the image built from main `74b0523`. Ships #215 (Refs #214): a fresh Messenger on a Wizard without the platform owner proof no longer asks for a setup link nothing can make; it opens straight into Create address (with a passphrase there), as trusted installs already did. Boxes whose operator provisions setup links keep them. Bug fix, no switch.

## 0.2.0-unified.16.43 (Translate on your Wizard, off by default)

Store recipe: pins the image built from main `6966f9c`. Ships #212 (Translate on your Wizard, `box-translate`, Refs #209: auto-translate, the send preview and Translate under a message use a translator that runs on the box itself (Argos models on CTranslate2, downloaded once per language on first use into `data/translation-models`), so no text goes to Tinfoil on any phone or browser). The translation worker's memory limit goes from 256m to 768m. The new switch is off until the owner turns it on from the Tracker.

## 0.2.0-unified.16.42 (Auto-translate on this device, off by default)

Store recipe: pins the image built from main `93c39b1`. Ships #210 (Auto-translate on this device, `device-auto-translate`, Refs #204: in an auto-translate chat, a browser with a built-in translator translates incoming messages to English and the reply's send preview itself, so nothing goes to Tinfoil; other browsers use Tinfoil as before). The new switch is off until the owner turns it on from the Tracker.

## 0.2.0-unified.16.41 (Clean Settings, off by default)

Store recipe: pins the image built from main `f7c55f4`. Ships #207 (Clean Settings, `clean-settings`, Refs #202: Settings shows only Accounts, Agent access and one Agent drafts choice; every test switch moves to Try new features at the bottom with thumbs up / down; Inbox view and Suggested merges move to the chat list's ⋯ menu; the Catch me up model moves to the Catch me up sheet). The new switch is off until the owner turns it on from the Tracker.

## 0.2.0-unified.16.40 (Draft ready from the chat list, off by default)

Store recipe: pins the image built from main `1cef86a`. Ships #205 (Draft ready from the chat list, `list-draft-ready`, Refs #201: holding or right-clicking a chat offers Agent keeps a draft ready / Stop keeping a draft ready). The new switch is off until the owner turns it on from the Tracker.

## 0.2.0-unified.16.39 (Translate on this device, off by default)

Store recipe: pins the image built from main `dcb1f41`. Ships #200 (Translate on this device, `on-device-translate`, Refs #199: a tapped Translate uses the browser's built-in translator, falling back to Tinfoil) and the switch removals #196 (drafts to new contacts, Refs #176), #197 (agent keeps drafts ready, Refs #178) and #198 (LINE photo groups, Refs #188), which are now on for everyone. The new switch is off until the owner turns it on from the Tracker.

## 0.2.0-unified.16.38 (draft and LINE switches ship; all off by default)

Store recipe: pins the image built from main `9f56aae` and the LINE bridge built from `b1c5812`. Ships #177 (drafts to new contacts, `new-contact-drafts`, Refs #176), #179 (agent keeps drafts ready, `agent-drafts`, Refs #178), #183 (`row-tap-menu`), #189/#190 (LINE photo albums both ways, `line-photo-groups`, Refs #187 #188) and the fixes #181 #185 #191 #192 #193 #194. Every new switch is off until the owner turns it on from the Tracker.

## 0.2.0-unified.16.37 (unlock fix)

Store recipe: pins the image built from main `8cafa04` (#174). A Messenger whose Wizard holds no remembered key (restart, `trusted-owner-unlock.json` missing or unreadable) now shows the unlock card once instead of sitting on "Opening your messages…"; unlocking remembers this Wizard again. Refs #162 #164.

## 0.2.0-unified.16.36 (photo-speed switches ship; all off by default)

Store recipe only: pins the image built from main `2590ec2`, which carries the photo-speed work from #163 (photos fetched on the box as they arrive, `photo-warm`), #165 (view-size copies and a thumbnail-first viewer, `photo-instant`), #167 (background photo download on the phone, `photo-prefetch`), #169 (per-stage photo timings in Settings, `photo-timings`) and #171 (ready placeholder in Wizard's viewer, `viewer-placeholder`), plus #172 (Drafts at top always on). Every photo switch is off until the owner turns it on from the Tracker. The version strings inside the image still read 16.35; the recipe version is the one the App Manager compares.

## 0.2.0-unified.16.35 (feature switches flip from the Tracker in any browser)

Messenger declares its feature switches in `wizard.md` (`switches:`), so the App Manager lists them in the box's one switch catalog next to the WizardOS core ones. With Wizard owner access on, the platform's signed owner proof alone lets the owner read and flip a switch at `/api/view/switches`: no Messenger session or unlock is needed, so the App Manager flips Drafts at top server-side when the owner taps Try it on the Tracker card, from any browser or device. Bearers and agent keys are still refused; the write still needs the box's Origin and `X-Wizard-Switch: 1`.

## 0.2.0-unified.16.34 (signing in to a network uses a normal browser, with a Paste step)

Connecting a network (Instagram, Facebook, Slack, X, LinkedIn and the others that sign in on the site itself) now opens the real site in Messenger's own normal Chromium instead of the shared Wizard Browser's stripped-down engine. The browser is a new `signin-browser` service in Messenger's recipe, using the Browser app's engine image (real Chromium on a virtual display). It sits on an internal lane that only Messenger can reach and has its own outbound network, so agents and other apps never get to it, and Messenger no longer needs the Browser app installed (`uses: []`). Each sign-in is a throw-away window: when it ends, finishes or is cancelled, its cookies are cleared and the window is destroyed. The window presents a plain desktop browser (no phone-touch emulation paired with a desktop identity, which is what sites flag as a bot).

The live view gets a **Paste** button next to Back, Tab and Enter: one tap puts what you copied (a code, an email, a link) into the field you have selected. If the phone will not hand over the clipboard, the box above still takes a long-press Paste.
