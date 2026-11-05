# Parent handoff: attachment controller repair

## Scope and privacy

No private Messenger/Signal/Recorder databases, drafts, attachments, vaults, private agents, or owner accounts were opened. The only live HTTP reads were static `/app.js` and `/unified.js` on the loopback app port. Docker inspection was restricted to source/image metadata and mount destination names. No connector source, configuration, or runtime was changed; Slack/Instagram diagnosis is owned by the parent's separate helper.

## Exact live composite

- Container `messenger_wizardapps-messenger-1`, loopback port 9245, image config `sha256:75dde49255cdb88b789103170b69c68517a7acc6a8523fec3ee0f2174235b84e`, tag `wizard-messenger:0.2.0-unified.15.14`, OCI revision `4566306576d3a6805da1ba531da3a89214dfd7af`.
- `/unified.js` is served by that container (not the shared static root). Observed SHA256 `d3d43465fd49cae6a9535a4ffbc2ce0378505f14a99a7e629622badf3fe06b68`, byte-identical to that revision's `static/unified.js`.
- Gateway Caddy serves only `/`, `/index.html`, `/app.js`, `/app.css` from `/home/telos/.local/share/wizard-system-views/messenger/dee754a`; all other Messenger paths proxy to the container. Those three files are byte-identical at `4566306` (no composite normalization commit needed). SHA256: index `20e4cdbc1daa90092daa277833e743838acdbb17045c9e51fb334b1df7c0d06a`; app.js `37438c5d470e3ca00f8814cff45508f283bac5a2e16974efd625f667fdf475b4`; app.css `7524d12b8070905aee947c1da81ead48e8e5e4b392cc1c99fcc4b2490642d989`.
- Container's ONLY mounts target `/data`, `/wizard`, `/wizard-requests`; no source/static bind replaces `/app/static`.
- Default checkout `/home/telos/workspace/wizard-messenger` remained untouched, including its four unrelated dirty files. Candidate worktree `/home/telos/worktrees/messenger-draft-attachment-20261105`, named branch `fix/draft-attachment-signal-album-20261105`, based on actual live `4566306`, not default checkout HEAD `c93835e`.
- Filtered build-delivery control metadata showed no active overlapping Messenger repair lease at the observed snapshot. No sibling chat bodies/tails were read. Parent remains final promotion owner.

## Causal source defects addressed

1. Each picker/paste invocation started its own attachment batch; `sd.uploading` tracked only the latest promise. Separate valid selections reused the same server draft revision and raced, causing `draft_changed` and a sticky global uploadError.
2. Autosave/removal could race that same revision. A remove before PUT completed could leave an orphan persisted attachment; removing any one failed local upload cleared the global block even when another was still failed.
3. Successful retry never retried an upload or cleared a previous uploadError. Failed downloads were omitted from the tray, so the stated "Remove it" recovery was unavailable. A slow loader could also revive an obsolete tray snapshot.
4. Retry precedes send; switching conversations while it awaited I/O could otherwise let the old handler observe the new tray.

The exact owner's triggering event was not inspected. The queued old-source negative controls reproduce these causal states with strict revisions and synthetic bytes; do not call them proof of the owner's original private sequence.

## Product delta

Only `static/unified.js`: serialized attachment/removal queue sharing autosave revisions; failed state scoped to retained individual chips; retry persisted bytes/downloads; removable unavailable placeholders; failed delete restored and blocked; generation/revision/conversation fences; wait for persistence before proceeding with existing send latch. Existing sender/album/connector implementations are untouched.

`tests/test_draft_attachment_recovery.cjs` executes the REAL extracted production controller against a strict synthetic endpoint (11 cases). Browser harness uses real ViewServer/draft persistence with fake engine and mocked Matrix provider, actual shared Appearance host/client and source-pinned shell assets. It records synthetic-only sends; it never authenticates a real account. The two-skin screenshots are a hosted proxy, NOT live owner/device evidence.

## Focused queued QA

Forum staging root `/srv/work/messenger-draft-attachment-20261105`, source subdir `source`; pinned live old JS adjacent as `baseline-unified.js`; source-pinned shared shell at `shell-web`. Ready submission:

```json
{
  "key": "messenger-attachment-recovery-20261105-r1",
  "host": "forum",
  "lane": "light",
  "cwd": "/srv/work/messenger-draft-attachment-20261105/source",
  "argv": ["python3", "tests/run_attachment_recovery_forum.py"],
  "timeout_seconds": 900
}
```

The runner records old-source negative, candidate 11-case controller suite, all 7 preexisting Node test files, focused Python draft/agent/album/web suites, new browser recovery and existing double-send browser harness. It writes exact commands/logs/totals into adjacent `evidence/`. Browser provider activity is mocked. Stops its temporary fixture server in `finally`. On any failure, inspect/fix/recommit/push and queue a new revision-specific key; do not weaken expectations.

Before final acceptance inspect images, extract exact test totals from logs, run app-parity gate vs live source, and require PR final-head checks. Syntax checks alone are not QA completion.

## Deployment-ready payload/spec (parent owns activation)

`static/unified.js` plus a SHA256 manifest is the entire runtime delta; no data migration or account restart is logically needed.

**Superseded proposal — do not extend gateway matching:** the parent selected the ordinary immutable-image overlay plus existing WAM app lifecycle (see `CONTINUE.md` in the parent's attachment-readiness packet). Preserve the shared gateway matcher and its three pinned static files unchanged. The image recipe must explicitly preserve the parent's two persisted service-owner overrides for Slack/Instagram. Parent alone owns packaging admission, parity review, merge and activation; re-read metadata before any later lifecycle action.

**Container lifecycle alternative:** stage/pin the exact live image on forum, derive an image with only `COPY static/unified.js /app/static/unified.js`, preserving user/entrypoint/env and all engine/connector binaries. Build via a separate forum light admission. The forum did not have live image ID `75dde...` at discovery; never silently use its older `64c41e...` image as equivalent. Obtain/import the authorized exact base through the existing app image transport or normal source packaging with verified binary reuse. Use the existing App Manager app update lifecycle; do not change protected branches, mounts, owner data or peer bridges.

Before either activation, re-read effective source hashes/image revision to catch the parallel Slack/Instagram repair. Compose independent changes deliberately, never overwrite its deployment. Record rollback old root `/home/telos/.local/share/wizard-system-views/messenger/dee754a`, original Caddy shared matcher (three paths only), and live image ID/tag above. After activation, read exact served `/messenger/unified.js`, `/messenger/app.js`, index and app.css hashes; verify candidate and preserved files, API routing, and rollback target. No live login or message send is allowed as a test.

## Signal album addition

See `SIGNAL-ALBUM-SLICE.md`: exact pinned converter/bridgev2 diagnosis and an independent bridge-plus-app slice. The installed bridge does NOT expose a source-group field, so an app-only grouping heuristic is rejected. This branch does not claim Signal parity is fixed; parent may send that slice to a dedicated builder while the original attachment repair proceeds.

## r3 autosave navigation correction (supersedes r2 admission)

- Review found a second actual source defect: `save()` awaited uploads, then classified the old draft using the new conversation's global attachment tray. With its caption cleared, this could delete the just-uploaded old attachment draft.
- The controller now retains its own handle references, freezes text/channel/edit state and an attachment snapshot before awaiting, and rechecks a save generation plus send epoch after each suspension. Persisted attachment metadata prevents treating a completed upload as empty. Destination UI writes require exact active-controller identity as well as connected form/person. Same-person composer rebuild waits a save that is still suspended before `sd.busy` exists.
- Six added regression cases execute the real production handler with the PUT explicitly held: empty/nonempty destination, navigation flush after global reset, frozen text/channel versus destination edit state, latest-save supersession, and send-epoch non-resurrection. Together with the original eleven, the candidate controller suite requires seventeen passes with no skips/cancellations. This is a staged expectation, not a reported pass.
- `tests/run_attachment_recovery_r3_forum.py` requires the submitted manifest hash and clean exact source revision. It preserves all original r1 evidence without crediting that old JS pass at this new head; reruns the controller, existing Node, corrected two-palette browser, existing single-send and focused Python suites. Two strict old-source controls must fail at their exact named assertion with expected/actual values, never a fixture exception.
- Stage fresh `/srv/work/messenger-draft-attachment-r3-20261105`, leaving r1/r2 untouched. Parent submits the exact manifest-bound spec once. No child admission, tests outside the queue, live activation or protected merge. Inspect both new hosted skin screenshots after execution; these remain synthetic hosted-proxy evidence.
- Runtime overlap with the separate account-sign-in UX helper is only `static/unified.js`, confined here to `serverDraft()` and the previous-save wait in `composer()`. No account/settings/CSS/shared appearance assets changed. Combine deliberately after both candidates pass rather than overwriting either source.
