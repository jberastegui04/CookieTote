"""Obstacle pipeline (Michael).

Both functions take a PIL image and a mode ("indoor" or "outdoor") and return a dict.
main.py adds audio_b64 to the describe() result, so don't add it here.
"""
import numpy as np
from PIL import Image
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
# 20% of the frame within 2 m is ceiling, above anyone's head, so it's skipped. Below 75% is
# ignored because the floor fills the bottom of the frame when the phone tilts down.
BANDS = {"head": (0.2, 0.4), "waist": (0.4, 0.65), "foot": (0.65, 0.75)}
LANE_X = (0.2, 0.8)
LANE_Y = (0.2, 0.75)
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
# The model reads phone photos about twice as far as they are. Multiply by this to get real meters.
# Indoor is fit to 12 venue photos with estimated distances (tune.py); refit with measured ones.
# Outdoor is untested, so it stays uncorrected until we have outdoor photos.
DEPTH_SCALE = {"indoor": 0.5, "outdoor": 1.0}
# At or under this, say "very close" instead of a number.
VERY_CLOSE_M = 0.5
# Friendlier names for DETR's COCO labels.
LABEL_NAMES = {"dining table": "table"}

DETECT_MODEL = "facebook/detr-resnet-50"
# Only trust detections at least this confident.
DETECT_THRESHOLD = 0.7
# A detection must have at least this much of its own area inside the obstacle box to name it.
DETECT_MIN_OVERLAP = 0.3

# Load once at import so each request doesn't reload the model. Outdoor loads on first use.
_depth_pipes = {"indoor": hf_pipeline("depth-estimation", model=DEPTH_MODELS["indoor"])}
_detector = hf_pipeline("object-detection", model=DETECT_MODEL)


def depth_map(image: Image.Image, mode: str) -> np.ndarray:
    """Depth in meters as a 2D array. Uses predicted_depth (meters), not depth (a picture for viewing)."""
    if mode not in _depth_pipes:
        _depth_pipes[mode] = hf_pipeline("depth-estimation", model=DEPTH_MODELS[mode])
    out = _depth_pipes[mode](image)
    return out["predicted_depth"].squeeze().cpu().numpy() * DEPTH_SCALE[mode]


def _rows(depth: np.ndarray, span: tuple[float, float]) -> slice:
    h = depth.shape[0]
    return slice(int(span[0] * h), int(span[1] * h))


def _cols(depth: np.ndarray, span: tuple[float, float]) -> slice:
    w = depth.shape[1]
    return slice(int(span[0] * w), int(span[1] * w))


def find_obstacle(depth: np.ndarray, mode: str) -> dict | None:
    """Closest lane region within the warning distance, or None if the path is clear."""
    best = None
    cells = {}  # (direction, height) -> distance
    for direction, xs in COLUMNS.items():
        for height, ys in BANDS.items():
            d = float(np.percentile(depth[_rows(depth, ys), _cols(depth, xs)], PERCENTILE))
            cells[direction, height] = d
            if best is None or d < best["distance"]:
                best = {"distance": d, "direction": direction, "height": height}
    if best["distance"] > WARN_DISTANCE_M[mode]:
        return None
    if cells[best["direction"], "waist"] - best["distance"] <= BAND_MARGIN_M:
        best["height"] = "waist"
    # Compare with straight ahead at the same height, so the floor in the foot band doesn't
    # drown out a chair on the left at waist height.
    if cells["ahead", best["height"]] - best["distance"] <= SIDE_MARGIN_M:
        best["direction"] = "ahead"
    best["box"] = _box(depth, best["distance"])
    return best


def _box(depth: np.ndarray, distance: float) -> list[float] | None:
    """Bounding box of lane pixels within BOX_MARGIN_M of the obstacle, as x, y, width, height fractions."""
    h, w = depth.shape
    ys, xs = _rows(depth, LANE_Y), _cols(depth, LANE_X)
    rows, cols = np.nonzero(depth[ys, xs] <= distance + BOX_MARGIN_M)
    if rows.size == 0:
        return None
    x0, x1 = (cols.min() + xs.start) / w, (cols.max() + 1 + xs.start) / w
    y0, y1 = (rows.min() + ys.start) / h, (rows.max() + 1 + ys.start) / h
    return [round(float(v), 3) for v in (x0, y0, x1 - x0, y1 - y0)]


def label_for(image: Image.Image, box: list[float] | None) -> str | None:
    """Name of the detected object that overlaps the obstacle box the most, or None."""
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
        if own > 0 and inter / own >= DETECT_MIN_OVERLAP and inter > best_area:
            best_label, best_area = det["label"], inter
    return LABEL_NAMES.get(best_label, best_label)


def round_half(meters: float) -> float:
    return max(0.5, round(meters * 2) / 2)


def describe(image: Image.Image, mode: str) -> dict:
    hit = find_obstacle(depth_map(image, mode), mode)
    if hit is None:
        return {
            "clear": True,
            "sentence": to_sentence(None, None, None, None),
            "label": None,
            "distance_m": None,
            "direction": None,
            "height": None,
            "box": None,
        }
    # Detection only runs when there's something to name, so a clear path stays fast.
    label, distance_m = label_for(image, hit["box"]), round_half(hit["distance"])
    return {
        "clear": False,
        "sentence": to_sentence(label, distance_m, hit["direction"], hit["height"]),
        "label": label,
        "distance_m": distance_m,
        "direction": hit["direction"],
        "height": hit["height"],
        "box": hit["box"],
    }


def sonar(image: Image.Image, mode: str) -> dict:
    hit = find_obstacle(depth_map(image, mode), mode)
    if hit is None:
        return {"clear": True, "distance_m": None, "direction": None}
    # Finer than half meters so the beep rate changes smoothly as you walk.
    return {"clear": False, "distance_m": round(hit["distance"], 1), "direction": hit["direction"]}


def to_sentence(label: str | None, distance_m: float | None, direction: str | None, height: str | None) -> str:
    if distance_m is None:
        return "Path clear"
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
        return f"{label.capitalize()}, {how_far}{where}"
    return f"Obstacle at {height} height, {how_far}{where}"
