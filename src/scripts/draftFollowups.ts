// tsx src/scripts/draftFollowups.ts
//
// Cron entry (7:00 AM ET): batch-draft approval-gated nudges for leads in the
// "awaiting reply" state (10+ days since last send, no open queue work).
// Same eligibility as /queue's awaiting-reply section; runs before
// runSequences (7:30) which drafts template touches 2–5 into /queue.

import 'dotenv/config';
import { PrismaPg } from '@prisma/adapter-pg';
import { PrismaClient } from '@prisma/client';
import { draftNudge } from '../outreach/draftNudge.js';
import { getSequenceState } from '../outreach/sequencer.js';
import {
  awaitingReplyLeadWhere,
  awaitingReplySilenceCutoff,
} from '../shared/awaitingReply.js';

const BATCH_SIZE = 15;
const CONCURRENCY = 3;
const BATCH_SLEEP_MS = 1000;
const CANDIDATE_OVERFETCH = BATCH_SIZE * 4;

const prisma = new PrismaClient({
  adapter: new PrismaPg({ connectionString: process.env.DATABASE_URL ?? '' }),
});

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

const runConcurrent = async <T>(
  items: T[],
  n: number,
  fn: (item: T) => Promise<void>,
): Promise<void> => {
  let cursor = 0;
  await Promise.all(Array.from({ length: Math.min(n, items.length) }, async () => {
    while (cursor < items.length) await fn(items[cursor++]);
  }));
};

try {
const silenceCutoff = awaitingReplySilenceCutoff();

const candidates = await prisma.lead.findMany({
  where: awaitingReplyLeadWhere(silenceCutoff),
  select: {
    id: true,
    drafts: {
      where: { status: 'sent' },
      orderBy: { sentAt: 'desc' },
      take: 1,
      select: { sentAt: true },
    },
  },
  take: CANDIDATE_OVERFETCH,
});

// Oldest silence first — same priority as /queue awaiting-reply.
const ordered = [...candidates].sort((a, b) => {
  const aMs = a.drafts[0]?.sentAt?.getTime() ?? 0;
  const bMs = b.drafts[0]?.sentAt?.getTime() ?? 0;
  return aMs - bMs;
});

const eligible: string[] = [];
for (const lead of ordered) {
  if (eligible.length >= BATCH_SIZE) break;

  const state = await getSequenceState(lead.id);
  if (state?.status === 'replied') continue;
  // Defer to runSequences when a template follow-up touch is due — avoids double outreach.
  if (state?.status === 'active' && state.nextSendAt <= new Date()) continue;

  const queuedFollowup = await prisma.draft.findFirst({
    where: {
      leadId: lead.id,
      kind: { startsWith: 'followup-' },
      status: { in: ['pending', 'approved'] },
    },
    select: { id: true },
  });
  if (queuedFollowup !== null) continue;

  eligible.push(lead.id);
}

let ok = 0;
let skipped = 0;
let fail = 0;

for (let i = 0; i < eligible.length; i += CONCURRENCY) {
  const batch = eligible.slice(i, i + CONCURRENCY);
  await runConcurrent(batch, CONCURRENCY, async (leadId) => {
    try {
      const draftId = await draftNudge(leadId);
      if (draftId === null) skipped += 1;
      else ok += 1;
    } catch (err) {
      fail += 1;
      await prisma.auditLog.create({ data: {
        action: 'draftFollowup.failure',
        entity: 'lead',
        entityId: leadId,
        meta: { error: err instanceof Error ? err.message : String(err) },
      } });
    }
  });
  if (i + CONCURRENCY < eligible.length) await sleep(BATCH_SLEEP_MS);
}

const summary = {
  candidates: candidates.length,
  eligible: eligible.length,
  ok,
  skipped,
  fail,
};

await prisma.auditLog.create({ data: {
  action: 'cron.success',
  entity: 'draftFollowups',
  meta: summary,
} });
console.log(JSON.stringify(summary));
} catch (err) {
  const message = err instanceof Error ? err.message : String(err);
  await prisma.auditLog.create({ data: {
    action: 'cron.failure',
    entity: 'draftFollowups',
    meta: { error: message },
  } });
  throw err;
}
