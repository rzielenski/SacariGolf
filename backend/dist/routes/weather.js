"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
const express_1 = require("express");
const auth_1 = require("../middleware/auth");
const asyncHandler_1 = require("../utils/asyncHandler");
/**
 * Weather conditions for a course location. Powered by Open-Meteo
 * (https://open-meteo.com) — free, no API key, generous rate limits, and
 * returns the exact fields we need (temp, wind speed/direction, precip,
 * surface elevation).
 *
 * We expose a single endpoint that proxies + simplifies their response so
 * the mobile client doesn't have to know the upstream shape and so we can
 * swap providers later without an app release.
 *
 * Premium-only adjustment math runs on the client; this endpoint itself is
 * unauthenticated-required (just `requireAuth`) so free users still see
 * raw weather, but the auto-adjust UI is gated client-side.
 */
const router = (0, express_1.Router)();
const OPEN_METEO = 'https://api.open-meteo.com/v1/forecast';
const OPEN_METEO_ELEV = 'https://api.open-meteo.com/v1/elevation';
// USGS 3DEP — 1m resolution, ~1m vertical accuracy, US-only. Free, no key.
const USGS_EPQS = 'https://epqs.nationalmap.gov/v1/json';
const cache = new Map();
const CACHE_TTL_MS = 10 * 60 * 1000; // 10 minutes — weather doesn't change that fast
function cacheKey(lat, lng) {
    // Round to 0.01° (~1.1 km). Players within a single course collapse to one entry.
    return `${lat.toFixed(2)},${lng.toFixed(2)}`;
}
const elevCache = new Map();
const ELEV_TTL_MS = 30 * 24 * 60 * 60 * 1000; // 30 days
function elevKey(lat, lng) {
    return `${lat.toFixed(5)},${lng.toFixed(5)}`;
}
/** USGS 3DEP coverage box (CONUS + most of Alaska). Coarse but rejects
 *  obviously-non-US points before wasting an upstream request. */
function isLikelyUS(lat, lng) {
    return (lat >= 24 && lat <= 50 && lng >= -125 && lng <= -66)
        || (lat >= 51 && lat <= 72 && lng >= -180 && lng <= -130); // AK
}
router.get('/', auth_1.requireAuth, (0, asyncHandler_1.wrap)(async (req, res) => {
    const lat = parseFloat(String(req.query.lat ?? ''));
    const lng = parseFloat(String(req.query.lng ?? ''));
    if (!Number.isFinite(lat) || !Number.isFinite(lng) || Math.abs(lat) > 90 || Math.abs(lng) > 180) {
        return res.status(400).json({ error: 'lat and lng required' });
    }
    const key = cacheKey(lat, lng);
    const cached = cache.get(key);
    if (cached && Date.now() - cached.fetched_at < CACHE_TTL_MS) {
        return res.json({ ...cached.data, cached: true });
    }
    try {
        // Current-conditions fields. Imperial units to match the rest of the
        // app (yards, mph, °F).
        const url = `${OPEN_METEO}?latitude=${lat}&longitude=${lng}`
            + `&current=temperature_2m,relative_humidity_2m,precipitation,wind_speed_10m,wind_direction_10m`
            + `&temperature_unit=fahrenheit&wind_speed_unit=mph&precipitation_unit=inch`
            + `&timezone=auto`;
        const elevUrl = `${OPEN_METEO_ELEV}?latitude=${lat}&longitude=${lng}`;
        const [wResp, eResp] = await Promise.all([
            fetch(url),
            fetch(elevUrl),
        ]);
        if (!wResp.ok)
            throw new Error(`weather upstream ${wResp.status}`);
        const wData = await wResp.json();
        const eData = eResp.ok ? await eResp.json() : null;
        const cur = wData.current ?? {};
        const precipIn = cur.precipitation ?? 0;
        const rain = precipIn >= 0.1 ? 'heavy'
            : precipIn > 0 ? 'light'
                : 'none';
        const elevation_m = eData?.elevation?.[0] ?? null;
        const elevation_ft = elevation_m != null ? Math.round(elevation_m * 3.28084) : null;
        const data = {
            temperature_f: typeof cur.temperature_2m === 'number' ? Math.round(cur.temperature_2m) : null,
            humidity_pct: typeof cur.relative_humidity_2m === 'number' ? Math.round(cur.relative_humidity_2m) : null,
            wind_speed_mph: typeof cur.wind_speed_10m === 'number' ? Math.round(cur.wind_speed_10m) : null,
            // Open-Meteo wind_direction = direction the wind is COMING FROM (meteorological).
            wind_from_bearing: typeof cur.wind_direction_10m === 'number' ? Math.round(cur.wind_direction_10m) : null,
            precipitation_in: precipIn,
            rain,
            elevation_ft,
            // Pass the exact timestamp so the client can show staleness if needed.
            observed_at: cur.time ?? null,
            cached: false,
        };
        cache.set(key, { fetched_at: Date.now(), data });
        res.json(data);
    }
    catch (err) {
        console.error('GET /weather upstream failed:', err);
        res.status(502).json({ error: 'Weather provider unavailable' });
    }
}));
/**
 * High-precision elevation lookup for a single lat/lng. Used by the slope
 * adjustment on the scoring screen.
 *
 * Provider chain (best → worst):
 *   1. USGS 3DEP (US only, 1m resolution, ~1m vertical accuracy)
 *   2. Open-Meteo Copernicus DEM (worldwide, 30m resolution, ~3m accuracy)
 *
 * Aggressively cached at ~1m grid for 30 days — terrain doesn't change.
 */
router.get('/elevation', auth_1.requireAuth, (0, asyncHandler_1.wrap)(async (req, res) => {
    const lat = parseFloat(String(req.query.lat ?? ''));
    const lng = parseFloat(String(req.query.lng ?? ''));
    if (!Number.isFinite(lat) || !Number.isFinite(lng) || Math.abs(lat) > 90 || Math.abs(lng) > 180) {
        return res.status(400).json({ error: 'lat and lng required' });
    }
    const key = elevKey(lat, lng);
    const cached = elevCache.get(key);
    if (cached && Date.now() - cached.fetched_at < ELEV_TTL_MS) {
        return res.json({ ...cached.data, cached: true });
    }
    let elevation_m = null;
    let source = 'unknown';
    // Try USGS 3DEP first when in coverage. Fastest, most accurate option.
    if (isLikelyUS(lat, lng)) {
        try {
            const r = await fetch(`${USGS_EPQS}?x=${lng}&y=${lat}&units=Meters&wkid=4326&includeDate=false`);
            if (r.ok) {
                const d = await r.json();
                // EPQS returns { value: <elevation in meters> } — rejects with -1000000 for no data
                const v = typeof d?.value === 'number' ? d.value : Number(d?.value);
                if (Number.isFinite(v) && v > -500 && v < 9000) {
                    elevation_m = v;
                    source = 'usgs_3dep';
                }
            }
        }
        catch { /* fall through to global provider */ }
    }
    // Fallback: Open-Meteo's worldwide Copernicus DEM
    if (elevation_m == null) {
        try {
            const r = await fetch(`${OPEN_METEO_ELEV}?latitude=${lat}&longitude=${lng}`);
            if (r.ok) {
                const d = await r.json();
                const v = d?.elevation?.[0];
                if (typeof v === 'number' && v > -500 && v < 9000) {
                    elevation_m = v;
                    source = 'open_meteo_copernicus';
                }
            }
        }
        catch { /* */ }
    }
    if (elevation_m == null) {
        return res.status(502).json({ error: 'No elevation data available for this location' });
    }
    const data = { elevation_m, source };
    elevCache.set(key, { fetched_at: Date.now(), data });
    res.json({ ...data, cached: false });
}));
exports.default = router;
