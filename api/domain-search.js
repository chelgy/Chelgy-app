// api/domain-search.js — search domains + live prices via Vercel's Domains Registrar API.
//
// The member types a name; we check availability + yearly price across common TLDs
// and return the available ones. Buying happens separately (api/domain-checkout.js).
//
// Env:
//   VERCEL_TOKEN         — a Vercel access token with the Domains scope (required)
//   VERCEL_TEAM_ID       — your Vercel team id, if the token is team-scoped (optional)
//   DOMAIN_MARKUP_USD    — flat $ added to each domain's yearly price (optional; default 0)

const VT = (process.env.VERCEL_TOKEN || "").trim();
const TEAM = (process.env.VERCEL_TEAM_ID || "").trim();
const MARKUP_PCT = (parseFloat(process.env.DOMAIN_MARKUP_PCT || "50") || 50) / 100; // Chelgy's margin, % of Vercel's at-cost price (scales with pricier domains)
const MARKUP_MIN = parseFloat(process.env.DOMAIN_MARKUP_MIN_USD || "4") || 4;         // dollar floor so cheap domains still clear Stripe's fee
function withMargin(base) { const m = Math.max(base * MARKUP_PCT, MARKUP_MIN); return Math.round((base + m) * 100) / 100; } // ~$10 domain -> ~$15

// TLDs to try when the member types a bare name (no dot). Kept modest to stay
// well under Vercel's registrar rate limits.
const TLDS = ["com", "co", "net", "io", "shop", "store", "org", "me"];

function slug(q) {
  return String(q || "").toLowerCase().trim()
    .replace(/^https?:\/\//, "").replace(/\/.*$/, "")
    .replace(/[^a-z0-9.\- ]/g, "").replace(/\s+/g, "").replace(/\.+/g, ".");
}
async function v(path) {
  const url = "https://api.vercel.com" + path + (path.includes("?") ? "&" : "?") + (TEAM ? "teamId=" + encodeURIComponent(TEAM) : "");
  const r = await fetch(url, { headers: { Authorization: "Bearer " + VT } });
  const j = await r.json().catch(() => ({}));
  return { ok: r.ok, j };
}

export default async function handler(req, res) {
  if (req.method !== "POST") return res.status(405).json({ error: "Method not allowed" });
  try {
    if (!VT) return res.status(500).json({ error: "Domain search isn't set up yet." });
    const body = typeof req.body === "string" ? JSON.parse(req.body || "{}") : (req.body || {});
    const q = slug(body.query);
    if (!q || q.replace(/\..*$/, "").length < 2) return res.status(400).json({ error: "Type a name to search." });

    const names = (q.includes(".") ? [q] : TLDS.map(t => q + "." + t)).slice(0, 10);

    const results = [];
    await Promise.all(names.map(async (dom) => {
      try {
        const a = await v("/v1/registrar/domains/" + encodeURIComponent(dom) + "/availability");
        const available = !!(a.ok && a.j && a.j.available);
        let price = null;
        if (available) {
          const p = await v("/v1/registrar/domains/" + encodeURIComponent(dom) + "/price?years=1");
          if (p.ok && p.j && p.j.purchasePrice != null) {
            const base = parseFloat(p.j.purchasePrice);
            if (isFinite(base)) price = withMargin(base);
          }
        }
        results.push({ domain: dom, available, price });
      } catch (e) { /* skip this candidate */ }
    }));

    // available first, then cheapest
    results.sort((x, y) => (Number(y.available) - Number(x.available)) || ((x.price || 9999) - (y.price || 9999)));
    return res.status(200).json({ results });
  } catch (e) {
    return res.status(500).json({ error: "Search failed. Please try again." });
  }
}
