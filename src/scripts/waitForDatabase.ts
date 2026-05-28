// Waits for Postgres to accept connections (Railway internal DNS / cold start).
// Run after validateEnv.js, before migrate deploy or cronTick.

import 'dotenv/config';
import pg from 'pg';

const MAX_ATTEMPTS = 30;
const RETRY_MS = 2_000;

const url = process.env.DATABASE_URL?.trim() ?? '';

const sleep = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));

for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt += 1) {
  const client = new pg.Client({ connectionString: url });
  try {
    await client.connect();
    await client.query('SELECT 1');
    console.error(`[ssa] Postgres ready (attempt ${attempt}/${MAX_ATTEMPTS})`);
    await client.end();
    break;
  } catch (err) {
    await client.end().catch(() => undefined);
    if (attempt === MAX_ATTEMPTS) {
      const message = err instanceof Error ? err.message : String(err);
      console.error(`[ssa] FATAL: Postgres not reachable after ${MAX_ATTEMPTS} attempts: ${message}`);
      throw err;
    }
    console.error(`[ssa] Postgres not ready (attempt ${attempt}/${MAX_ATTEMPTS}), retrying…`);
    await sleep(RETRY_MS);
  }
}
