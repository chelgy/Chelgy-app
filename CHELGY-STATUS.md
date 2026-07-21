# Chelgy — what's actually done, what isn't

Last updated: 20 July 2026

Keep this in the repo. Every time something ships, move it up. Every time we defer
something, it goes in here with a reason — not in your head.

---

## 1. BLOCKS SELLING (fix before anyone pays)

### Paywall bypass — `?payment=success`
The URL handler writes paid status **client-side, with no server verification**.
Anyone can type `?payment=success` and get a paid account. The `?membership=success`
handler already does this correctly by polling the server; this one needs to match.

Status: **open, known for weeks.** This is the one that costs real money if someone
finds it.

### GPU worker lifecycle is manual
A pod has to be started and terminated by hand. That is not a product — it means
renders only work when you're awake and watching.

What "done" looks like: a job arriving starts a worker automatically, and a worker
that finds no work for a few minutes shuts itself down. RunPod has an API for both.
Roughly 40 lines plus an API key.

Status: **not started.** Next thing to build.

---

## 2. SHIPPED AND WORKING

- Chunked render pipeline: plan → fan out → join, on Postgres job state
- Audio split from video; drift measured at under 20ms and not accumulating
- Failed chunk kills the job in seconds and refunds, instead of hanging two hours
- Worker probes the machine by actually running the pipeline, not reading a list
- GPU image builds and publishes itself on `git push`
- Scene cards, transitions (Seedance video-extend), caption punctuation, CAVELINE
  title layout, composed LUT (~30% faster)
- `/audio` endpoint — was throwing a ReferenceError on every call and had never once
  run successfully

---

## 3. HALF DONE — the dangerous category

### B-roll
Render side is finished: stills composite correctly, graded to match, forward-snapped
if their moment was cut. **Nothing generates the images.** `api/image.js` (Gemini) is
there and unused.

Also: strip "warm cinematic film style" from `studio-plan.js` prompts first, or images
get graded twice.

When it ships: put `editorCinematic` back to 4,000 credits. It's at 3,000 precisely
because this is missing.

### Music
Button is **greyed out on purpose** — it was selectable and promising "+400
credits/minute" while sending nothing at all. Lyria 3 on WaveSpeed uses your existing
key. The real work is sidechain ducking so the score sits under the voice. Un-grey it
in the same commit that makes it work.

### Two code paths doing the same job
The single-server renderer and the chunked one each implement grade resolution, card
placement and LUT caching separately. **Four separate bugs came from this** — the
missing LUT, the stacked title, the dangling LUT path, the missing captions. Each time
the rewrite dropped a rule the original had.

This is the root cause, not a tidy-up.

---

## 4. NOT STARTED

| | why it matters |
|---|---|
| WebGL browser preview | Biggest perceived-speed win available. No new hardware. Editing feels instant because nothing renders until export. |
| Multiple workers | Never actually run more than one at a time. The parallelism is untested. |
| Desktop Mac app | Capacitor/Xcode. RevenueCat `pro` entitlement already covers macOS. |
| Package back to private | The GPU image is public right now. Contains CAVELINE and the Phantom LUTs — check your licences. Fix is registry auth in the RunPod template. |

---

## 5. NEEDS YOUR EYES, NOT MY CODE

- **Audio sync at the cuts** on a chunked render. This is the specific thing the audio
  split exists for and you haven't confirmed it yet.
- **Title proportions** — small-line ratio 0.20, display cap h/5.2, wrap width 62%.
  I got these wrong twice by reasoning instead of looking.
- **Crossbar-less A in captions** — the specimen uses it only in the display word;
  Chelgy uses it everywhere. Your call, unchanged so far.
- **Transitions toggle** only appears on Vlog and Cinematic. You couldn't find it.
  Worth showing greyed-out elsewhere so people know it exists.

---

## 6. HOUSEKEEPING

- Two Render services are both named `chelgy-render-server`. Rename the worker.
- Auto-deploy appears to be off on at least one Render service — pushes weren't
  building until manually deployed.
- `CHUNKED_RENDER=1` is live in Vercel. Removing it reverts to the old renderer.
