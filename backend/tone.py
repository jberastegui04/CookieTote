"""Stereo warning tone: panned toward the obstacle, higher pitch when closer."""
import io
import wave

import numpy as np

SAMPLE_RATE = 22050


def make_tone(direction: str | None, distance_m: float | None, duration_s: float = 0.35) -> bytes:
    """Return WAV bytes. direction: left/center/right. Closer = higher pitch."""
    d = 2.0 if distance_m is None else max(0.3, min(distance_m, 4.0))
    freq = 1200 - (d - 0.3) / (4.0 - 0.3) * 800  # 1200 Hz close, 400 Hz far

    t = np.linspace(0, duration_s, int(SAMPLE_RATE * duration_s), endpoint=False)
    wave_mono = np.sin(2 * np.pi * freq * t)
    fade = np.minimum(1, np.minimum(t, duration_s - t) / 0.02)  # avoid clicks
    wave_mono *= fade * 0.6

    pan = {"left": -1.0, "right": 1.0}.get(direction or "center", 0.0)
    left = wave_mono * np.sqrt((1 - pan) / 2)
    right = wave_mono * np.sqrt((1 + pan) / 2)
    stereo = (np.stack([left, right], axis=1) * 32767).astype(np.int16)

    buf = io.BytesIO()
    with wave.open(buf, "wb") as w:
        w.setnchannels(2)
        w.setsampwidth(2)
        w.setframerate(SAMPLE_RATE)
        w.writeframes(stereo.tobytes())
    return buf.getvalue()
