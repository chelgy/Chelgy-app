// Chelgy AI Video Editor — STEP 3: render the edit.
// Charges the flat credit price, then builds a Creatomate RenderScript:
//  - one trimmed video clip per kept segment (trim_start/trim_duration), laid
//    end-to-end with explicit times
//  - animated word-by-word captions per clip (Creatomate's transcript_source
//    with the "highlight" karaoke effect)
//  - the chosen cinematic grade as a full-frame translucent color wash
//    (Wolf 2383 warm-gold, or Luxury Vlog creamy-bright)
//  - a luxury-serif opening title
// Submits to POST https://api.creatomate.com/v2/renders and returns the render
// id (prefixed "cm:") for /api/studio-status to poll. Refund on submit failure.
// Music: optional original score composed by ElevenLabs Music ($0.15/min real),
// uploaded to Supabase and mixed at low volume under the voice.
// Env: CREATOMATE_API_KEY, ELEVENLABS_API_KEY (for music), SUPABASE_URL, SUPABASE_ANON_KEY, SUPABASE_SERVICE_ROLE_KEY

export const maxDuration = 60;

const SB_URL  = (process.env.SUPABASE_URL || "").trim();
const SB_ANON = (process.env.SUPABASE_ANON_KEY || "").trim();
const SB_SVC  = (process.env.SUPABASE_SERVICE_ROLE_KEY || "").trim();
const STUDIO_COST = 2000;        // flat — Quick Edit tier
const CINEMATIC_COST = 4000;     // flat — Cinematic (kinetic cut + scene cards + AI b-roll stills)
const MUSIC_PER_MIN = 400;       // original score, per minute of final video (real ~$0.15/min)
const MAX_RAW_SECONDS = 600;     // 10 minutes of raw footage max

async function getUserId(token) {
  if (!token) return null;
  try {
    const r = await fetch(SB_URL + "/auth/v1/user", { headers: { apikey: SB_ANON, Authorization: "Bearer " + token } });
    const u = await r.json();
    return r.ok && u && u.id ? u.id : null;
  } catch { return null; }
}
async function spend(token, amount, reason) {
  try {
    const r = await fetch(SB_URL + "/rest/v1/rpc/spend_credits", {
      method: "POST",
      headers: { apikey: SB_ANON, Authorization: "Bearer " + token, "Content-Type": "application/json" },
      body: JSON.stringify({ p_amount: amount, p_reason: reason })
    });
    const d = await r.json();
    if (!r.ok) return { ok: false, error: (d && d.message) || "Could not deduct credits." };
    return { ok: true, balance: typeof d === "number" ? d : null };
  } catch { return { ok: false, error: "Credit service unreachable." }; }
}
async function refund(userId, amount, reason) {
  try {
    await fetch(SB_URL + "/rest/v1/rpc/add_credits", {
      method: "POST",
      headers: { apikey: SB_SVC, Authorization: "Bearer " + SB_SVC, "Content-Type": "application/json" },
      body: JSON.stringify({ p_user: userId, p_amount: amount, p_reason: reason })
    });
  } catch {}
}
async function recordVideoJob(id, userId, cost) {
  try {
    await fetch(SB_URL + "/rest/v1/video_jobs", {
      method: "POST",
      headers: { apikey: SB_SVC, Authorization: "Bearer " + SB_SVC, "Content-Type": "application/json", Prefer: "return=minimal" },
      body: JSON.stringify({ id: String(id), user_id: userId, cost })
    });
  } catch {}
}
async function logCost(id, userId, model, duration, credits, estUsd) {
  try {
    await fetch(SB_URL + "/rest/v1/cost_log", {
      method: "POST",
      headers: { apikey: SB_SVC, Authorization: "Bearer " + SB_SVC, "Content-Type": "application/json", Prefer: "return=minimal" },
      body: JSON.stringify({ id: String(id), user_id: userId, tool: "video_editor", model, duration: Math.round(duration) || null, credits_charged: credits, est_usd: estUsd })
    });
  } catch {}
}

// The two signature grades. Rather than one blind wash for everyone (which goes
// orange on already-warm footage and muddy on dark footage), the AI colorist
// classifies each video (temperature + exposure) and this maps that analysis to
// an adjusted wash — the "apply the LUT correctly" step. Color math stays here
// in code, deterministic; the AI only classifies.
function washFor(grade, look) {
  const t = (look && look.temperature) || "neutral";
  const x = (look && look.exposure) || "balanced";
  if (grade === "luxury") {
    // Creamy-bright: lift dark footage more, back off on already-bright footage.
    let a = x === "dark" ? 0.18 : x === "bright" ? 0.08 : 0.14;
    if (t === "warm") a = Math.max(0.06, a - 0.03); // already warm — keep it subtle
    return "rgba(255,246,232," + a.toFixed(2) + ")";
  }
  // Wolf 2383 warm-gold: push harder on cool footage, ease off on warm footage
  // (no double-warming), and lighten on dark footage so it doesn't go muddy.
  let a = t === "cool" ? 0.16 : t === "warm" ? 0.07 : 0.12;
  if (x === "dark") a = Math.max(0.06, a - 0.03);
  if (x === "bright") a = Math.min(0.18, a + 0.02); // bright footage carries gold beautifully
  return "rgba(255,166,77," + a.toFixed(2) + ")";
}

export default async function handler(req, res) {
  if (req.method !== "POST") return res.status(405).json({ error: "Method not allowed" });
  try {
    const body = typeof req.body === "string" ? JSON.parse(req.body || "{}") : (req.body || {});
    const url = body.url;
    const keep = Array.isArray(body.keep) ? body.keep : [];
    const title = (typeof body.title === "string" ? body.title : "").slice(0, 60);
    const grade = body.grade === "luxury" ? "luxury" : "wolf";
    const style = ["vlog","tutorial","cinematic"].includes(body.style) ? body.style : "talkinghead";
    const brollIn = style === "cinematic" && Array.isArray(body.broll) ? body.broll.slice(0, 4) : [];
    const chaptersIn = Array.isArray(body.chapters) ? body.chapters : [];
    const music = body.music === "eleven" ? "eleven" : "off";
    const look = body.look && typeof body.look === "object" ? body.look : null;
    const orientation = body.orientation === "landscape" ? "landscape" : "portrait";
    const rawDuration = Number(body.rawDuration) || 0;
    if (!url || !/^https?:\/\//.test(url)) return res.status(400).json({ error: "Missing video URL." });
    if (!keep.length) return res.status(400).json({ error: "Missing edit plan." });
    if (rawDuration > MAX_RAW_SECONDS) return res.status(400).json({ error: "Raw footage is limited to 10 minutes for now." });

    const CM = (process.env.CREATOMATE_API_KEY || "").trim();
    if (!CM) return res.status(500).json({ error: "The editor is not configured yet (render key missing)." });

    const token = (req.headers.authorization || "").replace(/^Bearer\s+/i, "").trim();
    const userId = await getUserId(token);
    if (!userId) return res.status(401).json({ error: "Please log in again." });

    // ── Sanitize segments server-side (never trust the client blindly) ──
    const segs = keep
      .map(k => ({ s: Math.max(0, Number(k.s) || 0), e: Number(k.e) || 0 }))
      .filter(k => k.e - k.s >= 0.8)
      .sort((a, b) => a.s - b.s)
      .slice(0, 120);
    if (!segs.length) return res.status(400).json({ error: "The edit plan came back empty." });
    const outSeconds = segs.reduce((t, k) => t + (k.e - k.s), 0);

    // ── Build the RenderScript ──
    const W = orientation === "landscape" ? 1920 : 1080;
    const H = orientation === "landscape" ? 1080 : 1920;
    // Map chapters (original-timeline times) onto the first kept segment at or
    // after each chapter point. Skipped for segment 0 (the opening title owns it).
    const CARD = 1.6; // seconds per chapter card
    const chapterBySeg = {};
    if (style !== "talkinghead" && chaptersIn.length) {
      const chs = chaptersIn
        .map(c => ({ s: Math.max(0, Number(c.s) || 0), label: String(c.label || "").trim().slice(0, 40) }))
        .filter(c => c.label)
        .sort((a, b) => a.s - b.s)
        .slice(0, 6);
      let num = 1;
      for (const c of chs) {
        // First kept segment that ends after this chapter point gets the card.
        const idx = segs.findIndex(sg => sg.e > c.s);
        if (idx > 0 && !chapterBySeg[idx]) chapterBySeg[idx] = { label: c.label, num: num++ };
      }
    }

    const elements = [];
    const brollTimed = []; // { newTime, prompt } — mapped to the edited timeline
    let cursor = 0;
    segs.forEach((k, i) => {
      // Chapter card before this segment (tutorial): full-frame charcoal card,
      // "CHAPTER N" eyebrow + luxury-serif label sliding in.
      const ch = chapterBySeg[i];
      if (ch) {
        elements.push({
          type: "composition", track: 1, time: Math.round(cursor * 100) / 100, duration: CARD,
          width: "100%", height: "100%", fill_color: "#111111",
          elements: [
            { type: "text", text: ch.label, y: "48%", width: "86%", height: "18%",
              x_alignment: "50%", y_alignment: "50%", fill_color: "#ffffff",
              font_family: "Playfair Display", font_weight: "700",
              font_size: orientation === "landscape" ? "6.4 vmin" : "7.6 vmin",
              animations: [{ time: 0, duration: 0.7, easing: "quadratic-out", type: "text-slide", scope: "element", split: "line", distance: "120%", direction: "up", background_effect: "disabled" }] }
          ]
        });
        cursor += CARD;
      }
      const d = Math.round((k.e - k.s) * 100) / 100;
      // B-roll moments that land inside this kept segment map to the new timeline.
      for (const b of brollIn) {
        const bs = Number(b.s) || 0;
        if (bs >= k.s && bs < k.e && typeof b.prompt === "string" && b.prompt.trim()) {
          brollTimed.push({ newTime: Math.round((cursor + (bs - k.s)) * 100) / 100, prompt: b.prompt.trim().slice(0, 300) });
        }
      }
      const name = "clip-" + i;
      elements.push({
        type: "video", track: 1, name,
        time: Math.round(cursor * 100) / 100,
        source: url,
        trim_start: k.s,
        trim_duration: d,
        fit: "cover"
      });
      // Word-by-word animated captions for this clip. Vlog captions sit a touch
      // lower and smaller (the footage is the star); talking-head runs bolder.
      elements.push({
        type: "text", track: 3,
        time: Math.round(cursor * 100) / 100,
        duration: d,
        transcript_source: name,
        transcript_effect: "highlight",
        transcript_maximum_length: 14,
        y: style === "vlog" ? "84%" : "80%",
        width: "82%", height: "30%",
        x_alignment: "50%", y_alignment: "50%",
        fill_color: "#ffffff",
        ...(style === "tutorial"
          ? { background_color: "rgba(17,17,17,0.55)", background_x_padding: "34%", background_y_padding: "16%", background_border_radius: "30%" }
          : { stroke_color: "#000000", stroke_width: style === "vlog" ? "1.1 vmin" : "1.4 vmin" }),
        font_family: "Montserrat", font_weight: "700",
        font_size: style === "vlog"
          ? (orientation === "landscape" ? "4.4 vmin" : "6.6 vmin")
          : style === "tutorial"
          ? (orientation === "landscape" ? "4.2 vmin" : "6.2 vmin")
          : (orientation === "landscape" ? "5.2 vmin" : "7.6 vmin")
      });
      cursor += d;
    });
    // Cinematic grade — adapted to this footage's temperature + exposure
    elements.push({
      type: "composition", track: 4, time: 0, duration: Math.round(cursor * 100) / 100,
      width: "100%", height: "100%", fill_color: washFor(grade, look)
    });
    // Luxury opening title
    if (title) {
      elements.push({
        type: "text", track: 5, time: 0.4, duration: 2.8,
        text: title,
        y: "44%", width: "84%", height: "26%",
        x_alignment: "50%", y_alignment: "50%",
        fill_color: "#ffffff",
        stroke_color: "rgba(0,0,0,0.55)", stroke_width: "0.6 vmin",
        font_family: "Playfair Display", font_weight: "700",
        font_size: orientation === "landscape" ? "7 vmin" : "9 vmin"
      });
    }

    // ── Charge (edit + optional score), then compose music, then submit ──
    const baseCost = style === "cinematic" ? CINEMATIC_COST : STUDIO_COST;
    const musicCost = music === "eleven" ? Math.max(1, Math.ceil(outSeconds / 60)) * MUSIC_PER_MIN : 0;
    const chargedTotal = baseCost + musicCost;
    const paid = await spend(token, chargedTotal, "video-editor:" + style + (music !== "off" ? "+score" : ""));
    if (!paid.ok) return res.status(402).json({ error: paid.error });

    // ── Original score (ElevenLabs Music) — composed for this video's style ──
    let musicPath = null;
    if (music === "eleven") {
      const EL = (process.env.ELEVENLABS_API_KEY || "").trim();
      if (!EL) {
        await refund(userId, chargedTotal, "refund:video-editor-music-config");
        return res.status(500).json({ error: "The score composer is not configured yet. Your credits were refunded — try again without music." });
      }
      const MOODS = {
        talkinghead: "confident modern minimal instrumental bed, warm and understated, steady subtle pulse, premium feel",
        vlog: "warm upbeat luxury lifestyle instrumental, light percussion, sunny and expensive-feeling",
        tutorial: "calm focused minimal instrumental, soft keys, unobtrusive, clean and premium"
      };
      const gradeMood = grade === "wolf" ? "rich, golden, cinematic film-score warmth" : "bright, airy, elegant";
      const musicPrompt =
        "Background music bed for a video. " + (MOODS[style] || MOODS.talkinghead) + ". " + gradeMood + ". " +
        "Instrumental only — no vocals, no lyrics. Consistent energy throughout, no dramatic drops. Ends cleanly.";
      const lenMs = Math.max(10000, Math.min(600000, Math.round(outSeconds * 1000) + 1500));
      try {
        const mr = await fetch("https://api.elevenlabs.io/v1/music", {
          method: "POST",
          headers: { "xi-api-key": EL, "Content-Type": "application/json" },
          body: JSON.stringify({ prompt: musicPrompt, music_length_ms: lenMs, model_id: "music_v2" })
        });
        if (!mr.ok) throw new Error("music " + mr.status);
        const audio = Buffer.from(await mr.arrayBuffer());
        musicPath = userId + "/score-" + Date.now() + "-" + Math.random().toString(36).slice(2, 7) + ".mp3";
        const upR = await fetch(SB_URL + "/storage/v1/object/sites/" + musicPath, {
          method: "POST",
          headers: { apikey: SB_SVC, Authorization: "Bearer " + SB_SVC, "x-upsert": "true", "Content-Type": "audio/mpeg" },
          body: audio
        });
        if (!upR.ok) throw new Error("music upload");
      } catch (e) {
        await refund(userId, chargedTotal, "refund:video-editor-music");
        return res.status(502).json({ error: "Couldn't compose the score. Your credits were refunded — try again, or run it without music." });
      }
      elements.push({
        type: "audio", track: 6, time: 0, duration: Math.round(cursor * 100) / 100,
        source: SB_URL + "/storage/v1/object/public/sites/" + musicPath,
        volume: "16%"
      });
    }

    // ── Cinematic b-roll: generate stills (Nano Banana) and cut them in with a
    // slow push-zoom. Failures degrade gracefully — a missing image never kills
    // the edit, that moment just stays on the speaker.
    const brollPaths = [];
    if (style === "cinematic" && brollTimed.length) {
      const GK = (process.env.GEMINI_API_KEY || "").trim();
      const total = Math.round(cursor * 100) / 100;
      for (const b of brollTimed.slice(0, 4)) {
        if (!GK) break;
        try {
          const ir = await fetch("https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash-image:generateContent", {
            method: "POST",
            headers: { "x-goog-api-key": GK, "Content-Type": "application/json" },
            body: JSON.stringify({ contents: [{ parts: [{ text: "Cinematic film still, warm Kodak-print grade, shallow depth of field. " + b.prompt + " No text, no words, no logos." }] }] })
          });
          const idata = await ir.json();
          let imgB64 = null, imgMime = "image/png";
          const partsOut = idata && idata.candidates && idata.candidates[0] && idata.candidates[0].content && idata.candidates[0].content.parts || [];
          for (const pt of partsOut) { if (pt.inlineData && pt.inlineData.data) { imgB64 = pt.inlineData.data; imgMime = pt.inlineData.mimeType || "image/png"; break; } }
          if (!ir.ok || !imgB64) continue;
          const ext = (imgMime.split("/")[1] || "png").split("+")[0];
          const bPath = userId + "/broll-" + Date.now() + "-" + Math.random().toString(36).slice(2, 7) + "." + ext;
          const upB = await fetch(SB_URL + "/storage/v1/object/sites/" + bPath, {
            method: "POST",
            headers: { apikey: SB_SVC, Authorization: "Bearer " + SB_SVC, "x-upsert": "true", "Content-Type": imgMime },
            body: Buffer.from(imgB64, "base64")
          });
          if (!upB.ok) continue;
          brollPaths.push(bPath);
          const dur = 2.4;
          const t = Math.max(0, Math.min(b.newTime, total - dur));
          elements.push({
            type: "image", track: 2, time: t, duration: dur,
            source: SB_URL + "/storage/v1/object/public/sites/" + bPath,
            width: "100%", height: "100%", fit: "cover",
            animations: [{ easing: "linear", type: "scale", scope: "element", start_scale: "103%", end_scale: "112%", fade: false }]
          });
        } catch (e) { /* skip this b-roll moment */ }
      }
    }

    const cr = await fetch("https://api.creatomate.com/v2/renders", {
      method: "POST",
      headers: { Authorization: "Bearer " + CM, "Content-Type": "application/json" },
      body: JSON.stringify({ output_format: "mp4", width: W, height: H, frame_rate: 30, elements })
    });
    const cdata = await cr.json();
    if (!cr.ok) {
      await refund(userId, chargedTotal, "refund:video-editor-submit");
      const msg = (cdata && (cdata.message || (cdata.error && cdata.error.message))) || "Render service error";
      return res.status(cr.status).json({ error: String(msg) + " Your credits were refunded." });
    }
    const render = Array.isArray(cdata) ? cdata[0] : cdata;
    const rid = render && render.id;
    if (!rid) {
      await refund(userId, chargedTotal, "refund:video-editor-noid");
      return res.status(502).json({ error: "No render id returned. Your credits were refunded." });
    }

    await recordVideoJob("cm:" + rid, userId, chargedTotal);
    // Real-cost estimate: transcription+plan (~$0.05) + render minutes (~$0.12/min) + score ($0.15/min)
    const estUsd = Math.round((0.05 + 0.12 * (outSeconds / 60) + (music === "eleven" ? 0.15 * (outSeconds / 60) : 0) + brollPaths.length * 0.04) * 10000) / 10000;
    await logCost("cm:" + rid, userId, "creatomate-" + style + "-" + grade + (music === "eleven" ? "+score" : ""), outSeconds, chargedTotal, estUsd);
    return res.status(200).json({ id: "cm:" + rid, balance: paid.balance, charged: chargedTotal, musicPath, brollPaths });
  } catch (e) {
    return res.status(500).json({ error: "Server error: " + (e && e.message ? e.message : "unknown") });
  }
}
