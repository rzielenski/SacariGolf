# RevenueCat / IAP Setup

The codebase is wired for in-app purchases via **RevenueCat**, but no SDK
is installed yet and no products exist in App Store Connect / Google Play.
Until you finish the steps below, the app falls back to the **promo code**
redemption flow (the existing `f32dk4` lifetime founder code still works).

## Why RevenueCat?

It abstracts both Apple IAP and Google Play Billing behind one client SDK
and one webhook. You configure products once, get a unified server-side
receipt validator, and your client code is identical on iOS and Android.

Free tier: up to $10K/mo MTR. Plenty of headroom for closed beta + launch.

## One-time setup

### 1. Install the SDK

```bash
cd mobile
npm install react-native-purchases
```

After install, do a fresh native build (`eas build` or `npx expo prebuild`).
The SDK includes native code so an OTA update alone won't pick it up.

### 2. Create a RevenueCat project

1. Sign up at https://app.revenuecat.com
2. New project → "Sacari Golf"
3. Add your iOS app (App Store Connect Bundle ID: `com.sacarigolf.app`)
4. (Later) Add your Android app (`com.sacarigolf.app`)

### 3. Configure products in App Store Connect

Create three subscription / one-time products:

| App Store Product ID         | Sacari Plan ID | RC Entitlement |
|------------------------------|----------------|----------------|
| `com.sacarigolf.premium.monthly`  | monthly        | premium        |
| `com.sacarigolf.premium.yearly`   | yearly         | premium        |
| `com.sacarigolf.premium.lifetime` | lifetime       | premium        |

The product IDs need to **contain the words** `monthly`, `yearly`, or
`lifetime` so the webhook handler maps them to your `premium_plan` column
correctly.

In RevenueCat:
1. Products tab → "+ Add product" for each
2. Entitlements tab → create one called `premium`, attach all three products
3. Offerings tab → create a "default" offering with all three packages

### 4. Add the public API key to the app

`mobile/app.json`:

```json
{
  "expo": {
    "extra": {
      "eas": { "projectId": "..." },
      "revenueCatPublicKey": "appl_xxxxxxxxxxxxxxx"
    }
  }
}
```

(Use the iOS public key from RevenueCat → Project Settings → API Keys.
For Android, you'd add a separate key and switch on `Platform.OS` in
`mobile/lib/purchases.ts`.)

### 5. Configure the server webhook

In RevenueCat → Project Settings → Integrations → Webhooks:

- **URL**: `https://YOUR_RAILWAY_URL/premium/revenuecat-webhook`
- **Authorization header**: `Bearer <SHARED_SECRET>`

Then in Railway → Variables, set:

```
REVENUECAT_WEBHOOK_SECRET=<SHARED_SECRET>
```

Use a strong random string. RC will retry on non-2xx for up to 72h, so
brief downtime won't drop signals.

### 6. Test the loop

1. Build a sandbox version with `eas build --profile preview`
2. Install on a real device (sandbox IAP doesn't work in the simulator)
3. Sign in with a sandbox tester account in iOS Settings → App Store
4. Open the app → Profile → Premium → Upgrade Now
5. Complete the sandbox purchase
6. Within ~10 seconds, RC should hit your webhook and `is_premium` flips
7. The app's profile screen should immediately show "Premium until ..."

## What to ship today (no IAP installed)

The app already builds and runs without the SDK:
- The premium screen renders without an Upgrade button
- Promo-code redemption works (`f32dk4` = lifetime founder)
- Sensitive endpoints already check `is_premium` server-side

You can launch a paid feature waitlist with just promo codes. Ship IAP
when you're ready to take payments.

## Cancellation behavior

RevenueCat fires `CANCELLATION` the moment a user toggles auto-renew off,
even though they keep access until the period ends. Our webhook honors this
correctly — `premium_until` is set from the event, and `is_premium` only
flips false when that timestamp passes.

`/users/me` reads both fields and the client-side `isPremium()` helper in
`mobile/lib/premium.ts` short-circuits if `premium_until` is in the past,
so users can't keep premium UI after their access ends, even if the DB
hasn't been re-checked yet.
