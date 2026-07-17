// Chelgy AI Video Editor — SCRIPT-FIRST MODE.
// Before the user films anything, Chelgy writes them a script in their chosen
// style: a scroll-stopping hook, the middle beats, and a call-to-action, sized
// to their target length. They film it, then run the footage through the editor
// (which also makes the auto-edit smarter — the delivery follows a structure).
// Charged a small flat fee (like other AI-writing tools); refunded on failure.
// Env: GEMINI_API_KEY, SUPABASE_URL, SUPABASE_ANON_KEY, SUPABASE_SERVICE_ROLE_KEY

export const maxDuration = 60;

const SB_URL  = (process.env.SUPABASE_URL || "").trim();
const SB_ANON = (process.env.SUPABASE_ANON_KEY || "").trim();
const SB_SVC  = (process.env.SUPABASE_SERVICE_ROLE_KEY || "").trim();
const SCRIPT_COST = 100;

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

const STYLE_NOTES = {
  talkinghead: "One person talking straight to camera. Confident, direct-address, first person. Short punchy sentences that are easy to deliver in one take. Think charismatic and personal — the person IS the video.",
  vlog: "Real-world day-in-the-life energy. Written to be spoken while moving through places. Conversational, high-energy, moments narrated as they happen.",
  tutorial: "Sit-down teaching format. Clear numbered steps, one idea per beat, plain language before any jargon. Calm and authoritative.",
  cinematic: "Voiceover-driven storytelling in the style of a Scorsese narration — vivid, rhythmic, confessional first-person lines meant to play over cinematic shots."
};
const LENGTHS = {
  "30": "a ~30 second reel (roughly 65-80 spoken words)",
  "60": "a ~60 second short (roughly 130-160 spoken words)",
  "180": "a 2-3 minute video (roughly 300-450 spoken words)"
};


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
    const topic = (body.topic || "").trim().slice(0, 500);
    const audience = (body.audience || "").trim().slice(0, 200);
    const style = STYLE_NOTES[body.style] ? body.style : "talkinghead";
    const length = LENGTHS[String(body.length)] ? String(body.length) : "60";
    if (!topic) return res.status(400).json({ error: "Tell us what the video is about." });

    const GKEY = (process.env.GEMINI_API_KEY || "").trim();
    if (!GKEY) return res.status(500).json({ error: "The script writer is not configured." });

    const token = (req.headers.authorization || "").replace(/^Bearer\s+/i, "").trim();
    const userId = await getUserId(token);
    if (!userId) return res.status(401).json({ error: "Please log in again." });

    const paid = await spend(token, SCRIPT_COST, "editor-script:" + style);
    if (!paid.ok) return res.status(402).json({ error: paid.error });

    const prompt =
      "You are a top short-form video scriptwriter. Write a script the creator will read on camera.\n\n" +
      "STYLE: " + STYLE_NOTES[style] + "\n" +
      "LENGTH: " + LENGTHS[length] + ".\n" +
      "TOPIC: " + topic + "\n" +
      (audience ? "AUDIENCE: " + audience + "\n" : "") +
      "\nRules:\n" +
      "- The HOOK is the first 1-2 sentences and must stop the scroll — curiosity, a bold claim, or a pattern interrupt. Never start with 'Hey guys' or introductions.\n" +
      "- Write in natural SPOKEN language: contractions, short sentences, no corporate words.\n" +
      "- The beats should each be deliverable in one breath or two.\n" +
      "- End with ONE clear call-to-action.\n" +
      "- No emojis, no hashtags, no stage directions in the script text itself.\n\n" +
      "Respond with ONLY this JSON:\n" +
      '{"hook":"string","beats":["string"],"cta":"string"}';

    const g = await callGemini(GKEY, {
      contents: [{ parts: [{ text: prompt }] }],
      generationConfig: { responseMimeType: "application/json", temperature: 0.8 }
    });
    if (!g.ok) {
      await refund(userId, SCRIPT_COST, "refund:editor-script");
      return res.status(502).json({ error: g.error + " Your credits were refunded." });
    }
    let out;
    try { out = JSON.parse((g.text || "").replace(/```json|```/g, "").trim()); } catch {
      await refund(userId, SCRIPT_COST, "refund:editor-script");
      return res.status(502).json({ error: "Couldn't write that script. Your credits were refunded — please try again." });
    }
    const hook = typeof out.hook === "string" ? out.hook : "";
    const beats = Array.isArray(out.beats) ? out.beats.filter(b => typeof b === "string").slice(0, 12) : [];
    const cta = typeof out.cta === "string" ? out.cta : "";
    if (!hook || !beats.length) {
      await refund(userId, SCRIPT_COST, "refund:editor-script");
      return res.status(502).json({ error: "Couldn't write that script. Your credits were refunded — please try again." });
    }

    return res.status(200).json({ hook, beats, cta, balance: paid.balance });
  } catch (e) {
    return res.status(500).json({ error: "Server error: " + (e && e.message ? e.message : "unknown") });
  }
}
