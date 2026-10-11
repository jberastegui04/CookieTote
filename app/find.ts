// Find mode: the types and the target list. The loop that sends frames to POST /find lives in App.tsx.

const API_URL = process.env.EXPO_PUBLIC_API_URL ?? 'http://localhost:8000';
// Free ngrok links answer with an HTML warning page unless this header is sent.
const HEADERS = { 'ngrok-skip-browser-warning': 'true' };

// Matches POST /find in the README. Keep in sync with backend/pipeline.py find().
export type FindResult = {
  found: boolean;
  target: string;
  description: string | null; // the user's words, if they described it
  match: 'yes' | 'possible' | 'no' | null; // how well the best candidate fits the description
  match_score: number | null;
  direction: 'left' | 'ahead' | 'right' | null;
  bearing_deg: number | null; // degrees off center, right is positive, about -26 to 26
  distance_m: number | null;
  centered: boolean; // within 5 degrees: you're facing it
  box: [number, number, number, number] | null; // x, y, width, height, each 0 to 1 of the image
  sentence: string;
  // Every candidate this frame, best first (the first is `box`). The tracker follows one across frames.
  candidates?: { box: [number, number, number, number]; score: number; bearing_deg: number; distance_m: number | null }[];
  obstacle: {
    clear: boolean;
    distance_m: number | null;
    direction: 'left' | 'ahead' | 'right' | null;
    open: 'left' | 'right' | null;
    // The nearest thing in the lane at foot height only (box, bin, step), even when it isn't the
    // nearest obstacle. edge: it reaches the bottom of the frame, so it's about to slip out of view.
    // Older servers don't send it.
    low?: LowObstacle | null;
  };
  stale?: boolean; // app-side: the tracker hasn't seen it for a moment, so the box is drawn faded
  locked?: boolean; // app-side: the tracker locked onto it (2 confident sightings in a row)
};

export type LowObstacle = {
  distance_m: number;
  direction: 'left' | 'ahead' | 'right';
  box: [number, number, number, number];
  edge: boolean;
  open: 'left' | 'right' | null;
};

// The edge of the frame is about this many degrees off center (CAMERA_HALF_FOV_DEG in pipeline.py).
export const HALF_FOV_DEG = 26;

export async function loadFindTargets(): Promise<string[]> {
  const res = await fetch(`${API_URL}/find/targets`, { headers: HEADERS });
  if (!res.ok) throw new Error(`Server ${res.status}`);
  const data: { targets: string[] } = await res.json();
  return data.targets;
}

// Descriptions are cut to this length on the server (DESCRIPTION_MAX_CHARS in pipeline.py).
export const DESCRIPTION_MAX_CHARS = 60;

// Mirrors FIND_SYNONYMS in backend/pipeline.py.
const SYNONYMS: Record<string, string> = {
  sofa: 'couch', fridge: 'refrigerator', bag: 'backpack', mug: 'cup', computer: 'laptop',
  desk: 'table', man: 'person', woman: 'person', guy: 'person', girl: 'person', boy: 'person',
  someone: 'person', people: 'person', kid: 'person', child: 'person', seat: 'chair',
  tv: 'television', telly: 'television', macbook: 'laptop', cellphone: 'phone', iphone: 'phone',
  smartphone: 'phone', mobile: 'phone', purse: 'handbag', luggage: 'suitcase', bike: 'bicycle',
  motorbike: 'motorcycle', puppy: 'dog', kitten: 'cat', kitty: 'cat', flower: 'plant',
  flowers: 'plant', racket: 'tennis racket', bat: 'baseball bat', glove: 'baseball glove',
  hairdryer: 'hair dryer', dryer: 'hair dryer', glass: 'cup',
  'remote control': 'remote', 'cell phone': 'phone', 'stuffed animal': 'teddy bear', 'potted plant': 'plant',
  'dining table': 'table', 'sports ball': 'ball', 'hair drier': 'hair dryer', 'wine glass': 'wine glass',
};

// Which target a description names, the same way the server reads it (target_from in pipeline.py):
// the first known object name (two-word names first, then single words), after synonyms and
// plurals. Null if it names none.
export function targetFromDescription(description: string, targets: string[]): string | null {
  const words = description
    .toLowerCase()
    .replace(/,/g, ' ')
    .split(/\s+/)
    .map((raw) => raw.replace(/^[.!?'"]+|[.!?'"]+$/g, ''));
  for (let i = 0; i < words.length; i++) {
    const tries = i + 1 < words.length ? [`${words[i]} ${words[i + 1]}`, words[i]] : [words[i]];
    for (const raw of tries) {
      const word = SYNONYMS[raw] ?? raw;
      if (targets.includes(word)) return word;
      if (word.endsWith('s') && targets.includes(word.slice(0, -1))) return word.slice(0, -1);
    }
  }
  return null;
}

export const capitalize = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);
