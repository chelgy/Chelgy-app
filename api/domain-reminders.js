// /api/domain-reminders.js
// Runs once a day (via Vercel Cron). Finds domains that are about to expire
// and emails the owner a renewal reminder using Resend.
//
// It sends TWO reminders per domain over its lifetime:
//   - a 30-day heads-up  (when the domain is within 30 days of expiring)
//   - a 7-day final nudge (when the domain is within 7 days of expiring)
// Each is sent only once, tracked by remind30_sent / remind7_sent on the row.
// When a domain is renewed, the webhook resets those flags so the cycle repeats.
//
// Required env vars:
//   RESEND_API_KEY              (from resend.com)
//   REMINDER_FROM               e.g.  Chelgy <domains@chelgy.app>   (must be a Resend-verified sender)
//   SUPABASE_URL                (already set)
//   SUPABASE_SERVICE_ROLE_KEY   (already set — service role, bypasses RLS)
//   CRON_SECRET                 (recommended — Vercel auto-sends it as a Bearer token on cron calls)
// Optional:
//   APP_URL                     link shown in the email (defaults to https://chelgy.app)

const SB_URL = (process.env.SUPABASE_URL || "").replace(/\/+$/, "");
const SVC = process.env.SUPABASE_SERVICE_ROLE_KEY || "";
const RESEND_KEY = process.env.RESEND_API_KEY || "";
const FROM = process.env.REMINDER_FROM || "Chelgy <onboarding@resend.dev>";
const APP_URL = (process.env.APP_URL || "https://chelgy.app").replace(/\/+$/, "");

function svcHeaders() {
  return { apikey: SVC, Authorization: "Bearer " + SVC };
}

function reminderHtml(domain, expDate, days) {
  const when = days === 7 ? "in about a week" : "in about a month";
  return `
  <div style="background:#f6f5f2;padding:32px 0;font-family:Arial,Helvetica,sans-serif;">
    <div style="max-width:480px;margin:0 auto;background:#ffffff;border:1px solid #e7e4dd;border-radius:14px;overflow:hidden;">
      <div style="padding:26px 30px 8px;">
        <div style="font-family:Georgia,'Times New Roman',serif;font-size:22px;color:#111;">Your domain renews soon</div>
      </div>
      <div style="padding:6px 30px 4px;font-size:15px;line-height:1.65;color:#333;">
        <p style="margin:0 0 14px;">Heads-up — your domain <strong>${domain}</strong> is set to expire ${when}, on <strong>${expDate}</strong>.</p>
        <p style="margin:0 0 14px;">To keep your website live at this address, renew it before then. It only takes a moment:</p>
        <p style="margin:0 0 6px;color:#555;">Open Chelgy → <strong>Website Builder</strong> → <strong>Domains you own</strong> → <strong>Renew 1 year</strong>.</p>
      </div>
      <div style="padding:18px 30px 28px;">
        <a href="${APP_URL}" style="display:inline-block;background:#111;color:#fff;text-decoration:none;font-size:14px;padding:12px 22px;border-radius:9px;">Open Chelgy</a>
      </div>
      <div style="padding:0 30px 26px;font-size:12px;line-height:1.6;color:#999;">
        If you've already renewed, you can ignore this — you're all set.<br/>— Chelgy
      </div>
    </div>
  </div>`;
}

async function sendEmail(to, subject, html) {
  const r = await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: {
      Authorization: "Bearer " + RESEND_KEY,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ from: FROM, to, subject, html }),
  });
  return r.ok;
}

export default async function handler(req, res) {
  // Only allow the scheduled cron (or a manual call carrying the secret).
  const secret = (process.env.CRON_SECRET || "").trim();
  if (secret) {
    const auth = req.headers.authorization || "";
    if (auth !== "Bearer " + secret) {
      return res.status(401).json({ error: "unauthorized" });
    }
  }

  if (!SB_URL || !SVC) return res.status(500).json({ error: "supabase not configured" });
  if (!RESEND_KEY) return res.status(500).json({ error: "RESEND_API_KEY not set" });

  try {
    const now = Date.now();
    const nowIso = new Date(now).toISOString();
    const in7 = new Date(now + 7 * 86400000).toISOString();
    const in30 = new Date(now + 30 * 86400000).toISOString();

    // 7-day nudge: expiring within 7 days, not yet reminded at 7.
    const q7 = await fetch(
      SB_URL + "/rest/v1/domains?select=id,domain,user_id,expires_at" +
        "&expires_at=gte." + nowIso + "&expires_at=lte." + in7 + "&remind7_sent=eq.false",
      { headers: svcHeaders() }
    );
    const d7 = q7.ok ? await q7.json() : [];

    // 30-day heads-up: expiring within 30 days but more than 7 away, not yet reminded at 30.
    const q30 = await fetch(
      SB_URL + "/rest/v1/domains?select=id,domain,user_id,expires_at" +
        "&expires_at=gt." + in7 + "&expires_at=lte." + in30 + "&remind30_sent=eq.false",
      { headers: svcHeaders() }
    );
    const d30 = q30.ok ? await q30.json() : [];

    const jobs = [
      ...(Array.isArray(d30) ? d30 : []).map((x) => ({ ...x, stage: 30 })),
      ...(Array.isArray(d7) ? d7 : []).map((x) => ({ ...x, stage: 7 })),
    ];
    if (!jobs.length) return res.status(200).json({ checked: 0, sent: 0 });

    // Look up member emails for all affected users in one query.
    const uids = [...new Set(jobs.map((j) => j.user_id).filter(Boolean))];
    const emailByUid = {};
    if (uids.length) {
      const mq = await fetch(
        SB_URL + "/rest/v1/members?select=user_id,email&user_id=in.(" + uids.join(",") + ")",
        { headers: svcHeaders() }
      );
      const members = mq.ok ? await mq.json() : [];
      (Array.isArray(members) ? members : []).forEach((m) => {
        if (m.user_id && m.email) emailByUid[m.user_id] = m.email;
      });
    }

    let sent = 0;
    for (const j of jobs) {
      const email = emailByUid[j.user_id];
      if (!email) continue;
      const expDate = j.expires_at ? new Date(j.expires_at).toLocaleDateString("en-US", { month: "long", day: "numeric", year: "numeric" }) : "soon";
      const subject = "Your domain " + j.domain + " renews soon";
      const ok = await sendEmail(email, subject, reminderHtml(j.domain, expDate, j.stage));
      if (ok) {
        sent++;
        const field = j.stage === 7 ? { remind7_sent: true } : { remind30_sent: true };
        await fetch(SB_URL + "/rest/v1/domains?id=eq." + j.id, {
          method: "PATCH",
          headers: { ...svcHeaders(), "Content-Type": "application/json", Prefer: "return=minimal" },
          body: JSON.stringify(field),
        });
      }
    }

    return res.status(200).json({ checked: jobs.length, sent });
  } catch (e) {
    console.error("domain-reminders error", e);
    return res.status(500).json({ error: "reminder run failed" });
  }
}
