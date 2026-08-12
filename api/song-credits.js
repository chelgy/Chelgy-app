// api/song-credits.js
//
// ONE place that knows what Song Studio work costs and how to charge for it.
//
// Every song endpoint used to authenticate and then do the work for free: the
// browser's useCredits() call is a PRE-CHECK ONLY, and with nothing deducting
// server-side the whole studio — re-sing, separation, mixing, mastering — ran
// GPU pods at no charge. Anyone could split stems all day. Re-sing was charged
// 150 in the UI and zero in reality.
//
// Deliberately a shared module rather than the same forty lines copied into
// four handlers: when a real run gets timed, the number changes HERE and every
// endpoint moves with it. Four copies would drift the first time one is edited.
//
// Env: SUPABASE_URL, SUPABASE_ANON_KEY, SUPABASE_SERVICE_ROLE_KEY

const SB_URL  = (process.env.SUPABASE_URL || "").trim();
const SB_ANON = (process.env.SUPABASE_ANON_KEY || "").trim();
const SB_SVC  = (process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_SERVICE_KEY || "").trim();

// ── THE NUMBERS ──────────────────────────────────────────────────────────────
//
// MUST MATCH CREDIT_COSTS in src/App.jsx. The button promises these; this file
// charges them. If they disagree, the customer is quoted one price and billed
// another — the exact failure the musicvideo comment warns about.
//
// `convert` and `beat` already existed in App.jsx (songConvert / songBeat) and
// are unchanged, so re-sing keeps the price it has always displayed — it simply
// starts actually taking it.
//
// separate / mix / master are INTERIM, on the same footing as songConvert.
// The house formula is credits = (L4 $/hr) x minutes x 50, which at $0.44/hr
// gives roughly 66 for a 3-minute separation, 44 for a 2-minute mix and 22 for
// a ~1-minute master. These are set higher than that on purpose: the formula
// prices the WORK and ignores the POD. A separation that wakes a cold pod costs
// several minutes of L4 before any audio is touched, and on a quiet day one
// user's single split can carry that whole spin-up. The multiple absorbs it.
//
// RETIME ALL THREE off a real run — wall-clock from queue to done, including
// the pod pull — and bring them back to the formula once the cold-start cost is
// known rather than guessed.
export const SONG_COSTS = {
  convert:  150,   // re-sing / convert one vocal (RVC inference)
  beat:     400,   // full song with a generated beat (gated off in the UI)
  separate: 250,   // INTERIM — stem separation (Demucs), the expensive one
  mix:      150,   // INTERIM — mixdown of a session's stems
  master:   100,   // INTERIM — one mastering pass, synchronous
};

// Deducts from the CALLER's balance using their own token, so the database's
// row-level security is what stops one member spending another's credits.
// Mirrors api/openai-image.js exactly — same RPC, same shape, same failure mode.
export async function spendCredits(token, amount, reason) {
  if (!amount) return { ok: true, balance: null };
  try {
    const r = await fetch(SB_URL + "/rest/v1/rpc/spend_credits", {
      method: "POST",
      headers: { apikey: SB_ANON, Authorization: "Bearer " + token, "Content-Type": "application/json" },
      body: JSON.stringify({ p_amount: amount, p_reason: reason }),
    });
    const d = await r.json();
    if (!r.ok) return { ok: false, error: (d && d.message) || "Could not deduct credits." };
    return { ok: true, balance: typeof d === "number" ? d : null };
  } catch { return { ok: false, error: "Credit service unreachable." }; }
}

// Puts credits back. Uses the SERVICE key, not the caller's token: a refund has
// to work even when the thing that failed was the caller's session.
//
// Never throws. A refund that fails must not turn a failed render into a 500 —
// the customer would then see an error about credits on top of an error about
// audio, and the second one is the one they need.
export async function refundCredits(userId, amount, reason) {
  if (!userId || !amount || !SB_SVC) return;
  try {
    await fetch(SB_URL + "/rest/v1/rpc/add_credits", {
      method: "POST",
      headers: { apikey: SB_SVC, Authorization: "Bearer " + SB_SVC, "Content-Type": "application/json" },
      body: JSON.stringify({ p_user: userId, p_amount: amount, p_reason: reason }),
    });
  } catch {}
}

// What a /api/studio-song POST body costs. The route has three modes and they
// are told apart by the body, exactly the way the browser builds it in
// SongStudio: `convertVocal` set = convert, `vocalOnly` = re-sing a take,
// neither = the full beat flow.
export function songPostCost(body) {
  const b = body || {};
  if (b.convertVocal || b.vocalOnly) return SONG_COSTS.convert;
  return SONG_COSTS.beat;
}
