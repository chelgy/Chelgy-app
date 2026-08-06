#!/usr/bin/env python3
"""
SONG STUDIO — split a track into stems.

  a finished track  →  demucs  →  vocals / drums / bass / other

Runs on the pod, same conventions as render_song.py: pulled fresh from the app,
service key and ids from the environment, every stage prints what it did.

  export SUPABASE_SERVICE_KEY=...
  export USER_ID=...  SESSION_ID=...
  python separate.py --source https://…/track.mp3

Why demucs and not the RVC repo's own separator: pymss is deliberately excluded
from the song image — it publishes no wheel below Python 3.12 and the image runs
3.10. htdemucs is the better separator anyway, and it is the one thing here that
genuinely needs the GPU.
"""

import os, sys, json, glob, argparse, subprocess, tempfile, datetime
import requests

SUPABASE_URL = os.environ.get("SUPABASE_URL", "https://yuzvpmxbtjpqtapborhr.supabase.co")
KEY = (os.environ.get("SUPABASE_SERVICE_KEY") or "").strip()
H = {"apikey": KEY, "Authorization": "Bearer " + KEY}

BUCKET = "sessions"

# demucs names its outputs; these are the roles they map to in song_stems. The
# CHECK constraint on that column is the source of truth — a role missing there
# is a 400 at insert time, so this table must stay a subset of it.
ROLE_OF = {
    "vocals": "lead",
    "drums":  "drums",
    "bass":   "bass",
    "other":  "keys",
}
# The order they are registered in, so the session lists them the way a person
# reads a mix rather than the order demucs happens to write files.
ORDER = ["vocals", "drums", "bass", "other"]


def sh(*cmd):
    r = subprocess.run(cmd, capture_output=True, text=True)
    if r.returncode:
        raise RuntimeError(" ".join(cmd[:3]) + " failed:\n" + (r.stderr or "")[-800:])
    return r


def say(msg):
    print("\033[1m▸ %s\033[0m" % msg, flush=True)


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


def upload(local, user_id, session_id, name):
    """Into the sessions bucket, at the layout every storage policy expects:
    sessions/<uid>/<session_id>/<file>. First segment is the owner."""
    path = "%s/%s/%s" % (user_id, session_id, name)
    with open(local, "rb") as f:
        r = requests.post(
            "%s/storage/v1/object/%s/%s" % (SUPABASE_URL, BUCKET, path),
            headers={**H, "x-upsert": "true", "Content-Type": "audio/wav"},
            data=f, timeout=1800)
    r.raise_for_status()
    return path


def register(user_id, session_id, role, label, storage_path, duration, parent_id, meta):
    """
    user_id is sent EXPLICITLY. The column is NOT NULL and the RLS policy checks
    auth.uid() = user_id — omitting it is exactly what made every voice_clips
    insert fail on 5 Aug. This runs with the service key so RLS is bypassed, but
    the column still has to be right or the row is wrong for everyone reading it.
    """
    row = {
        "user_id": user_id,
        "session_id": session_id,
        "role": role,
        "source": "separated",
        "parent_id": parent_id,
        "label": label,
        "storage_path": storage_path,
        "duration": duration,
        "meta": meta or {},
    }
    r = requests.post(SUPABASE_URL + "/rest/v1/song_stems",
                      headers={**H, "Content-Type": "application/json",
                               "Prefer": "return=representation"},
                      json=row, timeout=120)
    r.raise_for_status()
    return r.json()[0]


def main():
    p = argparse.ArgumentParser()
    p.add_argument("--source", required=True, help="URL of the track to split")
    p.add_argument("--user-id", default=os.environ.get("USER_ID", ""))
    p.add_argument("--session-id", default=os.environ.get("SESSION_ID", ""))
    p.add_argument("--parent-id", default=os.environ.get("PARENT_STEM_ID", "") or None,
                   help="the stem this was split FROM, so lineage survives")
    p.add_argument("--label", default="", help="name of the source track")
    p.add_argument("--model", default=os.environ.get("DEMUCS_MODEL", "htdemucs"))
    p.add_argument("--two-stems", default="",
                   help="only split this one out (e.g. vocals) — faster, half the files")
    p.add_argument("--no-upload", action="store_true")
    a = p.parse_args()

    if not KEY:
        raise SystemExit("SUPABASE_SERVICE_KEY is not set.")
    if not a.user_id or not a.session_id:
        raise SystemExit("need --user-id and --session-id (or USER_ID / SESSION_ID).")

    work = tempfile.mkdtemp(prefix="sep-")
    src = os.path.join(work, "source.audio")

    say("fetching the track")
    fetch_to(a.source, src)
    dur = duration_of(src)
    print("  %s%s" % (a.label or "track", (" — %.1fs" % dur) if dur else ""))

    # A predictable wav rather than whatever container came in. demucs reads most
    # formats, but a decode failure halfway through a GPU job is expensive and
    # this makes it fail here instead, in a second, with a clear message.
    say("preparing audio")
    wav = os.path.join(work, "source.wav")
    sh("ffmpeg", "-y", "-v", "error", "-i", src,
       "-ar", "44100", "-ac", "2", "-c:a", "pcm_s16le", wav)

    say("separating (%s)" % a.model)
    out_dir = os.path.join(work, "out")
    cmd = [sys.executable, "-m", "demucs", "-n", a.model, "-o", out_dir,
           "--filename", "{stem}.{ext}"]
    if a.two_stems:
        cmd += ["--two-stems", a.two_stems]
    cmd.append(wav)
    r = subprocess.run(cmd, capture_output=True, text=True)
    if r.returncode:
        raise SystemExit("demucs failed:\n" + (r.stderr or "")[-1200:])

    produced = {}
    for f in glob.glob(os.path.join(out_dir, "**", "*.wav"), recursive=True):
        produced[os.path.splitext(os.path.basename(f))[0]] = f
    if not produced:
        raise SystemExit("demucs produced no stems — nothing to upload.")
    print("  got: " + ", ".join(sorted(produced)))

    stamp = datetime.datetime.now().strftime("%Y%m%d-%H%M%S")
    base = (a.label or "track").rsplit(".", 1)[0]

    registered = []
    for name in ORDER + [k for k in sorted(produced) if k not in ORDER]:
        local = produced.get(name)
        if not local:
            continue
        role = ROLE_OF.get(name, "other")
        fname = "%s-%s-%s.wav" % (name, stamp, os.urandom(3).hex())
        if a.no_upload:
            print("  (skipped upload) %s -> %s" % (name, role))
            continue
        say("uploading %s" % name)
        path = upload(local, a.user_id, a.session_id, fname)
        stem = register(a.user_id, a.session_id, role,
                        "%s — %s" % (base, name), path, duration_of(local),
                        a.parent_id,
                        {"separated_from": a.label or a.source, "model": a.model,
                         "demucs_stem": name})
        registered.append((name, role, stem["id"]))
        print("  %s -> %s" % (path, role))

    print("\n✓ %d stem(s) in the session" % len(registered))
    for name, role, sid in registered:
        print("   %-8s %-6s %s" % (name, role, sid))


if __name__ == "__main__":
    main()
