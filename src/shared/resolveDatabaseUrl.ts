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

const isSkeletonUrl = (raw: string): boolean =>
  raw === EMPTY_REF_SKELETON || (raw.startsWith('postgresql://') && tryParseUrl(raw)?.hostname === '');

const isUsableUrl = (raw: string): boolean => {
  if (raw === '' || isSkeletonUrl(raw)) return false;
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

const pgVarDiagnostics = (): string => {
  const flag = (name: string): string => {
    const v = process.env[name]?.trim() ?? '';
    if (v === '') return `${name}=empty`;
    if (v.includes('${{')) return `${name}=unresolved-ref`;
    return `${name}=set(len=${v.length})`;
  };
  return ['PGHOST', 'PGPORT', 'PGUSER', 'PGPASSWORD', 'PGDATABASE'].map(flag).join(', ');
};

const railwayFixLines = (): string[] => [
  '',
  'Railway fix (web AND cron) — read Variables → Raw Editor:',
  '  1. If DATABASE_URL value is literally "postgresql://:@:/" or starts with',
  '     "postgresql://" and looks like a template, DELETE that row entirely.',
  '  2. Add ONE variable via picker (chip icon):',
  '       DATABASE_URL = ${{<your-postgres-box>.DATABASE_URL}}',
  '     At runtime len must be 80+, host postgres.railway.internal — NOT 17.',
  '  3. Or delete DATABASE_URL and add five picker refs: PGHOST, PGPORT,',
  '     PGUSER, PGPASSWORD, PGDATABASE (all from the same Postgres box).',
  '  4. Emergency: Postgres service → Variables → reveal DATABASE_URL →',
  '     copy the full string → paste as web/cron DATABASE_URL (plain text).',
];

export const resolveDatabaseUrl = (label = 'ssa'): string => {
  const direct = process.env.DATABASE_URL?.trim() ?? '';

  if (direct.includes('${{')) {
    throw new Error(
      [
        `[${label}] FATAL: DATABASE_URL still contains unresolved Railway refs.`,
        `Diagnostics: DATABASE_URL len=${direct.length}; ${pgVarDiagnostics()}`,
        ...railwayFixLines(),
      ].join('\n'),
    );
  }

  if (isUsableUrl(direct)) return direct;

  const fromPg = buildFromPgVars();
  if (fromPg !== null && isUsableUrl(fromPg)) {
    if (isSkeletonUrl(direct)) {
      console.error(
        `[${label}] Ignoring broken DATABASE_URL (len=17 skeleton); using PGHOST/PGUSER/PGDATABASE instead`,
      );
    }
    console.error(`[${label}] DATABASE_URL built from PGHOST/PGUSER/PGDATABASE refs`);
    return fromPg;
  }

  if (direct === EMPTY_REF_SKELETON || isSkeletonUrl(direct)) {
    throw new Error(
      [
        `[${label}] FATAL: DATABASE_URL is "postgresql://:@:/" (len=17).`,
        'This is the OLD hand-pasted composite — not a ${{Service.DATABASE_URL}} picker.',
        'Delete DATABASE_URL in Raw Editor, then re-add via picker OR use emergency copy.',
        `Diagnostics: ${pgVarDiagnostics()}`,
        ...railwayFixLines(),
      ].join('\n'),
    );
  }

  if (direct === '') {
    throw new Error(
      [
        `[${label}] FATAL: DATABASE_URL is missing or empty.`,
        `Diagnostics: ${pgVarDiagnostics()}`,
        ...railwayFixLines(),
      ].join('\n'),
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
      `Diagnostics: ${pgVarDiagnostics()}`,
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
