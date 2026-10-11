"""Obstacle pipeline (Michael).

Both functions take a PIL image and a mode ("indoor" or "outdoor") and return a dict.
main.py adds audio_b64 to the describe() result, so don't add it here.
"""
import os
import threading
from concurrent.futures import ThreadPoolExecutor

import numpy as np
import torch
from PIL import Image
from transformers import AutoModel, AutoProcessor
from transformers import pipeline as hf_pipeline

# Warn further out outdoors since people walk faster.
WARN_DISTANCE_M = {"indoor": 2.0, "outdoor": 4.0}
# The "Warn me" setting scales that: indoors 1.5 / 2 / 3 m, outdoors 3 / 4 / 6 m.
WARNING_SCALE = {"close": 0.75, "normal": 1.0, "early": 1.5}
UNITS = ("meters", "feet")
FEET_PER_METER = 3.28084


def warn_distance(mode: str, warning: str = "normal") -> float:
    return WARN_DISTANCE_M[mode] * WARNING_SCALE[warning]

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
# Half precision on the GPU: faster on a T4, same answers to the precision we report. Each model is
# tried on a tiny image at load; if fp16 fails there, that model stays at full precision. FP16=0 in
# the Space's settings turns it off.
HALF = DEVICE == "cuda" and os.getenv("FP16", "1") != "0"


def _pipe(task: str, model: str, **probe):
    """A pipeline on DEVICE, in fp16 when HALF and it works, else fp32."""
    if HALF:
        try:
            p = hf_pipeline(task, model=model, device=DEVICE, dtype=torch.float16)
            p(Image.new("RGB", (64, 64)), **probe)
            print(f"{model}: fp16", flush=True)
            return p
        except Exception as e:  # an op without half support: keep this model at fp32
            print(f"{model}: fp16 failed ({type(e).__name__}: {e}), using fp32", flush=True)
    return hf_pipeline(task, model=model, device=DEVICE)


# Load once at import so each request doesn't reload the model. Outdoor loads on first use.
_depth_pipes = {"indoor": _pipe("depth-estimation", DEPTH_MODELS["indoor"])}
_detector = _pipe("object-detection", DETECT_MODEL)
# find() runs depth and detection side by side instead of one after the other. On a GPU that
# overlaps them; on CPU it's about even, since each model already uses every core.
_parallel = ThreadPoolExecutor(max_workers=4)


def depth_map(image: Image.Image, mode: str) -> np.ndarray:
    """Depth in meters as a 2D array. Uses predicted_depth (meters), not depth (a picture for viewing)."""
    if mode not in _depth_pipes:
        _depth_pipes[mode] = _pipe("depth-estimation", DEPTH_MODELS[mode])
    out = _depth_pipes[mode](image)
    return out["predicted_depth"].squeeze().float().cpu().numpy() * DEPTH_SCALE[mode]


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


def find_obstacle(depth: np.ndarray, warn_m: float, mask: np.ndarray | None = None) -> dict | None:
    """Closest lane region within the warning distance, or None if the path is clear."""
    if mask is None:
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
    if best is None or best["distance"] > warn_m:
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
    best["box"] = _box(depth, mask, best["distance"])
    if best["box"]:
        # Direction from where the near pixels actually sit, not which column won by a few cm (a
        # flat floor or wall ties the columns and said "ahead" for a box clearly on the left).
        # Right on 15 of 21 labeled photos, up from 12; the rest are frame-filling or debatable.
        center = best["box"][0] + best["box"][2] / 2
        best["direction"] = "left" if center < DIRECTION_LEFT else "right" if center > DIRECTION_RIGHT else "ahead"
    best["open"] = open_side(cells, best, warn_m)
    return best


# Near-pixel center (fraction of the frame width) beyond which an obstacle is to one side.
DIRECTION_LEFT = 0.4
DIRECTION_RIGHT = 0.6


def open_side(cells: dict, best: dict, warn_m: float) -> str | None:
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
    return side if room[side] > warn_m else None


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


def describe(image: Image.Image, mode: str, warning: str = "normal", units: str = "meters") -> dict:
    depth = depth_map(image, mode)
    hit = find_obstacle(depth, warn_distance(mode, warning))
    if hit is None:
        return {
            "clear": True,
            "sentence": to_sentence(None, None, None, None, units=units),
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
        "sentence": to_sentence(label, distance_m, hit["direction"], hit["height"], hit["open"], units),
        "label": label,
        "distance_m": distance_m,
        "direction": hit["direction"],
        "height": hit["height"],
        "box": hit["box"],
        "open": hit["open"],
    }


def sonar(image: Image.Image, mode: str, warning: str = "normal") -> dict:
    return _sonar_result(depth_map(image, mode), warn_distance(mode, warning))


def _sonar_result(depth: np.ndarray, warn_m: float, mask: np.ndarray | None = None, with_box: bool = False) -> dict:
    """The /sonar fields; with_box adds `box` (Find uses it to tell when a detour has passed the obstacle)."""
    hit = find_obstacle(depth, warn_m, mask)
    if hit is None:
        result = {"clear": True, "distance_m": None, "direction": None, "open": None}
    else:
        # Finer than half meters so the guide's thresholds change smoothly as you walk.
        result = {"clear": False, "distance_m": round(hit["distance"], 1), "direction": hit["direction"], "open": hit["open"]}
    if with_box:
        result["box"] = hit["box"] if hit else None
    return result


# Find mode. Spoken name -> DETR label. Only things DETR reliably detects; its label list also has
# "door", "desk" and "window", but COCO never trained them, so those wait for an open-vocabulary model.
# Spoken name -> DETR label. Every class DETR was trained on (COCO's 80, minus "orange": as a color
# word it would hijack "find the orange chair"). DETR's config also lists door, desk, window, mirror
# and a few more, but it never predicts them (no COCO annotations), so they go to the open-vocabulary
# detector like anything else not listed here.
FIND_TARGETS = {
    # Furniture and rooms
    "chair": "chair", "bench": "bench", "couch": "couch", "table": "dining table", "bed": "bed",
    "plant": "potted plant", "toilet": "toilet", "sink": "sink",
    # Kitchen
    "refrigerator": "refrigerator", "microwave": "microwave", "oven": "oven", "toaster": "toaster",
    "bottle": "bottle", "cup": "cup", "wine glass": "wine glass", "bowl": "bowl",
    "fork": "fork", "knife": "knife", "spoon": "spoon",
    # Electronics
    "laptop": "laptop", "television": "tv", "keyboard": "keyboard", "mouse": "mouse",
    "remote": "remote", "phone": "cell phone",
    # Around the house
    "book": "book", "clock": "clock", "vase": "vase", "scissors": "scissors", "teddy bear": "teddy bear",
    "hair dryer": "hair drier", "toothbrush": "toothbrush",
    # Carried
    "backpack": "backpack", "handbag": "handbag", "suitcase": "suitcase", "umbrella": "umbrella", "tie": "tie",
    # People and animals
    "person": "person", "dog": "dog", "cat": "cat", "bird": "bird", "horse": "horse", "sheep": "sheep",
    "cow": "cow", "elephant": "elephant", "bear": "bear", "zebra": "zebra", "giraffe": "giraffe",
    # Outside
    "bicycle": "bicycle", "car": "car", "motorcycle": "motorcycle", "bus": "bus", "train": "train",
    "truck": "truck", "boat": "boat", "airplane": "airplane", "traffic light": "traffic light",
    "fire hydrant": "fire hydrant", "stop sign": "stop sign", "parking meter": "parking meter",
    # Sports
    "ball": "sports ball", "frisbee": "frisbee", "kite": "kite", "skateboard": "skateboard",
    "surfboard": "surfboard", "skis": "skis", "snowboard": "snowboard", "baseball bat": "baseball bat",
    "baseball glove": "baseball glove", "tennis racket": "tennis racket",
    # Food
    "banana": "banana", "apple": "apple", "sandwich": "sandwich", "pizza": "pizza", "donut": "donut",
    "cake": "cake", "hot dog": "hot dog", "broccoli": "broccoli", "carrot": "carrot",
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
    "tv": "television", "telly": "television", "macbook": "laptop", "cellphone": "phone", "iphone": "phone",
    "smartphone": "phone", "mobile": "phone", "purse": "handbag", "luggage": "suitcase", "bike": "bicycle",
    "motorbike": "motorcycle", "puppy": "dog", "kitten": "cat", "kitty": "cat", "flower": "plant",
    "flowers": "plant", "racket": "tennis racket", "bat": "baseball bat", "glove": "baseball glove",
    "hairdryer": "hair dryer", "dryer": "hair dryer", "glass": "cup",
    # Two-word phrases are checked before single words, so "remote control" doesn't become "remote" twice.
    "remote control": "remote", "cell phone": "phone", "stuffed animal": "teddy bear", "potted plant": "plant",
    "dining table": "table", "sports ball": "ball", "hair drier": "hair dryer", "wine glass": "wine glass",
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


# Anything else people ask for ("door", "exit sign", "trash can") goes to OWLv2, which searches for
# whatever words it's given. Slower than DETR (about 20 s a frame on a laptop CPU, a fraction of a
# second on the T4) and less sure of itself, so it says "Possible match" more often. Thresholds fit
# on venue photos with tune-style tests (see the commit).
OPEN_VOCAB_MODEL = "google/owlv2-base-patch16-ensemble"
OPEN_YES = 0.4  # things present scored 0.39-0.60, absent 0.01-0.13
OPEN_POSSIBLE = 0.2
# A box smaller than this share of the frame is a far-off speck: never more than "Possible match".
# The one confident wrong answer in testing ("fire extinguisher", 0.445) was a 0.04% red dot on a far wall;
# real objects were 6-38%, and a far exit sign 0.15% (already "possible" on its score).
OPEN_MIN_SURE_AREA = 0.005
OPEN_QUERY_CHARS = set("abcdefghijklmnopqrstuvwxyz '-")
_open = {}
_open_lock = threading.Lock()


def _open_detector():
    """Loaded on first use, so the server starts as fast as before."""
    with _open_lock:
        if "pipe" not in _open:
            _open["pipe"] = _pipe("zero-shot-object-detection", OPEN_VOCAB_MODEL, candidate_labels=["door"])
    return _open["pipe"]


def open_query(text: str | None) -> str | None:
    """Cleaned words for an open-vocabulary search, or None if there's nothing usable."""
    text = " ".join((text or "").lower().split())[:DESCRIPTION_MAX_CHARS]
    if not text or not set(text) <= OPEN_QUERY_CHARS or not any(c.isalpha() for c in text):
        return None
    return text


def _match_model():
    """Loaded on first use, so the server starts as fast as before."""
    with _match_lock:
        if not _match:
            _match["processor"] = AutoProcessor.from_pretrained(MATCH_MODEL)
            model = AutoModel.from_pretrained(MATCH_MODEL).eval().to(DEVICE)
            if HALF:
                try:
                    model = model.half()
                    with torch.inference_mode():
                        model(**_match_inputs(_match["processor"], model, ["a photo"], [Image.new("RGB", (64, 64))]))
                    print(f"{MATCH_MODEL}: fp16", flush=True)
                except Exception as e:
                    print(f"{MATCH_MODEL}: fp16 failed ({type(e).__name__}: {e}), using fp32", flush=True)
                    model = model.float()
            _match["model"] = model
    return _match["processor"], _match["model"]


def target_from(target: str | None, description: str | None) -> str | None:
    """The FIND_TARGETS name to look for: the picked target, else the first one named in the description."""
    if target:
        return target if target in FIND_TARGETS else None
    words = [w.strip(".!?'\"") for w in (description or "").lower().replace(",", " ").split()]
    for i, word in enumerate(words):
        # Two-word names first ("teddy bear", "cell phone"), then the word on its own.
        for candidate in ([f"{word} {words[i + 1]}"] if i + 1 < len(words) else []) + [word]:
            candidate = FIND_SYNONYMS.get(candidate, candidate)
            if candidate in FIND_TARGETS:
                return candidate
            if candidate.endswith("s") and candidate[:-1] in FIND_TARGETS:  # "chairs"
                return candidate[:-1]
    return None


# Spoken requests come wrapped in filler ("can you find me the ... please"). Dropped from the ends so
# the description is just the thing, which is what SigLIP matches best.
REQUEST_LEAD = (
    # "listening": VoiceOver's own announcement can end up at the start of the recording.
    "listening", "please", "hey", "ok", "okay", "can you", "could you", "help me", "i want to", "i need to", "i want", "i need",
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
    inputs = _match_inputs(processor, model, [f"a photo of a {description}"], crops)
    with torch.inference_mode():
        logits = model(**inputs).logits_per_image[:, 0]
    return torch.sigmoid(logits.float()).tolist()


def _match_inputs(processor, model, texts: list[str], images: list[Image.Image]):
    inputs = processor(text=texts, images=images, padding="max_length", return_tensors="pt").to(DEVICE)
    inputs["pixel_values"] = inputs["pixel_values"].to(model.dtype)  # fp16 model on the GPU
    return inputs


def feet_words(meters: float) -> str:
    """Whole feet up close, nearest 5 feet beyond 10, e.g. "7 feet", "15 feet"."""
    feet = meters * FEET_PER_METER
    feet = round(feet) if feet < 10 else 5 * round(feet / 5)
    return f"{feet:g} {'foot' if feet == 1 else 'feet'}"


def _find_how_far(distance: float, units: str = "meters") -> str:
    """Half meters up close, whole meters farther out, so the phrase set stays small."""
    if distance <= VERY_CLOSE_M:
        return "very close"
    if distance > FIND_MAX_SPOKEN_M:
        return f"more than {feet_words(FIND_MAX_SPOKEN_M)}" if units == "feet" else f"more than {FIND_MAX_SPOKEN_M} meters"
    if units == "feet":
        return f"about {feet_words(distance)}"
    meters = round(distance * 2) / 2 if distance < 3.25 else float(round(distance))
    return f"about {meters:g} {'meter' if meters == 1 else 'meters'}"


# Find tells the user what to do, in two sizes: up to this many degrees off is "turn a little left",
# beyond it (out to the edge of the frame) "turn left". "Slightly left" said where the target was, not
# what to do, and gave no idea of how much. The distance is its own instruction ("... and walk about
# 2 meters"): with only a comma between them it was heard as "turn left about 2 meters".
# Mirrored in findSentence() in app/App.tsx.
FIND_SMALL_TURN_DEG = 15


def find_sentence(
    target: str, direction: str | None, distance: float | None, match: str | None = None, units: str = "meters",
    small: bool = True,
) -> str:
    """With a description, the sentence never repeats the user's words ("Found it", not "Red bench"),
    so every possible sentence can be on the /say allowlist and a cloned voice can't be made to say
    arbitrary text."""
    if direction is None or distance is None:
        return "No match yet. Turn slowly." if match else f"No {target} yet. Turn slowly."
    name = {"yes": "Found it", "possible": "Possible match"}.get(match or "", target.capitalize())
    far = _find_how_far(distance, units)
    if direction not in ("left", "right"):
        return f"{name}, ahead, {far}."
    turn = f"turn a little {direction}" if small else f"turn {direction}"
    if far == "very close":
        # Within reach nobody turns and walks: say where it is. (Not "right in front of you": "right"
        # would collide with the direction.)
        return f"{name}, very close, {'a little ' if small else ''}to your {direction}."
    return f"{name}, {turn} and walk {far}."


def find_phrases() -> set[str]:
    """Every sentence find() can return, for the /say allowlist. Distances are sampled every 5 cm,
    so every rounding the sentence can produce, in meters or feet, is covered."""
    distances = [round(0.5 + 0.05 * i, 2) for i in range(int((FIND_MAX_SPOKEN_M - 0.5) / 0.05) + 2)]
    phrases = {find_sentence("", None, None, "no")}
    for units in UNITS:
        for direction, small in (("left", True), ("left", False), ("ahead", True), ("right", True), ("right", False)):
            for d in distances:
                for target in FIND_TARGETS:
                    phrases.add(find_sentence(target, direction, d, None, units, small))
                for match in ("yes", "possible"):
                    phrases.add(find_sentence("", direction, d, match, units, small))
    for target in FIND_TARGETS:
        phrases.add(find_sentence(target, None, None))
    return phrases


# Automatic indoor/outdoor: SigLIP (already loaded for descriptions) compares the frame with these
# two captions. Right on all 25 venue photos, with a wide margin (indoor -5.7 to -8.9, outdoor +2.3 to +6.6).
SCENE_PROMPTS = ("a photo taken indoors", "a photo taken outdoors")


def guess_scene(image: Image.Image) -> str:
    processor, model = _match_model()
    inputs = _match_inputs(processor, model, list(SCENE_PROMPTS), [image])
    with torch.inference_mode():
        logits = model(**inputs).logits_per_image[0].float()
    return "outdoor" if float(logits[1] - logits[0]) > 0 else "indoor"


def find(
    image: Image.Image, mode: str, target: str, description: str | None = None,
    warning: str = "normal", units: str = "meters",
) -> dict:
    """Where the target is (bearing and distance), plus the usual obstacle reading from the same depth map.
    With a description, the candidate that best matches it wins, and only if it matches well enough.
    A target that isn't in FIND_TARGETS ("door", "exit sign") goes to the open-vocabulary detector."""
    open_vocab = target not in FIND_TARGETS
    depth_job = _parallel.submit(depth_map, image, mode)
    result = {"found": False, "target": target, "description": description, "open_vocab": open_vocab,
              "match": None, "match_score": None,
              "direction": None, "bearing_deg": None, "distance_m": None, "centered": False, "box": None}
    w, h = image.size
    # (detection, score) pairs, best first. The app's tracker gets all of them as `candidates`, so it
    # can keep following the object it locked onto instead of jumping to whichever won this frame.
    ranked: list[tuple[dict, float]] = []
    if open_vocab:
        found = _open_detector()(image, candidate_labels=[description or target], threshold=OPEN_POSSIBLE)
        ranked = [(d, d["score"]) for d in sorted(found, key=lambda d: -d["score"])]
        best = ranked[0][0] if ranked else None
        result["match_score"] = round(best["score"], 3) if best else None
        result["match"] = "no" if best is None else "yes" if best["score"] >= OPEN_YES else "possible"
        if best and result["match"] == "yes":
            b = best["box"]
            if (b["xmax"] - b["xmin"]) * (b["ymax"] - b["ymin"]) / (w * h) < OPEN_MIN_SURE_AREA:
                result["match"] = "possible"
        description = None  # already used as the search words
    else:
        detections = _detector(image, threshold=DETECT_THRESHOLD)
        hits = [d for d in detections if d["label"] == FIND_TARGETS[target]]
        # The biggest one is usually the nearest.
        hits.sort(key=lambda d: -(d["box"]["xmax"] - d["box"]["xmin"]) * (d["box"]["ymax"] - d["box"]["ymin"]))
        hits = hits[:MATCH_MAX_CANDIDATES]
        if hits and description:
            scores = _match_scores([image.crop((d["box"]["xmin"], d["box"]["ymin"], d["box"]["xmax"], d["box"]["ymax"])) for d in hits], description)
            ranked = sorted(zip(hits, scores), key=lambda p: -p[1])
            score = ranked[0][1]
            result["match_score"] = round(score, 3)
            result["match"] = "yes" if score >= MATCH_YES else "possible" if score >= MATCH_POSSIBLE else "no"
            ranked = [(d, s) for d, s in ranked if s >= MATCH_POSSIBLE]
        else:
            ranked = [(d, d["score"]) for d in hits]
            if description:
                result["match"] = "no"
    depth = depth_job.result()
    candidates = [_locate(d["box"], s, w, h, depth) for d, s in ranked[:FIND_MAX_CANDIDATES]]
    # Sure enough to lock onto (the app locks after 2 confident matches in a row): a very sure DETR
    # detection, a strong description match, or a strong open-vocab match that isn't a far-off speck.
    for c, (d, s) in zip(candidates, ranked):
        if open_vocab:
            c["confident"] = s >= OPEN_YES and c["box"][2] * c["box"][3] >= OPEN_MIN_SURE_AREA
        elif description:
            c["confident"] = s >= MATCH_YES
        else:
            c["confident"] = s >= FIND_CONFIDENT
    if candidates and result["match"] != "no":
        best = candidates[0]
        result.update(
            found=True,
            direction="ahead" if abs(best["bearing_deg"]) <= FIND_AHEAD_DEG else ("right" if best["bearing_deg"] > 0 else "left"),
            bearing_deg=best["bearing_deg"],
            distance_m=round_half(best["_distance"]) if best["_distance"] is not None else None,
            centered=abs(best["bearing_deg"]) <= FIND_CENTERED_DEG,
            box=best["box"],
        )
        result["_distance"] = best["_distance"]
    else:
        candidates = []
    target_distance = result.pop("_distance", None)
    small = result["bearing_deg"] is None or abs(result["bearing_deg"]) <= FIND_SMALL_TURN_DEG
    result["sentence"] = find_sentence(target, result["direction"], target_distance, result["match"], units, small)
    for c in candidates:
        c.pop("_distance")
    result["candidates"] = candidates
    warn_m = max(warn_distance(mode, warning), FIND_OBSTACLE_M * WARNING_SCALE[warning])
    mask = obstacle_mask(depth)
    if result["found"] and target_distance is not None:
        # Only what's clearly nearer than the target can be in the way: you stop when you get there.
        # That leaves out the target itself, and a wall beside or behind it, which used to start a
        # detour ("something close on your left") just before arriving. A box on the floor in front of
        # it still counts. Both distances come from this depth map, so its overreading up close cancels.
        mask &= depth < target_distance - FIND_SELF_M
    obstacle = _sonar_result(depth, warn_m, mask, with_box=True)
    obstacle["low"] = low_obstacle(depth, mask, warn_m)
    result["obstacle"] = obstacle
    return result


def low_obstacle(depth: np.ndarray, mask: np.ndarray, warn_m: float) -> dict | None:
    """The nearest thing in the lane that only sticks up at foot height (a box, a bin, a step), or None.

    These are the trip hazards that slide out the bottom of the frame as you walk up to them: with the
    phone held up at the target, the floor under about the last 1.5 m isn't in view at all. They also
    read too far up close (a box and a bin really 0.5 m away read 1.1-1.3 m). So the app warns about
    them earlier than other obstacles, especially once `edge` is set: their near pixels reach the
    bottom of the frame, so they're about to leave the picture.
    """
    best = None
    for direction, xs in COLUMNS.items():
        foot = _cell(depth, mask, BANDS["foot"], xs)
        # Low only: nothing at waist height about as near (a wall, a person or a chair is both).
        if foot <= warn_m and foot < _cell(depth, mask, BANDS["waist"], xs) - BAND_MARGIN_M:
            if best is None or foot < best["distance"]:
                best = {"distance": foot, "direction": direction}
    if best is None:
        return None
    h, w = depth.shape
    ys, xs = _rows(depth, BANDS["foot"]), _cols(depth, LANE_X)
    rows, cols = np.nonzero((depth[ys, xs] <= best["distance"] + BOX_MARGIN_M) & mask[ys, xs])
    if rows.size == 0:
        return None
    x0, x1 = (cols.min() + xs.start) / w, (cols.max() + 1 + xs.start) / w
    y0, y1 = (rows.min() + ys.start) / h, (rows.max() + 1 + ys.start) / h
    center = (x0 + x1) / 2
    best["direction"] = "left" if center < DIRECTION_LEFT else "right" if center > DIRECTION_RIGHT else "ahead"
    cells = {(d, b): _cell(depth, mask, ys_, xs_) for d, xs_ in COLUMNS.items() for b, ys_ in BANDS.items()}
    return {
        "distance_m": round(best["distance"], 1),
        "direction": best["direction"],
        "box": [round(float(v), 3) for v in (x0, y0, x1 - x0, y1 - y0)],
        "edge": bool(y1 >= LOW_EDGE),
        "open": open_side(cells, best, warn_m),
    }


# A low obstacle whose near pixels reach this far down the frame (fraction of the height) is at the
# bottom edge. In the venue photos: the box and bin 0.5 m away and the stairs reach 1.0, a chair 1 m
# away 0.84, a table 1.5 m away 0.71.
LOW_EDGE = 0.95


FIND_MAX_CANDIDATES = 5
# While finding, the user is looking at the target, not the path, so obstacles ahead are reported
# from further out than the guide's indoor 2 m (scaled by "Warn me"): about 3.5 m by default.
FIND_OBSTACLE_M = 3.5
# Once the target is found, obstacles only count this much nearer than it (the target, and walls
# beside or behind it, are no farther).
FIND_SELF_M = 0.6


# DETR's own score for a known target that's sure enough to lock onto (it finds them at 0.7+; real
# chairs in the venue photos scored 0.98-1.0).
FIND_CONFIDENT = 0.9


def _locate(b: dict, score: float, w: int, h: int, depth: np.ndarray) -> dict:
    """Box (x, y, width, height fractions), bearing, and distance of one detection."""
    x0, y0, x1, y1 = b["xmin"] / w, b["ymin"] / h, b["xmax"] / w, b["ymax"] / h
    bearing = ((x0 + x1) / 2 - 0.5) * 2 * CAMERA_HALF_FOV_DEG  # right is positive
    # Distance from the middle of the box, so floor and background at its edges don't count.
    cx, cy, hw, hh = (x0 + x1) / 2, (y0 + y1) / 2, (x1 - x0) / 4, (y1 - y0) / 4
    core = depth[_rows(depth, (cy - hh, cy + hh)), _cols(depth, (cx - hw, cx + hw))]
    distance = float(np.percentile(core, 25)) if core.size else None
    return {
        "box": [round(v, 3) for v in (x0, y0, x1 - x0, y1 - y0)],
        "score": round(float(score), 3),
        "bearing_deg": round(bearing, 1),
        "distance_m": round_half(distance) if distance is not None else None,
        "_distance": distance,
    }


def to_sentence(
    label: str | None, distance_m: float | None, direction: str | None, height: str | None,
    open_side: str | None = None, units: str = "meters",
) -> str:
    if distance_m is None:
        return "Path clear"
    tail = f". More room on the {open_side}" if open_side else ""
    meters = round(distance_m * 2) / 2  # round to half meters
    amount = feet_words(meters) if units == "feet" else f"{meters:g} {'meter' if meters == 1 else 'meters'}"
    # "1 meter ahead" reads as one phrase; "1 meter, slightly left" needs the pause.
    where = {"left": ", slightly left", "right": ", slightly right"}.get(direction or "", " ahead")
    if meters <= VERY_CLOSE_M:
        how_far = "very close"
    elif label:
        how_far = f"about {amount}"
    else:
        how_far = amount
    if label:
        return f"{label.capitalize()}, {how_far}{where}{tail}"
    return f"Obstacle at {height} height, {how_far}{where}{tail}"
