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
    const frame = typeof body.frame === "string" ? body.frame : null; // small JPEG data URL of one frame
    const style = ["vlog","tutorial"].includes(body.style) ? body.style : "talkinghead";
    if (!words.length) return res.status(400).json({ error: "Missing transcript." });

    const GKEY = (process.env.GEMINI_API_KEY || "").trim();
    if (!GKEY) return res.status(500).json({ error: "The editor is not configured." });

    const token = (req.headers.authorization || "").replace(/^Bearer\s+/i, "").trim();
    const userId = await getUserId(token);
    if (!userId) return res.status(401).json({ error: "Please log in again." });

    // Compact word list: "word|start|end" per line (caps prompt size on long videos).
    const lines = words.slice(0, 4000).map(w => w.w + "|" + w.s + "|" + w.e).join("\n");

    const editorRole = style === "vlog"
      ? "You are a professional video editor AND colorist cutting a VLOG (real-world, day-in-the-life footage where the person talks while moving through places)."
      : style === "tutorial"
      ? "You are a professional video editor AND colorist cutting a TUTORIAL (one person teaching, sit-down, possibly with a screen). Clarity beats pace."
      : "You are a professional video editor AND colorist cutting a talking-head video (one person speaking to camera).";

    const tutorialRules =
        "Decide which time segments to KEEP so the tutorial is clear and easy to follow:\n" +
        "- REMOVE filler words (um, uh), false starts, repeated takes (keep the best take), and dead air over ~2.5s — but keep short thinking pauses; tutorials should feel calm, not rushed.\n" +
        "- KEEP the natural flow: never cut mid-word; start each kept segment ~0.15s before its first word and end ~0.35s after its last word.\n" +
        "- Merge keeps that are less than 1s apart into one segment. No kept segment shorter than 1s.\n" +
        "- A good tutorial cut usually keeps 80-95% of clear teaching.\n" +
        "- ALSO identify 2-6 SCENE INTROS: natural section starts in the teaching. Each label is a short cinematic intro to what comes next (2-5 words, title case) — like 'Setting Up', 'The First Step', 'The Common Mistake', 'Bringing It Together'. NEVER use the word Chapter. Give each one's start time (seconds, ORIGINAL timeline, at a sentence boundary).\n";
    const cutRules = style === "tutorial" ? tutorialRules : style === "vlog"
      ? ("Decide which time segments to KEEP so the vlog is punchy and keeps moving — but respect that vlogs have VISUAL moments:\n" +
         "- IMPORTANT: in a vlog, silence is NOT automatically dead air — quiet gaps under ~4 seconds are usually the person showing something, walking, or letting a moment breathe. KEEP those (extend the surrounding kept segment across them) unless they clearly drag.\n" +
         "- REMOVE filler words (um, uh, like when used as filler), false starts, repeated takes (keep the best take), and only truly long dead air (over ~4-5s of nothing).\n" +
         "- KEEP the natural flow: never cut mid-word; start each kept segment ~0.15s before its first word and end ~0.4s after its last word (vlogs breathe a little more).\n" +
         "- Merge keeps that are less than 4s apart into one segment (bridging the visual moments between them). No kept segment shorter than 1s.\n" +
         "- A good vlog cut usually keeps 75-92% of decent footage.\n" +
         "- ALSO identify 0-5 SCENE INTROS where the day clearly moves to a new moment — a place change, a time jump, a new activity. Each label is a short cinematic card introducing what comes next, in the vlogger's own context — like 'Arriving Home', 'The Next Day', 'Monday, 8:45 AM', 'Back In The Studio'. Use time/place words the speaker actually says when possible. NEVER use the word Chapter. Give each one's start time (seconds, ORIGINAL timeline). If the vlog has no clear scene changes, return an empty list.\n")
      : ("Decide which time segments to KEEP so the final cut is tight, confident and watchable:\n" +
         "- REMOVE filler words (um, uh, like when used as filler), false starts, repeated takes (keep the best take), long pauses and dead air, and rambling that doesn't add anything.\n" +
         "- KEEP the natural flow: never cut mid-word; start each kept segment ~0.15s before its first word and end ~0.25s after its last word.\n" +
         "- Merge keeps that are less than 0.5s apart into one segment. No kept segment shorter than 1s.\n" +
         "- Be decisive but not butcher-y: a good result usually keeps 70-90% of a well-delivered video, less if it's rambly.\n");

    const prompt =
      editorRole + "\n" +
      "Below is the transcript as word|startSeconds|endSeconds lines. Total length: " + duration + "s.\n" +
      (frame ? "A still frame from the footage is attached — use it ONLY for the color analysis below.\n" : "") +
      "\n" + cutRules +
      "- Segments must be in chronological order, non-overlapping, within 0.." + duration + ".\n\n" +
      "Also write:\n" +
      "- title: a short punchy on-screen opening title for this video (max 6 words, no quotes, no emojis).\n\n" +
      "COLOR ANALYSIS (as a colorist" + (frame ? ", from the attached frame" : ", assume neutral if no frame") + "):\n" +
      "- temperature: is the footage's white balance warm, neutral, or cool?\n" +
      "- exposure: is it dark, balanced, or bright?\n" +
      "(The render will adapt the cinematic grade to this so the look is applied correctly instead of blindly.)\n\n" +
      "Respond with ONLY this JSON, nothing else:\n" +
      (style !== "talkinghead"
        ? '{"keep":[{"s":number,"e":number}],"title":"string","chapters":[{"s":number,"label":"string"}],"look":{"temperature":"warm|neutral|cool","exposure":"dark|balanced|bright"}}\n\n'
        : '{"keep":[{"s":number,"e":number}],"title":"string","look":{"temperature":"warm|neutral|cool","exposure":"dark|balanced|bright"}}\n\n') +
      "TRANSCRIPT:\n" + lines;

    const parts = [];
    if (frame) {
      const m = frame.match(/^data:(.*?);base64,(.*)$/);
      if (m) parts.push({ inlineData: { mimeType: m[1] || "image/jpeg", data: m[2] || "" } });
    }
    parts.push({ text: prompt });

    const gr = await fetch(
      "https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent",
      {
        method: "POST",
        headers: { "x-goog-api-key": GKEY, "Content-Type": "application/json" },
        body: JSON.stringify({
          contents: [{ parts }],
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
    const mergeGap = style === "vlog" ? 4.0 : style === "tutorial" ? 1.0 : 0.5; // vlogs bridge visual moments; tutorials breathe
    const merged = [];
    for (const k of keep) {
      const last = merged[merged.length - 1];
      if (last && k.s - last.e < mergeGap) last.e = Math.max(last.e, k.e);
      else merged.push({ ...k });
    }
    if (!merged.length) merged.push({ s: 0, e: Math.max(1, duration) }); // fallback: keep everything

    const title = (typeof plan.title === "string" ? plan.title : "").slice(0, 60);
    const outSeconds = Math.round(merged.reduce((t, k) => t + (k.e - k.s), 0) * 10) / 10;

    // Sanitize the colorist classification to allowed values only.
    const L = plan.look || {};
    const look = {
      temperature: ["warm","neutral","cool"].includes(L.temperature) ? L.temperature : "neutral",
      exposure: ["dark","balanced","bright"].includes(L.exposure) ? L.exposure : "balanced"
    };

    // Sanitize chapters (tutorial only): valid times, short labels, max 6.
    let chapters = [];
    if (style !== "talkinghead" && Array.isArray(plan.chapters)) {
      chapters = plan.chapters
        .map(c => ({ s: Math.max(0, Number(c.s) || 0), label: String(c.label || "").trim().slice(0, 40) }))
        .filter(c => c.label && c.s < (duration || 1e9))
        .sort((a, b) => a.s - b.s)
        .slice(0, 6);
    }

    return res.status(200).json({ keep: merged, title, chapters, look, outSeconds });
  } catch (e) {
    return res.status(500).json({ error: "Server error: " + (e && e.message ? e.message : "unknown") });
  }
}
