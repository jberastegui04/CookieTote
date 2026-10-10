// Find's box tracker. The server answers about twice a second with every candidate it saw
// (FindResult.candidates); this keeps following the one we locked onto instead of jumping to
// whichever won that frame. Positions are kept in world terms (gyro heading + bearing), so the box
// stays put while the phone turns, and each answer only nudges it.
import { HALF_FOV_DEG } from './find';

export type Box = [number, number, number, number]; // x, y, width, height, each 0 to 1 of the frame
export type Candidate = {
  box: Box;
  score: number;
  bearing_deg: number;
  distance_m: number | null;
  confident?: boolean; // sure enough to count toward a lock (see FIND_CONFIDENT etc. in pipeline.py)
};

export type Track = {
  world: number; // heading + bearing of the object's center, degrees
  y: number; // top of the box, fraction of the frame
  w: number;
  h: number;
  distance: number | null;
  score: number;
  lastSeen: number; // ms; when an answer last matched it
  matched: Candidate | null; // the candidate that matched in the latest answer, if any
  pending: { world: number; count: number } | null; // a different object that keeps showing up
  streak: number; // confident matches in a row
  locked: boolean; // LOCK_AFTER confident matches in a row: this is the object, for good
};

export type TrackView = {
  box: Box | null; // null when the object is outside the frame
  bearing_deg: number; // live degrees off center, right is positive (not clamped)
  stale: boolean; // no answer has matched it for a moment: draw it faded
  locked: boolean;
};

// Lock-on: after this many confident matches in a row the track is the object. A locked track
// never switches to another object and coasts on the gyro for LOCKED_COAST_MS through misses; it
// ends only when Find resets it (lost, stopped) or it coasts out.
const LOCK_AFTER = 2;
const LOCKED_COAST_MS = 6000;

// How far each answer moves the track toward what it saw (1 = jump, like before). Adaptive: small
// differences are noise between answers and get smoothed (BLEND_MIN); a bigger one means the object
// really moved in the frame (you stepped, or first lock-on was rough), so it catches up almost at once.
const BLEND_MIN = 0.5;
const BLEND_MAX = 0.85;
const NOISE_DEG = 2; // differences up to this are treated as jitter
const FULL_DEG = 6; // at this difference and beyond, blend at BLEND_MAX
const DISTANCE_BLEND = 0.5;

function blendFor(diff: number, noise: number, full: number) {
  const t = Math.min(1, Math.max(0, (diff - noise) / (full - noise)));
  return BLEND_MIN + t * (BLEND_MAX - BLEND_MIN);
}
// An answer's candidate is the same object if its center is within this of where the track
// predicts it (or half the box's width, for big boxes), and its size is within this ratio.
// Close up both get loose on purpose (Juan's analysis): a 20 cm sidestep at 1 m moves the object
// 11 degrees without the phone turning (parallax), walking from 2 m to 1 m quadruples its area,
// and boxes clipped at the frame edges swing their centers around.
const GATE_DEG = 10;
const GATE_SIZE_RATIO = 4;
// Close or big: trust each answer as it comes (no smoothing toward the gyro guess). You're about to
// arrive, and parallax makes the gyro guess wrong there anyway.
const CLOSE_M = 1.5;
const BIG_WIDTH = 0.5; // box wider than half the frame
const CLOSE_GATE_DEG = 20;

const isClose = (t: Track) => t.w > BIG_WIDTH || (t.distance !== null && t.distance < CLOSE_M);
const coastFor = (t: Track) => (t.locked ? LOCKED_COAST_MS : COAST_MS);
// A different object takes over only after this many answers in a row agree on it.
const SWITCH_AFTER = 2;
// Keep showing the box this long after the last match (gyro moves it), faded after STALE_MS.
const COAST_MS = 1500;
const STALE_MS = 700;

const wrap = (d: number) => ((((d + 180) % 360) + 360) % 360) - 180; // to (-180, 180]

function startTrack(c: Candidate, heading: number, now: number): Track {
  return {
    world: wrap(heading + c.bearing_deg),
    y: c.box[1],
    w: c.box[2],
    h: c.box[3],
    distance: c.distance_m,
    score: c.score,
    lastSeen: now,
    matched: c,
    pending: null,
    streak: c.confident ? 1 : 0,
    locked: false,
  };
}

// Is the candidate the same object as the track? Lower is closer; null when it doesn't qualify.
function cost(t: Track, c: Candidate, heading: number): number | null {
  const off = Math.abs(wrap(heading + c.bearing_deg - t.world));
  const size = Math.max(c.box[2] * c.box[3], 1e-6) / Math.max(t.w * t.h, 1e-6);
  // Half the box width in degrees, and wider still close up, where a step sideways moves it a lot.
  const gate = Math.max(isClose(t) ? CLOSE_GATE_DEG : GATE_DEG, (t.w * 2 * HALF_FOV_DEG) / 2);
  if (off > gate || size > GATE_SIZE_RATIO || size < 1 / GATE_SIZE_RATIO) return null;
  return off + 10 * Math.abs(Math.log(size));
}

/** Fold one /find answer into the track. heading is the gyro heading when the frame was taken
 * (null without a gyro: then positions are frame-relative, which still smooths size and jitter). */
export function trackUpdate(track: Track | null, candidates: Candidate[], heading: number | null, now: number): Track | null {
  const hd = heading ?? 0;
  if (!track || now - track.lastSeen > coastFor(track)) {
    return candidates.length ? startTrack(candidates[0], hd, now) : null;
  }
  let best: Candidate | null = null;
  let bestCost = Infinity;
  for (const c of candidates) {
    const k = cost(track, c, hd);
    if (k !== null && k < bestCost) {
      best = c;
      bestCost = k;
    }
  }
  if (best) {
    const world = wrap(hd + best.bearing_deg);
    const close = isClose(track);
    const move = close ? 1 : blendFor(Math.abs(wrap(world - track.world)), NOISE_DEG, FULL_DEG);
    // Size and height: same idea, in fractions of the frame (0.02 is jitter, 0.08 is a real change).
    const sizeDiff = Math.max(
      Math.abs(best.box[1] - track.y),
      Math.abs(best.box[2] - track.w),
      Math.abs(best.box[3] - track.h),
    );
    const resize = close ? 1 : blendFor(sizeDiff, 0.02, 0.08);
    const streak = track.locked ? track.streak : best.confident ? track.streak + 1 : 0;
    return {
      world: wrap(track.world + move * wrap(world - track.world)),
      y: track.y + resize * (best.box[1] - track.y),
      w: track.w + resize * (best.box[2] - track.w),
      h: track.h + resize * (best.box[3] - track.h),
      distance:
        best.distance_m === null || track.distance === null
          ? best.distance_m ?? track.distance
          : track.distance + DISTANCE_BLEND * (best.distance_m - track.distance),
      score: best.score,
      lastSeen: now,
      matched: best,
      pending: null,
      streak,
      locked: track.locked || streak >= LOCK_AFTER,
    };
  }
  // Nothing matched. Locked: keep it (the gyro carries it). Otherwise, if the server keeps pointing
  // somewhere else, switch after SWITCH_AFTER answers.
  const top = candidates[0];
  if (top && !track.locked) {
    const world = wrap(hd + top.bearing_deg);
    const same = track.pending && Math.abs(wrap(world - track.pending.world)) <= GATE_DEG;
    const count = same ? track.pending!.count + 1 : 1;
    if (count >= SWITCH_AFTER) return startTrack(top, hd, now);
    return { ...track, matched: null, pending: { world, count } };
  }
  return { ...track, matched: null };
}

/** Where to draw the track right now, from the live gyro heading. Null once it has coasted out. */
export function trackView(track: Track | null, heading: number | null, now: number): TrackView | null {
  if (!track || now - track.lastSeen > coastFor(track)) return null;
  const bearing = wrap(track.world - (heading ?? 0));
  const center = 0.5 + bearing / (2 * HALF_FOV_DEG);
  const inView = center + track.w / 2 > 0 && center - track.w / 2 < 1;
  return {
    box: inView ? [center - track.w / 2, track.y, track.w, track.h] : null,
    bearing_deg: bearing,
    stale: now - track.lastSeen > STALE_MS,
    locked: track.locked,
  };
}
