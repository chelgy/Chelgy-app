// api/prerender.js
// Dynamic rendering for search-engine + social crawlers.
// Real visitors never hit this (see middleware.js) — bots get fully-rendered
// HTML (title, meta, Open Graph, JSON-LD schema, and all the visible copy)
// so a JavaScript site indexes as if it were plain HTML.

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_KEY = process.env.SUPABASE_ANON_KEY || process.env.SUPABASE_SERVICE_ROLE_KEY;

function esc(s) {
  return String(s == null ? "" : s)
    .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;").replace(/'/g, "&#39;");
}
function first(v) { return Array.isArray(v) ? v[0] : v; }
function findSec(secs, t) { return (secs || []).find(s => s && s.type === t) || {}; }

function metaDescription(site) {
  const secs = site.sections || [];
  const hero = findSec(secs, "hero"), phil = findSec(secs, "philosophy"), about = findSec(secs, "about");
  const name = (site.brand && site.brand.name) || "";
  const d = hero.sub || first(phil.body) || first(about.body) || ((name ? name + " — " : "") + (hero.headline || "")) || name;
  return String(d || "").replace(/\s+/g, " ").trim().slice(0, 300);
}
function heroImage(site) {
  const secs = site.sections || [];
  const hero = findSec(secs, "hero"), about = findSec(secs, "about");
  return (hero.image && hero.image.url) || (about.image && about.image.url) || "";
}

// Build the semantic body content from every text-bearing section.
function bodyContent(site) {
  const secs = site.sections || [];
  const name = (site.brand && site.brand.name) || "";
  let h = [];
  if (name) h.push(`<p><strong>${esc(name)}</strong></p>`);
  for (const sec of secs) {
    if (!sec || !sec.type) continue;
    const t = sec.type;
    if (t === "hero") {
      const head = [sec.headline, sec.headlineEm].filter(Boolean).join(" ");
      if (head) h.push(`<h1>${esc(head)}</h1>`);
      if (sec.sub) h.push(`<p>${esc(sec.sub)}</p>`);
    } else if (t === "philosophy" || t === "about") {
      const head = [sec.heading, sec.headingEm].filter(Boolean).join(" ");
      if (head) h.push(`<h2>${esc(head)}</h2>`);
      (Array.isArray(sec.body) ? sec.body : [sec.body]).filter(Boolean).forEach(p => h.push(`<p>${esc(p)}</p>`));
    } else if (t === "offerings" || t === "services") {
      if (sec.title) h.push(`<h2>${esc(sec.title)}</h2>`);
      (sec.items || []).forEach(it => {
        if (it && it.name) h.push(`<h3>${esc(it.name)}${it.price ? " — " + esc(it.price) : ""}</h3>`);
        if (it && (it.note || it.desc)) h.push(`<p>${esc(it.note || it.desc)}</p>`);
      });
    } else if (t === "editorial") {
      const line = [sec.line, sec.lineEm].filter(Boolean).join(" ");
      if (line) h.push(`<h2>${esc(line)}</h2>`);
    } else if (t === "quote") {
      if (sec.text) h.push(`<blockquote>${esc(sec.text)}${sec.cite ? " " + esc(sec.cite) : ""}</blockquote>`);
    } else if (t === "whyus" || t === "process") {
      if (sec.title) h.push(`<h2>${esc(sec.title)}</h2>`);
      const arr = sec.points || sec.steps || [];
      if (arr.length) h.push("<ul>" + arr.map(x => `<li>${esc(x)}</li>`).join("") + "</ul>");
    } else if (t === "faq") {
      if (sec.title) h.push(`<h2>${esc(sec.title)}</h2>`);
      (sec.qs || []).forEach(q => { if (q) { h.push(`<h3>${esc(q.q)}</h3>`); h.push(`<p>${esc(q.a)}</p>`); } });
    } else if (t === "testimonials") {
      if (sec.title) h.push(`<h2>${esc(sec.title)}</h2>`);
      (sec.cards || []).forEach(c => { if (c && c.quote) h.push(`<blockquote>${esc(c.quote)}${c.name ? " — " + esc(c.name) : ""}</blockquote>`); });
    } else if (t === "pricing") {
      if (sec.title) h.push(`<h2>${esc(sec.title)}</h2>`);
      (sec.tiers || []).forEach(tr => { if (tr) { h.push(`<h3>${esc(tr.name)}${tr.price ? " — " + esc(tr.price) : ""}</h3>`); if (tr.desc) h.push(`<p>${esc(tr.desc)}</p>`); } });
    } else if (t === "serviceareas") {
      if (sec.title) h.push(`<h2>${esc(sec.title)}</h2>`);
      if ((sec.areas || []).length) h.push("<ul>" + sec.areas.map(a => `<li>${esc(a)}</li>`).join("") + "</ul>");
    } else if (t === "hours") {
      if (sec.title) h.push(`<h2>${esc(sec.title)}</h2>`);
      (sec.rows || []).forEach(r => { if (Array.isArray(r)) h.push(`<p>${esc(r.join(": "))}</p>`); });
    } else if (t === "cta") {
      if (sec.headline) h.push(`<h2>${esc(sec.headline)}</h2>`);
    } else if (t === "contact") {
      const head = [sec.heading, sec.headingEm].filter(Boolean).join(" ");
      if (head) h.push(`<h2>${esc(head)}</h2>`);
      (sec.details || []).forEach(d => { if (d) h.push(`<p>${esc((d.k ? d.k + ": " : "") + (d.v || ""))}</p>`); });
    }
  }
  // blog index
  const blog = Array.isArray(site.blog) ? site.blog : [];
  if (blog.length) {
    h.push("<h2>From the blog</h2>");
    blog.forEach(p => {
      if (!p) return;
      const key = p.slug || p.id;
      h.push(`<article><h3><a href="?post=${encodeURIComponent(key)}">${esc(p.title)}</a></h3>${p.excerpt ? `<p>${esc(p.excerpt)}</p>` : ""}</article>`);
    });
  }
  return h.join("\n");
}

function localBusinessLd(site, canonical) {
  const name = (site.brand && site.brand.name) || "";
  const desc = metaDescription(site);
  const secs = site.sections || [];
  const contact = findSec(secs, "contact");
  const rows = contact.details || [];
  const rv = k => { const r = rows.find(x => x && String(x.k || "").toLowerCase().includes(k)); return r ? r.v : ""; };
  const ld = { "@context": "https://schema.org", "@type": "LocalBusiness", name: name || "Website", description: desc };
  if (canonical) ld.url = canonical;
  const img = heroImage(site); if (img) ld.image = img;
  const tel = rv("phone"); if (tel) ld.telephone = tel;
  const email = rv("email"); if (email) ld.email = email;
  const addr = rv("address") || rv("location"); if (addr) ld.address = { "@type": "PostalAddress", streetAddress: String(addr) };
  const areas = findSec(secs, "serviceareas").areas; if (Array.isArray(areas) && areas.length) ld.areaServed = areas;
  const hrs = findSec(secs, "hours").rows; if (Array.isArray(hrs) && hrs.length) ld.openingHours = hrs.map(r => Array.isArray(r) ? r.join(" ") : String(r)).filter(Boolean);
  return ld;
}

function pageHtml({ head, body }) {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">${head}</head><body>${body}</body></html>`;
}

function renderSite(site, canonical) {
  const name = (site.brand && site.brand.name) || "Website";
  const secs = site.sections || [];
  const hero = findSec(secs, "hero");
  const title = name + (hero.eyebrow ? " · " + hero.eyebrow : "");
  const desc = metaDescription(site);
  const img = heroImage(site);
  const head = [
    `<title>${esc(title)}</title>`,
    `<meta name="description" content="${esc(desc)}">`,
    canonical ? `<link rel="canonical" href="${esc(canonical)}">` : "",
    `<meta property="og:type" content="website">`,
    `<meta property="og:title" content="${esc(title)}">`,
    `<meta property="og:description" content="${esc(desc)}">`,
    canonical ? `<meta property="og:url" content="${esc(canonical)}">` : "",
    img ? `<meta property="og:image" content="${esc(img)}">` : "",
    `<meta name="twitter:card" content="${img ? "summary_large_image" : "summary"}">`,
    `<script type="application/ld+json">${JSON.stringify(localBusinessLd(site, canonical))}</script>`,
  ].join("");
  return pageHtml({ head, body: bodyContent(site) });
}

function renderPost(site, post, canonical) {
  const name = (site.brand && site.brand.name) || "";
  const title = post.title + (name ? " — " + name : "");
  const desc = String(post.excerpt || String(post.body || "").replace(/\s+/g, " ").slice(0, 200)).slice(0, 300);
  const ld = { "@context": "https://schema.org", "@type": "BlogPosting", headline: post.title, description: desc };
  if (post.date) ld.datePublished = post.date;
  if (name) ld.author = { "@type": "Organization", name };
  if (canonical) { ld.url = canonical; ld.mainEntityOfPage = canonical; }
  const paras = String(post.body || "").split(/\n\n+/).map(p => `<p>${esc(p)}</p>`).join("");
  const head = [
    `<title>${esc(title)}</title>`,
    `<meta name="description" content="${esc(desc)}">`,
    canonical ? `<link rel="canonical" href="${esc(canonical)}">` : "",
    `<meta property="og:type" content="article">`,
    `<meta property="og:title" content="${esc(post.title)}">`,
    `<meta property="og:description" content="${esc(desc)}">`,
    canonical ? `<meta property="og:url" content="${esc(canonical)}">` : "",
    `<meta name="twitter:card" content="summary">`,
    `<script type="application/ld+json">${JSON.stringify(ld)}</script>`,
  ].join("");
  const body = `${name ? `<p><strong>${esc(name)}</strong></p>` : ""}<article><h1>${esc(post.title)}</h1>${post.date ? `<p><time datetime="${esc(post.date)}">${esc(new Date(post.date).toDateString())}</time></p>` : ""}${paras}</article>`;
  return pageHtml({ head, body });
}

export default async function handler(req, res) {
  try {
    const slug = (req.query.slug || "").toString();
    const domain = (req.query.domain || "").toString();
    const postKey = (req.query.post || "").toString();
    if (!slug && !domain) { res.setHeader("Content-Type", "text/html"); return res.status(400).send("<!doctype html><title>Bad request</title>"); }

    const q = domain ? ("custom_domain=eq." + encodeURIComponent(domain)) : ("slug=eq." + encodeURIComponent(slug));
    const r = await fetch(SUPABASE_URL + "/rest/v1/websites?select=slug,data,theme,published&" + q + "&published=eq.true&limit=1", {
      headers: { apikey: SUPABASE_KEY, Authorization: "Bearer " + SUPABASE_KEY },
    });
    const rows = await r.json();
    res.setHeader("Content-Type", "text/html; charset=utf-8");
    if (!Array.isArray(rows) || !rows.length) {
      return res.status(404).send(pageHtml({ head: "<title>Site not found</title><meta name=\"robots\" content=\"noindex\">", body: "<h1>Site not found</h1>" }));
    }
    const site = (rows[0].data && typeof rows[0].data === "object") ? rows[0].data : {};
    if (!site.theme && rows[0].theme) site.theme = rows[0].theme;

    // canonical URL (best effort)
    const proto = (req.headers["x-forwarded-proto"] || "https");
    const host = (req.headers["x-forwarded-host"] || req.headers.host || "");
    const canonical = host ? (proto + "://" + host + (req.url || "").split("?")[0] + (postKey ? "?post=" + encodeURIComponent(postKey) : "")) : "";

    let html;
    if (postKey && Array.isArray(site.blog)) {
      const post = site.blog.find(p => String(p.slug) === postKey || String(p.id) === postKey);
      html = post ? renderPost(site, post, canonical) : renderSite(site, canonical);
    } else {
      html = renderSite(site, canonical);
    }
    res.setHeader("Cache-Control", "public, max-age=300, s-maxage=600, stale-while-revalidate=86400");
    return res.status(200).send(html);
  } catch (e) {
    res.setHeader("Content-Type", "text/html");
    // Fail open: return an empty valid doc so a crawler error never blocks anything.
    return res.status(200).send("<!doctype html><html><head><meta charset=\"utf-8\"></head><body></body></html>");
  }
}
