// api/retention.js — delete finished renders once they pass their keep-window.
//
// WHY THIS EXISTS
// A finished edit lives at renders/<job>/final.mp4 and nothing ever removed it. That
// is fine for a hundred customers and ruinous at scale, because storage cost is not a
// one-off — it recurs every month for every file ever made, so the bill grows even if
// usage stays flat. Projected at five videos per member per month and 250MB each,
// 5,000 members reach roughly 73TB and about $1,500/month by month twelve, and double
// that by month twenty-four. Nothing breaks; it just quietly becomes the largest line
// item in the business.
//
// Deleting on a clock turns that curve flat: storage reaches a steady state at
// (monthly output x window) instead of climbing forever.
//
// WHAT IT DOES NOT TOUCH
// Raw customer uploads (already deleted at render time), intermediate chunks (deleted
// at the join), and images in the library. Images are a few hundred KB — a thousand of
// them costs less than one video, so they are kept.
//
// SAFETY
//   · requires CRON_SECRET, so it cannot be triggered by a stranger
//   · ?dry=1 reports exactly what it would delete and deletes nothing
//   · batched, so one run can never stall on a huge backlog
//   · the render_jobs row SURVIVES with output_url cleared. The cost and credit
//     history stays auditable; only the dead file and the dead link go.
//
// Env: SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, CRON_SECRET,
//      optional RETENTION_DAYS (default 60), RETENTION_BATCH (default 200)

const SB_URL = (process.env.SUPABASE_URL || "").trim();
const SB_SVC = (process.env.SUPABASE_SERVICE_ROLE_KEY || "").trim();
const BUCKET = "sites";

const DAYS  = Math.max(1, Number(process.env.RETENTION_DAYS) || 60);
const BATCH = Math.max(1, Math.min(1000, Number(process.env.RETENTION_BATCH) || 200));

function sb(path, opts) {
  return fetch(SB_URL + path, Object.assign({}, opts, {
    headers: Object.assign(
      { apikey: SB_SVC, Authorization: "Bearer " + SB_SVC, "Content-Type": "application/json" },
      (opts && opts.headers) || {}
    )
  }));
}

// renders/<jobId>/final.mp4 — derived from the job id rather than parsed out of the
// URL, so a malformed or foreign URL can never point this at someone else's file.
function renderKey(jobId) {
  return "renders/" + String(jobId) + "/final.mp4";
}

export default async function handler(req, res) {
  // Vercel Cron sends GET. A secret is required either way so this can't be poked.
  const secret = (process.env.CRON_SECRET || "").trim();
  const given = (req.headers.authorization || "").replace(/^Bearer\s+/i, "").trim()
             || String((req.query && req.query.key) || "");
  if (!secret || given !== secret) return res.status(401).json({ error: "Unauthorized" });
  if (!SB_URL || !SB_SVC) return res.status(500).json({ error: "Not configured" });

  const dry = String((req.query && req.query.dry) || "") === "1";
  const cutoff = new Date(Date.now() - DAYS * 86400000).toISOString();

  try {
    // Jobs that finished before the cutoff and still have a file to remove.
    // finished_at can be null on older rows, so created_at is the fallback ordering
    // and the filter covers both.
    const q = "/rest/v1/render_jobs?select=id,user_id,output_url,finished_at,created_at" +
              "&status=eq.done&output_url=not.is.null" +
              "&or=(finished_at.lt." + cutoff + ",and(finished_at.is.null,created_at.lt." + cutoff + "))" +
              "&order=created_at.asc&limit=" + BATCH;
    const r = await sb(q, { method: "GET" });
    const rows = await r.json();
    if (!r.ok || !Array.isArray(rows))
      return res.status(502).json({ error: "Couldn't list expired renders", detail: rows });

    if (!rows.length)
      return res.status(200).json({ ok: true, days: DAYS, expired: 0, note: "nothing past the window" });

    if (dry) {
      return res.status(200).json({
        ok: true, dry: true, days: DAYS, cutoff,
        wouldDelete: rows.length,
        sample: rows.slice(0, 5).map((x) => ({ id: x.id, at: x.finished_at || x.created_at, key: renderKey(x.id) })),
        note: "nothing was deleted"
      });
    }

    let files = 0, libRows = 0, cleared = 0, failed = 0;

    for (const row of rows) {
      const key = renderKey(row.id);

      // 1) the video file itself. A 404 counts as success — the goal is "gone".
      try {
        const d = await sb("/storage/v1/object/" + BUCKET + "/" + key, { method: "DELETE" });
        if (d.ok || d.status === 404) files++;
        else { failed++; console.warn("[retention] " + key + " delete returned " + d.status); }
      } catch (e) {
        failed++;
        console.warn("[retention] " + key + " delete threw: " + ((e && e.message) || e));
      }

      // 2) the Library entry, matched on the exact url. A row pointing at a file that
      //    no longer exists is worse than no row — it looks like a broken video.
      if (row.output_url) {
        try {
          const lr = await sb("/rest/v1/media_library?url=eq." + encodeURIComponent(row.output_url),
                              { method: "DELETE", headers: { Prefer: "return=minimal" } });
          if (lr.ok) libRows++;
        } catch (_) {}
      }

      // 3) clear the link but KEEP the row. credits_charged, refunded and the timings
      //    are the margin history — deleting them would erase the audit trail along
      //    with the file.
      try {
        const pr = await sb("/rest/v1/render_jobs?id=eq." + encodeURIComponent(row.id), {
          method: "PATCH", headers: { Prefer: "return=minimal" },
          body: JSON.stringify({ output_url: null })
        });
        if (pr.ok) cleared++;
      } catch (_) {}
    }

    console.log("[retention] window " + DAYS + "d — " + files + " file(s), " +
                libRows + " library row(s), " + cleared + " job(s) cleared, " + failed + " failure(s)");

    return res.status(200).json({
      ok: true, days: DAYS, expired: rows.length,
      filesDeleted: files, libraryRowsRemoved: libRows, jobsCleared: cleared, failures: failed,
      more: rows.length === BATCH   // another run is needed to finish the backlog
    });
  } catch (e) {
    return res.status(500).json({ error: "Server error: " + ((e && e.message) || "unknown") });
  }
}
