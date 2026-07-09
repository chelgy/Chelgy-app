// ─────────────────────────────────────────────────────────────────────────────
//  /api/extract-leads  — pull businesses off any webpage  (Vercel serverless)
//
//  Paste a directory / listicle URL ("top 20 plumbers in Tampa") and this
//  fetches the page, hands the text to Claude (via your existing /api/claude
//  proxy — no new key), and returns every business it can find with whatever
//  contact info is on the page. Cheap for you: no paid data API, just Claude.
//
//  Vercel environment variables (all already yours):
//    APP_BASE_URL       — e.g. https://chelgy.app  (to reach your /api/claude)
//    SUPABASE_URL / SUPABASE_ANON_KEY
// ─────────────────────────────────────────────────────────────────────────────

const APP_BASE_URL      = (process.env.APP_BASE_URL || "https://chelgy.app").replace(/\/+$/, "");
const SUPABASE_URL      = process.env.SUPABASE_URL || "https://yuzvpmxbtjpqtapborhr.supabase.co";
const SUPABASE_ANON_KEY = process.env.SUPABASE_ANON_KEY || "";

const COST = 200;          // keep in sync with CREDIT_COSTS.websiteLeads in App.jsx
const MAX_CHARS = 16000;   // how much page text we hand to Claude

async function verifyMember(authHeader) {
  try {
    if (!authHeader) return null;
    const token = authHeader.replace(/^Bearer\s+/i, "").trim();
    if (!token) return null;
    const res = await fetch(SUPABASE_URL + "/auth/v1/user", {
      headers: { apikey: SUPABASE_ANON_KEY, Authorization: "Bearer " + token },
    });
    if (!res.ok) return null;
    const user = await res.json();
    return user && user.id ? { user, token } : null;
  } catch (e) { return null; }
}
async function readBalance(token, uid) {
  try {
    const res = await fetch(SUPABASE_URL + "/rest/v1/members?select=credits,credits_purchased&user_id=eq." + uid,
      { headers: { apikey: SUPABASE_ANON_KEY, Authorization: "Bearer " + token } });
    if (!res.ok) return 0;
    const rows = await res.json();
    const m = Array.isArray(rows) && rows[0] ? rows[0] : {};
    return (Number(m.credits) || 0) + (Number(m.credits_purchased) || 0);
  } catch (e) { return 0; }
}
async function spend(token, amount, fallback) {
  try {
    const res = await fetch(SUPABASE_URL + "/rest/v1/rpc/spend_credits", {
      method: "POST",
      headers: { apikey: SUPABASE_ANON_KEY, Authorization: "Bearer " + token, "Content-Type": "application/json" },
      body: JSON.stringify({ p_amount: amount }),
    });
    if (!res.ok) return fallback;
    const v = await res.json();
    return typeof v === "number" && v >= 0 ? v : fallback;
  } catch (e) { return fallback; }
}

// Turn raw HTML into readable-ish text for the model.
function htmlToText(html) {
  return String(html || "")
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/\s+/g, " ")
    .trim();
}

module.exports = async function handler(req, res) {
  if (req.method !== "POST") { res.status(405).json({ error: "Use POST." }); return; }

  const auth = await verifyMember(req.headers.authorization);
  if (!auth) { res.status(401).json({ error: "Please sign in again and retry." }); return; }
  const { user, token } = auth;

  try {
    const body = typeof req.body === "string" ? JSON.parse(req.body || "{}") : (req.body || {});
    let url = (body.url || "").toString().trim();
    if (!url) { res.status(400).json({ error: "Paste a webpage URL first." }); return; }
    if (!/^https?:\/\//i.test(url)) url = "https://" + url;

    const balance = await readBalance(token, user.id);
    if (balance < COST) { res.status(402).json({ error: "Not enough credits.", balance }); return; }

    // 1) Fetch the page.
    let html = "";
    try {
      const pageRes = await fetch(url, { headers: { "User-Agent": "Mozilla/5.0 (compatible; ChelgyBot/1.0)" } });
      if (!pageRes.ok) { res.status(400).json({ error: "Couldn't open that page (" + pageRes.status + "). Check the URL." }); return; }
      html = await pageRes.text();
    } catch (e) {
      res.status(400).json({ error: "Couldn't reach that page. Some sites block automated access." });
      return;
    }
    const text = htmlToText(html).slice(0, MAX_CHARS);
    if (text.length < 40) { res.status(422).json({ error: "That page didn't have readable text to pull businesses from." }); return; }

    // 2) Ask Claude (via your existing proxy) to extract businesses as JSON.
    const prompt =
      "From the web page content below, extract EVERY business or service provider listed. " +
      "For each, capture whatever is present: name, phone, email, website, address, category. " +
      "Return ONLY a JSON array, no prose, no code fences, in exactly this shape:\n" +
      '[{"name":"","phone":"","email":"","website":"","address":"","category":""}]\n' +
      "Use empty strings for anything not on the page. If no businesses are listed, return [].\n\n" +
      "PAGE CONTENT:\n" + text;

    const aiRes = await fetch(APP_BASE_URL + "/api/claude", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ prompt, max_tokens: 2500 }),
    });
    const aiData = await aiRes.json().catch(() => ({}));
    const raw = (aiData && aiData.text) ? String(aiData.text) : "";

    // 3) Pull the JSON array out of the reply.
    let leads = [];
    try {
      const start = raw.indexOf("[");
      const end = raw.lastIndexOf("]");
      if (start !== -1 && end > start) {
        const arr = JSON.parse(raw.slice(start, end + 1));
        if (Array.isArray(arr)) {
          leads = arr.filter((x) => x && x.name).map((x) => ({
            name: String(x.name || "").slice(0, 200),
            category: String(x.category || "").slice(0, 120),
            address: String(x.address || "").slice(0, 300),
            phone: String(x.phone || "").slice(0, 40),
            website: String(x.website || "").slice(0, 300),
            email: String(x.email || "").slice(0, 200),
            rating: null, reviews: null, maps_url: "",
          }));
        }
      }
    } catch (e) { leads = []; }

    // 4) Charge and return.
    const newBalance = await spend(token, COST, balance - COST);
    res.status(200).json({ leads, balance: newBalance, meta: { count: leads.length, source: url } });
  } catch (e) {
    res.status(500).json({ error: (e && e.message) ? e.message.slice(0, 300) : "Extraction failed. Try again." });
  }
};
