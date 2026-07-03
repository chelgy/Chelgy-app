// api/_shopify-populate.js — shared build-out logic.
//
// Underscore prefix means Vercel does NOT expose this as an endpoint; it's a helper
// imported by api/shopify-callback.js (auto-fires after a member connects) and
// api/shopify-build.js (admin manual retry). One catalog, one source of truth.

export const API_VERSION = "2026-07"; // pin the Admin API version; bump deliberately

// One GraphQL call to a specific store's Admin API.
export async function gql(shop, adminToken, query, variables) {
  const r = await fetch("https://" + shop + "/admin/api/" + API_VERSION + "/graphql.json", {
    method: "POST",
    headers: { "Content-Type": "application/json", "X-Shopify-Access-Token": adminToken },
    body: JSON.stringify({ query, variables })
  });
  const j = await r.json().catch(() => null);
  return { ok: r.ok, status: r.status, j };
}

// ── Starter catalog. Expand freely. Prices are decimal strings (Shopify wants that). ──
export const CATALOG = {
  clothes: [
    { title: "Oversized Everyday Tee", price: "29.99", type: "Apparel", desc: "Soft, heavyweight cotton tee with a relaxed drape. The one they'll reach for daily." },
    { title: "High-Rise Sculpt Leggings", price: "39.99", type: "Apparel", desc: "Squat-proof, buttery compression that holds everything in and moves with you." },
    { title: "Cropped Fleece Hoodie", price: "44.99", type: "Apparel", desc: "Cozy brushed fleece with a flattering cropped cut and roomy front pocket." },
  ],
  electronics: [
    { title: "Wireless Charging Stand 3-in-1", price: "49.99", type: "Gadgets", desc: "Charge phone, watch, and earbuds at once. Clean desk, one cable." },
    { title: "Noise-Isolating Earbuds Pro", price: "59.99", type: "Audio", desc: "Deep bass, 30-hour case, and a snug fit that stays put on every run." },
    { title: "Magnetic Car Mount Charger", price: "27.99", type: "Accessories", desc: "Snap, drive, charge. Strong hold, fast wireless power, one-hand mount." },
  ],
  home: [
    { title: "Aromatherapy Mist Diffuser", price: "34.99", type: "Home", desc: "Whisper-quiet ultrasonic mist with a warm glow. Turns any room into a calm one." },
    { title: "Cloud Memory-Foam Slippers", price: "24.99", type: "Home", desc: "Step onto a pillow. Plush foam that molds to your feet, all-day soft." },
    { title: "Rapid Stain-Lift Spray", price: "19.99", type: "Home", desc: "Lifts set-in stains in seconds. The bottle that lives on the counter." },
  ],
  pets: [
    { title: "Calming Donut Pet Bed", price: "42.99", type: "Pets", desc: "Ultra-soft raised rim your pet burrows into. Sleep they'll actually settle in." },
    { title: "Slow-Feeder Lick Mat", price: "16.99", type: "Pets", desc: "Turns mealtime into a calm, focused ten minutes. Vet-loved, dishwasher-safe." },
    { title: "No-Pull Padded Harness", price: "31.99", type: "Pets", desc: "Even pressure, easy on-off, zero choking. Walks get easy again." },
  ],
  sports: [
    { title: "Resistance Band Set (5-Piece)", price: "26.99", type: "Fitness", desc: "A full gym in a pouch. Five tensions for legs, glutes, arms, and travel days." },
    { title: "Insulated Sport Bottle 32oz", price: "22.99", type: "Fitness", desc: "Ice-cold for 24 hours, sweat-free grip, leak-proof lid built for the gym bag." },
    { title: "Adjustable Speed Jump Rope", price: "14.99", type: "Fitness", desc: "Weighted, tangle-free, cut-to-fit. The cardio tool that goes anywhere." },
  ],
};

export const PAGES = [
  { title: "About Us", body: "<p>We hand-pick products we believe in and stand behind every order. Questions? We're a message away.</p>" },
  { title: "Shipping Policy", body: "<p>Orders are processed within 1–2 business days. Delivery typically takes 7–15 business days. You'll get tracking as soon as it ships.</p>" },
  { title: "Refund Policy", body: "<p>Not in love with it? Reach out within 30 days for a replacement or refund.</p>" },
  { title: "Contact", body: "<p>Email us any time and we'll get back within 24 hours.</p>" },
];

async function createProduct(shop, token, p) {
  const query = `
    mutation ($input: ProductSetInput!) {
      productSet(input: $input, synchronous: true) {
        product { id }
        userErrors { field message }
      }
    }`;
  const input = {
    title: p.title,
    descriptionHtml: "<p>" + p.desc + "</p>",
    status: "ACTIVE",
    productType: p.type || "",
    productOptions: [{ name: "Title", values: [{ name: "Default Title" }] }],
    variants: [{ optionValues: [{ optionName: "Title", name: "Default Title" }], price: p.price }],
  };
  const { ok, j } = await gql(shop, token, query, { input });
  const errs = (j && j.data && j.data.productSet && j.data.productSet.userErrors) || [];
  if (!ok || errs.length) return { ok: false, error: (errs[0] && errs[0].message) || "product error" };
  return { ok: true };
}

async function createPage(shop, token, pg) {
  const query = `
    mutation ($page: PageCreateInput!) {
      pageCreate(page: $page) { page { id } userErrors { field message } }
    }`;
  const { ok, j } = await gql(shop, token, query, { page: { title: pg.title, body: pg.body } });
  const errs = (j && j.data && j.data.pageCreate && j.data.pageCreate.userErrors) || [];
  if (!ok || errs.length) return { ok: false, error: (errs[0] && errs[0].message) || "page error" };
  return { ok: true };
}

async function createCollection(shop, token, title) {
  const query = `
    mutation ($input: CollectionInput!) {
      collectionCreate(input: $input) { collection { id } userErrors { field message } }
    }`;
  const { ok, j } = await gql(shop, token, query, { input: { title } });
  const errs = (j && j.data && j.data.collectionCreate && j.data.collectionCreate.userErrors) || [];
  if (!ok || errs.length) return { ok: false, error: (errs[0] && errs[0].message) || "collection error" };
  return { ok: true };
}

// Build out the whole store. Returns { ok, failures[] }.
export async function populateStore(shop, adminToken, niche) {
  const items = CATALOG[niche] || CATALOG.clothes;
  const failures = [];

  const coll = await createCollection(shop, adminToken, "Best Sellers");
  if (!coll.ok) failures.push("collection: " + coll.error);

  for (const p of items) {
    const out = await createProduct(shop, adminToken, p);
    if (!out.ok) failures.push(p.title + ": " + out.error);
  }
  for (const pg of PAGES) {
    const out = await createPage(shop, adminToken, pg);
    if (!out.ok) failures.push(pg.title + ": " + out.error);
  }
  return { ok: failures.length === 0, failures };
}
