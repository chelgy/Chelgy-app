// ============================================================================
// /api/fal-webhook.js  —  fal.ai calls this when a "Fake It" model finishes
// ----------------------------------------------------------------------------
// Training takes ~30-60 minutes, so we don't sit and wait. fal pings this URL
// when the job is done. We match it back to the user's row by fal_request_id
// and either save the trained model file (status: ready) or record the error.
//
// ENV VARS: SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY  (already set)
// ============================================================================

const SUPABASE_URL = process.env.SUPABASE_URL || '';
const SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || '';

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

export default async function handler(req, res) {
  if (req.method !== 'POST') { res.status(405).json({ error: 'Method not allowed' }); return; }
  if (!SUPABASE_URL || !SERVICE_KEY) { res.status(500).json({ error: 'Server not configured' }); return; }

  let body = req.body;
  if (typeof body === 'string') { try { body = JSON.parse(body); } catch { body = null; } }
  if (!body) { res.status(200).json({ ok: true, note: 'no body' }); return; }

  // fal sends: { request_id, status: "OK" | "ERROR", payload: {...}, error: ... }
  const requestId = body.request_id || body.requestId;
  if (!requestId) { res.status(200).json({ ok: true, note: 'no request id' }); return; }

  const ok = body.status === 'OK' || body.status === 'COMPLETED';
  const payload = body.payload || {};
  const loraUrl =
    (payload.diffusers_lora_file && payload.diffusers_lora_file.url) || null;

  const patch = ok && loraUrl
    ? { status: 'ready', lora_url: loraUrl, updated_at: new Date().toISOString() }
    : {
        status: 'failed',
        error: String(
          (body.error && (body.error.message || body.error)) ||
          (!loraUrl && ok ? 'Training finished but returned no model file.' : 'Training failed.')
        ).slice(0, 500),
        updated_at: new Date().toISOString(),
      };

  try {
    const upd = await sb(
      '/rest/v1/user_models?fal_request_id=eq.' + encodeURIComponent(requestId),
      { method: 'PATCH', headers: { Prefer: 'return=minimal' }, body: JSON.stringify(patch) }
    );
    if (!upd.ok) throw new Error(await upd.text());
    res.status(200).json({ ok: true });
  } catch (err) {
    console.error('[fal-webhook]', err && err.message);
    // 500 tells fal to retry.
    res.status(500).json({ error: 'update failed' });
  }
}
