import { readFile, rename } from 'node:fs/promises';
import { basename } from 'node:path';
import { Prisma, type PrismaClient } from '@prisma/client';
import type { ExclusionKind } from '../../shared/exclusion.js';
import { parseCsv, rowToRecord } from './parseCsv.js';
import { normalizeImportRow } from './normalizeRow.js';
import { applyExclusionToLead } from './applyExclusion.js';
import { buildLeadIndex, matchRowToLead } from './matchLead.js';

export type ImportKind = 'directory' | 'client';

const KIND_MAP: Record<ImportKind, ExclusionKind> = {
  directory: 'directory-listed',
  client: 'existing-client',
};

export type ImportFileResult = {
  sourceFile: string;
  kind: ImportKind;
  rowsTotal: number;
  rowsSkipped: number;
  matched: number;
  ambiguous: number;
  unmatched: number;
  cancelledDrafts: number;
  ambiguousSamples: Array<{ rowName: string; leadIds: string[] }>;
};

export const importExclusionCsv = async (
  prisma: PrismaClient,
  filePath: string,
  kind: ImportKind,
): Promise<ImportFileResult> => {
  const text = await readFile(filePath, 'utf8');
  const { headers, rows } = parseCsv(text);
  const exclusionKind = KIND_MAP[kind];
  const sourceFile = basename(filePath);

  const leads = await prisma.lead.findMany({
    select: {
      id: true,
      nameNormalized: true,
      addressHash: true,
      city: true,
      state: true,
      website: true,
    },
  });
  const index = buildLeadIndex(leads);

  const result: ImportFileResult = {
    sourceFile,
    kind,
    rowsTotal: rows.length,
    rowsSkipped: 0,
    matched: 0,
    ambiguous: 0,
    unmatched: 0,
    cancelledDrafts: 0,
    ambiguousSamples: [],
  };

  for (const cells of rows) {
    const raw = rowToRecord(headers, cells);
    const row = normalizeImportRow(raw);
    if (row === null) {
      result.rowsSkipped += 1;
      continue;
    }

    const match = matchRowToLead(row, index, leads);
    if (match.status === 'unmatched') {
      result.unmatched += 1;
      await prisma.auditLog.create({
        data: {
          action: 'exclusion.import-unmatched',
          entity: 'exclusion',
          meta: {
            sourceFile,
            kind: exclusionKind,
            name: row.name,
            domain: row.domain,
            city: row.city,
            state: row.state,
          } as Prisma.InputJsonValue,
        },
      });
      continue;
    }

    if (match.status === 'ambiguous') {
      result.ambiguous += 1;
      if (result.ambiguousSamples.length < 20) {
        result.ambiguousSamples.push({ rowName: row.name, leadIds: match.leadIds });
      }
      await prisma.auditLog.create({
        data: {
          action: 'exclusion.import-ambiguous',
          entity: 'exclusion',
          meta: {
            sourceFile,
            kind: exclusionKind,
            name: row.name,
            leadIds: match.leadIds,
            confidence: match.confidence,
          } as Prisma.InputJsonValue,
        },
      });
      continue;
    }

    const applied = await applyExclusionToLead(prisma, {
      leadId: match.leadId,
      kind: exclusionKind,
      row,
      matchConfidence: match.confidence,
      sourceFile,
    });
    result.matched += 1;
    result.cancelledDrafts += applied.cancelledDrafts;

    await prisma.auditLog.create({
      data: {
        action: 'exclusion.import-matched',
        entity: 'lead',
        entityId: match.leadId,
        meta: {
          sourceFile,
          kind: exclusionKind,
          name: row.name,
          confidence: match.confidence,
          tier: row.tier,
          cancelledDrafts: applied.cancelledDrafts,
        } as Prisma.InputJsonValue,
      },
    });
  }

  await prisma.auditLog.create({
    data: {
      action: 'exclusion.import-complete',
      entity: 'exclusion',
      meta: result as unknown as Prisma.InputJsonValue,
    },
  });

  return result;
};

export const moveToProcessed = async (filePath: string, processedDir: string): Promise<string> => {
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const dest = `${processedDir}/${stamp}-${basename(filePath)}`;
  await rename(filePath, dest);
  return dest;
};
