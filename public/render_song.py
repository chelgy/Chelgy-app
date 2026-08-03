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

import os, sys, json, argparse, subprocess, tempfile, shutil
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
def stage_beat(out, genre, instruments, key, tempo, seconds, app_base):
    """
    Calls the app's own endpoint rather than ElevenLabs directly, so the
    composition rules live in exactly one place and the pod never needs a
    music API key.
    """
    r = requests.post(f"{app_base}/api/song-beat", timeout=300, json={
        "action": "compose", "genre": genre, "instruments": instruments,
        "key": {"name": key["name"], "mode": key["mode"]} if key else None,
        "tempo": tempo, "seconds": int(seconds),
    })
    if r.status_code != 200:
        raise RuntimeError(f"Beat generation failed ({r.status_code}): {r.text[:300]}")
    open(out, "wb").write(r.content)
    print(f"  {len(r.content)//1024} KB")


# ── 4 · MIX ─────────────────────────────────────────────────────────────────
def stage_mix(vocal, beat, out, vocal_db, beat_db):
    """
    A vocal chain in one ffmpeg graph.

    highpass    — clears the mud below the voice so the bass has room
    compand     — evens out the loud and quiet parts of an untrained take
    aecho       — a short slap, not a wash; long reverb buries diction
    sidechain   — ducks the beat under the voice, which is what makes a mix
                  sound produced rather than layered
    loudnorm    — one pass to −14 LUFS, the streaming target
    """
    sh("ffmpeg", "-y", "-i", vocal, "-i", beat,
       "-filter_complex",
       f"[0:a]highpass=f=90,"
       f"compand=attacks=0.01:decays=0.25:points=-70/-70|-24/-14|-6/-6|0/-4,"
       f"aecho=0.8:0.85:45:0.12,"
       f"volume={vocal_db}dB,asplit=2[v][vkey];"
       f"[1:a]volume={beat_db}dB[b];"
       f"[b][vkey]sidechaincompress=threshold=0.05:ratio=4:attack=8:release=260[bduck];"
       f"[v][bduck]amix=inputs=2:duration=longest:normalize=0,"
       f"alimiter=limit=0.95,"
       f"loudnorm=I=-14:TP=-1.5:LRA=11",
       "-ar", "44100", "-b:a", "320k", out)
    print(f"  {os.path.getsize(out)//1024} KB")


# ── 5 · SHIP ────────────────────────────────────────────────────────────────
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
    p.add_argument("--out", default="song.mp3")
    p.add_argument("--tune-strength", type=float, default=0.85)
    # 0.75 is a deliberate middle. Higher locks onto the trained voice but drags
    # in its quirks; lower keeps the guide's delivery and sounds less like you.
    p.add_argument("--index-rate", type=float, default=0.75)
    p.add_argument("--protect", type=float, default=0.33)
    p.add_argument("--vocal-db", type=float, default=0.0)
    p.add_argument("--beat-db", type=float, default=-4.0)
    p.add_argument("--app", default="https://chelgy.app")
    p.add_argument("--no-upload", action="store_true")
    a = p.parse_args()

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

    print("▸ 1/5  tuning the guide take")
    info = stage_tune(a.guide, w("tuned.wav"), a.tune_strength)

    print("▸ 2/5  fetching your voice model")
    for field, dest in (("model_path", "model.pth"), ("index_path", "model.index")):
        if not prof.get(field): continue
        d = requests.get(f"{SUPABASE_URL}/storage/v1/object/voice/{prof[field]}",
                         headers=H, timeout=600)
        d.raise_for_status()
        open(w(dest), "wb").write(d.content)

    print("▸ 3/5  singing it in your voice")
    stage_voice(w("tuned.wav"), w("vocal.wav"), w("model.pth"),
                w("model.index") if prof.get("index_path") else None,
                a.index_rate, a.protect)

    dur = sf.info(w("vocal.wav")).duration
    print("▸ 4/5  making the beat")
    stage_beat(w("beat.mp3"), a.genre, a.instruments, info["key"], info["tempo"], dur, a.app)

    print("▸ 5/5  mixing")
    stage_mix(w("vocal.wav"), w("beat.mp3"), a.out, a.vocal_db, a.beat_db)

    if not a.no_upload:
        import datetime
        stage_upload(a.out, pid, {"stamp": datetime.datetime.now().strftime("%Y%m%d-%H%M%S")})

    print(f"\n✓ {a.out}")
    print(json.dumps({"key": info["key"]["name"] + " " + info["key"]["mode"],
                      "tempo": info["tempo"], "seconds": round(dur, 1),
                      "genre": a.genre}, indent=2))


if __name__ == "__main__":
    main()
