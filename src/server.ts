import 'dotenv/config';
import express from 'express';
import { queueRouter } from './ui/queue.js';
import { prepBriefRouter } from './ui/prepBrief.js';
import { unsubscribeRouter } from './routes/unsubscribe.js';

const VERSION = '0.1.0';
const DEFAULT_PORT = 3000;

const app = express();

app.get('/health', (_req, res) => {
  res.json({
    ok: true,
    uptime: process.uptime(),
    version: VERSION,
  });
});

app.use('/', queueRouter);
app.use('/', prepBriefRouter);
app.use('/', unsubscribeRouter);

const port = Number(process.env.PORT) || DEFAULT_PORT;

app.listen(port);
