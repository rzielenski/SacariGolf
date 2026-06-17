"use strict";
/**
 * Expo push sender.
 *
 * Guarantees:
 *   • NEVER throws — message sends must not fail because a push didn't.
 *   • Chunks to Expo's 100-message-per-request limit (big clans).
 *   • Reads the per-message tickets in the response and prunes tokens that
 *     Expo reports as DeviceNotRegistered (user uninstalled / token rotated),
 *     so dead tokens stop slowing down every later send.
 */
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.sendPush = sendPush;
const pool_1 = __importDefault(require("../db/pool"));
const EXPO_PUSH_URL = 'https://exp.host/--/api/v2/push/send';
const CHUNK_SIZE = 100;
async function pruneDeadToken(token) {
    try {
        await pool_1.default.query(`UPDATE users SET push_token = NULL WHERE push_token = $1`, [token]);
    }
    catch { /* pruning is best-effort */ }
}
async function sendPush(tokens, title, body, data) {
    const valid = tokens.filter((t) => t && t.startsWith('ExponentPushToken'));
    if (!valid.length)
        return;
    for (let i = 0; i < valid.length; i += CHUNK_SIZE) {
        const chunk = valid.slice(i, i + CHUNK_SIZE);
        const messages = chunk.map((to) => ({ to, title, body, data: data ?? {}, sound: 'default' }));
        try {
            const res = await fetch(EXPO_PUSH_URL, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
                body: JSON.stringify(messages),
            });
            if (!res.ok) {
                console.warn(`sendPush: Expo responded ${res.status}`);
                continue;
            }
            // Tickets come back in request order. An "error" ticket with
            // DeviceNotRegistered means the token is permanently dead — null it
            // out so we stop paying for it on every send.
            const json = await res.json().catch(() => null);
            const tickets = Array.isArray(json?.data) ? json.data : [];
            for (let t = 0; t < tickets.length; t++) {
                const ticket = tickets[t];
                if (ticket?.status === 'error') {
                    const detail = ticket?.details?.error;
                    if (detail === 'DeviceNotRegistered' && chunk[t]) {
                        await pruneDeadToken(chunk[t]);
                    }
                    else {
                        console.warn(`sendPush: ticket error ${detail ?? ticket?.message ?? 'unknown'}`);
                    }
                }
            }
        }
        catch (err) {
            // Push failures are non-fatal — don't propagate, but leave a trace so
            // "notifications stopped working" is diagnosable from Railway logs.
            console.warn('sendPush: request failed', err instanceof Error ? err.message : err);
        }
    }
}
