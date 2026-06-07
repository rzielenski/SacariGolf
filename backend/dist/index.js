"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
require("dotenv/config");
const express_1 = __importDefault(require("express"));
const cors_1 = __importDefault(require("cors"));
const auth_1 = __importDefault(require("./routes/auth"));
const users_1 = __importDefault(require("./routes/users"));
const courses_1 = __importDefault(require("./routes/courses"));
const matches_1 = __importDefault(require("./routes/matches"));
const clans_1 = __importDefault(require("./routes/clans"));
const finds_1 = __importDefault(require("./routes/finds"));
const messages_1 = __importDefault(require("./routes/messages"));
const invites_1 = __importDefault(require("./routes/invites"));
const dm_1 = __importDefault(require("./routes/dm"));
const rounds_1 = __importDefault(require("./routes/rounds"));
const premium_1 = __importDefault(require("./routes/premium"));
const weather_1 = __importDefault(require("./routes/weather"));
const tournaments_1 = __importDefault(require("./routes/tournaments"));
const posts_1 = __importDefault(require("./routes/posts"));
const seasons_1 = __importDefault(require("./routes/seasons"));
const balls_1 = __importDefault(require("./routes/balls"));
const migrate_1 = require("./db/migrate");
const cleanup_1 = require("./utils/cleanup");
const twitterDigest_1 = require("./utils/twitterDigest");
const app = (0, express_1.default)();
app.use((0, cors_1.default)());
app.use(express_1.default.json({ limit: '8mb' }));
// Serve uploaded find photos and avatars (path overridable via UPLOADS_DIR env var)
const UPLOADS_DIR = process.env.UPLOADS_DIR || '/app/uploads';
app.use('/uploads', express_1.default.static(UPLOADS_DIR));
app.get('/health', (_req, res) => res.json({ status: 'ok' }));
app.use('/auth', auth_1.default);
app.use('/users', users_1.default);
app.use('/courses', courses_1.default);
app.use('/matches', matches_1.default);
app.use('/clans', clans_1.default);
app.use('/finds', finds_1.default);
app.use('/messages', messages_1.default);
app.use('/invites', invites_1.default);
app.use('/dm', dm_1.default);
app.use('/rounds', rounds_1.default);
app.use('/premium', premium_1.default);
app.use('/weather', weather_1.default);
app.use('/tournaments', tournaments_1.default);
app.use('/posts', posts_1.default);
app.use('/seasons', seasons_1.default);
app.use('/balls', balls_1.default);
// Catch unhandled errors so the server doesn't crash
app.use((err, _req, res, _next) => {
    console.error('Unhandled error:', err);
    res.status(500).json({ error: 'Server error' });
});
process.on('unhandledRejection', (reason) => {
    console.error('Unhandled rejection:', reason);
});
const PORT = process.env.PORT || 3000;
(0, migrate_1.runMigrations)()
    .catch((e) => console.error('Migration runner crashed (continuing anyway):', e))
    .finally(() => {
    // Kick off the hourly cleanup that auto-cancels stale (>24h idle) rounds.
    // Runs immediately once on boot too, in case we slept through a window.
    (0, cleanup_1.startCleanupSchedule)();
    // Once-a-day @Sacari Twitter/X recap (no-op until TWITTER_* env is set).
    (0, twitterDigest_1.startTwitterDigestSchedule)();
    app.listen(PORT, () => console.log(`Sacari Golf API running on :${PORT}`));
});
