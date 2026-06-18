"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.ALLOWED_CLUBS_SHOT = exports.ALLOWED_CLUBS = void 0;
/**
 * Single source of truth for valid club codes, shared by the bag editor
 * (PATCH /users/me, clubs_in_bag) and shot tracking (PUT /matches/:id/shots).
 * Previously this set was copy-pasted in both routes, so adding a club meant
 * editing two places (and they could drift). Import from here instead.
 */
exports.ALLOWED_CLUBS = new Set([
    'driver', '3w', '5w', '7w', 'hybrid',
    '2i', '3i', '4i', '5i', '6i', '7i', '8i', '9i',
    'pw', 'gw', 'sw', 'lw', 'putter',
]);
/** Shot tracking additionally allows 'chip' — a tracked-but-not-attributed tag
 *  (a chip could be a 56°, 60°, or a hybrid bump, so /club-stats skips it). */
exports.ALLOWED_CLUBS_SHOT = new Set([...exports.ALLOWED_CLUBS, 'chip']);
