"""Scratch test for the depth model and describe().

Usage: python depth_test.py photo.jpg [indoor|outdoor]
Prints depth stats, each lane cell's reading, and describe() timing, and saves photo_depth.png
(near is bright, far is dark) with the lane, bands, and floor cutoff drawn on it.
"""
import sys
import time
from pathlib import Path

import numpy as np
from PIL import Image, ImageDraw, ImageOps

start = time.perf_counter()
import pipeline  # loads the indoor model (first run downloads it)

print(f"model load: {time.perf_counter() - start:.1f} s")

path = Path(sys.argv[1])
mode = sys.argv[2] if len(sys.argv) > 2 else "indoor"
image = ImageOps.exif_transpose(Image.open(path)).convert("RGB")  # same as main.py

depth = pipeline.depth_map(image, mode)
print(f"photo {image.size[0]}x{image.size[1]}, depth shape {depth.shape}, min {depth.min():.2f} m, max {depth.max():.2f} m")

print(f"{pipeline.PERCENTILE}th percentile per cell (m), warn under {pipeline.WARN_DISTANCE_M[mode]} m:")
for height, ys in pipeline.BANDS.items():
    cells = [np.percentile(depth[pipeline._rows(depth, ys), pipeline._cols(depth, xs)], pipeline.PERCENTILE) for xs in pipeline.COLUMNS.values()]
    print(f"  {height:<6}" + "".join(f"{name}={d:5.2f}  " for name, d in zip(pipeline.COLUMNS, cells)))

# Near is bright. Clip at 2x the warning distance so the range that matters gets the contrast.
far = 2 * pipeline.WARN_DISTANCE_M[mode]
gray = (255 * (1 - np.clip(depth, 0, far) / far)).astype(np.uint8)
vis = Image.fromarray(gray).convert("RGB")
draw = ImageDraw.Draw(vis)
w, h = vis.size
for x in (0.2, 0.4, 0.6, 0.8):
    draw.line([(x * w, 0), (x * w, pipeline.LANE_Y[1] * h)], fill=(255, 214, 10), width=2)
for _, (top, bottom) in pipeline.BANDS.items():
    draw.line([(0.2 * w, top * h), (0.8 * w, top * h)], fill=(255, 214, 10), width=2)
draw.line([(0, pipeline.LANE_Y[1] * h), (w, pipeline.LANE_Y[1] * h)], fill=(255, 60, 60), width=3)  # floor cutoff
out_path = path.with_name(path.stem + "_depth.png")
vis.save(out_path)
print(f"saved {out_path}")

for _ in range(3):
    start = time.perf_counter()
    result = pipeline.describe(image, mode)
    print(f"describe: {time.perf_counter() - start:.2f} s -> {result}")
