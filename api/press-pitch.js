// ============================================================================
// /api/press-pitch.js  —  "Get Featured": pitch journalists & publications
// ----------------------------------------------------------------------------
// HONEST FRAMING (this matters):
//   Nobody can "automatically get you into Forbes." What we CAN do is the part
//   that's actually hard and time-consuming: figure out WHO covers your beat,
//   and write a pitch a journalist might actually open.
//
//   Contact routes come from public sources (a publication's tips line, a
//   reporter's public contact page). Paid journalist databases (Muck Rack,
//   Cision) cost thousands — we don't pretend to have that data.
//
// Credits are charged for the AI writing (the same 100 as a podcast pitch).
//
// Env: ANTHROPIC_API_KEY, SUPABASE_URL, SUPABASE_ANON_KEY, SUPABASE_SERVICE_ROLE_KEY
// ============================================================================

const SB_URL  = (process.env.SUPABASE_URL || "").trim();
const SB_ANON = (process.env.SUPABASE_ANON_KEY || "").trim();
const SB_SVC  = (process.env.SUPABASE_SERVICE_ROLE_KEY || "").trim();

const PITCH_COST = 100;

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
  if (!AKEY) return res.status(500).json({ error: "Not configured." });

  const token = (req.headers.authorization || "").replace(/^Bearer\s+/i, "").trim();
  const userId = await getUserId(token);
  if (!userId) return res.status(401).json({ error: "Please log in again." });

  const body = typeof req.body === "string" ? JSON.parse(req.body || "{}") : (req.body || {});
  const mode = body.mode === "targets" ? "targets" : "pitch";
  const you = (body.you || "").trim();
  const story = (body.story || "").trim();
  const outlet = (body.outlet || "").trim();

  if (you.length < 10) return res.status(400).json({ error: "Tell us about you and your business first." });

  const paid = await spend(token, PITCH_COST, "press:" + mode);
  if (!paid.ok) return res.status(402).json({ error: paid.error });

  try {
    let sys, usr;

    if (mode === "targets") {
      // Help them figure out WHO to pitch and WHAT story actually has legs.
      sys =
        "You are a seasoned PR strategist who has placed hundreds of founder stories. You are blunt and practical. " +
        "You do NOT flatter, and you do NOT promise coverage. Journalists get hundreds of pitches a day; most are boring.\n\n" +
        "Given a business, produce:\n" +
        "1. HONEST READ \u2014 2-3 sentences: is there a real story here, or not yet? Say so plainly.\n" +
        "2. YOUR ANGLES \u2014 3 story angles a journalist would actually care about (a trend, a surprising number, a conflict, a first). " +
        "Not 'local business does well.' Real hooks.\n" +
        "3. WHO TO PITCH \u2014 the TYPES of outlets and reporters realistically within reach right now (local press, trade publications, niche newsletters, industry blogs), " +
        "in order of how gettable they are. Be realistic: national press is not a starting point for most businesses.\n" +
        "4. HOW TO FIND THEM \u2014 concrete steps: search the outlet for recent articles on your topic, note the byline, find the reporter's public contact or the tips line.\n" +
        "5. WHAT TO DO FIRST \u2014 one specific action for this week.\n\n" +
        "Format with clear headers. Be specific to their business, not generic.";
      usr = "MY BUSINESS\n" + you + (story ? ("\n\nWHAT I THINK THE STORY IS\n" + story) : "");
    } else {
      // Write the actual pitch to a journalist.
      sys =
        "You write press pitches that journalists actually open. Rules:\n" +
        "- Subject line must be specific and newsworthy. Not 'Story idea' or 'Partnership opportunity'.\n" +
        "- Under 150 words. Journalists skim on a phone.\n" +
        "- Lead with the story, not with the person. Why does this matter to THEIR readers, right now?\n" +
        "- Include one concrete, checkable fact or number if there is one.\n" +
        "- No press-release voice. No 'thrilled to announce'. No adjectives doing the work of facts.\n" +
        "- Make the ask easy: offer an interview, data, or a source \u2014 and say you'll keep it short.\n" +
        "- Output ONLY the email: a subject line, blank line, then the body.";
      usr =
        (outlet ? ("OUTLET / REPORTER\n" + outlet + "\n\n") : "") +
        "ME / MY BUSINESS\n" + you + "\n\n" +
        "THE STORY\n" + (story || "(none given \u2014 find the most newsworthy angle in the business above)") +
        "\n\nWrite the pitch.";
    }

    const r = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-api-key": AKEY,
        "anthropic-version": "2023-06-01",
      },
      body: JSON.stringify({
        model: "claude-sonnet-4-6",
        max_tokens: 1400,
        system: sys,
        messages: [{ role: "user", content: usr }],
      }),
    });

    const d = await r.json();
    if (!r.ok) {
      await refund(userId, PITCH_COST, "refund:press");
      return res.status(r.status).json({ error: "Couldn't write that. Your credits were refunded." });
    }
    const text = (d.content || []).map((c) => c.text || "").join("").trim();
    if (!text) {
      await refund(userId, PITCH_COST, "refund:press-empty");
      return res.status(502).json({ error: "Empty result. Your credits were refunded." });
    }

    let subject = "";
    let out = text;
    if (mode === "pitch") {
      const m = text.match(/^\s*subject:\s*(.+?)\n([\s\S]*)$/i);
      if (m) { subject = m[1].trim(); out = m[2].trim(); }
    }

    return res.status(200).json({ ok: true, mode, subject, body: out, balance: paid.balance });
  } catch (e) {
    await refund(userId, PITCH_COST, "refund:press-error");
    return res.status(500).json({ error: "Something went wrong. Your credits were refunded." });
  }
}
