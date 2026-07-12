// ============================================================================
// /api/fakeit-generate.js  —  Generate an image using the user's OWN trained model
// ----------------------------------------------------------------------------
// Takes a prompt like "at the Amalfi Coast in a red gown", finds the signed-in
// user's trained "Fake It" model, and renders THEM into that scene.
//
// SAFETY:
//   - Only ever loads a model that belongs to the signed-in user.
//   - fal's safety checker is ON; any image flagged NSFW is rejected.
//   - A prompt blocklist rejects explicit requests before we spend anything.
//
// ENV VARS: FAL_KEY, SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY
// ============================================================================

const FAL_KEY = process.env.FAL_KEY || '';
const SUPABASE_URL = process.env.SUPABASE_URL || '';
const SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || '';

// Blocked outright — this tool is for putting YOU in nice places, not this.
const BLOCKED = [
  'nude','naked','nsfw','porn','explicit','topless','lingerie','underwear',
  'sexual','erotic','fetish','undressed','strip','bikini shoot nude','xxx',
  'child','kid','minor','teen','underage','baby','toddler',
];

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

async function getUserId(req) {
  const auth = req.headers['authorization'] || '';
  const token = auth.replace(/^Bearer\s+/i, '');
  if (!token) return null;
  const r = await fetch(SUPABASE_URL + '/auth/v1/user', {
    headers: { apikey: SERVICE_KEY, Authorization: 'Bearer ' + token },
  });
  if (!r.ok) return null;
  const u = await r.json();
  return (u && u.id) || null;
}

export default async function handler(req, res) {
  if (req.method !== 'POST') { res.status(405).json({ error: 'Method not allowed' }); return; }
  if (!FAL_KEY || !SUPABASE_URL || !SERVICE_KEY) { res.status(500).json({ error: 'Server not configured' }); return; }

  const userId = await getUserId(req);
  if (!userId) { res.status(401).json({ error: 'Not signed in' }); return; }

  let body = req.body;
  if (typeof body === 'string') { try { body = JSON.parse(body); } catch { body = {}; } }
  const { prompt, modelId, aspect } = body || {};

  if (!prompt || typeof prompt !== 'string' || prompt.trim().length < 3) {
    res.status(400).json({ error: 'Tell us the scene you want.' });
    return;
  }

  // --- Prompt safety check (before we spend a cent) -------------------------
  const lower = prompt.toLowerCase();
  if (BLOCKED.some(w => lower.includes(w))) {
    res.status(400).json({ error: "That's outside what Fake It is for. Try a place, an outfit, or a vibe." });
    return;
  }

  try {
    // --- Load the user's model — and ONLY the user's own model --------------
    let q = '/rest/v1/user_models?user_id=eq.' + encodeURIComponent(userId) +
            '&status=eq.ready&select=id,lora_url,trigger_word&order=created_at.desc&limit=1';
    if (modelId) {
      q = '/rest/v1/user_models?user_id=eq.' + encodeURIComponent(userId) +
          '&id=eq.' + encodeURIComponent(modelId) +
          '&status=eq.ready&select=id,lora_url,trigger_word&limit=1';
    }
    const mres = await sb(q);
    const models = mres.ok ? await mres.json() : [];
    const model = Array.isArray(models) ? models[0] : null;

    if (!model || !model.lora_url) {
      res.status(400).json({ error: 'No trained model yet. Train your Fake It model first.' });
      return;
    }

    // The trigger word tells the model "this is the person" — prepend it.
    const fullPrompt = model.trigger_word
      ? (model.trigger_word + ', ' + prompt.trim())
      : prompt.trim();

    const sizeMap = {
      '1:1': 'square_hd',
      '4:5': 'portrait_4_3',
      '9:16': 'portrait_16_9',
      '16:9': 'landscape_16_9',
      '3:2': 'landscape_4_3',
    };
    const image_size = sizeMap[aspect] || 'portrait_4_3';

    // --- Generate --------------------------------------------------------
    const r = await fetch('https://fal.run/fal-ai/flux-lora', {
      method: 'POST',
      headers: { Authorization: 'Key ' + FAL_KEY, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        prompt: fullPrompt,
        loras: [{ path: model.lora_url, scale: 1.0 }],
        image_size,
        num_inference_steps: 28,
        guidance_scale: 3.5,
        num_images: 1,
        enable_safety_checker: true,   // SAFETY: fal flags NSFW output
        output_format: 'jpeg',
      }),
    });

    if (!r.ok) throw new Error('Generation failed: ' + (await r.text()));
    const data = await r.json();

    // --- SAFETY: refuse anything the checker flagged -----------------------
    const flagged = Array.isArray(data.has_nsfw_concepts) && data.has_nsfw_concepts.some(Boolean);
    if (flagged) {
      res.status(400).json({ error: 'That image was blocked by our safety filter. Try a different scene.' });
      return;
    }

    const url = data.images && data.images[0] && data.images[0].url;
    if (!url) throw new Error('No image came back.');

    res.status(200).json({ ok: true, image: url });
  } catch (err) {
    console.error('[fakeit-generate]', err && err.message);
    res.status(500).json({ error: (err && err.message) || 'Could not create that image.' });
  }
}
