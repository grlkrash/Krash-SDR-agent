// Import directory / existing-client spreadsheets → mark leads excluded from cold.
//
// Drop CSVs into:
//   data/exclusions/incoming/directory/   — Sobriety Select directory export
//   data/exclusions/incoming/client/      — paying clients (HubSpot export)
//
// Run (local or railway run, with DATABASE_URL set):
//   npm run exclusions:import -- --incoming
//   npm run exclusions:import -- directory path/to/file.csv
//   npm run exclusions:import -- client path/to/file.csv
//
// Processed files move to data/exclusions/processed/

import 'dotenv/config';
import { readdir } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { PrismaPg } from '@prisma/adapter-pg';
import { PrismaClient } from '@prisma/client';
import {
  importExclusionCsv,
  moveToProcessed,
  type ImportKind,
} from '../pipeline/exclusions/importFile.js';

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const INCOMING_DIR = join(REPO_ROOT, 'data/exclusions/incoming');
const PROCESSED_DIR = join(REPO_ROOT, 'data/exclusions/processed');

const prisma = new PrismaClient({
  adapter: new PrismaPg({ connectionString: process.env.DATABASE_URL ?? '' }),
});

const isCsv = (name: string): boolean => name.toLowerCase().endsWith('.csv');

const listCsvFiles = async (dir: string): Promise<string[]> => {
  const names = await readdir(dir);
  return names.filter(isCsv).map((n) => join(dir, n));
};

const runOne = async (kind: ImportKind, filePath: string): Promise<void> => {
  const result = await importExclusionCsv(prisma, filePath, kind);
  const movedTo = await moveToProcessed(filePath, PROCESSED_DIR);
  console.log(JSON.stringify({ ...result, movedTo }));
};

const runIncoming = async (): Promise<void> => {
  const pairs: Array<{ kind: ImportKind; dir: string }> = [
    { kind: 'directory', dir: join(INCOMING_DIR, 'directory') },
    { kind: 'client', dir: join(INCOMING_DIR, 'client') },
  ];
  let total = 0;
  for (const { kind, dir } of pairs) {
    const files = await listCsvFiles(dir);
    for (const file of files) {
      await runOne(kind, file);
      total += 1;
    }
  }
  if (total === 0) {
    console.log(JSON.stringify({
      message: 'No CSV files in data/exclusions/incoming/directory or .../client',
    }));
  }
};

const printUsage = (): void => {
  console.error(`Usage:
  npm run exclusions:import -- --incoming
  npm run exclusions:import -- directory <file.csv>
  npm run exclusions:import -- client <file.csv>`);
};

try {
  const args = process.argv.slice(2);
  if (args[0] === '--incoming') {
    await runIncoming();
  } else if (args.length === 2 && (args[0] === 'directory' || args[0] === 'client')) {
    await runOne(args[0], resolve(args[1]));
  } else {
    printUsage();
    throw new Error('Invalid arguments');
  }

  await prisma.auditLog.create({
    data: {
      action: 'cron.success',
      entity: 'importExclusions',
      meta: { argv: args },
    },
  });
} catch (err) {
  const message = err instanceof Error ? err.message : String(err);
  await prisma.auditLog.create({
    data: {
      action: 'cron.failure',
      entity: 'importExclusions',
      meta: { error: message },
    },
  });
  throw err;
}
