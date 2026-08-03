#!/usr/bin/env bash
# ═══════════════════════════════════════════════════════════════════════════
# SONG STUDIO — train a voice model
#
# Runs on a RunPod GPU pod. No Gradio, no web UI, no browser. One command,
# then walk away.
#
#   export SUPABASE_SERVICE_KEY="eyJ..."      # Supabase → Settings → API → service_role
#   export PROFILE_ID="....-....-...."        # from the voice_profiles table
#   bash train-voice.sh
#
# Stages, in order:
#   0  environment + assets      ~10 min first run, cached after
#   1  fetch the clips           ~1 min
#   2  slice and clean           ~2 min
#   3  extract pitch (RMVPE)     ~3 min
#   4  extract HuBERT features   ~3 min
#   5  train                     ~40 min
#   6  build the retrieval index ~2 min
#   7  upload the model back     ~1 min
# ═══════════════════════════════════════════════════════════════════════════
set -euo pipefail

SUPABASE_URL="${SUPABASE_URL:-https://yuzvpmxbtjpqtapborhr.supabase.co}"
EXP="${EXP:-voice}"
SR="48k"; SR_HZ=48000
EPOCHS="${EPOCHS:-200}"
BATCH="${BATCH:-8}"
ROOT=/workspace/rvc

say(){ printf "\n\033[1m▸ %s\033[0m\n" "$*"; }
die(){ printf "\n\033[31m✗ %s\033[0m\n" "$*" >&2; exit 1; }

[ -n "${SUPABASE_SERVICE_KEY:-}" ] || die "SUPABASE_SERVICE_KEY is not set."
[ -n "${PROFILE_ID:-}" ]          || die "PROFILE_ID is not set."
nvidia-smi -L >/dev/null 2>&1     || die "No GPU visible. This needs a GPU pod."

# ── 0 · ENVIRONMENT ────────────────────────────────────────────────────────
say "Stage 0/7 — environment"
if [ ! -d "$ROOT" ]; then
  apt-get update -qq && apt-get install -y -qq ffmpeg unzip >/dev/null
  git clone -q --depth 1 https://github.com/RVC-Project/Retrieval-based-Voice-Conversion-WebUI.git "$ROOT"
fi
cd "$ROOT"

if [ ! -f .deps-done ]; then
  pip install -q --upgrade pip
  # cu128 list matches the CUDA on current RunPod images. If torch fails to see
  # the GPU later, this is the line to change.
  pip install -q -r requirments_cu128_py312.txt || pip install -q -r requirments_cu118_py312.txt
  pip install -q --upgrade huggingface_hub requests soundfile
  touch .deps-done
fi

# Asset paths come from the repo's own README, not from older guides — this
# version keeps HuBERT as a transformers folder, not the single .pt file that
# most RVC tutorials still tell you to download.
if [ ! -f assets/hubert_base/pytorch_model.bin ]; then
  say "Downloading model assets (one time, a few GB)"
  hf download lj1995/VoiceConversionWebUI --revision main --include "hubert_base/*" --local-dir assets -q
  hf download lj1995/VoiceConversionWebUI rmvpe.pt --revision main --local-dir assets/rmvpe -q
  hf download lj1995/VoiceConversionWebUI --revision main --include "pretrained_v2/*" --local-dir assets -q
  hf download lj1995/VoiceConversionWebUI mute.zip --revision main --local-dir .model-downloads -q
  python -m zipfile -e .model-downloads/mute.zip logs
fi
[ -f assets/pretrained_v2/f0G${SR}.pth ] || die "Missing assets/pretrained_v2/f0G${SR}.pth"
[ -d logs/mute ]                          || die "Missing logs/mute — training needs the silence samples."

# ── 1 · FETCH THE CLIPS ────────────────────────────────────────────────────
say "Stage 1/7 — fetching clips for profile $PROFILE_ID"
RAW="$ROOT/dataset_raw/$PROFILE_ID"
rm -rf "$RAW"; mkdir -p "$RAW"

SUPABASE_URL="$SUPABASE_URL" SUPABASE_SERVICE_KEY="$SUPABASE_SERVICE_KEY" \
PROFILE_ID="$PROFILE_ID" RAW="$RAW" python - <<'PY'
import os, requests, sys
url=os.environ["SUPABASE_URL"]; key=os.environ["SUPABASE_SERVICE_KEY"]
pid=os.environ["PROFILE_ID"];  raw=os.environ["RAW"]
H={"apikey":key,"Authorization":"Bearer "+key}

r=requests.get(f"{url}/rest/v1/voice_clips",
               params={"select":"take_id,section,storage_path,duration","profile_id":f"eq.{pid}","order":"seq"},
               headers=H, timeout=60)
r.raise_for_status()
clips=r.json()
if not clips: sys.exit("No clips found for that profile id.")

total=0
for c in clips:
    d=requests.get(f"{url}/storage/v1/object/voice/{c['storage_path']}", headers=H, timeout=180)
    if d.status_code!=200:
        print(f"  skip {c['take_id']}: storage {d.status_code}"); continue
    open(os.path.join(raw, os.path.basename(c["storage_path"])),"wb").write(d.content)
    total+=float(c["duration"] or 0)

print(f"  {len(clips)} clips, {total/60:.1f} minutes")
# Below ten minutes RVC produces something that works but audibly isn't the
# person. Better to stop here than burn an hour of GPU finding that out.
if total < 600: sys.exit(f"Only {total/60:.1f} min of audio. Need 10 minutes minimum.")
PY

# ── 2 · SLICE AND CLEAN ────────────────────────────────────────────────────
# Splits everything into ~3s pieces, resamples, and normalises. The audio
# already went through a global gain pass in the browser, so this stage is
# doing the slicing work rather than rescuing levels.
say "Stage 2/7 — slicing"
python train/preprocess.py "$RAW" $SR_HZ 8 "$ROOT/logs/$EXP" False 3.0

# ── 3 · PITCH ──────────────────────────────────────────────────────────────
# RMVPE on GPU. This is the stage that decides how well sung notes survive.
say "Stage 3/7 — pitch extraction"
python train/dataset/extract_f0.py cuda 1 0 0 "$ROOT/logs/$EXP" True

# ── 4 · FEATURES ───────────────────────────────────────────────────────────
say "Stage 4/7 — HuBERT features"
python train/dataset/extract_hubert_feature.py cuda:0 1 0 "$ROOT/logs/$EXP" v2 True

# ── 5 · FILELIST ───────────────────────────────────────────────────────────
# The web UI builds this in Python and it is the easiest part of the pipeline
# to get subtly wrong: it must be the intersection of all four output folders,
# plus two mute lines, or training dies partway through with a confusing error.
say "Stage 5/7 — building the file list"
EXP="$EXP" ROOT="$ROOT" python - <<'PY'
import os, random
root=os.environ["ROOT"]; exp=os.environ["EXP"]
d=f"{root}/logs/{exp}"
gt, feat = f"{d}/0_gt_wavs", f"{d}/3_feature768"
f0, f0n  = f"{d}/2a_f0",     f"{d}/2b-f0nsf"
for p in (gt,feat,f0,f0n):
    if not os.path.isdir(p): raise SystemExit(f"missing {p} — an earlier stage failed")
names = set.intersection(*[{n.split(".")[0] for n in os.listdir(p)} for p in (gt,feat,f0,f0n)])
if not names: raise SystemExit("no usable training files after feature extraction")
opt=[f"{gt}/{n}.wav|{feat}/{n}.npy|{f0}/{n}.wav.npy|{f0n}/{n}.wav.npy|0" for n in names]
for _ in range(2):
    opt.append(f"{root}/logs/mute/0_gt_wavs/mute48k.wav|{root}/logs/mute/3_feature768/mute.npy|"
               f"{root}/logs/mute/2a_f0/mute.wav.npy|{root}/logs/mute/2b-f0nsf/mute.wav.npy|0")
random.shuffle(opt)
open(f"{d}/filelist.txt","w",encoding="utf8").write("\n".join(opt))
print(f"  {len(names)} training slices")
PY

# ── 6 · TRAIN ──────────────────────────────────────────────────────────────
say "Stage 6/7 — training ($EPOCHS epochs, ~40 min)"
python train/train.py -e "$EXP" -sr $SR -f0 1 -bs $BATCH -g 0 \
  -te $EPOCHS -se 50 \
  -pg assets/pretrained_v2/f0G${SR}.pth -pd assets/pretrained_v2/f0D${SR}.pth \
  -l 1 -c 0 -sw 1 -v v2

say "Stage 6b/7 — retrieval index"
python train/train_index.py "$EXP" v2 "$ROOT/assets/indices" 8

# ── 7 · SHIP IT ────────────────────────────────────────────────────────────
# RVC emits two artefacts and needs both at inference. Uploading only the .pth
# gives you a model that loads fine and sounds noticeably less like the person.
say "Stage 7/7 — uploading the model"
SUPABASE_URL="$SUPABASE_URL" SUPABASE_SERVICE_KEY="$SUPABASE_SERVICE_KEY" \
PROFILE_ID="$PROFILE_ID" ROOT="$ROOT" EXP="$EXP" python - <<'PY'
import os, glob, requests, sys, datetime
url=os.environ["SUPABASE_URL"]; key=os.environ["SUPABASE_SERVICE_KEY"]
pid=os.environ["PROFILE_ID"];  root=os.environ["ROOT"]; exp=os.environ["EXP"]
H={"apikey":key,"Authorization":"Bearer "+key}

pth = sorted(glob.glob(f"{root}/assets/weights/{exp}*.pth"), key=os.path.getmtime)
idx = sorted(glob.glob(f"{root}/assets/indices/*{exp}*.index"), key=os.path.getmtime) \
   or sorted(glob.glob(f"{root}/logs/{exp}/*.index"), key=os.path.getmtime)
if not pth: sys.exit("no .pth produced — training did not finish")
if not idx: print("  warning: no .index produced; similarity will be lower")

prof=requests.get(f"{url}/rest/v1/voice_profiles", params={"select":"user_id","id":f"eq.{pid}"},
                  headers=H, timeout=30).json()
if not prof: sys.exit("profile not found")
uid=prof[0]["user_id"]

def put(local, name):
    path=f"{uid}/{pid}/model/{name}"
    r=requests.post(f"{url}/storage/v1/object/voice/{path}",
                    headers={**H,"x-upsert":"true","Content-Type":"application/octet-stream"},
                    data=open(local,"rb"), timeout=600)
    r.raise_for_status(); return path

model_path = put(pth[-1], "model.pth")
index_path = put(idx[-1], "model.index") if idx else None
print(f"  {model_path}")

r=requests.patch(f"{url}/rest/v1/voice_profiles", params={"id":f"eq.{pid}"},
    headers={**H,"Content-Type":"application/json"},
    json={"status":"ready","model_path":model_path,"index_path":index_path,
          "trained_at":datetime.datetime.now(datetime.timezone.utc).isoformat(),
          "train_error":None})
r.raise_for_status()
print("  profile marked ready")
PY

say "Done. The voice model is in the account."
