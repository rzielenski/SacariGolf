import 'dotenv/config';
import express from 'express';
import cors from 'cors';
import path from 'path';

import authRouter from './routes/auth';
import usersRouter from './routes/users';
import coursesRouter from './routes/courses';
import matchesRouter from './routes/matches';
import clansRouter from './routes/clans';
import findsRouter from './routes/finds';
import messagesRouter from './routes/messages';
import invitesRouter from './routes/invites';
import dmRouter from './routes/dm';
import roundsRouter from './routes/rounds';

const app = express();
app.use(cors());
app.use(express.json({ limit: '8mb' }));

// Serve uploaded find photos and avatars (path overridable via UPLOADS_DIR env var)
const UPLOADS_DIR = process.env.UPLOADS_DIR || '/app/uploads';
app.use('/uploads', express.static(UPLOADS_DIR));

app.get('/health', (_req, res) => res.json({ status: 'ok' }));

app.use('/auth', authRouter);
app.use('/users', usersRouter);
app.use('/courses', coursesRouter);
app.use('/matches', matchesRouter);
app.use('/clans', clansRouter);
app.use('/finds', findsRouter);
app.use('/messages', messagesRouter);
app.use('/invites', invitesRouter);
app.use('/dm', dmRouter);
app.use('/rounds', roundsRouter);

// Catch unhandled errors so the server doesn't crash
app.use((err: any, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
  console.error('Unhandled error:', err);
  res.status(500).json({ error: 'Server error' });
});

process.on('unhandledRejection', (reason) => {
  console.error('Unhandled rejection:', reason);
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Sacari Golf API running on :${PORT}`));
