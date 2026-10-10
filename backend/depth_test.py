"""Scratch test for the depth model and describe(). Usage: python depth_test.py photo.jpg [indoor|outdoor]"""
import sys
import time

from PIL import Image

start = time.perf_counter()
import pipeline  # loads the indoor model (first run downloads it)

print(f"model load: {time.perf_counter() - start:.1f} s")

image = Image.open(sys.argv[1]).convert("RGB")
mode = sys.argv[2] if len(sys.argv) > 2 else "indoor"

depth = pipeline.depth_map(image, mode)
print(f"photo {image.size[0]}x{image.size[1]}, depth shape {depth.shape}, min {depth.min():.2f} m, max {depth.max():.2f} m")

for _ in range(3):
    start = time.perf_counter()
    result = pipeline.describe(image, mode)
    print(f"describe: {time.perf_counter() - start:.2f} s -> {result}")
