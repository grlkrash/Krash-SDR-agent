// Shared lead opt-out — suppresses email + phone and stops all outreach.
// Used by STOP email replies, unsubscribe link (future), and inbound call opt-out.

import { PrismaPg } from '@prisma/adapter-pg';
import { PrismaClient } from '@prisma/client';
import { guessEmail } from './guessEmail.js';

const REASON_MAX_CHARS = 240;

const prisma = new PrismaClient({
  adapter: new PrismaPg({ connectionString: process.env.DATABASE_URL ?? '' }),
});

const OPT_OUT_BODY = /^(?:please\s+)?(?:reply\s+)?(stop|unsubscribe|opt[\s-]?out|remove(?:\s+me)?|cancel(?:\s+(?:all|emails|calls|contact))?)(?:[\s.!]*)$/i;

export const isOptOutReplyText = (raw: string): boolean => {
  const trimmed = raw.trim();
  if (trimmed === '') return false;
  if (trimmed.length > 80) return false;
  const withoutRe = trimmed.replace(/^re:\s*/i, '').trim();
  if (OPT_OUT_BODY.test(withoutRe)) return true;
  const firstWord = withoutRe.split(/\s+/)[0] ?? '';
  return /^(stop|unsubscribe)$/i.test(firstWord);
};

export type OptOutLeadOpts = {
  leadId: string;
  email: string;
  phone: string;
  reason: string;
  source: string;
};

export const optOutLead = async (opts: OptOutLeadOpts): Promise<{
  cancelledDrafts: number;
}> => {
  const reason = opts.reason.trim().slice(0, REASON_MAX_CHARS);

  await prisma.lead.update({
    where: { id: opts.leadId },
    data: { doNotContact: true, priorWrittenConsent: false },
  });

  const cancelled = await prisma.draft.updateMany({
    where: {
      leadId: opts.leadId,
      status: { in: ['pending', 'approved', 'paused'] },
    },
    data: {
      status: 'rejected',
      rejectReason: `Opt-out (${opts.source}): ${reason}`.slice(0, REASON_MAX_CHARS),
    },
  });

  const email = opts.email.trim().toLowerCase();
  const phone = opts.phone.trim();
  if (email !== '' || phone !== '') {
    await prisma.suppression.upsert({
      where: { email_phoneE164: { email, phoneE164: phone } },
      create: { email, phoneE164: phone, reason: `opt-out:${opts.source}` },
      update: { reason: `opt-out:${opts.source}` },
    });
  }

  await prisma.auditLog.create({
    data: {
      action: 'lead.opt-out',
      entity: 'Lead',
      entityId: opts.leadId,
      meta: {
        source: opts.source,
        reason,
        suppressedEmail: email === '' ? null : email,
        suppressedPhone: phone === '' ? null : phone,
        cancelledDrafts: cancelled.count,
      },
    },
  });

  return { cancelledDrafts: cancelled.count };
};

export const resolveLeadContactEmail = (
  ownerEmail: string | null | undefined,
  ownerName: string | null | undefined,
  website: string | null | undefined,
): string =>
  ownerEmail?.trim().toLowerCase()
  ?? guessEmail(ownerName ?? null, website ?? null)
  ?? '';
