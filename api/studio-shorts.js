// Chelgy AI Video Editor — VIRAL CLIPS.
// From one piece of footage, finds the 2-3 strongest self-contained moments
// (15-45s each), writes a scroll-stopping on-screen hook for each, and renders
// them as vertical 9:16 clips with karaoke captions and the cinematic grade —
// ready for Reels / TikTok / Shorts.
// One flat charge covers the planning AND all clip renders. Each render is
// recorded with its share of the cost so a failed clip auto-refunds its share
// via /api/studio-status.
// RENDERED BY THE CHELGY RENDER SERVER, NOT CREATOMATE.
// Clips used to go to Creatomate, which meant a second captioning system: Montserrat
// with a 1.4vmin black stroke, ~19% larger type, and a colour overlay standing in for
// the grade. The main edit uses Caveline with no outline and a real 3D LUT. They could
// never match by tuning, because they were different renderers. A clip is just a
// one-segment edit, so it now goes through the same /plan pipeline and inherits the
// title, the rule under it, the caption style and the LUT automatically.
// Env: GEMINI_API_KEY, RENDER_SERVER_URL, RENDER_SECRET, SUPABASE_URL, SUPABASE_ANON_KEY, SUPABASE_SERVICE_ROLE_KEY

export const maxDuration = 60;

const SB_URL  = (process.env.SUPABASE_URL || "").trim();
const SB_ANON = (process.env.SUPABASE_ANON_KEY || "").trim();
const SB_SVC  = (process.env.SUPABASE_SERVICE_ROLE_KEY || "").trim();
const SHORTS_COST = 1500; // flat — up to 3 viral clips from one video
const RS_URL = (process.env.RENDER_SERVER_URL || "").trim().replace(/\/+$/, "");
const RS_SECRET = (process.env.RENDER_SECRET || "").trim();

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
// gradeFor() used to translate the grade into Creatomate colour filters — a wash
// approximating the look. The render server applies the actual LUT chain, so there is
// nothing left to approximate and the function is gone.

// ── Resilient Gemini call: retries the primary model, and if it's shedding load
// (503/429, or an overloaded/high-demand message returned even inside a 200),
// automatically falls back to a stable pinned model so callers never see it.
const GEMINI_PRIMARY = "gemini-flash-latest";
const GEMINI_FALLBACK = "gemini-3.1-flash-lite"; // stable Gemini 3, low-demand safety net (longer runway than 2.5)
async function callGemini(GKEY, payload) {
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const overloaded = (s) => /overloaded|high demand|try again later|unavailable|resource[_ ]?exhausted|rate limit|quota/i.test(String(s || ""));
  const models = [GEMINI_PRIMARY, GEMINI_PRIMARY, GEMINI_PRIMARY, GEMINI_FALLBACK]; // 3 tries on primary, then fallback
  let lastErr = "The editor is busy. Please try again in a moment.";
  for (let i = 0; i < models.length; i++) {
    try {
      const gr = await fetch(
        "https://generativelanguage.googleapis.com/v1beta/models/" + models[i] + ":generateContent",
        { method: "POST", headers: { "x-goog-api-key": GKEY, "Content-Type": "application/json" }, body: JSON.stringify(payload) }
      );
      const gdata = await gr.json().catch(() => ({}));
      if (!gr.ok) {
        lastErr = (gdata && gdata.error && gdata.error.message) || ("Model error " + gr.status);
        // Retryable server/capacity errors → wait and try next; hard errors → stop.
        if (gr.status === 503 || gr.status === 429 || gr.status >= 500 || overloaded(lastErr)) { await sleep(1200 * (i + 1)); continue; }
        return { ok: false, error: lastErr };
      }
      let text = "";
      try { text = gdata.candidates[0].content.parts[0].text; } catch {}
      // Model returned 200 but the *content* is a "high demand" apology, not real output.
      if (!text || overloaded(text)) { lastErr = "The model is experiencing high demand."; await sleep(1200 * (i + 1)); continue; }
      return { ok: true, text };
    } catch (e) {
      lastErr = (e && e.message) || "Network error contacting the editor.";
      await sleep(1200 * (i + 1));
    }
  }
  return { ok: false, error: lastErr };
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
    if (!GKEY || !RS_URL || !RS_SECRET) return res.status(500).json({ error: "The clip maker is not configured yet." });

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

    const g = await callGemini(GKEY, { contents: [{ parts }], generationConfig: { responseMimeType: "application/json", temperature: 0.4 } });
    if (!g.ok) {
      await refund(userId, SHORTS_COST, "refund:viral-clips-plan");
      return res.status(502).json({ error: g.error + " Your credits were refunded." });
    }
    let out;
    try { out = JSON.parse((g.text || "").replace(/```json|```/g, "").trim()); } catch {
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

    // ── Render each clip through the SAME engine as the main edit ──
    // One clip = one segment. Everything else — captions, the title treatment, the
    // rule under it, the LUT chain — comes from the shared renderer, so clips cannot
    // drift from the main video again.
    const perClipCost = Math.floor(SHORTS_COST / clips.length);
    const ids = [];
    const hooks = [];
    for (const c of clips) {
      const d = Math.round((c.e - c.s) * 100) / 100;
      const uploadPath = userId + "/clip-" + Date.now() + "-" + Math.random().toString(36).slice(2, 7) + ".mp4";
      let started = null;
      try {
        const r = await fetch(RS_URL + "/plan", {
          method: "POST",
          headers: { "Content-Type": "application/json", "x-render-secret": RS_SECRET },
          body: JSON.stringify({
            userId, creditsCharged: perClipCost,
            edl: {
              sources: [url],
              segments: [{ s: c.s, e: c.e }],
              // The FULL transcript, exactly as the main edit sends it — the renderer
              // windows the words to the kept segment itself. Pre-trimming here would
              // duplicate that logic and is how the two would drift apart again.
              words,
              // The hook becomes the title, so it gets the Caveline display treatment
              // rather than Creatomate's boxed text.
              title: c.hook || "",
              orientation: "portrait",
              fps: 30,
              size: { w: 1080, h: 1920 },
              // Clips have no per-clip camera info, so no log conversion — just the
              // film look. Same shape the main edit sends.
              grade: { footage: "standard", look: grade, clipFootage: [] },
              chapters: [], broll: [], transitions: [], music: null, showcase: [], narration: null,
              captionStyle: {},
              uploadPath
            }
          })
        });
        const dj = await r.json().catch(() => ({}));
        if (r.ok && dj && dj.jobId) started = dj.jobId;
        else console.error("[shorts] plan rejected a clip: " + ((dj && dj.error) || r.status));
      } catch (e) {
        console.error("[shorts] could not reach the render engine: " + ((e && e.message) || e));
      }
      if (started) {
        const id = "ff:" + started;
        ids.push(id);
        hooks.push(c.hook || "");
        await recordVideoJob(id, userId, perClipCost);
        // Real pod cost, not Creatomate's per-render price. ~$0.40/hr across the pods
        // a short clip spreads over; deliberately a slight over-estimate.
        const estUsd = Math.round((0.02 + 0.10 * (d / 60)) * 10000) / 10000;
        await logCost(id, userId, "chelgy-render-short-" + grade, d, perClipCost, estUsd);
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
