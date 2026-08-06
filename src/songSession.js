// ═══════════════════════════════════════════════════════════════════════════
// SONG STUDIO — sessions and stems
//
// The data layer for the new Song Studio. A SESSION is a song project; a STEM
// is one audio file in it with a role and a lineage.
//
// TWO RULES THIS FILE EXISTS TO ENFORCE:
//
//   1. Every operation is stem-in / stem-out. Nothing is ever overwritten. A
//      converted vocal is a NEW stem pointing at the take it came from, so you
//      can A/B them, revert, or convert the same source three different ways
//      and keep all three.
//
//   2. Sessions are OPTIONAL. Every tool still works standalone. This is a
//      place to keep stems between operations, never a gate in front of them.
//      Nothing here should ever be required to download a result.
//
// Talks to Supabase over REST with the person's own token, exactly like the
// rest of App.jsx — apikey + Authorization: Bearer <user token>, RLS does the
// rest. No service key ever reaches the browser.
// ═══════════════════════════════════════════════════════════════════════════

const SUPABASE_URL = "https://yuzvpmxbtjpqtapborhr.supabase.co";
const SUPABASE_KEY = "sb_publishable_F_hsngWtnCkBZx9SpMDbSw_laaYfTor";
const REST = SUPABASE_URL + "/rest/v1/";
const STORE = SUPABASE_URL + "/storage/v1/";
const BUCKET = "sessions";

// ── ROLES AND SOURCES ──────────────────────────────────────────────────────
// Kept in sync with the CHECK constraints in song_sessions_schema.sql. A value
// missing here that exists there is harmless; a value here that is missing
// there is a 400 at insert time, so add to the SQL first.
export const ROLES = [
  { id: "lead",         label: "Lead vocal" },
  { id: "backing",      label: "Backing vocals" },
  { id: "adlib",        label: "Ad libs" },
  { id: "drums",        label: "Drums" },
  { id: "bass",         label: "Bass" },
  { id: "keys",         label: "Keys" },
  { id: "guitar",       label: "Guitar" },
  { id: "fx",           label: "FX" },
  { id: "other",        label: "Other" },
  { id: "instrumental", label: "Instrumental" },
  { id: "mix",          label: "Mix" },
  { id: "master",       label: "Master" },
];

export const SOURCES = ["uploaded", "converted", "separated", "generated", "mixed", "mastered"];

// Roles that are a whole song rather than one layer. The mixer leaves these
// alone — mixing a master back into a mix is how people ruin a good bounce.
export const FULL_MIX_ROLES = ["mix", "master", "instrumental"];

export const roleLabel = (id) => (ROLES.find(r => r.id === id) || {}).label || id || "Stem";

// ── PLUMBING ───────────────────────────────────────────────────────────────
function H(token, extra) {
  return {
    apikey: SUPABASE_KEY,
    Authorization: "Bearer " + token,
    ...(extra || {}),
  };
}

async function readErr(res) {
  try {
    const t = await res.text();
    try { const j = JSON.parse(t); return j.message || j.error || t; } catch { return t; }
  } catch { return "server error " + res.status; }
}

// Every export returns { ok, ... } rather than throwing. The callers are UI
// handlers and a rejected promise in one of those is a blank screen.
function fail(e) { return { ok: false, error: String((e && e.message) || e || "error").slice(0, 300) }; }

// ── SESSIONS ───────────────────────────────────────────────────────────────
export async function createSession(token, userId, title) {
  try {
    if (!token || !userId) return { ok: false, error: "Please sign in first." };
    const res = await fetch(REST + "song_sessions", {
      method: "POST",
      headers: H(token, { "Content-Type": "application/json", Prefer: "return=representation" }),
      // user_id sent EXPLICITLY. The RLS policy checks auth.uid() = user_id and
      // the column is NOT NULL — omitting it is what made every voice_clips
      // insert fail on 5 Aug with "row violates row-level security policy".
      body: JSON.stringify({ user_id: userId, title: title || "Untitled song" }),
    });
    if (!res.ok) return { ok: false, error: await readErr(res) };
    const rows = await res.json();
    return { ok: true, session: rows[0] };
  } catch (e) { return fail(e); }
}

export async function listSessions(token, userId, limit) {
  try {
    if (!token || !userId) return { ok: true, sessions: [] };
    const q = "song_sessions?select=*&user_id=eq." + userId +
              "&order=updated_at.desc&limit=" + (limit || 50);
    const res = await fetch(REST + q, { headers: H(token) });
    if (!res.ok) return { ok: false, error: await readErr(res) };
    return { ok: true, sessions: await res.json() };
  } catch (e) { return fail(e); }
}

export async function renameSession(token, sessionId, title) {
  try {
    const res = await fetch(REST + "song_sessions?id=eq." + sessionId, {
      method: "PATCH",
      headers: H(token, { "Content-Type": "application/json", Prefer: "return=representation" }),
      body: JSON.stringify({ title: title || "Untitled song" }),
    });
    if (!res.ok) return { ok: false, error: await readErr(res) };
    const rows = await res.json();
    return { ok: true, session: rows[0] };
  } catch (e) { return fail(e); }
}

// Stores BPM and key once, so every later step agrees on the grid instead of
// re-detecting and disagreeing with itself.
export async function setSessionGrid(token, sessionId, bpm, musicKey) {
  try {
    const body = {};
    if (bpm != null) body.bpm = bpm;
    if (musicKey != null) body.music_key = musicKey;
    if (!Object.keys(body).length) return { ok: true };
    const res = await fetch(REST + "song_sessions?id=eq." + sessionId, {
      method: "PATCH",
      headers: H(token, { "Content-Type": "application/json" }),
      body: JSON.stringify(body),
    });
    if (!res.ok) return { ok: false, error: await readErr(res) };
    return { ok: true };
  } catch (e) { return fail(e); }
}

// Deletes the row; stems cascade. Storage objects are NOT removed here — see
// deleteStem for why that is deliberate.
export async function deleteSession(token, sessionId) {
  try {
    const res = await fetch(REST + "song_sessions?id=eq." + sessionId, {
      method: "DELETE", headers: H(token),
    });
    if (!res.ok) return { ok: false, error: await readErr(res) };
    return { ok: true };
  } catch (e) { return fail(e); }
}

// ── STEMS ──────────────────────────────────────────────────────────────────
export async function listStems(token, sessionId) {
  try {
    const q = "song_stems?select=*&session_id=eq." + sessionId + "&order=created_at.asc";
    const res = await fetch(REST + q, { headers: H(token) });
    if (!res.ok) return { ok: false, error: await readErr(res) };
    return { ok: true, stems: await res.json() };
  } catch (e) { return fail(e); }
}

// Registers a stem whose audio is ALREADY in the sessions bucket — the path a
// server-side operation takes after writing its output.
export async function registerStem(token, userId, sessionId, fields) {
  try {
    const row = {
      user_id: userId,                       // explicit, always — see createSession
      session_id: sessionId,
      role: fields.role || "other",
      source: fields.source || "generated",
      parent_id: fields.parentId || null,
      label: fields.label || "",
      storage_path: fields.storagePath,
      duration: fields.duration != null ? fields.duration : null,
      meta: fields.meta || {},
    };
    if (!row.storage_path) return { ok: false, error: "registerStem needs a storagePath." };
    const res = await fetch(REST + "song_stems", {
      method: "POST",
      headers: H(token, { "Content-Type": "application/json", Prefer: "return=representation" }),
      body: JSON.stringify(row),
    });
    if (!res.ok) return { ok: false, error: await readErr(res) };
    const rows = await res.json();
    return { ok: true, stem: rows[0] };
  } catch (e) { return fail(e); }
}

// Uploads a File/Blob straight to storage from the browser, then registers it.
// Direct-to-storage on purpose: audio stems are tens of megabytes and routing
// them through a serverless function would hit the body limit and pay for the
// bandwidth twice.
export async function uploadStem(token, userId, sessionId, file, fields) {
  try {
    if (!token || !userId) return { ok: false, error: "Please sign in first." };
    if (!file) return { ok: false, error: "No file to upload." };

    const ext = (String(file.name || "audio.wav").match(/\.([a-z0-9]+)$/i) || [, "wav"])[1].toLowerCase();
    // Path layout is sessions/<uid>/<session_id>/<name>. The FIRST segment is
    // the owner, which is the single comparison every storage policy makes.
    const stemName = (fields && fields.role ? fields.role : "stem") + "-" +
                     Date.now().toString(36) + "-" +
                     Math.random().toString(36).slice(2, 7) + "." + ext;
    const path = userId + "/" + sessionId + "/" + stemName;

    const up = await fetch(STORE + "object/" + BUCKET + "/" + path, {
      method: "POST",
      headers: H(token, { "x-upsert": "true", "Content-Type": file.type || "application/octet-stream" }),
      body: file,
    });
    if (!up.ok) return { ok: false, error: "Upload failed: " + (await readErr(up)) };

    const reg = await registerStem(token, userId, sessionId, {
      ...(fields || {}),
      source: (fields && fields.source) || "uploaded",
      label: (fields && fields.label) || file.name || "",
      storagePath: path,
    });
    // The bytes are up but the row failed — tell the truth rather than
    // reporting success for a stem that will never appear in the list.
    if (!reg.ok) return { ok: false, error: "Uploaded, but could not register it: " + reg.error };
    return reg;
  } catch (e) { return fail(e); }
}

// The bucket is private, so playback and download both go through a signed URL.
export async function signStem(token, storagePath, seconds) {
  try {
    const res = await fetch(STORE + "object/sign/" + BUCKET + "/" + storagePath, {
      method: "POST",
      headers: H(token, { "Content-Type": "application/json" }),
      body: JSON.stringify({ expiresIn: seconds || 3600 }),
    });
    if (!res.ok) return { ok: false, error: await readErr(res) };
    const j = await res.json();
    return { ok: true, url: SUPABASE_URL + "/storage/v1" + j.signedURL };
  } catch (e) { return fail(e); }
}

// A playable URL for any stem, wherever its bytes actually live.
//
// Stems produced INSIDE the session flow sit in the sessions bucket and get a
// signed URL. Stems registered by an existing tool — convert being the first —
// already have a URL from that tool's own storage, kept in meta.source_url.
// Resolving both here means the UI never has to know the difference, and no
// 15MB render has to be copied between buckets just to satisfy a path rule.
export async function stemUrl(token, stem) {
  try {
    if (stem && stem.meta && stem.meta.source_url) return { ok: true, url: stem.meta.source_url };
    if (!stem || !stem.storage_path) return { ok: false, error: "That stem has no file." };
    return await signStem(token, stem.storage_path, 3600);
  } catch (e) { return fail(e); }
}

// Removes the row only. The object stays in storage on purpose: parent_id is
// ON DELETE SET NULL precisely so deleting a source take never destroys the
// good result somebody made from it, and deleting the bytes here would defeat
// that. Orphaned objects are a cleanup job, not a user-facing action.
export async function deleteStem(token, stemId) {
  try {
    const res = await fetch(REST + "song_stems?id=eq." + stemId, {
      method: "DELETE", headers: H(token),
    });
    if (!res.ok) return { ok: false, error: await readErr(res) };
    return { ok: true };
  } catch (e) { return fail(e); }
}

// ── VOICE ──────────────────────────────────────────────────────────────────
// The newest profile that can actually SING — trained, with a model file.
//
// Not simply the newest profile. Enrolling for one model creates a fresh row,
// which then shadows the profile that holds the trained model, and every tool
// keyed on "newest" starts looking at an empty one. That is exactly what broke
// Song Studio and the generator on 5 Aug. Asking for the newest profile that
// carries the artifact this job needs makes retraining one model unable to hide
// the other.
export async function readyVoiceProfile(token, userId) {
  try {
    if (!token || !userId) return { ok: false, error: "Please sign in first." };
    const q = "voice_profiles?select=id,name,status,model_path,created_at" +
              "&user_id=eq." + userId +
              "&status=eq.ready&model_path=not.is.null" +
              "&order=created_at.desc&limit=1";
    const res = await fetch(REST + q, { headers: H(token) });
    if (!res.ok) return { ok: false, error: await readErr(res) };
    const rows = await res.json();
    if (!rows.length) {
      return { ok: false, error: "No trained voice yet — train one in Song Studio first." };
    }
    return { ok: true, profile: rows[0] };
  } catch (e) { return fail(e); }
}

// ── DERIVED VIEWS ──────────────────────────────────────────────────────────
// Which stem is the CURRENT lead: the newest one in the lead role. Converting
// a vocal three times leaves all three in the session and the newest wins,
// while every earlier take stays downloadable.
export function currentLead(stems) {
  const leads = (stems || []).filter(s => s.role === "lead");
  return leads.length ? leads[leads.length - 1] : null;
}

// Layers the mixer should act on — everything that is not a whole-song bounce.
export function mixableStems(stems) {
  return (stems || []).filter(s => !FULL_MIX_ROLES.includes(s.role));
}

// Groups a stem with everything derived from it, for showing versions together
// rather than as a flat list of near-identical rows.
export function lineage(stems, rootId) {
  const byParent = {};
  (stems || []).forEach(s => {
    const k = s.parent_id || "_root";
    (byParent[k] = byParent[k] || []).push(s);
  });
  const out = [];
  (function walk(id) {
    (byParent[id] || []).forEach(s => { out.push(s); walk(s.id); });
  })(rootId || "_root");
  return out;
}
