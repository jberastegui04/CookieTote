"""Obstacle pipeline (Michael).

Both functions take a PIL image and a mode ("indoor" or "outdoor") and return a dict.
main.py adds audio_b64 to the describe() result, so don't add it here.
"""
import threading
from concurrent.futures import ThreadPoolExecutor

import numpy as np
import torch
from PIL import Image
from transformers import AutoModel, AutoProcessor
from transformers import pipeline as hf_pipeline

# Warn further out outdoors since people walk faster.
WARN_DISTANCE_M = {"indoor": 2.0, "outdoor": 4.0}

DEPTH_MODELS = {
    "indoor": "depth-anything/Depth-Anything-V2-Metric-Indoor-Small-hf",
    "outdoor": "depth-anything/Depth-Anything-V2-Metric-Outdoor-Small-hf",
}

# Everything below is in fractions of the image, since the depth map can be a different size than the photo.
# Lane is the middle 60% of the width, split into three columns.
COLUMNS = {"left": (0.2, 0.4), "ahead": (0.4, 0.6), "right": (0.6, 0.8)}
# Top to bottom, no overlap, fit to venue photos (tune.py). With the phone at chest height, the top
# 20% of the frame within 2 m is ceiling, above anyone's head, so it's skipped. The foot band runs to
# the bottom of the frame: that's where the things you walk into are.
BANDS = {"head": (0.2, 0.4), "waist": (0.4, 0.65), "foot": (0.65, 1.0)}
LANE_X = (0.2, 0.8)
# The floor fills the foot band, so there a pixel only counts if it sticks up from the floor: clearly
# nearer than most of its own row across the whole width (which is the floor at that distance).
GROUND_TOP = 0.65
GROUND_REF_PERCENTILE = 60
GROUND_RAISE = 0.8  # nearer than this fraction of the row's floor distance (fit with tune.py)
GROUND_MIN_FRACTION = 0.03  # of the cell's pixels, so a speck on the floor isn't an obstacle
# Head height only warns this close. Farther up-and-away readings are mostly overhangs, signs and
# door frames above the path, and read nearer than they are.
HEAD_WARN_M = 1.2
# Low percentile instead of the minimum so a few noisy pixels can't trigger a warning.
PERCENTILE = 5
# Lane pixels this close to the obstacle distance count as part of it for the box.
BOX_MARGIN_M = 0.3
# A side only wins if it is this much closer than straight ahead in the same band. Without it,
# a flat wall flips between left and right because the columns differ by a few centimeters of noise.
SIDE_MARGIN_M = 0.15
# Same idea for height: a wall or person fills every band at about the same distance, so
# head or foot only wins if it is this much closer than waist in the same column.
BAND_MARGIN_M = 0.3
# The model reads phone photos too far away. Multiply by this to get real meters. Fit to photos
# with tape-measured distances (tune.py): indoor reads about 1.25x too far, outdoor about 2.9x.
DEPTH_SCALE = {"indoor": 0.8, "outdoor": 0.35}
# At or under this, say "very close" instead of a number.
VERY_CLOSE_M = 0.5
# Friendlier names for DETR's COCO labels.
LABEL_NAMES = {"dining table": "table"}

DETECT_MODEL = "facebook/detr-resnet-50"
# Only trust detections at least this confident.
DETECT_THRESHOLD = 0.7
# A detection must have at least this much of its own area inside the obstacle box to name it.
DETECT_MIN_OVERLAP = 0.3
# ...and be about as far away as the obstacle, so a table across the room can't name a pillar.
DETECT_DEPTH_MARGIN_M = 0.5

# GPU when the Space has one (all three models together drop from about 1.1 s to about 0.1 s a frame),
# CPU otherwise, so laptops and the CPU Space keep working unchanged.
DEVICE = "cuda" if torch.cuda.is_available() else "cpu"

# Load once at import so each request doesn't reload the model. Outdoor loads on first use.
_depth_pipes = {"indoor": hf_pipeline("depth-estimation", model=DEPTH_MODELS["indoor"], device=DEVICE)}
_detector = hf_pipeline("object-detection", model=DETECT_MODEL, device=DEVICE)
# find() runs depth and detection side by side instead of one after the other. On a GPU that
# overlaps them; on CPU it's about even, since each model already uses every core.
_parallel = ThreadPoolExecutor(max_workers=4)


def depth_map(image: Image.Image, mode: str) -> np.ndarray:
    """Depth in meters as a 2D array. Uses predicted_depth (meters), not depth (a picture for viewing)."""
    if mode not in _depth_pipes:
        _depth_pipes[mode] = hf_pipeline("depth-estimation", model=DEPTH_MODELS[mode], device=DEVICE)
    out = _depth_pipes[mode](image)
    return out["predicted_depth"].squeeze().cpu().numpy() * DEPTH_SCALE[mode]


def _rows(depth: np.ndarray, span: tuple[float, float]) -> slice:
    h = depth.shape[0]
    return slice(int(span[0] * h), int(span[1] * h))


def _cols(depth: np.ndarray, span: tuple[float, float]) -> slice:
    w = depth.shape[1]
    return slice(int(span[0] * w), int(span[1] * w))


def obstacle_mask(depth: np.ndarray) -> np.ndarray:
    """True where a pixel can be an obstacle: everything above GROUND_TOP, and below it only
    pixels that stick up from the floor of their own row."""
    mask = np.ones(depth.shape, dtype=bool)
    ground = _rows(depth, (GROUND_TOP, 1.0))
    floor = np.percentile(depth[ground], GROUND_REF_PERCENTILE, axis=1, keepdims=True)
    mask[ground] = depth[ground] < floor * GROUND_RAISE
    return mask


def _cell(depth: np.ndarray, mask: np.ndarray, ys: tuple[float, float], xs: tuple[float, float]) -> float:
    """Near edge of a lane cell in meters, or infinity if nothing in it can be an obstacle."""
    rows, cols = _rows(depth, ys), _cols(depth, xs)
    values = depth[rows, cols][mask[rows, cols]]
    if values.size < GROUND_MIN_FRACTION * depth[rows, cols].size:
        return float("inf")
    return float(np.percentile(values, PERCENTILE))


def find_obstacle(depth: np.ndarray, mode: str) -> dict | None:
    """Closest lane region within the warning distance, or None if the path is clear."""
    mask = obstacle_mask(depth)
    best = None
    cells = {}  # (direction, height) -> distance
    for direction, xs in COLUMNS.items():
        for height, ys in BANDS.items():
            d = _cell(depth, mask, ys, xs)
            cells[direction, height] = d
            if height == "head" and d > HEAD_WARN_M:
                continue
            if best is None or d < best["distance"]:
                best = {"distance": d, "direction": direction, "height": height}
    if best is None or best["distance"] > WARN_DISTANCE_M[mode]:
        return None
    # Ahead wins unless the side is clearly nearer, comparing each column's own nearest reading
    # (head only counts within HEAD_WARN_M, same as above).
    nearest = {
        c: min(d for (col, h), d in cells.items() if col == c and (h != "head" or d <= HEAD_WARN_M))
        for c in COLUMNS
    }
    if nearest["ahead"] - nearest[best["direction"]] <= SIDE_MARGIN_M:
        best["direction"] = "ahead"
    if cells[best["direction"], "waist"] - best["distance"] <= BAND_MARGIN_M:
        best["height"] = "waist"
    best["open"] = open_side(cells, best, mode)
    best["box"] = _box(depth, mask, best["distance"])
    return best


def open_side(cells: dict, best: dict, mode: str) -> str | None:
    """The side column with nothing inside the warning distance, or None.

    Only a narrow strip of the frame and only what sticks up from the floor, so it's phrased as
    "more room", never "clear": it must not read as permission to step that way.
    """
    room = {}
    for side in ("left", "right"):
        if side != best["direction"]:
            room[side] = min(cells[side, h] for h in BANDS)
    if not room:
        return None
    side = max(room, key=room.get)
    return side if room[side] > WARN_DISTANCE_M[mode] else None


def _box(depth: np.ndarray, mask: np.ndarray, distance: float) -> list[float] | None:
    """Bounding box of lane pixels within BOX_MARGIN_M of the obstacle, as x, y, width, height fractions."""
    h, w = depth.shape
    ys, xs = _rows(depth, (BANDS["head"][0], 1.0)), _cols(depth, LANE_X)
    rows, cols = np.nonzero((depth[ys, xs] <= distance + BOX_MARGIN_M) & mask[ys, xs])
    if rows.size == 0:
        return None
    x0, x1 = (cols.min() + xs.start) / w, (cols.max() + 1 + xs.start) / w
    y0, y1 = (rows.min() + ys.start) / h, (rows.max() + 1 + ys.start) / h
    return [round(float(v), 3) for v in (x0, y0, x1 - x0, y1 - y0)]


def label_for(image: Image.Image, depth: np.ndarray, distance: float, box: list[float] | None) -> str | None:
    """Name of the detected object that overlaps the obstacle box the most and sits at its distance, or None."""
    if box is None:
        return None
    w, h = image.size
    bx0, by0, bx1, by1 = box[0], box[1], box[0] + box[2], box[1] + box[3]
    best_label, best_area = None, 0.0
    for det in _detector(image, threshold=DETECT_THRESHOLD):
        b = det["box"]
        x0, y0, x1, y1 = b["xmin"] / w, b["ymin"] / h, b["xmax"] / w, b["ymax"] / h
        inter = max(0.0, min(x1, bx1) - max(x0, bx0)) * max(0.0, min(y1, by1) - max(y0, by0))
        own = (x1 - x0) * (y1 - y0)
        if own <= 0 or inter / own < DETECT_MIN_OVERLAP or inter <= best_area:
            continue
        # Nearest part of the detection, same percentile as the lane cells.
        region = depth[_rows(depth, (y0, y1)), _cols(depth, (x0, x1))]
        if region.size and abs(float(np.percentile(region, PERCENTILE)) - distance) <= DETECT_DEPTH_MARGIN_M:
            best_label, best_area = det["label"], inter
    return LABEL_NAMES.get(best_label, best_label)


def round_half(meters: float) -> float:
    return max(0.5, round(meters * 2) / 2)


def describe(image: Image.Image, mode: str) -> dict:
    depth = depth_map(image, mode)
    hit = find_obstacle(depth, mode)
    if hit is None:
        return {
            "clear": True,
            "sentence": to_sentence(None, None, None, None),
            "label": None,
            "distance_m": None,
            "direction": None,
            "height": None,
            "box": None,
            "open": None,
        }
    # Detection only runs when there's something to name, so a clear path stays fast.
    label = label_for(image, depth, hit["distance"], hit["box"])
    distance_m = round_half(hit["distance"])
    return {
        "clear": False,
        "sentence": to_sentence(label, distance_m, hit["direction"], hit["height"], hit["open"]),
        "label": label,
        "distance_m": distance_m,
        "direction": hit["direction"],
        "height": hit["height"],
        "box": hit["box"],
        "open": hit["open"],
    }


def sonar(image: Image.Image, mode: str) -> dict:
    return _sonar_result(depth_map(image, mode), mode)


def _sonar_result(depth: np.ndarray, mode: str) -> dict:
    hit = find_obstacle(depth, mode)
    if hit is None:
        return {"clear": True, "distance_m": None, "direction": None, "open": None}
    # Finer than half meters so the guide's thresholds change smoothly as you walk.
    return {"clear": False, "distance_m": round(hit["distance"], 1), "direction": hit["direction"], "open": hit["open"]}


# Find mode. Spoken name -> DETR label. Only things DETR reliably detects; its label list also has
# "door", "desk" and "window", but COCO never trained them, so those wait for an open-vocabulary model.
FIND_TARGETS = {
    "chair": "chair", "bench": "bench", "couch": "couch", "table": "dining table", "person": "person",
    "toilet": "toilet", "sink": "sink", "refrigerator": "refrigerator", "microwave": "microwave",
    "laptop": "laptop", "backpack": "backpack", "bottle": "bottle", "cup": "cup",
}
# A phone's main camera held upright sees about 52 degrees across, so the frame edge is about 26 degrees off center.
CAMERA_HALF_FOV_DEG = 26
FIND_AHEAD_DEG = 8  # within this of center, say "ahead"
FIND_CENTERED_DEG = 5  # within this, you're facing it
FIND_MAX_SPOKEN_M = 10
# Words people say for the targets, so a description like "the red sofa" still finds a couch.
FIND_SYNONYMS = {
    "sofa": "couch", "fridge": "refrigerator", "bag": "backpack", "mug": "cup", "computer": "laptop",
    "desk": "table", "man": "person", "woman": "person", "guy": "person", "girl": "person", "boy": "person",
    "someone": "person", "people": "person", "kid": "person", "child": "person", "seat": "chair",
}

# Describe-and-match: DETR finds every candidate of the noun, then SigLIP scores each crop against the
# user's words ("red bench", "person in a dark hoodie"). SigLIP scores each pair on its own (0..1), so
# the score also says whether anything matches at all. Fit on venue photos: right pick on all 7 tests;
# a clear match scored 0.2-0.99, a wrong color or absent person 0.001-0.013.
MATCH_MODEL = "google/siglip-base-patch16-224"
MATCH_YES = 0.1
MATCH_POSSIBLE = 0.01
MATCH_MAX_CANDIDATES = 5  # biggest first; scoring every chair in a full room took 2 s
DESCRIPTION_MAX_CHARS = 60
_match = {}
_match_lock = threading.Lock()


def _match_model():
    """Loaded on first use, so the server starts as fast as before."""
    with _match_lock:
        if not _match:
            _match["processor"] = AutoProcessor.from_pretrained(MATCH_MODEL)
            _match["model"] = AutoModel.from_pretrained(MATCH_MODEL).eval().to(DEVICE)
    return _match["processor"], _match["model"]


def target_from(target: str | None, description: str | None) -> str | None:
    """The FIND_TARGETS name to look for: the picked target, else the first one named in the description."""
    if target:
        return target if target in FIND_TARGETS else None
    for word in (description or "").lower().replace(",", " ").split():
        word = word.strip(".!?'\"")
        word = FIND_SYNONYMS.get(word, word)
        if word in FIND_TARGETS:
            return word
        if word.endswith("s") and word[:-1] in FIND_TARGETS:  # "chairs"
            return word[:-1]
    return None


# Spoken requests come wrapped in filler ("can you find me the ... please"). Dropped from the ends so
# the description is just the thing, which is what SigLIP matches best.
REQUEST_LEAD = (
    "please", "hey", "ok", "okay", "can you", "could you", "help me", "i want to", "i need to", "i want", "i need",
    "find me", "find", "look for", "looking for", "search for", "where is", "where's", "show me", "take me to",
    "the", "a", "an", "my", "some",
)
REQUEST_TAIL = ("please", "for me", "thanks", "thank you")


def parse_request(text: str) -> tuple[str | None, str | None]:
    """(target, description) from a spoken request like "find me the red bench please"."""
    words = "".join(c if c.isalnum() or c in " '" else " " for c in text.lower()).split()
    changed = True
    while changed and words:
        changed = False
        for phrase in REQUEST_LEAD:
            p = phrase.split()
            if words[: len(p)] == p:
                words, changed = words[len(p):], True
                break
        for phrase in REQUEST_TAIL:
            p = phrase.split()
            if len(words) > len(p) and words[-len(p):] == p:
                words, changed = words[: -len(p)], True
                break
    description = " ".join(words)[:DESCRIPTION_MAX_CHARS] or None
    return target_from(None, description), description


def _match_scores(crops: list[Image.Image], description: str) -> list[float]:
    processor, model = _match_model()
    inputs = processor(text=[f"a photo of a {description}"], images=crops, padding="max_length", return_tensors="pt").to(DEVICE)
    with torch.inference_mode():
        logits = model(**inputs).logits_per_image[:, 0]
    return torch.sigmoid(logits).tolist()


def _find_how_far(distance: float) -> str:
    """Half meters up close, whole meters farther out, so the phrase set stays small."""
    if distance <= VERY_CLOSE_M:
        return "very close"
    if distance > FIND_MAX_SPOKEN_M:
        return f"more than {FIND_MAX_SPOKEN_M} meters"
    meters = round(distance * 2) / 2 if distance < 3.25 else float(round(distance))
    return f"about {meters:g} {'meter' if meters == 1 else 'meters'}"


def find_sentence(target: str, direction: str | None, distance: float | None, match: str | None = None) -> str:
    """With a description, the sentence never repeats the user's words ("Found it", not "Red bench"),
    so every possible sentence can be on the /say allowlist and a cloned voice can't be made to say
    arbitrary text."""
    if direction is None or distance is None:
        return "No match yet. Turn slowly." if match else f"No {target} yet. Turn slowly."
    where = {"left": "slightly left", "right": "slightly right"}.get(direction, "ahead")
    name = {"yes": "Found it", "possible": "Possible match"}.get(match or "", target.capitalize())
    return f"{name}, {where}, {_find_how_far(distance)}."


def find_phrases() -> set[str]:
    """Every sentence find() can return, for the /say allowlist."""
    distances = [0.5, 1, 1.5, 2, 2.5, 3] + list(range(4, FIND_MAX_SPOKEN_M + 1)) + [FIND_MAX_SPOKEN_M + 1]
    phrases = {find_sentence("", None, None, "no")}
    for target in FIND_TARGETS:
        phrases.add(find_sentence(target, None, None))
        for direction in ("left", "ahead", "right"):
            phrases |= {find_sentence(target, direction, d) for d in distances}
    for match in ("yes", "possible"):
        for direction in ("left", "ahead", "right"):
            phrases |= {find_sentence("", direction, d, match) for d in distances}
    return phrases


def find(image: Image.Image, mode: str, target: str, description: str | None = None) -> dict:
    """Where the target is (bearing and distance), plus the usual obstacle reading from the same depth map.
    With a description, the candidate that best matches it wins, and only if it matches well enough."""
    depth_job = _parallel.submit(depth_map, image, mode)
    detections = _detector(image, threshold=DETECT_THRESHOLD)
    depth = depth_job.result()
    w, h = image.size
    wanted = FIND_TARGETS[target]
    hits = [d for d in detections if d["label"] == wanted]
    # The biggest one is usually the nearest.
    hits.sort(key=lambda d: -(d["box"]["xmax"] - d["box"]["xmin"]) * (d["box"]["ymax"] - d["box"]["ymin"]))
    result = {"found": False, "target": target, "description": description, "match": None, "match_score": None,
              "direction": None, "bearing_deg": None, "distance_m": None, "centered": False, "box": None}
    if hits and description:
        hits = hits[:MATCH_MAX_CANDIDATES]
        scores = _match_scores([image.crop((d["box"]["xmin"], d["box"]["ymin"], d["box"]["xmax"], d["box"]["ymax"])) for d in hits], description)
        best = max(range(len(hits)), key=lambda i: scores[i])
        score = scores[best]
        result["match_score"] = round(score, 3)
        result["match"] = "yes" if score >= MATCH_YES else "possible" if score >= MATCH_POSSIBLE else "no"
        hits = [hits[best]] if result["match"] != "no" else []
    elif description:
        result["match"] = "no"
    if hits:
        b = hits[0]["box"]
        x0, y0, x1, y1 = b["xmin"] / w, b["ymin"] / h, b["xmax"] / w, b["ymax"] / h
        bearing = ((x0 + x1) / 2 - 0.5) * 2 * CAMERA_HALF_FOV_DEG  # right is positive
        # Distance from the middle of the box, so floor and background at its edges don't count.
        cx, cy, hw, hh = (x0 + x1) / 2, (y0 + y1) / 2, (x1 - x0) / 4, (y1 - y0) / 4
        core = depth[_rows(depth, (cy - hh, cy + hh)), _cols(depth, (cx - hw, cx + hw))]
        distance = float(np.percentile(core, 25)) if core.size else None
        result.update(
            found=True,
            direction="ahead" if abs(bearing) <= FIND_AHEAD_DEG else ("right" if bearing > 0 else "left"),
            bearing_deg=round(bearing, 1),
            distance_m=round_half(distance) if distance is not None else None,
            centered=abs(bearing) <= FIND_CENTERED_DEG,
            box=[round(v, 3) for v in (x0, y0, x1 - x0, y1 - y0)],
        )
        result["_distance"] = distance
    result["sentence"] = find_sentence(target, result["direction"], result.pop("_distance", None), result["match"])
    result["obstacle"] = _sonar_result(depth, mode)
    return result


def to_sentence(
    label: str | None, distance_m: float | None, direction: str | None, height: str | None, open_side: str | None = None
) -> str:
    if distance_m is None:
        return "Path clear"
    tail = f". More room on the {open_side}" if open_side else ""
    meters = round(distance_m * 2) / 2  # round to half meters
    unit = "meter" if meters == 1 else "meters"
    # "1 meter ahead" reads as one phrase; "1 meter, slightly left" needs the pause.
    where = {"left": ", slightly left", "right": ", slightly right"}.get(direction or "", " ahead")
    if meters <= VERY_CLOSE_M:
        how_far = "very close"
    elif label:
        how_far = f"about {meters:g} {unit}"
    else:
        how_far = f"{meters:g} {unit}"
    if label:
        return f"{label.capitalize()}, {how_far}{where}{tail}"
    return f"Obstacle at {height} height, {how_far}{where}{tail}"
