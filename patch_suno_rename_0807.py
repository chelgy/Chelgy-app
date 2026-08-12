#!/usr/bin/env python3
"""
CHELGY — take a competitor's brand out of the interface.

WHAT THIS CHANGES: visible copy only. Button labels, headings, hints, stage messages,
error text, the Song Studio blurb.

WHAT IT DELIBERATELY DOES NOT CHANGE, and this is the important half:

  the tool id           "sunoprod"        — renaming it breaks routing
  the storage folder    "suno-in/"        — renaming it orphans every file already there
  the API route         "/api/song-suno"  — renaming it means renaming a file too
  the component name    SunoProduction    — internal, invisible, and referenced elsewhere

None of those are visible to anybody. Cosmetic renames that break working systems are
the most expensive kind of tidying there is.

    python3 patch_suno_rename_0807.py <md5 of src/App.jsx>
"""

import hashlib
import sys

PATH = "src/App.jsx"

if len(sys.argv) < 2:
    print("Usage: python3 patch_suno_rename_0807.py <md5 of src/App.jsx>")
    sys.exit(1)
GUARD = sys.argv[1].strip().lower()

src = open(PATH, encoding="utf-8").read()
have = hashlib.md5(src.encode("utf-8")).hexdigest()
if have != GUARD:
    print("STOPPED — App.jsx does not match the hash you gave.")
    print("  you said " + GUARD)
    print("  found    " + have)
    sys.exit(1)


def counts(t):
    return {k: t.count(a) - t.count(b) for k, a, b in (("{}", "{", "}"), ("()", "(", ")"), ("[]", "[", "]"))}


before = counts(src)
edits = 0
skipped = []


def sub(old, new, label, required=True):
    global src, edits
    n = src.count(old)
    if n == 0 and not required:
        skipped.append(label)
        return
    if n != 1:
        print("STOPPED — anchor for '" + label + "' appears " + str(n) + " times, expected 1.")
        sys.exit(1)
    src = src.replace(old, new)
    edits += 1


# ── Song Studio: the convert / match flow ───────────────────────────────────
#
# "Match" is the feature: your voice is time-aligned to a reference vocal's phrasing
# and tone-matched to sit in the same mix. Nothing about that needs a brand name, and
# naming one makes the feature look like it only works with that one service.

sub('{[["match","Match Suno"],["wet","Produced"],["dry","Dry"]]',
    '{[["match","Match my reference"],["wet","Produced"],["dry","Dry"]]',
    "finish buttons A")

sub('{[["match","Match my Suno track"],["produced","Produced"],["dry","Dry"]]',
    '{[["match","Match my reference"],["produced","Produced"],["dry","Dry"]]',
    "finish buttons B")

sub('"Upload your Suno vocal stem \\u2014 your voice is time-aligned to its phrasing and tone-matched, so it sits right on your Suno stems."',
    '"Upload the finished lead vocal \\u2014 your voice is time-aligned to its phrasing and tone-matched, so it sits right on the same backing."',
    "match hint")

sub(': "Upload Suno vocal stem"}',
    ': "Upload the lead vocal"}',
    "upload button")

sub("Time-align my phrases to the Suno stem (recommended if you sang along to it)",
    "Time-align my phrases to the reference (recommended if you sang along to it)",
    "time-align checkbox")

sub('"Upload a finished vocal (e.g. your Suno lead stem) and get it back in your voice',
    '"Upload a finished vocal \\u2014 a professional lead stem, a demo, a guide \\u2014 and get it back in your voice',
    "convert hint")

# ── Song Studio blurbs, in both places they appear ──────────────────────────
sub("Put any vocal in your own voice. Upload a finished vocal — a Suno lead stem, a rough demo, someone else\u2019s guide",
    "Put any vocal in your own voice. Upload a finished vocal — a professional lead stem, a rough demo, someone else\u2019s guide",
    "studio blurb")

sub('blurb:"Put any vocal in your own voice. Upload a finished vocal \\u2014 a Suno lead stem',
    'blurb:"Put any vocal in your own voice. Upload a finished vocal \\u2014 a professional lead stem',
    "category blurb")

# ── The production tab, currently hidden but renamed for when it isn't ──────
sub('setStage("Suno is building production around your voice\\u2026 (up to a few minutes)");',
    'setStage("Building the production around your voice\\u2026 (up to a few minutes)");',
    "stage A")

sub('setStage("Suno is generating a full song, then splitting stems\\u2026 (up to a few minutes)");',
    'setStage("Generating a full song, then splitting stems\\u2026 (up to a few minutes)");',
    "stage B")

sub('throw new Error(j.error||"Suno production failed.");',
    'throw new Error(j.error||"The production failed.");',
    "error text")

sub('const label = approach==="A" ? "Suno production (wrapped)" : "Suno full + stems";',
    'const label = approach==="A" ? "Full production (wrapped)" : "Full song + stems";',
    "library label")

sub('margin:"0 0 8px"}}>Suno Production</h2>',
    'margin:"0 0 8px"}}>Full Production</h2>',
    "heading")

sub("Your voice, their production. Bring a finished vocal and Suno builds a full arrangement",
    "Your voice, a full production. Bring a finished vocal and a complete arrangement is built",
    "production blurb")

sub('{approach==="A" ? "Send your vocal to Suno; it wraps a full arrangement around your actual voice. One pass."',
    '{approach==="A" ? "Your vocal goes out for production and comes back inside a full arrangement. One pass."',
    "approach A")

sub('"Generate a full Suno song from a description, then split it \\u2014 keep the instrumental and backing vocals',
    '"Generate a full song from a description, then split it \\u2014 keep the instrumental and backing vocals',
    "approach B")

# The hidden tab's own label, so switching it on later doesn't reintroduce the name.
sub('/* HIDDEN: {label:"Suno Production",tool:"sunoprod"}',
    '/* HIDDEN: {label:"Full Production",tool:"sunoprod"}',
    "hidden tab label", required=False)

# ── comments, so the next person reading this isn't misled about the coupling ──
sub('const [matchFile,setMatchFile]   = useState(null);    // Suno vocal stem for match',
    'const [matchFile,setMatchFile]   = useState(null);    // the reference lead vocal for match mode',
    "comment A")

sub('// In "match" mode, upload the Suno vocal stem so the render can',
    '// In "match" mode, upload the reference lead vocal so the render can',
    "comment B")

sub("// Direct conversion: upload the finished vocal (e.g. a Suno lead stem).",
    "// Direct conversion: upload the finished vocal (a professional lead stem, a demo).",
    "comment C")

after = counts(src)
if after != before:
    print("STOPPED — delimiters moved: " + str(before) + " -> " + str(after))
    sys.exit(1)

open(PATH, "w", encoding="utf-8").write(src)
left = src.lower().count("suno")
print("OK — " + str(edits) + " edits, delimiters unchanged " + str(after))
if skipped:
    print("   not present, skipped: " + ", ".join(skipped))
print("   'suno' still appears " + str(left) + " times — all plumbing (tool id, storage path, api route, component name)")
