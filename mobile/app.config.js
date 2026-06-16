// Dynamic Expo config.
//
// All static settings live in app.json. This file injects the secrets that must
// NOT live in tracked source: the Android Google Maps key and the path to
// google-services.json (Firebase). Everything else is spread through unchanged —
// iOS is completely untouched.
//
// Maps key:
//   • Local builds:  mobile/.env.local → GOOGLE_MAPS_ANDROID_KEY=AIza...
//   • EAS builds:    eas env:create --name GOOGLE_MAPS_ANDROID_KEY \
//                      --value "AIza..." --visibility sensitive --environment preview
//
// google-services.json (gitignored — it contains a Firebase API key):
//   • Local builds:  the file sits at mobile/google-services.json and is used as-is.
//   • EAS builds:    upload it as a FILE env var so it's never in git —
//                      eas env:create --name GOOGLE_SERVICES_JSON --type file \
//                        --value ./google-services.json --visibility sensitive \
//                        --environment preview
//     EAS sets GOOGLE_SERVICES_JSON to the downloaded file's path at build time.
//   • If neither is present the build still succeeds (just without Firebase/push),
//     so a missing file never blocks a build.
//
// Note: on Android these keys are compiled into the app anyway, so their real
// protection is the Cloud key restriction (package + SHA-1) / Firebase rules,
// not secrecy. This just keeps them out of the repo / git history.

const fs = require('fs');
const path = require('path');

const localGoogleServices = path.join(__dirname, 'google-services.json');
const googleServicesFile =
  process.env.GOOGLE_SERVICES_JSON ||
  (fs.existsSync(localGoogleServices) ? './google-services.json' : undefined);

module.exports = ({ config }) => ({
  ...config,
  android: {
    ...config.android,
    ...(googleServicesFile ? { googleServicesFile } : {}),
    config: {
      ...(config.android && config.android.config),
      googleMaps: {
        apiKey: process.env.GOOGLE_MAPS_ANDROID_KEY,
      },
    },
  },
});
