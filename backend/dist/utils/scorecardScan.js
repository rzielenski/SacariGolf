"use strict";
// Scorecard OCR via Claude's vision API. Given a base64 photo of a paper
// scorecard, we ask Claude to read every tee column and return structured
// JSON (tee sets + per-hole par / handicap / yardage) that the in-app course
// builder can drop straight into its form — so a player can add a course by
// snapping one photo instead of typing ~90 numbers by hand.
//
// Mirrors utils/email.ts: no SDK, just fetch + an env key, with a dev
// fallback that fails cleanly (and loudly) when the key isn't configured.
//
// Configure on Railway with:
//   ANTHROPIC_API_KEY=sk-ant-...
//   SCORECARD_MODEL=claude-opus-4-8     ← optional; defaults to Opus 4.8.
//                                         Set to claude-sonnet-4-6 for a
//                                         faster / cheaper OCR pass.
//
// The image never touches our disk — it's relayed straight to Anthropic and
// only the parsed numbers come back. We do NOT store the photo.
Object.defineProperty(exports, "__esModule", { value: true });
exports.ScorecardScanError = void 0;
exports.scanScorecard = scanScorecard;
const ANTHROPIC_URL = 'https://api.anthropic.com/v1/messages';
const ANTHROPIC_VERSION = '2023-06-01';
const DEFAULT_MODEL = 'claude-opus-4-8';
/** Raised when scanning can't be done or the photo wasn't readable. The
 *  route turns these into clean 4xx/503 responses so the app can fall back
 *  to manual entry with a helpful message. */
class ScorecardScanError extends Error {
    constructor(message, status = 422) {
        super(message);
        this.name = 'ScorecardScanError';
        this.status = status;
    }
}
exports.ScorecardScanError = ScorecardScanError;
// The tool Claude is forced to call. Keeping the schema flat + lenient (most
// fields optional) means a partially-legible card still returns whatever was
// readable instead of the model balking on a missing value.
const SUBMIT_TOOL = {
    name: 'submit_scorecard',
    description: 'Return the golf course details transcribed from the scorecard photo. ' +
        'Include one entry in teeSets per tee/color column on the card.',
    input_schema: {
        type: 'object',
        properties: {
            readable: {
                type: 'boolean',
                description: 'False if the image is not a golf scorecard or is too blurry to read.',
            },
            courseName: { type: 'string', description: 'Course / club name printed on the card, if visible.' },
            city: { type: 'string', description: 'City, if printed.' },
            state: { type: 'string', description: 'State / region abbreviation, if printed.' },
            numHoles: { type: 'integer', enum: [9, 18], description: 'Total holes on this card.' },
            teeSets: {
                type: 'array',
                description: 'One per tee column (e.g. Black, Blue, White, Gold, Red).',
                items: {
                    type: 'object',
                    properties: {
                        name: { type: 'string', description: 'Tee name or color, e.g. "Blue" or "Championship".' },
                        gender: { type: 'string', enum: ['male', 'female'], description: 'Tee gender if indicated (ladies/red often female); otherwise male.' },
                        courseRating: { type: 'number', description: 'USGA course rating for this tee, e.g. 71.4.' },
                        slopeRating: { type: 'integer', description: 'USGA slope rating for this tee, e.g. 129.' },
                        holes: {
                            type: 'array',
                            description: 'One per hole, in order. Omit a field you cannot read rather than guessing.',
                            items: {
                                type: 'object',
                                properties: {
                                    hole: { type: 'integer', description: 'Hole number (1-18).' },
                                    par: { type: 'integer', description: 'Par for the hole.' },
                                    handicap: { type: 'integer', description: 'Stroke index / handicap ranking (HCP), 1-18.' },
                                    yardage: { type: 'integer', description: 'Yardage from this tee.' },
                                },
                                required: ['hole'],
                                additionalProperties: false,
                            },
                        },
                    },
                    required: ['name', 'holes'],
                    additionalProperties: false,
                },
            },
        },
        required: ['readable', 'numHoles', 'teeSets'],
        additionalProperties: false,
    },
};
const SYSTEM_PROMPT = 'You are a meticulous transcriber of golf scorecards. You are given a photo ' +
    'of a paper scorecard. Read every tee (color) row/column and transcribe the ' +
    'per-hole par, handicap (stroke index, often labelled HCP or H/CP or S.I.), ' +
    'and yardage exactly as printed. Cards vary: tees may be rows or columns; ' +
    'OUT/IN/TOTAL columns are subtotals, not holes — ignore them. Par and ' +
    'handicap are usually shared across all tees; yardage differs per tee. ' +
    'Course rating/slope are often a small "RATING / SLOPE" line per tee. ' +
    'Never invent numbers: if a value is illegible, leave that field out. ' +
    'Always respond by calling the submit_scorecard tool.';
const clampInt = (v, lo, hi) => {
    const n = Number(v);
    if (!Number.isFinite(n))
        return null;
    const r = Math.round(n);
    return r >= lo && r <= hi ? r : null;
};
/**
 * Send the image to Claude and return a normalized, sanity-clamped result.
 * Throws ScorecardScanError for "can't scan" / "couldn't read" cases.
 */
async function scanScorecard(imageBase64, mediaType) {
    const apiKey = process.env.ANTHROPIC_API_KEY;
    if (!apiKey) {
        // No key reaching the running process — env var missing, misnamed, or set
        // on the wrong service / not redeployed. Logged so it's diagnosable from
        // the Railway logs; to the user it's just "feature unavailable".
        // eslint-disable-next-line no-console
        console.error('[scorecard] ANTHROPIC_API_KEY is not set in this process — cannot scan.');
        throw new ScorecardScanError('This feature is not available at this time.', 503);
    }
    const model = process.env.SCORECARD_MODEL || DEFAULT_MODEL;
    // Presence-only diagnostic (never logs the key itself): confirms the env var
    // is wired and which model we're calling, so a failure downstream is clearly
    // an Anthropic-side rejection rather than a missing key.
    // eslint-disable-next-line no-console
    console.log(`[scorecard] calling Anthropic (model=${model}, key set, length=${apiKey.length})`);
    let res;
    try {
        res = await fetch(ANTHROPIC_URL, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'x-api-key': apiKey,
                'anthropic-version': ANTHROPIC_VERSION,
            },
            body: JSON.stringify({
                model,
                max_tokens: 8000,
                system: SYSTEM_PROMPT,
                tools: [SUBMIT_TOOL],
                tool_choice: { type: 'tool', name: 'submit_scorecard' },
                messages: [
                    {
                        role: 'user',
                        content: [
                            {
                                type: 'image',
                                source: { type: 'base64', media_type: mediaType, data: imageBase64 },
                            },
                            {
                                type: 'text',
                                text: 'Transcribe this scorecard. Call submit_scorecard with every tee column you can read.',
                            },
                        ],
                    },
                ],
            }),
        });
    }
    catch (err) {
        // eslint-disable-next-line no-console
        console.error('[scorecard] fetch error', err?.message ?? err);
        throw new ScorecardScanError('Could not reach the scanning service. Try again.', 502);
    }
    if (!res.ok) {
        const errText = await res.text().catch(() => '');
        // eslint-disable-next-line no-console
        console.error('[scorecard] Anthropic error', res.status, errText.slice(0, 500));
        // Out of credits, billing problem, bad/revoked key, or quota exhausted:
        // the feature genuinely can't run until the account owner fixes billing,
        // so report it as unavailable (not "try again"). A 400 here is almost
        // always the "credit balance too low" error, since we control the request
        // shape; 401 = bad key, 403 = billing/permission, 429 = quota.
        if (res.status === 400 || res.status === 401 || res.status === 403 || res.status === 429) {
            throw new ScorecardScanError('This feature is not available at this time.', 503);
        }
        // Transient upstream error (5xx) — genuinely worth retrying later.
        throw new ScorecardScanError('Scorecard scanning is temporarily unavailable. Please try again.', 502);
    }
    const data = await res.json().catch(() => null);
    if (!data)
        throw new ScorecardScanError('The scanning service returned an unreadable response.', 502);
    if (data.stop_reason === 'refusal') {
        throw new ScorecardScanError('Could not process that image.', 422);
    }
    const toolUse = Array.isArray(data.content)
        ? data.content.find((b) => b?.type === 'tool_use' && b?.name === 'submit_scorecard')
        : null;
    if (!toolUse || typeof toolUse.input !== 'object') {
        throw new ScorecardScanError('Could not read a scorecard from that photo. Try a clearer, well-lit photo.', 422);
    }
    return normalize(toolUse.input);
}
/** Clamp + reshape the model's tool input into our normalized contract.
 *  Drops implausible values to null so a misread digit can't poison the
 *  builder form. */
function normalize(input) {
    const warnings = [];
    if (input.readable === false) {
        throw new ScorecardScanError('That photo did not look like a readable golf scorecard. Try again or enter it manually.', 422);
    }
    const numHoles = Number(input.numHoles) === 9 ? 9 : 18;
    const teeSetsIn = Array.isArray(input.teeSets) ? input.teeSets : [];
    if (teeSetsIn.length === 0) {
        throw new ScorecardScanError('No tee sets could be read from that photo. Try a clearer photo.', 422);
    }
    const teeboxes = teeSetsIn.slice(0, 6).map((tb, ti) => {
        const name = String(tb?.name ?? '').trim().slice(0, 60) || `Tee ${ti + 1}`;
        const gender = tb?.gender === 'female' ? 'female' : 'male';
        // Rating/slope only kept when inside the plausible window FOR THIS HOLE
        // COUNT — a 9-hole card is half-scale (rating ~27-42, slope ~40-90).
        const ratingN = Number(tb?.courseRating);
        const rMin = numHoles === 9 ? 27 : 55, rMax = numHoles === 9 ? 42 : 80;
        const courseRating = Number.isFinite(ratingN) && ratingN >= rMin && ratingN <= rMax
            ? Math.round(ratingN * 10) / 10 : null;
        const slopeRating = clampInt(tb?.slopeRating, numHoles === 9 ? 40 : 55, numHoles === 9 ? 90 : 155);
        const holesIn = Array.isArray(tb?.holes) ? tb.holes : [];
        const holes = [];
        for (const h of holesIn) {
            const hole_num = clampInt(h?.hole, 1, numHoles);
            if (hole_num == null)
                continue; // OUT/IN/TOTAL or garbage row
            holes.push({
                hole_num,
                par: clampInt(h?.par, 3, 6),
                yardage: clampInt(h?.yardage, 30, 1000),
                handicap: clampInt(h?.handicap, 1, numHoles),
            });
        }
        if (holes.length === 0)
            warnings.push(`No hole data was read for the "${name}" tee.`);
        return { name, gender, courseRating, slopeRating, holes };
    });
    const courseName = typeof input.courseName === 'string' && input.courseName.trim()
        ? input.courseName.trim().slice(0, 120) : null;
    const city = typeof input.city === 'string' && input.city.trim()
        ? input.city.trim().slice(0, 80) : null;
    const state = typeof input.state === 'string' && input.state.trim()
        ? input.state.trim().slice(0, 40) : null;
    warnings.push('Auto-filled from a photo — double-check every number before submitting.');
    return { courseName, city, state, numHoles, teeboxes, warnings };
}
