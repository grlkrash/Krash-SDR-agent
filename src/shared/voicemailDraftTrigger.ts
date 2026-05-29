import { PrismaPg } from '@prisma/adapter-pg';
import { PrismaClient } from '@prisma/client';
import type { VoicemailTrigger } from './voicemailCompliance.js';

const prisma = new PrismaClient({
  adapter: new PrismaPg({ connectionString: process.env.DATABASE_URL ?? '' }),
});

type DraftMeta = { draftId?: string; trigger?: VoicemailTrigger };

const parseTrigger = (meta: unknown): VoicemailTrigger | null => {
  if (meta === null || typeof meta !== 'object') return null;
  const t = (meta as DraftMeta).trigger;
  if (t === 'renewal' || t === 'reactivation') return t;
  return null;
};

/** Resolve consent-gated vm trigger from AuditLog (voicemail.drafted / voicemail2.drafted). */
export const getVoicemailDraftTrigger = async (
  draftId: string,
): Promise<VoicemailTrigger | null> => {
  const row = await prisma.auditLog.findFirst({
    where: {
      action: { in: ['voicemail.drafted', 'voicemail2.drafted'] },
      meta: { path: ['draftId'], equals: draftId },
    },
    orderBy: { createdAt: 'desc' },
  });
  return parseTrigger(row?.meta ?? null);
};
