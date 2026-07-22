// Chelgy AI Video Editor — SHOWCASE: direct a silent video by what's ON SCREEN.
//
// The transcript planner is useless here — an outfit-of-the-day, a jewelry reveal,
// a product haul often has no speech at all. So this planner LOOKS instead of
// listens. It's handed a strip of frames sampled across the video (each tagged with
// its timestamp) plus the creator's own note — "show my jewelry, it's from
// cherosi.com; show my shoes" — and it finds, by sight, WHEN each named thing is on
// screen and WHERE in the frame it sits.
//
// It returns, per item:
//   - t:      the timestamp where that thing is best shown
//   - label:  the on-screen text the creator asked for
//   - pos:    "upper" | "lower" — whether the product sits high or low in frame, so
//             the render can place the label on the OPPOSITE side and never cover it
//
// Placement note baked into the design: labels go NEAR the product, pulled toward
// centre — never the bottom third, which on TikTok/Reels is buried under the app's
// own captions, username and buttons. That instruction lives here so the model
// reports position with that use in mind.
//
// Charged as a plan step (vision is the cost). Logged to cost_log so the real
// per-edit number is visible, since frame count drives it.
// Env: ANTHROPIC_API_KEY, GEMINI_API_KEY, SUPABASE_URL, SUPABASE_ANON_KEY, SUPABASE_SERVICE_ROLE_KEY

export const maxDuration = 90;

const SB_URL  = (process.env.SUPABASE_URL || "").trim();
const SB_ANON = (process.env.SUPABASE_ANON_KEY || "").trim();
const SB_SVC  = (process.env.SUPABASE_SERVICE_ROLE_KEY || "").trim();

const CLAUDE_MODEL = (process.env.PLANNER_MODEL || "claude-opus-4-8").trim();
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const overloaded = (s) => /overloaded|high demand|try again later|unavailable|resource[_ ]?exhausted|rate limit|quota/i.test(String(s || ""));

async function getUserId(token) {
  if (!token) return null;
  try {
    const r = await fetch(SB_URL + "/auth/v1/user", { headers: { apikey: SB_ANON, Authorization: "Bearer " + token } });
    const u = await r.json();
    return r.ok && u && u.id ? u.id : null;
  } catch { return null; }
}
async function logCost(userId, model, credits, estUsd, frames) {
  try {
    await fetch(SB_URL + "/rest/v1/cost_log", {
      method: "POST",
      headers: { apikey: SB_SVC, Authorization: "Bearer " + SB_SVC, "Content-Type": "application/json", Prefer: "return=minimal" },
      body: JSON.stringify({ id: "showcase:" + Date.now() + ":" + Math.random().toString(36).slice(2,7),
        user_id: userId, tool: "video_editor", model, duration: frames, credits_charged: credits, est_usd: estUsd })
    });
  } catch {}
}

// Vision call to Claude. Frames come in as { t, data:"data:image/jpeg;base64,..." }.
async function callClaudeVision(AKEY, system, frames, instruction) {
  const content = [];
  for (const f of frames) {
    const m = String(f.data || "").match(/^data:(.*?);base64,(.*)$/);
    if (!m) continue;
    // A tiny text marker before each image so the model can tie an image to its time.
    content.push({ type: "text", text: "[frame @ " + f.t + "s]" });
    content.push({ type: "image", source: { type: "base64", media_type: m[1] || "image/jpeg", data: m[2] || "" } });
  }
  content.push({ type: "text", text: instruction });

  let lastErr = "The showcase planner is busy. Please try again.";
  for (let i = 0; i < 3; i++) {
    try {
      const r = await fetch("https://api.anthropic.com/v1/messages", {
        method: "POST",
        headers: { "x-api-key": AKEY, "anthropic-version": "2023-06-01", "Content-Type": "application/json" },
        body: JSON.stringify({
          // No temperature: Opus 4.8 (the planner default) deprecated the parameter
          // and rejects the request if it's present. The default sampling is fine for
          // a JSON extraction task like this.
          model: CLAUDE_MODEL, max_tokens: 2000, system,
          messages: [{ role: "user", content }]
        })
      });
      const d = await r.json().catch(() => ({}));
      if (!r.ok) {
        lastErr = (d && d.error && d.error.message) || ("Model error " + r.status);
        if (r.status === 429 || r.status >= 500 || overloaded(lastErr)) { await sleep(1200 * (i + 1)); continue; }
        return { ok: false, error: lastErr };
      }
      const text = (Array.isArray(d.content) ? d.content : []).map(b => b && b.type === "text" ? b.text : "").join("");
      if (!text) { lastErr = "Empty response."; await sleep(1200 * (i + 1)); continue; }
      return { ok: true, text };
    } catch (e) {
      lastErr = (e && e.message) || "Network error.";
      await sleep(1200 * (i + 1));
    }
  }
  return { ok: false, error: lastErr };
}

export default async function handler(req, res) {
  if (req.method !== "POST") return res.status(405).json({ error: "Method not allowed" });
  try {
    const AKEY = (process.env.ANTHROPIC_API_KEY || "").trim();
    if (!AKEY) return res.status(500).json({ error: "The showcase planner isn't configured." });

    const body = typeof req.body === "string" ? JSON.parse(req.body || "{}") : (req.body || {});
    const token = (req.headers.authorization || "").replace(/^Bearer\s+/i, "").trim();
    const userId = await getUserId(token);
    if (!userId) return res.status(401).json({ error: "Please log in again." });

    const frames = Array.isArray(body.frames) ? body.frames.slice(0, 40) : [];
    const note = String(body.note || "").trim().slice(0, 1200);
    const duration = Number(body.duration) || 0;
    const mode = body.mode === "process" ? "process" : "showcase";
    // Process can carry a transcript (a cooking video where the person also narrates)
    // and the cheap activity track as extra signal. Both optional.
    const words = Array.isArray(body.words) ? body.words : [];
    const activity = Array.isArray(body.activity) ? body.activity : null;
    if (!frames.length) return res.status(400).json({ error: "No frames to look at." });
    if (mode === "showcase" && !note) return res.status(400).json({ error: "Tell Chelgy what to show — e.g. \"show my jewelry from cherosi.com, show my shoes.\"" });

    // ── PROCESS: cut a how-to / cooking / cleaning / GRWM video BY SIGHT ──
    if (mode === "process") {
      const wordLines = words.length
        ? "\nTRANSCRIPT (word|start|end) — use it too; if they explain a step, that moment matters:\n" +
          words.slice(0, 4000).map(w => (w.w || "") + "|" + (Number(w.s)||0).toFixed(1) + "|" + (Number(w.e)||0).toFixed(1)).join("\n") + "\n"
        : "\n(This video has little or no speech — cut it by what you SEE.)\n";
      const actLine = activity && activity.length
        ? "\nACTIVITY HINT — one number per second, 0 (still) to 9 (lots of motion). Use it as a hint for where to LOOK, but trust your own eyes over it:\n" + activity.join(",") + "\n"
        : "";

      const sys =
        "You are a professional video editor cutting a PROCESS video — cooking, cleaning, a build, a craft, a get-ready-with-me — by actually LOOKING at frames sampled from it. " +
        "Each image is preceded by its timestamp like [frame @ 6.5s]. You can SEE what is happening at each moment, which is far better than guessing from motion alone. " +
        "The whole point of this video is the DOING, and much of the best footage is silent. Reply with ONE raw JSON object and nothing else — no prose, no explanation, no markdown code fences.";

      const instruction =
        (note ? "THE CREATOR'S DIRECTION (follow this above all — it outranks the general rules):\n\"" + note + "\"\n\n" : "") +
        "The video is " + (duration || "?") + " seconds long." + wordLines + actLine + "\n" +
        "Looking at the actual frames, decide which time ranges to KEEP so the finished video shows the process clearly and keeps moving:\n" +
        "- KEEP the real work you can SEE happening — chopping, searing, plating, wiping, assembling, applying makeup — even when it is silent. This is the video.\n" +
        "- KEEP the finished result / reveal shots. These are often visually STILL (a plated dish, a clean room, the final look) so a motion score would wrongly cut them — but they are the most important shots. Your eyes catch what motion cannot.\n" +
        "- KEEP talking where the person explains what they're doing.\n" +
        "- CUT genuinely dead footage you can see is empty: an abandoned counter, someone out of frame, fumbling, long nothing.\n" +
        "- COMPRESS repetitive work — 40 seconds of continuous stirring becomes 6-10 seconds. Show that it happened, don't play all of it.\n" +
        "- Keep segments in chronological order, non-overlapping, within 0.." + (duration || 0) + ". No kept segment shorter than 1s. Merge keeps less than 1.5s apart.\n" +
        "- ALSO give 2-6 SCENE CARDS at real stage changes you can see — 'Prepping The Base', 'Into The Oven', 'The Messy Part', 'Finishing Touches'. 2-5 words, title case, never the word Chapter. Each with its start time (seconds).\n" +
        "- ALSO give 0-3 B-ROLL moments where a full-screen photo would help (an ingredient, the finished result). Each with s (seconds) and a NEUTRAL photographic prompt — no grading words; the render applies the film look itself.\n\n" +
        "Respond with ONLY this JSON, nothing else:\n" +
        '{"keep":[{"s":number,"e":number}],"title":"string","chapters":[{"s":number,"label":"string"}],"broll":[{"s":number,"prompt":"string"}],"music":{"prompt":"string"},"look":{"temperature":"warm|neutral|cool","exposure":"dark|balanced|bright"}}';

      const g = await callClaudeVision(AKEY, sys, frames, instruction);
      if (!g.ok) return res.status(502).json({ error: g.error });
      let plan;
      try { plan = JSON.parse((g.text || "").replace(/```json|```/g, "").trim()); } catch {
        return res.status(502).json({ error: "The editor couldn't read the footage. Please try again." });
      }
      // Sanitize into the exact shape the app's plan consumer expects.
      const keep = (Array.isArray(plan.keep) ? plan.keep : [])
        .map(k => ({ s: Math.max(0, Number(k.s)||0), e: Math.max(0, Number(k.e)||0) }))
        .filter(k => k.e > k.s + 0.2)
        .sort((a,b)=>a.s-b.s);
      const chapters = (Array.isArray(plan.chapters) ? plan.chapters : [])
        .map(c => ({ s: Math.max(0, Number(c.s)||0), label: String(c.label||"").trim().slice(0,40) }))
        .filter(c => c.label).slice(0, 6);
      const broll = (Array.isArray(plan.broll) ? plan.broll : [])
        .map(b => ({ s: Math.max(0, Number(b.s)||0), prompt: String(b.prompt||"").trim().slice(0,300) }))
        .filter(b => b.prompt).slice(0, 3);
      const look = {
        temperature: ["warm","neutral","cool"].includes(plan.look&&plan.look.temperature) ? plan.look.temperature : "neutral",
        exposure: ["dark","balanced","bright"].includes(plan.look&&plan.look.exposure) ? plan.look.exposure : "balanced"
      };
      const music = { prompt: String((plan.music&&plan.music.prompt)||"").trim().slice(0,400) };

      const estUsd = Math.round((frames.length * 600 / 1e6) * 5 * 10000) / 10000;
      await logCost(userId, "process-vision-" + frames.length + "frames", 0, estUsd, frames.length);

      if (!keep.length) return res.status(502).json({ error: "The editor couldn't find footage worth keeping. Try again, or trim any long empty stretches first." });
      return res.status(200).json({ keep, title: String(plan.title||"").trim().slice(0,60), chapters, broll, music, look });
    }

    const system =
      "You are directing a SILENT product/outfit video by looking at frames sampled from it. " +
      "Each image is preceded by its timestamp like [frame @ 6.5s]. The creator has told you what to feature and what to label it. " +
      "Your job: for each thing they named, find the frame where it is shown BEST (clearest, most centred, fully in view), and note where in the frame it sits. Reply with ONE raw JSON object and nothing else — no prose, no explanation, no markdown code fences.";

    const instruction =
      "THE CREATOR'S DIRECTION:\n\"" + note + "\"\n\n" +
      "The video is " + (duration ? duration + " seconds long" : "short") + ". Looking at the frames above:\n" +
      "- For EACH distinct thing the creator asked to show (each product, each item), pick the single timestamp where it is shown best.\n" +
      "- Give the exact label text they want on screen for it. If they gave a source like a website, include it (e.g. \"Jewelry · cherosi.com\"). Keep labels short — a few words. Title case looks best. If they didn't specify text for an item, write a clean short label yourself (e.g. \"The Shoes\").\n" +
      "- Say whether the item sits in the UPPER or LOWER half of the frame, so the label can be placed on the opposite side and never cover the product.\n" +
      "- Only include things you can actually SEE in the frames. Do not invent a moment for something that never appears.\n" +
      "- Order by timestamp. At most 8 items.\n\n" +
      "Respond with ONLY this JSON, nothing else:\n" +
      '{"items":[{"t":number,"label":"string","pos":"upper|lower"}]}';

    const g = await callClaudeVision(AKEY, system, frames, instruction);
    if (!g.ok) return res.status(502).json({ error: g.error });

    let plan;
    try { plan = JSON.parse((g.text || "").replace(/```json|```/g, "").trim()); } catch {
      return res.status(502).json({ error: "The showcase planner couldn't read the footage. Please try again." });
    }

    // Sanitize: valid times, real labels, allowed position, cap at 8.
    const items = (Array.isArray(plan.items) ? plan.items : [])
      .map(it => ({
        t: Math.max(0, Math.min(duration || 1e9, Number(it.t) || 0)),
        label: String(it.label || "").trim().slice(0, 60),
        pos: it.pos === "lower" ? "lower" : "upper"
      }))
      .filter(it => it.label)
      .sort((a, b) => a.t - b.t)
      .slice(0, 8);

    // Rough cost: frames are the driver. Opus vision ~$5/Mtok in; a 512px frame is
    // ~600 tokens. Report it so margin stays visible.
    const estUsd = Math.round((frames.length * 600 / 1e6) * 5 * 10000) / 10000;
    await logCost(userId, "showcase-" + frames.length + "frames", 0, estUsd, frames.length);

    return res.status(200).json({ items });
  } catch (e) {
    return res.status(500).json({ error: "Server error: " + (e && e.message ? e.message : "unknown") });
  }
}
