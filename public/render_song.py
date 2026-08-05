#!/usr/bin/env python3
"""
SONG STUDIO — render a song.

  guide take  →  tune  →  your voice model  →  beat  →  mix  →  track

Runs on the pod, inside the RVC repo. Every stage writes an intermediate file
so a failure at the mix step doesn't cost the two expensive stages before it.

  export SUPABASE_SERVICE_KEY=...
  export PROFILE_ID=...
  python render_song.py guide.wav --genre rnb --instruments "Rhodes, no hi-hats"
"""

import os, sys, json, math, argparse, subprocess, tempfile, shutil
import numpy as np, requests, soundfile as sf

ROOT = os.environ.get("RVC_ROOT", "/workspace/rvc")
sys.path.insert(0, ROOT)
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

SUPABASE_URL = os.environ.get("SUPABASE_URL", "https://yuzvpmxbtjpqtapborhr.supabase.co")
KEY = (os.environ.get("SUPABASE_SERVICE_KEY") or "").strip()
H = {"apikey": KEY, "Authorization": "Bearer " + KEY}


def sh(*cmd):
    r = subprocess.run(cmd, capture_output=True, text=True)
    if r.returncode:
        raise RuntimeError(" ".join(cmd[:3]) + " failed:\n" + (r.stderr or "")[-800:])
    return r


# ── 1 · TUNE ────────────────────────────────────────────────────────────────
def stage_tune(guide, out, strength):
    from tune import tune_file
    info = tune_file(guide, out, strength=strength)
    k = info["key"]
    print(f"  key {k['name']} {k['mode']} (confidence {k['confidence']})  "
          f"tempo {info['tempo']}  {info['notes']} notes  "
          f"median move {info['median_correction_cents']}c")
    # Low confidence means the guide wandered between keys. The beat gets built
    # from this, so a bad read here becomes a beat that fights the vocal — worth
    # saying out loud rather than burying.
    if k["confidence"] < 0.4:
        print("  ⚠ key detection is uncertain — the beat may not sit right")
    return info


# ── 2 · YOUR VOICE ──────────────────────────────────────────────────────────
def stage_voice(tuned, out, model_pth, model_index, index_rate, protect):
    """
    RVC inference against the fine-tuned model.

    f0_up_key stays 0. Transposing here would undo the tuning stage, which has
    already put the melody exactly where it belongs.
    """
    weights = os.path.join(ROOT, "assets", "weights")
    os.makedirs(weights, exist_ok=True)
    local = os.path.join(weights, "songvoice.pth")
    if os.path.abspath(model_pth) != os.path.abspath(local):
        shutil.copy(model_pth, local)

    from configs.config import Config
    from infer.vc.modules import VC

    # RVC's Config runs argparse on sys.argv when constructed — it expects the
    # web UI's flags (--port, --pycmd, --colab) and hard-exits on anything else.
    # Ours look like garbage to it. Hide the command line for the duration of
    # the import and put it back afterwards.
    saved_argv = sys.argv
    sys.argv = [saved_argv[0]]
    try:
        vc = VC(Config())
        vc.get_vc("songvoice.pth")
    finally:
        sys.argv = saved_argv

    _, wav = vc.vc_single(
        0, tuned,
        0,                  # f0_up_key — see above
        "rmvpe",            # best pitch tracker available here for singing
        model_index or "",
        index_rate,         # how hard to pull toward the real voice
        0,                  # resample_sr 0 = keep the model's native rate
        0.25,               # rms_mix_rate — keeps some of the guide's dynamics
        protect,            # protects consonants and breaths from artefacts
    )
    if wav is None:
        raise RuntimeError("Voice conversion returned nothing — check the model file.")
    sr, audio = wav
    sf.write(out, audio, sr)
    print(f"  {len(audio)/sr:.1f}s at {sr} Hz")
    return sr


# ── 3 · BEAT ────────────────────────────────────────────────────────────────
def fetch_to(url, dst):
    """Download a URL to a local file. Used to pull a chosen/uploaded beat."""
    r = requests.get(url, timeout=120)
    r.raise_for_status()
    with open(dst, "wb") as f:
        f.write(r.content)
    if os.path.getsize(dst) < 1000:
        raise RuntimeError("downloaded beat is empty")
    return dst


def build_sections(info, total_dur, max_sections=12):
    """
    Carve the sung melody into SECTIONS — the score's structure — so the
    instrumental can be arranged around the vocal's actual shape instead of
    generated blind and glued on after. This is the difference between
    "a beat in the right key" and "an arrangement written for this melody".

    Sections split at breath gaps (>0.8s between notes). Each carries:
      - its exact duration (the instrumental's sections will match it 1:1)
      - its energy (mean pitch height + note density -> sparse/building/full)
      - its chords (which bars of the progression fall inside it)
    """
    notes = info.get("note_list") or []
    chords = info.get("chords") if isinstance(info.get("chords"), dict) else {}
    bars = chords.get("bars") or []
    spb = float(chords.get("seconds_per_bar") or 2.0)
    if len(notes) < 4:
        return None

    # split at gaps
    phrases, cur = [], [notes[0]]
    for prev, n in zip(notes, notes[1:]):
        gap = n["start"] - (prev["start"] + prev["dur"])
        if gap > 0.8:
            phrases.append(cur); cur = []
        cur.append(n)
    phrases.append(cur)

    # merge tiny phrases forward until each section is >=4s (ElevenLabs
    # sections must be 3-120s; very short ones make a choppy arrangement).
    # Close at the BREATH GAP once the running section is long enough —
    # closing after extending instead would swallow the next phrase and
    # merge musically distinct passages (a verse into its chorus).
    sections, cur, start = [], [], phrases[0][0]["start"]
    for ph in phrases:
        if cur:
            cur_end = cur[-1]["start"] + cur[-1]["dur"]
            if cur_end - start >= 4.0:
                sections.append((start, cur_end, cur))
                cur = []; start = ph[0]["start"]
        cur.extend(ph)
    if cur:
        if sections:
            s0, _, ns = sections[-1]
            sections[-1] = (s0, cur[-1]["start"] + cur[-1]["dur"], ns + cur)
        else:
            sections = [(start, cur[-1]["start"] + cur[-1]["dur"], cur)]
    sections = sections[:max_sections]

    # energy per section, relative to the whole take
    import statistics
    def midi_of(name):
        NAMES = ["C","C#","D","D#","E","F","F#","G","G#","A","A#","B"]
        pc = name[:-1]; octv = int(name[-1])
        return NAMES.index(pc) + 12 * (octv + 1)
    all_pitches = [midi_of(n["name"]) for n in notes]
    p_lo, p_hi = min(all_pitches), max(all_pitches)

    out = []
    for (a, b, ns) in sections:
        pitches = [midi_of(n["name"]) for n in ns]
        density = len(ns) / max(0.5, b - a)
        height = (statistics.mean(pitches) - p_lo) / max(1, p_hi - p_lo)
        score = 0.6 * height + 0.4 * min(1.0, density / 4.0)
        energy = "sparse" if score < 0.35 else ("building" if score < 0.65 else "full")
        # chords whose bars overlap this section
        i0, i1 = int(a // spb), int(b // spb) + 1
        sec_chords = [x["chord"] for x in bars[i0:i1]]
        out.append({
            "start": round(a, 2), "duration": round(b - a, 2),
            "energy": energy,
            "chords": sec_chords[:8],
        })
    # lead-in before the first phrase becomes an intro the vocal enters over
    if out and out[0]["start"] > 2.0:
        out.insert(0, {"start": 0.0, "duration": round(out[0]["start"], 2),
                       "energy": "sparse", "chords": out[0]["chords"][:2], "intro": True})
    # a short tail so the song does not stop dead with the last word
    out.append({"start": round(total_dur, 2), "duration": 6.0,
                "energy": "sparse", "chords": (out[-1]["chords"] or [])[-2:], "outro": True})
    return out


def stage_beat(out, genre, instruments, key, tempo, seconds, app_base, chords=None, style=None, sections=None):
    """
    Calls the app's own endpoint rather than ElevenLabs directly, so the
    composition rules live in exactly one place and the pod never needs a
    music API key.

    Asks for more beat than the vocal needs. Alignment folds whatever comes
    back into the vocal's metrical octave, which can mean speeding it up by as
    much as 29% — and a beat that runs out early leaves the last phrase
    hanging over silence. Overshooting costs a few seconds of generation;
    undershooting costs the ending.
    """
    r = requests.post(f"{app_base}/api/song-beat", timeout=300, json={
        "action": "compose", "genre": genre, "instruments": instruments,
        "key": {"name": key["name"], "mode": key["mode"]} if key else None,
        "tempo": tempo, "seconds": int(seconds),
        # The melody's implied progression, so the beat is built on the vocal's
        # own harmony rather than a genre-word guess. This is the fix for beats
        # that clash with the sung line.
        "chords": chords,
        # An inspo track's production description (from Gemini via /api/song-inspo).
        # Shapes the FEEL — instruments, texture, mix — while the key/tempo/chords
        # above keep the beat on the melody's own harmonic ground.
        "style": style,
        # The score's structure: the vocal's own sections with exact durations,
        # energy and chords. When present, the beat endpoint builds a
        # composition PLAN from it instead of a text prompt — the instrumental
        # is arranged around this melody, not generated blind.
        "sections": sections,
    })
    if r.status_code != 200:
        raise RuntimeError(f"Beat generation failed ({r.status_code}): {r.text[:300]}")
    open(out, "wb").write(r.content)
    print(f"  {len(r.content)//1024} KB, {int(seconds)}s requested")


# ── 4 · ALIGN ───────────────────────────────────────────────────────────────
def stage_align(beat, vocal, out, info, tempo_override, key_override,
                min_key_conf, enabled):
    """
    Make the beat match the vocal instead of hoping it does.

    The music engine treats the requested tempo and key as a vibe, not a spec —
    148 in G# came back as 166 in something else. Everything here is measured
    off the audio that actually arrived. See align.py for why folding the
    tempo octave first is what keeps the stretch inaudible.
    """
    if not enabled:
        print("  alignment disabled — copying the beat through untouched")
        shutil.copy(beat, out)
        return {"disabled": True}
    from align import align_beat
    key = key_override or info["key"]
    conf = 1.0 if key_override else float(info["key"].get("confidence") or 0.0)
    return align_beat(beat, vocal, out,
                      vocal_tempo=tempo_override or info["tempo"],
                      vocal_key=key, key_confidence=conf,
                      min_key_confidence=min_key_conf)


# ── 5 · MIX ─────────────────────────────────────────────────────────────────
def _rms_db(path):
    x, _ = sf.read(path, always_2d=True)
    if not len(x):
        return -100.0
    r = float(np.sqrt((x.mean(axis=1) ** 2).mean()))
    return 20.0 * math.log10(r) if r > 0 else -100.0


def stage_harmony(vocal, out, info, intensity="lush"):
    """
    Backing vocals — the vocal singing harmony with itself.

    NOT a fixed pitch shift of the whole take: that moves the harmony in perfect
    parallel with the lead and just sounds like an aggressive chorus effect. Real
    backing vocals hold their OWN note as the melody moves, landing in the chord
    underneath. So this shifts each phrase by a DIFFERENT interval, chosen per
    chord, so the harmony line moves independently — a second singer, not a
    doubler.

    Uses the chord progression already detected from the melody (info["chords"]).
    Formant-preserved shifting (rubberband -F) keeps the harmony sounding like
    the same voice rather than thin and chipmunky. Panned and delayed slightly so
    the layers separate instead of blurring into one another.

    intensity: "subtle" = one soft third; "lush" = third + fifth, wider.
    Returns True if a harmony was written, False if there wasn't enough to work
    with (in which case the caller just uses the dry lead).
    """
    chords = info.get("chords")
    if not isinstance(chords, dict) or not chords.get("bars"):
        print("  no chord map — skipping harmony")
        return False

    import numpy as _np
    import soundfile as _sf
    from tune import hz_to_midi, analyse as _an, NAMES as _NAMES

    x, sr, f0, _t, _sp, _ap = _an(vocal)
    midi = hz_to_midi(f0)
    fps = 200.0
    spb = float(chords.get("seconds_per_bar") or 2.0)
    fpb = max(1, int(spb * fps))
    bars = chords["bars"]

    def _tones(name):
        rn = name[:-1] if name.endswith("m") else name
        if rn not in _NAMES:
            return None
        root = _NAMES.index(rn)
        ints = (0, 3, 7) if name.endswith("m") else (0, 4, 7)
        return [(root + i) % 12 for i in ints]

    def _shift_for(lead_note, chord_name, lo, hi):
        tones = _tones(chord_name)
        if tones is None:
            return None
        best = None
        for octv in range(-1, 4):
            for tpc in tones:
                note = tpc + 12 * (4 + octv)
                d = note - lead_note
                if lo <= d <= hi and (best is None or d < best):
                    best = d
        return best

    voices = [("third", 2, 6, 0.85, 0.55)]
    if intensity == "lush":
        voices.append(("fifth", 6, 11, 0.55, 0.85))   # pan opposite the third

    work = os.path.dirname(out) or "."
    lead = x / (_np.abs(x).max() or 1.0) * 0.8
    left = lead.copy()
    right = lead.copy()

    wrote_any = False
    for vname, lo, hi, lgain, rgain in voices:
        harmony = _np.zeros(len(x))
        last_semi = None
        for i, bar in enumerate(bars):
            b0, b1 = i * fpb, (i + 1) * fpb
            seg = midi[b0:b1]
            seg = seg[~_np.isnan(seg)]
            s0 = int(b0 / fps * sr)
            s1 = min(int(b1 / fps * sr), len(x))
            if s1 <= s0:
                continue
            if len(seg) >= 8:
                lead_note = int(round(_np.median(seg)))
                semi = _shift_for(lead_note, bar["chord"], lo, hi)
                if semi is not None:
                    last_semi = semi
            # Hold the last good interval through a rest/breath so the harmony
            # doesn't drop out for a bar — that gap is what made the prototype
            # sound intermittent.
            semi = last_semi
            if semi is None or semi == 0:
                continue
            seg_wav = os.path.join(work, "_hseg.wav")
            seg_out = os.path.join(work, "_hseg_sh.wav")
            _sf.write(seg_wav, x[s0:s1].astype("float32"), sr)
            try:
                sh("rubberband", "-F", "-p", "%+d" % semi, "-q", seg_wav, seg_out)
                h, _hr = _sf.read(seg_out)
                if getattr(h, "ndim", 1) > 1:
                    h = h.mean(axis=1)
                n = s1 - s0
                h = h[:n] if len(h) >= n else _np.pad(h, (0, n - len(h)))
                harmony[s0:s1] = h
                wrote_any = True
            except Exception as e:
                print("  harmony shift skipped a bar: " + str(e))
        if harmony.any():
            peak = _np.abs(harmony).max() or 1.0
            harmony = harmony / peak * 0.5
            # small delay so the backing voice sits a hair behind the lead
            d = int(sr * 0.012)
            hd = _np.concatenate([_np.zeros(d), harmony])[:len(lead)]
            left += hd * lgain
            right += hd * rgain

    if not wrote_any:
        print("  harmony produced nothing usable — using dry lead")
        return False

    st = _np.stack([left, right], axis=1)
    st = st / (_np.abs(st).max() * 1.05 or 1.0)
    _sf.write(out, st.astype("float32"), sr)
    print("  backing vocals: %s, %d bars harmonised" % (intensity, len(bars)))
    return True


def stage_vocal_chain(vocal, out):
    """
    highpass  — clears the mud below the voice so the bass has room
    compand   — evens out the loud and quiet parts of an untrained take
    aecho     — a short slap, not a wash; long reverb buries diction

    Rendered on its own rather than inline in the mix graph so the next stage
    can measure the vocal as it will actually be heard. Measuring the raw take
    would set the balance against a level that no longer exists by the time
    the two stems meet.
    """
    sh("ffmpeg", "-y", "-v", "error", "-i", vocal, "-af",
       "highpass=f=90,"
       "compand=attacks=0.01:decays=0.25:points=-70/-70|-24/-14|-6/-6|0/-4,"
       "aecho=0.8:0.85:45:0.12",
       "-ar", "44100", "-c:a", "pcm_s16le", out)


def _avg_spectrum(path, nbands=32):
    """Average magnitude spectrum of a mono mixdown, in nbands log-spaced bins."""
    import numpy as np, soundfile as sf
    x, sr = sf.read(path, always_2d=True)
    x = x.mean(axis=1)
    # Welch-ish: average FFT magnitude over windows
    win = 4096
    if len(x) < win:
        x = np.pad(x, (0, win - len(x)))
    hop = win // 2
    mags = []
    for i in range(0, len(x) - win, hop):
        seg = x[i:i+win] * np.hanning(win)
        mags.append(np.abs(np.fft.rfft(seg)))
    if not mags:
        mags = [np.abs(np.fft.rfft(x[:win] * np.hanning(win)))]
    mag = np.mean(mags, axis=0) + 1e-9
    freqs = np.fft.rfftfreq(win, 1/sr)
    # log-spaced band edges 60 Hz .. 16 kHz
    edges = np.logspace(np.log10(60), np.log10(16000), nbands + 1)
    band_f, band_db = [], []
    for lo, hi in zip(edges[:-1], edges[1:]):
        m = (freqs >= lo) & (freqs < hi)
        if m.any():
            band_f.append(float(np.sqrt(lo*hi)))
            band_db.append(float(20*np.log10(np.mean(mag[m]))))
    return band_f, band_db, sr


def _detect_phrases(path, silence_db=-38, min_sil=0.4):
    """Find [start,end] of sung phrases via silence gaps. Returns seconds."""
    import subprocess, re
    r = subprocess.run(["ffmpeg", "-i", path, "-af",
        f"silencedetect=noise={silence_db}dB:d={min_sil}", "-f", "null", "-"],
        capture_output=True, text=True)
    log = r.stderr
    starts = [float(m) for m in re.findall(r"silence_end: ([0-9.]+)", log)]
    ends = [float(m) for m in re.findall(r"silence_start: ([0-9.]+)", log)]
    import soundfile as sf
    dur = sf.info(path).duration
    # Phrases are the audio BETWEEN silences. Build from the silence markers.
    # silence_start marks where a phrase ends; silence_end marks where next begins.
    bounds = []
    cur_start = 0.0 if (not starts or (ends and ends[0] < (starts[0] if starts else 1e9))) else None
    # Simpler robust reconstruction:
    marks = sorted([("end", e) for e in ends] + [("start", s2) for s2 in starts], key=lambda x: x[1])
    phrases, open_at = [], 0.0
    silent = False
    for kind, t in marks:
        if kind == "end" and not silent:  # a phrase just ended
            if t > open_at + 0.05:
                phrases.append([open_at, t]); silent = True
        elif kind == "start":            # a phrase begins
            open_at = t; silent = False
    if not silent and dur > open_at + 0.05:
        phrases.append([open_at, dur])
    return phrases or [[0.0, dur]]


def stage_vocal_align(vocal, reference, out):
    """
    Time-align the re-sung vocal to the reference (Suno vocal stem) so silences
    and phrase positions LAND on Suno's timeline. Detect phrase blocks in both;
    for each matched pair, place our phrase at the reference's start and, if the
    lengths differ, gently stretch ours to fit (atempo, capped so it stays
    natural). Gaps become silence. Result drops onto Suno's stems in time.
    """
    import soundfile as sf, subprocess, os, tempfile
    ref_p = _detect_phrases(reference)
    our_p = _detect_phrases(vocal)
    n = min(len(ref_p), len(our_p))
    if n == 0:
        # nothing to align — copy through
        sh("ffmpeg", "-y", "-v", "error", "-i", vocal, "-ar", "44100",
           "-c:a", "pcm_s16le", out); return
    total = sf.info(reference).duration
    sr = 44100
    import numpy as np
    canvas = np.zeros(int(total * sr) + sr, dtype=np.float32)
    src, ssr = sf.read(vocal, always_2d=True)
    src = src.mean(axis=1)
    if ssr != sr:
        import librosa; src = librosa.resample(src, orig_sr=ssr, target_sr=sr)
    for i in range(n):
        r0, r1 = ref_p[i]; o0, o1 = our_p[i]
        seg = src[int(o0*sr):int(o1*sr)]
        if len(seg) < 10:
            continue
        want = r1 - r0; have = (o1 - o0)
        ratio = have / want if want > 0 else 1.0
        # stretch only within a natural range; beyond that, just place it
        if 0.8 <= ratio <= 1.25 and abs(ratio - 1) > 0.03:
            tmp_i = tempfile.mktemp(suffix=".wav"); tmp_o = tempfile.mktemp(suffix=".wav")
            sf.write(tmp_i, seg, sr)
            subprocess.run(["ffmpeg","-y","-v","error","-i",tmp_i,"-af",
                f"atempo={ratio:.4f}","-ar",str(sr),tmp_o], check=True)
            seg, _ = sf.read(tmp_o); os.remove(tmp_i); os.remove(tmp_o)
        pos = int(r0 * sr)
        end = min(pos + len(seg), len(canvas))
        canvas[pos:end] += seg[:end-pos]
    peak = float(np.max(np.abs(canvas))) or 1.0
    canvas = (canvas / peak) * 0.97
    sf.write(out, canvas, sr)
    print(f"  aligned {n} phrases to the reference timeline")


def stage_vocal_match(vocal, reference, out, wet=True, max_boost=9.0):
    """
    MATCH the re-sung vocal to a reference (the person's Suno vocal stem) the way
    Logic's Match EQ does: measure the reference's tonal fingerprint, measure
    ours, and apply the difference so ours takes on the reference's tone. Then,
    if wet, place it in a matching space. This is how the output sits in that
    SPECIFIC Suno song without the person touching an EQ.

    We match EQ (tone), not reverb — reverb is added to taste. Boosts are capped
    so a wildly different reference can't turn the vocal into noise.
    """
    import numpy as np
    rf, rdb, _ = _avg_spectrum(reference)
    sf_, sdb, _ = _avg_spectrum(vocal)
    # align on shared bands, compute reference-minus-source correction
    n = min(len(rf), len(sf_))
    rdb, sdb, freqs = np.array(rdb[:n]), np.array(sdb[:n]), np.array(rf[:n])
    # normalise both to their own mean so we match SHAPE, not absolute level
    diff = (rdb - rdb.mean()) - (sdb - sdb.mean())
    diff = np.clip(diff, -max_boost, max_boost)
    # build a firequalizer curve: gain_entry '(f=GAIN)' pairs
    entries = ";".join(f"entry({int(f)},{d:.1f})" for f, d in zip(freqs, diff))
    fireq = "firequalizer=gain_entry='" + entries + "'"
    space = ("aecho=0.8:0.9:60:0.18,aecho=0.7:0.75:220:0.12" if wet else "")
    chain = "highpass=f=85," + fireq + ("," + space if space else "")
    sh("ffmpeg", "-y", "-v", "error", "-i", vocal, "-af",
       chain, "-ar", "44100", "-c:a", "pcm_s16le", out)
    print(f"  matched tone to reference across {n} bands"
          + (", added space" if wet else ", dry"))


def stage_vocal_seated(vocal, out, space="wet"):
    """
    The re-sing, PRODUCED to sit in a Suno-style mix.

    Suno stems come wet — reverb, EQ, compression already on them. A bone-dry
    vocal dropped beside them sounds like a different room, and most people
    (rightly) don't want to become a mixing engineer to fix it. So we seat the
    vocal in the same sonic world: carve it with EQ, keep it steady with
    compression, and place it in a real reverb tuned for a modern lead vocal.
    We can't copy Suno's exact reverb (it lives in their model), but we can put
    the voice in a matching space so it belongs in the mix as-is.

      space="wet"  — lush plate-ish reverb + delay throw, for dream-pop / pop
      space="dry"  — clean and close, for users who WILL mix it themselves

    Chain:
      highpass 85      — clear the sub so it doesn't clash with bass
      equalizer 250 -2 — trim boxiness
      equalizer 3.5k +2, 10k +1.5 — presence and air so it cuts
      compand          — even out an untrained take
      aecho (short)    — a slap for depth
      aecho (long)     — the reverb tail that seats it in the room (wet only)
    """
    if space == "dry":
        af = ("highpass=f=90,"
              "equalizer=f=250:t=q:w=1.2:g=-2,"
              "equalizer=f=3500:t=q:w=1.4:g=2,"
              "compand=attacks=0.01:decays=0.25:points=-70/-70|-24/-14|-6/-6|0/-4")
    else:
        af = ("highpass=f=85,"
              "equalizer=f=250:t=q:w=1.2:g=-2,"
              "equalizer=f=3500:t=q:w=1.4:g=2.2,"
              "equalizer=f=10000:t=q:w=1:g=1.5,"
              "compand=attacks=0.01:decays=0.25:points=-70/-70|-24/-14|-6/-6|0/-4,"
              # short slap for depth, then a longer softer tail for space
              "aecho=0.8:0.9:60:0.18,"
              "aecho=0.7:0.75:220:0.12")
    sh("ffmpeg", "-y", "-v", "error", "-i", vocal, "-af",
       af, "-ar", "44100", "-c:a", "pcm_s16le", out)


def stage_mix(vocal_proc, beat, out, lead_db, vocal_db, beat_db):
    """
    The balance is measured, not dialled in.

    Fixed dB offsets are how the beat ended up 13 dB over the vocal: they were
    chosen against one beat, and every beat since has come back at whatever
    level the music engine felt like. Setting the beat relative to the
    measured vocal makes the balance hold no matter what arrives.

    sidechain — ducks the beat under the voice, which is what makes a mix
                sound produced rather than layered
    loudnorm  — one pass to −14 LUFS, the streaming target
    """
    v_db, b_db = _rms_db(vocal_proc), _rms_db(beat)
    gain = (v_db - lead_db) - b_db + beat_db
    print(f"  vocal {v_db:.1f} dB RMS, beat {b_db:.1f} dB — beat {gain:+.1f} dB "
          f"so the vocal leads by {lead_db:.1f} dB")

    fmt = "aformat=sample_fmts=fltp:sample_rates=44100:channel_layouts=stereo"
    sh("ffmpeg", "-y", "-v", "error", "-i", vocal_proc, "-i", beat,
       "-filter_complex",
       f"[0:a]{fmt},volume={vocal_db}dB,asplit=2[v][vkey];"
       f"[1:a]{fmt},volume={gain:.2f}dB[b];"
       f"[b][vkey]sidechaincompress=threshold=0.05:ratio=4:attack=8:release=260[bduck];"
       f"[v][bduck]amix=inputs=2:duration=longest:normalize=0,"
       f"alimiter=limit=0.95,"
       f"loudnorm=I=-14:TP=-1.5:LRA=11[mix]",
       "-map", "[mix]", "-ar", "44100", "-b:a", "320k", out)
    print(f"  {os.path.getsize(out)//1024} KB")


# ── 6 · SHIP ────────────────────────────────────────────────────────────────
def stage_upload(path, profile_id, meta):
    prof = requests.get(f"{SUPABASE_URL}/rest/v1/voice_profiles",
                        params={"select": "user_id", "id": f"eq.{profile_id}"},
                        headers=H, timeout=30).json()
    if not prof:
        raise RuntimeError("profile not found")
    uid = prof[0]["user_id"]
    name = f"song-{meta['stamp']}.mp3"
    key = f"{uid}/{profile_id}/songs/{name}"
    r = requests.post(f"{SUPABASE_URL}/storage/v1/object/voice/{key}",
                      headers={**H, "x-upsert": "true", "Content-Type": "audio/mpeg"},
                      data=open(path, "rb"), timeout=600)
    r.raise_for_status()
    print(f"  {key}")
    return key


def stage_upload_vocal(path, profile_id, meta):
    prof = requests.get(f"{SUPABASE_URL}/rest/v1/voice_profiles",
                        params={"select": "user_id", "id": f"eq.{profile_id}"},
                        headers=H, timeout=30).json()
    if not prof:
        raise RuntimeError("profile not found")
    uid = prof[0]["user_id"]
    name = f"resing-{meta['stamp']}.wav"
    key = f"{uid}/{profile_id}/vocals/{name}"
    r = requests.post(f"{SUPABASE_URL}/storage/v1/object/voice/{key}",
                      headers={**H, "x-upsert": "true", "Content-Type": "audio/wav"},
                      data=open(path, "rb"), timeout=600)
    r.raise_for_status()
    print(f"  {key}")
    return key


def main():
    p = argparse.ArgumentParser()
    p.add_argument("guide", nargs="?", default="",
                   help="the guide take; omit when using --convert-vocal")
    p.add_argument("--genre", default="pop")
    p.add_argument("--beat-url", default="",
                   help="a pre-chosen or uploaded beat; when set, skip generation and use this")
    p.add_argument("--voice-mode", default="converter", choices=["converter", "generator"],
                   help="converter = RVC repaints the tuned take (default); "
                        "generator = DiffSinger SINGS the score from scratch (needs a trained generator)")
    p.add_argument("--lyrics", default="",
                   help="the words sung in the guide take (generator mode needs them)")
    p.add_argument("--generator-model", default="",
                   help="path to the trained acoustic.ckpt (generator mode)")
    p.add_argument("--instruments", default="")
    p.add_argument("--style", default="",
                   help="production style from an inspo track (feel only, not key/tempo)")
    p.add_argument("--harmony", default="off",
                   choices=["off", "subtle", "lush"],
                   help="backing vocals: chord-aware harmony of the lead with itself")
    p.add_argument("--out", default="song.mp3")
    p.add_argument("--tune-strength", type=float, default=0.85)
    # 0.75 is a deliberate middle. Higher locks onto the trained voice but drags
    # in its quirks; lower keeps the guide's delivery and sounds less like you.
    p.add_argument("--index-rate", type=float, default=0.75)
    p.add_argument("--protect", type=float, default=0.33)
    # Detection off a solo vocal is the least certain number in the pipeline.
    # These make it a suggestion rather than a fact.
    p.add_argument("--tempo", type=float, default=None,
                   help="override the detected tempo, in BPM")
    p.add_argument("--key", default=None,
                   help='override the detected key, e.g. "G# minor"')
    p.add_argument("--no-align", action="store_true",
                   help="skip beat alignment entirely (for A/B comparison)")
    p.add_argument("--min-key-confidence", type=float, default=0.5,
                   help="below this, the beat is not pitch-shifted at all")
    # How far the vocal sits above the beat, in dB RMS. The absolute levels are
    # measured at mix time; this is the only number that is taste.
    p.add_argument("--vocal-lead-db", type=float, default=3.0)
    p.add_argument("--vocal-db", type=float, default=0.0, help="trim on the vocal")
    p.add_argument("--beat-db", type=float, default=0.0, help="trim on the beat")
    p.add_argument("--app", default="https://chelgy.app")
    p.add_argument("--no-match", action="store_true",
                   help="convert mode: skip matching the output's tone back to "
                        "the source vocal (matching is on by default)")
    p.add_argument("--convert-vocal", default="",
                   help="URL of a finished vocal (e.g. a Suno stem) to convert "
                        "directly to this voice \u2014 no guide take, keeps the "
                        "input's exact timing, words and phrasing")
    p.add_argument("--vocal-only", action="store_true",
                   help="output ONLY the re-sung vocal (no beat) to sit over your own stems")
    p.add_argument("--vocal-space", default="wet", choices=["wet", "dry", "match"],
                   help="wet = generic produced sound (default); dry = clean/raw; "
                        "match = tone-matched to a reference Suno vocal stem")
    p.add_argument("--match-ref", default="",
                   help="URL of the Suno vocal stem to match tone to (vocal-space=match)")
    p.add_argument("--match-align", dest="match_align", action="store_true", default=True,
                   help="time-align phrases to the reference stem (default on)")
    p.add_argument("--no-match-align", dest="match_align", action="store_false",
                   help="keep my natural timing, only match tone")
    p.add_argument("--no-upload", action="store_true")
    a = p.parse_args()

    key_override = None
    if a.key:
        from tune import NAMES
        bits = a.key.split()
        if bits[0] not in NAMES:
            sys.exit('--key should look like "G# minor". Names: ' + " ".join(NAMES))
        key_override = {"tonic": NAMES.index(bits[0]), "name": bits[0],
                        "mode": (bits[1].lower() if len(bits) > 1 else "major"),
                        "confidence": 1.0}

    pid = os.environ.get("PROFILE_ID")
    if not pid: sys.exit("PROFILE_ID is not set.")
    if not KEY: sys.exit("SUPABASE_SERVICE_KEY is not set.")

    prof = requests.get(f"{SUPABASE_URL}/rest/v1/voice_profiles",
                        params={"select": "*", "id": f"eq.{pid}"}, headers=H, timeout=30).json()
    if not prof: sys.exit("profile not found")
    prof = prof[0]
    if prof["status"] != "ready":
        sys.exit(f"Profile status is '{prof['status']}' — train the voice first.")

    if not a.guide and not a.convert_vocal:
        raise SystemExit("need a guide take, or --convert-vocal <url>")

    work = tempfile.mkdtemp(prefix="song-")
    def w(n): return os.path.join(work, n)

    # ── DIRECT CONVERSION ───────────────────────────────────────────────────
    # Suno's vocal in -> your voice out. No guide take, no tune, no beat: fetch
    # your voice model and run RVC straight on the input, so the melody, timing,
    # words and phrasing stay exactly as Suno performed them and only the voice
    # (timbre) becomes yours. The result drops onto Suno's stems in Logic with
    # perfect alignment, because we never changed the timing.
    if a.convert_vocal:
        print("▸ fetching your voice model")
        for field, dest in (("model_path", "model.pth"), ("index_path", "model.index")):
            if not prof.get(field): continue
            d = requests.get(f"{SUPABASE_URL}/storage/v1/object/voice/{prof[field]}",
                             headers=H, timeout=600)
            d.raise_for_status()
            open(w(dest), "wb").write(d.content)
        print("▸ converting the uploaded vocal to your voice")
        fetch_to(a.convert_vocal, w("src-vocal.audio"))
        # normalise to a wav RVC is happy with
        sh("ffmpeg", "-y", "-v", "error", "-i", w("src-vocal.audio"),
           "-ar", "44100", "-ac", "1", "-c:a", "pcm_s16le", w("src-vocal.wav"))
        stage_voice(w("src-vocal.wav"), w("vocal.wav"), w("model.pth"),
                    w("model.index") if prof.get("index_path") else None,
                    a.index_rate, a.protect)
        # Three finishes, the person's choice:
        #   dry     — bare conversion, no effects (mix it yourself)
        #   wet     — our general produced sound (reverb/EQ), the Mix&Master feel
        #   match   — measure the ACTUAL input vocal and restore its tone/space
        #             onto the converted voice. RVC flattens the production the
        #             input carried; this puts it back with precision to the take
        #             that came in. Highest fidelity to the source.
        if a.vocal_space == "match":
            stage_vocal_match(w("vocal.wav"), w("src-vocal.wav"), w("resing.wav"), wet=True)
        elif a.vocal_space == "dry":
            stage_vocal_seated(w("vocal.wav"), w("resing.wav"), space="dry")
        else:
            stage_vocal_seated(w("vocal.wav"), w("resing.wav"), space="wet")
        import shutil as _sh
        _sh.copy(w("resing.wav"), a.out)
        if not a.no_upload:
            import datetime
            stage_upload_vocal(w("resing.wav"), pid,
                               {"stamp": datetime.datetime.now().strftime("%Y%m%d-%H%M%S")})
        print(f"\n✓ {a.out}  (your voice on Suno’s performance — drops onto the stems in Logic)")
        return

    print("▸ 1/6  tuning the guide take")
    info = stage_tune(a.guide, w("tuned.wav"), a.tune_strength)
    if info.get("tempo_candidates"):
        print("  tempo options: " + ", ".join(
            f"{c['bpm']} ({c['relation']})" for c in info["tempo_candidates"]))
    if a.tempo:
        print(f"  using your tempo override: {a.tempo}")
    if key_override:
        print(f"  using your key override: {a.key}")

    print("▸ 2/6  fetching your voice model")
    for field, dest in (("model_path", "model.pth"), ("index_path", "model.index")):
        if not prof.get(field): continue
        d = requests.get(f"{SUPABASE_URL}/storage/v1/object/voice/{prof[field]}",
                         headers=H, timeout=600)
        d.raise_for_status()
        open(w(dest), "wb").write(d.content)

    print("▸ 3/6  singing it in your voice")
    if a.voice_mode == "generator":
        # THE GENERATOR PATH. Instead of repainting the tuned take (RVC), the
        # trained DiffSinger model SINGS the melody from scratch — a genuinely
        # generated vocal in the person's voice. Needs: the note list from the
        # tune analysis, the lyrics that were sung, and the trained ckpt.
        print("\u25b8 voice (generator)")
        if not a.lyrics.strip():
            raise SystemExit("generator mode needs --lyrics (the words sung in the guide)")
        if not a.generator_model or not os.path.isfile(a.generator_model):
            raise SystemExit("generator mode needs --generator-model pointing at the trained ckpt")
        notes_path = w("notes.json")
        json.dump(info.get("note_list") or [], open(notes_path, "w"))
        sh(sys.executable, os.path.join(os.path.dirname(os.path.abspath(__file__)), "sing.py"),
           "--notes", notes_path, "--lyrics", a.lyrics,
           "--model", a.generator_model, "--out", w("vocal.wav"))
    else:
        stage_voice(w("tuned.wav"), w("vocal.wav"), w("model.pth"),
                w("model.index") if prof.get("index_path") else None,
                a.index_rate, a.protect)

    dur = sf.info(w("vocal.wav")).duration

    # ── Dry re-sing only ────────────────────────────────────────────────────
    # Everything above already produced w("vocal.wav") — your melody, re-sung in
    # your voice. For the Logic workflow we stop here: clean it dry (no reverb),
    # upload the wav, and skip beat/align/mix entirely.
    if a.vocal_only:
        if a.vocal_space == "match" and a.match_ref:
            print("▸ re-sing (vocal only, matched to your Suno stem)")
            fetch_to(a.match_ref, w("matchref.audio"))
            src_vocal = w("vocal.wav")
            if a.match_align:
                stage_vocal_align(w("vocal.wav"), w("matchref.audio"), w("vocal-aligned.wav"))
                src_vocal = w("vocal-aligned.wav")
            stage_vocal_match(src_vocal, w("matchref.audio"), w("resing.wav"), wet=True)
        else:
            sp = a.vocal_space if a.vocal_space in ("wet", "dry") else "wet"
            print(f"▸ re-sing (vocal only, {sp}) — to sit over your stems")
            stage_vocal_seated(w("vocal.wav"), w("resing.wav"), space=sp)
        import shutil as _sh
        _sh.copy(w("resing.wav"), a.out)
        if not a.no_upload:
            import datetime
            stage_upload_vocal(w("resing.wav"), pid,
                               {"stamp": datetime.datetime.now().strftime("%Y%m%d-%H%M%S")})
        print(f"\n✓ {a.out}  (dry re-sung vocal — add it over your stems in Logic)")
        return
    tempo = a.tempo or info["tempo"]
    key = key_override or info["key"]

    print("▸ 4/6  making the beat")
    # 35% longer than the vocal, because alignment may have to speed the beat
    # up to reach the vocal's tempo and a beat that ends early is worse than a
    # beat that gets trimmed.
    chords = (info.get("chords") or {}).get("progression") if isinstance(info.get("chords"), dict) else None
    # The score's structure — sections carved from the vocal itself. This is
    # what makes the instrumental UNIFIED with the melody instead of stacked
    # under it: the arrangement's sections, durations, energy and chords all
    # come from the same score the voice sings.
    sections = build_sections(info, dur)
    if sections:
        print(f"  score structure: {len(sections)} sections "
              + " ".join(x["energy"][0] for x in sections))
    if a.beat_url:
        # Bring-your-own-beat: the person picked a generated option or uploaded
        # their own instrumental, so we DON'T generate. We still tune and align
        # the vocal to it — the beat is now the fixed thing the voice fits to,
        # which is exactly the beat-first idea (and sidesteps chord-matching).
        print(f"  using the chosen beat: {a.beat_url[:70]}")
        try:
            fetch_to(a.beat_url, w("beat.mp3"))
        except Exception as e:
            print(f"  couldn't fetch the chosen beat ({e}); generating instead")
            stage_beat(w("beat.mp3"), a.genre, a.instruments, key, tempo,
                       min(300, dur * 1.35 + 4), a.app, chords=chords, style=(a.style or None))
    else:
        stage_beat(w("beat.mp3"), a.genre, a.instruments, key, tempo,
                   min(300, dur * 1.35 + 4), a.app, chords=chords,
                   style=(a.style or None), sections=sections)
        if a.style:
            print(f"  inspo feel: {a.style[:70]}")
        if chords:
            print(f"  built on the melody's chords: {' '.join(chords[:8])}")

    print("▸ 5/6  aligning the beat to your vocal")
    align_info = stage_align(w("beat.mp3"), w("vocal.wav"), w("beat-aligned.wav"),
                             info, a.tempo, key_override, a.min_key_confidence,
                             not a.no_align)

    print("▸ 6/6  mixing")
    vocal_for_chain = w("vocal.wav")
    if a.harmony != "off":
        print("▸ backing vocals")
        if stage_harmony(w("vocal.wav"), w("vocal-harm.wav"), info, intensity=a.harmony):
            vocal_for_chain = w("vocal-harm.wav")
    stage_vocal_chain(vocal_for_chain, w("vocal-proc.wav"))
    stage_mix(w("vocal-proc.wav"), w("beat-aligned.wav"), a.out,
              a.vocal_lead_db, a.vocal_db, a.beat_db)

    if not a.no_upload:
        import datetime
        stage_upload(a.out, pid, {"stamp": datetime.datetime.now().strftime("%Y%m%d-%H%M%S")})

    print(f"\n✓ {a.out}")
    print(json.dumps({"key": key["name"] + " " + key["mode"],
                      "tempo": tempo, "seconds": round(dur, 1),
                      "genre": a.genre, "alignment": align_info}, indent=2))


if __name__ == "__main__":
    main()
