/**
 * RevenueCat client wrapper.
 *
 * Uses `react-native-purchases` when installed, falls back to `unavailable`
 * status when the dep isn't present so the rest of the app keeps building.
 *
 * Setup checklist (one-time):
 *   1. `npm install react-native-purchases` in mobile/
 *   2. Create a RevenueCat project (https://app.revenuecat.com), connect
 *      App Store Connect (and Google Play Console).
 *   3. Create products matching the catalog plan IDs in
 *      backend/src/routes/premium.ts (monthly / yearly / lifetime). Their
 *      productIds should ideally CONTAIN the words "monthly", "yearly",
 *      or "lifetime" so the webhook plan-mapper picks them up.
 *   4. Set the entitlement identifier to "premium" so the SDK's
 *      `customerInfo.entitlements.active.premium` check works below.
 *   5. Add your RevenueCat API key to mobile/app.json under
 *      `expo.extra.revenueCatPublicKey`.
 *   6. Configure the webhook in RC dashboard:
 *        URL:    https://YOUR_API/premium/revenuecat-webhook
 *        Header: Authorization: Bearer <REVENUECAT_WEBHOOK_SECRET>
 *      Set `REVENUECAT_WEBHOOK_SECRET` in your Railway env.
 *
 * Runtime contract:
 *   • `init(userId)` — call ONCE after the user logs in (and again whenever
 *     a different user logs in). Sets the RC App User ID so webhooks tie
 *     back to your DB user_id.
 *   • `getOfferings()` — pulls the products configured in RC.
 *   • `purchasePackage(pkg)` — kicks off the native purchase sheet. Resolves
 *     with the new entitlement state.
 *   • `restorePurchases()` — re-grants on a fresh install / new device.
 *
 * The fallback (`status === 'unavailable'`) returns helpful errors so the
 * upgrade screen can render a "Use a promo code instead" message until the
 * native module is wired up.
 */

import Constants from 'expo-constants';

let Purchases: any = null;
let purchasesError: Error | null = null;
try {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  Purchases = require('react-native-purchases').default;
} catch (e) {
  purchasesError = e instanceof Error ? e : new Error('react-native-purchases not installed');
}

export type PurchaseStatus = 'available' | 'unavailable';

export function purchaseStatus(): PurchaseStatus {
  return Purchases ? 'available' : 'unavailable';
}

let initialized = false;
let initializedFor: string | null = null;

/**
 * Configure the SDK and identify the current user. Idempotent — safe to
 * call from a useEffect that re-runs on user changes.
 */
export async function init(userId: string): Promise<void> {
  if (!Purchases) return;
  const apiKey = (Constants.expoConfig?.extra as any)?.revenueCatPublicKey;
  if (!apiKey) {
    purchasesError = new Error('Missing expo.extra.revenueCatPublicKey in app.json');
    return;
  }
  if (!initialized) {
    Purchases.configure({ apiKey });
    initialized = true;
  }
  if (initializedFor !== userId) {
    try { await Purchases.logIn(userId); } catch { /* swallow */ }
    initializedFor = userId;
  }
}

/** Fetch the current offerings (products + entitlements) from RevenueCat. */
export async function getOfferings(): Promise<any | null> {
  if (!Purchases) return null;
  try { return await Purchases.getOfferings(); }
  catch { return null; }
}

/**
 * Trigger the native purchase sheet for a package returned by getOfferings.
 * Returns whether the user is now considered premium.
 */
export async function purchasePackage(pkg: any): Promise<{ ok: boolean; entitled: boolean; error?: string }> {
  if (!Purchases) return { ok: false, entitled: false, error: 'In-app purchases unavailable. Use a promo code or try a newer build.' };
  try {
    const { customerInfo } = await Purchases.purchasePackage(pkg);
    return { ok: true, entitled: !!customerInfo?.entitlements?.active?.premium };
  } catch (e: any) {
    if (e?.userCancelled) return { ok: false, entitled: false, error: 'Cancelled' };
    return { ok: false, entitled: false, error: e?.message ?? 'Purchase failed' };
  }
}

/** Replay platform purchases — e.g. after reinstall. */
export async function restorePurchases(): Promise<{ entitled: boolean; error?: string }> {
  if (!Purchases) return { entitled: false, error: 'In-app purchases unavailable.' };
  try {
    const customerInfo = await Purchases.restorePurchases();
    return { entitled: !!customerInfo?.entitlements?.active?.premium };
  } catch (e: any) {
    return { entitled: false, error: e?.message ?? 'Restore failed' };
  }
}

export function purchasesUnavailableReason(): string | null {
  return purchasesError?.message ?? null;
}
