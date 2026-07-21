// Chelgy AI Video Editor — STEP 3d: compose the score.
//
// Google Lyria 3 Pro on WaveSpeed. Deliberately the same provider the video tools
// already use, which buys three things for free: the key is already in Vercel, the
// job polls through the existing /api/video-result WaveSpeed branch, and a failed
// generation is auto-refunded by the refund logic already living there. A second
// provider would have meant a second key, a second poller and a second refund path
// — three new places for money to go missing.
//
// The score is NOT uploaded to our storage. It stays on the provider's URL and the
// render server fetches it over https, exactly like a generated transition clip
// does. Same contract, same failure mode, nothing new to clean up.
//
// PRICING NOTE, because this one is easy to get wrong later: Lyria is charged PER
// CLIP (~$0.08), not per minute. A 90-second edit and a 12-minute edit cost us the
// same. So the charge here is FLAT. Charging per finished minute would have meant
// billing 4,800 credits for an eight-cent track on a long video, which is the kind
// of thing a customer notices.
//
// Env: WAVESPEED_API_KEY, SUPABASE_URL, SUPABASE_ANON_KEY, SUPABASE_SERVICE_ROLE_KEY

export const maxDuration = 60;

const SB_URL = (process.env.SUPABASE_URL || "").trim();
const SB_ANON = (process.env.SUPABASE_ANON_KEY || "").trim();
const SB_SVC = (process.env.SUPABASE_SERVICE_ROLE_KEY || "").trim();

const MUSIC_COST = 600;       // flat, per score — must match CREDIT_COSTS.musicScore in App.jsx
const MUSIC_REAL_USD = 0.08;  // Lyria 3 Pro, per clip
const MODEL_PATH = "google/lyria-3-pro/music";

async function getUserId(token) {
  if (!token) return null;
  try {
    const r = await fetch(SB_URL + "/auth/v1/user", { headers: { apikey: SB_ANON, Authorization: "Bearer " + token } });
    const u = await r.json();
    return r.ok && u && u.id ? u.id : null;
  } catch { return null; }
}
async function spend(token, amount, reason) {
  try {
    const r = await fetch(SB_URL + "/rest/v1/rpc/spend_credits", {
      method: "POST",
      headers: { apikey: SB_ANON, Authorization: "Bearer " + token, "Content-Type": "application/json" },
      body: JSON.stringify({ p_amount: amount, p_reason: reason })
    });
    const d = await r.json();
    if (!r.ok) return { ok: false, error: (d && d.message) || "Could not deduct credits." };
    return { ok: true, balance: typeof d === "number" ? d : null };
  } catch { return { ok: false, error: "Credit service unreachable." }; }
}
async function refund(userId, amount, reason) {
  try {
    await fetch(SB_URL + "/rest/v1/rpc/add_credits", {
      method: "POST",
      headers: { apikey: SB_SVC, Authorization: "Bearer " + SB_SVC, "Content-Type": "application/json" },
      body: JSON.stringify({ p_user: userId, p_amount: amount, p_reason: reason })
    });
  } catch {}
}
// Recording the job is what makes the refund automatic: /api/video-result looks the
// id up here when WaveSpeed reports a failure and puts the credits back exactly once.
async function recordVideoJob(id, userId, cost) {
  try {
    await fetch(SB_URL + "/rest/v1/video_jobs", {
      method: "POST",
      headers: { apikey: SB_SVC, Authorization: "Bearer " + SB_SVC, "Content-Type": "application/json", Prefer: "return=minimal" },
      body: JSON.stringify({ id: String(id), user_id: userId, cost })
    });
  } catch {}
}
async function logCost(id, userId, model, credits, estUsd) {
  try {
    await fetch(SB_URL + "/rest/v1/cost_log", {
      method: "POST",
      headers: { apikey: SB_SVC, Authorization: "Bearer " + SB_SVC, "Content-Type": "application/json", Prefer: "return=minimal" },
      body: JSON.stringify({ id: String(id), user_id: userId, tool: "video_editor", model, duration: null, credits_charged: credits, est_usd: estUsd })
    });
  } catch {}
}

// The house style, applied on top of whatever brief the planner wrote.
//
// Two rules do most of the work. INSTRUMENTAL, because a vocal under a talking
// voice is unlistenable — two people singing over each other. And RESTRAINED,
// because this track is going under someone's face, not playing on its own; a
// score that demands attention is competing with the thing it's supposed to serve.
const HOUSE_STYLE =
  "Instrumental only, absolutely no vocals, no lyrics, no vocal samples, no spoken word. " +
  "Composed as an underscore that sits beneath a speaking voice: restrained, steady, " +
  "no sudden dynamic jumps, no drops, no build-and-release structure that would fight " +
  "the edit. Clean, uncluttered arrangement with space in the midrange where a voice sits.";

const NEGATIVE = "vocals, singing, lyrics, spoken word, rap, choir, applause, crowd noise, " +
  "sound effects, sudden silence, abrupt ending, distortion, clipping";

// The genres someone can actually ask for.
//
// Each one is a composer's brief, not a label. "Classical" on its own gets you an
// average of everything classical ever written; naming the instruments, the register
// and the tempo gets you a piece that belongs under a specific video. These are all
// written as UNDERSCORES — a string quartet recorded to be listened to would bury a
// voice no matter how hard the ducking worked.
//
// "auto" is deliberately kept as the default, because a score written from what the
// person is actually talking about is usually right. This exists for when it isn't.
const GENRES = {
  classical:  "Classical chamber underscore. Warm strings — violin, viola, cello — with restrained dynamics and long sustained lines. Elegant and composed, in the register of a chamber ensemble rather than a full orchestra. Around 70 BPM.",
  orchestral: "Cinematic orchestral underscore. Low strings and soft brass swells, subtle timpani, sweeping but controlled. Filmic and expansive without ever becoming a fanfare. Around 80 BPM.",
  piano:      "Solo piano underscore. Felt piano, close-recorded, gentle repeating figures with plenty of space between phrases. Intimate and unhurried. Around 68 BPM.",
  ambient:    "Ambient underscore. Warm synthesiser pads, slow evolving texture, soft analogue shimmer, no discernible beat. Weightless and atmospheric. Around 60 BPM.",
  acoustic:   "Acoustic underscore. Fingerpicked guitar, light upright bass, brushed percussion. Warm, organic and easy, golden-hour feeling. Around 90 BPM.",
  lofi:       "Lo-fi underscore. Soft dusty drums, mellow electric piano, warm vinyl texture and gentle tape wobble. Relaxed and unpressured. Around 82 BPM.",
  electronic: "Modern electronic underscore. Clean synth arpeggios, soft sub bass, crisp minimal percussion. Sleek and forward-moving without being aggressive. Around 100 BPM.",
  jazz:       "Jazz underscore. Brushed drums, walking upright bass, muted trumpet or soft rhodes, relaxed swing. Late-evening and effortless. Around 88 BPM."
};
const GENRE_IDS = Object.keys(GENRES);

// Fallbacks when the planner didn't write a brief — a look-matched bed rather than
// a generic one, so the score still belongs to the video it's under.
const BY_LOOK = {
  "cinematic:wolf":     "Warm, gilded orchestral underscore. Low strings, soft brass swells, brushed percussion. Confident and filmic, the sound of a story being told in retrospect. Around 85 BPM.",
  "cinematic:luxury":   "Airy modern-classical underscore. Felt piano, high sustained strings, light shimmer. Bright and clean, expensive-feeling and unhurried. Around 80 BPM.",
  "vlog:wolf":          "Warm, easy instrumental groove. Muted electric guitar, soft rhodes, relaxed live drums. Golden-hour feel, moving but never busy. Around 95 BPM.",
  "vlog:luxury":        "Bright, airy instrumental. Clean electric guitar, soft synth pads, light brushed percussion. Fresh and effortless. Around 100 BPM.",
  "tutorial:wolf":      "Calm, warm instrumental bed. Soft rhodes, gentle upright bass, minimal percussion. Steady and reassuring, nothing that pulls focus. Around 75 BPM.",
  "tutorial:luxury":    "Clean minimal instrumental bed. Felt piano and soft pads, almost no percussion. Quiet, focused, unobtrusive. Around 72 BPM.",
  "talkinghead:wolf":   "Understated warm instrumental. Low strings and soft rhodes, sparse percussion. Sits well behind a voice. Around 80 BPM.",
  "talkinghead:luxury": "Understated bright instrumental. Soft pads and felt piano, almost no percussion. Sits well behind a voice. Around 78 BPM."
};

export default async function handler(req, res) {
  if (req.method !== "POST") return res.status(405).json({ error: "Method not allowed" });
  try {
    const key = (process.env.WAVESPEED_API_KEY || "").trim();
    if (!key) return res.status(500).json({ error: "The music engine isn't configured yet." });

    const body = typeof req.body === "string" ? JSON.parse(req.body || "{}") : (req.body || {});
    const token = (req.headers.authorization || "").replace(/^Bearer\s+/i, "").trim();
    const userId = await getUserId(token);
    if (!userId) return res.status(401).json({ error: "Please log in again." });

    const style = ["vlog", "tutorial", "cinematic"].includes(body.style) ? body.style : "talkinghead";
    const look = body.look === "luxury" ? "luxury" : "wolf";

    // The planner's brief, written from the actual transcript. Sanitised the same
    // way b-roll prompts are — it comes from a language model and shouldn't be
    // trusted verbatim into a paid API call.
    const brief = String(body.prompt || "").trim().slice(0, 400);
    const genre = GENRE_IDS.includes(body.genre) ? body.genre : "auto";

    // A chosen genre decides the SOUND; the planner's brief still supplies the mood.
    //
    // Keeping both is the point. Genre alone gives a competent stock bed that could
    // sit under anyone's video. The brief alone gives something written for this
    // video but in whatever style the model felt like. Together you get a piece in
    // the style that was asked for, pitched at what the person is actually saying —
    // and the ordering matters, because the instruction is explicit that the brief
    // must not drag the instrumentation somewhere else.
    let musical;
    if (genre !== "auto") {
      musical = GENRES[genre] +
        (brief ? " Keep that instrumentation and style exactly. Use the following only to judge mood, energy and pacing — never to change the instruments or the genre: " + brief : "");
    } else {
      musical = brief || BY_LOOK[style + ":" + look] || BY_LOOK["talkinghead:wolf"];
    }
    const prompt = musical + " " + HOUSE_STYLE;

    const paid = await spend(token, MUSIC_COST, "video-editor:score");
    if (!paid.ok) return res.status(402).json({ error: paid.error });

    const input = { prompt, negative_prompt: NEGATIVE };
    // Lyria accepts a reference image to steer the mood. We already capture a frame
    // of the footage for the colour analysis, so the score can be written against
    // what the video actually looks like instead of a description of it — free, and
    // it is the difference between a score for this video and a score for any video.
    const frame = typeof body.frame === "string" ? body.frame : null;
    if (frame && /^https?:\/\//.test(frame)) input.image = frame;

    let r, data;
    try {
      r = await fetch("https://api.wavespeed.ai/api/v3/" + MODEL_PATH, {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: "Bearer " + key },
        body: JSON.stringify(input)
      });
      data = await r.json();
    } catch {
      await refund(userId, MUSIC_COST, "refund:score-unreachable");
      return res.status(502).json({ error: "Couldn't reach the music engine. Your credits were refunded." });
    }
    if (!r.ok) {
      await refund(userId, MUSIC_COST, "refund:score-submit");
      return res.status(r.status).json({ error: ((data && data.message) || "Music service error") + " Your credits were refunded." });
    }
    const id = data && data.data && data.data.id;
    if (!id) {
      await refund(userId, MUSIC_COST, "refund:score-noid");
      return res.status(502).json({ error: "No job id came back from the music engine. Your credits were refunded." });
    }

    await recordVideoJob(id, userId, MUSIC_COST);
    await logCost(id, userId, "lyria-3-pro-" + genre + "-" + style, MUSIC_COST, MUSIC_REAL_USD);

    // No "ff:" or "g:" prefix — a bare id is a WaveSpeed id, which is exactly what
    // /api/video-result polls by default. The app reuses pollVideo unchanged.
    return res.status(200).json({ id, balance: paid.balance, charged: MUSIC_COST });
  } catch (e) {
    return res.status(500).json({ error: "Server error: " + (e && e.message ? e.message : "unknown") });
  }
}
