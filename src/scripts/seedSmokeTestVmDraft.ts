// One-off: reset blocked smoke-test vm-2 drafts and create a fresh pending draft.
// Usage: SMOKE_TEST_LEAD_ID=<leadId> tsx src/scripts/seedSmokeTestVmDraft.ts

import 'dotenv/config';
import { PrismaPg } from '@prisma/adapter-pg';
import { PrismaClient } from '@prisma/client';
import { dropVoicemail2 } from '../outreach/voicemail2.js';

const prisma = new PrismaClient({
  adapter: new PrismaPg({ connectionString: process.env.DATABASE_URL ?? '' }),
});

const leadId = process.env.SMOKE_TEST_LEAD_ID?.trim() ?? '';
if (leadId === '') {
  throw new Error('SMOKE_TEST_LEAD_ID is required');
}

const lead = await prisma.lead.findUnique({
  where: { id: leadId },
  select: { id: true, name: true, phoneE164: true },
});
if (lead === null) {
  throw new Error(`Lead not found: ${leadId}`);
}

const reset = await prisma.draft.updateMany({
  where: {
    leadId,
    kind: 'voicemail-2',
    status: { not: 'rejected' },
  },
  data: {
    status: 'rejected',
    rejectReason: 'smoke-test-reset',
  },
});

await dropVoicemail2(leadId);

const pending = await prisma.draft.findFirst({
  where: { leadId, kind: 'voicemail-2', status: 'pending' },
  select: { id: true, body: true },
  orderBy: { createdAt: 'desc' },
});

console.log(JSON.stringify({
  lead: lead.name,
  phoneE164: lead.phoneE164,
  resetDrafts: reset.count,
  pendingDraftId: pending?.id ?? null,
  bodyPreview: pending?.body.slice(0, 80) ?? null,
}));
