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
# Top to bottom, no overlap. Below 75% is ignored because the floor fills the bottom
# of the frame at about 1 m when the phone is held forward (tune this).
BANDS = {"head": (0.0, 1 / 3), "waist": (1 / 3, 0.5), "foot": (0.5, 0.75)}
LANE_X = (0.2, 0.8)
LANE_Y = (0.0, 0.75)
# Low percentile instead of the minimum so a few noisy pixels can't trigger a warning.
PERCENTILE = 5
# Lane pixels this close to the obstacle distance count as part of it for the box.
BOX_MARGIN_M = 0.3
# The model reads phone photos too far away. Multiply by this to get real meters.
# 1.0 until we calibrate against photos taken at measured distances.
DEPTH_SCALE = {"indoor": 1.0, "outdoor": 1.0}

# Load once at import so each request doesn't reload the model. Outdoor loads on first use.
_depth_pipes = {"indoor": hf_pipeline("depth-estimation", model=DEPTH_MODELS["indoor"])}


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
    for direction, xs in COLUMNS.items():
        for height, ys in BANDS.items():
            d = float(np.percentile(depth[_rows(depth, ys), _cols(depth, xs)], PERCENTILE))
            if best is None or d < best["distance"]:
                best = {"distance": d, "direction": direction, "height": height}
    if best["distance"] > WARN_DISTANCE_M[mode]:
        return None
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


def round_half(meters: float) -> float:
    return max(0.5, round(meters * 2) / 2)


def describe(image: Image.Image, mode: str) -> dict:
    # TODO (Michael): run facebook/detr-resnet-50 on the box to get a label.
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
    label, distance_m = None, round_half(hit["distance"])
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
    if label:
        return f"{label.capitalize()}, about {meters:g} {unit}{where}"
    return f"Obstacle at {height} height, {meters:g} {unit}{where}"
