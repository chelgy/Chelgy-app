// ============================================================================
// /api/podcast-pitch.js  —  writes a tailored pitch for ONE specific show
// ----------------------------------------------------------------------------
// This is the part that actually earns its keep: a pitch that references THAT
// show — its name, its angle, its audience — not a mail-merge blast. That's the
// difference between getting read and getting deleted.
//
// Credits are charged here (the search itself is free).
//
// Env: ANTHROPIC_API_KEY, SUPABASE_URL, SUPABASE_ANON_KEY, SUPABASE_SERVICE_ROLE_KEY
// ============================================================================

const SB_URL  = (process.env.SUPABASE_URL || "").trim();
const SB_ANON = (process.env.SUPABASE_ANON_KEY || "").trim();
const SB_SVC  = (process.env.SUPABASE_SERVICE_ROLE_KEY || "").trim();

const PITCH_COST = 100; // credits

async function getUserId(token) {
  if (!token) return null;
  try {
    const r = await fetch(SB_URL + "/auth/v1/user", {
      headers: { apikey: SB_ANON, Authorization: "Bearer " + token },
    });
    const u = await r.json();
    return r.ok && u && u.id ? u.id : null;
  } catch { return null; }
}
async function spend(token, amount, reason) {
  try {
    const r = await fetch(SB_URL + "/rest/v1/rpc/spend_credits", {
      method: "POST",
      headers: { apikey: SB_ANON, Authorization: "Bearer " + token, "Content-Type": "application/json" },
      body: JSON.stringify({ p_amount: amount, p_reason: reason }),
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
      body: JSON.stringify({ p_user: userId, p_amount: amount, p_reason: reason }),
    });
  } catch {}
}

export default async function handler(req, res) {
  if (req.method !== "POST") return res.status(405).json({ error: "Method not allowed" });

  const AKEY = (process.env.ANTHROPIC_API_KEY || "").trim();
  if (!AKEY) return res.status(500).json({ error: "Pitch writer is not configured." });

  const token = (req.headers.authorization || "").replace(/^Bearer\s+/i, "").trim();
  const userId = await getUserId(token);
  if (!userId) return res.status(401).json({ error: "Please log in again." });

  const body = typeof req.body === "string" ? JSON.parse(req.body || "{}") : (req.body || {});
  const show = body.show || {};
  const you = (body.you || "").trim();     // who they are / what they do
  const angle = (body.angle || "").trim(); // what they'd talk about

  if (!show.title) return res.status(400).json({ error: "Pick a show first." });
  if (you.length < 10) return res.status(400).json({ error: "Tell us a bit about yourself first." });

  const paid = await spend(token, PITCH_COST, "podcast:pitch");
  if (!paid.ok) return res.status(402).json({ error: paid.error });

  try {
    const sys =
      "You write podcast guest pitches that actually get replies. You are writing ONE email " +
      "from a real person to a real podcast host. Rules:\n" +
      "- Open by showing you know THEIR show specifically. Reference its actual subject matter.\n" +
      "- Never use flattery filler like 'I love your podcast' without specifics.\n" +
      "- Get to the point fast. Hosts skim. 120-180 words MAX.\n" +
      "- Offer 2-3 concrete talking points their audience would actually want.\n" +
      "- Sound like a human, not a press release. No corporate speak. No 'I hope this finds you well.'\n" +
      "- End with a low-friction ask (a yes/no question), not a hard sell.\n" +
      "- Output ONLY the email: a subject line, then a blank line, then the body. No preamble, no notes.";

    const usr =
      "THE SHOW\n" +
      "Title: " + show.title + "\n" +
      (show.author ? "Host: " + show.author + "\n" : "") +
      (show.categories && show.categories.length ? "Topics: " + show.categories.join(", ") + "\n" : "") +
      (show.description ? "About the show: " + show.description + "\n" : "") +
      "\nTHE GUEST (me)\n" + you + "\n" +
      (angle ? "\nWHAT I'D TALK ABOUT\n" + angle + "\n" : "") +
      "\nWrite the pitch email.";

    const r = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-api-key": AKEY,
        "anthropic-version": "2023-06-01",
      },
      body: JSON.stringify({
        model: "claude-sonnet-4-6",
        max_tokens: 700,
        system: sys,
        messages: [{ role: "user", content: usr }],
      }),
    });

    const d = await r.json();
    if (!r.ok) {
      await refund(userId, PITCH_COST, "refund:podcast-pitch");
      return res.status(r.status).json({ error: "Couldn't write that pitch. Your credits were refunded." });
    }

    const text = (d.content || []).map((c) => c.text || "").join("").trim();
    if (!text) {
      await refund(userId, PITCH_COST, "refund:podcast-pitch-empty");
      return res.status(502).json({ error: "Empty pitch. Your credits were refunded." });
    }

    // Split "Subject: ..." off the top if it's there.
    let subject = "";
    let pitchBody = text;
    const m = text.match(/^\s*subject:\s*(.+?)\n([\s\S]*)$/i);
    if (m) { subject = m[1].trim(); pitchBody = m[2].trim(); }

    return res.status(200).json({ ok: true, subject, body: pitchBody, balance: paid.balance });
  } catch (e) {
    await refund(userId, PITCH_COST, "refund:podcast-pitch-error");
    return res.status(500).json({ error: "Something went wrong. Your credits were refunded." });
  }
}
