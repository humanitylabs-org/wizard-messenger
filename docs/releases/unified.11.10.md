# Messenger 0.2.0-unified.11.10 acceptance

REUSE: existing message menu, selection controller, Back registration, player media cache and Wizard voice API.
EXTEND: one message gesture controller for unified and Marmot renderers; internal Wizard share destination sheet in the shell; non-deleted chat-list query and existing change feed.
NEW: no parallel app sharing UI or recorder/transcriber.

## Changes
- Tap a bubble for its actions plus Forward to Wizard; interactive children retain their behavior. No Select menu item.
- Touch hold at 450 ms selects the message immediately, with no first-hold native highlight/callout. In selection mode, taps toggle messages and subsequent holds allow native text selection without toggling on lift. Cancel/Back exits selection in place. Chat-row hold/Mute is unchanged.
- Forward uses one `WizardApp.share.wizard({files,text,title})` call, with all selected attachments and sender/time/text/transcript context. Old-shell file/text sharing is used only when `.wizard` is absent.
- Chats with no non-deleted messages are excluded from lists/unreads without deleting stored history. Removed IDs travel through the existing change feed; new messages restore the row.
- Restore the accepted blue outgoing bubbles (`#2c6bed`); remove the accidental hosted skin recoloring block.

## Shell dependency
`humanitylabs-org/wizard-ux` PR https://github.com/humanitylabs-org/wizard-ux/pull/471 (`feature/app-share-wizard`). No live deployment or merge. The extracted `WizShareWizard` sheet handles native imports and in-memory app shares, both phone and desktop, with at most 10 files / 100 MB and 100000 text characters. Existing destination drafts remain intact. Shared Chats attachment cap is also 10 (previously 8).

## Proof commands
Run browser suites against a freshly reset disposable preview, never an owner's store:

```
T=multi_photo_browser env -u APP_DATA_DIR sh "$HOME/.hermes/cache/scratch/prf-run.sh"
T=transcribe_forward_browser env -u APP_DATA_DIR sh "$HOME/.hermes/cache/scratch/prf-run.sh"
T=tab_badges_browser env -u APP_DATA_DIR sh "$HOME/.hermes/cache/scratch/prf-run.sh"
T=update_speed_browser env -u APP_DATA_DIR sh "$HOME/.hermes/cache/scratch/prf-run.sh"
T=phone_vault_browser env -u APP_DATA_DIR sh "$HOME/.hermes/cache/scratch/prf-run.sh"
MSG_DIR="$PWD" OUT="$HOME/.hermes/cache/scratch/voicefix/share_receiver_browser" T=share_receiver_browser env -u APP_DATA_DIR sh "$HOME/.hermes/cache/scratch/prf-run.sh"
node --test tests/voice_speed.test.cjs
uv run --with PyYAML python -m unittest discover -s tests -q
```

Six browser suites pass (share_receiver: 9 explicit checks); voice_speed: 1 test file; Python: 103 tests. Additional boot_restart browser proof passes after rebasing the latest unified-inbox changes. Touch proof uses CDP Input.dispatchTouchEvent in isMobile/hasTouch, checks empty first-hold selection, uncancelled second-hold selectstart/contextmenu, 1→2 selected, two voice files plus text in one internal share, tap-menu forwarding, play exclusion, cancellation, fallback, native Back, and live list removal/restoration. Separate-process fixture writes pulse the preview's authenticated mutation route because PeopleStore's sequence/condition is process-local.

Shell proof: `node --test tests/app-*.test.mjs tests/components-inventory.test.mjs tests/responsive*.test.mjs tests/skin*.test.mjs tests/chats*.test.mjs tests/device*.test.mjs tests/share*.test.mjs` (150 passed). `node tests/app-share-wizard.browser.cjs` passes phone and desktop with the real installed-frame client/service/sheet and a loopback upload/chat adapter: 10 files, exactly one chat POST. A disposable checkout based on the live shell passes 128 relevant tests, including voice API compatibility, and the same browser proof. Its broader skin suite has nine unchanged baseline fixture failures (`window.addEventListener is not a function`), reproduced before the share patch.

## Transcription timing
Synthetic flite TTS, 60.0065 s Ogg Opus, never owner's audio. Measured through the real installed-frame `WizardApp.voice.transcribe` → live `WizConfig.transcribe` → `/wizard/voice/transcribe` → Voice Core on port 8864 (Tinfoil Voxtral). Alternating Ogg/WAV/WAV/Ogg/Ogg/WAV; WAV decoded and downmixed/resampled in the browser to 16 kHz mono PCM, including preparation in total elapsed time.

| Format | Three total times (ms) | Median (ms) | Bytes |
| --- | --- | --- | --- |
| Original Ogg Opus | 3983, 3643, 4540 | 3983 | 171569 |
| Browser 16 kHz mono WAV | 3780, 3741, 3587 | 3741 | 1920044 |

Browser WAV prep: 288, 319, 302 ms. All six returned the same 991-character transcription. WAV median is 242 ms lower, but ranges overlap and WAV is 11.19× larger; this does not establish a reliable phone win. Keep original format and the shared shell transcriber. Desktop dictation prefers compressed WebM when supported and already has a 16 kHz PCM fallback; format conversion is not a separate transcription service.

## Boundaries
No live Messenger/shell deployment, no Caddy edits, no merge, no owner messages inspected/sent/deleted. Physical Android native share import and real-agent forwarding delivery are not claimed verified; loopback adapters are explicitly UI/protocol evidence. Live-compatible source is a separate disposable checkout, not the running shell.
