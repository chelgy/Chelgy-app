#!/usr/bin/env python3
"""
SONG STUDIO — mix a session's stems into one track.

  N stems + a level and a pan for each  →  one mix

Runs on the pod, same conventions as render_song.py and separate.py.

  export SUPABASE_SERVICE_KEY=...
  python mix_session.py --session <uuid> --user <uuid> --stems '[{...}]'

Deliberately NOT a mastering pass. Mixing is per-stem and iterative — you change
one level and listen again — while mastering is one pass over the finished thing.
Bundling them would re-master on every level tweak, which is slow and sounds
worse. Master is its own step, reading the mix this produces.
"""

import os, sys, json, argparse, subprocess, tempfile, datetime
import requests

SUPABASE_URL = os.environ.get("SUPABASE_URL", "https://yuzvpmxbtjpqtapborhr.supabase.co")
KEY = (os.environ.get("SUPABASE_SERVICE_KEY") or "").strip()
H = {"apikey": KEY, "Authorization": "Bearer " + KEY}

BUCKET = "sessions"

# Sensible starting points per role, in dB relative to the mix. Only used when
# the caller sends no explicit level — the person's own faders always win.
#
# The lead sits forward because that is what a listener follows. Drums and bass
# anchor without competing with it. These are a starting mix, not a mastering
# decision, and they are all inside a few dB of each other on purpose: big
# default offsets make a mix that sounds "produced" and impossible to adjust.
DEFAULT_DB = {
    "lead": 1.5, "backing": -4.0, "adlib": -6.0,
    "drums": -1.0, "bass": -1.5, "keys": -3.0,
    "guitar": -3.0, "fx": -6.0, "other": -3.0,
    "instrumental": -1.0, "mix": 0.0, "master": 0.0,
}
# A little width where width helps, dead centre where it doesn't. Lead, bass and
# drums stay centred: moving a lead vocal off centre is a effect, not a mix, and
# panned bass loses power on a mono system (which is most phone speakers).
DEFAULT_PAN = {"backing": 0.25, "adlib": -0.3, "keys": 0.2, "guitar": -0.2, "fx": 0.35}


# Where the mix is allowed to peak. Not a loudness target — mastering sets that.
# This only stops the sum of several stems clipping before anyone hears it.
CEILING_DBTP = -1.0


def _true_peak(path):
    """True peak in dBTP via one loudnorm analysis pass, or None if unreadable."""
    import re as _re
    try:
        r = subprocess.run(
            ["ffmpeg", "-hide_banner", "-nostats", "-i", path, "-af",
             "loudnorm=print_format=json", "-f", "null", "-"],
            capture_output=True, text=True, timeout=600)
        m = _re.findall(r"\{[^{}]*\"input_tp\"[\s\S]*?\}", r.stderr)
        return float(json.loads(m[-1])["input_tp"]) if m else None
    except Exception:
        return None


def sh(*cmd):
    r = subprocess.run(cmd, capture_output=True, text=True)
    if r.returncode:
        raise RuntimeError(" ".join(cmd[:3]) + " failed:\n" + (r.stderr or "")[-900:])
    return r


def say(msg):
    print("\033[1m▸ %s\033[0m" % msg, flush=True)


def sign(path, seconds=3600):
    r = requests.post(
        "%s/storage/v1/object/sign/%s/%s" % (SUPABASE_URL, BUCKET, path),
        headers={**H, "Content-Type": "application/json"},
        json={"expiresIn": seconds}, timeout=120)
    r.raise_for_status()
    return SUPABASE_URL + "/storage/v1" + r.json()["signedURL"]


def fetch_to(url, dst):
    r = requests.get(url, timeout=900, stream=True)
    r.raise_for_status()
    with open(dst, "wb") as f:
        for chunk in r.iter_content(1 << 20):
            if chunk:
                f.write(chunk)
    return dst


def duration_of(path):
    try:
        r = subprocess.run(
            ["ffprobe", "-v", "error", "-show_entries", "format=duration",
             "-of", "default=noprint_wrappers=1:nokey=1", path],
            capture_output=True, text=True, timeout=120)
        return round(float(r.stdout.strip()), 2)
    except Exception:
        return None


def upload(local, user_id, session_id, name, content_type="audio/wav"):
    path = "%s/%s/%s" % (user_id, session_id, name)
    with open(local, "rb") as f:
        r = requests.post(
            "%s/storage/v1/object/%s/%s" % (SUPABASE_URL, BUCKET, path),
            headers={**H, "x-upsert": "true", "Content-Type": content_type},
            data=f, timeout=1800)
    r.raise_for_status()
    return path


def register(user_id, session_id, role, label, storage_path, duration, meta):
    row = {
        "user_id": user_id, "session_id": session_id, "role": role,
        "source": "mixed", "parent_id": None, "label": label,
        "storage_path": storage_path, "duration": duration, "meta": meta or {},
    }
    r = requests.post(SUPABASE_URL + "/rest/v1/song_stems",
                      headers={**H, "Content-Type": "application/json",
                               "Prefer": "return=representation"},
                      json=row, timeout=120)
    r.raise_for_status()
    return r.json()[0]


def main():
    p = argparse.ArgumentParser()
    p.add_argument("--session", required=True)
    p.add_argument("--user", required=True)
    p.add_argument("--stems", default="",
                   help='JSON list: [{"id","storage_path","role","db","pan","mute"}]')
    p.add_argument("--label", default="")
    p.add_argument("--no-upload", action="store_true")
    a = p.parse_args()

    if not KEY:
        raise SystemExit("SUPABASE_SERVICE_KEY is not set.")

    try:
        stems = json.loads(a.stems) if a.stems else []
    except Exception as e:
        raise SystemExit("couldn't read --stems: %s" % e)

    stems = [s for s in stems if s.get("storage_path") and not s.get("mute")]
    if not stems:
        raise SystemExit("nothing to mix — every stem was muted or missing a file.")
    if len(stems) > 24:
        raise SystemExit("%d stems is more than this mixes at once (24)." % len(stems))

    work = tempfile.mkdtemp(prefix="mix-")
    say("fetching %d stem(s)" % len(stems))
    locals_ = []
    for i, st in enumerate(stems):
        dst = os.path.join(work, "in%02d.audio" % i)
        fetch_to(sign(st["storage_path"]), dst)
        role = st.get("role") or "other"
        db = float(st["db"]) if st.get("db") is not None else DEFAULT_DB.get(role, -3.0)
        pan = float(st["pan"]) if st.get("pan") is not None else DEFAULT_PAN.get(role, 0.0)
        db = max(-40.0, min(12.0, db))
        pan = max(-1.0, min(1.0, pan))
        locals_.append({"path": dst, "role": role, "db": db, "pan": pan,
                        "label": st.get("label") or role})
        print("  %-12s %+5.1f dB  pan %+.2f" % (role, db, pan))

    say("mixing")
    # One filter graph, one pass. Each input is levelled, placed, and then all of
    # them are summed — amix rather than a chain of overlays so nothing is
    # attenuated twice.
    #
    # normalize=0 is load-bearing. amix's default divides every input by the
    # number of inputs, so adding a quiet ad-lib would drop the whole mix by a
    # third and every fader the person set would mean something different than
    # it did a moment ago.
    parts, labels = [], []
    for i, st in enumerate(locals_):
        # pan= places a mono or stereo source in the field explicitly. Computed
        # as equal-gain rather than equal-power: these are stems that already sit
        # together, and equal-power would lift anything panned hard.
        l = (1.0 - st["pan"]) / 2.0 + 0.5 * (1.0 - abs(st["pan"]))
        r = (1.0 + st["pan"]) / 2.0 + 0.5 * (1.0 - abs(st["pan"]))
        l, r = min(1.0, l), min(1.0, r)
        parts.append(
            "[%d:a]aformat=sample_fmts=fltp:sample_rates=44100:channel_layouts=stereo,"
            "volume=%.2fdB,pan=stereo|c0=%.3f*c0|c1=%.3f*c1[a%d]" % (i, st["db"], l, r, i))
        labels.append("[a%d]" % i)

    # duration=longest so a short ad-lib doesn't truncate the song. dropout
    # transition 0 so a stem ending does not duck everything still playing.
    parts.append("%samix=inputs=%d:duration=longest:normalize=0:dropout_transition=0[mixed]"
                 % ("".join(labels), len(labels)))
    raw_wav = os.path.join(work, "raw.wav")
    cmd = ["ffmpeg", "-y", "-v", "error"]
    for st in locals_:
        cmd += ["-i", st["path"]]
    cmd += ["-filter_complex", ";".join(parts) + ";[mixed]anull[out]", "-map", "[out]",
            "-ar", "44100", "-ac", "2", "-c:a", "pcm_s16le", raw_wav]
    sh(*cmd)

    # HEADROOM, NOT A LIMITER.
    #
    # The first version put an alimiter on the sum. It stopped the clipping, and
    # it also pulled a test mix down 5 dB and pumped on anything dense — a
    # limiter is a mastering decision, and mixing must not change the character
    # of takes the person already approved. So: measure the true peak, and if it
    # is over the ceiling, apply ONE static gain trim. Every fader keeps the
    # relationship it had; the whole thing just sits a little lower.
    tp = _true_peak(raw_wav)
    out_wav = raw_wav
    if tp is not None and tp > CEILING_DBTP:
        trim = CEILING_DBTP - tp
        out_wav = os.path.join(work, "mix.wav")
        print("  peak %.1f dBTP — trimming %.1f dB for headroom" % (tp, trim))
        sh("ffmpeg", "-y", "-v", "error", "-i", raw_wav, "-af", "volume=%.2fdB" % trim,
           "-ar", "44100", "-ac", "2", "-c:a", "pcm_s16le", out_wav)
    elif tp is not None:
        print("  peak %.1f dBTP — no trim needed" % tp)

    dur = duration_of(out_wav)
    print("  %.1fs" % (dur or 0))

    if a.no_upload:
        print("\n(skipped upload) %s" % out_wav)
        return

    say("uploading the mix")
    stamp = datetime.datetime.now().strftime("%Y%m%d-%H%M%S")
    path = upload(out_wav, a.user, a.session, "mix-%s.wav" % stamp)
    stem = register(a.user, a.session, "mix", a.label or ("Mix — " + stamp),
                    path, dur,
                    {"stems": [{"role": s["role"], "db": s["db"], "pan": s["pan"]} for s in locals_],
                     "count": len(locals_)})
    print("  %s" % path)
    print("\n✓ mix in the session (%s)" % stem["id"])


if __name__ == "__main__":
    main()
