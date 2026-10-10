// Find's box tracker. The server answers about twice a second with every candidate it saw
// (FindResult.candidates); this keeps following the one we locked onto instead of jumping to
// whichever won that frame. Positions are kept in world terms (gyro heading + bearing), so the box
// stays put while the phone turns, and each answer only nudges it.
import { HALF_FOV_DEG } from './find';

export type Box = [number, number, number, number]; // x, y, width, height, each 0 to 1 of the frame
export type Candidate = { box: Box; score: number; bearing_deg: number; distance_m: number | null };

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
};

export type TrackView = {
  box: Box | null; // null when the object is outside the frame
  bearing_deg: number; // live degrees off center, right is positive (not clamped)
  stale: boolean; // no answer has matched it for a moment: draw it faded
};

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
// predicts it, and its size is within this ratio.
const GATE_DEG = 10;
const GATE_SIZE_RATIO = 2.5;
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
  };
}

// Is the candidate the same object as the track? Lower is closer; null when it doesn't qualify.
function cost(t: Track, c: Candidate, heading: number): number | null {
  const off = Math.abs(wrap(heading + c.bearing_deg - t.world));
  const size = Math.max(c.box[2] * c.box[3], 1e-6) / Math.max(t.w * t.h, 1e-6);
  if (off > GATE_DEG || size > GATE_SIZE_RATIO || size < 1 / GATE_SIZE_RATIO) return null;
  return off + 10 * Math.abs(Math.log(size));
}

/** Fold one /find answer into the track. heading is the gyro heading when the frame was taken
 * (null without a gyro: then positions are frame-relative, which still smooths size and jitter). */
export function trackUpdate(track: Track | null, candidates: Candidate[], heading: number | null, now: number): Track | null {
  const hd = heading ?? 0;
  if (!track || now - track.lastSeen > COAST_MS) {
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
    const move = blendFor(Math.abs(wrap(world - track.world)), NOISE_DEG, FULL_DEG);
    // Size and height: same idea, in fractions of the frame (0.02 is jitter, 0.08 is a real change).
    const sizeDiff = Math.max(
      Math.abs(best.box[1] - track.y),
      Math.abs(best.box[2] - track.w),
      Math.abs(best.box[3] - track.h),
    );
    const resize = blendFor(sizeDiff, 0.02, 0.08);
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
    };
  }
  // Nothing matched. If the server keeps pointing somewhere else, switch after SWITCH_AFTER answers.
  const top = candidates[0];
  if (top) {
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
  if (!track || now - track.lastSeen > COAST_MS) return null;
  const bearing = wrap(track.world - (heading ?? 0));
  const center = 0.5 + bearing / (2 * HALF_FOV_DEG);
  const inView = center + track.w / 2 > 0 && center - track.w / 2 < 1;
  return {
    box: inView ? [center - track.w / 2, track.y, track.w, track.h] : null,
    bearing_deg: bearing,
    stale: now - track.lastSeen > STALE_MS,
  };
}
