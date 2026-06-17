"use strict";
/**
 * Owner group helper. An "owner" (users.is_owner = true) is a staff/owner
 * account that dynamically owns every cosmetic, counts as premium, and can
 * broadcast an @everyone announcement post. Membership is managed straight
 * from the database:
 *   UPDATE users SET is_owner = true  WHERE LOWER(username) = 'someone';
 *   UPDATE users SET is_owner = false WHERE LOWER(username) = 'someone';
 *
 * Never throws — a lookup failure resolves to "not an owner" so a DB hiccup
 * can't accidentally hand out owner powers.
 */
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.isOwner = isOwner;
const pool_1 = __importDefault(require("../db/pool"));
async function isOwner(userId) {
    if (!userId)
        return false;
    try {
        const { rows } = await pool_1.default.query(`SELECT is_owner FROM users WHERE user_id = $1`, [userId]);
        return rows[0]?.is_owner === true;
    }
    catch {
        return false;
    }
}
