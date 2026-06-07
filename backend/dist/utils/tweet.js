"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.isConfigured = isConfigured;
exports.pct = pct;
exports.signatureBaseString = signatureBaseString;
exports.computeSignature = computeSignature;
exports.postTweet = postTweet;
/**
 * Minimal X / Twitter API v2 client — posts a single text tweet using
 * OAuth 1.0a user-context auth (the only auth flow that can WRITE on behalf
 * of an account; app-only bearer tokens are read-only).
 *
 * Dependency-free on purpose: the OAuth 1.0a signature is built with Node's
 * `crypto`, keeping the same lean "plain fetch, best-effort, never blocks"
 * stance as utils/notify.ts.
 *
 * Configure via four env vars from the bot's X developer app
 * (full walkthrough in TWITTER_SETUP.md):
 *   TWITTER_API_KEY        — app API key            (OAuth consumer key)
 *   TWITTER_API_SECRET     — app API secret         (OAuth consumer secret)
 *   TWITTER_ACCESS_TOKEN   — the @account's token
 *   TWITTER_ACCESS_SECRET  — the @account's token secret
 *
 * When any are missing the module is inert: isConfigured() === false and
 * postTweet() resolves to null without throwing, so local dev and the rest
 * of the app run unaffected.
 */
const crypto_1 = __importDefault(require("crypto"));
function envCreds() {
    return {
        apiKey: process.env.TWITTER_API_KEY ?? '',
        apiSecret: process.env.TWITTER_API_SECRET ?? '',
        accessToken: process.env.TWITTER_ACCESS_TOKEN ?? '',
        accessSecret: process.env.TWITTER_ACCESS_SECRET ?? '',
    };
}
function isConfigured() {
    const c = envCreds();
    return !!(c.apiKey && c.apiSecret && c.accessToken && c.accessSecret);
}
/**
 * RFC 3986 percent-encoding. encodeURIComponent leaves !*'() unescaped, but
 * OAuth requires those encoded too — so we finish the job by hand. Getting
 * this exactly right is the whole ballgame for signature validity.
 */
function pct(value) {
    return encodeURIComponent(value).replace(/[!*'()]/g, (c) => '%' + c.charCodeAt(0).toString(16).toUpperCase());
}
/**
 * The OAuth 1.0a signature base string: METHOD & encoded-URL & encoded-and-
 * sorted-param-string. `params` must already include every oauth_* field
 * plus any signed request params (query params, or form-body fields on the
 * legacy v1.1 endpoints). Exported so the signature unit test can assert it
 * against Twitter's own worked example.
 */
function signatureBaseString(method, url, params) {
    const paramString = Object.keys(params)
        .map((k) => [pct(k), pct(params[k])])
        .sort((a, b) => a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : a[1] < b[1] ? -1 : a[1] > b[1] ? 1 : 0)
        .map(([k, v]) => `${k}=${v}`)
        .join('&');
    return `${method.toUpperCase()}&${pct(url)}&${pct(paramString)}`;
}
/** HMAC-SHA1 signature (base64) over the base string with the OAuth signing
 *  key = encoded(consumerSecret) & encoded(tokenSecret). */
function computeSignature(method, url, params, consumerSecret, tokenSecret) {
    const base = signatureBaseString(method, url, params);
    const signingKey = `${pct(consumerSecret)}&${pct(tokenSecret)}`;
    return crypto_1.default.createHmac('sha1', signingKey).update(base).digest('base64');
}
/**
 * Build the `Authorization: OAuth …` header value. `extraParams` are request
 * params that must participate in the signature; for the v2 JSON endpoint the
 * body is NOT signed, so callers pass `{}`. nonce/timestamp are injectable for
 * deterministic testing; production uses fresh random/clock values.
 */
function oauthHeader(creds, method, url, extraParams = {}, nonce = crypto_1.default.randomBytes(32).toString('hex'), timestamp = Math.floor(Date.now() / 1000).toString()) {
    const oauth = {
        oauth_consumer_key: creds.apiKey,
        oauth_nonce: nonce,
        oauth_signature_method: 'HMAC-SHA1',
        oauth_timestamp: timestamp,
        oauth_token: creds.accessToken,
        oauth_version: '1.0',
    };
    const signature = computeSignature(method, url, { ...oauth, ...extraParams }, creds.apiSecret, creds.accessSecret);
    // Only oauth_* fields (plus the signature) go in the header — never the
    // request body/query params.
    const headerParams = { ...oauth, oauth_signature: signature };
    return ('OAuth ' +
        Object.keys(headerParams)
            .sort()
            .map((k) => `${pct(k)}="${pct(headerParams[k])}"`)
            .join(', '));
}
/**
 * Post a tweet. Returns the new tweet id on success, or null on any failure
 * (not configured, network error, API rejection) — posting is best-effort and
 * must never break the surrounding flow.
 */
async function postTweet(text) {
    const creds = envCreds();
    if (!(creds.apiKey && creds.apiSecret && creds.accessToken && creds.accessSecret)) {
        return null;
    }
    const url = 'https://api.twitter.com/2/tweets';
    const body = text.slice(0, 280); // X hard cap; digests are built well under this
    try {
        const res = await fetch(url, {
            method: 'POST',
            headers: {
                Authorization: oauthHeader(creds, 'POST', url),
                'Content-Type': 'application/json',
            },
            body: JSON.stringify({ text: body }),
        });
        if (!res.ok) {
            const detail = await res.text().catch(() => '');
            console.error(`[tweet] X API ${res.status}: ${detail.slice(0, 300)}`);
            return null;
        }
        const json = await res.json().catch(() => null);
        return json?.data?.id ?? null;
    }
    catch (err) {
        console.error('[tweet] post failed:', err);
        return null;
    }
}
