// Swipe intent: the one threshold for every horizontal shell swipe in a chat (core swipe-back, and skin
// gestures through api.gesture.intent). Same rule in both directions.
// James, 23 Oct 2026: "an absolute subtle swipe is going back; make sure it's an intentional swipe."
// A drag only starts tracking once it is clearly sideways, and Back fires only on a long drag
// or a deliberate fast flick that stays level. Short nudges, diagonal scrolls and slow drifts snap back.
export const ENGAGE_PX = 24;      // sideways travel before the thread starts to follow the finger
export const COMMIT_PX = 120;     // a slow drag must travel this far (about a third of a phone screen)
export const FLICK_PX = 80;       // a fast flick still needs this much travel...
export const FLICK_SPEED = 0.6;   // ...at this speed (px/ms)
export const MAX_DRIFT = 50;      // vertical travel allowed during the swipe
export const LEVEL = 2.5;         // sideways travel must beat vertical travel by this ratio

export const engages = (dx, dy) => dx > ENGAGE_PX && dx > dy * 2;
export const commits = (dx, dy, ms) => {
  if (dy >= MAX_DRIFT || dx <= dy * LEVEL) return false;
  const v = dx / (ms || 1);
  return dx > COMMIT_PX || (dx > FLICK_PX && v > FLICK_SPEED);
};

// Either direction: travel is the absolute sideways distance.
export const intentional = (dx, dy, ms) => commits(Math.abs(dx), Math.abs(dy), ms);
if (typeof globalThis !== 'undefined') globalThis.WosSwipeIntent = Object.freeze({ engages, commits, intentional });
