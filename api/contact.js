// Chelgy back room — emails Chelsea each "Need Help" submission via Resend.
// Set these in Vercel:
//   RESEND_API_KEY     = your Resend API key (starts with re_)
//   CONTACT_TO_EMAIL   = the email address where you want to receive help requests
//   CONTACT_FROM_EMAIL = (optional) a verified sender; defaults to Resend's test sender
export default async function handler(req, res) {
  if (req.method !== "POST") {
    return res.status(405).json({ error: "Method not allowed" });
  }
  try {
    const body = typeof req.body === "string" ? JSON.parse(req.body || "{}") : (req.body || {});
    const name = (body.name || "").toString().trim();
    const email = (body.email || "").toString().trim();
    const message = (body.message || "").toString().trim();
    if (!name || !email || !message) return res.status(400).json({ error: "Missing fields" });

    const key = (process.env.RESEND_API_KEY || "").trim();
    const to = (process.env.CONTACT_TO_EMAIL || "").trim();
    if (!key || !to) return res.status(500).json({ error: "Help email is not configured yet." });

    const esc = (s) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
    const html =
      "<h2 style=\"font-family:sans-serif\">New Chelgy help request</h2>" +
      "<p style=\"font-family:sans-serif\"><strong>Name:</strong> " + esc(name) + "</p>" +
      "<p style=\"font-family:sans-serif\"><strong>Email:</strong> " + esc(email) + "</p>" +
      "<p style=\"font-family:sans-serif\"><strong>Message:</strong></p>" +
      "<p style=\"font-family:sans-serif;white-space:pre-wrap\">" + esc(message) + "</p>";

    const r = await fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: { "Content-Type": "application/json", "Authorization": "Bearer " + key },
      body: JSON.stringify({
        from: (process.env.CONTACT_FROM_EMAIL || "Chelgy Help <onboarding@resend.dev>").trim(),
        to: [to],
        reply_to: email,
        subject: "Chelgy Help — " + name,
        html: html
      })
    });
    const data = await r.json().catch(() => ({}));
    if (!r.ok) {
      return res.status(r.status).json({ error: (data && (data.message || data.error)) || "Email service error" });
    }
    return res.status(200).json({ ok: true });
  } catch (e) {
    return res.status(500).json({ error: "Server error: " + (e && e.message ? e.message : "unknown") });
  }
}
