// api/song-suno.js
//
// SONG STUDIO — Suno production via Unifically.
//
// This is the "your voice, their production" engine. Two approaches, both
// building on the fact that Chelsea's real RVC voice already sounds like her
// (Suno's clone doesn't), so we keep HER voice as the lead and borrow Suno
// only for the production we can't build ourselves — the beat, the
// arrangement, the backing vocals, the ad-libs, the polish.
//
//   action "addInstrumental"  (Path B / Option A)
//     Send her finished vocal to Suno; Suno wraps a full produced arrangement
//     AROUND it. One call. Suno matches the production to her voice, which
//     sidesteps the whole "beat doesn't fit the vocal" problem — the
//     instrumental is built for this vocal, not matched to it after.
//
//   action "fullThenStems"  (Path B / Option B)
//     Generate a complete Suno song from a prompt, then split it into stems
//     and hand back the instrumental + backing-vocals stems. The caller layers
//     her RVC lead in place of Suno's lead, keeping Suno's backing/ad-libs.
//     More moving parts, but preserves the ad-libs she liked.
//
// Everything is one async pattern on Unifically: POST /v1/tasks returns a
// task_id; poll GET /v1/tasks/<id> until status "completed", read the audio
// url off output. No vocal upload step needed — add-instrumental takes an
// audio_url, and her vocal already lives at a public Supabase URL.
//
// Env: UNIFICALLY_API_KEY, SUPABASE_URL, SUPABASE_ANON_KEY

export const maxDuration = 300;

const UNI = "https://api.unifically.com/v1";
const KEY = (process.env.UNIFICALLY_API_KEY || "").trim();
const SB_URL = (process.env.SUPABASE_URL || "").trim();
const SB_ANON = (process.env.SUPABASE_ANON_KEY || "").trim();

// Suno model version tag Unifically expects (chirp-*). Bluejay = v4.5-plus
// class, a good default for rich arrangements; overridable per request.
const DEFAULT_MV = (process.env.SUNO_MV || "chirp-bluejay").trim();

async function getUserId(token) {
  if (!token) return null;
  try {
    const r = await fetch(SB_URL + "/auth/v1/user", {
      headers: { apikey: SB_ANON, Authorization: "Bearer " + token },
    });
    const u = await r.json();
    return r.ok && u && u.id ? u.id : null;
  } catch { return null; }
}

// Submit a task, then poll until it finishes. Unifically's audio tasks return
// their result on output — the field name varies a little by model, so we look
// across the likely spots rather than hard-coding one.
async function runTask(model, input, { tries = 90, waitMs = 4000 } = {}) {
  const submit = await fetch(UNI + "/tasks", {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: "Bearer " + KEY },
    body: JSON.stringify({ model, input }),
  });
  const sj = await submit.json().catch(() => ({}));
  if (!submit.ok) {
    throw new Error("Suno submit failed (" + submit.status + "): "
      + (sj && (sj.message || sj.error) || JSON.stringify(sj)).toString().slice(0, 200));
  }
  const taskId = sj.task_id || (sj.data && sj.data.task_id);
  if (!taskId) throw new Error("No task_id came back from Suno.");

  for (let i = 0; i < tries; i++) {
    await new Promise((r) => setTimeout(r, waitMs));
    const st = await fetch(UNI + "/tasks/" + taskId, {
      headers: { Authorization: "Bearer " + KEY },
    });
    const j = await st.json().catch(() => ({}));
    const status = j.status || (j.data && j.data.status);
    if (status === "completed" || status === "finished" || status === "success") {
      return j.output || (j.data && j.data.output) || j.data || j;
    }
    if (status === "failed" || status === "error") {
      throw new Error("Suno task failed: "
        + ((j.error || j.message || "unknown").toString().slice(0, 200)));
    }
  }
  throw new Error("Suno task timed out — it may still finish; try again shortly.");
}

// Pull every audio-ish URL out of whatever shape the output took, so callers
// can pick what they need (a single track, or a set of stems).
function collectAudio(output) {
  const urls = [];
  const walk = (v, keyHint) => {
    if (!v) return;
    if (typeof v === "string") {
      if (/^https?:\/\/.+\.(mp3|wav|m4a|flac|ogg)(\?|$)/i.test(v)) urls.push({ url: v, hint: keyHint || "" });
      return;
    }
    if (Array.isArray(v)) { v.forEach((x) => walk(x, keyHint)); return; }
    if (typeof v === "object") {
      for (const k of Object.keys(v)) walk(v[k], k.toLowerCase());
    }
  };
  walk(output, "");
  return urls;
}

export default async function handler(req, res) {
  if (req.method !== "POST") return res.status(405).json({ error: "POST only" });
  if (!KEY) return res.status(500).json({ error: "Suno production isn't configured yet." });

  const token = (req.headers.authorization || "").replace(/^Bearer\s+/i, "").trim();
  const userId = await getUserId(token);
  if (!userId) return res.status(401).json({ error: "Please log in again." });

  const b = req.body || {};
  const action = String(b.action || "").trim();
  const mv = String(b.mv || DEFAULT_MV).trim();

  try {
    // ── Path B / Option A ──────────────────────────────────────────────────
    // Her vocal in, full arrangement wrapped around it.
    if (action === "addInstrumental") {
      const audioUrl = String(b.audioUrl || "").trim();
      if (!/^https?:\/\//.test(audioUrl))
        return res.status(400).json({ error: "Missing the vocal's URL." });

      const input = {
        mv,
        audio_url: audioUrl,
        // "simple mode" description drives the arrangement's genre/feel; the
        // caller passes the melody's own style so production fits the song.
        gpt_description_prompt: String(b.style || b.prompt || "").slice(0, 480),
      };
      if (b.title) input.title = String(b.title).slice(0, 80);
      if (Number.isFinite(b.startS)) input.start_s = b.startS;
      if (Number.isFinite(b.endS)) input.end_s = b.endS;

      const out = await runTask("suno-ai/add-instrumental", input);
      const audio = collectAudio(out);
      if (!audio.length) throw new Error("Suno returned no audio.");
      return res.json({ ok: true, approach: "A", url: audio[0].url, all: audio });
    }

    // ── Path B / Option B ──────────────────────────────────────────────────
    // Generate a full song, then split it so the caller can keep the
    // instrumental + backing vocals and drop in her own lead.
    if (action === "fullThenStems") {
      const prompt = String(b.prompt || "").trim();
      if (!prompt) return res.status(400).json({ error: "Missing the song prompt." });

      // 1) full song (with Suno's vocals, backing, ad-libs)
      const genInput = {
        mv,
        gpt_description_prompt: prompt.slice(0, 480),
        make_instrumental: false,
      };
      if (b.title) genInput.title = String(b.title).slice(0, 80);
      const gen = await runTask("suno-ai/music", genInput);

      // find the generated clip's id to feed the stem splitter
      const clipId = gen && (gen.clip_id || gen.id
        || (Array.isArray(gen.clips) && gen.clips[0] && gen.clips[0].id)
        || (gen.data && gen.data.clip_id));
      if (!clipId) {
        // no clip id — still hand back whatever full audio we got
        const audio = collectAudio(gen);
        return res.json({ ok: true, approach: "B", full: audio[0] && audio[0].url,
          note: "Stems unavailable (no clip id); returned the full song.", all: audio });
      }

      // 2) split into all stems; keep instrumental + backing vocals
      const stemsOut = await runTask("suno-ai/stems-all", { clip_id: clipId, title: b.title || "stems" });
      const stems = collectAudio(stemsOut);
      const pick = (want) => {
        const hit = stems.find((s) => s.hint.includes(want));
        return hit ? hit.url : null;
      };
      return res.json({
        ok: true, approach: "B",
        instrumental: pick("instrument") || pick("accompan") || null,
        backingVocals: pick("backing") || null,
        allStems: stems,
      });
    }

    return res.status(400).json({ error: "Unknown action." });
  } catch (e) {
    return res.status(502).json({ error: String((e && e.message) || e) });
  }
}
