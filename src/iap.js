// ============================================================================
// src/iap.js  —  Chelgy In-App Purchase helper (Apple / RevenueCat)
// ----------------------------------------------------------------------------
// WHAT THIS IS:
//   A small, self-contained module that talks to Apple's In-App Purchase system
//   through RevenueCat. It ONLY does anything inside the native app (iOS, and
//   later the Mac app). On the web (chelgy.app), every function here is a safe
//   no-op, so your existing Stripe flow is completely untouched.
//
// HOW IT'S USED (wiring comes in the next step, inside App.jsx):
//   import * as IAP from './iap';
//   await IAP.initIAP(supabaseUserId);      // once, right after login
//   const packages = await IAP.getPackages(); // to build the paywall
//   await IAP.purchase(pkg);                 // when a buy button is tapped
//   await IAP.restore();                     // for the "Restore Purchases" button
//
// NOTHING in here grants credits or membership on its own. Purchases are
// verified server-side by the webhook (next files) so they can't be spoofed.
// ============================================================================

import { Capacitor } from '@capacitor/core';

// --- Your RevenueCat + Apple identifiers -----------------------------------

// Public SDK key from RevenueCat (safe to ship in app code — it's the PUBLIC key).
const RC_PUBLIC_APPLE_KEY = 'appl_QpCYvFZgdLXzoBswmOChxLBJHJh';

// The entitlement that means "paid member" (created in RevenueCat).
export const MEMBERSHIP_ENTITLEMENT = 'pro';

// The auto-renewable subscription product (the membership itself).
export const MEMBERSHIP_PRODUCT_ID = 'com.chelgy.app.membership.monthly';

// Consumable credit packs -> how many credits each one grants.
// (Used by the UI for labels; the actual credit grant happens server-side.)
export const PACK_CREDITS = {
  'com.chelgy.app.credits.starter': 33000,
  'com.chelgy.app.credits.creator': 70000,
  'com.chelgy.app.credits.pro':     150000,
  'com.chelgy.app.credits.studio':  400000,
  'com.chelgy.app.credits.agency2': 850000,
};

// ---------------------------------------------------------------------------
// Internal state
// ---------------------------------------------------------------------------

let _Purchases = null;   // the RevenueCat plugin, loaded lazily on native only
let _configured = false; // have we called configure() yet?

// True only inside the real native app (iOS now, Mac later). False on web.
export function iapAvailable() {
  try {
    return Capacitor.isNativePlatform();
  } catch {
    return false;
  }
}

// Lazily import the RevenueCat plugin. We do this INSIDE a native check so the
// web build never actually loads native code at runtime.
async function loadPlugin() {
  if (_Purchases) return _Purchases;
  const mod = await import('@revenuecat/purchases-capacitor');
  _Purchases = mod.Purchases;
  return _Purchases;
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

// Call ONCE after the user is logged in.
// IMPORTANT: appUserId MUST be the Supabase user id, so the webhook can map a
// purchase back to the correct account and grant credits/membership.
export async function initIAP(appUserId) {
  if (!iapAvailable()) return false;
  try {
    const Purchases = await loadPlugin();

    if (!_configured) {
      await Purchases.configure({
        apiKey: RC_PUBLIC_APPLE_KEY,
        appUserID: appUserId || undefined,
      });
      _configured = true;
    } else if (appUserId) {
      // Already configured earlier (e.g. before login) — align the id now.
      try { await Purchases.logIn({ appUserID: appUserId }); } catch (_) {}
    }
    return true;
  } catch (err) {
    console.warn('[IAP] initIAP failed:', err);
    return false;
  }
}

// If a user logs in AFTER init (or switches accounts), point RevenueCat at the
// right Supabase id.
export async function identifyUser(appUserId) {
  if (!iapAvailable() || !appUserId) return;
  try {
    const Purchases = await loadPlugin();
    await Purchases.logIn({ appUserID: appUserId });
  } catch (err) {
    console.warn('[IAP] identifyUser failed:', err);
  }
}

// Returns a clean, UI-friendly list of what's for sale, pulled live from Apple.
// Each item: { pkg, productId, title, priceString, isMembership, credits }
// `pkg` is the raw RevenueCat package object you pass back into purchase().
export async function getPackages() {
  if (!iapAvailable()) return [];
  try {
    const Purchases = await loadPlugin();
    const offerings = await Purchases.getOfferings();
    const current = offerings && offerings.current;
    const list = (current && current.availablePackages) || [];

    return list.map((pkg) => {
      const product = pkg.product || {};
      const productId = product.identifier;
      return {
        pkg,
        productId,
        title: product.title || productId,
        priceString: product.priceString || '',
        isMembership: productId === MEMBERSHIP_PRODUCT_ID,
        credits: PACK_CREDITS[productId] || 0,
      };
    });
  } catch (err) {
    console.warn('[IAP] getPackages failed:', err);
    return [];
  }
}

// Is the signed-in user currently an active paid member (per Apple/RevenueCat)?
export async function hasActiveMembership() {
  if (!iapAvailable()) return false;
  try {
    const Purchases = await loadPlugin();
    const { customerInfo } = await Purchases.getCustomerInfo();
    const active = customerInfo && customerInfo.entitlements && customerInfo.entitlements.active;
    return !!(active && active[MEMBERSHIP_ENTITLEMENT]);
  } catch (err) {
    console.warn('[IAP] hasActiveMembership failed:', err);
    return false;
  }
}

// Trigger the native Apple purchase sheet for a given package (from getPackages).
// Returns:
//   { success: true,  customerInfo, productId }           on success
//   { success: false, cancelled: true }                   if the user backed out
//   { success: false, cancelled: false, error }           on a real failure
export async function purchase(pkg) {
  if (!iapAvailable()) {
    return { success: false, cancelled: false, error: new Error('Not available on web') };
  }
  try {
    const Purchases = await loadPlugin();
    const result = await Purchases.purchasePackage({ packageToPurchase: pkg });
    const productId =
      (pkg && pkg.product && pkg.product.identifier) || result.productIdentifier;
    return { success: true, customerInfo: result.customerInfo, productId };
  } catch (err) {
    // RevenueCat marks user-cancellation on the error object.
    const cancelled = !!(err && (err.userCancelled || err.code === 'PURCHASE_CANCELLED'));
    if (!cancelled) console.warn('[IAP] purchase failed:', err);
    return { success: false, cancelled, error: cancelled ? undefined : err };
  }
}

// Apple REQUIRES a "Restore Purchases" button. This re-checks past purchases
// and returns the refreshed customerInfo (or null on web / failure).
export async function restore() {
  if (!iapAvailable()) return null;
  try {
    const Purchases = await loadPlugin();
    const { customerInfo } = await Purchases.restorePurchases();
    return customerInfo;
  } catch (err) {
    console.warn('[IAP] restore failed:', err);
    return null;
  }
}
