// api/sfx.js — ElevenLabs sound effects with SERVER-ENFORCED credit spending.
//
// Deliberately the same shape as api/voice.js: deduct, generate, refund automatically
// if it fails, return audio bytes with the new balance in "X-Credits-Balance". Two
// slightly different ways of talking to the same service is how the two drift apart,
// so this copies that file's structure rather than improving on it.
//
// TWO MODES, ONE ENDPOINT
//
//   A HIT — a short effect that lands on an action. A dress flipping, a turn, a step.
//   Half a second to two seconds, generated per moment.
//
//   A BED — room tone under the whole video. `loop: true` makes ElevenLabs blend the
//   ending into the beginning, so a 20-second generation can be repeated for a
//   three-minute film with no audible click at the seam. Without that flag a looped
//   bed ticks every time it wraps, which is worse than no bed at all.
//
// BILLED PER GENERATION, not per request, so the cost scales with duration: a
// two-second whoosh is cheap and a thirty-second bed is not. The charge here reflects
// that rather than being one flat number for both.
//
// Env: ELEVENLABS_API_KEY, SUPABASE_URL, SUPABASE_ANON_KEY, SUPABASE_SERVICE_ROLE_KEY

const SB_URL  = (process.env.SUPABASE_URL || "").trim();
const SB_ANON = (process.env.SUPABASE_ANON_KEY || "").trim();
const SB_SVC  = (process.env.SUPABASE_SERVICE_ROLE_KEY || "").trim();

// A floor plus a per-second rate. Adjust freely — it is one line and it is the only
// place the price of a sound effect is decided.
const SFX_MIN_COST = 25;
const SFX_COST_PER_SEC = 12;
const costFor = (seconds) => Math.max(SFX_MIN_COST, Math.round(seconds * SFX_COST_PER_SEC));

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

    const text = String(body.text || "").trim();
    if (!text) return res.status(400).json({ error: "Missing a description of the sound" });
    // A description this long is a scene, not a sound, and the model does worse with it.
    if (text.length > 300) return res.status(400).json({ error: "That description is too long for a sound effect." });

    const loop = body.loop === true;
    // 0.5 to 30 is the model's own range. A bed defaults long enough to be worth
    // looping; a hit defaults short, because a whoosh that outlasts the movement reads
    // as a mistake.
    const raw = Number(body.seconds);
    const seconds = Number.isFinite(raw)
      ? Math.max(0.5, Math.min(30, raw))
      : (loop ? 20 : 1.2);

    // Higher influence for hits, lower for beds. A hit has to be the thing asked for;
    // a bed benefits from the model wandering a little, which is what stops room tone
    // sounding synthetic.
    const rawInf = Number(body.promptInfluence);
    const promptInfluence = Number.isFinite(rawInf)
      ? Math.max(0, Math.min(1, rawInf))
      : (loop ? 0.3 : 0.7);

    const token = (req.headers.authorization || "").replace(/^Bearer\s+/i, "").trim();
    const userId = await getUserId(token);
    if (!userId) return res.status(401).json({ error: "Please log in again to generate." });

    const cost = costFor(seconds);
    const paid = await spend(token, cost, loop ? "sfx-bed" : "sfx-hit");
    if (!paid.ok) return res.status(402).json({ error: paid.error });

    const key = (process.env.ELEVENLABS_API_KEY || "").trim();
    if (!key) {
      await refund(userId, cost, "refund:sfx-config");
      return res.status(500).json({ error: "Sound effects are not configured." });
    }

    let r;
    try {
      r = await fetch("https://api.elevenlabs.io/v1/sound-generation", {
        method: "POST",
        headers: { "Content-Type": "application/json", "xi-api-key": key },
        body: JSON.stringify({
          text,
          // loop and duration_seconds are both v2-only. Naming the model explicitly
          // rather than relying on the account default, so a default change elsewhere
          // cannot silently drop the looping that a seamless bed depends on.
          model_id: "eleven_text_to_sound_v2",
          duration_seconds: seconds,
          prompt_influence: promptInfluence,
          loop
        })
      });
    } catch (e) {
      await refund(userId, cost, "refund:sfx-error");
      return res.status(502).json({ error: "Sound effect service unreachable. Your credits were refunded." });
    }

    if (!r.ok) {
      await refund(userId, cost, "refund:sfx-fail");
      let msg = "Sound effect service error";
      try {
        const err = await r.json();
        const d = err && err.detail;
        msg = (d && (d.message || d)) || (err && err.message) || msg;
        if (typeof msg === "object") msg = JSON.stringify(msg);
      } catch (_) {}
      return res.status(r.status).json({ error: String(msg) + " Your credits were refunded." });
    }

    const audio = Buffer.from(await r.arrayBuffer());
    // An empty 200 is still a failure, and without this check it would be charged for
    // and then mixed in as silence.
    if (!audio.length) {
      await refund(userId, cost, "refund:sfx-empty");
      return res.status(502).json({ error: "That sound came back empty. Your credits were refunded." });
    }

    res.setHeader("Content-Type", "audio/mpeg");
    res.setHeader("Content-Length", audio.length);
    res.setHeader("X-Sfx-Seconds", String(seconds));
    if (paid.balance !== null) res.setHeader("X-Credits-Balance", String(paid.balance));
    return res.status(200).send(audio);
  } catch (e) {
    return res.status(500).json({ error: "Server error: " + (e && e.message ? e.message : "unknown") });
  }
}
