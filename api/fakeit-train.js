// ============================================================================
// /api/fakeit-train.js  —  "Fake It" model training (fal.ai Flux LoRA)
// ----------------------------------------------------------------------------
// WHAT IT DOES:
//   Takes the photos a user uploaded of THEMSELVES, zips them, sends them to
//   fal.ai to train a personal LoRA model, and records the job in Supabase.
//   Training runs in the background (~30-60 min); fal calls /api/fal-webhook
//   when it finishes, which flips the model to "ready".
//
// SAFETY:
//   - Requires an explicit self-consent flag from the client.
//   - Only ever trains on images the signed-in user uploaded to their own folder.
//   - One active model per user at a time (prevents runaway spend).
//
// ENV VARS NEEDED (Vercel → Settings → Environment Variables):
//   FAL_KEY                     your fal.ai API key
//   SUPABASE_URL                (already set)
//   SUPABASE_SERVICE_ROLE_KEY   (already set)
// ============================================================================

const FAL_KEY = process.env.FAL_KEY || '';
const SUPABASE_URL = process.env.SUPABASE_URL || '';
const SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || '';

const BUCKET = 'ai-twin-training';
const TRAINING_STEPS = 1000;          // good likeness without overfitting
const MIN_PHOTOS = 8;
const MAX_PHOTOS = 25;

// Where fal should call us back when training finishes.
const WEBHOOK_URL = 'https://chelgy.app/api/fal-webhook';

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

// Verify the caller's token and return their user id (never trust the client).
async function getUserId(req) {
  const auth = req.headers['authorization'] || '';
  const token = auth.replace(/^Bearer\s+/i, '');
  if (!token) return null;
  const res = await fetch(SUPABASE_URL + '/auth/v1/user', {
    headers: { apikey: SERVICE_KEY, Authorization: 'Bearer ' + token },
  });
  if (!res.ok) return null;
  const user = await res.json();
  return (user && user.id) || null;
}

export default async function handler(req, res) {
  if (req.method !== 'POST') { res.status(405).json({ error: 'Method not allowed' }); return; }
  if (!FAL_KEY || !SUPABASE_URL || !SERVICE_KEY) {
    res.status(500).json({ error: 'Server not configured' });
    return;
  }

  // --- 1) Who is calling? ---------------------------------------------------
  const userId = await getUserId(req);
  if (!userId) { res.status(401).json({ error: 'Not signed in' }); return; }

  let body = req.body;
  if (typeof body === 'string') { try { body = JSON.parse(body); } catch { body = {}; } }
  const { paths, consent, name } = body || {};

  // --- 2) Safety gate: explicit self-consent -------------------------------
  if (consent !== true) {
    res.status(400).json({ error: 'Consent required: these must be photos of yourself.' });
    return;
  }

  // --- 3) Validate the photo set -------------------------------------------
  if (!Array.isArray(paths) || paths.length < MIN_PHOTOS || paths.length > MAX_PHOTOS) {
    res.status(400).json({ error: 'Please upload between ' + MIN_PHOTOS + ' and ' + MAX_PHOTOS + ' photos.' });
    return;
  }
  // Every path must live inside THIS user's folder — no reaching into others'.
  const badPath = paths.find(p => typeof p !== 'string' || !p.startsWith(userId + '/'));
  if (badPath) { res.status(403).json({ error: 'Invalid photo path.' }); return; }

  try {
    // --- 4) Don't allow a second training run while one is in flight -------
    const existing = await sb(
      '/rest/v1/user_models?user_id=eq.' + encodeURIComponent(userId) + '&status=eq.training&select=id'
    );
    const inFlight = existing.ok ? await existing.json() : [];
    if (Array.isArray(inFlight) && inFlight.length > 0) {
      res.status(409).json({ error: 'You already have a model training. Hang tight!' });
      return;
    }

    // --- 5) Build a ZIP of the user's photos for fal -----------------------
    // Get short-lived signed URLs for each private photo, download them, zip them.
    const signed = await sb('/storage/v1/object/sign/' + BUCKET, {
      method: 'POST',
      body: JSON.stringify({ expiresIn: 3600, paths }),
    });
    if (!signed.ok) throw new Error('Could not read your photos: ' + (await signed.text()));
    const signedList = await signed.json(); // [{ path, signedURL }]

    const files = [];
    for (const item of signedList) {
      const url = SUPABASE_URL + '/storage/v1' + item.signedURL;
      const img = await fetch(url);
      if (!img.ok) throw new Error('Could not download a photo.');
      const buf = Buffer.from(await img.arrayBuffer());
      const ext = (item.path.split('.').pop() || 'jpg').toLowerCase();
      files.push({ name: 'img_' + files.length + '.' + ext, data: buf });
    }

    const zipBuffer = makeZip(files);

    // --- 6) Upload the ZIP to fal's file storage ---------------------------
    const zipUrl = await falUpload(zipBuffer, 'training.zip', 'application/zip');

    // --- 7) Kick off training (queued; fal will call our webhook when done) --
    // A unique trigger word so this person's model activates reliably.
    const triggerWord = 'chlg' + userId.replace(/-/g, '').slice(0, 8);

    const submit = await fetch(
      'https://queue.fal.run/fal-ai/flux-lora-portrait-trainer?fal_webhook=' + encodeURIComponent(WEBHOOK_URL),
      {
        method: 'POST',
        headers: { Authorization: 'Key ' + FAL_KEY, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          images_data_url: zipUrl,
          steps: TRAINING_STEPS,
          trigger_phrase: triggerWord,
          subject_crop: true,
          multiresolution_training: true,
        }),
      }
    );
    if (!submit.ok) throw new Error('Training could not start: ' + (await submit.text()));
    const job = await submit.json();
    const requestId = job.request_id || job.requestId;
    if (!requestId) throw new Error('Training did not return a job id.');

    // --- 8) Record it so the webhook can find it later ---------------------
    const insert = await sb('/rest/v1/user_models', {
      method: 'POST',
      headers: { Prefer: 'return=representation' },
      body: JSON.stringify({
        user_id: userId,
        name: (typeof name === 'string' && name.trim()) ? name.trim().slice(0, 60) : 'My Fake It Model',
        status: 'training',
        fal_request_id: requestId,
        trigger_word: triggerWord,
      }),
    });
    if (!insert.ok) throw new Error('Could not save your model: ' + (await insert.text()));
    const rows = await insert.json();

    res.status(200).json({
      ok: true,
      model: Array.isArray(rows) ? rows[0] : rows,
      message: 'Training started. This takes about 30-60 minutes — we\'ll have it ready for you.',
    });
  } catch (err) {
    console.error('[fakeit-train]', err && err.message);
    res.status(500).json({ error: (err && err.message) || 'Training failed to start.' });
  }
}

// ---------------------------------------------------------------------------
// Upload a buffer to fal's file storage, return its public URL.
// ---------------------------------------------------------------------------
async function falUpload(buffer, fileName, contentType) {
  // Step 1: ask fal for an upload target
  const init = await fetch('https://rest.alpha.fal.ai/storage/upload/initiate', {
    method: 'POST',
    headers: { Authorization: 'Key ' + FAL_KEY, 'Content-Type': 'application/json' },
    body: JSON.stringify({ file_name: fileName, content_type: contentType }),
  });
  if (!init.ok) throw new Error('fal upload init failed: ' + (await init.text()));
  const { upload_url, file_url } = await init.json();

  // Step 2: PUT the bytes
  const put = await fetch(upload_url, {
    method: 'PUT',
    headers: { 'Content-Type': contentType },
    body: buffer,
  });
  if (!put.ok) throw new Error('fal upload failed: ' + put.status);

  return file_url;
}

// ---------------------------------------------------------------------------
// Minimal ZIP writer (stored / no compression). Avoids extra dependencies.
// ---------------------------------------------------------------------------
function makeZip(files) {
  const chunks = [];
  const central = [];
  let offset = 0;

  const crcTable = (() => {
    const t = [];
    for (let n = 0; n < 256; n++) {
      let c = n;
      for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
      t[n] = c >>> 0;
    }
    return t;
  })();
  const crc32 = (buf) => {
    let c = 0xffffffff;
    for (let i = 0; i < buf.length; i++) c = crcTable[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
    return (c ^ 0xffffffff) >>> 0;
  };

  for (const f of files) {
    const nameBuf = Buffer.from(f.name, 'utf8');
    const crc = crc32(f.data);
    const size = f.data.length;

    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);   // local file header sig
    local.writeUInt16LE(20, 4);           // version needed
    local.writeUInt16LE(0, 6);            // flags
    local.writeUInt16LE(0, 8);            // method 0 = stored
    local.writeUInt16LE(0, 10);           // time
    local.writeUInt16LE(0, 12);           // date
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(size, 18);        // compressed size
    local.writeUInt32LE(size, 22);        // uncompressed size
    local.writeUInt16LE(nameBuf.length, 26);
    local.writeUInt16LE(0, 28);           // extra len

    chunks.push(local, nameBuf, f.data);

    const cd = Buffer.alloc(46);
    cd.writeUInt32LE(0x02014b50, 0);      // central dir sig
    cd.writeUInt16LE(20, 4);              // version made by
    cd.writeUInt16LE(20, 6);              // version needed
    cd.writeUInt16LE(0, 8);
    cd.writeUInt16LE(0, 10);
    cd.writeUInt16LE(0, 12);
    cd.writeUInt16LE(0, 14);
    cd.writeUInt32LE(crc, 16);
    cd.writeUInt32LE(size, 20);
    cd.writeUInt32LE(size, 24);
    cd.writeUInt16LE(nameBuf.length, 28);
    cd.writeUInt16LE(0, 30);              // extra
    cd.writeUInt16LE(0, 32);              // comment
    cd.writeUInt16LE(0, 34);              // disk
    cd.writeUInt16LE(0, 36);              // int attrs
    cd.writeUInt32LE(0, 38);              // ext attrs
    cd.writeUInt32LE(offset, 42);         // local header offset
    central.push(cd, nameBuf);

    offset += local.length + nameBuf.length + f.data.length;
  }

  const centralBuf = Buffer.concat(central);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(0, 4);
  end.writeUInt16LE(0, 6);
  end.writeUInt16LE(files.length, 8);
  end.writeUInt16LE(files.length, 10);
  end.writeUInt32LE(centralBuf.length, 12);
  end.writeUInt32LE(offset, 16);
  end.writeUInt16LE(0, 20);

  return Buffer.concat([...chunks, centralBuf, end]);
}
