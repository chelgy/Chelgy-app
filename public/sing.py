#!/usr/bin/env python3
"""
SONG STUDIO — sing.py — the GENERATOR's voice.

Where RVC repaints an existing take, this SINGS from a score: phonemes + notes
+ durations in, a brand-new sung vocal out, in the trained voice. The Suno-class
path. Runs on the song pod next to render_song.py.

  python sing.py --notes notes.json --lyrics "the words that were sung" \
                 --model /models/acoustic.ckpt --out vocal.wav

notes.json is tune.py's analysis of the guide take:
  [{"midi": 62, "start": 0.42, "dur": 0.31}, ...]

The score construction (syllables onto notes) is deliberately simple in v1:
one syllable per note, in order, melisma when syllables run out. That's the
honest 80% — a real lyric-to-note aligner is a later refinement, and the
guide take's own timing already carries most of the musical truth.

Requires the DiffSinger repo + vocoder baked into the image (see
Dockerfile.song's generator section). Fails fast and loud at each stage.
"""

import argparse
import json
import os
import re
import subprocess
import sys

DS_ROOT = os.environ.get("DIFFSINGER_ROOT", "/opt/diffsinger/DiffSinger")


def die(msg):
    print(f"[sing] ✗ {msg}", file=sys.stderr)
    sys.exit(1)


def note_name(midi):
    NAMES = ["C", "C#", "D", "D#", "E", "F", "F#", "G", "G#", "A", "A#", "B"]
    return f"{NAMES[int(midi) % 12]}{int(midi) // 12 - 1}"


# ── syllables ────────────────────────────────────────────────────────────────
# A tiny, dependency-free English syllable splitter. Not perfect — it doesn't
# need to be. Each syllable becomes the lyric of one note; DiffSinger's own
# phonemizer (in its inference stack) turns words into phonemes properly.
VOWELS = "aeiouy"


def syllables(word):
    w = re.sub(r"[^a-z']", "", word.lower())
    if not w:
        return []
    groups = re.findall(r"[aeiouy]+", w)
    n = max(1, len(groups))
    if len(groups) > 1 and w.endswith("e") and not w.endswith(("le", "ee", "ye")):
        n -= 1  # silent e
    if n == 1:
        return [w]
    # split the word into n roughly even chunks at consonant boundaries
    out, start, per = [], 0, len(w) / n
    for i in range(1, n):
        cut = round(i * per)
        while cut < len(w) - 1 and w[cut] in VOWELS:
            cut += 1
        out.append(w[start:cut]); start = cut
    out.append(w[start:])
    return [s for s in out if s]


def build_score(notes, lyrics, min_note_s=0.06):
    """Marry syllables to notes: one syllable per note, in order; extra notes
    become melisma ('-' continues the previous syllable); extra syllables are
    dropped with a warning (better a shorter line than a garbled one)."""
    sylls = []
    for w in lyrics.split():
        sylls.extend(syllables(w))
    if not sylls:
        die("no usable syllables in the lyrics")

    usable = [n for n in notes if float(n.get("dur", 0)) >= min_note_s]
    if not usable:
        die("no usable notes in the guide analysis")

    score, si = [], 0
    for n in usable:
        if si < len(sylls):
            text = sylls[si]; si += 1
        else:
            text = "-"      # melisma: keep singing the last vowel
        # tune.py sends the tuned note NAME (e.g. "D4"); older callers may send
        # a midi number. Accept either.
        note = n.get("name") or note_name(n["midi"])
        score.append({
            "text": text,
            "note": note,
            "start": round(float(n["start"]), 4),
            "dur": round(float(n["dur"]), 4),
        })
    if si < len(sylls):
        print(f"[sing] note: {len(sylls)-si} syllables didn't fit the melody and were dropped")
    return score


def score_to_ds(score):
    """The .ds format openvpi's inference consumes: parallel strings of
    lyric | note | note duration, plus offsets."""
    return [{
        "offset": score[0]["start"],
        "text": " ".join(s["text"] for s in score),
        "ph_seq": None,                      # let the phonemizer fill this
        "note_seq": " ".join(s["note"] for s in score),
        "note_dur_seq": " ".join(str(s["dur"]) for s in score),
        "input_type": "word",
    }]


def main():
    p = argparse.ArgumentParser()
    p.add_argument("--notes", required=True, help="notes.json from tune.py's analysis")
    p.add_argument("--lyrics", required=True, help="the words that were sung")
    p.add_argument("--model", required=True, help="path to the trained acoustic.ckpt")
    p.add_argument("--out", required=True, help="output vocal wav")
    p.add_argument("--exp", default="generator", help="experiment name the ckpt was trained under")
    a = p.parse_args()

    if not os.path.isdir(DS_ROOT):
        die(f"DiffSinger repo not found at {DS_ROOT} — the image needs the generator section")
    if not os.path.isfile(a.model):
        die(f"model not found: {a.model}")

    notes = json.load(open(a.notes))
    if not isinstance(notes, list) or not notes:
        die("notes.json is empty — the guide analysis found no melody")

    score = build_score(notes, a.lyrics)
    ds = score_to_ds(score)
    ds_path = os.path.splitext(a.out)[0] + ".ds"
    json.dump(ds, open(ds_path, "w"), indent=1)
    print(f"[sing] score: {len(score)} notes, {sum(1 for s in score if s['text']=='-')} melisma")

    # Place the ckpt where DiffSinger's loader expects experiment checkpoints.
    exp_dir = os.path.join(DS_ROOT, "checkpoints", a.exp)
    os.makedirs(exp_dir, exist_ok=True)
    tgt = os.path.join(exp_dir, "model_ckpt_steps_final.ckpt")
    if not os.path.exists(tgt):
        os.symlink(os.path.abspath(a.model), tgt)

    # openvpi inference entrypoint. --exp names the checkpoint dir above.
    r = subprocess.run(
        [sys.executable, "scripts/infer.py", "acoustic", ds_path,
         "--exp", a.exp, "--out", os.path.dirname(os.path.abspath(a.out)) or "."],
        cwd=DS_ROOT)
    if r.returncode != 0:
        die("DiffSinger inference failed — its log above names the reason")

    # infer.py writes <ds name>.wav next to --out; normalise to the asked name.
    produced = os.path.join(os.path.dirname(os.path.abspath(a.out)),
                            os.path.basename(ds_path).replace(".ds", ".wav"))
    if os.path.isfile(produced) and produced != os.path.abspath(a.out):
        os.replace(produced, a.out)
    if not os.path.isfile(a.out):
        die("no vocal was produced")
    print(f"[sing] sung: {a.out}")


if __name__ == "__main__":
    main()
