import { Prisma, type PrismaClient } from '@prisma/client';
import { toE164 } from '../../shared/lead.js';
import {
  type ExclusionKind,
  type ExclusionRecord,
  type MatchConfidence,
  mergeExclusionIntoJson,
} from '../../shared/exclusion.js';
import type { ExclusionImportRow } from './normalizeRow.js';

const COLD_DRAFT_CANCEL_STATUSES = ['pending', 'approved', 'paused'] as const;

export type ApplyExclusionInput = {
  leadId: string;
  kind: ExclusionKind;
  row: ExclusionImportRow;
  matchConfidence: MatchConfidence;
  sourceFile: string;
};

export const applyExclusionToLead = async (
  prisma: PrismaClient,
  input: ApplyExclusionInput,
): Promise<{ cancelledDrafts: number; suppressedEmail: string | null }> => {
  const importedAt = new Date().toISOString();
  const record: ExclusionRecord = {
    excludeFromCold: true,
    kind: input.kind,
    tier: input.row.tier,
    source: input.kind === 'directory-listed' ? 'directory-import' : 'client-import',
    importedAt,
    matchConfidence: input.matchConfidence,
    externalId: input.row.externalId,
    sourceFile: input.sourceFile,
  };

  const lead = await prisma.lead.findUnique({
    where: { id: input.leadId },
    include: { enrichment: true },
  });
  if (lead === null) {
    throw new Error(`Lead not found: ${input.leadId}`);
  }

  await prisma.lead.update({
    where: { id: input.leadId },
    data: {
      sourceMeta: mergeExclusionIntoJson(lead.sourceMeta, record) as Prisma.InputJsonValue,
    },
  });

  if (lead.enrichment !== null) {
    await prisma.enrichment.update({
      where: { leadId: input.leadId },
      data: {
        signals: mergeExclusionIntoJson(lead.enrichment.signals, record) as Prisma.InputJsonValue,
      },
    });
  }

  let suppressedEmail: string | null = null;
  if (input.kind === 'existing-client' && input.row.email !== null) {
    const email = input.row.email.toLowerCase().trim();
    if (email !== '') {
      await prisma.suppression.upsert({
        where: { email_phoneE164: { email, phoneE164: '' } },
        create: {
          email,
          phoneE164: '',
          reason: `existing-client:import:${input.sourceFile}`,
        },
        update: { reason: `existing-client:import:${input.sourceFile}` },
      });
      suppressedEmail = email;
    }
  }

  const phoneE164 = toE164(input.row.phone);
  if (input.kind === 'existing-client' && phoneE164 !== null) {
    await prisma.suppression.upsert({
      where: { email_phoneE164: { email: '', phoneE164 } },
      create: {
        email: '',
        phoneE164,
        reason: `existing-client:import:${input.sourceFile}`,
      },
      update: { reason: `existing-client:import:${input.sourceFile}` },
    });
  }

  const cancel = await prisma.draft.updateMany({
    where: {
      leadId: input.leadId,
      kind: 'cold',
      status: { in: [...COLD_DRAFT_CANCEL_STATUSES] },
    },
    data: {
      status: 'rejected',
      rejectReason: `Excluded (${input.kind}) via ${input.sourceFile}`,
    },
  });

  return { cancelledDrafts: cancel.count, suppressedEmail };
};
