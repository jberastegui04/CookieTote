// Find mode: the types and the target list. The loop that sends frames to POST /find lives in App.tsx.

const API_URL = process.env.EXPO_PUBLIC_API_URL ?? 'http://localhost:8000';
// Free ngrok links answer with an HTML warning page unless this header is sent.
const HEADERS = { 'ngrok-skip-browser-warning': 'true' };

// Matches POST /find in the README. Keep in sync with backend/pipeline.py find().
export type FindResult = {
  found: boolean;
  target: string;
  direction: 'left' | 'ahead' | 'right' | null;
  bearing_deg: number | null; // degrees off center, right is positive, about -26 to 26
  distance_m: number | null;
  centered: boolean; // within 5 degrees: you're facing it
  box: [number, number, number, number] | null; // x, y, width, height, each 0 to 1 of the image
  sentence: string;
  obstacle: { clear: boolean; distance_m: number | null; direction: 'left' | 'ahead' | 'right' | null; open: 'left' | 'right' | null };
};

// The edge of the frame is about this many degrees off center (CAMERA_HALF_FOV_DEG in pipeline.py).
export const HALF_FOV_DEG = 26;

export async function loadFindTargets(): Promise<string[]> {
  const res = await fetch(`${API_URL}/find/targets`, { headers: HEADERS });
  if (!res.ok) throw new Error(`Server ${res.status}`);
  const data: { targets: string[] } = await res.json();
  return data.targets;
}

export const capitalize = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);
