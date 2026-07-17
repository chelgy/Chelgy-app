// Chelgy AI Video Editor — VIRAL CLIPS.
// From one piece of footage, finds the 2-3 strongest self-contained moments
// (15-45s each), writes a scroll-stopping on-screen hook for each, and renders
// them as vertical 9:16 clips with karaoke captions and the cinematic grade —
// ready for Reels / TikTok / Shorts.
// One flat charge covers the planning AND all clip renders. Each render is
// recorded with its share of the cost so a failed clip auto-refunds its share
// via /api/studio-status.
// Env: GEMINI_API_KEY, CREATOMATE_API_KEY, SUPABASE_URL, SUPABASE_ANON_KEY, SUPABASE_SERVICE_ROLE_KEY

export const maxDuration = 60;

const SB_URL  = (process.env.SUPABASE_URL || "").trim();
const SB_ANON = (process.env.SUPABASE_ANON_KEY || "").trim();
const SB_SVC  = (process.env.SUPABASE_SERVICE_ROLE_KEY || "").trim();
const SHORTS_COST = 1500; // flat — up to 3 viral clips from one video

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
async function recordVideoJob(id, userId, cost) {
  try {
    await fetch(SB_URL + "/rest/v1/video_jobs", {
      method: "POST",
      headers: { apikey: SB_SVC, Authorization: "Bearer " + SB_SVC, "Content-Type": "application/json", Prefer: "return=minimal" },
      body: JSON.stringify({ id: String(id), user_id: userId, cost })
    });
  } catch {}
}
async function logCost(id, userId, model, duration, credits, estUsd) {
  try {
    await fetch(SB_URL + "/rest/v1/cost_log", {
      method: "POST",
      headers: { apikey: SB_SVC, Authorization: "Bearer " + SB_SVC, "Content-Type": "application/json", Prefer: "return=minimal" },
      body: JSON.stringify({ id: String(id), user_id: userId, tool: "viral_clips", model, duration: Math.round(duration) || null, credits_charged: credits, est_usd: estUsd })
    });
  } catch {}
}
function gradeFor(grade, look) {
  const t = (look && look.temperature) || "neutral";
  const x = (look && look.exposure) || "balanced";
  if (grade === "luxury") {
    let a = x === "dark" ? 0.34 : x === "bright" ? 0.20 : 0.27;
    if (t === "warm") a = Math.max(0.16, a - 0.05);
    const contrast = x === "bright" ? 26 : 20;
    return { color_filter: "contrast", color_filter_value: contrast + "%", color_overlay: "rgba(255,242,225," + a.toFixed(2) + ")" };
  }
  let a = t === "cool" ? 0.40 : t === "warm" ? 0.24 : 0.33;
  if (x === "dark") a = Math.max(0.20, a - 0.06);
  if (x === "bright") a = Math.min(0.42, a + 0.03);
  const contrast = x === "dark" ? 30 : 42;
  return { color_filter: "contrast", color_filter_value: contrast + "%", color_overlay: "rgba(255,150,45," + a.toFixed(2) + ")" };
}

export default async function handler(req, res) {
  if (req.method !== "POST") return res.status(405).json({ error: "Method not allowed" });
  try {
    const body = typeof req.body === "string" ? JSON.parse(req.body || "{}") : (req.body || {});
    const url = body.url;
    const words = Array.isArray(body.words) ? body.words : [];
    const duration = Number(body.duration) || 0;
    const frame = typeof body.frame === "string" ? body.frame : null;
    const grade = body.grade === "luxury" ? "luxury" : "wolf";
    if (!url || !/^https?:\/\//.test(url)) return res.status(400).json({ error: "Missing video URL." });
    if (!words.length) return res.status(400).json({ error: "Missing transcript." });

    const GKEY = (process.env.GEMINI_API_KEY || "").trim();
    const CM = (process.env.CREATOMATE_API_KEY || "").trim();
    if (!GKEY || !CM) return res.status(500).json({ error: "The clip maker is not configured yet." });

    const token = (req.headers.authorization || "").replace(/^Bearer\s+/i, "").trim();
    const userId = await getUserId(token);
    if (!userId) return res.status(401).json({ error: "Please log in again." });

    // ── Charge once for the whole pack ──
    const paid = await spend(token, SHORTS_COST, "viral-clips");
    if (!paid.ok) return res.status(402).json({ error: paid.error });

    // ── Find the strongest moments + hooks (and the colorist look) ──
    const lines = words.slice(0, 4000).map(w => w.w + "|" + w.s + "|" + w.e).join("\n");
    const prompt =
      "You are a short-form video strategist. Below is a transcript as word|startSeconds|endSeconds lines from a " + duration + "s video.\n\n" +
      "Find the 2-3 STRONGEST self-contained moments to publish as viral vertical clips:\n" +
      "- Each clip must be 15-45 seconds, make complete sense on its own, and start at a natural sentence boundary (~0.15s before its first word).\n" +
      "- Prefer moments with a strong claim, a story beat, a surprising fact, an emotional spike, or a clear payoff.\n" +
      "- Clips must not overlap.\n" +
      "- For each clip write a HOOK: the on-screen text shown at the top (max 8 words, punchy, curiosity or bold claim, no emojis, no hashtags, never a greeting).\n" +
      (frame ? "\nA still frame is attached — also classify the footage color: temperature (warm|neutral|cool) and exposure (dark|balanced|bright).\n" : "") +
      "\nRespond ONLY with this JSON:\n" +
      '{"clips":[{"s":number,"e":number,"hook":"string"}],"look":{"temperature":"warm|neutral|cool","exposure":"dark|balanced|bright"}}\n\n' +
      "TRANSCRIPT:\n" + lines;

    const parts = [];
    if (frame) {
      const m = frame.match(/^data:(.*?);base64,(.*)$/);
      if (m) parts.push({ inlineData: { mimeType: m[1] || "image/jpeg", data: m[2] || "" } });
    }
    parts.push({ text: prompt });

    const gr = await fetch("https://generativelanguage.googleapis.com/v1beta/models/gemini-flash-latest:generateContent", {
      method: "POST",
      headers: { "x-goog-api-key": GKEY, "Content-Type": "application/json" },
      body: JSON.stringify({ contents: [{ parts }], generationConfig: { responseMimeType: "application/json", temperature: 0.4 } })
    });
    const gdata = await gr.json();
    if (!gr.ok) {
      await refund(userId, SHORTS_COST, "refund:viral-clips-plan");
      return res.status(502).json({ error: ((gdata && gdata.error && gdata.error.message) || "Couldn't plan the clips.") + " Your credits were refunded." });
    }
    let out;
    try { out = JSON.parse(gdata.candidates[0].content.parts[0].text.replace(/```json|```/g, "").trim()); } catch {
      await refund(userId, SHORTS_COST, "refund:viral-clips-plan");
      return res.status(502).json({ error: "Couldn't plan the clips. Your credits were refunded — please try again." });
    }
    let clips = (Array.isArray(out.clips) ? out.clips : [])
      .map(c => ({ s: Math.max(0, Number(c.s) || 0), e: Math.min(duration || 1e9, Number(c.e) || 0), hook: String(c.hook || "").trim().slice(0, 70) }))
      .filter(c => c.e - c.s >= 12 && c.e - c.s <= 60)
      .sort((a, b) => a.s - b.s)
      .slice(0, 3);
    if (!clips.length) {
      await refund(userId, SHORTS_COST, "refund:viral-clips-none");
      return res.status(422).json({ error: "Couldn't find strong stand-alone moments in that footage. Your credits were refunded — try a longer or meatier video." });
    }
    const L = out.look || {};
    const look = {
      temperature: ["warm","neutral","cool"].includes(L.temperature) ? L.temperature : "neutral",
      exposure: ["dark","balanced","bright"].includes(L.exposure) ? L.exposure : "balanced"
    };

    // ── Render each clip: vertical, hook on top, karaoke captions, grade ──
    const perClipCost = Math.floor(SHORTS_COST / clips.length);
    const ids = [];
    const hooks = [];
    for (const c of clips) {
      const d = Math.round((c.e - c.s) * 100) / 100;
      const gp = gradeFor(grade, c.look || look); // per-clip grade from its colorist read
      const elements = [
        { type: "video", track: 1, name: "clip", time: 0, source: url, trim_start: c.s, trim_duration: d, fit: "cover", color_filter: gp.color_filter, color_filter_value: gp.color_filter_value, color_overlay: gp.color_overlay },
        { type: "text", track: 2, time: 0, duration: d,
          transcript_source: "clip", transcript_effect: "highlight", transcript_maximum_length: 14,
          y: "80%", width: "82%", height: "30%", x_alignment: "50%", y_alignment: "50%",
          fill_color: "#ffffff", stroke_color: "#000000", stroke_width: "1.4 vmin",
          font_family: "Montserrat", font_weight: "700", font_size: "7.6 vmin" },
        // (grade applied on the clip pixels above)
      ];
      if (c.hook) {
        elements.push({
          type: "text", track: 4, time: 0, duration: Math.min(3.2, d),
          text: c.hook,
          y: "14%", width: "88%", height: "20%", x_alignment: "50%", y_alignment: "50%",
          fill_color: "#ffffff",
          background_color: "rgba(17,17,17,0.62)", background_x_padding: "30%", background_y_padding: "16%", background_border_radius: "18%",
          font_family: "Montserrat", font_weight: "800", font_size: "6.4 vmin"
        });
      }
      const cr = await fetch("https://api.creatomate.com/v2/renders", {
        method: "POST",
        headers: { Authorization: "Bearer " + CM, "Content-Type": "application/json" },
        body: JSON.stringify({ output_format: "mp4", width: 1080, height: 1920, frame_rate: 30, elements })
      });
      const cdata = await cr.json();
      const render = Array.isArray(cdata) ? cdata[0] : cdata;
      const rid = cr.ok && render && render.id;
      if (rid) {
        ids.push("cm:" + rid);
        hooks.push(c.hook || "");
        await recordVideoJob("cm:" + rid, userId, perClipCost);
        const estUsd = Math.round((0.03 + 0.12 * (d / 60)) * 10000) / 10000;
        await logCost("cm:" + rid, userId, "creatomate-short-" + grade, d, perClipCost, estUsd);
      }
    }
    if (!ids.length) {
      await refund(userId, SHORTS_COST, "refund:viral-clips-submit");
      return res.status(502).json({ error: "Couldn't start the clip renders. Your credits were refunded." });
    }

    return res.status(200).json({ ids, hooks, balance: paid.balance });
  } catch (e) {
    return res.status(500).json({ error: "Server error: " + (e && e.message ? e.message : "unknown") });
  }
}
