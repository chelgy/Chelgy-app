// middleware.js  (project root, next to package.json)
// Bots-only dynamic rendering: search + social crawlers requesting a PUBLIC
// member site get routed to /api/prerender (fully-rendered HTML). Real visitors
// are never touched — they always get the normal app. Deleting this file fully
// reverts to current behavior.
//
// Requires: npm i @vercel/edge
import { next, rewrite } from "@vercel/edge";

export const config = {
  // Run on everything EXCEPT api routes, static assets, and files with an extension.
  matcher: "/((?!api/|assets/|_next/|favicon|robots\\.txt|sitemap|.*\\.[a-zA-Z0-9]+$).*)",
};

const BOT = /googlebot|bingbot|yandex|duckduckbot|baiduspider|facebookexternalhit|twitterbot|linkedinbot|slackbot|whatsapp|telegrambot|discordbot|applebot|petalbot|pinterest|semrushbot|ahrefsbot|embedly|redditbot|rogerbot|screaming|bytespider|google-inspectiontool|chrome-lighthouse/i;

export default function middleware(req) {
  const ua = req.headers.get("user-agent") || "";
  if (!BOT.test(ua)) return next(); // real visitors → untouched app

  const url = new URL(req.url);
  const host = (req.headers.get("host") || "").toLowerCase();
  const isAppHost =
    host.endsWith("chelgy.app") || host.endsWith("chelgy.com") ||
    host.endsWith(".vercel.app") || host.startsWith("localhost") || host.startsWith("127.");

  const target = new URL("/api/prerender", url.origin);
  const siteParam = url.searchParams.get("site");

  if (!isAppHost) {
    // A custom domain → always a published member site
    target.searchParams.set("domain", host);
  } else if (siteParam) {
    // chelgy.app/?site=slug → a member site previewed on our domain
    target.searchParams.set("slug", siteParam);
  } else {
    // chelgy.app app pages (home, tools, /privacy, etc.) → leave alone
    return next();
  }

  // Carry the blog post identifier through, from ?post= or a /blog/<slug> path
  const postParam = url.searchParams.get("post");
  if (postParam) target.searchParams.set("post", postParam);
  const m = url.pathname.match(/\/blog\/([^\/?#]+)/i);
  if (m) target.searchParams.set("post", decodeURIComponent(m[1]));

  return rewrite(target);
}
