// api/domain-reconcile.js — scheduled reconciler for domains bought/renewed through Chelgy.
//
// WHY THIS EXISTS
// Vercel's registrar is asynchronous. POST /buy and POST /renew return an `orderId`
// the moment the order is PLACED — NOT when the domain is actually registered/renewed.
// An order moves draft -> purchasing -> completed | failed on Vercel's side, minutes later.
// So api/stripe-webhook.js no longer treats "got an orderId" as success. Instead it records
// the purchase as status="pending" (or a renewal as status="renewing") and this job is the
// ONE place that checks what really happened and then:
//   • completed → connect the domain to the member's site (+ www) and set the 1-year expiry
//                 (for a renewal: push the expiry out another year), mark it "active".
//   • failed    → refund the member automatically and mark it "failed"
//                 (a failed RENEWAL keeps the domain active until its existing expiry).
//   • stuck     → if it never resolves within STUCK_HOURS, refund + fail so money never hangs.
//
// Triggered by a Vercel Cron (see vercel.json). Safe to run as often as you like and safe to
// re-run: it only ever acts on pending/renewing rows and flips them to a final state.
//
// Env: SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, VERCEL_TOKEN, VERCEL_PROJECT_ID,
//      VERCEL_TEAM_ID (optional), STRIPE_SECRET_KEY, CRON_SECRET (recommended)

const SUPABASE_URL = (process.env.SUPABASE_URL || "").trim();
const SERVICE = (process.env.SUPABASE_SERVICE_ROLE_KEY || "").trim();
const VT = (process.env.VERCEL_TOKEN || "").trim();
const VP = (process.env.VERCEL_PROJECT_ID || "").trim();
const VTEAM = (process.env.VERCEL_TEAM_ID || "").trim();
const STRIPE_KEY = (process.env.STRIPE_SECRET_KEY || "").trim();
const CRON_SECRET = (process.env.CRON_SECRET || "").trim();

const BATCH = 50;        // rows handled per run — plenty, and safely under the function timeout
const STUCK_HOURS = 6;   // an order still not done after this long → refund + fail

const svc = { apikey: SERVICE, Authorization: "Bearer " + SERVICE };

function ageHours(ts) { try { return (Date.now() - new Date(ts).getTime()) / 3600000; } catch { return 0; } }

async function vfetch(path, opts) {
  const t = VTEAM ? ("teamId=" + VTEAM) : "";
  const url = "https://api.vercel.com" + path + (t ? ((path.includes("?") ? "&" : "?") + t) : "");
  return fetch(url, { ...(opts || {}), headers: { Authorization: "Bearer " + VT, "Content-Type": "application/json", ...((opts && opts.headers) || {}) } });
}

async function sbPatch(pathAndQuery, body) {
  try {
    await fetch(SUPABASE_URL + "/rest/v1/" + pathAndQuery, {
      method: "PATCH",
      headers: { ...svc, "Content-Type": "application/json", Prefer: "return=minimal" },
      body: JSON.stringify(body),
    });
  } catch { /* swallow; next run retries */ }
}

async function refund(pi) {
  try {
    if (!STRIPE_KEY || !pi) return;
    await fetch("https://api.stripe.com/v1/refunds", {
      method: "POST",
      headers: { Authorization: "Bearer " + STRIPE_KEY, "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ payment_intent: String(pi) }).toString(),
    });
  } catch { /* already-refunded etc. → Stripe errors; harmless, we still flip status */ }
}

async function getOrder(orderId) {
  try {
    const r = await vfetch("/v1/registrar/orders/" + encodeURIComponent(orderId));
    const j = await r.json().catch(() => ({}));
    return { ok: r.ok, j };
  } catch { return { ok: false, j: {} }; }
}

// Vercel order status: draft | purchasing | completed | failed (top-level), with a per-domain
// status/error inside `domains[]`. Collapse both into one of: completed | failed | pending.
function orderState(j) {
  const top = String((j && j.status) || "").toLowerCase();
  if (top === "completed") return "completed";
  if (top === "failed") return "failed";
  const d = j && Array.isArray(j.domains) && j.domains[0];
  const ds = d && String(d.status || "").toLowerCase();
  if (ds === "completed" || ds === "active" || ds === "registered") return "completed";
  if (ds === "failed") return "failed";
  return "pending"; // draft / purchasing / anything still in flight
}

async function attachToProject(domain) {
  const addOne = async (name) => { try { await vfetch("/v10/projects/" + VP + "/domains", { method: "POST", body: JSON.stringify({ name }) }); } catch { } };
  await addOne(domain);
  if (domain.split(".").length <= 2) await addOne("www." + domain); // apex → also add www
}

export default async function handler(req, res) {
  // Vercel Cron automatically sends `Authorization: Bearer $CRON_SECRET` when CRON_SECRET
  // is set on the project. If it's set, require it so nobody else can trigger this route.
  if (CRON_SECRET && (req.headers.authorization || "") !== "Bearer " + CRON_SECRET) {
    return res.status(401).json({ error: "unauthorized" });
  }
  if (!SUPABASE_URL || !SERVICE || !VT || !VP) return res.status(500).json({ error: "not configured" });

  const out = { checked: 0, completed: 0, failed: 0, still_pending: 0 };
  try {
    const q = await fetch(
      SUPABASE_URL + "/rest/v1/domains?select=id,domain,user_id,site_id,order_id,payment_intent,status,expires_at,pending_since" +
      "&status=in.(pending,renewing)&order=pending_since.asc&limit=" + BATCH,
      { headers: svc }
    );
    const rows = await q.json().catch(() => []);
    if (!Array.isArray(rows)) return res.status(200).json(out);

    for (const row of rows) {
      out.checked++;
      const isRenew = row.status === "renewing";
      const domain = String(row.domain || "").toLowerCase();

      // No order id on a pending row (shouldn't happen) — fail it out if it's been too long.
      if (!row.order_id) {
        if (!isRenew && ageHours(row.pending_since) > STUCK_HOURS) {
          await refund(row.payment_intent);
          await sbPatch("domains?id=eq." + row.id, { status: "failed" });
          out.failed++;
        } else { out.still_pending++; }
        continue;
      }

      const { ok, j } = await getOrder(row.order_id);
      if (!ok) { out.still_pending++; continue; } // transient (network / 5xx) → try next run
      const state = orderState(j);

      if (state === "completed") {
        if (isRenew) {
          // extend from the later of (current expiry, now) + 1 year
          let base = Date.now();
          const cur = row.expires_at ? new Date(row.expires_at).getTime() : 0;
          if (cur > base) base = cur;
          const next = new Date(base + 365 * 86400000).toISOString();
          await sbPatch("domains?id=eq." + row.id, { status: "active", expires_at: next, remind30_sent: false, remind7_sent: false });
        } else {
          await attachToProject(domain);
          const target = row.site_id ? ("websites?id=eq." + row.site_id) : ("websites?user_id=eq." + row.user_id);
          await sbPatch(target, { custom_domain: domain });
          const expires = new Date(Date.now() + 365 * 86400000).toISOString();
          await sbPatch("domains?id=eq." + row.id, { status: "active", expires_at: expires });
        }
        out.completed++;
      } else if (state === "failed") {
        await refund(row.payment_intent);
        // failed renewal → they still own it until the existing expiry, so keep it active.
        await sbPatch("domains?id=eq." + row.id, isRenew ? { status: "active" } : { status: "failed" });
        out.failed++;
      } else {
        // still draft/purchasing — give it time, but don't let money hang forever.
        if (ageHours(row.pending_since) > STUCK_HOURS) {
          await refund(row.payment_intent);
          await sbPatch("domains?id=eq." + row.id, isRenew ? { status: "active" } : { status: "failed" });
          out.failed++;
        } else { out.still_pending++; }
      }
    }

    return res.status(200).json(out);
  } catch (e) {
    return res.status(200).json({ ...out, error: "partial" });
  }
}
