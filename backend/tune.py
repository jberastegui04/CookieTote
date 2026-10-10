"""Run every photo in a folder through describe() and compare with expected.csv in that folder.

Usage: python tune.py C:\\path\\to\\tuning [indoor|outdoor]

expected.csv columns: file,clear,label,distance_m,direction,height,notes (blank means "don't check").
Prints one row per photo with mismatches marked, each lane cell's reading, and a score at the end.
"""
import csv
import sys
import time
from pathlib import Path

import numpy as np
from PIL import Image, ImageOps

import pipeline

DISTANCE_TOLERANCE_M = 0.5


def load(folder: Path) -> list[tuple[dict, Image.Image]]:
    cases = []
    for row in csv.DictReader(open(folder / "expected.csv", newline="")):
        image = ImageOps.exif_transpose(Image.open(folder / row["file"])).convert("RGB")
        image.thumbnail((1024, 1024))  # roughly what the app sends
        cases.append((row, image))
    return cases


def cells(depth: np.ndarray, mode: str) -> str:
    out = []
    for height, ys in pipeline.bands_for(mode).items():
        vals = [np.percentile(depth[pipeline._rows(depth, ys), pipeline._cols(depth, xs)], pipeline.PERCENTILE) for xs in pipeline.COLUMNS.values()]
        out.append(f"{height[0]}:" + "/".join(f"{v:.1f}" for v in vals))
    return "  ".join(out)


def score(row: dict, got: dict) -> tuple[int, list[str]]:
    """Number of checks and the names of the ones that failed."""
    misses, checks = [], 1
    want_clear = row["clear"].strip().lower() == "true"
    if got["clear"] != want_clear:
        misses.append("clear")
    if not want_clear and not got["clear"]:
        if row["distance_m"]:
            checks += 1
            if abs(got["distance_m"] - float(row["distance_m"])) > DISTANCE_TOLERANCE_M:
                misses.append("distance")
        for field in ("direction", "height", "label"):
            if row[field]:
                checks += 1
                if got[field] != row[field]:
                    misses.append(field)
        if not row["label"] and got["label"] == "person" and "reflection" in row["notes"]:
            checks += 1
            misses.append("label")  # named a reflection as a person
    return checks, misses


def run(cases, mode: str = "indoor", verbose: bool = True) -> tuple[int, int]:
    passed = total = 0
    for row, image in cases:
        start = time.perf_counter()
        got = pipeline.describe(image, mode)
        ms = (time.perf_counter() - start) * 1000
        checks, misses = score(row, got)
        total += checks
        passed += checks - len(misses)
        if verbose:
            print(f"{'MISS' if misses else 'ok  '} {row['file']:<26} {ms:5.0f} ms  got: {got['sentence']!r}")
            if misses:
                want = "clear" if row["clear"].lower() == "true" else f"{row['label'] or '-'} {row['distance_m']} m {row['direction']} {row['height']}"
                print(f"       wrong: {', '.join(misses)} | wanted: {want} | {row['notes']}")
                print(f"       cells (head/waist/foot as left/ahead/right, m): {cells(pipeline.depth_map(image, mode), mode)}")
    if verbose:
        print(f"\n{passed}/{total} checks passed")
    return passed, total


if __name__ == "__main__":
    run(load(Path(sys.argv[1])), sys.argv[2] if len(sys.argv) > 2 else "indoor")
