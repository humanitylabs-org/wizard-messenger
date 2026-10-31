# Voice is opt-in, including after a chat opens

James's correction (31 Oct 2026): opening a chat must not show a recording or start the microphone.

## Root cause and reuse decision

REUSE shared `WizardApp.capture` for microphone, custody and upload acknowledgement. EXTEND its owner-scoped facade with `current()` positive running-state proof and `settle(keepId)` stop-only recovery. No app-owned recorder, MediaRecorder, native-bridge call or second custody store.

In 15.11 the composer queued `record(true)` on every open. `record` installed `view.recording`, hid the text row and painted Starting before awaiting `capture.attach()`. The guard `!own && !capture.attach` was never useful: the API always exposes attach. Attach is not a read-only probe: it waits for shared storage/recovery/lock and can resume an old native take. Thus both an empty slow store and an old native take produced James's panel without a tap.

## Contract

- A fresh, nonpersistent document token enters capture metadata only from the mic button. A live panel may be recovered only with synchronous `current()` proof: active, recording, phase recording, appId messenger, same token and original person. An existing view is also checked before restoring it after a chat rebuild. No await and no Starting flash on an unowned open.
- A mic tap still paints immediate start feedback, starts fresh capture (never probes attach first), paints the timer on recorder acknowledgement and retains the eight-second startup fallback and late-session cancellation.
- Quiet background `settle` stops an old same-app active take, or a native live take with a proven matching native ID. It never calls native start/resume, and cannot stop another app's take. A concurrent later tap is not captured by the cleanup snapshot.
- Stopped takes with duration <=600 ms or empty blobs are acknowledged silently. A real longer voice take appears as Unsent voice note, Send, Discard above the ordinary composer, addressed only to its original person/channel. Unknown destinations and uncertain/resumable native custody stay with the shared service; they are never sent to the currently open chat or blindly deleted.
- Reloading the app document does not authorize an old mic tap; returning within the same document to a still-running explicitly tapped take does restore its panel.

## Entry-point audit

Messenger has one capture.start site (the mic-button record path), one capture.attach site (strictly proven same-document running-take recovery), and one queued recover-on-open site (synchronous guard plus quiet settle). No other automatic capture start, resumeId, prepare, getUserMedia or MediaRecorder path exists in Messenger.

The shell's `app-capture.attach` is intentionally retained for apps that explicitly resume: it can call start with resumeId. `pending` and startup `recoverLocked` salvage existing recordings, not new microphones. `settle` is separately stop-only. App-services attach delegates to the same authorized host service; app-client does not own a recorder. Orb/Wizard voice gesture entry points, Recorder/meeting explicit resume and native notification recovery are not Messenger auto-entry points and are unchanged. Native recStop blocks until the existing file closes; recClaim/recRead retain it, recDone happens only after app ack. An ID-less row with uncertain native ownership is deliberately not enough authority to stop another possible native owner.

## Tests and evidence

`tests/voice_open_browser.cjs`: every animation frame for >2 seconds plus a MutationObserver, with attach deliberately hanging; no take, stale empty/tiny, real five-second leftover, orphan active native mock, Send/Discard, tap/leave/return, physical-stop stale view. It fails against 15.11 and passes here.

`tests/voice_note_record_browser.cjs`: immediate timer, hung start deadline, late completion, start/discard, rebuild, full-document reload becomes quiet chip, Send/Discard, visible busy notice.

Shared shell `qa-app-capture/orphan-settle.cjs` exercises real Chromium IndexedDB/Web Locks plus a synthetic native bridge: reload orphan stops once with no new native start; real audio retained until ack; current tap and other app are protected.

Shared shell `qa-app-capture/messenger-open-shell.cjs` runs the real shell, authorized app client and exact production composer, real synthetic browser audio, a 5-second recording and document replacement. Open composer and kept-note screenshots cover Nebula and Grove with Appearance v1 acknowledgement; composer and microphone stay usable. It also verifies the Messenger updated / Reload strip.

Physical Samsung mic routing, its current orphan state and native foreground-service behavior are not asserted: no owner databases, messages, recordings or phone storage were inspected. These are controlled reproductions and next-open self-healing logic, not on-device telemetry. The release evidence directory records source revisions, served hashes, full suites and rollback.
