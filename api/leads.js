// ─────────────────────────────────────────────────────────────────────────────
//  /api/leads  — Chelgy Lead Finder engine  (Vercel serverless function)
//
//  What it does:
//    1. Takes a plain-English request ("boutique fitness studios in Tampa")
//    2. Searches Google Places LIVE and returns real businesses with their
//       name, address, phone, website, category, rating, and maps link
//    3. Optionally finds a public business email for each result via Hunter.io
//    4. Charges the member's credits SERVER-SIDE (can't be cheated from the app)
//
//  Why it lives here (not in App.jsx):
//    Your Google + Hunter API keys are SECRET. Anything in the front-end can be
//    read by anyone who opens their browser's dev tools, which would let them
//    run up your API bill. Serverless functions keep the keys private.
//
//  Vercel environment variables this file expects (you'll add these):
//    GOOGLE_PLACES_KEY   — from Google Cloud (Places API New)
//    HUNTER_API_KEY      — from hunter.io   (optional; email enrichment)
//    SUPABASE_URL        — https://yuzvpmxbtjpqtapborhr.supabase.co  (already yours)
//    SUPABASE_ANON_KEY   — your Supabase publishable key (already yours)
// ─────────────────────────────────────────────────────────────────────────────

const GOOGLE_PLACES_KEY = process.env.GOOGLE_PLACES_KEY || "";
const HUNTER_API_KEY    = process.env.HUNTER_API_KEY || "";
const SUPABASE_URL      = process.env.SUPABASE_URL || "https://yuzvpmxbtjpqtapborhr.supabase.co";
const SUPABASE_ANON_KEY = process.env.SUPABASE_ANON_KEY || "";

// Credit price per search. Keep these in sync with CREDIT_COSTS in App.jsx.
const COST_SEARCH   = 300;  // names, phones, websites, addresses, ratings (up to 60 = 3 Google pages)
const COST_ENRICHED = 2000;  // the above PLUS email lookups (Hunter is the pricey part)

// Never let one request cost too much. Hard caps protect your bill.
const MAX_RESULTS = 60;   // Google's hard ceiling for one text search (3 pages of 20)
const MAX_ENRICH  = 12;   // cap email lookups per search — Hunter is billed per lookup

// Confirm the caller is a signed-in Chelgy member; returns { user, token } or null.
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
  } catch (e) {
    return null;
  }
}

// Read the member's current balance (their own row only, under RLS).
async function readBalance(token, uid) {
  try {
    const res = await fetch(
      SUPABASE_URL + "/rest/v1/members?select=credits,credits_purchased&user_id=eq." + uid,
      { headers: { apikey: SUPABASE_ANON_KEY, Authorization: "Bearer " + token } }
    );
    if (!res.ok) return 0;
    const rows = await res.json();
    const m = Array.isArray(rows) && rows[0] ? rows[0] : {};
    return (Number(m.credits) || 0) + (Number(m.credits_purchased) || 0);
  } catch (e) {
    return 0;
  }
}

// Deduct credits atomically via the spend_credits database function.
// Returns the new balance, or the passed fallback if the call fails.
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
  } catch (e) {
    return fallback;
  }
}

// Pull the bare domain out of a website URL ("https://www.acme.com/x" -> "acme.com")
function domainFromUrl(url) {
  try {
    if (!url) return "";
    const h = new URL(url).hostname.toLowerCase();
    return h.replace(/^www\./, "");
  } catch (e) {
    return "";
  }
}

// Ask Google Places (New) for real businesses matching the text query.
async function searchPlaces(query, count) {
  const wanted = Math.min(Math.max(1, Number(count) || 20), MAX_RESULTS);
  const fieldMask = [
    "places.displayName",
    "places.formattedAddress",
    "places.nationalPhoneNumber",
    "places.internationalPhoneNumber",
    "places.websiteUri",
    "places.rating",
    "places.userRatingCount",
    "places.primaryTypeDisplayName",
    "places.googleMapsUri",
    "places.businessStatus",
    "nextPageToken",
  ].join(",");

  // Google returns max 20 per page — paginate (up to 3 pages) to reach `wanted`.
  async function fetchPage(pageToken, attempt) {
    const body = { textQuery: query, pageSize: 20 };
    if (pageToken) body.pageToken = pageToken;
    const res = await fetch("https://places.googleapis.com/v1/places:searchText", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Goog-Api-Key": GOOGLE_PLACES_KEY,
        "X-Goog-FieldMask": fieldMask,
      },
      body: JSON.stringify(body),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) {
      // A fresh nextPageToken can need a moment before it's valid — retry once.
      const msg = (data && data.error && data.error.message) || ("Places error " + res.status);
      if (pageToken && /INVALID_ARGUMENT/i.test(JSON.stringify(data)) && (attempt || 0) < 1) {
        await new Promise((r) => setTimeout(r, 1600));
        return fetchPage(pageToken, (attempt || 0) + 1);
      }
      throw new Error(msg);
    }
    return data;
  }

  const collected = [];
  let token = null;
  for (let page = 0; page < 3 && collected.length < wanted; page++) {
    const data = await fetchPage(token, 0);
    const places = Array.isArray(data.places) ? data.places : [];
    for (const p of places) {
      const website = p.websiteUri || "";
      collected.push({
        name: (p.displayName && p.displayName.text) || "",
        category: (p.primaryTypeDisplayName && p.primaryTypeDisplayName.text) || "",
        address: p.formattedAddress || "",
        phone: p.nationalPhoneNumber || p.internationalPhoneNumber || "",
        website: website,
        domain: domainFromUrl(website),
        email: "",
        rating: typeof p.rating === "number" ? p.rating : null,
        reviews: typeof p.userRatingCount === "number" ? p.userRatingCount : null,
        maps_url: p.googleMapsUri || "",
        status: p.businessStatus || "",
      });
    }
    token = data.nextPageToken || null;
    if (!token) break;
  }

  return collected.slice(0, wanted);
}

// Ask Hunter.io for a public business email tied to a domain.
async function findEmailForDomain(domain) {
  try {
    if (!domain || !HUNTER_API_KEY) return "";
    const url =
      "https://api.hunter.io/v2/domain-search?domain=" +
      encodeURIComponent(domain) +
      "&limit=1&api_key=" +
      encodeURIComponent(HUNTER_API_KEY);
    const res = await fetch(url);
    if (!res.ok) return "";
    const data = await res.json().catch(() => ({}));
    // Prefer a generic inbox (info@, contact@) if Hunter surfaces one, else first email.
    const emails = (data && data.data && data.data.emails) || [];
    if (!emails.length) return "";
    const generic = emails.find((e) => e && e.type === "generic" && e.value);
    return (generic && generic.value) || (emails[0] && emails[0].value) || "";
  } catch (e) {
    return "";
  }
}

module.exports = async function handler(req, res) {
  if (req.method !== "POST") {
    res.status(405).json({ error: "Use POST." });
    return;
  }
  if (!GOOGLE_PLACES_KEY) {
    res.status(500).json({ error: "Lead Finder isn't configured yet (missing Google Places key)." });
    return;
  }

  // Only signed-in members can run searches (keeps randoms off your API bill).
  const auth = await verifyMember(req.headers.authorization);
  if (!auth) {
    res.status(401).json({ error: "Please sign in again and retry." });
    return;
  }
  const { user, token } = auth;

  try {
    const body = typeof req.body === "string" ? JSON.parse(req.body || "{}") : (req.body || {});
    const query = (body.query || "").toString().trim();
    const count = body.count;
    const enrichEmail = body.enrichEmail === true && !!HUNTER_API_KEY;

    if (!query) {
      res.status(400).json({ error: "Tell me what kind of business to look for and where." });
      return;
    }

    // 1) Make sure they can afford it BEFORE we spend any API money.
    const cost = enrichEmail ? COST_ENRICHED : COST_SEARCH;
    const balance = await readBalance(token, user.id);
    if (balance < cost) {
      res.status(402).json({ error: "Not enough credits for this search.", balance });
      return;
    }

    // 2) Live business search
    let leads = await searchPlaces(query, count);

    // Drop permanently-closed businesses — nobody wants dead leads.
    leads = leads.filter((l) => l.status !== "CLOSED_PERMANENTLY");

    // 3) Optional email enrichment (capped to protect your Hunter credits)
    if (enrichEmail) {
      const toEnrich = leads.filter((l) => l.domain).slice(0, MAX_ENRICH);
      const BATCH = 5;
      for (let i = 0; i < toEnrich.length; i += BATCH) {
        const slice = toEnrich.slice(i, i + BATCH);
        const found = await Promise.all(slice.map((l) => findEmailForDomain(l.domain)));
        slice.forEach((l, idx) => { l.email = found[idx] || ""; });
      }
    }

    // 4) Charge for it (server-side, atomic) and report the new balance.
    const newBalance = await spend(token, cost, balance - cost);

    res.status(200).json({
      leads,
      balance: newBalance,
      meta: { count: leads.length, query, enriched: enrichEmail, charged: cost },
    });
  } catch (e) {
    res.status(500).json({ error: (e && e.message) ? e.message.slice(0, 300) : "Search failed. Try again." });
  }
};
