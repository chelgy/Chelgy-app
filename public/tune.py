"""
SONG STUDIO — melody stage.

Takes a rough guide take and returns a tuned one, plus the musical facts the
rest of the pipeline needs (key, tempo, note range).

This runs BEFORE the voice model. RVC's inference pipeline in the current repo
exposes only (x, p_len, f0_up_key, f0_method) — the old f0_file hook for
injecting an external pitch curve is gone — so a corrected melody cannot be
handed to it directly. Correcting the audio first and letting RVC read pitch
off already-tuned audio gets the same result with stock RVC and nothing to fork.
"""

import numpy as np
import pyworld as pw
import soundfile as sf

# Krumhansl-Kessler key profiles. Rating every note equally would let one long
# held note decide the key; these weight scale degrees the way listeners
# actually weight them, so a tonic that is sung briefly still wins over a
# passing tone that is sung forever.
KK_MAJOR = np.array([6.35,2.23,3.48,2.33,4.38,4.09,2.52,5.19,2.39,3.66,2.29,2.88])
KK_MINOR = np.array([6.33,2.68,3.52,5.38,2.60,3.53,2.54,4.75,3.98,2.69,3.34,3.17])
NAMES = ["C","C#","D","D#","E","F","F#","G","G#","A","A#","B"]
MAJOR_SET = [0,2,4,5,7,9,11]
MINOR_SET = [0,2,3,5,7,8,10]


def hz_to_midi(f):
    out = np.full(len(f), np.nan)
    v = f > 0
    out[v] = 69 + 12 * np.log2(f[v] / 440.0)
    return out


def midi_to_hz(m):
    return 440.0 * (2.0 ** ((m - 69) / 12.0))


def analyse(path):
    x, sr = sf.read(path, always_2d=False)
    if x.ndim > 1:
        x = x.mean(axis=1)
    x = np.ascontiguousarray(x.astype(np.float64))
    # Harvest over DIO: slower, but markedly more robust on untrained singing,
    # which is full of the creak and breathiness that trips cheaper trackers.
    f0, t = pw.harvest(x, sr, f0_floor=65.0, f0_ceil=1000.0, frame_period=5.0)
    f0 = pw.stonemask(x, f0, t, sr)
    sp = pw.cheaptrick(x, f0, t, sr)
    ap = pw.d4c(x, f0, t, sr)
    return x, sr, f0, t, sp, ap


def detect_key(f0):
    """Weight each pitch class by how long it was actually sung."""
    m = hz_to_midi(f0)
    voiced = ~np.isnan(m)
    if voiced.sum() < 20:
        return None
    pc = np.zeros(12)
    np.add.at(pc, (np.round(m[voiced]).astype(int) % 12), 1.0)
    pc /= pc.sum()

    best = None
    for tonic in range(12):
        rolled = np.roll(pc, -tonic)
        for mode, prof in (("major", KK_MAJOR), ("minor", KK_MINOR)):
            r = float(np.corrcoef(rolled, prof)[0, 1])
            if best is None or r > best[2]:
                best = (tonic, mode, r)
    tonic, mode, r = best
    return {
        "tonic": tonic,
        "name": NAMES[tonic],
        "mode": mode,
        "confidence": round(r, 3),
        "scale": [(tonic + i) % 12 for i in (MAJOR_SET if mode == "major" else MINOR_SET)],
    }


def segment_notes(m, min_frames=6, max_jump=1.2):
    """
    Split the pitch line into held notes, breaking wherever it moves more than
    a semitone or so between frames.

    This exists because snapping frame by frame destroys the two things that
    make singing sound human: the slide into a note, and the vibrato once
    you're on it. Correcting per note instead of per frame keeps both.
    """
    segs, start = [], None
    for i in range(len(m)):
        voiced = not np.isnan(m[i])
        if voiced and start is None:
            start = i
        elif start is not None:
            broke = (not voiced) or (i > start and abs(m[i] - m[i - 1]) > max_jump)
            if broke:
                if i - start >= min_frames:
                    segs.append((start, i))
                start = i if voiced else None
    if start is not None and len(m) - start >= min_frames:
        segs.append((start, len(m)))
    return segs


def correct(f0, key, strength=0.85, preserve_vibrato=True):
    """
    Pull each held note onto the nearest note of the detected key.

    strength is deliberately not 1.0 by default. Snapping fully is the sound
    people describe as robotic — it is a stylistic choice, not a correctness
    one, and at 0.85 a listener hears "in tune" rather than "processed".
    """
    m = hz_to_midi(f0)
    out = m.copy()
    notes = []

    for a, b in segment_notes(m):
        seg = m[a:b]
        if np.isnan(seg).all():
            continue
        # Median, not mean: one frame of octave error from the tracker would
        # drag a mean far enough to snap the whole note to the wrong pitch.
        centre = float(np.nanmedian(seg))
        pc = int(round(centre)) % 12
        octave = int(round(centre)) - pc

        # Nearest pitch class in key, checked across the octave boundary so a
        # B in C major snaps up to C rather than down a seventh.
        cands = []
        for s in key["scale"]:
            for off in (-12, 0, 12):
                cands.append(octave + s + off)
        target = min(cands, key=lambda c: abs(c - centre))

        shift = target - centre
        if preserve_vibrato:
            # Move the whole note by one constant amount. Vibrato and any drift
            # inside the note ride along untouched.
            out[a:b] = seg + shift * strength
        else:
            out[a:b] = target

        notes.append({
            "start": round(a * 0.005, 3),
            "end": round(b * 0.005, 3),
            "sang_hz": round(float(midi_to_hz(centre)), 1),
            "target": NAMES[target % 12] + str(target // 12 - 1),
            "cents_moved": round(shift * 100),
        })

    corrected = np.zeros_like(f0)
    v = ~np.isnan(out)
    corrected[v] = midi_to_hz(out[v])
    return corrected, notes


def estimate_tempo(x, sr):
    """
    Onset strength autocorrelation. Coarse by design — this is a starting
    suggestion for the beat, and the person can override it. Guessing precisely
    wrong is worse than offering a round number they can correct.
    """
    hop = 512
    n = len(x) // hop
    if n < 40:
        return None
    frames = x[:n * hop].reshape(n, hop)
    env = np.sqrt((frames ** 2).mean(axis=1))
    env = np.maximum(0, np.diff(env, prepend=env[0]))
    env -= env.mean()
    if not env.any():
        return None
    ac = np.correlate(env, env, "full")[len(env) - 1:]
    fps = sr / hop
    lo, hi = int(fps * 60 / 180), int(fps * 60 / 60)   # 60–180 BPM
    hi = min(hi, len(ac) - 1)
    if hi <= lo:
        return None
    lag = lo + int(np.argmax(ac[lo:hi]))
    return round(60.0 * fps / lag, 1)


def tune_file(in_path, out_path, strength=0.85):
    x, sr, f0, t, sp, ap = analyse(in_path)
    key = detect_key(f0)
    if key is None:
        raise ValueError("No pitch found — is there singing in this file?")

    corrected, notes = correct(f0, key, strength=strength)
    y = pw.synthesize(corrected, sp, ap, sr, frame_period=5.0)

    # WORLD resynthesis can overshoot the original peak. Rescaling to match the
    # input keeps this stage gain-neutral, so nothing downstream has to know
    # whether the audio has been tuned.
    peak_in, peak_out = np.abs(x).max(), np.abs(y).max()
    if peak_out > 0:
        y *= (peak_in / peak_out)
    sf.write(out_path, y.astype(np.float32), sr)

    voiced = f0 > 0
    moved = [abs(n["cents_moved"]) for n in notes]
    return {
        "key": key,
        "tempo": estimate_tempo(x, sr),
        "notes": len(notes),
        "median_correction_cents": int(np.median(moved)) if moved else 0,
        "max_correction_cents": int(max(moved)) if moved else 0,
        "range": {
            "low": round(float(np.percentile(f0[voiced], 2)), 1),
            "high": round(float(np.percentile(f0[voiced], 98)), 1),
        } if voiced.any() else None,
        "voiced_seconds": round(float(voiced.sum() * 0.005), 1),
        "note_detail": notes,
    }


if __name__ == "__main__":
    import sys, json
    src, dst = sys.argv[1], sys.argv[2]
    s = float(sys.argv[3]) if len(sys.argv) > 3 else 0.85
    r = tune_file(src, dst, s)
    r.pop("note_detail")
    print(json.dumps(r, indent=2))
