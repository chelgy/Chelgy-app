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
def stage_beat(out, genre, instruments, key, tempo, seconds, app_base, chords=None, style=None):
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


def main():
    p = argparse.ArgumentParser()
    p.add_argument("guide")
    p.add_argument("--genre", default="pop")
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

    work = tempfile.mkdtemp(prefix="song-")
    def w(n): return os.path.join(work, n)

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
    stage_voice(w("tuned.wav"), w("vocal.wav"), w("model.pth"),
                w("model.index") if prof.get("index_path") else None,
                a.index_rate, a.protect)

    dur = sf.info(w("vocal.wav")).duration
    tempo = a.tempo or info["tempo"]
    key = key_override or info["key"]

    print("▸ 4/6  making the beat")
    # 35% longer than the vocal, because alignment may have to speed the beat
    # up to reach the vocal's tempo and a beat that ends early is worse than a
    # beat that gets trimmed.
    chords = (info.get("chords") or {}).get("progression") if isinstance(info.get("chords"), dict) else None
    stage_beat(w("beat.mp3"), a.genre, a.instruments, key, tempo,
               min(300, dur * 1.35 + 4), a.app, chords=chords,
               style=(a.style or None))
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
