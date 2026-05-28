// Resolve Postgres connection string for Railway runtime.
// Prefer DATABASE_URL; fall back to individual PG* vars (picker-friendly).

const BUILD_PLACEHOLDER_HOST = '127.0.0.1:5432/build';
const EMPTY_REF_SKELETON = 'postgresql://:@:/';

const tryParseUrl = (raw: string): URL | null => {
  try {
    return new URL(raw);
  } catch {
    return null;
  }
};

const isUsableUrl = (raw: string): boolean => {
  if (raw === '' || raw === EMPTY_REF_SKELETON) return false;
  if (raw.includes(BUILD_PLACEHOLDER_HOST)) return false;
  if (raw.includes('${{')) return false;
  const parsed = tryParseUrl(raw);
  return parsed !== null && parsed.hostname !== '';
};

const buildFromPgVars = (): string | null => {
  const host = process.env.PGHOST?.trim() ?? '';
  const port = process.env.PGPORT?.trim() || '5432';
  const user = process.env.PGUSER?.trim() ?? '';
  const password = process.env.PGPASSWORD ?? '';
  const database = process.env.PGDATABASE?.trim() ?? '';

  if (host === '' || user === '' || database === '') return null;
  if (host.includes('${{') || user.includes('${{') || database.includes('${{')) return null;

  const encUser = encodeURIComponent(user);
  const encPass = encodeURIComponent(password);
  return `postgresql://${encUser}:${encPass}@${host}:${port}/${database}`;
};

const railwayFixLines = (): string[] => [
  '',
  'Railway fix (web AND cron services):',
  '  A) Delete DATABASE_URL. Add via variable picker only:',
  '       DATABASE_URL = ${{<Postgres-box-name>.DATABASE_URL}}',
  '     Do NOT paste a composite postgresql://${{...}} string by hand.',
  '  B) Or add five picker refs (same Postgres box name for each):',
  '       PGHOST=${{<name>.PGHOST}}  PGPORT=${{<name>.PGPORT}}',
  '       PGUSER=${{<name>.PGUSER}}  PGPASSWORD=${{<name>.PGPASSWORD}}',
  '       PGDATABASE=${{<name>.PGDATABASE}}',
  '  C) Emergency: Postgres service → Variables → copy DATABASE_URL value',
  '     → paste into web/cron DATABASE_URL (re-pick after next reconnect).',
];

export const resolveDatabaseUrl = (label = 'ssa'): string => {
  const direct = process.env.DATABASE_URL?.trim() ?? '';

  if (direct.includes('${{')) {
    throw new Error(
      [
        `[${label}] FATAL: DATABASE_URL still contains unresolved Railway refs (\${{...}}).`,
        'Use the variable picker — do not type service names manually.',
        ...railwayFixLines(),
      ].join('\n'),
    );
  }

  if (direct === EMPTY_REF_SKELETON) {
    throw new Error(
      [
        `[${label}] FATAL: DATABASE_URL is "postgresql://:@:/" (len=17).`,
        'A hand-pasted composite URL used the wrong Postgres service name;',
        'every ${{<X>.PG*}} ref resolved to "".',
        ...railwayFixLines(),
      ].join('\n'),
    );
  }

  if (isUsableUrl(direct)) return direct;

  const fromPg = buildFromPgVars();
  if (fromPg !== null && isUsableUrl(fromPg)) {
    console.error(`[${label}] DATABASE_URL built from PGHOST/PGUSER/PGDATABASE refs`);
    return fromPg;
  }

  if (direct === '') {
    throw new Error(
      [`[${label}] FATAL: DATABASE_URL is missing or empty.`, ...railwayFixLines()].join('\n'),
    );
  }

  if (direct.includes(BUILD_PLACEHOLDER_HOST)) {
    throw new Error(
      `[${label}] FATAL: DATABASE_URL is the build placeholder (127.0.0.1:5432/build).`,
    );
  }

  throw new Error(
    [
      `[${label}] FATAL: DATABASE_URL is not a valid Postgres URL (len=${direct.length}).`,
      ...railwayFixLines(),
    ].join('\n'),
  );
};

export const logDatabaseUrlReady = (url: string, label = 'ssa'): void => {
  const parsed = tryParseUrl(url);
  if (parsed === null) return;
  console.error(
    `[${label}] DATABASE_URL ready (host=${parsed.hostname}, port=${parsed.port || '(default)'}, len=${url.length})`,
  );
};
