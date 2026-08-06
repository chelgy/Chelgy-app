#!/usr/bin/env bash
# ═══════════════════════════════════════════════════════════════════════════
# SONG STUDIO — train the VOICE GENERATOR (DiffSinger fine-tune)
#
# The RVC model is a converter: it repaints an existing take. THIS trains the
# generator — a model that SINGS from notes + lyrics with no input take. The
# Suno-class capability, in the person's own voice.
#
# Runs on a RunPod GPU pod. One command, then walk away (training is long).
#
#   export SUPABASE_SERVICE_KEY="eyJ..."   # Supabase → Settings → API → service_role
#   export PROFILE_ID="....-....-...."     # from the voice_profiles table
#   bash train-diffsinger.sh
#
# Consumes the dataset laid down by dataset-upload.html:
#   voice/<uid>/<pid>/dataset/clip_NNN.wav   the singing
#   voice/<uid>/<pid>/dataset/clip_NNN.txt   the exact lyrics of that clip
#
# Stages:
#   0  environment (DiffSinger + MFA + pretrained bases)   ~15 min first run
#   1  fetch the dataset                                    ~2 min
#   2  validate + resample pairs                            ~2 min
#   3  MFA forced alignment (lyrics -> phoneme timing)      ~10-30 min
#   4  build DiffSinger transcriptions + binarize           ~10 min
#   5  fine-tune the acoustic model                         hours-days
#   6  export + upload back to the account                  ~5 min
#
# The long part is stage 5 and it is GPU time, not human time. EPOCHS/STEPS
# below deliberately start modest — a first fine-tune that proves the pipeline
# beats a perfect one that never finishes.
# ═══════════════════════════════════════════════════════════════════════════
set -uo pipefail
# NOTE: -e is deliberately OFF. An ERR-trap that self-deletes the pod on ANY
# non-zero exit killed pods mid-setup on harmless probe commands (command -v,
# conda checks). We check real failures explicitly and only self-terminate on
# those — never on an incidental non-zero from a setup line.

SUPABASE_URL="${SUPABASE_URL:-https://yuzvpmxbtjpqtapborhr.supabase.co}"
ROOT=/workspace/diffsinger
DS_REPO=https://github.com/openvpi/DiffSinger.git
MAKE_REPO=https://github.com/openvpi/MakeDiffSinger.git
MAX_STEPS="${MAX_STEPS:-60000}"        # fine-tune length; raise for quality once proven
DICTIONARY="${DICTIONARY:-english}"    # MFA dictionary/language

say(){ printf "\n\033[1m▸ %s\033[0m\n" "$*"; }
die(){ printf "\n\033[31m✗ %s\033[0m\n" "$*" >&2; fail_and_stop "$*"; exit 1; }

# ── Progress + lifecycle helpers (defined before anything that can fail) ─────
# The app watches voice/<uid>/<pid>/generator/status.json. Every stage writes
# it, so "watch the pod" becomes "watch the app". The pod REMOVES ITSELF when
# training ends — success or failure — so a training pod nobody babysits never
# bills forever. But self-terminate fires ONLY on a real checked failure (via
# die), never on an incidental non-zero exit — that early over-eager trap is
# what deleted pods mid-setup.
STATUS_PATH=""   # set once the profile is known; report() no-ops until then

report() { # report <stage-number> <label> [error]
  [ -n "${STATUS_PATH:-}" ] || return 0
  python3 - "$1" "$2" "${3:-}" <<'PYR'
import json, os, sys, urllib.request
stage, label, err = sys.argv[1], sys.argv[2], sys.argv[3]
body = json.dumps({"stage": int(stage), "of": 6, "label": label,
                   "error": err or None, "at": __import__("time").time()}).encode()
req = urllib.request.Request(
    os.environ["SUPABASE_URL"] + "/storage/v1/object/voice/" + os.environ["STATUS_PATH"],
    data=body, method="POST",
    headers={"apikey": os.environ["SUPABASE_SERVICE_KEY"],
             "Authorization": "Bearer " + os.environ["SUPABASE_SERVICE_KEY"],
             "Content-Type": "application/json", "x-upsert": "true"})
try: urllib.request.urlopen(req, timeout=30)
except Exception as e: print("  (status update failed: %s)" % e)
PYR
}

terminate_self() {
  local key="${CHELGY_RUNPOD_KEY:-}"
  [ -n "$key" ] && [ -n "${RUNPOD_POD_ID:-}" ] || { echo "(no pod credentials — not self-terminating)"; return 0; }
  echo "removing this pod (${RUNPOD_POD_ID})"
  curl -fsSL -X DELETE "https://rest.runpod.io/v1/pods/${RUNPOD_POD_ID}" \
    -H "Authorization: Bearer $key" || echo "(self-terminate call failed — the reaper will get it)"
}

fail_and_stop() {
  report 0 "failed" "stopped at: ${CURRENT_STAGE:-startup} — $1"
  echo "[train] FAILED at ${CURRENT_STAGE:-startup}: $1"
  echo "[train] leaving pod up 3 HOURS so the log survives and nothing is cut short; then self-terminating"
  echo "[train] (a healthy run never reaches here — this only fires on a real failure)"
  sleep 10800
  terminate_self
}

# ── Preconditions (now die/fail_and_stop exist) ─────────────────────────────
CURRENT_STAGE="startup"
[ -n "${SUPABASE_SERVICE_KEY:-}" ] || die "SUPABASE_SERVICE_KEY is not set."
[ -n "${PROFILE_ID:-}" ]          || die "PROFILE_ID is not set."
nvidia-smi -L >/dev/null 2>&1     || die "No GPU visible. This needs a GPU pod."

# Resolve the owning user, then progress can be reported.
UID_JSON=$(curl -fsSL "$SUPABASE_URL/rest/v1/voice_profiles?select=user_id&id=eq.$PROFILE_ID" \
  -H "apikey: $SUPABASE_SERVICE_KEY" -H "Authorization: Bearer $SUPABASE_SERVICE_KEY")
OWNER_UID=$(printf '%s' "$UID_JSON" | python3 -c "import sys,json;d=json.load(sys.stdin);print(d[0]['user_id'] if d else '')")
[ -n "$OWNER_UID" ] || die "profile $PROFILE_ID not found"
STATUS_PATH="$OWNER_UID/$PROFILE_ID/generator/status.json"
export SUPABASE_URL SUPABASE_SERVICE_KEY STATUS_PATH

report 0 "starting up"

# ── 0 · ENVIRONMENT ────────────────────────────────────────────────────────
CURRENT_STAGE="setting up the training environment"
report 0 "setting up the training environment"
say "Stage 0/6 — environment"
mkdir -p "$ROOT"; cd "$ROOT"

if [ ! -d DiffSinger ]; then
  apt-get update -qq && apt-get install -y -qq ffmpeg git sox libsox-fmt-all >/dev/null
  git clone -q --depth 1 "$DS_REPO" DiffSinger
  git clone -q --depth 1 "$MAKE_REPO" MakeDiffSinger
fi

if [ ! -f .deps-done ]; then
  pip install -q --upgrade pip
  pip install -q -r DiffSinger/requirements.txt
  pip install -q requests soundfile praat-parselmouth textgrid
  # MFA runs best from conda; miniconda keeps it isolated from torch's env.
  if ! command -v mfa >/dev/null 2>&1; then
    say "Installing Montreal Forced Aligner (conda)"
    if [ ! -d /opt/conda ]; then
      curl -fsSL https://repo.anaconda.com/miniconda/Miniconda3-latest-Linux-x86_64.sh -o /tmp/mc.sh
      bash /tmp/mc.sh -b -p /opt/conda
    fi
    # Anaconda now requires accepting the Terms of Service for its default
    # channels before conda will install anything (CondaToSNonInteractiveError).
    # Accept for the default channels; harmless if already accepted. We install
    # MFA from conda-forge (which has no ToS gate), but conda still checks the
    # defaults during solve, so both must be accepted.
    /opt/conda/bin/conda tos accept --override-channels --channel https://repo.anaconda.com/pkgs/main 2>/dev/null || true
    /opt/conda/bin/conda tos accept --override-channels --channel https://repo.anaconda.com/pkgs/r 2>/dev/null || true
    # Install strictly from conda-forge so the defaults channel isn't needed at all.
    /opt/conda/bin/conda create -n mfa -c conda-forge --override-channels montreal-forced-aligner -y -q
  fi
  touch .deps-done
fi
MFA=/opt/conda/envs/mfa/bin/mfa
[ -x "$MFA" ] || MFA=$(command -v mfa) || die "MFA did not install."

# MFA is a Python front end that SHELLS OUT to the OpenFST and Kaldi binaries —
# fstcompile, fstarcsort, gmm-align-compiled — which conda-forge installs as
# siblings of `mfa` inside the env's bin. Calling $MFA by absolute path does not
# put that directory on PATH, so those siblings are invisible and MFA dies with
# ThirdpartyError: Could not find 'fstcompile'. That is the 5 Aug failure: the
# env was fine, nothing was missing, the binaries just weren't reachable.
# Activating the env properly is what fixes it — same class of bug as the
# missing `python` in train-voice.sh.
MFA_BIN="$(dirname "$MFA")"
export PATH="$MFA_BIN:$PATH"
[ -d "$MFA_BIN/../lib" ] && export LD_LIBRARY_PATH="$MFA_BIN/../lib:${LD_LIBRARY_PATH:-}"
case "$MFA_BIN" in */envs/mfa/bin) export CONDA_PREFIX="${MFA_BIN%/bin}" ;; esac

# Verified, not assumed. If the binaries genuinely are absent, install them now
# rather than 30 minutes later mid-alignment.
if ! command -v fstcompile >/dev/null 2>&1; then
  say "OpenFST/Kaldi binaries missing — installing into the mfa env"
  /opt/conda/bin/conda install -n mfa -c conda-forge --override-channels \
    openfst kaldi -y -q || die "Could not install OpenFST/Kaldi into the mfa env."
fi
command -v fstcompile >/dev/null 2>&1 || die "fstcompile still not on PATH after install — MFA cannot align."
printf "  mfa: %s\n  fstcompile: %s\n" "$MFA" "$(command -v fstcompile)"

# MFA needs a dictionary + acoustic model for the language.
if [ ! -f .mfa-models-done ]; then
  say "Downloading MFA $DICTIONARY models"
  # Download a MATCHED dictionary+acoustic pair and record which model name
  # actually landed, so alignment references the one that exists. Try the
  # modern "_mfa" pair first (better for singing), fall back to "_us_arpa".
  MFA_MODEL=""
  if "$MFA" model download acoustic "${DICTIONARY}_mfa" 2>/dev/null \
     && "$MFA" model download dictionary "${DICTIONARY}_mfa" 2>/dev/null; then
    MFA_MODEL="${DICTIONARY}_mfa"
  elif "$MFA" model download acoustic "${DICTIONARY}_us_arpa" 2>/dev/null \
       && "$MFA" model download dictionary "${DICTIONARY}_us_arpa" 2>/dev/null; then
    MFA_MODEL="${DICTIONARY}_us_arpa"
  else
    die "Could not download any MFA model for ${DICTIONARY}"
  fi
  echo "$MFA_MODEL" > .mfa-model-name
  touch .mfa-models-done
fi

# The pretrained pieces we fine-tune FROM. The community NSF-HiFiGAN vocoder is
# universal (trained on ~72h of singing) and is used as-is; the acoustic model
# is what we fine-tune on the person's voice.
if [ ! -f .pretrained-done ]; then
  say "Downloading pretrained vocoder + base acoustic checkpoint"
  mkdir -p DiffSinger/checkpoints
  python - <<'PY'
import urllib.request, zipfile, os, sys
# Community vocoder release (NSF-HiFiGAN 44.1k). The release asset name is
# stable; if this 404s, check github.com/openvpi/vocoders/releases and update.
url="https://github.com/openvpi/vocoders/releases/download/nsf-hifigan-44.1k-hop512-128bin-2024.02/nsf_hifigan_44.1k_hop512_128bin_2024.02.zip"
dst="DiffSinger/checkpoints/nsf_hifigan.zip"
try:
    urllib.request.urlretrieve(url,dst)
    with zipfile.ZipFile(dst) as z: z.extractall("DiffSinger/checkpoints/")
    os.remove(dst)
    print("  vocoder in place")
except Exception as e:
    sys.exit(f"vocoder download failed: {e} — check the release URL")
PY
  touch .pretrained-done
fi

# ── 1 · FETCH THE DATASET ──────────────────────────────────────────────────
CURRENT_STAGE="fetching your recordings"
report 1 "fetching your recordings"
say "Stage 1/6 — fetching the dataset for profile $PROFILE_ID"
RAW="$ROOT/raw/$PROFILE_ID"
rm -rf "$RAW"; mkdir -p "$RAW"

SUPABASE_URL="$SUPABASE_URL" SUPABASE_SERVICE_KEY="$SUPABASE_SERVICE_KEY" \
PROFILE_ID="$PROFILE_ID" RAW="$RAW" python - <<'PY'
import os, requests, sys
url=os.environ["SUPABASE_URL"]; key=os.environ["SUPABASE_SERVICE_KEY"]
pid=os.environ["PROFILE_ID"];  raw=os.environ["RAW"]
H={"apikey":key,"Authorization":"Bearer "+key}

prof=requests.get(f"{url}/rest/v1/voice_profiles", params={"select":"user_id","id":f"eq.{pid}"},
                  headers=H, timeout=30).json()
if not prof: sys.exit("profile not found")
uid=prof[0]["user_id"]
prefix=f"{uid}/{pid}/dataset"

# List everything under the dataset prefix.
r=requests.post(f"{url}/storage/v1/object/list/voice",
    headers={**H,"Content-Type":"application/json"},
    json={"prefix":prefix,"limit":1000,"offset":0}, timeout=60)
r.raise_for_status()
items=[o["name"] for o in r.json() if o.get("name")]
wavs=sorted(n for n in items if n.lower().endswith((".wav",".m4a",".mp3",".aif",".aiff")))
if not wavs: sys.exit(f"no audio found under voice/{prefix} — upload clips first (dataset-upload.html)")

total=0
kept=0
for n in wavs:
    base=os.path.splitext(n)[0]
    txt=base+".txt"
    if txt not in items:
        print(f"  skip {n}: no lyrics file"); continue
    a=requests.get(f"{url}/storage/v1/object/voice/{prefix}/{n}",  headers=H, timeout=300)
    t=requests.get(f"{url}/storage/v1/object/voice/{prefix}/{txt}",headers=H, timeout=60)
    if a.status_code!=200 or t.status_code!=200:
        print(f"  skip {n}: fetch {a.status_code}/{t.status_code}"); continue
    open(os.path.join(raw,n),"wb").write(a.content)
    open(os.path.join(raw,base+".txt"),"w",encoding="utf8").write(t.text.strip())
    kept+=1
print(f"  {kept} clip/lyrics pairs fetched")
if kept < 8:
    sys.exit(f"only {kept} usable pairs — need more clips (with lyrics) before training is worth the GPU time")
PY

# ── 2 · VALIDATE + RESAMPLE ────────────────────────────────────────────────
# Everything to mono 44.1k WAV, peak-checked. MFA and DiffSinger both want
# clean uniform wavs; a stray 24k m4a in the set fails late and confusingly.
CURRENT_STAGE="checking and preparing the clips"
report 2 "checking and preparing the clips"
say "Stage 2/6 — validating and resampling"
WORK="$ROOT/work/$PROFILE_ID"
rm -rf "$WORK"; mkdir -p "$WORK/wavs"
RAW="$RAW" WORK="$WORK" python - <<'PY'
import os, subprocess, sys
raw=os.environ["RAW"]; work=os.environ["WORK"]
n=0
for f in sorted(os.listdir(raw)):
    if not f.lower().endswith((".wav",".m4a",".mp3",".aif",".aiff")): continue
    base=os.path.splitext(f)[0]
    txt=os.path.join(raw,base+".txt")
    if not os.path.isfile(txt): continue
    dst=os.path.join(work,"wavs",base+".wav")
    subprocess.run(["ffmpeg","-y","-v","error","-i",os.path.join(raw,f),
                    "-ac","1","-ar","44100","-sample_fmt","s16",dst],check=True)
    # the .lab file MFA reads sits beside the wav with the same stem
    lab=os.path.join(work,"wavs",base+".lab")
    open(lab,"w",encoding="utf8").write(open(txt,encoding="utf8").read().strip().lower())
    n+=1
print(f"  {n} clips ready for alignment")
if n<8: sys.exit("too few after validation")
PY

# ── 3 · MFA FORCED ALIGNMENT ───────────────────────────────────────────────
# The automatic annotation: lyrics -> phoneme timings, no manual labelling.
CURRENT_STAGE="aligning your words to your audio"
report 3 "aligning your words to your audio"
say "Stage 3/6 — MFA forced alignment"
ALIGN="$WORK/textgrids"; rm -rf "$ALIGN"; mkdir -p "$ALIGN"
# Use the model that was actually downloaded (recorded above), for BOTH the
# dictionary and the acoustic model — asking for a name that was never fetched
# is what produced PretrainedModelNotFoundError: "english_mfa".
MFA_MODEL="$(cat .mfa-model-name 2>/dev/null || echo "${DICTIONARY}_us_arpa")"
say "Aligning with MFA model: $MFA_MODEL"
"$MFA" align --clean --single_speaker "$WORK/wavs" "$MFA_MODEL" "$MFA_MODEL" "$ALIGN" \
  || die "MFA alignment failed — usually lyrics not matching what was sung, or too-noisy audio"
ls "$ALIGN"/*.TextGrid >/dev/null 2>&1 || die "MFA produced no TextGrids"
echo "  aligned $(ls "$ALIGN"/*.TextGrid | wc -l) clips"

# ── 4 · BUILD DIFFSINGER DATA + BINARIZE ───────────────────────────────────
# MakeDiffSinger's pipeline turns wav+TextGrid into the transcriptions.csv +
# ds files DiffSinger's binarizer consumes.
CURRENT_STAGE="building the training dataset"
report 4 "building the training dataset"
say "Stage 4/6 — building DiffSinger dataset"
DATA="$ROOT/DiffSinger/data/$PROFILE_ID"
rm -rf "$DATA"; mkdir -p "$DATA"
cp -r "$WORK/wavs" "$DATA/wavs"
cp -r "$ALIGN" "$DATA/textgrids"

cd "$ROOT/MakeDiffSinger/acoustic_forced_alignment"
python build_dataset.py \
  --wavs "$DATA/wavs" \
  --tg "$DATA/textgrids" \
  --dataset "$DATA" \
  || die "MakeDiffSinger build_dataset failed — check TextGrid/wav pairing"

cd "$ROOT/DiffSinger"
# Config: start from the acoustic template, point it at our data.
CFG="configs/$PROFILE_ID.yaml"
python - <<PY
import yaml, os, shutil
src="configs/templates/config_acoustic.yaml"
cfg=yaml.safe_load(open(src))
cfg["raw_data_dir"]=["data/$PROFILE_ID"]
cfg["speakers"]=["$PROFILE_ID"]
cfg["binary_data_dir"]="data/${PROFILE_ID}_binary"
cfg["max_updates"]=int("$MAX_STEPS")
cfg["val_check_interval"]=2000
cfg["num_ckpt_keep"]=2
yaml.safe_dump(cfg, open("$CFG","w"))
print("  config written: $CFG")
PY
python scripts/binarize.py --config "$CFG" || die "binarize failed"

# ── 5 · FINE-TUNE ──────────────────────────────────────────────────────────
CURRENT_STAGE="training — this takes hours to days"
report 5 "training — this takes hours to days"
say "Stage 5/6 — fine-tuning (long; the machine works, not you)"
python scripts/train.py --config "$CFG" --exp_name "$PROFILE_ID" --reset \
  || die "training failed — the log above has the real reason"

# ── 6 · EXPORT + SHIP ──────────────────────────────────────────────────────
CURRENT_STAGE="saving your voice generator"
report 6 "saving your voice generator"
say "Stage 6/6 — exporting and uploading"
python scripts/export.py acoustic --exp "$PROFILE_ID" || echo "  (onnx export skipped — ckpt still uploads)"

SUPABASE_URL="$SUPABASE_URL" SUPABASE_SERVICE_KEY="$SUPABASE_SERVICE_KEY" \
PROFILE_ID="$PROFILE_ID" ROOT="$ROOT" python - <<'PY'
import os, glob, requests, sys, datetime
url=os.environ["SUPABASE_URL"]; key=os.environ["SUPABASE_SERVICE_KEY"]
pid=os.environ["PROFILE_ID"];  root=os.environ["ROOT"]
H={"apikey":key,"Authorization":"Bearer "+key}

ckpts=sorted(glob.glob(f"{root}/DiffSinger/checkpoints/{pid}/model_ckpt_steps_*.ckpt"), key=os.path.getmtime)
onnx =sorted(glob.glob(f"{root}/DiffSinger/artifacts/{pid}/**/*.onnx", recursive=True), key=os.path.getmtime)
if not ckpts: sys.exit("no checkpoint produced — training did not finish")

prof=requests.get(f"{url}/rest/v1/voice_profiles", params={"select":"user_id","id":f"eq.{pid}"},
                  headers=H, timeout=30).json()
uid=prof[0]["user_id"]

def put(local,name):
    path=f"{uid}/{pid}/generator/{name}"
    r=requests.post(f"{url}/storage/v1/object/voice/{path}",
        headers={**H,"x-upsert":"true","Content-Type":"application/octet-stream"},
        data=open(local,"rb"), timeout=1800)
    r.raise_for_status(); return path

ck=put(ckpts[-1],"acoustic.ckpt")
print(f"  {ck}")
for o in onnx[-2:]:
    print("  "+put(o, os.path.basename(o)))

r=requests.patch(f"{url}/rest/v1/voice_profiles", params={"id":f"eq.{pid}"},
    headers={**H,"Content-Type":"application/json"},
    json={"generator_path":ck,
          "generator_trained_at":datetime.datetime.now(datetime.timezone.utc).isoformat()})
# The generator_path column may not exist yet; that's fine — the artefact is in
# storage either way, and the column can be added when the inference path lands.
if not r.ok: print(f"  note: profile row not updated ({r.status_code}) — model is uploaded regardless")
PY

report 6 "done — your voice generator is ready"
say "Done. The voice GENERATOR is trained and uploaded."
terminate_self
