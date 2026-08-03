// api/song-beat.js
//
// SONG STUDIO — the beat.
//
// Two calls, deliberately separate:
//   action:"plan"    → a song structure, free, shown to the person to adjust
//   action:"compose" → renders that structure to audio, costs credits
//
// Splitting them matters because the plan endpoint is free and the render is
// not. Someone can reshape the arrangement as many times as they like and only
// pay when they hear it.

const EL = "https://api.elevenlabs.io/v1";
const MODEL = "music_v2";          // respects section durations; music_v1 does not
const BEAT_COST = 400;             // must match COSTS.songBeat in App.jsx

// Instrumental ONLY. The person's own voice is the vocal — a generated singer
// underneath it is the single worst failure this feature could have, so the
// exclusion is hardcoded rather than left to prompt wording.
const NO_VOCALS = [
  "vocals", "singing", "lyrics", "vocal melody", "backing vocals",
  "choir", "spoken word", "rap", "vocal chops", "human voice"
];

const GENRES = {
  rnb:      { label: "R&B",        styles: ["contemporary R&B", "smooth", "swung 16ths", "warm bass"] },
  trap:     { label: "Trap",       styles: ["trap", "808 bass", "rolling hi-hats", "sparse"] },
  pop:      { label: "Pop",        styles: ["modern pop", "bright", "punchy drums", "wide"] },
  afrobeat: { label: "Afrobeats",  styles: ["afrobeats", "log drum", "syncopated percussion", "warm"] },
  drill:    { label: "Drill",      styles: ["UK drill", "sliding 808s", "dark", "minimal"] },
  house:    { label: "House",      styles: ["house", "four on the floor", "filtered chords", "driving"] },
  soul:     { label: "Soul",       styles: ["neo-soul", "Rhodes", "live drums", "rich harmony"] },
  country:  { label: "Country",    styles: ["modern country", "acoustic guitar", "brushed drums", "open"] },
  rock:     { label: "Rock",       styles: ["alt rock", "electric guitars", "live drums", "driving"] },
  lofi:     { label: "Lo-fi",      styles: ["lo-fi hip hop", "dusty drums", "jazzy keys", "relaxed"] },
  ballad:   { label: "Ballad",     styles: ["piano ballad", "strings", "slow", "emotional"] },
  gospel:   { label: "Gospel",     styles: ["gospel", "Hammond organ", "live band", "uplifting"] },
};

// Section shapes by song length. A 30-second clip that tries to be a full song
// arrives as mush; a three-minute one with no arc is boring. Fixed skeletons
// beat asking a model to invent structure at every length.
function skeleton(seconds) {
  if (seconds <= 45)  return [["Intro",0.15],["Verse",0.4],["Chorus",0.45]];
  if (seconds <= 90)  return [["Intro",0.1],["Verse",0.28],["Chorus",0.3],["Verse",0.2],["Outro",0.12]];
  return [["Intro",0.08],["Verse",0.2],["Chorus",0.22],["Verse",0.17],["Chorus",0.21],["Outro",0.12]];
}

function buildPlan({ genre, instruments, key, tempo, seconds }) {
  const g = GENRES[genre] || GENRES.pop;

  // Key and tempo come from the guide take, so the beat lands under the vocal
  // instead of the vocal having to be dragged onto the beat.
  const technical = [];
  if (tempo) technical.push(Math.round(tempo) + " BPM");
  if (key)   technical.push(key.name + " " + key.mode);

  // Free text from the person, split on commas. Their words go in verbatim —
  // rewriting "no hi-hats" into something tidier is how you lose the request.
  const asked = String(instruments || "")
    .split(/[,;]+/).map(s => s.trim()).filter(Boolean).slice(0, 8);

  const positive = [...g.styles, ...technical, ...asked, "instrumental", "no vocals"];

  const parts = skeleton(seconds);
  const sections = parts.map(([name, share], i) => ({
    section_name: name,
    positive_local_styles:
      name === "Chorus" ? ["fuller arrangement", "lift"]
      : name === "Intro" ? ["sparse", "sets up the groove"]
      : name === "Outro" ? ["winding down"]
      : ["steady groove", "leaves room on top"],
    negative_local_styles: NO_VOCALS,
    // Clamped to Eleven's 3–120s per-section limit. Rounding down on the last
    // section rather than up keeps the total inside the requested length.
    duration_ms: Math.max(3000, Math.min(120000, Math.round(seconds * share) * 1000)),
    // "lines", not "lyrics". The API rejects a section without it, and the
    // error names composition_plan rather than the field, so it reads like the
    // whole plan is malformed. Empty array = instrumental, which is what we want.
    lines: [],
  }));

  return {
    positive_global_styles: positive,
    negative_global_styles: NO_VOCALS,
    sections,
  };
}

export default async function handler(req, res) {
  if (req.method !== "POST") return res.status(405).json({ error: "POST only" });

  const apiKey = process.env.ELEVENLABS_API_KEY;
  if (!apiKey) return res.status(500).json({ error: "Music engine isn't configured." });

  const {
    action = "plan", genre = "pop", instruments = "",
    key = null, tempo = null, seconds = 60, plan = null,
  } = req.body || {};

  const dur = Math.max(10, Math.min(300, Number(seconds) || 60));

  try {
    // ── PLAN ───────────────────────────────────────────────────────────────
    // Built here rather than asked for from /v1/music/plan. That endpoint takes
    // a text prompt and invents its own structure, which would quietly ignore
    // the key and tempo we measured off the guide take — the whole point.
    if (action === "plan") {
      return res.status(200).json({
        plan: buildPlan({ genre, instruments, key, tempo, seconds: dur }),
        genre: (GENRES[genre] || GENRES.pop).label,
        cost: BEAT_COST,
      });
    }

    // ── COMPOSE ────────────────────────────────────────────────────────────
    if (action === "compose") {
      const composition_plan = plan || buildPlan({ genre, instruments, key, tempo, seconds: dur });

      const r = await fetch(EL + "/music/compose", {
        method: "POST",
        headers: { "xi-api-key": apiKey, "Content-Type": "application/json" },
        body: JSON.stringify({ composition_plan, model_id: MODEL, output_format: "mp3_44100_128" }),
      });

      if (!r.ok) {
        const t = await r.text().catch(() => "");
        // Surface the real reason. "Music generation failed" tells nobody
        // whether they're out of credits or asked for something impossible.
        return res.status(502).json({ error: "Music engine: " + (t.slice(0, 300) || r.status) });
      }

      const audio = Buffer.from(await r.arrayBuffer());
      res.setHeader("Content-Type", "audio/mpeg");
      res.setHeader("X-Beat-Seconds", String(dur));
      return res.status(200).send(audio);
    }

    return res.status(400).json({ error: "Unknown action." });
  } catch (e) {
    return res.status(500).json({ error: (e && e.message) || "Beat generation failed." });
  }
}

export const config = { api: { bodyParser: { sizeLimit: "1mb" } } };
export { GENRES, buildPlan };
