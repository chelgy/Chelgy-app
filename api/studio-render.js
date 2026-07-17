// Chelgy AI Video Editor — STEP 3: render the edit.
// Charges the flat credit price, then builds a Creatomate RenderScript:
//  - one trimmed video clip per kept segment (trim_start/trim_duration), laid
//    end-to-end with explicit times
//  - animated word-by-word captions per clip (Creatomate's transcript_source
//    with the "highlight" karaoke effect)
//  - the chosen cinematic grade as a full-frame translucent color wash
//    (Wolf 2383 warm-gold, or Luxury Vlog creamy-bright)
//  - a luxury-serif opening title
// Submits to POST https://api.creatomate.com/v2/renders and returns the render
// id (prefixed "cm:") for /api/studio-status to poll. Refund on submit failure.
// Env: CREATOMATE_API_KEY, SUPABASE_URL, SUPABASE_ANON_KEY, SUPABASE_SERVICE_ROLE_KEY

export const maxDuration = 60;

const SB_URL  = (process.env.SUPABASE_URL || "").trim();
const SB_ANON = (process.env.SUPABASE_ANON_KEY || "").trim();
const SB_SVC  = (process.env.SUPABASE_SERVICE_ROLE_KEY || "").trim();
const STUDIO_COST = 2000;        // flat — Quick Edit tier (talking-head)
const MAX_RAW_SECONDS = 600;     // 10 minutes of raw footage max

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
      body: JSON.stringify({ id: String(id), user_id: userId, tool: "video_editor", model, duration: Math.round(duration) || null, credits_charged: credits, est_usd: estUsd })
    });
  } catch {}
}

// The two signature grades, as full-frame translucent washes (built from
// guaranteed Creatomate primitives so nothing exotic can fail the render).
const GRADES = {
  wolf:   { fill: "rgba(255,166,77,0.12)" },  // Wolf 2383 — warm golden, glossy, filmic
  luxury: { fill: "rgba(255,246,232,0.14)" }  // Luxury Vlog — bright, creamy, airy
};

export default async function handler(req, res) {
  if (req.method !== "POST") return res.status(405).json({ error: "Method not allowed" });
  try {
    const body = typeof req.body === "string" ? JSON.parse(req.body || "{}") : (req.body || {});
    const url = body.url;
    const keep = Array.isArray(body.keep) ? body.keep : [];
    const title = (typeof body.title === "string" ? body.title : "").slice(0, 60);
    const grade = body.grade === "luxury" ? "luxury" : "wolf";
    const orientation = body.orientation === "landscape" ? "landscape" : "portrait";
    const rawDuration = Number(body.rawDuration) || 0;
    if (!url || !/^https?:\/\//.test(url)) return res.status(400).json({ error: "Missing video URL." });
    if (!keep.length) return res.status(400).json({ error: "Missing edit plan." });
    if (rawDuration > MAX_RAW_SECONDS) return res.status(400).json({ error: "Raw footage is limited to 10 minutes for now." });

    const CM = (process.env.CREATOMATE_API_KEY || "").trim();
    if (!CM) return res.status(500).json({ error: "The editor is not configured yet (render key missing)." });

    const token = (req.headers.authorization || "").replace(/^Bearer\s+/i, "").trim();
    const userId = await getUserId(token);
    if (!userId) return res.status(401).json({ error: "Please log in again." });

    // ── Sanitize segments server-side (never trust the client blindly) ──
    const segs = keep
      .map(k => ({ s: Math.max(0, Number(k.s) || 0), e: Number(k.e) || 0 }))
      .filter(k => k.e - k.s >= 0.8)
      .sort((a, b) => a.s - b.s)
      .slice(0, 120);
    if (!segs.length) return res.status(400).json({ error: "The edit plan came back empty." });
    const outSeconds = segs.reduce((t, k) => t + (k.e - k.s), 0);

    // ── Build the RenderScript ──
    const W = orientation === "landscape" ? 1920 : 1080;
    const H = orientation === "landscape" ? 1080 : 1920;
    const elements = [];
    let cursor = 0;
    segs.forEach((k, i) => {
      const d = Math.round((k.e - k.s) * 100) / 100;
      const name = "clip-" + i;
      elements.push({
        type: "video", track: 1, name,
        time: Math.round(cursor * 100) / 100,
        source: url,
        trim_start: k.s,
        trim_duration: d,
        fit: "cover"
      });
      // Word-by-word animated captions for this clip
      elements.push({
        type: "text", track: 2,
        time: Math.round(cursor * 100) / 100,
        duration: d,
        transcript_source: name,
        transcript_effect: "highlight",
        transcript_maximum_length: 14,
        y: "80%", width: "82%", height: "30%",
        x_alignment: "50%", y_alignment: "50%",
        fill_color: "#ffffff",
        stroke_color: "#000000", stroke_width: "1.4 vmin",
        font_family: "Montserrat", font_weight: "700", font_size: orientation === "landscape" ? "5.2 vmin" : "7.6 vmin"
      });
      cursor += d;
    });
    // Cinematic grade — full-frame translucent wash on the top track
    elements.push({
      type: "composition", track: 3, time: 0, duration: Math.round(cursor * 100) / 100,
      width: "100%", height: "100%", fill_color: GRADES[grade].fill
    });
    // Luxury opening title
    if (title) {
      elements.push({
        type: "text", track: 4, time: 0.4, duration: 2.8,
        text: title,
        y: "44%", width: "84%", height: "26%",
        x_alignment: "50%", y_alignment: "50%",
        fill_color: "#ffffff",
        stroke_color: "rgba(0,0,0,0.55)", stroke_width: "0.6 vmin",
        font_family: "Playfair Display", font_weight: "700",
        font_size: orientation === "landscape" ? "7 vmin" : "9 vmin"
      });
    }

    // ── Charge, then submit ──
    const paid = await spend(token, STUDIO_COST, "video-editor:talkinghead");
    if (!paid.ok) return res.status(402).json({ error: paid.error });

    const cr = await fetch("https://api.creatomate.com/v2/renders", {
      method: "POST",
      headers: { Authorization: "Bearer " + CM, "Content-Type": "application/json" },
      body: JSON.stringify({ output_format: "mp4", width: W, height: H, frame_rate: 30, elements })
    });
    const cdata = await cr.json();
    if (!cr.ok) {
      await refund(userId, STUDIO_COST, "refund:video-editor-submit");
      const msg = (cdata && (cdata.message || (cdata.error && cdata.error.message))) || "Render service error";
      return res.status(cr.status).json({ error: String(msg) + " Your credits were refunded." });
    }
    const render = Array.isArray(cdata) ? cdata[0] : cdata;
    const rid = render && render.id;
    if (!rid) {
      await refund(userId, STUDIO_COST, "refund:video-editor-noid");
      return res.status(502).json({ error: "No render id returned. Your credits were refunded." });
    }

    await recordVideoJob("cm:" + rid, userId, STUDIO_COST);
    // Real-cost estimate: transcription+plan (~$0.05) + render minutes (~$0.12/min of output)
    const estUsd = Math.round((0.05 + 0.12 * (outSeconds / 60)) * 10000) / 10000;
    await logCost("cm:" + rid, userId, "creatomate-talkinghead-" + grade, outSeconds, STUDIO_COST, estUsd);
    return res.status(200).json({ id: "cm:" + rid, balance: paid.balance });
  } catch (e) {
    return res.status(500).json({ error: "Server error: " + (e && e.message ? e.message : "unknown") });
  }
}
