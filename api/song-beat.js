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

function buildPrompt({ genre, instruments, key, tempo, seconds }) {
  const g = GENRES[genre] || GENRES.pop;
  const bits = [g.styles.join(", ")];

  // Key and tempo come from the guide take, so the beat lands under the vocal
  // instead of the vocal having to be dragged onto the beat.
  if (tempo) bits.push(Math.round(tempo) + " BPM");
  if (key)   bits.push("in " + key.name + " " + key.mode);

  // The person's own words, verbatim. Rewriting "no hi-hats" into something
  // tidier is how you lose the thing they actually asked for.
  const asked = String(instruments || "")
    .split(/[,;]+/).map((x) => x.trim()).filter(Boolean).slice(0, 8);
  if (asked.length) bits.push(asked.join(", "));

  bits.push(skeleton(seconds).map(([n]) => n.toLowerCase()).join(" then "));

  // Stated three ways on purpose. The vocal is the person's own voice, and a
  // generated singer underneath it is the worst failure this feature has.
  bits.push("instrumental only, no vocals, no singing, no human voice");
  bits.push("leaves space in the middle for a lead vocal on top");

  return bits.join(". ") + ".";
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
        prompt: buildPrompt({ genre, instruments, key, tempo, seconds: dur }),
        structure: skeleton(dur).map(([n, sh]) => n + " " + Math.round(dur * sh) + "s"),
        genre: (GENRES[genre] || GENRES.pop).label,
        cost: BEAT_COST,
      });
    }

    // ── COMPOSE ────────────────────────────────────────────────────────────
    // The prompt endpoint, not the composition-plan one.
    //
    // Two attempts at hand-building a plan were rejected: first for using
    // `lyrics` where sections want `lines`, then for a plan shape music_v2
    // doesn't accept at all. Their errors name composition_plan rather than the
    // offending field, so each round costs a full render to discover. The
    // prompt path is what their own examples use and it takes everything we
    // need — genre, instruments, key, tempo — as words.
    if (action === "compose") {
      const r = await fetch(EL + "/music", {
        method: "POST",
        headers: { "xi-api-key": apiKey, "Content-Type": "application/json" },
        body: JSON.stringify({
          prompt: buildPrompt({ genre, instruments, key, tempo, seconds: dur }),
          music_length_ms: dur * 1000,
          model_id: MODEL,
          output_format: "mp3_44100_128",
        }),
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
export { GENRES, buildPrompt };
