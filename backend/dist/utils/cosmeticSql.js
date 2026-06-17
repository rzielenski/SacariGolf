"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.equippedVisualSql = equippedVisualSql;
/**
 * Shared SELECT fragment exposing a user's equipped cosmetics as one
 * JSONB object, resolved to the renderable visual_data blobs:
 *
 *   { border: {...}|null, background: {...}|null,
 *     username: {...}|null, ball_trail: {...}|null }
 *
 * `alias` is the users-table alias in the calling query. Every public
 * identity surface (feed, leaderboard, chat, profiles, cup) selects this
 * so the mobile app can render the owner's cosmetics anywhere their name
 * or avatar appears. Each lookup is a primary-key fetch on the small
 * cosmetics catalog table; four scalar subqueries per row is cheap even
 * on 100-row lists.
 *
 * fx is intentionally excluded: it drives celebration overlays, not
 * identity rendering, and the /me payload already carries it.
 */
function equippedVisualSql(alias) {
    return `jsonb_build_object(
    'border',     (SELECT visual_data FROM cosmetics WHERE cosmetic_id = ${alias}.equipped_border),
    'background', (SELECT visual_data FROM cosmetics WHERE cosmetic_id = ${alias}.equipped_background),
    'username',   (SELECT visual_data FROM cosmetics WHERE cosmetic_id = ${alias}.equipped_username),
    'ball_trail', (SELECT visual_data FROM cosmetics WHERE cosmetic_id = ${alias}.equipped_ball_trail)
  )`;
}
