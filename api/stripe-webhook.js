// api/stripe-webhook.js
// The ONLY place a purchase changes anything server-side.
//   • Credit packs → add credits
//   • Marketer / member membership subscription → flip account to "active"
//   • Subscription cancel / payment failure / recovery → adjust access
//   • Store sales (Stripe Connect stores) → record the order in store_orders
//
// Stripe calls this URL after a payment. We verify the request is genuinely from
// Stripe (signature check), then act using the Supabase service-role key — which
// only lives on the server. The browser is never involved, so nothing can be faked.
//
// One endpoint handles BOTH memberships/credits AND store orders. They're told
// apart by metadata: membership/credit sessions carry user_id + kind/credits;
// store sessions carry owner_id + items + fee.
//
// Required Vercel env vars:
//   STRIPE_WEBHOOK_SECRET, SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY

import crypto from "crypto";

// We need Stripe's RAW request body to verify the signature, so turn off
// Vercel's automatic body parsing for this function.
export const config = { api: { bodyParser: false } };

function readRaw(req) {
  return new Promise((resolve, reject) => {
    let data = "";
    req.on("data", (c) => (data += c));
    req.on("end", () => resolve(data));
    req.on("error", reject);
  });
}

function verifyStripe(payload, sigHeader, secret) {
  try {
    const parts = {};
    sigHeader.split(",").forEach((kv) => { const [k, v] = kv.split("="); parts[k] = v; });
    if (!parts.t || !parts.v1) return false;
    const signed = parts.t + "." + payload;
    const expected = crypto.createHmac("sha256", secret).update(signed, "utf8").digest("hex");
    const a = Buffer.from(expected);
    const b = Buffer.from(parts.v1);
    return a.length === b.length && crypto.timingSafeEqual(a, b);
  } catch { return false; }
}

export default async function handler(req, res) {
  if (req.method !== "POST") return res.status(405).end();

  const secret = (process.env.STRIPE_WEBHOOK_SECRET || "").trim();
  const sig = req.headers["stripe-signature"];
  let raw;
  try { raw = await readRaw(req); } catch { return res.status(400).json({ error: "no body" }); }
  if (!secret || !sig || !verifyStripe(raw, sig, secret)) {
    return res.status(400).json({ error: "Invalid signature" });
  }

  let event;
  try { event = JSON.parse(raw); } catch { return res.status(400).json({ error: "bad json" }); }

  const SUPABASE_URL = (process.env.SUPABASE_URL || "").trim();
  const SERVICE = (process.env.SUPABASE_SERVICE_ROLE_KEY || "").trim();

  async function setMemberStatus(userId, status) {
    try {
      await fetch(SUPABASE_URL + "/rest/v1/members?user_id=eq." + userId, {
        method: "PATCH",
        headers: { "apikey": SERVICE, "Authorization": "Bearer " + SERVICE, "Content-Type": "application/json", "Prefer": "return=minimal" },
        body: JSON.stringify({ status })
      });
    } catch { /* swallow; Stripe retries on non-200 */ }
  }
  async function addCredits(userId, credits, packId) {
    try {
      await fetch(SUPABASE_URL + "/rest/v1/rpc/add_credits", {
        method: "POST",
        headers: { "apikey": SERVICE, "Authorization": "Bearer " + SERVICE, "Content-Type": "application/json" },
        body: JSON.stringify({ p_user: userId, p_amount: credits, p_reason: "purchase:" + (packId || "pack") })
      });
    } catch { /* swallow */ }
  }
  // A Business Manager invoice was paid via api/invoice-checkout.js → mark it paid.
  // Idempotent: re-running just sets the same fields again.
  async function markInvoicePaid(invoiceId) {
    if (!invoiceId) return;
    try {
      await fetch(SUPABASE_URL + "/rest/v1/bm_invoices?id=eq." + encodeURIComponent(invoiceId), {
        method: "PATCH",
        headers: { "apikey": SERVICE, "Authorization": "Bearer " + SERVICE, "Content-Type": "application/json", "Prefer": "return=minimal" },
        body: JSON.stringify({ status: "paid", paid_at: new Date().toISOString() })
      });
    } catch { /* swallow */ }
  }

  // A domain was bought through Chelgy via api/domain-checkout.js. Register it with
  // Vercel using the contact Stripe collected, then attach it to the member's project
  // and save it on their site. If registration fails, refund the member automatically.
  //   DOMAIN_AUTO_RENEW: false = member owns it for 1 year (Chelgy isn't billed again).
  //   Set true ONLY once you bill members yearly, or Chelgy's Vercel eats every renewal.
  async function registerDomain(s, meta) {
    const DOMAIN_AUTO_RENEW = false;
    const VT = (process.env.VERCEL_TOKEN || "").trim();
    const VP = (process.env.VERCEL_PROJECT_ID || "").trim();
    const VTEAM = (process.env.VERCEL_TEAM_ID || "").trim();
    const STRIPE_KEY = (process.env.STRIPE_SECRET_KEY || "").trim();
    const domain = String(meta.domain || "").toLowerCase();
    const ownerId = meta.owner_id;
    if (!VT || !VP || !domain || !ownerId) return;

    const teamSuffix = VTEAM ? ("teamId=" + VTEAM) : "";
    async function vfetch(path, opts) {
      const url = "https://api.vercel.com" + path + (teamSuffix ? ((path.includes("?") ? "&" : "?") + teamSuffix) : "");
      return fetch(url, { ...(opts || {}), headers: { Authorization: "Bearer " + VT, "Content-Type": "application/json", ...((opts && opts.headers) || {}) } });
    }
    async function refund() {
      try {
        if (!STRIPE_KEY || !s.payment_intent) return;
        await fetch("https://api.stripe.com/v1/refunds", {
          method: "POST",
          headers: { Authorization: "Bearer " + STRIPE_KEY, "Content-Type": "application/x-www-form-urlencoded" },
          body: new URLSearchParams({ payment_intent: String(s.payment_intent) }).toString()
        });
      } catch { /* swallow */ }
    }

    // registrant contact, from what Stripe collected at checkout
    const cd = s.customer_details || {};
    const nm = String(cd.name || "").trim().split(/\s+/).filter(Boolean);
    const ad = cd.address || {};
    const contact = {
      firstName: nm.length > 1 ? nm.slice(0, -1).join(" ") : (nm[0] || "Domain"),
      lastName: nm.length > 1 ? nm[nm.length - 1] : (nm[0] || "Owner"),
      email: cd.email || "",
      phone: cd.phone || "",
      address1: ad.line1 || "",
      city: ad.city || "",
      state: ad.state || ad.city || "NA",
      zip: ad.postal_code || "",
      country: ad.country || "US",
    };
    if (ad.line2) contact.address2 = ad.line2;

    try {
      // use the current price as expectedPrice so it can't mismatch
      let expected = null;
      try { const pr = await (await vfetch("/v1/registrar/domains/" + encodeURIComponent(domain) + "/price?years=1")).json(); if (pr && pr.purchasePrice != null) expected = parseFloat(pr.purchasePrice); } catch { }
      const buyBody = { autoRenew: DOMAIN_AUTO_RENEW, years: 1, contactInformation: contact };
      if (expected != null && isFinite(expected)) buyBody.expectedPrice = expected;

      const br = await vfetch("/v1/registrar/domains/" + encodeURIComponent(domain) + "/buy", { method: "POST", body: JSON.stringify(buyBody) });
      const bj = await br.json().catch(() => ({}));
      if (!br.ok || !bj.orderId) { await refund(); return; }

      // attach to the Vercel project (+ www for apex domains)
      const addOne = async (name) => { try { await vfetch("/v10/projects/" + VP + "/domains", { method: "POST", body: JSON.stringify({ name }) }); } catch { } };
      await addOne(domain);
      if (domain.split(".").length <= 2) await addOne("www." + domain);

      // save it on the member's site
      const target = meta.site_id ? ("websites?id=eq." + meta.site_id) : ("websites?user_id=eq." + ownerId);
      await fetch(SUPABASE_URL + "/rest/v1/" + target, {
        method: "PATCH",
        headers: { "apikey": SERVICE, "Authorization": "Bearer " + SERVICE, "Content-Type": "application/json", "Prefer": "return=minimal" },
        body: JSON.stringify({ custom_domain: domain })
      });

      // record it so the member can see + renew it (expires in 1 year)
      const expires = new Date(Date.now() + 365 * 86400000).toISOString();
      await fetch(SUPABASE_URL + "/rest/v1/domains", {
        method: "POST",
        headers: { "apikey": SERVICE, "Authorization": "Bearer " + SERVICE, "Content-Type": "application/json", "Prefer": "resolution=merge-duplicates" },
        body: JSON.stringify({ user_id: ownerId, domain, site_id: meta.site_id || null, expires_at: expires, order_id: bj.orderId || null })
      });
    } catch { /* swallow: order may still have gone through; avoid a wrong refund */ }
  }

  // A domain the member owns was renewed via api/domain-renew.js → renew at Vercel
  // and push its expiry out another year. Refunds if the renewal fails.
  async function renewDomain(s, meta) {
    const VT = (process.env.VERCEL_TOKEN || "").trim();
    const VTEAM = (process.env.VERCEL_TEAM_ID || "").trim();
    const STRIPE_KEY = (process.env.STRIPE_SECRET_KEY || "").trim();
    const domain = String(meta.domain || "").toLowerCase();
    if (!VT || !domain) return;
    const teamSuffix = VTEAM ? ("teamId=" + VTEAM) : "";
    async function vfetch(path, opts) {
      const url = "https://api.vercel.com" + path + (teamSuffix ? ((path.includes("?") ? "&" : "?") + teamSuffix) : "");
      return fetch(url, { ...(opts || {}), headers: { Authorization: "Bearer " + VT, "Content-Type": "application/json", ...((opts && opts.headers) || {}) } });
    }
    async function refund() {
      try { if (!STRIPE_KEY || !s.payment_intent) return; await fetch("https://api.stripe.com/v1/refunds", { method: "POST", headers: { Authorization: "Bearer " + STRIPE_KEY, "Content-Type": "application/x-www-form-urlencoded" }, body: new URLSearchParams({ payment_intent: String(s.payment_intent) }).toString() }); } catch { }
    }
    try {
      let expected = null;
      try { const pr = await (await vfetch("/v1/registrar/domains/" + encodeURIComponent(domain) + "/price?years=1")).json(); if (pr && pr.renewalPrice != null) expected = parseFloat(pr.renewalPrice); } catch { }
      const renewBody = { years: 1 };
      if (expected != null && isFinite(expected)) renewBody.expectedPrice = expected;
      const rr = await vfetch("/v1/registrar/domains/" + encodeURIComponent(domain) + "/renew", { method: "POST", body: JSON.stringify(renewBody) });
      const rj = await rr.json().catch(() => ({}));
      if (!rr.ok || !rj.orderId) { await refund(); return; }
      // extend from the later of (current expiry, now) + 1 year
      let cur = Date.now();
      try {
        const g = await fetch(SUPABASE_URL + "/rest/v1/domains?select=expires_at&domain=eq." + encodeURIComponent(domain) + "&limit=1", { headers: { apikey: SERVICE, Authorization: "Bearer " + SERVICE } });
        const rows = await g.json().catch(() => []);
        const t = rows && rows[0] && rows[0].expires_at ? new Date(rows[0].expires_at).getTime() : 0;
        if (t > cur) cur = t;
      } catch { }
      const next = new Date(cur + 365 * 86400000).toISOString();
      await fetch(SUPABASE_URL + "/rest/v1/domains?domain=eq." + encodeURIComponent(domain), {
        method: "PATCH",
        headers: { "apikey": SERVICE, "Authorization": "Bearer " + SERVICE, "Content-Type": "application/json", "Prefer": "return=minimal" },
        body: JSON.stringify({ expires_at: next, order_id: rj.orderId || null, remind30_sent: false, remind7_sent: false })
      });
    } catch { /* swallow */ }
  }
  // Update a member's status looked up by email. onlyFrom (optional) restricts the
  // update to members currently in those statuses — so we never clobber admin/comp
  // accounts or re-suspend someone who's fine.
  async function setMemberStatusByEmail(email, status, onlyFrom) {
    if (!email) return;
    try {
      let url = SUPABASE_URL + "/rest/v1/members?email=eq." + encodeURIComponent(email);
      if (onlyFrom && onlyFrom.length) url += "&status=in.(" + onlyFrom.join(",") + ")";
      await fetch(url, {
        method: "PATCH",
        headers: { "apikey": SERVICE, "Authorization": "Bearer " + SERVICE, "Content-Type": "application/json", "Prefer": "return=minimal" },
        body: JSON.stringify({ status })
      });
    } catch { /* swallow */ }
  }
  // Record a store sale (Stripe Connect stores). Prices/fee come from the checkout
  // session metadata that api/stripe-checkout.js stamped on. Upsert on session_id so
  // a retried webhook never double-books the order.
  async function recordStoreOrder(s, meta) {
    try {
      let items = [];
      try { items = JSON.parse(meta.items || "[]"); } catch {}
      const ship = s.shipping_details || (s.collected_information && s.collected_information.shipping_details) || null;
      const addr = (ship && ship.address) || (s.customer_details && s.customer_details.address) || null;
      const shipName = (ship && ship.name) || (s.customer_details && s.customer_details.name) || null;
      const shipAddr = addr ? [addr.line1, addr.line2, addr.city, addr.state, addr.postal_code, addr.country].filter(Boolean).join(", ") : null;
      const order = {
        owner_id: meta.owner_id || null,
        session_id: s.id || null,
        customer_email: (s.customer_details && s.customer_details.email) || s.customer_email || null,
        amount_total: typeof s.amount_total === "number" ? s.amount_total : null,
        currency: s.currency || "usd",
        application_fee: meta.fee ? parseInt(meta.fee, 10) : null,
        items,
        shipping_name: shipName,
        shipping_address: shipAddr,
        status: "paid",
      };
      if (order.owner_id && order.session_id) {
        await fetch(SUPABASE_URL + "/rest/v1/store_orders", {
          method: "POST",
          headers: { "apikey": SERVICE, "Authorization": "Bearer " + SERVICE, "Content-Type": "application/json", "Prefer": "resolution=merge-duplicates" },
          body: JSON.stringify(order)
        });
      }
    } catch { /* swallow */ }
  }

  if (event.type === "checkout.session.completed") {
    const s = event.data.object || {};
    const meta = s.metadata || {};
    const userId = meta.user_id;
    const paid = s.payment_status === "paid" || s.status === "complete";

    // ── Memberships & credits (unchanged) ──
    if (paid && userId) {
      // Marketer membership subscription → activate the marketer
      if (meta.kind === "marketer_membership") {
        await setMemberStatus(userId, "active");
      }
      // Regular member subscription → activate the member.
      // (Their monthly allowance is granted by the monthly claim on next login.)
      if (meta.kind === "member_membership") {
        await setMemberStatus(userId, "active");
      }
      // Credit pack purchase → add credits
      const credits = parseInt(meta.credits, 10);
      if (credits > 0) {
        await addCredits(userId, credits, meta.pack_id);
      }
    }

    // ── Store sale (Stripe Connect stores) → record the order ──
    // Store sessions have no "type" in metadata; invoice/domain sessions do.
    if (paid && meta.owner_id && !meta.type) {
      await recordStoreOrder(s, meta);
    }

    // ── Business Manager invoice paid → flip the invoice to "paid" ──
    if (paid && meta.type === "invoice" && meta.invoice_id) {
      await markInvoicePaid(meta.invoice_id);
    }

    // ── Domain bought through Chelgy → register it via Vercel + connect it ──
    if (paid && meta.type === "domain" && meta.domain && meta.owner_id) {
      await registerDomain(s, meta);
    }

    // ── Domain renewed through Chelgy → extend it another year ──
    if (paid && meta.type === "domain_renew" && meta.domain && meta.owner_id) {
      await renewDomain(s, meta);
    }
  }

  // Marketer or member cancels / subscription lapses → revoke access
  if (event.type === "customer.subscription.deleted") {
    const sub = event.data.object || {};
    const meta = sub.metadata || {};
    if (meta.user_id && (meta.kind === "marketer_membership" || meta.kind === "member_membership")) {
      await setMemberStatus(meta.user_id, "canceled");
    }
  }

  // A subscription payment failed (card declined mid-membership) → suspend access.
  // Only touches members who were actively paying, so admin/comp accounts are safe.
  if (event.type === "invoice.payment_failed") {
    const inv = event.data.object || {};
    if (inv.subscription && inv.customer_email) {
      await setMemberStatusByEmail(inv.customer_email, "past_due", ["active", "paid"]);
    }
  }

  // A subscription payment cleared (initial or a recovered retry) → restore access.
  // Only un-suspends someone currently past_due; won't disturb admin/comp/active.
  if (event.type === "invoice.payment_succeeded") {
    const inv = event.data.object || {};
    if (inv.subscription && inv.customer_email) {
      await setMemberStatusByEmail(inv.customer_email, "active", ["past_due"]);
    }
  }

  // Always acknowledge receipt so Stripe doesn't retry endlessly
  return res.status(200).json({ received: true });
}
