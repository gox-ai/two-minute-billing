/**
 * Pure numbers behind the shell gestures: rubber-band resistance, swipe-back thresholds,
 * pull-to-refresh progress and the row press delay. No DOM here, so it is unit-tested (test/unit/gestures.test.ts).
 * The wiring lives in `components/main-gestures.ts` and `components/ui/row-press.ts`.
 */

/** Rubber-band constant: lower is stiffer. */
export const RUBBER_C = 0.55;

/**
 * How far content moves for `distance` dragged past an edge. Starts near 1:1, then each
 * pixel moves it less; it never reaches `dimension`.
 */
export function rubberband(distance: number, dimension: number, c = RUBBER_C): number {
  if (dimension <= 0 || distance === 0) return 0;
  const x = Math.abs(distance);
  return Math.sign(distance) * (1 - 1 / ((x * c) / dimension + 1)) * dimension;
}

/** The drag distance that produces `offset`: resumes a band caught mid-settle. */
export function rubberbandInverse(offset: number, dimension: number, c = RUBBER_C): number {
  if (dimension <= 0 || offset === 0) return 0;
  const d = Math.min(Math.abs(offset), dimension * 0.999);
  return (Math.sign(offset) * d) / (c * (1 - d / dimension));
}

export const RUBBER = {
  /** A trackpad's band is shorter than a finger's: momentum into the edge must not fling it. */
  wheelDimension: 240,
  /** Touch: the band scales with the scroller, up to this. */
  touchDimension: 600,
  /** No wheel event for this long ends a trackpad gesture (the wheel has no "lift"). */
  wheelIdleMs: 120,
} as const;

/**
 * A trackpad (or other pixel-precise) wheel event, not a mouse notch. A notch has no
 * momentum to absorb, so a band on every click reads as a jolt.
 */
export function isPreciseWheel(e: {
  deltaMode: number;
  deltaY: number;
  wheelDeltaY?: number;
}): boolean {
  if (e.deltaMode !== 0) return false;
  const legacy = e.wheelDeltaY ?? 0;
  const notch = legacy !== 0 && Math.abs(legacy) % 120 === 0;
  return !(notch && Math.abs(e.deltaY) >= 50);
}

export const PULL = {
  /** Band offset (px, after resistance) at which a pull arms a refresh. */
  armAt: 64,
  /** Progress past the arm point the indicator still follows. */
  maxProgress: 1.25,
  /** The indicator shows "refreshing" at least this long, so it never flashes. */
  minMs: 500,
  /** ...and never longer than this, whatever the page reports. */
  timeoutMs: 10_000,
} as const;

/**
 * Pull-to-refresh progress for `distance` px pulled past the top: 1 at the arm point.
 * Runs through the band's resistance even where content does not move, so a pull arms at
 * the same place with or without the band.
 */
export function pullProgress(distance: number, dimension: number): number {
  if (distance <= 0) return 0;
  return Math.min(PULL.maxProgress, rubberband(distance, dimension) / PULL.armAt);
}

export const pullArmed = (progress: number): boolean => progress >= 1;

/** A refresh in flight is done: past the minimum and no longer pending, or timed out. */
export function refreshDone(elapsedMs: number, pending: boolean): boolean {
  if (elapsedMs >= PULL.timeoutMs) return true;
  return elapsedMs >= PULL.minMs && !pending;
}

export const SWIPE = {
  /** A touch swipe starts within this many px of the page's left edge. */
  edge: 20,
  /** Movement before a gesture picks its axis. */
  slop: 8,
  /** Past this fraction of the track, a release goes back. */
  commitProgress: 0.5,
  /** A flick this fast (px/ms, rightward) goes back from anywhere past `flickMinProgress`. */
  flickVelocity: 0.35,
  flickMinProgress: 0.15,
  /** Moving back toward the edge this fast (px/ms) always cancels. */
  cancelVelocity: -0.1,
  /** Trackpad travel for a full swipe; touch uses the page width. */
  trackpadTrack: 240,
  /** A new wheel gesture starts after this gap. */
  wheelGapMs: 150,
} as const;

/** Horizontal or vertical, once the pointer is past the slop; null until then. */
export function lockAxis(dx: number, dy: number, slop: number = SWIPE.slop): "x" | "y" | null {
  if (Math.hypot(dx, dy) < slop) return null;
  return Math.abs(dx) > Math.abs(dy) * 1.2 ? "x" : "y";
}

export function swipeProgress(dx: number, track: number): number {
  if (track <= 0) return 0;
  return Math.min(1, Math.max(0, dx / track));
}

/** Release: go back, or spring home. */
export function swipeCommits(progress: number, velocity: number): boolean {
  if (velocity <= SWIPE.cancelVelocity) return false;
  if (progress >= SWIPE.commitProgress) return true;
  return velocity >= SWIPE.flickVelocity && progress >= SWIPE.flickMinProgress;
}

export type Sample = { t: number; x: number };

/** px/ms over the samples within `windowMs` of the newest one. */
export function velocityOf(samples: readonly Sample[], windowMs = 100): number {
  const last = samples.at(-1);
  if (!last) return 0;
  const first = samples.find((s) => last.t - s.t <= windowMs) ?? last;
  const dt = last.t - first.t;
  return dt > 0 ? (last.x - first.x) / dt : 0;
}

export const PRESS = {
  /** Touch and pen wait this long, so a scroll or flick never lights a row. */
  touchDelayMs: 100,
  /** A tap shorter than the delay still lights the row this long. */
  flashMs: 110,
  /** Moving this far cancels the press (a scroll or a text selection). */
  slop: 8,
} as const;

/** A mouse cannot start a scroll by pressing, so it lights at once. */
export function pressDelay(pointerType: string): number {
  return pointerType === "mouse" ? 0 : PRESS.touchDelayMs;
}

type NavigatorLike = {
  userAgent: string;
  maxTouchPoints?: number;
  userAgentData?: unknown;
};

/**
 * What the browser already does on its own. Apple platforms bounce every scroller and own
 * their history swipe; Chromium lets a page turn its history swipe off with
 * `overscroll-behavior-x: none`, so there the page's swipe can replace it.
 */
export function nativeGestures(nav: NavigatorLike): {
  elasticOverscroll: boolean;
  ownsHistorySwipe: boolean;
} {
  const ua = nav.userAgent;
  // iPadOS reports itself as a Mac; touch points give it away.
  const ios =
    /iPhone|iPad|iPod/.test(ua) || (/Macintosh/.test(ua) && (nav.maxTouchPoints ?? 0) > 1);
  const mac = !ios && /Macintosh|Mac OS X/.test(ua);
  const chromium = nav.userAgentData != null;
  return {
    elasticOverscroll: ios || mac,
    ownsHistorySwipe: ios || !chromium,
  };
}

/**
 * The time fraction at which `cubic-bezier(x1, y1, x2, y2)` reaches `progress`. A committed
 * swipe starts the pop animation this far in (a negative delay), so it continues from the
 * finger instead of restarting. Needs a curve whose output rises monotonically.
 */
export function bezierTimeFor(
  progress: number,
  [x1, y1, x2, y2]: readonly [number, number, number, number],
): number {
  if (progress <= 0) return 0;
  if (progress >= 1) return 1;
  const at = (a: number, b: number, s: number) =>
    3 * a * s * (1 - s) ** 2 + 3 * b * s * s * (1 - s) + s ** 3;
  let lo = 0;
  let hi = 1;
  for (let i = 0; i < 40; i++) {
    const mid = (lo + hi) / 2;
    if (at(y1, y2, mid) < progress) lo = mid;
    else hi = mid;
  }
  return at(x1, x2, (lo + hi) / 2);
}

/** `--ease-glide`, the navigation curve (globals.css). */
export const EASE_GLIDE = [0.32, 0.72, 0, 1] as const;
