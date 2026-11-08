/* Back on a sheet that holds something the owner could lose (James's standing rule: a single Back never discards).
 * Pure policy, no DOM. REUSE: ported from the live Android SheetBack (WINDOW_MS 2000) so one rule serves both shells.
 *   - a chooser (agent or chat picker) is open: Back closes it and the sheet stays;
 *   - the sheet has content (comment or shared items): the first Back only warns, a second Back within WINDOW_MS cancels;
 *     a late second Back warns again;
 *   - nothing to lose: Back cancels at once.
 * Cancel, the X and tapping the scrim are explicit and do not come through here; they close immediately. */
(() => {
  'use strict';
  if (window.WizSheetBack) return;
  const WINDOW_MS = 2000, NEVER = -Infinity;
  const Action = Object.freeze({CLOSE_CHOOSER: 'close-chooser', WARN: 'warn', CANCEL: 'cancel'});
  function create() {
    let choosers = 0, warnedAt = NEVER;
    return {
      openChooser() { choosers++; warnedAt = NEVER; },
      closeChooser() { if (choosers > 0) choosers--; },
      chooserOpen() { return choosers > 0; },
      back(now, hasContent = true) {
        if (choosers > 0) { choosers--; return Action.CLOSE_CHOOSER; }
        if (!hasContent) return Action.CANCEL;
        if (now - warnedAt <= WINDOW_MS) return Action.CANCEL;
        warnedAt = now;
        return Action.WARN;
      },
    };
  }
  window.WizSheetBack = Object.freeze({create, Action, WINDOW_MS, HINT: 'Press back again to cancel'});
})();
