// api/admin.js — secure admin actions (service-role), gated to admins only.
// Verifies the caller's login, confirms members.is_admin = true for them,
// then performs the requested action with the service-role key.
//
// Actions: list-members, delete-post, delete-comment, media-sign, ...
// Env: SUPABASE_URL, SUPABASE_ANON_KEY, SUPABASE_SERVICE_ROLE_KEY

const SB_URL  = (process.env.SUPABASE_URL || "").trim();
const SB_ANON = (process.env.SUPABASE_ANON_KEY || "").trim();
const SB_SVC  = (process.env.SUPABASE_SERVICE_ROLE_KEY || "").trim();

async function getUserId(token) {
  if (!token) return null;
  try {
    const r = await fetch(SB_URL + "/auth/v1/user", { headers: { apikey: SB_ANON, Authorization: "Bearer " + token } });
    const u = await r.json();
    return r.ok && u && u.id ? u.id : null;
  } catch { return null; }
}
async function isAdmin(userId) {
  try {
    const r = await fetch(SB_URL + "/rest/v1/members?select=is_admin&user_id=eq." + userId, { headers: { apikey: SB_SVC, Authorization: "Bearer " + SB_SVC } });
    const rows = await r.json();
    return Array.isArray(rows) && rows[0] && rows[0].is_admin === true;
  } catch { return false; }
}
function svc(path, opts) {
  return fetch(SB_URL + "/rest/v1/" + path, Object.assign({}, opts, {
    headers: Object.assign({ apikey: SB_SVC, Authorization: "Bearer " + SB_SVC, "Content-Type": "application/json" }, (opts && opts.headers) || {})
  }));
}

export default async function handler(req, res) {
  if (req.method !== "POST") return res.status(405).json({ error: "Method not allowed" });
  try {
    const body = typeof req.body === "string" ? JSON.parse(req.body || "{}") : (req.body || {});
    const token = (req.headers.authorization || "").replace(/^Bearer\s+/i, "").trim() || body.token;

    const uid = await getUserId(token);
    if (!uid) return res.status(401).json({ error: "Please log in again." });
    if (!(await isAdmin(uid))) return res.status(403).json({ error: "Admins only." });

    const action = body.action;

    if (action === "list-members") {
      const r = await svc("members?select=*");
      const rows = await r.json();
      return res.status(200).json({ members: Array.isArray(rows) ? rows : [] });
    }
    if (action === "delete-post") {
      const id = parseInt(body.id, 10);
      if (!id) return res.status(400).json({ error: "Missing post id" });
      await svc("forum_posts?id=eq." + id, { method: "DELETE" }); // comments cascade
      return res.status(200).json({ ok: true });
    }
    if (action === "delete-comment") {
      const id = parseInt(body.id, 10);
      if (!id) return res.status(400).json({ error: "Missing comment id" });
      await svc("forum_comments?id=eq." + id, { method: "DELETE" });
      return res.status(200).json({ ok: true });
    }
    if (action === "showcase-add") {
      const tool = body.tool === "video" ? "video" : "image";
      const url = String(body.url || "").trim();
      if (!url) return res.status(400).json({ error: "Missing url" });
      const r = await svc("showcase_items", {
        method: "POST",
        headers: { Prefer: "return=representation" },
        body: JSON.stringify({ tool, url, caption: String(body.caption || ""), prompt: String(body.prompt || "") })
      });
      const rows = await r.json();
      return res.status(200).json({ item: Array.isArray(rows) ? rows[0] : rows });
    }
    if (action === "showcase-delete") {
      const id = parseInt(body.id, 10);
      if (!id) return res.status(400).json({ error: "Missing id" });
      await svc("showcase_items?id=eq." + id, { method: "DELETE" });
      return res.status(200).json({ ok: true });
    }
    if (action === "settings-set") {
      const k = String(body.key || "").trim();
      if (!k) return res.status(400).json({ error: "Missing key" });
      await svc("app_settings", {
        method: "POST",
        headers: { Prefer: "resolution=merge-duplicates" },
        body: JSON.stringify({ key: k, value: String(body.value || ""), updated_at: new Date().toISOString() })
      });
      return res.status(200).json({ ok: true });
    }
    if (action === "marketer-list") {
      const r = await svc("members?select=user_id,status,marketer_status,marketer_info&marketer_status=not.is.null&order=marketer_status.asc");
      const rows = await r.json();
      return res.status(200).json({ marketers: Array.isArray(rows) ? rows : [] });
    }
    if (action === "member-stats") {
      const r = await svc("rpc/member_spend_stats", { method: "POST", body: "{}" });
      const rows = await r.json();
      return res.status(200).json({ stats: Array.isArray(rows) ? rows : [] });
    }
    if (action === "set-member-flags") {
      const targetId = body.user_id;
      if (!targetId) return res.status(400).json({ error: "Missing user_id" });
      const patch = {};
      if (typeof body.banned === "boolean") patch.banned = body.banned;
      if (typeof body.muted === "boolean") patch.muted = body.muted;
      if (!Object.keys(patch).length) return res.status(400).json({ error: "Nothing to change" });
      // Safety: an admin can't ban themselves out of the panel.
      if (patch.banned === true && String(targetId) === String(uid)) return res.status(400).json({ error: "You can't ban your own account." });
      await svc("members?user_id=eq." + encodeURIComponent(targetId), {
        method: "PATCH",
        headers: { Prefer: "return=minimal" },
        body: JSON.stringify(patch)
      });
      return res.status(200).json({ ok: true });
    }
    if (action === "marketer-set") {
      const targetId = body.user_id;
      const status = body.status;
      if (!targetId || !["pending", "approved", "denied"].includes(status)) return res.status(400).json({ error: "Bad request" });
      await svc("members?user_id=eq." + encodeURIComponent(targetId), {
        method: "PATCH",
        headers: { Prefer: "return=minimal" },
        body: JSON.stringify({ marketer_status: status })
      });
      return res.status(200).json({ ok: true });
    }
    // ── media-sign: authorise an admin upload into a SHARED bucket folder ──
    //
    // The sites bucket's insert policy only allows a member to write into a folder
    // named after their own user id, which is right for customer footage but blocks
    // admin media (onboarding/, luts/, hero/ ...) outright — "new row violates
    // row-level security policy".
    //
    // Rather than loosen that policy, this mints a short-lived signed upload URL with
    // the service role. The browser then PUTs the file straight to Supabase using that
    // URL, so:
    //   · RLS is bypassed only for a single path this endpoint has already approved,
    //   · no member gains any new write access to shared folders,
    //   · the file never passes through Vercel, so the 4.5MB function body limit
    //     doesn't apply — which matters for video.
    if (action === "media-sign") {
      const path = String(body.path || "").trim();
      // Allow-list, not sanitisation: an exact folder from the known set, then one
      // plain filename. No slashes, no "..", nothing that could escape the folder.
      if (!/^(onboarding|luts|hero|page-banners|tool-media|admin-media|app)\/[A-Za-z0-9._-]{1,120}$/.test(path))
        return res.status(400).json({ error: "That isn't an allowed media path." });
      let d = null;
      try {
        const r = await fetch(SB_URL + "/storage/v1/object/upload/sign/sites/" + path, {
          method: "POST",
          headers: { apikey: SB_SVC, Authorization: "Bearer " + SB_SVC, "Content-Type": "application/json" },
          body: JSON.stringify({})
        });
        d = await r.json().catch(() => null);
        if (!r.ok || !d || !d.url)
          return res.status(502).json({ error: (d && (d.message || d.error)) || "Couldn't authorise that upload." });
      } catch (e) {
        return res.status(502).json({ error: "Storage unreachable: " + ((e && e.message) || "unknown") });
      }
      return res.status(200).json({
        uploadUrl: SB_URL + "/storage/v1" + d.url,
        publicUrl: SB_URL + "/storage/v1/object/public/sites/" + path
      });
    }

    return res.status(400).json({ error: "Unknown action" });
  } catch (e) {
    return res.status(500).json({ error: "Server error: " + (e && e.message ? e.message : "unknown") });
  }
}
