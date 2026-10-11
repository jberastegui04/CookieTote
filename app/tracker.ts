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
  sizes: number[]; // the object's real size in meters (square root of its area), one per trusted sighting
  near: number | null; // meters, read off the box when depth clearly overstates the distance up close; else null
  nearCount: number; // answers in a row where the box said so
};

export type TrackView = {
  box: Box | null; // null when the object is outside the frame
  bearing_deg: number; // live degrees off center, right is positive (not clamped)
  stale: boolean; // no answer has matched it for a moment: draw it faded
  locked: boolean;
};

// Lock-on: after this many confident matches in a row the track is the object. A locked track
// coasts on the gyro for LOCKED_COAST_MS through misses and only moves to a candidate the detector
// keeps confidently reporting while the track should be in view (see trackUpdate); it ends only
// when Find resets it (lost, stopped) or it coasts out.
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

const CLOSE_SIZE_RATIO = 8; // close up the detector flips between the whole object and a part of it

const isClose = (t: Track) => t.w > BIG_WIDTH || (t.distance !== null && t.distance < CLOSE_M);

// Distance from the box. Up close the depth model overstates the distance (it read 2 m with the
// object at the lens), which also kept isClose() false, so none of the close-up rules above applied
// to a small object. The box doesn't have that problem: the object's real size is learned while depth
// can be trusted (SIZE_LEARN_*), and after that how big its box is says how far it is. That reading
// replaces depth only when it puts the object within NEAR_MAX_M and depth says at least NEAR_DISAGREE
// times farther, NEAR_AFTER answers in a row. Everywhere else depth stands.
const TAN_H = Math.tan((HALF_FOV_DEG * Math.PI) / 180);
const TAN_V = (TAN_H * 4) / 3; // frames are 3:4 portrait
const SIZE_LEARN_MIN_M = 1;
const SIZE_LEARN_MAX_M = 4;
const SIZE_SAMPLES = 12;
const SIZE_MIN_SAMPLES = 3;
const NEAR_MAX_M = 1.5;
const NEAR_DISAGREE = 1.4;
const NEAR_AFTER = 2;

// Meters of object (square root of its area) per meter of distance, for a box this big.
const angular = (b: Box) => 2 * Math.sqrt(b[2] * TAN_H * b[3] * TAN_V);
const clipped = (b: Box) => b[0] <= 0.02 || b[1] <= 0.02 || b[0] + b[2] >= 0.98 || b[1] + b[3] >= 0.98;

// The learned size, taken toward the large end of the samples: a box that caught only part of the
// object must not make it look nearer than it is. Too large a size just falls back to depth.
function typicalSize(sizes: number[]): number | null {
  if (sizes.length < SIZE_MIN_SAMPLES) return null;
  const sorted = [...sizes].sort((a, b) => a - b);
  return sorted[Math.floor((sorted.length - 1) * 0.75)];
}

function learnSize(sizes: number[], c: Candidate, trusted: boolean): number[] {
  const d = c.distance_m;
  if (!trusted || d === null || d < SIZE_LEARN_MIN_M || d > SIZE_LEARN_MAX_M || clipped(c.box)) return sizes;
  const size = d * angular(c.box);
  // Objects don't grow: a much bigger reading is depth overstating the distance, the thing this corrects.
  const known = typicalSize(sizes);
  if (known !== null && size > known * 1.5) return sizes;
  return [...sizes, size].slice(-SIZE_SAMPLES);
}

// The box's distance for this candidate, or null when it shouldn't replace depth. A box cut off by
// the frame edge shows only part of the object, so the object is nearer still: fine as an upper bound.
function distanceBySize(sizes: number[], c: Candidate): number | null {
  const size = typicalSize(sizes);
  if (size === null) return null;
  const d = size / angular(c.box);
  if (d > NEAR_MAX_M) return null;
  if (c.distance_m !== null && c.distance_m <= d * NEAR_DISAGREE) return null; // depth agrees
  return d;
}
const coastFor = (t: Track) => (t.locked ? LOCKED_COAST_MS : COAST_MS);
// A different object takes over only after this many answers in a row agree on it.
const SWITCH_AFTER = 2;
const LOCKED_SWITCH_AFTER = 3; // a locked track moving to where the detector keeps seeing it
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
    sizes: learnSize([], c, !!c.confident),
    near: null,
    nearCount: 0,
  };
}

// Is the candidate the same object as the track? Lower is closer; null when it doesn't qualify.
function cost(t: Track, c: Candidate, heading: number): number | null {
  const off = Math.abs(wrap(heading + c.bearing_deg - t.world));
  const size = Math.max(c.box[2] * c.box[3], 1e-6) / Math.max(t.w * t.h, 1e-6);
  // Half the box width in degrees, and wider still close up, where a step sideways moves it a lot.
  const gate = Math.max(isClose(t) ? CLOSE_GATE_DEG : GATE_DEG, (t.w * 2 * HALF_FOV_DEG) / 2);
  const ratio = isClose(t) ? CLOSE_SIZE_RATIO : GATE_SIZE_RATIO;
  if (off > gate || size > ratio || size < 1 / ratio) return null;
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
    const bySize = distanceBySize(track.sizes, best);
    const nearCount = bySize !== null ? track.nearCount + 1 : 0;
    const near = nearCount >= NEAR_AFTER ? bySize : null;
    // Learn the size only while depth and the box agree; `seen` is this answer's distance.
    const sizes = bySize === null ? learnSize(track.sizes, best, track.locked || !!best.confident) : track.sizes;
    const seen = near ?? best.distance_m;
    return {
      world: wrap(track.world + move * wrap(world - track.world)),
      y: track.y + resize * (best.box[1] - track.y),
      w: track.w + resize * (best.box[2] - track.w),
      h: track.h + resize * (best.box[3] - track.h),
      distance:
        near !== null || seen === null || track.distance === null
          ? seen ?? track.distance
          : track.distance + DISTANCE_BLEND * (seen - track.distance),
      score: best.score,
      lastSeen: now,
      matched: best,
      pending: null,
      streak,
      locked: track.locked || streak >= LOCK_AFTER,
      sizes,
      near,
      nearCount,
    };
  }
  // Nothing matched. If the server keeps pointing somewhere else, switch after SWITCH_AFTER answers.
  // A locked track used to ignore all of that and ride the gyro, so once a step sideways carried
  // the object past the gate (the gyro can't see a step), the box sat in the wrong place until it
  // coasted out. Now it moves too, but only to a confident candidate, only while the track itself
  // should be in the frame (so a second laptop can't take over while the first is off-screen), and
  // after one more answer. It stays locked and keeps the size it learned: same object, new spot.
  const top = candidates[0];
  const expected = Math.abs(wrap(track.world - hd)) <= HALF_FOV_DEG + (track.w * 2 * HALF_FOV_DEG) / 2;
  if (top && (track.locked ? !!top.confident && expected : true)) {
    const world = wrap(hd + top.bearing_deg);
    const gate = isClose(track) ? CLOSE_GATE_DEG : GATE_DEG;
    const same = track.pending && Math.abs(wrap(world - track.pending.world)) <= gate;
    const count = same ? track.pending!.count + 1 : 1;
    if (count >= (track.locked ? LOCKED_SWITCH_AFTER : SWITCH_AFTER)) {
      const next = startTrack(top, hd, now);
      return track.locked ? { ...next, locked: true, streak: track.streak, sizes: track.sizes } : next;
    }
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
