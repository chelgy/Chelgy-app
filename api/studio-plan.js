// Chelgy AI Video Editor — STEP 2: plan the edit.
// Gemini reads the word-timestamped transcript and decides which segments to
// KEEP (cutting filler words, false starts, long dead air and rambling), plus
// writes a short on-screen title. Returns strict JSON the render step consumes.
// Free step (pennies); credits are charged at the render step.
// Env: GEMINI_API_KEY, SUPABASE_URL, SUPABASE_ANON_KEY

export const maxDuration = 60;

const SB_URL  = (process.env.SUPABASE_URL || "").trim();
const SB_ANON = (process.env.SUPABASE_ANON_KEY || "").trim();

async function getUserId(token) {
  if (!token) return null;
  try {
    const r = await fetch(SB_URL + "/auth/v1/user", { headers: { apikey: SB_ANON, Authorization: "Bearer " + token } });
    const u = await r.json();
    return r.ok && u && u.id ? u.id : null;
  } catch { return null; }
}

export default async function handler(req, res) {
  if (req.method !== "POST") return res.status(405).json({ error: "Method not allowed" });
  try {
    const body = typeof req.body === "string" ? JSON.parse(req.body || "{}") : (req.body || {});
    const words = Array.isArray(body.words) ? body.words : [];
    const duration = Number(body.duration) || 0;
    if (!words.length) return res.status(400).json({ error: "Missing transcript." });

    const GKEY = (process.env.GEMINI_API_KEY || "").trim();
    if (!GKEY) return res.status(500).json({ error: "The editor is not configured." });

    const token = (req.headers.authorization || "").replace(/^Bearer\s+/i, "").trim();
    const userId = await getUserId(token);
    if (!userId) return res.status(401).json({ error: "Please log in again." });

    // Compact word list: "word|start|end" per line (caps prompt size on long videos).
    const lines = words.slice(0, 4000).map(w => w.w + "|" + w.s + "|" + w.e).join("\n");

    const prompt =
      "You are a professional video editor cutting a talking-head video (one person speaking to camera).\n" +
      "Below is the transcript as word|startSeconds|endSeconds lines. Total length: " + duration + "s.\n\n" +
      "Decide which time segments to KEEP so the final cut is tight, confident and watchable:\n" +
      "- REMOVE filler words (um, uh, like when used as filler), false starts, repeated takes (keep the best take), long pauses and dead air, and rambling that doesn't add anything.\n" +
      "- KEEP the natural flow: never cut mid-word; start each kept segment ~0.15s before its first word and end ~0.25s after its last word.\n" +
      "- Merge keeps that are less than 0.5s apart into one segment. No kept segment shorter than 1s.\n" +
      "- Be decisive but not butcher-y: a good result usually keeps 70-90% of a well-delivered video, less if it's rambly.\n" +
      "- Segments must be in chronological order, non-overlapping, within 0.." + duration + ".\n\n" +
      "Also write:\n" +
      "- title: a short punchy on-screen opening title for this video (max 6 words, no quotes, no emojis).\n\n" +
      "Respond with ONLY this JSON, nothing else:\n" +
      '{"keep":[{"s":number,"e":number}],"title":"string"}\n\n' +
      "TRANSCRIPT:\n" + lines;

    const gr = await fetch(
      "https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent",
      {
        method: "POST",
        headers: { "x-goog-api-key": GKEY, "Content-Type": "application/json" },
        body: JSON.stringify({
          contents: [{ parts: [{ text: prompt }] }],
          generationConfig: { responseMimeType: "application/json", temperature: 0.2 }
        })
      }
    );
    const gdata = await gr.json();
    if (!gr.ok) {
      const msg = (gdata && gdata.error && gdata.error.message) || "Planning failed.";
      return res.status(502).json({ error: msg });
    }
    let text = "";
    try { text = gdata.candidates[0].content.parts[0].text; } catch {}
    let plan;
    try { plan = JSON.parse((text || "").replace(/```json|```/g, "").trim()); } catch {
      return res.status(502).json({ error: "The editor couldn't produce a valid plan. Please try again." });
    }

    // ── Sanitize: clamp, order, merge, drop invalid ──
    let keep = Array.isArray(plan.keep) ? plan.keep : [];
    keep = keep
      .map(k => ({ s: Math.max(0, Number(k.s) || 0), e: Math.min(duration || 1e9, Number(k.e) || 0) }))
      .filter(k => k.e - k.s >= 0.8)
      .sort((a, b) => a.s - b.s);
    const merged = [];
    for (const k of keep) {
      const last = merged[merged.length - 1];
      if (last && k.s - last.e < 0.5) last.e = Math.max(last.e, k.e);
      else merged.push({ ...k });
    }
    if (!merged.length) merged.push({ s: 0, e: Math.max(1, duration) }); // fallback: keep everything

    const title = (typeof plan.title === "string" ? plan.title : "").slice(0, 60);
    const outSeconds = Math.round(merged.reduce((t, k) => t + (k.e - k.s), 0) * 10) / 10;

    return res.status(200).json({ keep: merged, title, outSeconds });
  } catch (e) {
    return res.status(500).json({ error: "Server error: " + (e && e.message ? e.message : "unknown") });
  }
}
