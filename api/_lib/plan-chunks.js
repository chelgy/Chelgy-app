var __getOwnPropNames = Object.getOwnPropertyNames;
var __esm = (fn, res, err) => function __init() {
  if (err) throw err[0];
  try {
    return fn && (res = (0, fn[__getOwnPropNames(fn)[0]])(fn = 0)), res;
  } catch (e) {
    throw err = [e], e;
  }
};

// stubs/fs-promises.js
var init_fs_promises = __esm({
  "stubs/fs-promises.js"() {
  }
});

// stubs/fs.js
function existsSync() {
  return true;
}
var init_fs = __esm({
  "stubs/fs.js"() {
  }
});

// ../rs/beat.js
function snapToBeat(segments, beat, tolerance) {
  if (!beat || !Array.isArray(segments) || !segments.length) return { segments, moved: 0 };
  const period = 60 / beat.bpm;
  const tol = typeof tolerance === "number" ? tolerance : 0.15;
  let moved = 0;
  const nearest = (t) => {
    const k = Math.round((t - beat.phase) / period);
    return beat.phase + k * period;
  };
  const out = segments.map((sg) => {
    const s = Number(sg.s) || 0, e = Number(sg.e) || 0;
    const dur = e - s;
    if (dur <= 0) return sg;
    const target = nearest(s);
    if (Math.abs(target - s) > tol || target < 0) return sg;
    moved++;
    return { ...sg, s: Math.round(target * 1e3) / 1e3, e: Math.round((target + dur) * 1e3) / 1e3 };
  });
  return { segments: out, moved };
}

// ../rs/job-plan.js
init_fs_promises();

// stubs/path.js
var join = (...p) => p.filter(Boolean).join("/").replace(/\/+/g, "/");
var basename = (p, ext) => {
  const b = String(p).split("/").pop();
  return ext && b.endsWith(ext) ? b.slice(0, -ext.length) : b;
};
var dirname = (p) => String(p).split("/").slice(0, -1).join("/") || "/";
var path_default = { join, basename, dirname };

// ../rs/audio-track.js
init_fs_promises();
function snapToFrames(seconds, fps) {
  const f = Math.max(1, Math.round(Number(seconds) * fps));
  return f / fps;
}
function frameCount(seconds, fps) {
  return Math.max(1, Math.round(Number(seconds) * fps));
}
function buildTimeline(segments, bridges, fps) {
  const out = [];
  let at = 0;
  for (let i = 0; i < segments.length; i++) {
    const sg = segments[i];
    const raw = Math.max(0, (Number(sg.e) || 0) - (Number(sg.s) || 0));
    const dur = snapToFrames(raw, fps);
    out.push({
      kind: "segment",
      idx: i,
      clip: Number(sg.clip) || 0,
      s: Number(sg.s) || 0,
      dur,
      frames: frameCount(dur, fps),
      startAt: at
    });
    at += dur;
    const b = bridges && bridges.get ? bridges.get(i) : null;
    if (b && b.dur > 0) {
      const bdur = snapToFrames(b.dur, fps);
      out.push({
        kind: "bridge",
        idx: i,
        url: b.url,
        file: b.file,
        trim: b.trim || 0,
        dur: bdur,
        frames: frameCount(bdur, fps),
        startAt: at
      });
      at += bdur;
    }
  }
  return { pieces: out, total: at };
}

// ../rs/render.js
init_fs();
init_fs_promises();

// stubs/url.js
function fileURLToPath() {
  return "/chelgy/render.js";
}

// ../rs/render.js
var __dirname = path_default.dirname(fileURLToPath(import.meta.url));
var LUT_DIR = path_default.join(__dirname, "luts");
var FONT_DIR = path_default.join(__dirname, "fonts");
var TITLE_FONT_FILE = existsSync(path_default.join(FONT_DIR, "CAVELINE.ttf")) ? path_default.join(FONT_DIR, "CAVELINE.ttf") : "/usr/share/fonts/truetype/dejavu/DejaVuSerif-Bold.ttf";
var CAPTION_FONT = "CAVELINE";
var FONT_PACKS = {
  // FOUR roles, not three:
  //   type    — the opening title, seen once, allowed to be a display face
  //   sub     — the line under it
  //   card    — chapter cards and product labels, seen repeatedly through the edit
  //   caption — the running subtitles
  //
  // card exists because a chapter card is not a title and not a caption. It appears
  // half a dozen times in a minute and is read in about a second, so it wants
  // something plainer than the masthead and more present than a subtitle. It used to
  // borrow the caption face, which made every card CAVELINE regardless.
  editorial: { file: "Monoton-Regular.ttf", type: "Monoton", sub: "Amore", card: "Lacuna", caption: "CAVELINE" },
  bold: { file: "Anton-Regular.ttf", type: "Anton", sub: "Barlow Condensed SemiBold", card: "Barlow Condensed SemiBold", caption: "Barlow Condensed SemiBold" },
  classic: { file: "PlayfairDisplay.ttf", type: "Playfair Display", sub: "Cormorant Garamond Light", card: "Lora", caption: "Lora" },
  modern: { file: "SpaceGrotesk.ttf", type: "Space Grotesk Light", sub: "Inter", card: "Inter", caption: "Inter" }
};
var PACK_ALIAS = { chelgy: "editorial" };
var normPack = (id) => PACK_ALIAS[String(id || "").toLowerCase()] || id;
function packFonts(rawId) {
  const id = normPack(rawId);
  const p = FONT_PACKS[id];
  if (p && existsSync(path_default.join(FONT_DIR, p.file))) return { type: p.type, sub: p.sub, card: p.card, caption: p.caption };
  if (id && id !== "editorial") console.warn("[fonts] pack '" + id + "' unavailable, using editorial");
  return existsSync(path_default.join(FONT_DIR, "LacunaRegular.ttf")) ? { type: "Monoton", sub: "Amore", card: "Lacuna", caption: CAPTION_FONT } : { type: "Monoton", sub: "Amore", card: CAPTION_FONT, caption: CAPTION_FONT };
}
var TYPE_FONT = existsSync(path_default.join(FONT_DIR, "Monoton-Regular.ttf")) ? "Monoton" : existsSync(path_default.join(FONT_DIR, "LacunaRegular.ttf")) ? "Lacuna" : "Monoton";
var BRAND_MARK = "CHELGY";
var CAVELINE_ALT_A = "\uE000";
function brandCase(text, font) {
  const up = String(text).toUpperCase();
  return font === "CAVELINE" || font === void 0 ? up.replace(/A/g, CAVELINE_ALT_A) : up;
}
function clipOf(x) {
  const n = Number(x && x.clip);
  return Number.isFinite(n) && n >= 0 ? Math.floor(n) : 0;
}
function assTime(sec) {
  const s = Math.max(0, sec);
  const h = Math.floor(s / 3600);
  const m = Math.floor(s % 3600 / 60);
  const rest = s % 60;
  const cs = Math.floor(rest % 1 * 100);
  return `${h}:${String(m).padStart(2, "0")}:${String(Math.floor(rest)).padStart(2, "0")}.${String(cs).padStart(2, "0")}`;
}
function cleanCaption(raw) {
  return String(raw).replace(/(\d)([.,])(\d)/g, (m, a, sep, b) => a + (sep === "." ? "" : "") + b).replace(/[.,\u2026]/g, "").replace(/\u0001/g, ".").replace(/\u0002/g, ",").trim();
}
function remapWords(words, segments) {
  const out = [];
  for (let si = 0; si < segments.length; si++) {
    const seg = segments[si];
    const s = Number(seg.s) || 0;
    const e = Number(seg.e) || 0;
    const segClip = clipOf(seg);
    const cursor = Number(seg.startAt) || 0;
    const segEnd = cursor + Math.max(0, e - s);
    for (const w of words) {
      if (clipOf(w) !== segClip) continue;
      const ws = Number(w.start ?? w.s);
      const we = Number(w.end ?? w.e);
      if (!Number.isFinite(ws) || !Number.isFinite(we)) continue;
      if (ws >= s && ws < e) {
        out.push({
          // Chelgy sends { w, s, e }; Deepgram raw sends { punctuated_word, word, start, end }.
          // Accept either shape so a key-name change can never silently drop captions.
          text: cleanCaption(w.w || w.punctuated_word || w.word || w.text || ""),
          start: cursor + (ws - s),
          end: cursor + (Math.min(we, e) - s),
          seg: si,
          // which cut this word survived in
          segEnd
          // where that cut ends on the edited timeline
        });
      }
    }
  }
  return out.filter((w) => w.text).sort((a, b) => a.start - b.start);
}
var ASS_WHITE = "&H00FFFFFF";
function escAss(s) {
  return String(s).replace(/[{}\\]/g, "").replace(/\n/g, " ");
}
function buildAssEvents(words, segments, size, opts = {}, title = "", chapters = []) {
  const mapped = remapWords(words || [], segments || []);
  const perLine = opts.perLine || 3;
  const PFearly = packFonts(opts.fontPack);
  const fontName = opts.fontName || PFearly.caption || CAPTION_FONT;
  const cardFont = PFearly.card || fontName;
  const PF = PFearly;
  const fontSize = Math.round(size.h * (opts.fontScale || 0.036));
  const marginV = Math.round(size.h * (opts.marginScale || 0.16));
  const edge = 0;
  const blurAmt = 0;
  const outline = edge;
  const shadow = 0;
  const capBold = opts.captionBold === false ? 0 : -1;
  const capSpacing = Math.round(fontSize * 0.03);
  const markSize = Math.round(size.h * 0.022);
  const titleSize = titleFontSize(title || "", size);
  const titleSpacing = Math.round(titleSize * 0.04);
  const CARD_IDEAL = Math.round(size.h * 0.04);
  const CARD_MIN = Math.round(size.h * 0.022);
  const cardSize = CARD_IDEAL;
  const CARD_TRACK = 0.06;
  const cardBudget = size.w - 160;
  const CARD_EM = { editorial: 0.78, bold: 0.58, classic: 0.78, modern: 0.76 };
  const CARD_EM_DEFAULT = 0.8;
  const cardEm = CARD_EM[normPack(opts.fontPack)] !== void 0 ? CARD_EM[normPack(opts.fontPack)] : CARD_EM_DEFAULT;
  const fitCardLine = (l) => {
    const n = Math.max(1, String(l).length);
    return Math.floor(cardBudget / (cardEm * n + CARD_TRACK * (n - 1)));
  };
  const cardSizeFor = (lines2) => Math.max(CARD_MIN, Math.min(CARD_IDEAL, Math.min.apply(null, lines2.map(fitCardLine))));
  const header = `[Script Info]
ScriptType: v4.00+
PlayResX: ${size.w}
PlayResY: ${size.h}
WrapStyle: 2
ScaledBorderAndShadow: yes

[V4+ Styles]
Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding
Style: Cap,${fontName},${fontSize},${ASS_WHITE},${ASS_WHITE},&H00000000,&HA0000000,${capBold},0,0,0,100,100,${capSpacing},0,1,${outline},${shadow},2,60,60,${marginV},1
Style: Title,${fontName},${titleSize},${ASS_WHITE},${ASS_WHITE},&H00000000,&H60000000,0,0,0,0,100,100,${titleSpacing},0,1,${edge ? Math.max(1, Math.round(titleSize * 0.02)) : 0},0,5,80,80,40,1
Style: Card,${cardFont},${cardSize},${ASS_WHITE},${ASS_WHITE},&H00000000,&H60000000,0,0,0,0,100,100,${Math.round(cardSize * 0.06)},0,1,0,0,5,80,80,40,1
Style: ShowUp,${cardFont},${cardSize},${ASS_WHITE},${ASS_WHITE},&H00000000,&H80000000,0,0,0,0,100,100,${Math.round(cardSize * 0.06)},0,1,0,0,8,80,80,${Math.round(size.h * 0.16)},1
Style: ShowDown,${cardFont},${cardSize},${ASS_WHITE},${ASS_WHITE},&H00000000,&H80000000,0,0,0,0,100,100,${Math.round(cardSize * 0.06)},0,1,0,0,2,80,80,${Math.round(size.h * 0.3)},1
Style: Mark,${TYPE_FONT},${markSize},&H20FFFFFF,&H20FFFFFF,&H00000000,&H80000000,0,0,0,0,100,100,${Math.round(markSize * 0.04)},0,1,0,1,3,40,${Math.round(size.w * 0.045)},${Math.round(size.h * 0.03)},1

`;
  const capTrack = capSpacing / fontSize;
  const capMaxPx = size.w * 0.86;
  const lineWidthPx = (arr) => {
    const s = arr.map((x) => x.text).join(" ");
    return fontSize * (textEm(s) + capTrack * Math.max(0, s.length - 1));
  };
  const lines = [];
  let current = [];
  for (const w of mapped) {
    const brokeAtCut = current.length && current[current.length - 1].seg !== w.seg;
    const wouldOverflow = current.length && lineWidthPx(current.concat(w)) > capMaxPx;
    if (current.length >= perLine || brokeAtCut || wouldOverflow) {
      lines.push(current);
      current = [];
    }
    current.push(w);
  }
  if (current.length) lines.push(current);
  const events = [];
  for (let g = 0; g < lines.length; g++) {
    const line = lines[g];
    const nextGroupStart = lines[g + 1] ? lines[g + 1][0].start : Infinity;
    for (let i = 0; i < line.length; i++) {
      const start = line[i].start;
      const end = i + 1 < line.length ? line[i + 1].start : Math.min(line[i].end + 0.18, nextGroupStart, line[i].segEnd ?? Infinity);
      if (!(end > start)) continue;
      const shown = line.slice(0, i + 1).map((w) => brandCase(escAss(w.text), fontName));
      let capText;
      if (opts.wordPunch && shown.length) {
        const settled = shown.slice(0, -1);
        const fresh = shown[shown.length - 1];
        const punch = "{\\fscx118\\fscy118\\t(0,130,\\fscx100\\fscy100)}";
        capText = settled.length ? settled.join(" ") + " " + punch + fresh : punch + fresh;
      } else {
        capText = shown.join(" ");
      }
      events.push({ start, end, style: "Cap", text: capText });
    }
  }
  if (title || opts.subtitle) {
    const typeText = String(title || "").trim().toUpperCase();
    const subText = String(opts.subtitle || "").trim();
    const TYPE_EM = 0.95, TYPE_TRACK = 0.04;
    const typeBudget = size.w * 0.84;
    const fitLine = (txt) => {
      const n = Math.max(1, String(txt).length);
      return Math.floor(typeBudget / (n * TYPE_EM + TYPE_TRACK * (n - 1)));
    };
    const splitTypeLines = (txt, n) => {
      const ws = String(txt).split(/\s+/).filter(Boolean);
      if (n <= 1 || ws.length <= 1) return [String(txt)];
      const per = Math.ceil(ws.length / n);
      const out = [];
      for (let i = 0; i < ws.length; i += per) out.push(ws.slice(i, i + per).join(" "));
      return out;
    };
    const typeIdeal = Math.round(size.h * 0.072);
    const TYPE_MIN = Math.round(size.h * 0.03);
    let typeLines = [typeText];
    let typeSize = typeIdeal;
    if (typeText) {
      const one = Math.min(typeIdeal, fitLine(typeText));
      typeSize = one;
      if (one < TYPE_MIN) {
        for (let n = 2; n <= 3; n++) {
          const cand = splitTypeLines(typeText, n);
          const s = Math.min(typeIdeal, Math.min.apply(null, cand.map(fitLine)));
          if (s > typeSize) {
            typeLines = cand;
            typeSize = s;
          }
        }
      }
      typeSize = Math.max(8, typeSize);
    }
    const subSize = Math.max(Math.round(size.h * 0.018), Math.round(typeSize * 0.34));
    const typeSp = Math.round(typeSize * 0.04);
    const subSp = Math.round(subSize * 0.1);
    const words2 = (typeText + " " + subText).trim().split(/\s+/).filter(Boolean).length;
    const hold = Math.min(7, Math.max(3.4, 2.2 + words2 * 0.55));
    const parts = [];
    if (typeText) parts.push(`{\\fn${PF.type}\\fs${typeSize}\\fsp${typeSp}}` + typeLines.map(escAss).join("\\N"));
    if (subText) parts.push(`{\\fn${PF.sub}\\b1\\fs${subSize}\\fsp${subSp}}` + escAss(subText));
    events.unshift({
      start: 0.4,
      end: 0.4 + hold,
      style: "Title",
      text: `{\\fad(350,350)${blurAmt ? "\\blur" + blurAmt : ""}}` + parts.join("\\N")
    });
  }
  for (const c of chapters || []) {
    const label = String(c.label || "").trim();
    if (!label) continue;
    const at = Number(c.at);
    if (!Number.isFinite(at)) continue;
    const cLines = splitBalanced(label);
    const cSize = cardSizeFor(cLines);
    events.push({
      start: at + 0.15,
      end: at + 2.9,
      style: "Card",
      text: `{\\fad(400,400)\\fs${cSize}\\fsp${Math.round(cSize * CARD_TRACK)}}` + cLines.map((l) => brandCase(escAss(l), cardFont)).join("\\N")
    });
  }
  for (const s of opts.showcase || []) {
    const label = String(s.label || "").trim();
    if (!label) continue;
    const at = Number(s.at);
    if (!Number.isFinite(at)) continue;
    const style = s.pos === "upper" ? "ShowDown" : "ShowUp";
    const sLines = splitBalanced(label);
    const sSize = cardSizeFor(sLines);
    events.push({
      start: at + 0.2,
      end: at + 3.4,
      style,
      text: `{\\fad(350,350)\\fs${sSize}\\fsp${Math.round(sSize * CARD_TRACK)}}` + sLines.map((l) => brandCase(escAss(l), cardFont)).join("\\N")
    });
  }
  if (opts.brandMark !== false) {
    const spanned = (segments || []).reduce(
      (t, sg) => t + Math.max(0, (Number(sg.e) || 0) - (Number(sg.s) || 0)),
      0
    );
    events.push({
      start: 0,
      end: Math.max(1, spanned) + 600,
      // slack for bridges and b-roll added in PASS 1
      style: "Mark",
      // NOT brandCase(): it swaps A for CAVELINE's private-use alternate, which is a
      // blank box in Monoton. Same trap the opening title already documents.
      text: escAss(String(BRAND_MARK).toUpperCase())
    });
  }
  events.sort((a, b) => a.start - b.start);
  return { header, events };
}
function assEventLine(e) {
  return `Dialogue: 0,${assTime(e.start)},${assTime(e.end)},${e.style},,0,0,0,,${e.text}`;
}
var BLOCK_STYLES = /* @__PURE__ */ new Set(["Title", "Card", "ShowUp", "ShowDown"]);
function assForWindow(header, events, winStart, winEnd) {
  const out = [];
  for (const e of events) {
    if (BLOCK_STYLES.has(e.style)) {
      if (!(e.end > winStart && e.start < winEnd)) continue;
      if (e.start >= winStart) {
        out.push(assEventLine({ ...e, start: e.start - winStart, end: e.end - winStart }));
      } else {
        const contText = e.text.replace(/\\fad\((\d+),(\d+)\)/, (_m, _in, outv) => "\\fad(0," + outv + ")");
        out.push(assEventLine({ ...e, start: 0, end: e.end - winStart, text: contText }));
      }
      continue;
    }
    if (!(e.end > winStart && e.start < winEnd)) continue;
    const start = Math.max(e.start, winStart) - winStart;
    const end = Math.min(e.end, winEnd) - winStart;
    if (end > start) out.push(assEventLine({ ...e, start, end }));
  }
  return header + `[Events]
Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text
` + out.join("\n") + "\n";
}
function splitBalanced(text) {
  const t = String(text).trim();
  if (!t) return [];
  const punct = t.match(/^(.+?[:\u2014\u2013-])\s+(.+)$/);
  if (punct) return [punct[1].trim(), punct[2].trim()];
  const words = t.split(/\s+/);
  if (words.length < 3) return [t];
  let best = 1, bestDiff = Infinity;
  for (let i = 1; i < words.length; i++) {
    const diff = Math.abs(words.slice(0, i).join(" ").length - words.slice(i).join(" ").length);
    if (diff < bestDiff) {
      bestDiff = diff;
      best = i;
    }
  }
  return [words.slice(0, best).join(" "), words.slice(best).join(" ")];
}
var MIN_DISPLAY_LETTERS = 6;
var MAX_DISPLAY_LETTERS = 12;
var FUNCTION_WORDS = /* @__PURE__ */ new Set(["the", "a", "an", "my", "to", "of", "in", "on", "is", "it", "i", "we", "and", "or", "for", "at", "by", "as", "so"]);
function splitTitle(title) {
  const t = String(title).trim();
  if (!t) return [];
  const words = t.split(/\s+/);
  if (words.length === 1) return [t];
  const letters = (w) => w.replace(/[^A-Za-z0-9]/g, "").length;
  if (letters(words[0]) >= MIN_DISPLAY_LETTERS && !FUNCTION_WORDS.has(words[0].toLowerCase().replace(/[^a-z]/g, ""))) {
    return [words[0], words.slice(1).join(" ")];
  }
  let take = 1, count = letters(words[0]);
  const maxTake = Math.max(1, Math.floor(words.length / 2));
  while (take < maxTake && count < MIN_DISPLAY_LETTERS) {
    const next = letters(words[take]);
    if (count + next > MAX_DISPLAY_LETTERS && count >= 3) break;
    count += next;
    take++;
  }
  return [words.slice(0, take).join(" "), words.slice(take).join(" ")];
}
var CAVELINE_W = { "A": 0.707, "B": 0.644, "C": 0.713, "D": 0.644, "E": 0.51, "F": 0.51, "G": 0.713, "H": 0.64, "I": 0.14, "J": 0.642, "K": 0.612, "L": 0.51, "M": 0.859, "N": 0.64, "O": 0.764, "P": 0.644, "Q": 0.764, "R": 0.644, "S": 0.667, "T": 0.72, "U": 0.64, "V": 0.707, "W": 1.048, "X": 0.676, "Y": 0.676, "Z": 0.61, "0": 0.66, "1": 0.187, "2": 0.564, "3": 0.56, "4": 0.556, "5": 0.567, "6": 0.594, "7": 0.56, "8": 0.586, "9": 0.594, " ": 0.25, ".": 0.163, ",": 0.167, "'": 0.17, "!": 0.15, "?": 0.498, "&": 0.607, "-": 0.374, ":": 0.163, ";": 0.167, '"': 0.23, "(": 0.308, ")": 0.308, "/": 0.442 };
var CAVELINE_W_DEFAULT = 0.66;
function textEm(text) {
  let t = 0;
  for (const ch of String(text).toUpperCase()) {
    t += CAVELINE_W[ch] !== void 0 ? CAVELINE_W[ch] : CAVELINE_W_DEFAULT;
  }
  return t;
}
function fitSize(text, maxPx, track) {
  const chars = Math.max(1, String(text).length);
  const em = textEm(text) + track * (chars - 1);
  return Math.floor(maxPx / Math.max(0.01, em));
}
function wrapToWidth(text, pt, maxPx, track) {
  const words = String(text).split(/\s+/).filter(Boolean);
  const lines = [];
  let cur = "";
  for (const w of words) {
    const t = cur ? cur + " " + w : w;
    const px = pt * (textEm(t) + track * Math.max(0, t.length - 1));
    if (px > maxPx && cur) {
      lines.push(cur);
      cur = w;
    } else {
      cur = t;
    }
  }
  if (cur) lines.push(cur);
  return lines;
}
function titleSizes(title, size) {
  const lines = splitTitle(title);
  const bigTrack = 0.02, smallTrack = 0.02;
  if (!lines.length) return { big: Math.round(size.h / 12), small: 0, smallLines: [], bigTrack, smallTrack };
  const WIDTH = size.w * 0.82;
  const CEIL = Math.round(size.h / 5.6);
  const FLOOR = Math.round(size.h / 26);
  let big = Math.min(CEIL, fitSize(lines[0], WIDTH, bigTrack));
  let rest = [];
  let guard = 0;
  while (guard++ < 40) {
    rest = lines[1] ? wrapToWidth(lines[1], big, WIDTH, bigTrack) : [];
    const tooWide = [lines[0], ...rest].some(
      (l) => big * (textEm(l) + bigTrack * Math.max(0, l.length - 1)) > WIDTH
    );
    const tooTall = (1 + rest.length) * big * 1.16 > size.h * 0.42;
    if (!tooWide && !tooTall) break;
    if (big <= FLOOR) break;
    big = Math.max(FLOOR, Math.round(big * 0.94));
  }
  return { big, small: big, smallLines: rest, bigTrack, smallTrack };
}
function titleFontSize(title, size) {
  return titleSizes(title, size).big;
}

// ../rs/job-plan.js
var SB_URL = (process.env.SUPABASE_URL || "").trim().replace(/\/+$/, "");
var SB_SVC = (process.env.SUPABASE_SERVICE_ROLE_KEY || "").trim();
var BUCKET = (process.env.BUCKET || "sites").trim();
function planChunks(edl) {
  const fps = Number(edl.fps) || 30;
  const size = edl.size || { w: 1080, h: 1920 };
  const bridges = /* @__PURE__ */ new Map();
  for (const t of edl.transitions || []) {
    if (t && Number.isFinite(Number(t.after)) && t.url) {
      bridges.set(Number(t.after), { url: t.url, dur: Number(t.dur) || 4, trim: Number(t.trim) || 0 });
    }
  }
  const { pieces, total } = buildTimeline(edl.segments || [], bridges, fps);
  const grade = edl.grade || {};
  let assHeader = null, assEvents = null;
  try {
    const segsForAss = pieces.filter((p) => p.kind === "segment").map((p) => ({
      clip: p.clip,
      s: p.s,
      e: p.s + p.dur,
      dur: p.dur,
      startAt: p.startAt
    }));
    const cards = [];
    for (const c of edl.chapters || []) {
      const label = String(c && c.label || "").trim();
      if (!label) continue;
      const ci = Number(c.clip) || 0, t = Number(c.s) || 0;
      let at = null;
      for (const sg of segsForAss) {
        if (sg.clip !== ci) continue;
        if (t < sg.s) {
          at = sg.startAt;
          break;
        }
        if (t < sg.e) {
          at = sg.startAt + (t - sg.s);
          break;
        }
      }
      if (at === null) continue;
      if (edl.title && at < 4) continue;
      cards.push({ at, label });
    }
    cards.sort((a, b) => a.at - b.at);
    for (let i = cards.length - 1; i > 0; i--) {
      if (cards[i].at - cards[i - 1].at < 3.2) cards.splice(i, 1);
    }
    const showcase = [];
    for (const s of edl.showcase || []) {
      const label = String(s && s.label || "").trim();
      if (!label) continue;
      const ci = Number(s.clip) || 0, t = Number(s.s) || 0;
      let at = null;
      for (const sg of segsForAss) {
        if (sg.clip !== ci) continue;
        if (t < sg.s) {
          at = sg.startAt;
          break;
        }
        if (t < sg.e) {
          at = sg.startAt + (t - sg.s);
          break;
        }
      }
      if (at === null) continue;
      showcase.push({ at, label, pos: s.pos === "upper" ? "upper" : "lower" });
    }
    showcase.sort((a, b) => a.at - b.at);
    const built = buildAssEvents(
      edl.words || [],
      segsForAss,
      size,
      { ...edl.captionStyle || {}, showcase, subtitle: edl.subtitle || "", fontPack: edl.fontPack },
      edl.title || "",
      cards
    );
    if (built && built.events && built.events.length) {
      assHeader = built.header;
      assEvents = built.events;
    }
  } catch (e) {
    console.error("[plan] captions skipped: " + (e && e.message || e));
  }
  const brollCues = [];
  for (const b of edl.broll || []) {
    const u = String(b && b.url || "");
    if (!u) continue;
    const bc = Number(b.clip) || 0, bt = Number(b.s) || 0, bdur = Math.max(0.5, Number(b.dur) || 2.4);
    let at = null;
    for (const p of pieces) {
      if (p.kind !== "segment" || p.clip !== bc) continue;
      if (bt < p.s) {
        at = p.startAt;
        break;
      }
      if (bt < p.s + p.dur) {
        at = p.startAt + (bt - p.s);
        break;
      }
    }
    if (at !== null) brollCues.push({ at, end: at + bdur, url: u });
  }
  const whips = whipPairs(String(edl.style || ""), pieces);
  const planned = plannedFx(String(edl.style || ""), pieces, edl.fx);
  const SPEED_BY_PIECE = pieces.map((p, i) => {
    const asked = planned.get(i);
    if (asked && asked.__speed) return asked.__speed;
    return speedFor(String(edl.style || ""), i, p.kind, p.dur, whips);
  });
  const specs = pieces.map((p, i) => ({
    idx: i,
    spec: {
      // Speed leaves p.dur and p.frames alone on purpose — see speedFor. Only the
      // amount of source read changes, so the timeline the captions and the beat
      // grid were built against stays true.
      // The planner's slow motion wins where it asked for it; otherwise the style's own
      // rule applies (fashion only). Computed once and reused so the source length and
      // the filter can never disagree about the rate.
      speed: SPEED_BY_PIECE[i] || null,
      srcSeconds: sourceSecondsFor(p.dur, SPEED_BY_PIECE[i] || null),
      kind: p.kind,
      sourceUrl: p.kind === "bridge" ? p.url : (edl.sources || [])[p.clip],
      startSec: p.kind === "bridge" ? 0 : p.s,
      trimStart: p.trim || 0,
      frames: p.frames,
      fps,
      width: size.w,
      height: size.h,
      startAt: p.startAt,
      clip: p.kind === "bridge" ? -1 : p.clip,
      // The grade travels as footage + look, NOT as a file path or URL. The worker
      // has the LUTs baked into its image and resolves them locally.
      //
      // This used to read edl.lutUrl, which nothing ever set — the app sends
      // grade:{footage,look}. Every chunk therefore rendered with no LUT filter at
      // all and the footage came out completely ungraded, silently.
      //
      // A bridge is generated footage — already Rec.709 — so it takes the film LOOK
      // but never the camera log conversion. Running S-Log3 -> Rec.709 over an image
      // that was never log wrecks it.
      footage: p.kind === "bridge" ? "none" : (grade.clipFootage || [])[p.clip] || grade.footage || "none",
      // "No colour" (global footage:"none") means NO film look anywhere — bridges
      // included. Without this, the leftover grade.look (which defaults to wolf) still
      // painted the cut, so "Don't color my footage" came back Golden Hour. A bridge in
      // a *coloured* job still gets the look; it only skips the camera conversion above.
      look: grade.footage === "none" ? "none" : grade.look || "none",
      // Degrees clockwise to turn this chunk's source before anything else.
      //
      // Travels the same way `footage` does — as a value the worker acts on, not as a
      // filter string — because the worker owns its own ffmpeg command. It MUST be
      // applied before scale and crop: a quarter turn swaps width and height, so
      // scaling first fits the frame to the wrong shape and then crops the subject out.
      //
      // A bridge is generated at the final orientation already, so it never rotates.
      rotate: p.kind === "bridge" ? 0 : (Math.round(Number((edl.clipRotate || [])[p.clip]) || 0) % 360 + 360) % 360,
      // Per-style look effects, decided here rather than in the worker so every chunk
      // of one film agrees. A bridge is generated footage and gets none of them: it
      // has no camera movement to smear and no reason to glitch.
      //
      // Fashion is the only style that gets them by default. The others are talking
      // videos, and a smeared frame behind someone's face is a fault rather than a
      // look — the effect has to belong to the format, not be sprinkled everywhere
      // because it is available.
      fx: p.kind === "bridge" ? {} : (() => {
        const style = String(edl.style || "");
        const base = { ...FX_BY_STYLE[style] || {} };
        const fxBlur = blurFor(style, i, p.kind, p.dur);
        if (fxBlur) base.motionBlur = fxBlur;
        const fxShift = shiftFor(style, i, p.kind, p.dur);
        if (fxShift) base.rgbShift = fxShift;
        const burn = burnFor(style, i, p.kind, p.dur);
        const ghost = ghostFor(style, i, p.kind, p.dur);
        const glitch = glitchFor(style, i, p.kind, p.dur);
        const dub = dubFor(style, i, p.kind, p.dur, pieces, edl.sources);
        const trans = { ...planned.get(i) || {} };
        const wantWhip = trans.__whip === true;
        const wantSlow = trans.__speed || null;
        delete trans.__whip;
        delete trans.__speed;
        const pWhipOut = planned.has(i + 1) && planned.get(i + 1).__whip === true;
        const pWhipIn = wantWhip;
        const whip = pWhipOut ? { edge: "out", dir: -1, dur: WHIP_DUR } : pWhipIn ? { edge: "in", dir: -1, dur: WHIP_DUR } : whips.has(i) ? { edge: "out", dir: whips.get(i), dur: WHIP_DUR } : whips.has(i - 1) ? { edge: "in", dir: whips.get(i - 1), dur: WHIP_DUR } : null;
        let out = base;
        if (burn) out = { ...out, burn };
        if (ghost) out = { ...out, ghost };
        if (glitch) out = { ...out, glitch };
        if (dub) out = { ...out, dub };
        if (whip) out = { ...out, whip };
        out = { ...out, ...trans };
        return out;
      })(),
      // This chunk's slice of the caption track, already rebased to start at zero.
      ass: assHeader && assEvents ? assForWindow(assHeader, assEvents, p.startAt, p.startAt + p.dur) : null,
      // The b-roll stills that fall inside THIS chunk's window, rebased so each is
      // timed from the chunk's own zero. Composited per-chunk for the same reason
      // captions are: it keeps the join a copy instead of a full re-encode. A still
      // straddling a chunk boundary is clipped to each side and shows on both, so it
      // doesn't blink out at the seam.
      broll: brollCues.filter((c) => c.end > p.startAt && c.at < p.startAt + p.dur).map((c) => ({
        url: c.url,
        at: Math.max(0, c.at - p.startAt),
        end: Math.min(p.dur, c.end - p.startAt)
      }))
    }
  }));
  return { specs, fps, size, totalDuration: total, pieces };
}
var MV_FX = "musicvideofx";
var FX_STYLES = ["fashion", MV_FX];
var FX_CADENCE = {
  fashion: { blurEvery: 4, blurFrames: 5, shiftEvery: 3, shiftPx: 2, minDur: 0.4 },
  [MV_FX]: { blurEvery: 6, blurFrames: 5, shiftEvery: 5, shiftPx: 2, minDur: 0.5 }
};
var FX_BY_STYLE = {};
function blurFor(style, idx, kind, dur) {
  const c = FX_CADENCE[style];
  if (!c || kind === "bridge") return null;
  if (idx < 1 || idx % c.blurEvery !== 0) return null;
  if (dur < c.minDur) return null;
  return c.blurFrames;
}
function shiftFor(style, idx, kind, dur) {
  const c = FX_CADENCE[style];
  if (!c || kind === "bridge") return null;
  if (idx < 1 || (idx + 1) % c.shiftEvery !== 0) return null;
  if (dur < c.minDur) return null;
  return c.shiftPx;
}
var BURN_FILES = ["burn-warm.mp4", "burn-red.mp4", "burn-amber.mp4"];
var BURN_EVERY = 5;
var BURN_DUR = 0.45;
function burnFor(style, idx, kind, dur) {
  if (style !== "fashion" || kind === "bridge") return null;
  if (idx < 1 || idx % BURN_EVERY !== 0) return null;
  if (dur < 0.35) return null;
  return { file: BURN_FILES[Math.floor(idx / BURN_EVERY) % BURN_FILES.length], dur: BURN_DUR };
}
var GHOST_EVERY = 7;
var GHOST_MIN_DUR = 0.6;
var GLITCH_EVERY = 6;
var GLITCH_DUR = 0.12;
var GLITCH_MIN_DUR = 0.3;
var GLITCH_SHIFT = 8;
var GLITCH_BANDS = [
  [[0.22, 0.07, -0.05], [0.52, 0.045, 0.04], [0.76, 0.055, -0.03]],
  [[0.14, 0.05, 0.045], [0.44, 0.06, -0.055], [0.7, 0.04, 0.025]],
  [[0.3, 0.06, -0.035], [0.6, 0.05, 0.05], [0.85, 0.045, -0.02]]
];
function glitchFor(style, idx, kind, dur) {
  if (!FX_STYLES.includes(style) || kind === "bridge") return null;
  if (idx < 1 || idx % GLITCH_EVERY !== 0) return null;
  if (dur < GLITCH_MIN_DUR) return null;
  const set = GLITCH_BANDS[Math.floor(idx / GLITCH_EVERY) % GLITCH_BANDS.length];
  return {
    dur: GLITCH_DUR,
    shift: GLITCH_SHIFT,
    bands: set.map(([y, h, dx]) => ({ y, h, dx }))
  };
}
var DUB_EVERY = 11;
var DUB_MIN_DUR = 0.5;
var DUB_OPACITY = 0.5;
function dubFor(style, idx, kind, dur, pieces, sources) {
  if (!FX_STYLES.includes(style) || kind === "bridge") return null;
  if (idx < 1 || idx % DUB_EVERY !== 0) return null;
  if (dur < DUB_MIN_DUR) return null;
  const me = pieces[idx];
  const pick = (wantDifferentClip) => {
    for (let k = 1; k < pieces.length; k++) {
      const j = (idx + 3 + k) % pieces.length;
      const c = pieces[j];
      if (!c || j === idx || c.kind === "bridge") continue;
      if (wantDifferentClip && c.clip === me.clip) continue;
      const url = (sources || [])[c.clip];
      if (!url) continue;
      return { url, startSec: Number(c.s) || 0 };
    }
    return null;
  };
  const donor = pick(true) || pick(false);
  return donor ? { ...donor, opacity: DUB_OPACITY } : null;
}
var WHIP_EVERY = 8;
var WHIP_MIN_DUR = 0.5;
var WHIP_DUR = 0.12;
var WHIP_STYLES = ["fashion", "entrepreneur", MV_FX];
function whipPairs(style, pieces) {
  const out = /* @__PURE__ */ new Map();
  if (!WHIP_STYLES.includes(style)) return out;
  for (let k = 1; k < pieces.length - 1; k++) {
    const every = style === "entrepreneur" ? 4 : WHIP_EVERY;
    if ((k + 1) % every !== 0) continue;
    const a = pieces[k], b = pieces[k + 1];
    if (!a || !b || a.kind === "bridge" || b.kind === "bridge") continue;
    if (a.dur < WHIP_MIN_DUR || b.dur < WHIP_MIN_DUR) continue;
    out.set(k, Math.floor(k / WHIP_EVERY) % 2 ? 1 : -1);
  }
  return out;
}
var SPEED_EVERY = 9;
var RAMP_EVERY = 13;
var SPEED_SLOW = 0.5;
var RAMP_FROM = 1.6;
var RAMP_TO = 0.4;
var SPEED_MIN_DUR = 0.35;
var SPEED_STYLES = [];
function speedFor(style, idx, kind, dur, whips) {
  if (!SPEED_STYLES.includes(style) || kind === "bridge") return null;
  if (dur < SPEED_MIN_DUR) return null;
  if (whips && (whips.has(idx) || whips.has(idx - 1))) return null;
  if (idx >= 1 && idx % RAMP_EVERY === 0) return { from: RAMP_FROM, to: RAMP_TO };
  if (idx >= 1 && idx % SPEED_EVERY === 0) return { speed: SPEED_SLOW };
  return null;
}
function sourceSecondsFor(dur, sp) {
  if (!sp) return dur;
  if (sp.speed) return dur * sp.speed;
  return dur * ((sp.from + sp.to) / 2);
}
var GHOST_STYLES = ["fashion", MV_FX];
var FX_SPEC = {
  whip: () => ({ __whip: true }),
  push: () => ({ zoomBlur: { amount: 0.2, blur: 6, dur: 0.18 } }),
  flash: () => ({ flash: { dur: 0.18, amount: 0.8 } }),
  drain: () => ({ drain: { dur: 0.22 } }),
  echo: () => ({ ghost: { opacity: 0.35, driftX: 0.05, driftY: 0.02, dur: 0.2 } }),
  roll: (n) => ({ roll: { deg: (n % 2 ? 1 : -1) * 10 } }),
  slowmo: () => ({ __speed: { speed: SPEED_SLOW } }),
  // Rushes in and settles. Averages exactly 1.0 so it reads no more source than an
  // unramped shot — see speedFor for why that matters.
  ramp: () => ({ __speed: { from: RAMP_FROM, to: RAMP_TO } })
};
function pieceAt(pieces, at) {
  let best = -1, bestGap = Infinity;
  for (let i = 0; i < pieces.length; i++) {
    if (pieces[i].kind === "bridge") continue;
    const gap = Math.abs((Number(pieces[i].s) || 0) - at);
    if (gap <= 0.35 && gap < bestGap) {
      best = i;
      bestGap = gap;
    }
  }
  if (best >= 0) return best;
  for (let i = 0; i < pieces.length; i++) {
    const p = pieces[i];
    if (p.kind === "bridge") continue;
    if (at >= (Number(p.s) || 0) && at <= (Number(p.e) || 0)) return i;
  }
  return -1;
}
var PLANNED_FX_STYLES = ["entrepreneur", "realestate", "fashion"];
var FALLBACK_FX = {
  realestate: ["roll", "push", "flash", "slowmo"],
  entrepreneur: ["whip", "push", "flash", "drain", "echo"]
};
var FALLBACK_EVERY = 3;
var FALLBACK_MIN_DUR = 0.35;
function fallbackFx(style, pieces) {
  const out = /* @__PURE__ */ new Map();
  const vocab = FALLBACK_FX[style];
  if (!vocab || !vocab.length) return out;
  let n = 0;
  for (let i = 1; i < pieces.length; i++) {
    const p = pieces[i];
    if (!p || p.kind === "bridge") continue;
    if (i % FALLBACK_EVERY !== 0) continue;
    if ((Number(p.dur) || 0) < FALLBACK_MIN_DUR) continue;
    const make = FX_SPEC[vocab[n % vocab.length]];
    if (!make) continue;
    out.set(i, make(n++));
  }
  console.warn("[plan] " + style + ": placed " + out.size + " fallback effect(s) by interval");
  return out;
}
function plannedFx(style, pieces, fxList) {
  const out = /* @__PURE__ */ new Map();
  if (!PLANNED_FX_STYLES.includes(style)) return out;
  if (!Array.isArray(fxList) || !fxList.length) {
    console.warn("[plan] " + style + ": plan carried NO fx \u2014 transitions will be absent");
    return fallbackFx(style, pieces);
  }
  let n = 0;
  for (const item of fxList) {
    const make = FX_SPEC[String(item && item.effect)];
    if (!make) continue;
    const idx = pieceAt(pieces, Number(item.at));
    if (idx < 1) continue;
    if (out.has(idx)) continue;
    if ((Number(pieces[idx].dur) || 0) < 0.35) continue;
    out.set(idx, make(n++));
  }
  if (!out.size) {
    console.warn("[plan] " + style + ": " + fxList.length + " fx in the plan, none placed \u2014 falling back to interval placement");
    return fallbackFx(style, pieces);
  }
  return out;
}
function ghostFor(style, idx, kind, dur) {
  if (!GHOST_STYLES.includes(style) || kind === "bridge") return null;
  if (idx < 1 || idx % GHOST_EVERY !== 0) return null;
  if (dur < GHOST_MIN_DUR) return null;
  return { opacity: 0.35, driftX: 0.03, driftY: 0.012 };
}
export {
  assForWindow,
  buildAssEvents,
  planChunks,
  snapToBeat
};
