import { Router, Response } from 'express';
import { requireAuth, AuthRequest } from '../middleware/auth';
import { wrap } from '../utils/asyncHandler';

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

const router = Router();

const OPEN_METEO = 'https://api.open-meteo.com/v1/forecast';
const OPEN_METEO_ELEV = 'https://api.open-meteo.com/v1/elevation';

// Tiny in-memory cache so we don't hammer Open-Meteo when many players load
// the same course in quick succession. Keyed by quantized lat/lng.
type CacheEntry = { fetched_at: number; data: any };
const cache = new Map<string, CacheEntry>();
const CACHE_TTL_MS = 10 * 60 * 1000;  // 10 minutes — weather doesn't change that fast

function cacheKey(lat: number, lng: number) {
  // Round to 0.01° (~1.1 km). Players within a single course collapse to one entry.
  return `${lat.toFixed(2)},${lng.toFixed(2)}`;
}

router.get('/', requireAuth, wrap(async (req: AuthRequest, res: Response) => {
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
    if (!wResp.ok) throw new Error(`weather upstream ${wResp.status}`);
    const wData = await wResp.json() as any;
    const eData = eResp.ok ? await eResp.json() as any : null;

    const cur = wData.current ?? {};
    const precipIn = cur.precipitation ?? 0;
    const rain: 'none' | 'light' | 'heavy' =
      precipIn >= 0.1 ? 'heavy'
      : precipIn > 0  ? 'light'
      : 'none';

    const elevation_m = eData?.elevation?.[0] ?? null;
    const elevation_ft = elevation_m != null ? Math.round(elevation_m * 3.28084) : null;

    const data = {
      temperature_f:        typeof cur.temperature_2m === 'number'    ? Math.round(cur.temperature_2m) : null,
      humidity_pct:         typeof cur.relative_humidity_2m === 'number' ? Math.round(cur.relative_humidity_2m) : null,
      wind_speed_mph:       typeof cur.wind_speed_10m === 'number'    ? Math.round(cur.wind_speed_10m) : null,
      // Open-Meteo wind_direction = direction the wind is COMING FROM (meteorological).
      wind_from_bearing:    typeof cur.wind_direction_10m === 'number' ? Math.round(cur.wind_direction_10m) : null,
      precipitation_in:     precipIn,
      rain,
      elevation_ft,
      // Pass the exact timestamp so the client can show staleness if needed.
      observed_at:          cur.time ?? null,
      cached: false,
    };

    cache.set(key, { fetched_at: Date.now(), data });
    res.json(data);
  } catch (err) {
    console.error('GET /weather upstream failed:', err);
    res.status(502).json({ error: 'Weather provider unavailable' });
  }
}));

export default router;
