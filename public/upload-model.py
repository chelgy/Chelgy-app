#!/usr/bin/env python3
"""
Upload a trained voice model to Supabase and mark the profile ready.

Recovers a training run whose stage 7 failed. Does NOT retrain — it only finds
the files already on disk and ships them.

  export SUPABASE_URL=...  SUPABASE_SERVICE_KEY=...  PROFILE_ID=...
  cd /workspace/rvc && python3 upload-model.py
"""

import os, sys, glob, datetime, requests

URL = os.environ.get("SUPABASE_URL", "").rstrip("/")
KEY = (os.environ.get("SUPABASE_SERVICE_KEY") or "").strip()
PID = (os.environ.get("PROFILE_ID") or "").strip()

for name, val in (("SUPABASE_URL", URL), ("SUPABASE_SERVICE_KEY", KEY), ("PROFILE_ID", PID)):
    if not val:
        sys.exit(f"✗ {name} is not set.")

H = {"apikey": KEY, "Authorization": "Bearer " + KEY}

# Newest by modification time. A run that saved at epoch 150 and again at 200
# leaves both behind, and the later one is the trained-for-longer model.
pths = sorted(glob.glob("assets/weights/*.pth"), key=os.path.getmtime)
idxs = sorted(glob.glob("assets/indices/*.index") + glob.glob("logs/voice/*.index"),
              key=os.path.getmtime)

if not pths:
    sys.exit("✗ No .pth in assets/weights — training didn't finish, or you're in the wrong folder.")

print("model:", pths[-1])
print("index:", idxs[-1] if idxs else "NONE — similarity will be lower without it")

prof = requests.get(URL + "/rest/v1/voice_profiles",
                    params={"select": "user_id", "id": "eq." + PID},
                    headers=H, timeout=30).json()
if not prof:
    sys.exit("✗ No profile with that id.")
uid = prof[0]["user_id"]


def put(local, name):
    key = f"{uid}/{PID}/model/{name}"
    with open(local, "rb") as fh:
        r = requests.post(
            f"{URL}/storage/v1/object/voice/{key}",
            # octet-stream, not audio. The bucket originally allowed audio MIME
            # types only, which is exactly why the first upload came back 400.
            headers={**H, "x-upsert": "true", "Content-Type": "application/octet-stream"},
            data=fh, timeout=900)
    if r.status_code >= 400:
        sys.exit(f"✗ Upload of {name} failed ({r.status_code}): {r.text[:300]}")
    print(f"  uploaded {key}  ({os.path.getsize(local)//1048576} MB)")
    return key


model_path = put(pths[-1], "model.pth")
index_path = put(idxs[-1], "model.index") if idxs else None

r = requests.patch(URL + "/rest/v1/voice_profiles",
                   params={"id": "eq." + PID},
                   headers={**H, "Content-Type": "application/json"},
                   json={"status": "ready",
                         "model_path": model_path,
                         "index_path": index_path,
                         "train_error": None,
                         "trained_at": datetime.datetime.now(datetime.timezone.utc).isoformat()},
                   timeout=30)
if r.status_code >= 400:
    sys.exit(f"✗ Couldn't mark the profile ready ({r.status_code}): {r.text[:300]}")

print("\n✓ READY — the voice model is in the account.")
