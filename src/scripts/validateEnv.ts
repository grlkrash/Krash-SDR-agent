// Runs before migrate deploy (web) and cronTick (cron). See package.json start:*.
// Fails fast with a log line Railway captures in Deploy Logs — not Build Logs.

import 'dotenv/config';

const BUILD_PLACEHOLDER_HOST = '127.0.0.1:5432/build';
const label = process.env.RAILWAY_SERVICE_NAME ?? 'ssa';

const fail = (message: string): never => {
  console.error(`[${label}] FATAL: ${message}`);
  throw new Error(message);
};

const url = process.env.DATABASE_URL?.trim() ?? '';

if (url === '') {
  fail(
    [
      'DATABASE_URL is missing or empty.',
      'Railway → ssa-web AND ssa-cron → Variables → DATABASE_URL reference.',
      'Prefer composite (survives Postgres reconnect better):',
      '  postgresql://${{Postgres.PGUSER}}:${{Postgres.PGPASSWORD}}@${{Postgres.PGHOST}}:${{Postgres.PGPORT}}/${{Postgres.PGDATABASE}}',
      'Or: ${{Postgres.DATABASE_URL}} — delete stale row and re-pick if it goes empty on redeploy.',
      'Use private PGHOST (*.railway.internal), not DATABASE_PUBLIC_URL.',
    ].join('\n'),
  );
}

if (url.includes(BUILD_PLACEHOLDER_HOST)) {
  fail(
    'DATABASE_URL is the Prisma build placeholder (127.0.0.1:5432/build). Runtime never received the Railway Postgres URL.',
  );
}

let host = '(unparseable)';
try {
  host = new URL(url).hostname;
} catch {
  // keep default
}

console.error(`[${label}] DATABASE_URL present (host=${host}, len=${url.length})`);
