"""Obstacle pipeline (Michael). Replace the stub in analyze_image with the real models."""
from dataclasses import dataclass

from PIL import Image

# Thresholds per mode: warn earlier outdoors since people walk faster.
WARN_DISTANCE_M = {"indoor": 2.0, "outdoor": 4.0}


@dataclass
class Obstacle:
    distance_m: float | None  # None = nothing in the walking lane
    direction: str | None     # "left" | "center" | "right"
    height_band: str | None   # "foot" | "waist" | "head"
    label: str | None         # from the object detector, if it recognized it


def analyze_image(image: Image.Image, mode: str) -> Obstacle:
    # TODO (Michael):
    # 1. Depth Anything V2 metric model (indoor or outdoor variant per mode) -> depth map in meters
    # 2. Take a lane down the middle of the frame, split into foot / waist / head bands
    # 3. Find the closest point under WARN_DISTANCE_M[mode], its band and left/center/right
    # 4. Run an object detector on that region to get a label if possible
    # Stub so the app and audio work end to end tonight:
    return Obstacle(distance_m=1.5, direction="left", height_band="head", label="cabinet door")


def to_sentence(o: Obstacle) -> str:
    if o.distance_m is None:
        return "Path clear"
    what = o.label or "Obstacle"
    where = {"left": "slightly left", "right": "slightly right"}.get(o.direction or "", "straight ahead")
    meters = round(o.distance_m * 2) / 2  # round to half meters
    return f"{what.capitalize()} at {o.height_band} height, {meters:g} meters, {where}"
