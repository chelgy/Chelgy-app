// ============================================================================
// src/iap.js  —  Chelgy In-App Purchase helper (Apple / RevenueCat)
// ----------------------------------------------------------------------------
// Native iOS/Mac only. On the web (chelgy.app) every function is a safe no-op,
// so the existing Stripe flow is untouched.
//
// NOTE: We import the RevenueCat plugin STATICALLY (below). A previous version
// used a dynamic import(), which Vite code-splits into a separate chunk that
// fails to load inside the native web view — causing purchase calls to hang.
// Static import bundles it into the main file and fixes that.
// ============================================================================

import { Capacitor } from '@capacitor/core';
import { Purchases } from '@revenuecat/purchases-capacitor';

// --- Your RevenueCat + Apple identifiers -----------------------------------

const RC_PUBLIC_APPLE_KEY = 'appl_QpCYvFZgdLXzoBswmOChxLBJHJh';

export const MEMBERSHIP_ENTITLEMENT = 'pro';
export const MEMBERSHIP_PRODUCT_ID = 'com.chelgy.app.membership.monthly';

export const PACK_CREDITS = {
  'com.chelgy.app.credits.starter': 33000,
  'com.chelgy.app.credits.creator': 70000,
  'com.chelgy.app.credits.pro':     150000,
  'com.chelgy.app.credits.studio':  400000,
  'com.chelgy.app.credits.agency2': 850000,
};

let _configured = false;

// True only inside the real native app (iOS now, Mac later). False on web.
export function iapAvailable() {
  try {
    return Capacitor.isNativePlatform();
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

// Call ONCE after the user is logged in. appUserId MUST be the Supabase user id
// so the webhook can map a purchase back to the correct account.
export async function initIAP(appUserId) {
  if (!iapAvailable()) return false;
  try {
    if (!_configured) {
      await Purchases.configure({ apiKey: RC_PUBLIC_APPLE_KEY, appUserID: appUserId || undefined });
      _configured = true;
    } else if (appUserId) {
      try { await Purchases.logIn({ appUserID: appUserId }); } catch (_) {}
    }
    return true;
  } catch (err) {
    console.warn('[IAP] initIAP failed:', err);
    return false;
  }
}

export async function identifyUser(appUserId) {
  if (!iapAvailable() || !appUserId) return;
  try {
    await Purchases.logIn({ appUserID: appUserId });
  } catch (err) {
    console.warn('[IAP] identifyUser failed:', err);
  }
}

// Makes sure configure() has run (safe to call repeatedly).
async function ensureConfigured(appUserId) {
  if (!_configured) {
    await Purchases.configure({ apiKey: RC_PUBLIC_APPLE_KEY, appUserID: appUserId || undefined });
    _configured = true;
  }
}

// Returns a clean, UI-friendly list of what's for sale, pulled live from Apple.
export async function getPackages() {
  if (!iapAvailable()) return [];
  try {
    await ensureConfigured();
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

export async function hasActiveMembership() {
  if (!iapAvailable()) return false;
  try {
    await ensureConfigured();
    const { customerInfo } = await Purchases.getCustomerInfo();
    const active = customerInfo && customerInfo.entitlements && customerInfo.entitlements.active;
    return !!(active && active[MEMBERSHIP_ENTITLEMENT]);
  } catch (err) {
    console.warn('[IAP] hasActiveMembership failed:', err);
    return false;
  }
}

// Trigger the native Apple purchase sheet for a given package (from getPackages).
export async function purchase(pkg) {
  if (!iapAvailable()) {
    return { success: false, cancelled: false, error: new Error('Not available on web') };
  }
  try {
    await ensureConfigured();
    const result = await Purchases.purchasePackage({ aPackage: pkg, packageToPurchase: pkg });
    const productId = (pkg && pkg.product && pkg.product.identifier) || result.productIdentifier;
    return { success: true, customerInfo: result.customerInfo, productId };
  } catch (err) {
    const cancelled = !!(err && (err.userCancelled || err.code === 'PURCHASE_CANCELLED'));
    if (!cancelled) console.warn('[IAP] purchase failed:', err);
    return { success: false, cancelled, error: cancelled ? undefined : err };
  }
}

export async function restore() {
  if (!iapAvailable()) return null;
  try {
    await ensureConfigured();
    const { customerInfo } = await Purchases.restorePurchases();
    return customerInfo;
  } catch (err) {
    console.warn('[IAP] restore failed:', err);
    return null;
  }
}
