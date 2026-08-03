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

import math

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


# ── TEMPO ───────────────────────────────────────────────────────────────────
# The previous estimator returned 148 for a 74 BPM take: it locked onto the
# eighth notes, which is the classic metrical octave error. Autocorrelation
# alone cannot resolve it — a signal that repeats every half beat also repeats
# every beat, so both lags peak. What resolves it is accent: on a real take the
# syllables that land on the beat are louder than the ones between. That is
# what the fold below measures.

ONSET_HOP = 512


def onset_envelope(x, sr, hop=ONSET_HOP):
    """
    Half-wave-rectified frame-to-frame RMS rise.

    Shared with the beat aligner rather than reimplemented there, so the vocal
    and the beat are always measured on the same clock. Cross-correlating two
    envelopes built with different hops lines up to the wrong place silently.
    """
    n = len(x) // hop
    if n < 16:
        return None, sr / float(hop)
    frames = x[:n * hop].reshape(n, hop)
    env = np.sqrt((frames ** 2).mean(axis=1))
    env = np.maximum(0.0, np.diff(env, prepend=env[0]))
    if env.any():
        env = env - env.mean()
    return env, sr / float(hop)


def _autocorr(env):
    ac = np.correlate(env, env, "full")[len(env) - 1:]
    return ac / ac[0] if ac[0] > 0 else ac


def _smear_score(ac):
    """
    A period of 32.3 frames splits its autocorrelation peak across bins 32 and
    33, while its own third multiple at 96.9 lands almost exactly on a bin and
    therefore looks stronger — which is how a 160 BPM take gets read as 53.
    Summing a window that grows with the lag puts the split energy back
    together; dividing by the square root of the window stops the wider
    windows at long lags from winning on width alone.
    """
    out = np.zeros(len(ac))
    for j in range(2, len(ac)):
        w = max(1, int(round(0.02 * j)))
        a, b = max(0, j - w), min(len(ac), j + w + 1)
        out[j] = ac[a:b].sum() / math.sqrt(b - a)
    return out


def _comb(e, axis, lag, start=0.0, kmax=48):
    """Mean envelope height on a beat grid of period `lag` starting at `start`."""
    k = min(kmax, int((len(e) - 1 - start) / lag)) if lag > 0 else 0
    if k < 2:
        return -1.0
    return float(np.interp(start + lag * np.arange(k + 1), axis, e).mean())


def _refine(env, lag):
    """
    Bin resolution is only good to about 2%, and a 2% error walks the grid a
    full beat out of phase across twenty seconds — which then makes the octave
    test below read noise instead of accent. Search fractional lags nearby.
    """
    e = env - env.min()
    axis = np.arange(len(e))
    span, step = max(1.5, 0.06 * lag), 0.02
    best, best_lag = -1e9, float(lag)
    for L in np.arange(max(2.0, lag - span), lag + span + 1e-9, step):
        # Score across several start phases so this measures the period rather
        # than whether frame zero happens to land on a beat.
        s = max(_comb(e, axis, L, p) for p in (0.0, L / 3.0, 2.0 * L / 3.0))
        if s > best:
            best, best_lag = s, float(L)
    return best_lag


def _off_beat_ratio(env, lag):
    """
    How loud the midpoints of `lag` are compared with its beats.

    Near 1 means both levels are accented equally and `lag` is not obviously
    the beat. Well below 1 means the faster level is a weak subdivision and
    `lag` is the real beat — which is the case this whole section exists for.
    """
    if lag < 2 or lag * 3 >= len(env):
        return None
    e = env - env.min()
    axis = np.arange(len(e))
    phases = (0.0, lag / 4.0, lag / 2.0, 3.0 * lag / 4.0)
    ph = max(phases, key=lambda p: _comb(e, axis, lag, p))
    on = _comb(e, axis, lag, ph)
    off = _comb(e, axis, lag, ph + lag / 2.0)
    return (off / on) if on > 0 else None


def tempo_candidates(x, sr, lo_bpm=50.0, hi_bpm=200.0, alternation=0.8):
    """
    Best first. The leading entry is the pipeline's answer; the rest are its
    metrical octaves, returned so the person can override a detection that
    heard eighth notes as beats without having to guess what else to try.
    """
    env, fps = onset_envelope(x, sr)
    if env is None or not env.any():
        return []
    ac = _autocorr(env)
    sc = _smear_score(ac)
    lo = max(2, int(fps * 60.0 / hi_bpm))
    hi = min(len(sc) - 1, int(fps * 60.0 / lo_bpm))
    if hi <= lo:
        return []

    lag = _refine(env, float(lo + int(np.argmax(sc[lo:hi]))))
    trail = []
    for _ in range(3):
        dbl = lag * 2.0
        if 60.0 * fps / dbl < lo_bpm or int(round(dbl)) >= len(sc):
            break
        r = _off_beat_ratio(env, dbl)
        if r is None or r >= alternation:
            break
        if sc[int(round(dbl))] < 0.35 * sc[int(round(lag))]:
            break
        trail.append(round(60.0 * fps / lag, 1))
        lag = _refine(env, dbl)

    out, seen = [], set()
    for rel, L in (("detected", lag), ("double", lag / 2.0), ("half", lag * 2.0)):
        bpm = round(60.0 * fps / L, 1)
        if not (lo_bpm <= bpm <= hi_bpm) or bpm in seen:
            continue
        seen.add(bpm)
        j = int(round(L))
        out.append({"bpm": bpm, "relation": rel,
                    "score": round(float(sc[j]) if j < len(sc) else 0.0, 4)})
    if trail:
        out[0]["folded_from"] = trail
    return out


def fold_tempo_to(bpm, target, max_octaves=3):
    """
    Move a tempo into the same metrical octave as `target` by halving or
    doubling.

    Used on the generated beat. Asking for 148 and getting 166 is one kind of
    disagreement; 166 measured against a 74 BPM vocal is that same
    disagreement plus an octave. Folding first turns a 124% time-stretch into
    a 12% one, and 12% is inaudible where 124% turns drums into wet cardboard.
    """
    if not bpm or not target or bpm <= 0 or target <= 0:
        return bpm
    best = float(bpm)
    for e in range(-max_octaves, max_octaves + 1):
        c = float(bpm) * (2.0 ** e)
        if abs(math.log2(c / target)) < abs(math.log2(best / target)):
            best = c
    return best


def estimate_tempo(x, sr):
    c = tempo_candidates(x, sr)
    return c[0]["bpm"] if c else None


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
    cands = tempo_candidates(x, sr)
    return {
        "key": key,
        "tempo": cands[0]["bpm"] if cands else None,
        # Offered, not hidden. Tempo off a solo vocal is the least certain
        # number this stage produces, and the alternatives are almost always
        # the exact halves and doubles — cheap to show, expensive to guess.
        "tempo_candidates": cands,
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
