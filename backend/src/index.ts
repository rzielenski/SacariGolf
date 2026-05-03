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

const app = express();
app.use(cors());
app.use(express.json({ limit: '8mb' }));

// Serve uploaded find photos
app.use('/uploads', express.static('/app/uploads'));

app.get('/health', (_req, res) => res.json({ status: 'ok' }));

app.use('/auth', authRouter);
app.use('/users', usersRouter);
app.use('/courses', coursesRouter);
app.use('/matches', matchesRouter);
app.use('/clans', clansRouter);
app.use('/finds', findsRouter);
app.use('/messages', messagesRouter);
app.use('/invites', invitesRouter);

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Clash of Clubs API running on :${PORT}`));
