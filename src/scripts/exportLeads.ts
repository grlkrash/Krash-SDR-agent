// Export leads as a HubSpot-friendly CSV for overlap / import testing.
//
// Run (local or production DB):
//   npm run leads:export
//   npm run leads:export -- --stdout > ~/Desktop/sdr-leads.csv
//   npm run leads:export -- --enriched-only --output ./data/exports/my-export.csv
//
// Share the file with Sobriety Select — do not commit CSVs (PII).

import 'dotenv/config';
import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { PrismaPg } from '@prisma/adapter-pg';
import { PrismaClient } from '@prisma/client';
import { extractDomain } from '../shared/domain.js';
import { getExclusion } from '../shared/exclusion.js';
import { guessEmail } from '../shared/guessEmail.js';
import { serializeCsv } from '../shared/serializeCsv.js';

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const DEFAULT_EXPORT_DIR = join(REPO_ROOT, 'data/exports');

// Column labels mirror common HubSpot CRM export headers so VLOOKUP/XLOOKUP
// against their Companies + Contacts export is one step.
const EXPORT_HEADERS = [
  'SDR lead ID',
  'Company record ID',
  'Company name',
  'Company Domain Name',
  'Website URL',
  'Street Address',
  'City',
  'State/Region',
  'Postal Code',
  'Phone Number',
  'Email',
  'Email source',
  'First Name',
  'Last Name',
  'Job Title',
  'LinkedIn URL',
  'Enriched',
  'Exclude from cold',
  'Exclusion reason',
  'Do not contact',
  'Lead source',
  'Google rating',
  'Google review count',
  'Expected product',
] as const;

const prisma = new PrismaClient({
  adapter: new PrismaPg({ connectionString: process.env.DATABASE_URL ?? '' }),
});

const splitContactName = (full: string | null): { first: string; last: string } => {
  if (full === null || full.trim() === '') return { first: '', last: '' };
  const parts = full.trim().split(/\s+/);
  const [first, ...rest] = parts;
  return { first: first ?? '', last: rest.join(' ') };
};

const todayStamp = (): string => new Date().toISOString().slice(0, 10);

const defaultOutputPath = (): string =>
  join(DEFAULT_EXPORT_DIR, `sdr-leads-${todayStamp()}.csv`);

const printUsage = (): void => {
  console.error(`Usage:
  npm run leads:export
  npm run leads:export -- --stdout
  npm run leads:export -- --enriched-only
  npm run leads:export -- --output ./path/to/file.csv`);
};

const resolveEmail = (
  ownerEmail: string | null,
  ownerName: string | null,
  website: string | null,
): { email: string; source: string } => {
  if (ownerEmail !== null && ownerEmail.trim() !== '') {
    return { email: ownerEmail.trim(), source: 'enriched' };
  }
  const guessed = guessEmail(ownerName, website);
  if (guessed !== null) return { email: guessed, source: 'guessed' };
  return { email: '', source: '' };
};

const resolveExclusion = (
  sourceMeta: unknown,
  signals: unknown,
): { excludeFromCold: string; kind: string } => {
  const rec =
    getExclusion(signals) ??
    getExclusion(sourceMeta);
  if (rec === null || !rec.excludeFromCold) {
    return { excludeFromCold: 'no', kind: '' };
  }
  return { excludeFromCold: 'yes', kind: rec.kind };
};

try {
  const args = process.argv.slice(2);
  const toStdout = args.includes('--stdout');
  const enrichedOnly = args.includes('--enriched-only');
  const outputIdx = args.indexOf('--output');
  const outputArg = outputIdx >= 0 ? args[outputIdx + 1] : undefined;
  if (outputIdx >= 0 && (outputArg === undefined || outputArg.startsWith('--'))) {
    printUsage();
    throw new Error('Missing path after --output');
  }
  if (args.some((a) => a.startsWith('--') && a !== '--stdout' && a !== '--enriched-only' && a !== '--output')) {
    printUsage();
    throw new Error('Unknown flag');
  }

  const leads = await prisma.lead.findMany({
    where: enrichedOnly ? { enrichment: { isNot: null } } : undefined,
    include: { enrichment: true },
    orderBy: [{ state: 'asc' }, { city: 'asc' }, { name: 'asc' }],
  });

  const rows = leads.map((lead) => {
    const enrichment = lead.enrichment;
    const domain = extractDomain(lead.website) ?? '';
    const { email, source: emailSource } = resolveEmail(
      enrichment?.ownerEmail ?? null,
      enrichment?.ownerName ?? null,
      lead.website,
    );
    const { first, last } = splitContactName(enrichment?.ownerName ?? null);
    const { excludeFromCold, kind: exclusionKind } = resolveExclusion(
      lead.sourceMeta,
      enrichment?.signals ?? null,
    );

    return [
      lead.id,
      lead.hubspotCompanyId ?? '',
      lead.name,
      domain,
      lead.website ?? '',
      lead.street ?? '',
      lead.city,
      lead.state,
      lead.zip ?? '',
      lead.phoneE164 ?? '',
      email,
      emailSource,
      first,
      last,
      enrichment?.ownerTitle ?? '',
      enrichment?.ownerLinkedIn ?? '',
      enrichment !== null ? 'yes' : 'no',
      excludeFromCold,
      exclusionKind,
      lead.doNotContact ? 'yes' : 'no',
      lead.source,
      lead.googleRating !== null ? String(lead.googleRating) : '',
      lead.googleReviews !== null ? String(lead.googleReviews) : '',
      enrichment?.expectedProduct ?? '',
    ];
  });

  const csv = serializeCsv([...EXPORT_HEADERS], rows);
  const outputPath = outputArg !== undefined ? resolve(outputArg) : defaultOutputPath();

  if (toStdout) {
    process.stdout.write(csv);
  } else {
    await mkdir(dirname(outputPath), { recursive: true });
    await writeFile(outputPath, csv, 'utf8');
    console.log(JSON.stringify({
      outputPath,
      rowCount: rows.length,
      enrichedOnly,
      hint: 'Share via secure channel only — contains PII',
    }));
  }

  await prisma.auditLog.create({
    data: {
      action: 'leads.export',
      entity: 'export',
      meta: {
        rowCount: rows.length,
        enrichedOnly,
        toStdout,
        outputPath: toStdout ? 'stdout' : outputPath,
      },
    },
  });
} catch (err) {
  const message = err instanceof Error ? err.message : String(err);
  await prisma.auditLog.create({
    data: {
      action: 'leads.export.failure',
      entity: 'export',
      meta: { error: message },
    },
  });
  throw err;
} finally {
  await prisma.$disconnect();
}
