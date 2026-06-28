// api/voice.js — ElevenLabs voiceover with SERVER-ENFORCED credit spending.
// Deduct 150 credits → generate → refund automatically if it fails.
// Success returns audio bytes; the new balance comes back in the
// "X-Credits-Balance" response header.
//
// Env: ELEVENLABS_API_KEY, SUPABASE_URL, SUPABASE_ANON_KEY, SUPABASE_SERVICE_ROLE_KEY

const SB_URL  = (process.env.SUPABASE_URL || "").trim();
const SB_ANON = (process.env.SUPABASE_ANON_KEY || "").trim();
const SB_SVC  = (process.env.SUPABASE_SERVICE_ROLE_KEY || "").trim();
const VOICE_COST = 150;

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

export default async function handler(req, res) {
  if (req.method !== "POST") return res.status(405).json({ error: "Method not allowed" });
  try {
    const body = typeof req.body === "string" ? JSON.parse(req.body || "{}") : (req.body || {});
    const text = body.text;
    const voiceId = body.voiceId || "JBFqnCBsd6RMkjVDRZzb";
    if (!text || !String(text).trim()) return res.status(400).json({ error: "Missing text" });

    // ── Auth + deduct ──
    const token = (req.headers.authorization || "").replace(/^Bearer\s+/i, "").trim();
    const userId = await getUserId(token);
    if (!userId) return res.status(401).json({ error: "Please log in again to generate." });

    const paid = await spend(token, VOICE_COST, "voiceover");
    if (!paid.ok) return res.status(402).json({ error: paid.error });

    const key = (process.env.ELEVENLABS_API_KEY || "").trim();
    if (!key) { await refund(userId, VOICE_COST, "refund:voice-config"); return res.status(500).json({ error: "Voiceover service is not configured." }); }

    let r;
    try {
      r = await fetch("https://api.elevenlabs.io/v1/text-to-speech/" + voiceId, {
        method: "POST",
        headers: { "Content-Type": "application/json", "xi-api-key": key },
        body: JSON.stringify({ text, model_id: "eleven_multilingual_v2", voice_settings: { stability: 0.5, similarity_boost: 0.75 } })
      });
    } catch (e) {
      await refund(userId, VOICE_COST, "refund:voice-error");
      return res.status(502).json({ error: "Voiceover service unreachable. Your credits were refunded." });
    }

    if (!r.ok) {
      await refund(userId, VOICE_COST, "refund:voice-fail");
      let msg = "Voiceover service error";
      try {
        const err = await r.json();
        const d = err && err.detail;
        msg = (d && (d.message || d)) || (err && err.message) || msg;
        if (typeof msg === "object") msg = JSON.stringify(msg);
      } catch (_) {}
      return res.status(r.status).json({ error: String(msg) + " Your credits were refunded." });
    }

    const audio = Buffer.from(await r.arrayBuffer());
    res.setHeader("Content-Type", "audio/mpeg");
    res.setHeader("Content-Length", audio.length);
    if (paid.balance !== null) res.setHeader("X-Credits-Balance", String(paid.balance));
    return res.status(200).send(audio);
  } catch (e) {
    return res.status(500).json({ error: "Server error: " + (e && e.message ? e.message : "unknown") });
  }
}
