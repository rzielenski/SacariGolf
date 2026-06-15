# Android / Samsung build — setup checklist

The codebase is one Expo project that targets **both** platforms. iOS is unchanged;
everything below is Android-only and additive. You build/ship them separately:
`eas build -p ios` vs `eas build -p android`.

## Already done (in code/config)
- `app.json` → `android` block: package `com.sacari.app`, `versionCode`, adaptive icon,
  permissions (deduped), and a **placeholder Google Maps key slot**.
- `eas.json`: Android build types — `apk` for `development`/`preview` (easy sideload on a
  Samsung), `app-bundle` (AAB) for `production` (store upload).
- iOS keeps using **Apple Maps** (free, no key). The Google key below only affects Android.

## You do tomorrow

### 1. Google Maps API key (Android only)
1. Google Cloud Console → create/pick a project → enable **"Maps SDK for Android"**.
2. APIs & Services → Credentials → Create credentials → **API key**.
3. Restrict it: Application restriction = **Android apps**, add package `com.sacari.app`
   + your app's SHA-1 (get it after the first build: `eas credentials` → Android →
   keystore → it lists the SHA-1).
4. Paste the key into `app.json` here:
   ```
   "android": { "config": { "googleMaps": { "apiKey": "REPLACE_WITH_ANDROID_GOOGLE_MAPS_API_KEY" } } }
   ```
5. Attach a billing account to the Cloud project (required even though map display is
   free/unlimited). Set a **budget alert** + a **quota cap** as a safety net.

> Until the real key is in, an Android build runs fine but the satellite map renders
> blank. iOS is unaffected either way.

### 2. Google Play developer account
- One-time $25 at https://play.google.com/console. Then: app listing, content rating,
  data-safety form, privacy policy URL. (Samsung Galaxy Store is a separate, optional
  account — the same AAB works for both; it's just another submission form.)

### 3. Push notifications (FCM) — needed for Android pushes
1. Create a Firebase project, add an Android app with package `com.sacari.app`,
   download `google-services.json` into `mobile/`.
2. Add to `app.json`: `"android": { "googleServicesFile": "./google-services.json" }`.
3. Upload the FCM **v1 service-account key** to Expo: `eas credentials` → Android →
   "Google Service Account" → FCM. (Don't add `googleServicesFile` until the file
   exists, or the build will fail to resolve it.)

### 4. In-app purchases (RevenueCat → Google Play Billing)
- Your purchase code already supports both stores (`lib/purchases.ts`). In Play Console,
  create the same monthly/yearly/lifetime products, link them in RevenueCat, and confirm
  the `premium` entitlement. No app-code change needed.

## Build commands (after the key is in)
```
# one-time: log in + configure credentials (EAS generates the Android keystore)
eas login
eas credentials            # Android → let EAS create a keystore; note the SHA-1

# sideloadable APK to test on your Samsung
eas build -p android --profile preview

# store-ready AAB for Google Play / Galaxy Store
eas build -p android --profile production
```

## Test on a real Samsung (things to check)
- Satellite map renders (confirms the Maps key + SHA-1 restriction are right).
- Hardware **back button** behavior across screens.
- Edge-to-edge insets: status bar + bottom nav bar don't overlap content.
- `react-native-vision-camera` swing capture works (Android camera pipeline).
- Push notification actually delivers (FCM).
- Cosmetic VFX (flag, rings, gradient text) perform smoothly on the device GPU.

## Notes
- All native deps are Android-compatible: reanimated + worklets, react-native-svg,
  expo-linear-gradient, masked-view, react-native-maps, vision-camera, react-native-purchases.
- The backend (Railway) needs **zero** changes; it already serves both platforms.
- OTA updates work per-platform via the existing `eas update --channel <channel>`.
