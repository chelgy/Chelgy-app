#!/usr/bin/env python3
"""
SONG STUDIO — beat alignment.

A generated beat does not obey the tempo or key it was asked for. Today's
render asked for 148 BPM in G# and got roughly 166 in something else. The fix
is not to prompt harder — prompt-based generation gives you a vibe, not a spec
— it is to measure what actually came back and correct it:

    measure the beat  →  fold its tempo into the vocal's metrical octave
                      →  time-stretch onto the vocal's exact tempo
                      →  slide it so its grid lands on the vocal's
                      →  pitch-shift into key, but only if the key is known

Every one of those steps is deterministic, which is what turns "hopefully it
matches" into "it matches, because we made it".

The folding step is what makes this safe. 166 against 74 is a 124% stretch and
would turn drums into wet cardboard; 166 folded to 83 is a 12% stretch and is
inaudible. Folding to the *nearest* octave — rather than to a fixed threshold —
caps the worst case at 41% and in practice keeps it under 15%.

One consequence worth knowing: because the beat is folded onto whatever tempo
the vocal is measured at, an octave error in the *vocal's* tempo no longer
breaks the render. The beat still locks to the vocal; it just feels
double-time. Wrong feel, not wrong time.

Runs standalone, which is the point — you can check alignment without paying
for a full render:

    python3 align.py beat.mp3 vocal.wav aligned.wav
    python3 align.py beat.mp3 vocal.wav aligned.wav --vocal-tempo 74
"""

import os
import sys
import json
import math
import shutil
import argparse
import subprocess
import tempfile

import numpy as np
import soundfile as sf

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

from tune import (  # noqa: E402
    ONSET_HOP, NAMES, KK_MAJOR, KK_MINOR,
    onset_envelope, estimate_tempo, fold_tempo_to,
)

# Everything is measured at one sample rate. The vocal arrives at 48k from RVC
# and the beat at 44.1k from the music engine; envelopes built at different
# rates have different frames-per-second and cross-correlate to a confidently
# wrong offset.
ANALYSIS_SR = 44100


def _sh(*cmd):
    r = subprocess.run(cmd, capture_output=True, text=True)
    if r.returncode:
        raise RuntimeError(" ".join(cmd[:4]) + " failed:\n" + (r.stderr or "")[-700:])
    return r


def _have(binary):
    return shutil.which(binary) is not None


def _decode(src, dst, channels=2, sr=ANALYSIS_SR):
    _sh("ffmpeg", "-y", "-v", "error", "-i", src,
        "-ac", str(channels), "-ar", str(sr), "-c:a", "pcm_s16le", dst)
    return dst


def _mono(path):
    x, sr = sf.read(path, always_2d=True)
    return np.ascontiguousarray(x.mean(axis=1).astype(np.float64)), sr


def _atempo_chain(speed):
    """ffmpeg's atempo is documented for 0.5–2.0, so chain it outside that."""
    parts, s = [], float(speed)
    while s > 2.0:
        parts.append("atempo=2.0")
        s /= 2.0
    while s < 0.5:
        parts.append("atempo=0.5")
        s *= 2.0
    parts.append("atempo=%.6f" % s)
    return ",".join(parts)


def time_stretch(src, dst, speed):
    """
    speed > 1 plays the beat faster and shorter. Pitch is preserved either way.

    rubberband handles transients better and is used when present. The atempo
    fallback is genuinely fine here rather than a compromise, because octave
    folding has already capped the ratio well inside atempo's comfortable range.
    """
    if abs(speed - 1.0) < 0.002:
        shutil.copy(src, dst)
        return "none"
    if _have("rubberband"):
        # rubberband's -t is output duration over input duration, so it is the
        # reciprocal of a speed factor.
        _sh("rubberband", "-q", "-t", "%.6f" % (1.0 / speed), src, dst)
        return "rubberband"
    _sh("ffmpeg", "-y", "-v", "error", "-i", src, "-af", _atempo_chain(speed), dst)
    return "atempo"


def pitch_shift(src, dst, semitones, sr=ANALYSIS_SR):
    if abs(semitones) < 0.01:
        shutil.copy(src, dst)
        return "none"
    if _have("rubberband"):
        _sh("rubberband", "-q", "-p", "%.4f" % semitones, src, dst)
        return "rubberband"
    # asetrate moves pitch and duration together; atempo puts the duration back.
    r = 2.0 ** (semitones / 12.0)
    _sh("ffmpeg", "-y", "-v", "error", "-i", src, "-af",
        "asetrate=%d,aresample=%d,%s" % (int(sr * r), sr, _atempo_chain(1.0 / r)), dst)
    return "asetrate"


def detect_beat_key(x, sr):
    """
    Key of a finished instrumental, from chroma.

    The tuner's key detection reads a single melodic line and cannot be reused
    here — a beat is polyphonic and pyworld would return one pitch for a whole
    chord. Returns None rather than a guess if librosa isn't installed, since
    a wrong pitch-shift is worse than none.
    """
    try:
        import librosa
    except Exception:
        return None
    y = np.asarray(x, dtype=np.float32)
    peak = float(np.abs(y).max()) if y.size else 0.0
    if peak <= 0:
        return None
    y = y / peak
    try:
        # Harmonic part only. Drums put energy in every chroma bin equally and
        # drown the chords that actually carry the key.
        y = librosa.effects.harmonic(y, margin=3.0)
        chroma = librosa.feature.chroma_cqt(y=y, sr=sr, bins_per_octave=36)
    except Exception:
        return None
    pc = np.asarray(chroma, dtype=np.float64).mean(axis=1)
    if not np.isfinite(pc).all() or pc.sum() <= 0:
        return None
    pc = pc / pc.sum()

    best = None
    for tonic in range(12):
        rolled = np.roll(pc, -tonic)
        for mode, prof in (("major", KK_MAJOR), ("minor", KK_MINOR)):
            r = float(np.corrcoef(rolled, prof)[0, 1])
            if not math.isfinite(r):
                continue
            if best is None or r > best[2]:
                best = (tonic, mode, r)
    if best is None:
        return None
    tonic, mode, r = best
    return {"tonic": tonic, "name": NAMES[tonic], "mode": mode, "confidence": round(r, 3)}


def best_offset(v_env, b_env, max_lag):
    """
    Frames the beat should be delayed by so its grid sits on the vocal's.

    Cross-correlating the two onset envelopes rather than hunting for a single
    downbeat, because a generated intro often has no downbeat to find and a
    guide take often starts with a breath. The search is capped at one bar —
    beyond that every answer is equivalent to one inside it.
    """
    n = min(len(v_env), len(b_env))
    if n < 32:
        return 0
    a = v_env[:n] - v_env[:n].mean()
    b = b_env[:n] - b_env[:n].mean()
    cc = np.correlate(a, b, "full")
    zero = n - 1
    lag = max(1, int(max_lag))
    lo, hi = max(0, zero - lag), min(len(cc), zero + lag + 1)
    return int(lo + int(np.argmax(cc[lo:hi])) - zero)


def _shift_and_fit(path, out_path, delay_samples, target_samples):
    """Delay or trim, then make the beat exactly as long as the vocal."""
    y, sr = sf.read(path, always_2d=True)
    if delay_samples > 0:
        y = np.vstack([np.zeros((delay_samples, y.shape[1]), dtype=y.dtype), y])
    elif delay_samples < 0:
        y = y[min(-delay_samples, len(y)):]
    pad = 0
    if len(y) < target_samples:
        pad = target_samples - len(y)
        y = np.vstack([y, np.zeros((pad, y.shape[1]), dtype=y.dtype)])
    else:
        y = y[:target_samples]
    sf.write(out_path, y, sr)
    return len(y) / float(sr), pad / float(sr)


def align_beat(beat_path, vocal_path, out_path,
               vocal_tempo=None, vocal_key=None, key_confidence=0.0,
               min_key_confidence=0.5, max_semitones=4.0,
               do_stretch=True, do_shift=True, log=print):
    """
    Returns everything it measured. Nothing here is inferred or assumed — if a
    step is skipped the reason is in the returned dict.
    """
    work = tempfile.mkdtemp(prefix="align-")

    def w(n):
        return os.path.join(work, n)

    info = {"stretched": False, "shifted": False, "slid": False}

    beat_st = _decode(beat_path, w("beat.wav"), channels=2)
    beat_mono, _ = _mono(_decode(beat_path, w("beat-m.wav"), channels=1))
    voc_mono, _ = _mono(_decode(vocal_path, w("voc-m.wav"), channels=1))
    voc_seconds = len(voc_mono) / float(ANALYSIS_SR)

    # ── tempo ───────────────────────────────────────────────────────────────
    if vocal_tempo is None:
        vocal_tempo = estimate_tempo(voc_mono, ANALYSIS_SR)
    beat_raw = estimate_tempo(beat_mono, ANALYSIS_SR)
    info["vocal_tempo"] = vocal_tempo
    info["beat_tempo_measured"] = beat_raw

    current = beat_st
    if do_stretch and vocal_tempo and beat_raw:
        folded = fold_tempo_to(beat_raw, vocal_tempo)
        speed = float(vocal_tempo) / folded
        info["beat_tempo_folded"] = round(folded, 1)
        info["stretch"] = round(speed, 4)
        log("  beat measured %.1f BPM, folded to %.1f, vocal %.1f — stretching %.1f%%"
            % (beat_raw, folded, vocal_tempo, (speed - 1.0) * 100.0))
        info["stretch_engine"] = time_stretch(current, w("stretched.wav"), speed)
        current = w("stretched.wav")
        info["stretched"] = info["stretch_engine"] != "none"

        # Measured, not assumed — the same rule that produced this whole stage.
        check_mono, _ = _mono(_decode(current, w("chk-m.wav"), channels=1))
        after = estimate_tempo(check_mono, ANALYSIS_SR)
        if after:
            after_folded = fold_tempo_to(after, vocal_tempo)
            info["beat_tempo_after"] = round(after_folded, 1)
            info["tempo_error_pct"] = round((after_folded / vocal_tempo - 1.0) * 100.0, 2)
            log("  after stretch: %.1f BPM (%.2f%% off the vocal)"
                % (after_folded, info["tempo_error_pct"]))
    else:
        info["stretch_skipped"] = "no tempo measured" if do_stretch else "disabled"
        log("  not stretching (%s)" % info["stretch_skipped"])

    # ── key ─────────────────────────────────────────────────────────────────
    if do_shift and vocal_key and key_confidence >= min_key_confidence:
        bk = detect_beat_key(_mono(_decode(current, w("key-m.wav"), channels=1))[0],
                             ANALYSIS_SR)
        if bk is None:
            info["shift_skipped"] = "could not read the beat's key"
        else:
            info["beat_key"] = bk["name"] + " " + bk["mode"]
            d = (int(vocal_key["tonic"]) - int(bk["tonic"])) % 12
            if d > 6:
                d -= 12
            info["semitones_needed"] = d
            if abs(d) > max_semitones:
                # Clamping would leave it in a different wrong key, which is
                # worse than an honest clash.
                info["shift_skipped"] = "%d semitones is too far to shift cleanly" % d
            else:
                info["shift_engine"] = pitch_shift(current, w("shifted.wav"), float(d))
                current = w("shifted.wav")
                info["shifted"] = info["shift_engine"] != "none"
                log("  beat in %s, vocal in %s %s — shifting %+d semitones"
                    % (info["beat_key"], vocal_key["name"], vocal_key["mode"], d))
    else:
        info["shift_skipped"] = ("key confidence %.3f is below %.2f"
                                 % (key_confidence, min_key_confidence)) \
            if do_shift else "disabled"
    if info.get("shift_skipped"):
        log("  not pitch-shifting (%s)" % info["shift_skipped"])

    # ── phase ───────────────────────────────────────────────────────────────
    delay = 0
    if do_shift or do_stretch:
        cur_mono, _ = _mono(_decode(current, w("cur-m.wav"), channels=1))
        v_env, fps = onset_envelope(voc_mono, ANALYSIS_SR)
        b_env, _ = onset_envelope(cur_mono, ANALYSIS_SR)
        if v_env is not None and b_env is not None and v_env.any() and b_env.any():
            bar = (4.0 * 60.0 / float(vocal_tempo)) if vocal_tempo else 3.0
            frames = best_offset(v_env, b_env, bar * fps)
            delay = int(round(frames * ONSET_HOP))
            info["slide_seconds"] = round(delay / float(ANALYSIS_SR), 3)
            info["slid"] = delay != 0
            log("  sliding the beat %+.3f s onto the vocal's grid"
                % info["slide_seconds"])
        else:
            info["slide_skipped"] = "no usable onsets"

    secs, pad = _shift_and_fit(current, out_path, delay, int(voc_seconds * ANALYSIS_SR))
    info["seconds"] = round(secs, 2)
    if pad > 0.25:
        # The last phrase of the vocal is sitting over nothing. Worth saying:
        # the cure is asking the music engine for a longer beat, not a
        # different alignment.
        info["padded_silence_seconds"] = round(pad, 2)
        log("  ⚠ beat ran %.1fs short — that much of the ending has no music "
            "under it; ask for a longer beat" % pad)
    shutil.rmtree(work, ignore_errors=True)
    return info


def main():
    p = argparse.ArgumentParser(description="Align a generated beat to a vocal.")
    p.add_argument("beat")
    p.add_argument("vocal")
    p.add_argument("out")
    p.add_argument("--vocal-tempo", type=float, default=None,
                   help="override the vocal's detected tempo, in BPM")
    p.add_argument("--vocal-key", default=None,
                   help='override the vocal key, e.g. "G# minor"')
    p.add_argument("--key-confidence", type=float, default=0.0)
    p.add_argument("--min-key-confidence", type=float, default=0.5)
    p.add_argument("--no-stretch", action="store_true")
    p.add_argument("--no-shift", action="store_true")
    a = p.parse_args()

    key = None
    if a.vocal_key:
        bits = a.vocal_key.split()
        if bits[0] not in NAMES:
            sys.exit("Key should look like 'G# minor'. Names: " + " ".join(NAMES))
        key = {"tonic": NAMES.index(bits[0]), "name": bits[0],
               "mode": (bits[1].lower() if len(bits) > 1 else "major")}

    info = align_beat(a.beat, a.vocal, a.out,
                      vocal_tempo=a.vocal_tempo, vocal_key=key,
                      key_confidence=a.key_confidence,
                      min_key_confidence=a.min_key_confidence,
                      do_stretch=not a.no_stretch, do_shift=not a.no_shift)
    print(json.dumps(info, indent=2))


if __name__ == "__main__":
    main()
