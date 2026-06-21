/**
 * Mapbox config for the 3D course view (Phase 1).
 *
 * SECURITY: the token VALUE is never stored in committed source. It lives only
 * in `mobile/.env` (gitignored) for local dev, and in an EAS environment
 * variable named `EXPO_PUBLIC_MAPBOX_TOKEN` for cloud builds. Expo inlines
 * `EXPO_PUBLIC_*` vars at build time, so this reads it at runtime. A `pk.`
 * token is a public client token (it ships in any client app and can't be
 * fully hidden); the real protections are: (1) keep it out of the repo [here],
 * (2) a Mapbox usage cap + alert so abuse can't bill you, (3) rotate if leaked.
 */
export const MAPBOX_TOKEN: string = process.env.EXPO_PUBLIC_MAPBOX_TOKEN ?? '';

/** True when a token is configured, so callers can fall back to the 2D map. */
export const HAS_MAPBOX: boolean = MAPBOX_TOKEN.length > 0;

/** Satellite + streets base with 3D terrain support. */
export const MAPBOX_STYLE = 'mapbox://styles/mapbox/satellite-streets-v12';

/**
 * Origin that serves the 3D map page (web/ → GET /embed/hole-3d). The WebView
 * loads this over https so Mapbox GL JS gets a real origin and its workers run
 * (an inline HTML string has no origin and the map hangs). Must be a deployed
 * host reachable from the device, your production web app.
 */
export const MAPBOX_EMBED_URL = 'https://sacarigolf.com';
