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

  // Guitar-forward, atmosphere-first genres. Each carries a full styles list
  // because a genre absent from this map is silently rendered as pop — a name
  // in App.jsx with no entry here would make six buttons that all quietly
  // produce the same beat.
  dreampop:     { label: "Dream Pop",       styles: ["dream pop", "washed reverb guitars", "hazy synth pads", "soft steady drums", "airy"] },
  shoegaze:     { label: "Shoegaze",        styles: ["shoegaze", "walls of distorted guitar", "heavy reverb", "buried melody", "dense"] },
  indiepop:     { label: "Indie Pop",       styles: ["indie pop", "jangly guitars", "bright melodic bass", "crisp live drums", "warm"] },
  indierock:    { label: "Indie Rock",      styles: ["indie rock", "driving electric guitars", "melodic bass", "energetic live drums"] },
  neopsych:     { label: "Neo-Psychedelia", styles: ["neo-psychedelia", "swirling modulated guitars", "phaser and tape echo", "hypnotic groove", "trippy"] },
  etherealwave: { label: "Ethereal Wave",   styles: ["ethereal wave", "reverb-drenched synths", "gliding chords", "slow atmospheric drums", "dreamlike", "cavernous"] },
};

// Section shapes by song length. A 30-second clip that tries to be a full song
// arrives as mush; a three-minute one with no arc is boring. Fixed skeletons
// beat asking a model to invent structure at every length.
function skeleton(seconds) {
  if (seconds <= 45)  return [["Intro",0.15],["Verse",0.4],["Chorus",0.45]];
  if (seconds <= 90)  return [["Intro",0.1],["Verse",0.28],["Chorus",0.3],["Verse",0.2],["Outro",0.12]];
  return [["Intro",0.08],["Verse",0.2],["Chorus",0.22],["Verse",0.17],["Chorus",0.21],["Outro",0.12]];
}

function buildPrompt({ genre, instruments, key, tempo, seconds, chords, style }) {
  const g = GENRES[genre] || GENRES.pop;
  // An inspo track's description, when present, LEADS the prompt — it is a
  // richer, more specific reading of the desired feel than a genre label, so it
  // replaces the canned genre words rather than piling on top of them. The
  // genre still names the lane; the inspo describes the production within it.
  const inspo = String(style || "").replace(/\s+/g, " ").trim();
  const bits = inspo
    ? [g.label.toLowerCase() + ", " + inspo]
    : [g.styles.join(", ")];

  // Key and tempo come from the guide take, so the beat lands under the vocal
  // instead of the vocal having to be dragged onto the beat.
  if (tempo) bits.push(Math.round(tempo) + " BPM");
  if (key)   bits.push("in " + key.name + " " + key.mode);

  // THE CHORD PROGRESSION OF THE SUNG MELODY.
  //
  // This is the difference between a beat that sits under the voice and one
  // that fights it. Without it, the engine hears a genre word and invents its
  // own harmony in its own key — which has no relationship to what was sung,
  // and that mismatch is exactly the clash. Handed the melody's own chords,
  // the beat is built on the same harmonic ground the vocal stands on.
  //
  // Capped at 8 chords: a prompt is a vibe, not a lead sheet, and a long list
  // reads as noise. The first phrase's harmony is what sets the feel.
  const prog = Array.isArray(chords) ? chords.filter(Boolean).slice(0, 8) : [];
  if (prog.length) bits.push("chord progression " + prog.join(" ") + ", follow this harmony");

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
    key = null, tempo = null, seconds = 60, plan = null, chords = null, style = null,
  } = req.body || {};

  const dur = Math.max(10, Math.min(300, Number(seconds) || 60));

  try {
    // ── PLAN ───────────────────────────────────────────────────────────────
    // Built here rather than asked for from /v1/music/plan. That endpoint takes
    // a text prompt and invents its own structure, which would quietly ignore
    // the key and tempo we measured off the guide take — the whole point.
    if (action === "plan") {
      return res.status(200).json({
        prompt: buildPrompt({ genre, instruments, key, tempo, seconds: dur, chords, style }),
        structure: skeleton(dur).map(([n, sh]) => n + " " + Math.round(dur * sh) + "s"),
        genre: (GENRES[genre] || GENRES.pop).label,
        cost: BEAT_COST,
      });
    }

    // ── PREVIEWS ───────────────────────────────────────────────────────────
    // Generate several SHORT beats to pick from — the browse step of beat-first
    // mode and the marketplace. Short and cheap on purpose: the person auditions
    // snippets, picks one, and only THEN do we spend a full-length compose on
    // the winner. Four full renders up front would be slow and burn 4x credits
    // before they've even sung a note.
    if (action === "previews") {
      const count = Math.max(1, Math.min(4, Number(req.body.count) || 3));
      const previewSec = 18;   // long enough to feel the vibe, short enough to be cheap
      // Vary the prompt slightly per preview so the options actually differ
      // rather than being four near-identical takes.
      const variants = [
        "", "warmer and more intimate", "brighter and more energetic",
        "more spacious and atmospheric",
      ];
      const jobs = [];
      for (let i = 0; i < count; i++) {
        const styleI = [style, variants[i]].filter(Boolean).join(", ");
        jobs.push(
          fetch(EL + "/music", {
            method: "POST",
            headers: { "xi-api-key": apiKey, "Content-Type": "application/json" },
            body: JSON.stringify({
              prompt: buildPrompt({ genre, instruments, key, tempo, seconds: previewSec, chords, style: styleI }),
              music_length_ms: previewSec * 1000,
              model_id: MODEL,
              output_format: "mp3_44100_128",
            }),
          }).then(async (r) => {
            if (!r.ok) return { ok: false, error: (await r.text().catch(() => "")).slice(0, 200) };
            const buf = Buffer.from(await r.arrayBuffer());
            return { ok: true, audio: "data:audio/mpeg;base64," + buf.toString("base64"),
                     variant: variants[i] || "signature" };
          }).catch((e) => ({ ok: false, error: String((e && e.message) || e) }))
        );
      }
      const results = await Promise.all(jobs);
      const good = results.filter((r) => r.ok);
      if (!good.length) {
        return res.status(502).json({ error: "Couldn't generate beats: " + (results[0] && results[0].error || "unknown") });
      }
      // Echo back the key/tempo/chords so the client can carry them into the
      // full render of whichever preview the person picks — same beat spec,
      // just longer.
      return res.status(200).json({
        previews: good.map((r, i) => ({ id: i, audio: r.audio, label: r.variant })),
        spec: { genre, instruments, key, tempo, chords, style, seconds: dur },
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
          prompt: buildPrompt({ genre, instruments, key, tempo, seconds: dur, chords, style }),
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
