"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.sendPush = sendPush;
// Send push notifications via Expo's push service
async function sendPush(tokens, title, body, data) {
    const valid = tokens.filter((t) => t && t.startsWith('ExponentPushToken'));
    if (!valid.length)
        return;
    const messages = valid.map((to) => ({ to, title, body, data: data ?? {}, sound: 'default' }));
    try {
        await fetch('https://exp.host/--/api/v2/push/send', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
            body: JSON.stringify(messages),
        });
    }
    catch {
        // Push failures are non-fatal — don't propagate
    }
}
