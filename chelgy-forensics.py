#!/usr/bin/env python3
"""
Find things that disappeared from a file and never came back.

Whole-file overwrites are silent: git records them as an ordinary commit, and a
feature that vanished three commits ago looks exactly like a feature that was
never written. This walks every commit that touched the file, extracts the set
of declared names at each point, and reports every name that is present in the
history but MISSING from the current version -- along with the exact commit
where it disappeared.

Usage, from inside the repo:

    python3 chelgy-forensics.py
    python3 chelgy-forensics.py --file src/App.jsx
    python3 chelgy-forensics.py --file api/studio-plan.js --out report.md
"""

import argparse
import re
import subprocess
import sys
from collections import OrderedDict

# What counts as a "thing" worth tracking. Declarations, priced items, and the
# id fields that register a tool in the app -- the shapes that represent a
# feature rather than a line of incidental code.
PATTERNS = [
    ("function",  re.compile(r'^(?:export\s+)?(?:async\s+)?function\s+([A-Za-z_$][\w$]*)')),
    ("nested fn", re.compile(r'^\s+(?:export\s+)?(?:async\s+)?function\s+([A-Za-z_$][\w$]*)')),
    ("const",     re.compile(r'^(?:export\s+)?(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=')),
    ("local",     re.compile(r'^\s+(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=')),
    ("credit",    re.compile(r'\b([a-zA-Z_$][\w$]*)\s*:\s*\d+(?:\s*[,}]|\s*$)')),
    ("tool id",   re.compile(r'id\s*:\s*"(cat_[\w]+)"')),
    ("api route", re.compile(r'["\'](/api/[\w.-]+)["\']')),
]


def sh(args):
    r = subprocess.run(args, capture_output=True, text=True)
    if r.returncode != 0:
        sys.exit("git failed: " + " ".join(args) + "\n" + r.stderr.strip())
    return r.stdout


# Declarations appear once per line and are anchored; keys, ids and routes can
# appear several times on one line (a whole priced object is often written
# inline), so those are scanned with finditer or every one after the first is
# invisible -- which is exactly the kind of silent miss this script exists to
# catch.
MULTI = {"credit", "tool id", "api route"}


def names_in(text):
    """Every tracked name in one version of the file, with its kind."""
    found = {}
    for line in text.splitlines():
        for kind, pat in PATTERNS:
            if kind in MULTI:
                for m in pat.finditer(line):
                    found.setdefault(m.group(1), kind)
            else:
                m = pat.search(line)
                if m:
                    found.setdefault(m.group(1), kind)
    return found


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--file", default="src/App.jsx")
    ap.add_argument("--out", default="")
    ap.add_argument("--all", action="store_true",
                    help="include local variables (noisy; off by default)")
    args = ap.parse_args()
    path = args.file

    # Oldest first, so "when did it vanish" reads forwards.
    commits = sh(["git", "log", "--reverse", "--format=%H|%ad|%s",
                  "--date=short", "--", path]).strip().splitlines()
    if not commits:
        sys.exit("No history for " + path + " -- check the path.")

    print("Walking " + str(len(commits)) + " commits that touched " + path + "\n")

    seen = OrderedDict()   # name -> kind, everything that ever existed
    born = {}              # name -> (hash, date, subject) first appearance
    vanished = {}          # name -> (hash, date, subject) most recent removal
    churn = []             # per-commit line stats, to spot whole-file overwrites
    prev = set()

    for i, row in enumerate(commits):
        h, date, subject = row.split("|", 2)
        try:
            text = sh(["git", "show", h + ":" + path])
        except SystemExit:
            continue
        cur_map = names_in(text)
        cur = set(cur_map)

        for n, k in cur_map.items():
            if n not in seen:
                seen[n] = k
                born[n] = (h, date, subject)
        # Anything that was here last commit and isn't now.
        for n in prev - cur:
            vanished[n] = (h, date, subject)
        # Anything that came back clears its removal record.
        for n in cur - prev:
            vanished.pop(n, None)

        if i > 0:
            stat = sh(["git", "diff", "--numstat", commits[i - 1].split("|")[0], h, "--", path]).strip()
            if stat:
                parts = stat.split()
                added, deleted = parts[0], parts[1]
                if added.isdigit() and deleted.isdigit():
                    churn.append((int(deleted), int(added), h, date, subject))
        prev = cur

    head = prev  # the final commit's set == current file
    NOISE = {"local", "nested fn"}
    lost = [(n, seen[n], born[n], vanished[n]) for n in seen
            if n not in head and n in vanished
            and (args.all or seen[n] not in NOISE or n[:1].isupper())]
    lost.sort(key=lambda x: x[3][1])

    out = []
    out.append("# What went missing from " + path + "\n")
    out.append("Commits examined: " + str(len(commits)) +
               " | names ever declared: " + str(len(seen)) +
               " | present now: " + str(len(head)) + "\n")

    out.append("\n## Features lost and never restored (" + str(len(lost)) + ")\n")
    if not args.all:
        out.append("\nLocal variables are excluded -- a renamed local inside a refactor")
        out.append(" is not a lost feature. Re-run with --all to see everything.\n")
    if not lost:
        out.append("\nNothing. Every name that ever existed is still in the file.\n")
    else:
        out.append("\n| name | kind | disappeared in | date | commit subject |")
        out.append("\n|---|---|---|---|---|\n")
        for n, kind, b, v in lost:
            out.append("| `" + n + "` | " + kind + " | `" + v[0][:9] + "` | " + v[1] +
                       " | " + v[2][:60].replace("|", "/") + " |\n")

    out.append("\n## Biggest deletions (the likely overwrites)\n")
    out.append("\nA commit that removes far more than it adds is usually a whole-file")
    out.append(" drop-in rather than an edit. Check these first.\n")
    out.append("\n| removed | added | commit | date | subject |")
    out.append("\n|---|---|---|---|---|\n")
    for deleted, added, h, date, subject in sorted(churn, reverse=True)[:12]:
        out.append("| " + str(deleted) + " | " + str(added) + " | `" + h[:9] + "` | " +
                   date + " | " + subject[:60].replace("|", "/") + " |\n")

    if lost:
        out.append("\n## Recovering one\n")
        n, kind, b, v = lost[0]
        out.append("\nThe last commit that still had `" + n + "` is the one BEFORE `" +
                   v[0][:9] + "`. To read it:\n")
        out.append("\n```bash\ngit show " + v[0][:9] + "^:" + path + " > /tmp/before.jsx\n")
        out.append("grep -n \"" + n + "\" /tmp/before.jsx\n```\n")
        out.append("\nThat gives you the old version of the whole file to copy the piece out of.")
        out.append(" Don't check the old file in wholesale -- that is the same move that caused this.\n")

    report = "".join(out)
    print(report)
    if args.out:
        with open(args.out, "w") as f:
            f.write(report)
        print("\nSaved to " + args.out)


if __name__ == "__main__":
    main()
