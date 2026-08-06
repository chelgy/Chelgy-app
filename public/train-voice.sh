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
SETUP_ONLY="${SETUP_ONLY:-0}"
EXP="${EXP:-voice}"
SR="48k"; SR_HZ=48000
EPOCHS="${EPOCHS:-200}"
BATCH="${BATCH:-8}"
# Honours RVC_ROOT so a BAKED image can be used, and falls back to the old
# interactive path when it is unset — so a pod running the previous way is
# completely unaffected by this.
ROOT="${RVC_ROOT:-/workspace/rvc}"

say(){ printf "\n\033[1m▸ %s\033[0m\n" "$*"; }
die(){ printf "\n\033[31m✗ %s\033[0m\n" "$*" >&2; fail_and_stop "$*"; exit 1; }

# ── STATUS + SELF-TERMINATE ──────────────────────────────────────────────────
# Neither existed here before. A failed run left the pod up forever: nothing told
# the app what happened, so the card span at "training" indefinitely, and the
# "one pod per profile" check in voice-train.js saw the dead pod and refused
# every retry. The machine billed the whole time. That is the single most
# expensive gap in this pipeline and it cost real money on 5 and 6 August.
#
# Mirrors train-diffsinger.sh deliberately — same status file convention, same
# terminate call — so there is one pattern to understand rather than two.
CURRENT_STAGE="startup"
STATUS_PATH=""    # set once the owner is known; report() no-ops until then

report() { # report <stage-number> <label> [error]
  [ -n "$STATUS_PATH" ] || return 0
  local body
  body=$(printf '{"stage":%s,"label":"%s","error":%s,"at":"%s"}' \
    "$1" "$2" "$(if [ -n "${3:-}" ]; then printf '"%s"' "$(printf '%s' "$3" | tr -d '"' | cut -c1-400)"; else printf 'null'; fi)" \
    "$(date -u +%Y-%m-%dT%H:%M:%SZ)")
  curl -fsSL -X POST "$SUPABASE_URL/storage/v1/object/voice/$STATUS_PATH" \
    -H "apikey: $SUPABASE_SERVICE_KEY" -H "Authorization: Bearer $SUPABASE_SERVICE_KEY" \
    -H "x-upsert: true" -H "Content-Type: application/json" \
    --data "$body" >/dev/null 2>&1 || true
}

terminate_self() {
  # NOT RUNPOD_API_KEY alone: RunPod injects a pod-scoped key under that exact
  # name, and a pod-scoped key cannot delete pods — every self-terminate comes
  # back 403 while the machine keeps billing. song-worker.js documents the same
  # trap.
  local key="${CHELGY_RUNPOD_KEY:-${RUNPOD_API_KEY:-}}"
  [ -n "$key" ] && [ -n "${RUNPOD_POD_ID:-}" ] || { echo "(no pod credentials — not self-terminating)"; return 0; }
  echo "removing this pod (${RUNPOD_POD_ID})"
  curl -fsSL -X DELETE "https://rest.runpod.io/v1/pods/${RUNPOD_POD_ID}" \
    -H "Authorization: Bearer $key" >/dev/null 2>&1 || echo "(terminate call failed — the reaper will clean up)"
}

fail_and_stop() {
  # Marks the failure as handled so the EXIT trap does not sleep and terminate a
  # SECOND time — which would double the wait and bill an extra half hour on
  # every failed run.
  HANDLED=1
  report 0 "failed" "stopped at: ${CURRENT_STAGE:-startup} — $1"
  echo "[voice] FAILED at ${CURRENT_STAGE:-startup}: $1"
  # Thirty minutes, not three hours. An RVC train is forty minutes end to end,
  # so half an hour is long enough to read the log and short enough that a
  # failure at 2am does not bill until morning.
  echo "[voice] leaving pod up 30 MINUTES so the log survives; then self-terminating"
  sleep 1800
  terminate_self
}

# Catches what die() cannot: an unexpected exit, a killed process, a bug in this
# script. Without it the pod simply stays up.
on_exit() {
  local code=$?
  if [ "$code" -ne 0 ] && [ "${FINISHED:-0}" != "1" ] && [ "${HANDLED:-0}" != "1" ]; then
    echo "[voice] exiting with code $code at ${CURRENT_STAGE:-unknown}"
    report 0 "failed" "exited with code $code at ${CURRENT_STAGE:-unknown}"
    sleep 1800
    terminate_self
  fi
}
trap on_exit EXIT

if [ "$SETUP_ONLY" != "1" ]; then
  [ -n "${SUPABASE_SERVICE_KEY:-}" ] || die "SUPABASE_SERVICE_KEY is not set."
  [ -n "${PROFILE_ID:-}" ]          || die "PROFILE_ID is not set."
fi
nvidia-smi -L >/dev/null 2>&1     || die "No GPU visible. This needs a GPU pod."

# Who owns this profile — status.json lives under their folder, and the same
# path voice-train.js clears before launching.
if [ "$SETUP_ONLY" != "1" ]; then
  OWNER_UID=$(curl -fsSL "$SUPABASE_URL/rest/v1/voice_profiles?select=user_id&id=eq.$PROFILE_ID" \
    -H "apikey: $SUPABASE_SERVICE_KEY" -H "Authorization: Bearer $SUPABASE_SERVICE_KEY" \
    | sed -n 's/.*"user_id":"\([^"]*\)".*/\1/p')
  [ -n "$OWNER_UID" ] || die "profile $PROFILE_ID not found"
  STATUS_PATH="$OWNER_UID/$PROFILE_ID/model/status.json"
  report 0 "starting up"
fi

# ── PYTHON ─────────────────────────────────────────────────────────────────
# The pod is launched with `bash -lc "curl … | bash"`. That inner bash is NOT a
# login shell, so whatever puts conda on PATH in ~/.bashrc never runs and bare
# `python` does not exist — the exact failure on 5 Aug, four seconds into stage
# 0, which read as "wrong pod template" when the template was fine. Resolve the
# interpreter instead of assuming it, and put its directory on PATH so pip and
# the `hf` CLI resolve too.
PY_BIN=""
for c in python python3 /opt/conda/bin/python /opt/conda/bin/python3 \
         /usr/local/bin/python3 /usr/bin/python3; do
  if command -v "$c" >/dev/null 2>&1; then PY_BIN="$(command -v "$c")"; break; fi
done
[ -n "$PY_BIN" ] || die "No python interpreter on this image. Checked python, python3, /opt/conda, /usr/local, /usr/bin."
export PATH="$(dirname "$PY_BIN"):$PATH"
export PY_BIN
printf "  python: %s (%s)\n" "$PY_BIN" "$("$PY_BIN" --version 2>&1)"
# pip the same way — `pip` alone is missing on images that only ship `pip3`,
# and `python -m pip` is the one form guaranteed to work wherever python does.
PIP="$PY_BIN -m pip"

# ── 0 · ENVIRONMENT ────────────────────────────────────────────────────────
say "Stage 0/7 — environment"
if [ ! -d "$ROOT" ]; then
  # rubberband is for the render side: it time-stretches the generated beat
  # onto the vocal with better transients than the ffmpeg atempo fallback.
  apt-get update -qq && apt-get install -y -qq ffmpeg unzip rubberband-cli >/dev/null
  git clone -q --depth 1 https://github.com/RVC-Project/Retrieval-based-Voice-Conversion-WebUI.git "$ROOT"
fi
cd "$ROOT"

if [ ! -f .deps-done ]; then
  $PIP install -q --upgrade pip
  # This file does NOT install torch. Upstream says so in its own header and
  # installs torch separately — which means torch has always come from the pod
  # template, and the CUDA assertion below is the only thing that has ever
  # actually guarded it.
  #
  # cu128, not cu118. The two files are identical apart from one block: cu118
  # pins nvidia-cudnn-cu11==8.9.5.29 for ONNX Runtime, and PyPI no longer
  # carries that version. It is permanently dead, not temporarily missing.
  # "Use cu118" is a rule about which torch build the template ships, and this
  # file has nothing to do with torch.
  #
  # pymss is the MSST separation backend and publishes no wheel below Python
  # 3.12, so on a 3.10/3.11 template it blocks the whole install. Nothing in
  # the training or render path imports it, but it is only dropped on failure
  # rather than pre-emptively, so a 3.12 pod still gets the complete set.
  $PIP install -q -r requirments_cu128_py312.txt || {
    say "retrying without pymss (needs Python 3.12; unused here)"
    grep -viE '^pymss' requirments_cu128_py312.txt > /tmp/rvc-reqs.txt
    $PIP install -q -r /tmp/rvc-reqs.txt
  }
  # Pinned, not upgraded. A blanket --upgrade pulls huggingface_hub 1.x, which
  # breaks transformers with a traceback that names transformers.
  $PIP install -q "huggingface_hub>=0.26,<1.0" requests soundfile
  # Render-time extras, so one setup leaves the pod ready for both jobs.
  $PIP install -q pyworld librosa
  touch .deps-done
fi

# Asserted, not assumed. A silent drop to CPU is the most expensive failure
# this pod has: it looks like a slow success for forty minutes.
"$PY_BIN" - <<'PY' || die "torch cannot use this GPU. Wrong pod template — relaunch on a CUDA PyTorch image, not ROCm/CPU."
import sys, torch
ok = torch.cuda.is_available()
print("  torch %s / cuda %s / %s" % (torch.__version__, torch.version.cuda,
      torch.cuda.get_device_name(0) if ok else "NO USABLE DEVICE"))
sys.exit(0 if ok else 1)
PY

# These five are read directly by the RVC code and are unset by default; unset,
# every path becomes the literal string "None". Written to a file rather than
# just exported, because the render step runs in a different shell.
mkdir -p "$ROOT/assets/weights" "$ROOT/assets/indices" "$ROOT/assets/rmvpe" \
         "$ROOT/assets/pymss_weights" "$ROOT/logs/$EXP"
cat > /workspace/rvc-env.sh <<EOF
export RVC_ROOT=$ROOT
export PYTHONPATH=$ROOT
export weight_root=$ROOT/assets/weights
export index_root=$ROOT/assets/indices
export outside_index_root=$ROOT/assets/indices
export rmvpe_root=$ROOT/assets/rmvpe
export weight_pymss_root=$ROOT/assets/pymss_weights
export SUPABASE_URL=$SUPABASE_URL
EOF
. /workspace/rvc-env.sh

# Asset paths come from the repo's own README, not from older guides — this
# version keeps HuBERT as a transformers folder, not the single .pt file that
# most RVC tutorials still tell you to download.
if [ ! -f assets/hubert_base/pytorch_model.bin ]; then
  say "Downloading model assets (one time, a few GB)"
  # No -q on these. The hf CLI's quiet flag is --quiet and has no short form,
  # so -q is an argparse error and exit code 2 — which reads exactly like a
  # failed download. Caught by the song image build on 3 Aug.
  hf download lj1995/VoiceConversionWebUI --revision main --include "hubert_base/*" --local-dir assets
  hf download lj1995/VoiceConversionWebUI rmvpe.pt --revision main --local-dir assets/rmvpe
  hf download lj1995/VoiceConversionWebUI --revision main --include "pretrained_v2/*" --local-dir assets
  hf download lj1995/VoiceConversionWebUI mute.zip --revision main --local-dir .model-downloads
  "$PY_BIN" -m zipfile -e .model-downloads/mute.zip logs
fi
[ -f assets/pretrained_v2/f0G${SR}.pth ] || die "Missing assets/pretrained_v2/f0G${SR}.pth"
[ -d logs/mute ]                          || die "Missing logs/mute — training needs the silence samples."

if [ "$SETUP_ONLY" = "1" ]; then
  say "Setup complete. Nothing was trained."
  cat <<EOF
  The pod is ready. To render a song:

    source /workspace/rvc-env.sh
    cd $ROOT && curl -sO https://chelgy.app/tune.py \
      && curl -sO https://chelgy.app/align.py \
      && curl -sO https://chelgy.app/render_song.py

EOF
  exit 0
fi

# ── 1 · FETCH THE CLIPS ────────────────────────────────────────────────────
CURRENT_STAGE="fetching your clips"; report 1 "fetching your clips"
say "Stage 1/7 — fetching clips for profile $PROFILE_ID"
RAW="$ROOT/dataset_raw/$PROFILE_ID"
rm -rf "$RAW"; mkdir -p "$RAW"

SUPABASE_URL="$SUPABASE_URL" SUPABASE_SERVICE_KEY="$SUPABASE_SERVICE_KEY" \
PROFILE_ID="$PROFILE_ID" RAW="$RAW" "$PY_BIN" - <<'PY'
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
CURRENT_STAGE="slicing"; report 2 "slicing"
say "Stage 2/7 — slicing"
# Run as MODULES, not scripts. `python train/preprocess.py` puts $ROOT/train
# first on sys.path, and that directory contains train.py — so `import train`
# resolves to the FILE, not the package, and the first internal import dies with
# "partially initialized module 'train' (most likely due to a circular import)".
# Nothing is actually circular; it is a name collision. `-m` runs from $ROOT, so
# `train` resolves to the package and every internal import works.
"$PY_BIN" -m train.preprocess "$RAW" $SR_HZ 8 "$ROOT/logs/$EXP" False 3.0

# ── 3 · PITCH ──────────────────────────────────────────────────────────────
# RMVPE on GPU. This is the stage that decides how well sung notes survive.
CURRENT_STAGE="pitch extraction"; report 3 "pitch extraction"
say "Stage 3/7 — pitch extraction"
"$PY_BIN" -m train.dataset.extract_f0 cuda 1 0 0 "$ROOT/logs/$EXP" True

# ── 4 · FEATURES ───────────────────────────────────────────────────────────
CURRENT_STAGE="voice features"; report 4 "voice features"
say "Stage 4/7 — HuBERT features"
"$PY_BIN" -m train.dataset.extract_hubert_feature cuda:0 1 0 "$ROOT/logs/$EXP" v2 True

# ── 5 · FILELIST ───────────────────────────────────────────────────────────
# The web UI builds this in Python and it is the easiest part of the pipeline
# to get subtly wrong: it must be the intersection of all four output folders,
# plus two mute lines, or training dies partway through with a confusing error.
CURRENT_STAGE="preparing"; report 5 "preparing"
say "Stage 5/7 — building the file list"
EXP="$EXP" ROOT="$ROOT" "$PY_BIN" - <<'PY'
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
# train.py reads logs/<exp>/config.json for the model hyperparameters and does
# NOT create it — in the web UI that copy happens in the browser flow, which
# this headless path never runs. Without it training dies instantly with
# FileNotFoundError: ./logs/voice/config.json. Copy the v2 config matching the
# sample rate; every per-run value (epochs, batch size, paths) is passed on the
# command line below and overrides whatever is in the file.
CFG_SRC="$ROOT/configs/v2/${SR}.json"
[ -f "$CFG_SRC" ] || CFG_SRC="$ROOT/configs/v2/48k.json"
[ -f "$CFG_SRC" ] || die "No RVC config template found at $ROOT/configs/v2/ — the repo layout changed."
cp "$CFG_SRC" "$ROOT/logs/$EXP/config.json"
say "  config: $(basename "$CFG_SRC") -> logs/$EXP/config.json"

CURRENT_STAGE="training"; report 6 "training"
say "Stage 6/7 — training ($EPOCHS epochs, ~40 min)"
"$PY_BIN" -m train.train -e "$EXP" -sr $SR -f0 1 -bs $BATCH -g 0 \
  -te $EPOCHS -se 50 \
  -pg assets/pretrained_v2/f0G${SR}.pth -pd assets/pretrained_v2/f0D${SR}.pth \
  -l 1 -c 0 -sw 1 -v v2

say "Stage 6b/7 — retrieval index"
"$PY_BIN" -m train.train_index "$EXP" v2 "$ROOT/assets/indices" 8

# ── 7 · SHIP IT ────────────────────────────────────────────────────────────
# RVC emits two artefacts and needs both at inference. Uploading only the .pth
# gives you a model that loads fine and sounds noticeably less like the person.
CURRENT_STAGE="saving your voice"; report 7 "saving your voice"
say "Stage 7/7 — uploading the model"
SUPABASE_URL="$SUPABASE_URL" SUPABASE_SERVICE_KEY="$SUPABASE_SERVICE_KEY" \
PROFILE_ID="$PROFILE_ID" ROOT="$ROOT" EXP="$EXP" "$PY_BIN" - <<'PY'
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

FINISHED=1
report 7 "ready"
say "Done. The voice model is in the account."
# Terminate on SUCCESS too. The header always claimed the pod removes itself;
# it never did on this path, which is why a finished train kept billing until
# somebody noticed it in the console.
terminate_self
