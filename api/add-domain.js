// POST /api/add-domain
// Body: { domain: "yourbusiness.com", action?: "status" | "remove" }
// Header: Authorization: Bearer <user access token>
//
// Requires these Vercel env vars (Project → Settings → Environment Variables):
//   VERCEL_TOKEN        - a Vercel API token (Account → Settings → Tokens)
//   VERCEL_PROJECT_ID   - your project id (Project → Settings → General)
//   VERCEL_TEAM_ID      - only if the project lives under a Vercel team (optional)
// Plus the Supabase ones you already have: SUPABASE_URL, SUPABASE_ANON_KEY, SUPABASE_SERVICE_ROLE_KEY

export default async function handler(req, res) {
  if (req.method !== "POST") return res.status(405).json({ error: "POST only" });

  const SUPABASE_URL = process.env.SUPABASE_URL;
  const ANON = process.env.SUPABASE_ANON_KEY;
  const SVC = process.env.SUPABASE_SERVICE_ROLE_KEY;
  const VT = process.env.VERCEL_TOKEN;
  const VP = process.env.VERCEL_PROJECT_ID;
  const VTEAM = process.env.VERCEL_TEAM_ID || "";
  const teamQ = VTEAM ? ("?teamId=" + VTEAM) : "";

  try {
    const body = req.body || {};
    const action = body.action || "add";
    let d = String(body.domain || "").trim().toLowerCase().replace(/^https?:\/\//, "").replace(/\/.*$/, "");

    // 1) Verify the signed-in user
    const token = (req.headers.authorization || "").replace(/^Bearer /, "");
    if (!token) return res.status(401).json({ error: "Please sign in again." });
    const ures = await fetch(SUPABASE_URL + "/auth/v1/user", { headers: { apikey: ANON, Authorization: "Bearer " + token } });
    const user = await ures.json();
    if (!user || !user.id) return res.status(401).json({ error: "Please sign in again." });

    // 2) Find this user's site
    const sres = await fetch(SUPABASE_URL + "/rest/v1/websites?select=id,slug,custom_domain&user_id=eq." + user.id + "&limit=1", { headers: { apikey: SVC, Authorization: "Bearer " + SVC } });
    const rows = await sres.json();
    if (!Array.isArray(rows) || !rows.length) return res.status(400).json({ error: "Build a site first, then connect a domain." });
    const site = rows[0];

    if (!VT || !VP) return res.status(500).json({ error: "Domains aren't configured yet. (Missing Vercel token or project id.)" });

    // ---- STATUS: is DNS resolving / domain verified? ----
    if (action === "status") {
      const dom = d || site.custom_domain;
      if (!dom) return res.status(400).json({ error: "No domain to check." });
      const cfg = await fetch("https://api.vercel.com/v6/domains/" + dom + "/config" + teamQ, { headers: { Authorization: "Bearer " + VT } });
      const cj = await cfg.json();
      return res.status(200).json({ ok: true, misconfigured: cj && cj.misconfigured === true, config: cj });
    }

    // ---- REMOVE ----
    if (action === "remove") {
      const dom = d || site.custom_domain;
      if (dom) {
        await fetch("https://api.vercel.com/v9/projects/" + VP + "/domains/" + dom + teamQ, { method: "DELETE", headers: { Authorization: "Bearer " + VT } });
      }
      await fetch(SUPABASE_URL + "/rest/v1/websites?id=eq." + site.id, { method: "PATCH", headers: { apikey: SVC, Authorization: "Bearer " + SVC, "Content-Type": "application/json", Prefer: "return=minimal" }, body: JSON.stringify({ custom_domain: null }) });
      return res.status(200).json({ ok: true, removed: true });
    }

    // ---- ADD ----
    if (!/^[a-z0-9-]+(\.[a-z0-9-]+)+$/.test(d)) return res.status(400).json({ error: "Please enter a valid domain like yourbusiness.com" });

    // Make sure no one else already claimed it inside Chelgy
    const dupe = await fetch(SUPABASE_URL + "/rest/v1/websites?select=id&custom_domain=eq." + encodeURIComponent(d) + "&limit=1", { headers: { apikey: SVC, Authorization: "Bearer " + SVC } });
    const dj = await dupe.json();
    if (Array.isArray(dj) && dj.length && dj[0].id !== site.id) return res.status(409).json({ error: "That domain is already connected to another Chelgy site." });

    // Register the domain (and its www) with the Vercel project
    const addOne = async (name) => {
      const r = await fetch("https://api.vercel.com/v10/projects/" + VP + "/domains" + teamQ, { method: "POST", headers: { Authorization: "Bearer " + VT, "Content-Type": "application/json" }, body: JSON.stringify({ name }) });
      const j = await r.json();
      return { status: r.status, j };
    };
    const primary = await addOne(d);
    if (primary.status >= 400) {
      const code = primary.j && primary.j.error && primary.j.error.code;
      if (code !== "domain_already_in_use" && code !== "domain_already_exists") {
        return res.status(400).json({ error: (primary.j.error && primary.j.error.message) || "Vercel could not add that domain." });
      }
    }
    const isApex = d.split(".").length <= 2;
    if (isApex) { try { await addOne("www." + d); } catch (e) {} }

    // Save it on the user's site
    await fetch(SUPABASE_URL + "/rest/v1/websites?id=eq." + site.id, { method: "PATCH", headers: { apikey: SVC, Authorization: "Bearer " + SVC, "Content-Type": "application/json", Prefer: "return=minimal" }, body: JSON.stringify({ custom_domain: d }) });

    // DNS the customer must set at their registrar
    const dns = isApex
      ? [{ type: "A", name: "@", value: "76.76.21.21" }, { type: "CNAME", name: "www", value: "cname.vercel-dns.com" }]
      : [{ type: "CNAME", name: d.split(".")[0], value: "cname.vercel-dns.com" }];

    return res.status(200).json({ ok: true, domain: d, dns, verification: (primary.j && primary.j.verification) || null });
  } catch (e) {
    return res.status(500).json({ error: "Something went wrong connecting the domain." });
  }
}
