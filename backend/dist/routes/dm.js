"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
const express_1 = require("express");
const pool_1 = __importDefault(require("../db/pool"));
const auth_1 = require("../middleware/auth");
const notify_1 = require("../utils/notify");
const asyncHandler_1 = require("../utils/asyncHandler");
const messages_1 = require("./messages");
const router = (0, express_1.Router)();
router.use(auth_1.requireAuth);
async function areFriends(a, b) {
    const { rows } = await pool_1.default.query(`SELECT 1 FROM friends
     WHERE ((user_id = $1 AND friend_id = $2) OR (user_id = $2 AND friend_id = $1))
       AND status = 'accepted'`, [a, b]);
    return rows.length > 0;
}
// GET /dm/:userId — conversation with another user (must be friends)
router.get('/:userId', (0, asyncHandler_1.wrap)(async (req, res) => {
    const me = req.userId;
    const { userId } = req.params;
    if (me === userId)
        return res.status(400).json({ error: 'Cannot DM yourself' });
    if (!(await areFriends(me, userId))) {
        return res.status(403).json({ error: 'You can only DM friends' });
    }
    const { rows } = await pool_1.default.query(`SELECT dm.dm_id AS message_id, dm.created_at, dm.body,
            dm.from_user_id AS user_id, u.username
     FROM direct_messages dm
     JOIN users u ON u.user_id = dm.from_user_id
     WHERE (dm.from_user_id = $1 AND dm.to_user_id = $2)
        OR (dm.from_user_id = $2 AND dm.to_user_id = $1)
     ORDER BY dm.created_at ASC
     LIMIT 100`, [me, userId]);
    res.json(rows);
}));
// POST /dm/:userId — send a direct message (friends only, length-capped)
router.post('/:userId', (0, asyncHandler_1.wrap)(async (req, res) => {
    const me = req.userId;
    const { userId } = req.params;
    if (me === userId)
        return res.status(400).json({ error: 'Cannot DM yourself' });
    const text = typeof req.body?.body === 'string' ? req.body.body.trim().slice(0, 2000) : '';
    if (!text)
        return res.status(400).json({ error: 'body required' });
    if (!(await areFriends(me, userId))) {
        return res.status(403).json({ error: 'You can only DM friends' });
    }
    // Blocking doesn't remove the friends row — same gate as routes/messages.
    const blocks = await (0, messages_1.blockStateBetween)(me, userId);
    if (blocks.senderBlockedRecipient) {
        return res.status(403).json({ error: 'You blocked this user. Unblock them to send messages.' });
    }
    if (blocks.recipientBlockedSender) {
        return res.status(403).json({ error: 'You can only DM friends' });
    }
    const { rows } = await pool_1.default.query(`INSERT INTO direct_messages (from_user_id, to_user_id, body)
     VALUES ($1, $2, $3)
     RETURNING dm_id AS message_id, created_at, body, from_user_id AS user_id`, [me, userId, text]);
    const msg = rows[0];
    const sender = await pool_1.default.query('SELECT username FROM users WHERE user_id = $1', [me]);
    const recipient = await pool_1.default.query('SELECT push_token FROM users WHERE user_id = $1', [userId]);
    const senderName = sender.rows[0]?.username ?? 'Someone';
    const token = recipient.rows[0]?.push_token;
    if (token)
        await (0, notify_1.sendPush)([token], senderName, text, { type: 'dm', fromUserId: me });
    res.status(201).json({ ...msg, username: senderName });
}));
exports.default = router;
