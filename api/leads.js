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
const COST_SEARCH   = 50;   // names, phones, websites, addresses, ratings
const COST_ENRICHED = 150;  // the above PLUS email lookups

// Never let one request cost too much. Hard caps protect your bill.
const MAX_RESULTS = 40;   // most Google will return per text search anyway
const MAX_ENRICH  = 25;   // most emails we'll look up in a single request

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
  const res = await fetch("https://places.googleapis.com/v1/places:searchText", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-Goog-Api-Key": GOOGLE_PLACES_KEY,
      // Field mask = only pay for / return the fields we actually use.
      "X-Goog-FieldMask": [
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
      ].join(","),
    },
    body: JSON.stringify({ textQuery: query, pageSize: wanted }),
  });

  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    const msg = (data && data.error && data.error.message) || ("Places error " + res.status);
    throw new Error(msg);
  }

  const places = Array.isArray(data.places) ? data.places : [];
  return places.map((p) => {
    const website = p.websiteUri || "";
    return {
      name: (p.displayName && p.displayName.text) || "",
      category: (p.primaryTypeDisplayName && p.primaryTypeDisplayName.text) || "",
      address: p.formattedAddress || "",
      phone: p.nationalPhoneNumber || p.internationalPhoneNumber || "",
      website: website,
      domain: domainFromUrl(website),
      email: "",            // filled in later if enrichment is on
      rating: typeof p.rating === "number" ? p.rating : null,
      reviews: typeof p.userRatingCount === "number" ? p.userRatingCount : null,
      maps_url: p.googleMapsUri || "",
      status: p.businessStatus || "",
    };
  });
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
