// Railway web/cron entry — resolve DATABASE_URL once, wait for Postgres,
// then run migrate/server or cronTick with the resolved URL in child env.

import 'dotenv/config';
import { spawnSync } from 'node:child_process';
import pg from 'pg';
import { logDatabaseUrlReady, resolveDatabaseUrl } from '../shared/resolveDatabaseUrl.js';

const MAX_ATTEMPTS = 30;
const RETRY_MS = 2_000;

const mode = process.argv[2];
const label = process.env.RAILWAY_SERVICE_NAME ?? 'ssa';

const fail = (err: unknown): never => {
  const message = err instanceof Error ? err.message : String(err);
  console.error(message);
  throw err instanceof Error ? err : new Error(message);
};

const sleep = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));

const waitForPostgres = async (url: string): Promise<void> => {
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt += 1) {
    const client = new pg.Client({ connectionString: url });
    try {
      await client.connect();
      await client.query('SELECT 1');
      console.error(`[${label}] Postgres ready (attempt ${attempt}/${MAX_ATTEMPTS})`);
      await client.end();
      return;
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
};

const run = (command: string, args: string[], env: NodeJS.ProcessEnv): void => {
  const result = spawnSync(command, args, { env, stdio: 'inherit' });
  if (result.status !== 0 && result.status !== null) {
    process.exitCode = result.status;
    throw new Error(`${command} ${args.join(' ')} exited ${result.status}`);
  }
  if (result.error !== undefined) throw result.error;
};

try {
  const url = resolveDatabaseUrl(label);
  process.env.DATABASE_URL = url;
  logDatabaseUrlReady(url, label);

  await waitForPostgres(url);

  const childEnv = { ...process.env, DATABASE_URL: url };

  if (mode === 'web') {
    run('npx', ['prisma', 'migrate', 'deploy'], childEnv);
    run('node', ['dist/server.js'], childEnv);
  } else if (mode === 'cron') {
    run('node', ['dist/scripts/cronTick.js'], childEnv);
  } else {
    throw new Error(`Usage: node dist/scripts/railwayBootstrap.js <web|cron>`);
  }
} catch (err) {
  fail(err);
}
