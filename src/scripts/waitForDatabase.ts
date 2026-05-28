// Waits for Postgres — production uses railwayBootstrap.js.

import 'dotenv/config';
import pg from 'pg';
import { resolveDatabaseUrl } from '../shared/resolveDatabaseUrl.js';

const MAX_ATTEMPTS = 30;
const RETRY_MS = 2_000;
const label = process.env.RAILWAY_SERVICE_NAME ?? 'ssa';

const url = resolveDatabaseUrl(label);

const sleep = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));

for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt += 1) {
  const client = new pg.Client({ connectionString: url });
  try {
    await client.connect();
    await client.query('SELECT 1');
    console.error(`[${label}] Postgres ready (attempt ${attempt}/${MAX_ATTEMPTS})`);
    await client.end();
    break;
  } catch (err) {
    await client.end().catch(() => undefined);
    if (attempt === MAX_ATTEMPTS) {
      const message = err instanceof Error ? err.message : String(err);
      console.error(`[${label}] FATAL: Postgres not reachable after ${MAX_ATTEMPTS} attempts: ${message}`);
      throw err;
    }
    console.error(`[${label}] Postgres not ready (attempt ${attempt}/${MAX_ATTEMPTS}), retrying…`);
    await sleep(RETRY_MS);
  }
}
