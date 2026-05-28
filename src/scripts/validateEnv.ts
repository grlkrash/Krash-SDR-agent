// Runs before migrate deploy (web) and cronTick (cron). See package.json start:*.
// Fails fast with a log line Railway captures in Deploy Logs — not Build Logs.

import 'dotenv/config';

const BUILD_PLACEHOLDER_HOST = '127.0.0.1:5432/build';
const EMPTY_REF_SKELETON = 'postgresql://:@:/';
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
      'Railway → web AND cron services → Variables → set DATABASE_URL.',
      'Easiest: ${{<PostgresServiceName>.DATABASE_URL}} via the variable picker.',
      'Replace <PostgresServiceName> with the EXACT case-sensitive name on the canvas.',
      'Use the private DATABASE_URL, not DATABASE_PUBLIC_URL.',
    ].join('\n'),
  );
}

if (url.includes(BUILD_PLACEHOLDER_HOST)) {
  fail(
    'DATABASE_URL is the Prisma build placeholder (127.0.0.1:5432/build). Runtime never received the Railway Postgres URL.',
  );
}

if (url === EMPTY_REF_SKELETON) {
  fail(
    [
      'DATABASE_URL collapsed to "postgresql://:@:/" (length 17) — every',
      '${{<X>.PG*}} reference resolved to "". The Postgres service name in',
      'your references does NOT match the Railway canvas (Railway refs are',
      'case-sensitive).',
      '',
      'Fix:',
      '1. On the Railway canvas, click the Postgres database box.',
      '   Note its EXACT name (e.g. "Postgres", "Postgres-abc123", "ssa-db").',
      '2. On web AND cron services → Variables → delete DATABASE_URL.',
      '3. Re-add via the variable picker:',
      '     DATABASE_URL = ${{<that-exact-name>.DATABASE_URL}}',
      '   (The picker fills the name in for you — do not type it.)',
      '4. Redeploy both services.',
    ].join('\n'),
  );
}

const tryParseUrl = (raw: string): URL | null => {
  try {
    return new URL(raw);
  } catch {
    return null;
  }
};

const parsed = tryParseUrl(url);

if (parsed === null) {
  fail(
    [
      `DATABASE_URL is set but not a valid URL (length=${url.length}).`,
      'Expected shape: postgresql://user:pass@host.railway.internal:5432/dbname',
      'Likely cause: one or more ${{<X>.PG*}} references resolved to "".',
      'On web AND cron Variables, set DATABASE_URL via the picker:',
      '  DATABASE_URL = ${{<PostgresServiceName>.DATABASE_URL}}',
    ].join('\n'),
  );
  throw new Error('unreachable');
}

if (parsed.hostname === '') {
  fail(
    [
      `DATABASE_URL parsed but hostname is empty (length=${url.length}).`,
      'Likely cause: ${{<X>.PGHOST}} reference resolved to "".',
      'On web AND cron Variables, set DATABASE_URL via the picker:',
      '  DATABASE_URL = ${{<PostgresServiceName>.DATABASE_URL}}',
    ].join('\n'),
  );
}

console.error(
  `[${label}] DATABASE_URL present (host=${parsed.hostname}, port=${parsed.port || '(default)'}, len=${url.length})`,
);
