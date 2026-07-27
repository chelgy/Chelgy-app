// Chelgy — pick the thumbnail moments out of a video.
//
// WHAT THIS DOES
// The browser samples cheap low-resolution frames across the video and sends them
// here. A vision model looks at all of them together and says which THREE are worth
// building a thumbnail on, and writes a short headline for each. It returns times,
// not images — the browser re-extracts those exact moments from the source at full
// resolution afterwards.
//
// WHY IT WORKS THAT WAY
// Sending forty full-size frames would be slow and expensive, and pointless: choosing
// a moment needs to see composition, eye-line and light, all of which survive being
// scaled to 512px. Only the winners need to be sharp. So selection runs on thumbnails
// of thumbnails, and the quality cost is paid exactly three times.
//
// WHY THE MODEL DOESN'T DRAW THE TEXT
// It doesn't draw anything at all. Image models render text badly — malformed letters,
// invented words, wrong kerning — and a luxury magazine thumbnail is the single worst
// place for that to show. So the model chooses a moment and writes the WORDS, and the
// browser sets them on a canvas in the real brand fonts. That also means editing the
// headline afterwards costs nothing, because nothing has to be regenerated.
//
// Env: GEMINI_API_KEY, SUPABASE_URL, SUPABASE_ANON_KEY

export const maxDuration = 120;

export const config = { api: { bodyParser: { sizeLimit: "25mb" } } }; // 24 small frames

const SB_URL = (process.env.SUPABASE_URL || "").trim();
const SB_ANON = (process.env.SUPABASE_ANON_KEY || "").trim();

async function getUserId(token) {
  if (!token) return null;
  try {
    const r = await fetch(SB_URL + "/auth/v1/user", { headers: { apikey: SB_ANON, Authorization: "Bearer " + token } });
    const u = await r.json();
    return r.ok && u && u.id ? u.id : null;
  } catch { return null; }
}

const GEMINI_PRIMARY = "gemini-flash-latest";
const GEMINI_FALLBACK = "gemini-3.1-flash-lite";
const overloaded = (s) => /overloaded|high demand|try again later|unavailable|resource[_ ]?exhausted|rate limit|quota/i.test(String(s || ""));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function callGemini(GKEY, payload) {
  const models = [GEMINI_PRIMARY, GEMINI_PRIMARY, GEMINI_FALLBACK];
  let lastErr = "The thumbnail picker is busy. Please try again in a moment.";
  for (let i = 0; i < models.length; i++) {
    try {
      const gr = await fetch(
        "https://generativelanguage.googleapis.com/v1beta/models/" + models[i] + ":generateContent",
        { method: "POST", headers: { "x-goog-api-key": GKEY, "Content-Type": "application/json" }, body: JSON.stringify(payload) }
      );
      const gdata = await gr.json().catch(() => ({}));
      if (!gr.ok) {
        lastErr = (gdata && gdata.error && gdata.error.message) || ("Model error " + gr.status);
        if (gr.status === 503 || gr.status === 429 || gr.status >= 500 || overloaded(lastErr)) { await sleep(1200 * (i + 1)); continue; }
        return { ok: false, error: lastErr };
      }
      let text = "";
      try { text = gdata.candidates[0].content.parts[0].text; } catch {}
      if (!text || overloaded(text)) { lastErr = "The model is experiencing high demand."; await sleep(1200 * (i + 1)); continue; }
      return { ok: true, text };
    } catch (e) {
      lastErr = (e && e.message) || "Network error contacting the thumbnail picker.";
      await sleep(1200 * (i + 1));
    }
  }
  return { ok: false, error: lastErr };
}

export default async function handler(req, res) {
  if (req.method !== "POST") return res.status(405).json({ error: "Method not allowed" });
  try {
    const body = req.body || {};
    const token = (req.headers.authorization || "").replace(/^Bearer\s+/i, "").trim();
    const userId = await getUserId(token);
    if (!userId) return res.status(401).json({ error: "Please sign in again." });

    const GKEY = (process.env.GEMINI_API_KEY || "").trim();
    if (!GKEY) return res.status(500).json({ error: "The thumbnail picker is not configured." });

    // Frames arrive as { t, data } where data is a data: URL. Capped at 24 — beyond
    // that the extra coverage stops changing which moment wins and only costs latency.
    const frames = (Array.isArray(body.frames) ? body.frames : [])
      .map((f) => {
        const m = String((f && f.data) || "").match(/^data:(image\/[a-z+]+);base64,(.+)$/i);
        if (!m) return null;
        const t = Number(f && f.t);
        if (!Number.isFinite(t) || t < 0) return null;
        return { t: Math.round(t * 10) / 10, mimeType: m[1], data: m[2] };
      })
      .filter(Boolean)
      .slice(0, 24);

    if (frames.length < 2) return res.status(400).json({ error: "Couldn't read enough of that video to choose a thumbnail." });

    const title = String(body.title || "").trim().slice(0, 120);
    const topic = String(body.topic || "").trim().slice(0, 300);
    const vertical = String(body.aspect || "16:9") === "9:16";

    const parts = [];
    frames.forEach((f, i) => {
      parts.push({ text: "FRAME " + i + " — at " + f.t + "s" });
      parts.push({ inlineData: { mimeType: f.mimeType, data: f.data } });
    });

    // The brief is deliberately about EDITORIAL quality rather than clickbait. Chelgy's
    // whole brand position is premium, and a thumbnail that shouts undoes that on the
    // one surface everybody sees before they see anything else.
    parts.push({
      text:
        "You are choosing thumbnail frames for a video, the way a magazine picture editor chooses a cover shot.\n\n" +
        "You have been shown " + frames.length + " frames sampled across the video, each labelled with its time in seconds.\n" +
        (title ? "The video is titled: \"" + title + "\"\n" : "") +
        (topic ? "It is about: " + topic + "\n" : "") +
        "\nPick the THREE strongest frames for a thumbnail and rank them best first. Judge them on:\n" +
        "- The face. Eyes open, in focus, an expression that reads as something. Mid-blink, mid-word and mid-chew are unusable no matter how good the rest of the frame is.\n" +
        "- Light on the subject. Flat or blown-out beats nothing, but a face that is modelled by the light beats both.\n" +
        "- Composition, and specifically NEGATIVE SPACE — a headline has to sit somewhere. A frame with the subject dead centre and no clear area is a weaker thumbnail than a slightly worse frame with room in it.\n" +
        "- Whether it says something about the video at a glance.\n" +
        (vertical ? "- This is a VERTICAL thumbnail, so the usable area is tall and narrow. Favour frames where the subject reads at that shape.\n"
                  : "- This is a WIDE thumbnail. Favour frames that hold up cropped to 16:9.\n") +
        "\nAvoid: motion blur, the back of someone's head, transition frames, anything where the main subject is cut off at the edge, and near-identical frames — the three should be genuinely DIFFERENT moments, not three from the same two seconds.\n" +
        "\nFor each pick also write a headline: at most 6 words, title case, no full stop, no emoji, no ALL CAPS, no clickbait phrasing like 'you won't believe'. It should read like a magazine cover line — confident and specific. If the video has a title, draw on it rather than restating it word for word.\n" +
        "\nAlso write one short 'space' value per pick saying where the headline should sit: \"lower\" if the bottom of the frame is clear, \"upper\" if the top is clearer.\n" +
        "\nRespond with ONLY this JSON, nothing else:\n" +
        '{"picks":[{"t":number,"headline":"string","space":"lower|upper","why":"string"}]}'
    });

    const out = await callGemini(GKEY, {
      contents: [{ parts }],
      generationConfig: { responseMimeType: "application/json", temperature: 0.4, maxOutputTokens: 1024 }
    });
    if (!out.ok) return res.status(502).json({ error: out.error });

    let parsed = null;
    try { parsed = JSON.parse(String(out.text).replace(/```json|```/g, "").trim()); } catch {}
    if (!parsed || !Array.isArray(parsed.picks)) {
      return res.status(502).json({ error: "Couldn't choose a thumbnail from that video. Try again." });
    }

    // Snap each returned time back to a frame we actually sampled. The model reads the
    // labels well but occasionally rounds or invents a value between two frames, and a
    // time that doesn't exist produces a black extraction in the browser.
    const times = frames.map((f) => f.t);
    const nearest = (t) => times.reduce((a, b) => (Math.abs(b - t) < Math.abs(a - t) ? b : a), times[0]);

    const seen = new Set();
    const picks = parsed.picks
      .map((p) => {
        const t = Number(p && p.t);
        if (!Number.isFinite(t)) return null;
        const snapped = nearest(t);
        if (seen.has(snapped)) return null;   // the same moment twice is one thumbnail, not two
        seen.add(snapped);
        const clean = (v, n) => String(v || "").trim().replace(/["""]/g, "").replace(/[.]+$/, "").slice(0, n);
        const hero = clean(p && p.hero, 18);
        // A pick with no hero word has nothing to set large, and the layout collapses
        // into a lead-in floating on its own. Drop it rather than render something odd.
        if (!hero) return null;
        return {
          t: snapped,
          lead: clean(p && p.lead, 40),
          hero,
          sub: clean(p && p.sub, 80),
          space: String((p && p.space) || "lower") === "upper" ? "upper" : "lower",
          why: String((p && p.why) || "").trim().slice(0, 140)
        };
      })
      .filter(Boolean)
      .slice(0, 3);

    if (!picks.length) return res.status(502).json({ error: "Couldn't choose a thumbnail from that video. Try again." });

    return res.status(200).json({ picks });
  } catch (e) {
    return res.status(500).json({ error: (e && e.message) || "Something went wrong choosing a thumbnail." });
  }
}
