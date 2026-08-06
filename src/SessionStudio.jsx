// ═══════════════════════════════════════════════════════════════════════════
// SONG STUDIO — the session workspace.
//
// A session is a place to keep the stems of one song between operations. This
// screen does the container: create a session, bring stems in, see what is in
// there, play any of them, download any of them, remove a row.
//
// It deliberately does NOT gate anything. Convert, mix and master remain
// standalone tools that work without ever opening this screen — a person who
// only wants a re-sing of one vocal never has to make a session. This is
// storage with structure, not a wizard.
//
// Everything is stem-in / stem-out: nothing here overwrites. Convert the same
// lead three times and all three sit in the list, newest marked CURRENT, every
// earlier one still playable and downloadable.
// ═══════════════════════════════════════════════════════════════════════════
import { useState, useEffect, useRef } from "react";
import {
  ROLES, roleLabel, currentLead,
  createSession, listSessions, renameSession, deleteSession,
  listStems, uploadStem, stemUrl, deleteStem,
} from "./songSession.js";

const B = {
  ink: "#111", mid: "#6b6b6b", stone: "#E8E6E1", white: "#fff",
  charcoal: "#222", inkBlock: "#111", inkText: "#fff", red: "#C0392B",
};
const JOST = "Jost,Helvetica,Arial,sans-serif";
const OUTFIT = "Outfit,Helvetica Neue,Helvetica,Arial,sans-serif";

const mmss = (s) => {
  const n = Math.max(0, Math.round(Number(s) || 0));
  return Math.floor(n / 60) + ":" + String(n % 60).padStart(2, "0");
};

// Reads duration without decoding the whole file — enough for a label.
function probeDuration(file) {
  return new Promise((resolve) => {
    try {
      const el = document.createElement("audio");
      const url = URL.createObjectURL(file);
      const done = (v) => { URL.revokeObjectURL(url); resolve(v); };
      el.preload = "metadata";
      el.onloadedmetadata = () => done(isFinite(el.duration) ? el.duration : null);
      el.onerror = () => done(null);
      el.src = url;
      setTimeout(() => done(null), 8000);
    } catch { resolve(null); }
  });
}

export default function SessionStudio({ user, token }) {
  const [sessions, setSessions] = useState([]);
  const [active, setActive]     = useState(null);
  const [stems, setStems]       = useState([]);
  const [busy, setBusy]         = useState("");
  const [err, setErr]           = useState("");
  const [role, setRole]         = useState("lead");
  const [playing, setPlaying]   = useState(null);
  const fileRef = useRef(null);

  const uid = user && user.id;

  async function refreshSessions() {
    if (!token || !uid) return;
    const r = await listSessions(token, uid);
    if (r.ok) setSessions(r.sessions);
    else setErr(r.error);
  }
  async function refreshStems(sessionId) {
    const r = await listStems(token, sessionId);
    if (r.ok) setStems(r.stems); else setErr(r.error);
  }

  useEffect(() => { refreshSessions(); /* eslint-disable-next-line */ }, [token, uid]);
  useEffect(() => { if (active) refreshStems(active.id); else setStems([]); /* eslint-disable-next-line */ }, [active && active.id]);

  async function onNew() {
    setErr(""); setBusy("Creating…");
    const r = await createSession(token, uid, "Untitled song");
    setBusy("");
    if (!r.ok) return setErr(r.error);
    setSessions((s) => [r.session, ...s]);
    setActive(r.session);
  }

  async function onRename(s) {
    const t = window.prompt("Name this song", s.title || "");
    if (t == null) return;
    const r = await renameSession(token, s.id, t.trim() || "Untitled song");
    if (!r.ok) return setErr(r.error);
    setSessions((list) => list.map((x) => (x.id === s.id ? r.session : x)));
    if (active && active.id === s.id) setActive(r.session);
  }

  async function onDeleteSession(s) {
    if (!window.confirm("Delete “" + (s.title || "Untitled song") + "”? The audio files stay in your storage; this removes the session and its list of stems.")) return;
    const r = await deleteSession(token, s.id);
    if (!r.ok) return setErr(r.error);
    setSessions((list) => list.filter((x) => x.id !== s.id));
    if (active && active.id === s.id) { setActive(null); setStems([]); }
  }

  async function onFiles(files) {
    if (!active || !files || !files.length) return;
    setErr("");
    const arr = Array.from(files);
    for (let i = 0; i < arr.length; i++) {
      const f = arr[i];
      setBusy("Uploading " + (i + 1) + " of " + arr.length + " — " + f.name);
      const dur = await probeDuration(f);
      const r = await uploadStem(token, uid, active.id, f, { role, source: "uploaded", duration: dur });
      if (!r.ok) { setErr(r.error); break; }
    }
    setBusy("");
    refreshStems(active.id);
  }

  async function onPlay(stem) {
    setErr("");
    const r = await stemUrl(token, stem);
    if (!r.ok) return setErr(r.error);
    setPlaying({ id: stem.id, url: r.url });
  }

  async function onDownload(stem) {
    setErr("");
    const r = await stemUrl(token, stem);
    if (!r.ok) return setErr(r.error);
    const a = document.createElement("a");
    a.href = r.url;
    a.download = (stem.label || roleLabel(stem.role)) || "stem";
    document.body.appendChild(a); a.click(); a.remove();
  }

  async function onDeleteStem(stem) {
    if (!window.confirm("Remove this stem from the session? The file itself stays in your storage.")) return;
    const r = await deleteStem(token, stem.id);
    if (!r.ok) return setErr(r.error);
    refreshStems(active.id);
  }

  if (!uid) {
    return <p style={{ fontFamily: JOST, fontSize: 14, color: B.mid }}>Sign in to use sessions.</p>;
  }

  const lead = currentLead(stems);

  return (
    <div>
      <h2 style={{ fontSize: 20, fontWeight: 400, fontFamily: OUTFIT, margin: "0 0 4px" }}>Sessions</h2>
      <p style={{ fontFamily: JOST, fontSize: 13, color: B.mid, lineHeight: 1.55, margin: "0 0 14px" }}>
        A session keeps the stems of one song together — the lead, the backing, the instruments, every version you make.
        Nothing here is required: convert, mix and master all still work on their own, and every stem downloads on its own.
      </p>

      {err && <div style={{ fontFamily: JOST, fontSize: 12.5, color: B.red, border: "1px solid " + B.stone, padding: "8px 12px", marginBottom: 12 }}>{err}</div>}
      {busy && <div style={{ fontFamily: JOST, fontSize: 12.5, color: B.mid, marginBottom: 12 }}>{busy}</div>}

      {/* ── SESSION LIST ─────────────────────────────────────────────── */}
      <div style={{ display: "flex", gap: 8, flexWrap: "wrap", alignItems: "center", marginBottom: 14 }}>
        <button onClick={onNew} style={{ fontFamily: JOST, fontSize: 12.5, letterSpacing: ".04em", padding: "9px 18px", border: "1px solid " + B.charcoal, background: B.inkBlock, color: B.inkText, cursor: "pointer" }}>
          New session
        </button>
        {sessions.length > 0 && (
          <select
            value={active ? active.id : ""}
            onChange={(e) => setActive(sessions.find((s) => s.id === e.target.value) || null)}
            style={{ fontFamily: JOST, fontSize: 13, padding: "9px 12px", border: "1px solid " + B.stone, background: B.white, color: B.ink, minWidth: 220 }}
          >
            <option value="">Choose a session…</option>
            {sessions.map((s) => <option key={s.id} value={s.id}>{s.title || "Untitled song"}</option>)}
          </select>
        )}
      </div>

      {!active && sessions.length === 0 && (
        <p style={{ fontFamily: JOST, fontSize: 13, color: B.mid }}>No sessions yet. Make one when you want to keep a song's parts together.</p>
      )}

      {active && (
        <div style={{ border: "1px solid " + B.stone, padding: 16, background: B.white }}>
          <div style={{ display: "flex", gap: 10, alignItems: "baseline", flexWrap: "wrap", marginBottom: 12 }}>
            <div style={{ fontFamily: OUTFIT, fontSize: 17 }}>{active.title || "Untitled song"}</div>
            <button onClick={() => onRename(active)} style={{ background: "none", border: "none", padding: 0, fontFamily: JOST, fontSize: 12, color: B.mid, cursor: "pointer", textDecoration: "underline" }}>rename</button>
            <button onClick={() => onDeleteSession(active)} style={{ background: "none", border: "none", padding: 0, fontFamily: JOST, fontSize: 12, color: B.mid, cursor: "pointer", textDecoration: "underline" }}>delete</button>
            {active.bpm ? <span style={{ fontFamily: JOST, fontSize: 11.5, color: B.mid }}>{Math.round(active.bpm)} BPM{active.music_key ? " · " + active.music_key : ""}</span> : null}
          </div>

          {/* ── BRING STEMS IN ────────────────────────────────────────── */}
          <div style={{ display: "flex", gap: 8, flexWrap: "wrap", alignItems: "center", marginBottom: 14 }}>
            <span style={{ fontFamily: JOST, fontSize: 10, letterSpacing: ".1em", textTransform: "uppercase", color: B.mid }}>Add as</span>
            <select value={role} onChange={(e) => setRole(e.target.value)}
              style={{ fontFamily: JOST, fontSize: 13, padding: "8px 10px", border: "1px solid " + B.stone, background: B.white, color: B.ink }}>
              {ROLES.map((r) => <option key={r.id} value={r.id}>{r.label}</option>)}
            </select>
            <button onClick={() => fileRef.current && fileRef.current.click()}
              style={{ fontFamily: JOST, fontSize: 12.5, letterSpacing: ".04em", padding: "9px 18px", border: "1px solid " + B.charcoal, background: B.white, color: B.ink, cursor: "pointer" }}>
              Add audio files
            </button>
            <input ref={fileRef} type="file" accept="audio/*" multiple style={{ display: "none" }}
              onChange={(e) => { onFiles(e.target.files); e.target.value = ""; }} />
          </div>

          {/* ── STEMS ─────────────────────────────────────────────────── */}
          {stems.length === 0 ? (
            <p style={{ fontFamily: JOST, fontSize: 13, color: B.mid, margin: 0 }}>
              Nothing in this session yet. Add a vocal, a Suno stem, or a whole track to start.
            </p>
          ) : (
            <div>
              {stems.map((s) => {
                const isLead = lead && lead.id === s.id;
                return (
                  <div key={s.id} style={{ borderTop: "1px solid " + B.stone, padding: "10px 0" }}>
                    <div style={{ display: "flex", gap: 10, alignItems: "center", flexWrap: "wrap" }}>
                      <span style={{ fontFamily: JOST, fontSize: 10, letterSpacing: ".1em", textTransform: "uppercase", color: B.mid, minWidth: 92 }}>
                        {roleLabel(s.role)}
                      </span>
                      <span style={{ fontFamily: JOST, fontSize: 13.5, color: B.ink, flex: 1, minWidth: 160, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                        {s.label || "(untitled)"}
                      </span>
                      {isLead && <span style={{ fontFamily: JOST, fontSize: 9.5, letterSpacing: ".1em", textTransform: "uppercase", color: B.ink, border: "1px solid " + B.stone, padding: "2px 6px" }}>current</span>}
                      {s.parent_id && <span style={{ fontFamily: JOST, fontSize: 11, color: B.mid }}>from an earlier take</span>}
                      <span style={{ fontFamily: JOST, fontSize: 11.5, color: B.mid }}>{s.duration ? mmss(s.duration) : ""}</span>
                      <button onClick={() => onPlay(s)} style={{ background: "none", border: "1px solid " + B.stone, padding: "5px 12px", fontFamily: JOST, fontSize: 11.5, color: B.ink, cursor: "pointer" }}>Play</button>
                      <button onClick={() => onDownload(s)} style={{ background: "none", border: "1px solid " + B.stone, padding: "5px 12px", fontFamily: JOST, fontSize: 11.5, color: B.ink, cursor: "pointer" }}>Download</button>
                      <button onClick={() => onDeleteStem(s)} style={{ background: "none", border: "none", padding: "5px 6px", fontFamily: JOST, fontSize: 11.5, color: B.mid, cursor: "pointer" }}>Remove</button>
                    </div>
                    {playing && playing.id === s.id && (
                      <audio src={playing.url} controls autoPlay style={{ width: "100%", height: 34, marginTop: 8 }} />
                    )}
                  </div>
                );
              })}
            </div>
          )}
        </div>
      )}
    </div>
  );
}
