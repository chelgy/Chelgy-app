// Chelgy back room — starts a video job on WaveSpeed.
// Your key lives in Vercel as WAVESPEED_API_KEY, never in public code.
// Quality tiers:
//   480p / 720p  -> WAN 2.2 (fast, economical), sized via "size"
//   1080p        -> WAN 2.7 (premium, pricier), sized via "resolution" + "aspect_ratio"
export default async function handler(req, res) {
  if (req.method !== "POST") {
    return res.status(405).json({ error: "Method not allowed" });
  }
  try {
    const body = typeof req.body === "string" ? JSON.parse(req.body || "{}") : (req.body || {});
    const prompt = body.prompt;
    if (!prompt) return res.status(400).json({ error: "Missing prompt" });

    const key = (process.env.WAVESPEED_API_KEY || "").trim();
    if (!key) return res.status(500).json({ error: "Video service is not configured." });

    const orientation = ["landscape", "portrait", "square"].includes(body.orientation) ? body.orientation : "landscape";
    const quality = ["480p", "720p", "1080p"].includes(body.quality) ? body.quality : "480p";

    // WAN 2.2 pixel sizes (480p / 720p), per orientation
    const SIZES = {
      "480p": { landscape: "832*480", portrait: "480*832", square: "480*480" },
      "720p": { landscape: "1280*720", portrait: "720*1280", square: "720*720" }
    };
    // WAN 2.7 aspect ratios (used for 1080p)
    const ASPECTS = { landscape: "16:9", portrait: "9:16", square: "1:1" };

    const image = body.image;
    let imageUrl = null;

    // If a photo was provided, get it to WaveSpeed as a hosted URL so image-to-video can use it.
    if (image && /^https?:\/\//.test(image)) {
      imageUrl = image;
    } else if (image && /^data:.*;base64,/.test(image)) {
      const m = image.match(/^data:(.*?);base64,(.*)$/);
      const mime = (m && m[1]) || "image/png";
      const b64 = (m && m[2]) || "";
      const bytes = Buffer.from(b64, "base64");
      const ext = (mime.split("/")[1] || "png").split("+")[0];
      const form = new FormData();
      form.append("file", new Blob([bytes], { type: mime }), "upload." + ext);

      const up = await fetch("https://api.wavespeed.ai/api/v3/media/upload/binary", {
        method: "POST",
        headers: { "Authorization": "Bearer " + key },
        body: form
      });
      const upData = await up.json();
      if (!up.ok) {
        return res.status(up.status).json({ error: (upData && upData.message) || "Couldn't upload your photo." });
      }
      imageUrl = upData && upData.data && upData.data.download_url;
      if (!imageUrl) return res.status(502).json({ error: "Photo upload returned no URL." });
    }

    let modelPath, input;
    if (quality === "1080p") {
      // Premium tier — WAN 2.7
      if (imageUrl) {
        modelPath = "alibaba/wan-2.7/image-to-video";
        input = { prompt, image: imageUrl, resolution: "1080p", duration: 5, seed: -1 };
      } else {
        modelPath = "alibaba/wan-2.7/text-to-video";
        input = { prompt, resolution: "1080p", aspect_ratio: ASPECTS[orientation], duration: 5, seed: -1 };
      }
    } else {
      // Standard / HD tiers — WAN 2.2
      if (imageUrl) {
        modelPath = quality === "720p" ? "wavespeed-ai/wan-2.2/i2v-720p" : "wavespeed-ai/wan-2.2/i2v-480p";
        input = { prompt, image: imageUrl, duration: 5, seed: -1 };
      } else {
        modelPath = quality === "720p" ? "wavespeed-ai/wan-2.2/t2v-720p-ultra-fast" : "wavespeed-ai/wan-2.2/t2v-480p-ultra-fast";
        input = { prompt, size: SIZES[quality][orientation], duration: 5, seed: -1 };
      }
    }

    const r = await fetch("https://api.wavespeed.ai/api/v3/" + modelPath, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Authorization": "Bearer " + key
      },
      body: JSON.stringify(input)
    });

    const data = await r.json();
    if (!r.ok) {
      return res.status(r.status).json({ error: (data && data.message) || "Video service error" });
    }
    const id = data && data.data && data.data.id;
    if (!id) return res.status(502).json({ error: "No prediction id returned" });
    return res.status(200).json({ id });
  } catch (e) {
    return res.status(500).json({ error: "Server error: " + (e && e.message ? e.message : "unknown") });
  }
}
