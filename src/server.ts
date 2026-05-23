import 'dotenv/config';
import express from 'express';

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

const port = Number(process.env.PORT) || DEFAULT_PORT;

app.listen(port);
