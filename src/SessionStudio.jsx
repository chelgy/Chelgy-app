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
  registerStem, readyVoiceProfile,
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

// Credit props arrive from SessionStudioMount in App.jsx. `costs` is passed in
// rather than imported so CREDIT_COSTS stays the one place prices are written.
// Defaults keep the screen renderable on its own (and keep the TDZ harness able
// to mount it with no props), but a missing cost must never read as free — the
// server charges regardless, so an absent number falls back to the real one.
export default function SessionStudio({
  user, token,
  credits = 0,
  useCredits = () => true,
  onBalance = () => {},
  onToolUse = () => {},
  onBuyCredits = () => {},
  costs = {},
}) {
  const COST = {
    separate: Number(costs.separate) || 250,
    mix:      Number(costs.mix)      || 150,
    master:   Number(costs.master)   || 100,
    convert:  Number(costs.convert)  || 150,
  };
  // One place to ask "can they afford this?". Returns false AND surfaces the
  // reason, because the old screen simply started the job and let the customer
  // discover the problem as a raw 402 from the server.
  function afford(kind) {
    const need = COST[kind] || 0;
    if (Number(credits) >= need && useCredits(need)) return true;
    setErr("This costs " + need.toLocaleString() + " credits. You have " + Number(credits).toLocaleString() + ".");
    onBuyCredits();
    return false;
  }
  // Every paid action says what it costs ON the button. The pre-check alone is
  // invisible to anyone who can afford the work — which is everyone until they
  // suddenly can't — so the screen read as free even while it charged.
  const price = (n) => (
    <span style={{ opacity: 0.55, fontSize: "0.92em", marginLeft: 6 }}>
      {Number(n).toLocaleString()}
    </span>
  );
  const [sessions, setSessions] = useState([]);
  const [active, setActive]     = useState(null);
  const [stems, setStems]       = useState([]);
  const [busy, setBusy]         = useState("");
  const [err, setErr]           = useState("");
  const [role, setRole]         = useState("lead");
  const [playing, setPlaying]   = useState(null);
  // stemId -> { jobId, pct, stage }. Keyed by stem so two separations running at
  // once report separately instead of overwriting one another's progress.
  const [splitting, setSplitting] = useState({});
  // stemId -> { jobId, pct, stage }, same shape and same reason as splitting.
  const [converting, setConverting] = useState({});
  // Which finish a conversion uses. Match restores the tone and space of the
  // take that came in, and is right often enough to be the default.
  const [space, setSpace] = useState("match");
  const [mixing, setMixing] = useState(null);
  // stemId -> true while mastering. /api/song-master answers synchronously, so
  // this is a busy flag rather than a polled job like mix and separate.
  const [mastering, setMastering] = useState({});
  // Warm is the all-rounder the Mix & Master tool defaults to; keeping the same
  // default means a master made here sounds like one made there.
  const [intensity, setIntensity] = useState("warm");
  const fileRef = useRef(null);
  const pollRef = useRef({});

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
  // Intervals outlive the component otherwise, and a poller firing against an
  // unmounted tree is a console full of setState warnings and a wasted request
  // every three seconds for as long as the tab is open.
  useEffect(() => () => {
    Object.values(pollRef.current || {}).forEach((id) => clearInterval(id));
    pollRef.current = {};
  }, []);
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

  // A filename a person can find again, not "audio.wav" twelve times over.
  function fileNameFor(stem) {
    const base = String(stem.label || roleLabel(stem.role) || "stem")
      .replace(/[\\/:*?"<>|]+/g, "-")      // illegal on Windows and confusing everywhere
      // The label often carries the ORIGINAL file's extension — "lead.aif" for
      // something now stored as wav — and keeping it produces "lead.aif.wav".
      .replace(/\.(wav|mp3|m4a|aif|aiff|flac|ogg|opus|webm)$/i, "")
      .replace(/\s+/g, " ")
      .trim()
      .slice(0, 80) || "stem";
    const ext = (String(stem.storage_path || "").match(/\.([a-z0-9]{1,5})$/i) || [, "wav"])[1];
    return base.toLowerCase().endsWith("." + ext.toLowerCase()) ? base : base + "." + ext;
  }

  async function onDownload(stem) {
    setErr("");
    const r = await stemUrl(token, stem);
    if (!r.ok) return setErr(r.error);

    const name = fileNameFor(stem);
    setBusy("Preparing " + name + "\u2026");
    try {
      // The <a download> attribute is IGNORED for cross-origin URLs — the
      // browser navigates to the file instead of saving it, which is what
      // sending people to a raw Supabase URL looked like. Fetching the bytes
      // and handing over a blob makes it same-origin, so the attribute is
      // honoured and the file lands in Downloads with the name we chose.
      const res = await fetch(r.url);
      if (!res.ok) throw new Error("download failed (" + res.status + ")");
      const blob = await res.blob();
      const objUrl = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = objUrl;
      a.download = name;
      document.body.appendChild(a); a.click(); a.remove();
      // Revoked on a delay: revoking immediately races the browser's own read
      // of the blob and produces an empty file on some versions of Safari.
      setTimeout(() => URL.revokeObjectURL(objUrl), 60000);
    } catch (e) {
      // Last resort so the person still gets their audio: Supabase honours a
      // `download` query parameter by setting Content-Disposition: attachment,
      // which saves the file even though this is a plain navigation.
      const sep = r.url.includes("?") ? "&" : "?";
      window.location.href = r.url + sep + "download=" + encodeURIComponent(name);
    } finally {
      setBusy("");
    }
  }

  // Separation runs on the song queue, so it is polled rather than awaited: a
  // GPU job outlives any single request, and a browser that reloads mid-split
  // must be able to pick it back up.
  async function onSplit(stem, twoStems) {
    setErr("");
    if (!afford("separate")) return;
    const got = await stemUrl(token, stem);
    if (!got.ok) return setErr(got.error);

    const t = token;
    const r = await fetch("/api/studio-separate", {
      method: "POST",
      headers: { "Content-Type": "application/json", ...(t ? { Authorization: "Bearer " + t } : {}) },
      body: JSON.stringify({
        sourceUrl: got.url,
        sessionId: active.id,
        parentStemId: stem.id,
        label: stem.label || roleLabel(stem.role),
        twoStems: twoStems || "",
      }),
    });
    const j = await r.json().catch(() => ({}));
    if (!r.ok || !j.jobId) return setErr(j.error || "Couldn't start the split.");
    if (typeof j.balance === "number") onBalance(j.balance);
    onToolUse("song_separate", COST.separate);

    setSplitting((m) => ({ ...m, [stem.id]: { jobId: j.jobId, pct: 5, stage: "Waiting for a machine" } }));

    pollRef.current[stem.id] = setInterval(async () => {
      try {
        const t2 = token;
        const s2 = await fetch("/api/studio-song?jobId=" + encodeURIComponent(j.jobId),
          { headers: t2 ? { Authorization: "Bearer " + t2 } : {} });
        const st = await s2.json();
        if (!s2.ok) return;
        setSplitting((m) => ({ ...m, [stem.id]: {
          jobId: j.jobId,
          pct: typeof st.progress === "number" ? Math.max(5, st.progress) : 5,
          stage: st.stage ? st.stage.charAt(0).toUpperCase() + st.stage.slice(1) : "Working",
        } }));
        if (st.status === "done" || st.status === "failed" || st.status === "error") {
          clearInterval(pollRef.current[stem.id]); delete pollRef.current[stem.id];
          setSplitting((m) => { const n = { ...m }; delete n[stem.id]; return n; });
          if (st.status !== "done") setErr(st.error || "The split didn't finish.");
          // The stems were written by the pod, not by this browser, so the list
          // has to be re-read rather than updated locally.
          refreshStems(active.id);
        }
      } catch (_) {}
    }, 3000);
  }

  // Convert a stem that is ALREADY in the session, in place.
  //
  // Backing vocals and ad libs are uploaded, never generated — the generated
  // harmonies sounded wrong and that path stays retired. But an uploaded
  // backing stem still has somebody else's voice on it, and until now the only
  // way to fix that was to download it and re-upload it through Song Studio.
  //
  // The result is a NEW stem carrying the same role, pointing at the take it
  // came from. Convert a vocal three times and all three sit in the session
  // with the newest marked CURRENT; nothing is overwritten.
  async function onConvert(stem) {
    setErr("");
    // Same job, same price as the Re-sing tab: this posts `convertVocal`, which
    // api/song-credits.js prices as a convert. Charging one number here and a
    // different one there for identical work is how a credit system loses trust.
    if (!afford("convert")) return;
    const prof = await readyVoiceProfile(token, uid);
    if (!prof.ok) return setErr(prof.error);
    const got = await stemUrl(token, stem);
    if (!got.ok) return setErr(got.error);

    const r = await fetch("/api/studio-song", {
      method: "POST",
      headers: { "Content-Type": "application/json", ...(token ? { Authorization: "Bearer " + token } : {}) },
      body: JSON.stringify({
        convertVocal: got.url,
        profileId: prof.profile.id,
        vocalSpace: space === "dry" ? "dry" : "wet",
      }),
    });
    const j = await r.json().catch(() => ({}));
    if (!r.ok || !j.jobId) return setErr(j.error || "Couldn't start the conversion.");
    if (typeof j.balance === "number") onBalance(j.balance);
    onToolUse("song_convert", COST.convert);

    setConverting((m) => ({ ...m, [stem.id]: { jobId: j.jobId, pct: 5, stage: "Waiting for a machine" } }));

    pollRef.current["c" + stem.id] = setInterval(async () => {
      try {
        const s2 = await fetch("/api/studio-song?jobId=" + encodeURIComponent(j.jobId),
          { headers: token ? { Authorization: "Bearer " + token } : {} });
        const st = await s2.json();
        if (!s2.ok) return;
        setConverting((m) => ({ ...m, [stem.id]: {
          jobId: j.jobId,
          pct: typeof st.progress === "number" ? Math.max(5, st.progress) : 5,
          stage: st.stage ? st.stage.charAt(0).toUpperCase() + st.stage.slice(1) : "Working",
        } }));
        if (st.status === "done" || st.status === "failed" || st.status === "error") {
          clearInterval(pollRef.current["c" + stem.id]); delete pollRef.current["c" + stem.id];
          setConverting((m) => { const n = { ...m }; delete n[stem.id]; return n; });
          if (st.status !== "done") { setErr(st.error || "The conversion didn't finish."); return; }
          // The render already lives at a URL of its own, so the stem points
          // there rather than copying tens of megabytes between buckets.
          const reg = await registerStem(token, uid, active.id, {
            role: stem.role,
            source: "converted",
            parentId: stem.id,
            label: (stem.label || roleLabel(stem.role)) + " \u2014 my voice",
            storagePath: st.storagePath || "",
            meta: { source_url: st.audioUrl || "", vocal_space: space, converted_from: stem.id },
          });
          if (!reg.ok) setErr("Converted, but couldn't add it to the session: " + reg.error);
          refreshStems(active.id);
        }
      } catch (_) {}
    }, 3000);
  }

  // Sum every layer in the session into one track.
  //
  // No faders yet, on purpose: the pipeline has sensible per-role levels, and a
  // mix button that works is worth more than sliders nobody has needed. When a
  // real mix comes back wrong, that is the moment to add the control it needed —
  // and the spec already carries db/pan fields for exactly that.
  async function onMix() {
    setErr("");
    if (!afford("mix")) return;
    const r = await fetch("/api/studio-mix", {
      method: "POST",
      headers: { "Content-Type": "application/json", ...(token ? { Authorization: "Bearer " + token } : {}) },
      body: JSON.stringify({ sessionId: active.id, label: active.title || "" }),
    });
    const j = await r.json().catch(() => ({}));
    if (!r.ok || !j.jobId) return setErr(j.error || "Couldn't start the mix.");
    if (typeof j.balance === "number") onBalance(j.balance);
    onToolUse("song_mix", COST.mix);

    setMixing({ jobId: j.jobId, pct: 5, stage: "Waiting for a machine" });
    pollRef.current.mix = setInterval(async () => {
      try {
        const s2 = await fetch("/api/studio-song?jobId=" + encodeURIComponent(j.jobId),
          { headers: token ? { Authorization: "Bearer " + token } : {} });
        const st = await s2.json();
        if (!s2.ok) return;
        setMixing({
          jobId: j.jobId,
          pct: typeof st.progress === "number" ? Math.max(5, st.progress) : 5,
          stage: st.stage ? st.stage.charAt(0).toUpperCase() + st.stage.slice(1) : "Working",
        });
        if (st.status === "done" || st.status === "failed" || st.status === "error") {
          clearInterval(pollRef.current.mix); delete pollRef.current.mix;
          setMixing(null);
          if (st.status !== "done") setErr(st.error || "The mix didn't finish.");
          refreshStems(active.id);
        }
      } catch (_) {}
    }, 3000);
  }

  // The final polish, on a finished bounce.
  //
  // Reuses /api/song-master rather than growing a pipeline: that endpoint already
  // does EQ, glue and loudness with a true-peak limiter, and it answers
  // synchronously, so there is no job to queue or poll.
  //
  // Mastering is deliberately its own step rather than part of Mix. Mixing is
  // per-stem and iterative; mastering is one pass over the finished thing.
  // Bundling them would re-master on every level change — slower, and it sounds
  // worse.
  async function onMaster(stem) {
    setErr("");
    if (!afford("master")) return;
    const got = await stemUrl(token, stem);
    if (!got.ok) return setErr(got.error);

    setMastering((m) => ({ ...m, [stem.id]: true }));
    try {
      const r = await fetch("/api/song-master", {
        method: "POST",
        headers: { "Content-Type": "application/json", ...(token ? { Authorization: "Bearer " + token } : {}) },
        body: JSON.stringify({ audioUrl: got.url, intensity }),
      });
      const j = await r.json().catch(() => ({}));
      if (!r.ok || !j.url) throw new Error(j.error || "Mastering failed.");
      if (typeof j.balance === "number") onBalance(j.balance);
      onToolUse("song_master", COST.master);

      const reg = await registerStem(token, uid, active.id, {
        role: "master",
        source: "mastered",
        parentId: stem.id,
        label: (stem.label || roleLabel(stem.role)) + " \u2014 mastered (" + intensity + ")",
        storagePath: "",
        meta: { source_url: j.url, intensity, mastered_from: stem.id },
      });
      if (!reg.ok) setErr("Mastered, but couldn't add it to the session: " + reg.error);
      refreshStems(active.id);
    } catch (e) {
      setErr(String((e && e.message) || e));
    } finally {
      setMastering((m) => { const n = { ...m }; delete n[stem.id]; return n; });
    }
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
  // Whole-song bounces are not layers — mixing a master back into a mix is how
  // people ruin a good bounce. Matches the same exclusion the route applies.
  const mixableStemCount = stems.filter(
    (s) => !["mix", "master", "instrumental"].includes(s.role) &&
           s.storage_path && !/^https?:\/\//.test(s.storage_path)).length;

  return (
    <div>
      <h2 style={{ fontSize: 20, fontWeight: 400, fontFamily: OUTFIT, margin: "0 0 4px" }}>Sessions</h2>
      <p style={{ fontFamily: JOST, fontSize: 13, color: B.mid, lineHeight: 1.55, margin: "0 0 14px" }}>
        A session keeps the stems of one song together — the lead, the backing, the instruments, every version you make.
        Nothing here is required: convert, mix and master all still work on their own, and every stem downloads on its own.
      </p>

      {err && <div style={{ fontFamily: JOST, fontSize: 12.5, color: B.red, border: "1px solid " + B.stone, padding: "8px 12px", marginBottom: 12 }}>{err}</div>}
      {busy && <div style={{ fontFamily: JOST, fontSize: 12.5, color: B.mid, marginBottom: 12 }}>{busy}</div>}
      {mixing && (
        <div style={{ marginBottom: 14 }}>
          <div style={{ height: 3, background: B.stone, marginBottom: 6 }}>
            <div style={{ height: 3, background: B.ink, width: (mixing.pct || 5) + "%", transition: "width .4s" }} />
          </div>
          <div style={{ fontFamily: JOST, fontSize: 11.5, color: B.mid }}>
            {mixing.stage}\u2026 mixing every layer into one track.
          </div>
        </div>
      )}

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
            {!mixing && mixableStemCount >= 2 && (
              <button onClick={onMix}
                style={{ fontFamily: JOST, fontSize: 11.5, letterSpacing: ".04em", padding: "6px 14px", border: "1px solid " + B.charcoal, background: B.inkBlock, color: B.inkText, cursor: "pointer" }}>
                Mix into one track{price(COST.mix)}
              </button>
            )}
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
            <span style={{ fontFamily: JOST, fontSize: 10, letterSpacing: ".1em", textTransform: "uppercase", color: B.mid, marginLeft: 8 }}>Voice finish</span>
            <select value={space} onChange={(e) => setSpace(e.target.value)}
              title="How a converted vocal is finished"
              style={{ fontFamily: JOST, fontSize: 13, padding: "8px 10px", border: "1px solid " + B.stone, background: B.white, color: B.ink }}>
              <option value="match">Match the original</option>
              <option value="wet">Produced</option>
              <option value="dry">Dry</option>
            </select>
            <span style={{ fontFamily: JOST, fontSize: 10, letterSpacing: ".1em", textTransform: "uppercase", color: B.mid, marginLeft: 8 }}>Master</span>
            <select value={intensity} onChange={(e) => setIntensity(e.target.value)}
              title="How the final polish is applied"
              style={{ fontFamily: JOST, fontSize: 13, padding: "8px 10px", border: "1px solid " + B.stone, background: B.white, color: B.ink }}>
              <option value="clean">Clean</option>
              <option value="warm">Warm</option>
              <option value="loud">Loud</option>
            </select>
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
                      {["mix", "instrumental", "master"].includes(s.role) && (
                        <button onClick={() => onMaster(s)} disabled={!!mastering[s.id]}
                          title="EQ, glue and loudness for streaming"
                          style={{ background: "none", border: "1px solid " + B.stone, padding: "5px 12px", fontFamily: JOST, fontSize: 11.5, color: B.ink, cursor: mastering[s.id] ? "default" : "pointer", opacity: mastering[s.id] ? 0.5 : 1 }}>
                          {mastering[s.id] ? "Mastering\u2026" : <>Master{price(COST.master)}</>}
                        </button>
                      )}
                      {["lead", "backing", "adlib"].includes(s.role) && !converting[s.id] && (
                        <button onClick={() => onConvert(s)} title="Sing this in your voice, keeping its timing and words"
                          style={{ background: "none", border: "1px solid " + B.stone, padding: "5px 12px", fontFamily: JOST, fontSize: 11.5, color: B.ink, cursor: "pointer" }}>To my voice{price(COST.convert)}</button>
                      )}
                      {!splitting[s.id] && (
                        <button onClick={() => onSplit(s, "")} title="Split into vocals, drums, bass and the rest"
                          style={{ background: "none", border: "1px solid " + B.stone, padding: "5px 12px", fontFamily: JOST, fontSize: 11.5, color: B.ink, cursor: "pointer" }}>Split{price(COST.separate)}</button>
                      )}
                      <button onClick={() => onDeleteStem(s)} style={{ background: "none", border: "none", padding: "5px 6px", fontFamily: JOST, fontSize: 11.5, color: B.mid, cursor: "pointer" }}>Remove</button>
                    </div>
                    {converting[s.id] && (
                      <div style={{ marginTop: 8 }}>
                        <div style={{ height: 3, background: B.stone, marginBottom: 6 }}>
                          <div style={{ height: 3, background: B.ink, width: (converting[s.id].pct || 5) + "%", transition: "width .4s" }} />
                        </div>
                        <div style={{ fontFamily: JOST, fontSize: 11.5, color: B.mid }}>
                          {converting[s.id].stage}\u2026 singing it in your voice, same timing and words.
                        </div>
                      </div>
                    )}
                    {splitting[s.id] && (
                      <div style={{ marginTop: 8 }}>
                        <div style={{ height: 3, background: B.stone, marginBottom: 6 }}>
                          <div style={{ height: 3, background: B.ink, width: (splitting[s.id].pct || 5) + "%", transition: "width .4s" }} />
                        </div>
                        <div style={{ fontFamily: JOST, fontSize: 11.5, color: B.mid }}>
                          {splitting[s.id].stage}\u2026 splitting into vocals, drums, bass and the rest. This takes a minute or two.
                        </div>
                      </div>
                    )}
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
