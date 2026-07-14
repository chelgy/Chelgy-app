// ============================================================================
// /api/press-find.js  —  "Get Featured → Press": find REAL outlets to pitch
// ----------------------------------------------------------------------------
// WHY THIS USES WEB SEARCH:
//   Asking an AI to "name some publications" produces confident, invented URLs.
//   So instead we let Claude actually SEARCH THE WEB, read who is genuinely
//   writing about this topic right now, and report back only what it found:
//   real outlets, real recent articles, real bylines.
//
// WHAT WE CANNOT DO (and we say so in the UI):
//   Give you a reporter's email. There is no open database of those — the real
//   ones (Muck Rack, Cision) cost thousands a year. What we CAN do is get you
//   to the outlet's tips page and tell you WHO covers your beat, which is the
//   actual first step of PR anyway.
//
// Env: ANTHROPIC_API_KEY, SUPABASE_URL, SUPABASE_ANON_KEY, SUPABASE_SERVICE_ROLE_KEY
// ============================================================================

const SB_URL  = (process.env.SUPABASE_URL || "").trim();
const SB_ANON = (process.env.SUPABASE_ANON_KEY || "").trim();
const SB_SVC  = (process.env.SUPABASE_SERVICE_ROLE_KEY || "").trim();

const FIND_COST = 300; // web search + a longer reasoning pass

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
  const you = (body.you || "").trim();
  const story = (body.story || "").trim();
  const place = (body.place || "").trim(); // optional — unlocks local press

  if (you.length < 10) return res.status(400).json({ error: "Tell us about your business first." });

  const paid = await spend(token, FIND_COST, "press:find");
  if (!paid.ok) return res.status(402).json({ error: paid.error });

  try {
    const sys =
      "You are a PR researcher. Your job is to find REAL publications and REAL journalists who are " +
      "actually covering a topic right now — using web search. Never invent an outlet, a URL, or a name.\n\n" +
      "METHOD:\n" +
      "1. Search for recent articles on the user's topic and in their industry.\n" +
      "2. Search for local/regional press if a location is given.\n" +
      "3. Search for trade publications and niche newsletters in their industry.\n" +
      "4. Where you can, find the outlet's tips / contact / 'submit a story' page.\n\n" +
      "Then return ONLY a JSON array (no preamble, no markdown fences) of 6-10 outlets, " +
      "ordered by how realistically gettable they are (easiest first). Each item:\n" +
      "{\n" +
      '  "outlet": "publication name",\n' +
      '  "url": "https://... the publication homepage (must be real, from your search)",\n' +
      '  "contactUrl": "https://... their tips/contact/submit page, or \\"\\" if you could not find one",\n' +
      '  "why": "one sentence: why THIS outlet fits THIS story",\n' +
      '  "reporter": "a journalist there who covers this beat, or \\"\\" if unknown",\n' +
      '  "articleTitle": "a real recent article of theirs on this topic, or \\"\\"",\n' +
      '  "articleUrl": "https://... link to that article, or \\"\\"",\n' +
      '  "reach": "local" | "trade" | "national" | "newsletter",\n' +
      '  "difficulty": "realistic" | "a stretch" | "long shot"\n' +
      "}\n\n" +
      "RULES:\n" +
      "- Every URL must come from your actual search results. If you did not find it, leave it as \"\".\n" +
      "- Lead with local and trade press. National press is a long shot for most small businesses — " +
      "say so honestly with difficulty: \"long shot\" rather than pretending.\n" +
      "- If the story genuinely isn't newsworthy, still return outlets but be honest in \"why\".";

    const usr =
      "MY BUSINESS\n" + you +
      (story ? ("\n\nTHE STORY I WANT TO PITCH\n" + story) : "") +
      (place ? ("\n\nWHERE I'M BASED (for local press)\n" + place) : "") +
      "\n\nSearch the web, then return the JSON array.";

    const r = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-api-key": AKEY,
        "anthropic-version": "2023-06-01",
      },
      body: JSON.stringify({
        model: "claude-sonnet-4-6",
        max_tokens: 4000,
        system: sys,
        messages: [{ role: "user", content: usr }],
        tools: [{ type: "web_search_20250305", name: "web_search", max_uses: 8 }],
      }),
    });

    const d = await r.json();
    if (!r.ok) {
      await refund(userId, FIND_COST, "refund:press-find");
      return res.status(r.status).json({ error: "Search failed. Your credits were refunded." });
    }

    // Pull the text out (there may also be tool-use blocks in the response).
    const text = (d.content || [])
      .filter((c) => c.type === "text")
      .map((c) => c.text || "")
      .join("")
      .trim();

    let outlets = [];
    try {
      const clean = text.replace(/```json/gi, "").replace(/```/g, "").trim();
      const start = clean.indexOf("[");
      const end = clean.lastIndexOf("]");
      if (start >= 0 && end > start) outlets = JSON.parse(clean.slice(start, end + 1));
    } catch (e) { outlets = []; }

    if (!Array.isArray(outlets) || !outlets.length) {
      await refund(userId, FIND_COST, "refund:press-find-empty");
      return res.status(502).json({ error: "Couldn't find outlets for that. Try describing your story differently. Your credits were refunded." });
    }

    // Only keep entries with a real-looking homepage link.
    outlets = outlets
      .filter((o) => o && o.outlet && /^https?:\/\//.test(o.url || ""))
      .slice(0, 10);

    return res.status(200).json({ ok: true, outlets, balance: paid.balance });
  } catch (e) {
    await refund(userId, FIND_COST, "refund:press-find-error");
    return res.status(500).json({ error: "Something went wrong. Your credits were refunded." });
  }
}
