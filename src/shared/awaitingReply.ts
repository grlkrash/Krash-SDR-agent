// Shared eligibility for "gone quiet" leads — used by /queue awaiting-reply
// section and the draftFollowups cron (PRD §9.1 7:00 AM ET).

import type { Prisma } from '@prisma/client';

export const REPLY_SILENCE_DAYS = 10;
export const MS_PER_DAY = 86_400_000;

export const awaitingReplySilenceCutoff = (): Date =>
  new Date(Date.now() - REPLY_SILENCE_DAYS * MS_PER_DAY);

/** Leads whose last outbound send (any kind) was before the silence cutoff. */
export const awaitingReplyLeadWhere = (silenceCutoff: Date): Prisma.LeadWhereInput => ({
  doNotContact: false,
  drafts: {
    some: { status: 'sent' },
    none: {
      OR: [
        { status: { in: ['pending', 'approved', 'paused'] } },
        { status: 'sent', sentAt: { gt: silenceCutoff } },
        { kind: 'nudge', createdAt: { gt: silenceCutoff } },
      ],
    },
  },
});
