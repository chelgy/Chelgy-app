// ============================================================================
// /api/revenuecat-webhook.js  —  Apple purchase → Supabase (secure)
// ----------------------------------------------------------------------------
// RevenueCat calls this URL every time something happens with a purchase
// (a membership starts/renews/expires, or a credit pack is bought). This is
// the ONLY place credits and membership get granted, so a purchase can't be
// faked from the app.
//
// It uses the Supabase SERVICE ROLE key (server-side secret) to write the
// member's row directly, matching on `user_id` — which is the same Supabase
// user id the app hands RevenueCat as the "app user id".
//
// ENVIRONMENT VARIABLES this needs (set in Vercel → Project → Settings → Env):
//   SUPABASE_URL                 e.g. https://YOURPROJECT.supabase.co
//   SUPABASE_SERVICE_ROLE_KEY    Supabase → Settings → API → service_role key (SECRET)
//   REVENUECAT_WEBHOOK_SECRET    any long random string you make up; paste the
//                                SAME value into RevenueCat's webhook Authorization field
// ============================================================================

const SUPABASE_URL =
  process.env.SUPABASE_URL || process.env.NEXT_PUBLIC_SUPABASE_URL || '';
const SERVICE_KEY =
  process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_SERVICE_KEY || '';
const WEBHOOK_SECRET = process.env.REVENUECAT_WEBHOOK_SECRET || '';

// Membership + credit-pack product ids (must match App Store Connect exactly).
const MEMBERSHIP_PRODUCT_ID = 'com.chelgy.app.membership.monthly';
const MEMBERSHIP_ENTITLEMENT = 'pro';
const PACK_CREDITS = {
  'com.chelgy.app.credits.starter': 33000,
  'com.chelgy.app.credits.creator': 70000,
  'com.chelgy.app.credits.pro':     150000,
  'com.chelgy.app.credits.studio':  400000,
  'com.chelgy.app.credits.agency2': 850000,
};

// Small helper for Supabase REST calls with the service-role key.
function sb(path, options = {}) {
  return fetch(SUPABASE_URL + path, {
    ...options,
    headers: {
      apikey: SERVICE_KEY,
      Authorization: 'Bearer ' + SERVICE_KEY,
      'Content-Type': 'application/json',
      ...(options.headers || {}),
    },
  });
}

// Set the member's membership status (active / expired / past_due).
async function setMemberStatus(userId, status) {
  const res = await sb(
    '/rest/v1/members?user_id=eq.' + encodeURIComponent(userId),
    { method: 'PATCH', headers: { Prefer: 'return=minimal' }, body: JSON.stringify({ status }) }
  );
  if (!res.ok) throw new Error('status update failed: ' + res.status + ' ' + (await res.text()));
}

// Atomically add purchased credits (uses the SQL function in the setup file).
async function addCredits(userId, amount) {
  const res = await sb('/rest/v1/rpc/add_purchased_credits', {
    method: 'POST',
    body: JSON.stringify({ p_user_id: userId, p_amount: amount }),
  });
  if (!res.ok) throw new Error('credit grant failed: ' + res.status + ' ' + (await res.text()));
}

// Idempotency: claim an event id so retries never double-grant. Returns:
//   true  = freshly claimed (go ahead and process)
//   false = already processed (skip)
async function claimEvent(eventId) {
  const res = await sb('/rest/v1/rc_events', {
    method: 'POST',
    headers: { Prefer: 'return=minimal' },
    body: JSON.stringify({ event_id: eventId }),
  });
  if (res.status === 201 || res.ok) return true;
  if (res.status === 409) return false; // duplicate primary key = already handled
  throw new Error('claim failed: ' + res.status + ' ' + (await res.text()));
}
async function releaseEvent(eventId) {
  try {
    await sb('/rest/v1/rc_events?event_id=eq.' + encodeURIComponent(eventId), { method: 'DELETE' });
  } catch (_) {}
}

export default async function handler(req, res) {
  // 1) Only POST.
  if (req.method !== 'POST') { res.status(405).json({ error: 'Method not allowed' }); return; }

  // 2) Verify the shared secret (RevenueCat sends it in the Authorization header).
  const auth = req.headers['authorization'] || '';
  if (!WEBHOOK_SECRET || auth !== WEBHOOK_SECRET) {
    res.status(401).json({ error: 'Unauthorized' });
    return;
  }

  // 3) Make sure the server is configured.
  if (!SUPABASE_URL || !SERVICE_KEY) {
    console.error('[RC webhook] Missing SUPABASE_URL or SERVICE key env vars.');
    res.status(500).json({ error: 'Server not configured' });
    return;
  }

  // 4) Parse the event.
  let body = req.body;
  if (typeof body === 'string') { try { body = JSON.parse(body); } catch { body = null; } }
  const event = body && body.event;
  if (!event) { res.status(200).json({ ok: true, note: 'no event (test ping?)' }); return; }

  const type = event.type;
  const userId = event.app_user_id;
  const productId = event.product_id;
  const entitlements = event.entitlement_ids || (event.entitlement_id ? [event.entitlement_id] : []);
  const eventId = event.id || (event.transaction_id + ':' + type);

  // RevenueCat's "Send test event" and anonymous ids have nothing to grant.
  if (!userId || String(userId).startsWith('$RCAnonymousID')) {
    res.status(200).json({ ok: true, note: 'no real user id' });
    return;
  }

  // 5) Decide what this event means.
  const touchesMembership =
    productId === MEMBERSHIP_PRODUCT_ID || entitlements.includes(MEMBERSHIP_ENTITLEMENT);

  let action = null; // { kind:'status', status } | { kind:'credits', amount }
  if (['INITIAL_PURCHASE', 'RENEWAL', 'UNCANCELLATION', 'PRODUCT_CHANGE', 'SUBSCRIPTION_EXTENDED'].includes(type) && touchesMembership) {
    action = { kind: 'status', status: 'active' };
  } else if (type === 'EXPIRATION' && touchesMembership) {
    action = { kind: 'status', status: 'expired' };
  } else if (type === 'BILLING_ISSUE' && touchesMembership) {
    action = { kind: 'status', status: 'past_due' };
  } else if (type === 'NON_RENEWING_PURCHASE' && PACK_CREDITS[productId]) {
    action = { kind: 'credits', amount: PACK_CREDITS[productId] };
  }

  // CANCELLATION (auto-renew turned off) is intentionally ignored — the member
  // keeps access until EXPIRATION. Anything else we don't recognize is a no-op.
  if (!action) { res.status(200).json({ ok: true, note: 'ignored: ' + type }); return; }

  // 6) Claim the event (idempotency), then apply it.
  let claimed = false;
  try {
    claimed = await claimEvent(eventId);
    if (!claimed) { res.status(200).json({ ok: true, note: 'already processed' }); return; }

    if (action.kind === 'status') await setMemberStatus(userId, action.status);
    else if (action.kind === 'credits') await addCredits(userId, action.amount);

    res.status(200).json({ ok: true });
  } catch (err) {
    console.error('[RC webhook] processing error:', err && err.message);
    if (claimed) await releaseEvent(eventId); // let RevenueCat retry cleanly
    res.status(500).json({ error: 'processing failed' });
  }
}
