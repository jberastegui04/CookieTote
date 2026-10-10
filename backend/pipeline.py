"""Obstacle pipeline (Michael). Replace the fake answers in describe() and sonar() with the real models.

Both functions take a PIL image and a mode ("indoor" or "outdoor") and return a dict.
main.py adds audio_b64 to the describe() result, so don't add it here.
"""
from PIL import Image

# Warn further out outdoors since people walk faster.
WARN_DISTANCE_M = {"indoor": 2.0, "outdoor": 4.0}


def describe(image: Image.Image, mode: str) -> dict:
    # TODO (Michael):
    # 1. Depth Anything V2 metric model (indoor or outdoor variant per mode) -> depth map in meters
    # 2. Take a lane down the middle of the frame, split into foot / waist / head bands
    # 3. Find the closest point under WARN_DISTANCE_M[mode], its band and left / ahead / right
    # 4. Run facebook/detr-resnet-50 on that region to get a label if possible
    # Fake answer so the app and audio work end to end tonight:
    label, distance_m, direction, height = "cabinet door", 1.5, "left", "head"
    return {
        "clear": False,
        "sentence": to_sentence(label, distance_m, direction, height),
        "label": label,
        "distance_m": distance_m,
        "direction": direction,
        "height": height,
        "box": [0.1, 0.1, 0.35, 0.5],  # x, y, width, height, each 0 to 1 of the image
    }


def sonar(image: Image.Image, mode: str) -> dict:
    # TODO (Michael): depth only, no detection. Same lane logic as describe(), keep it fast.
    return {"clear": False, "distance_m": 1.5, "direction": "left"}


def to_sentence(label: str | None, distance_m: float | None, direction: str | None, height: str | None) -> str:
    if distance_m is None:
        return "Path clear"
    meters = round(distance_m * 2) / 2  # round to half meters
    unit = "meter" if meters == 1 else "meters"
    where = {"left": "slightly left", "right": "slightly right"}.get(direction or "", "ahead")
    if label:
        return f"{label.capitalize()}, about {meters:g} {unit}, {where}"
    return f"Obstacle at {height} height, {meters:g} {unit} {where}"
