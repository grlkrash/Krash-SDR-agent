// tsx src/scripts/seedSmokeTestPostSaleQueue.ts
//
// Seeds renewal + reactivation pending drafts for SMOKE_TEST_LEAD_ID, then
// optionally runs the reactivation → consent → vm pipeline for Twilio smoke test.
//
// Usage:
//   SMOKE_TEST_LEAD_ID=... npx tsx src/scripts/seedSmokeTestPostSaleQueue.ts
//   ... RUN_VM_PIPELINE=true VM_AI_AUTO_SEND=true npx tsx ...

import 'dotenv/config';
import { PrismaPg } from '@prisma/adapter-pg';
import { Prisma, PrismaClient } from '@prisma/client';
import type { TextBlockParam } from '@anthropic-ai/sdk/resources/messages';
import { z } from 'zod';
import { claude, extractJSON } from '../shared/claude.js';
import { hs, hsRetry } from '../shared/hubspot.js';
import { generateRenewalWarnings } from '../outreach/renewalWarning.js';
import { sendApprovedDraft } from '../outreach/sender.js';
import { dropVoicemail } from '../outreach/voicemail.js';
import {
  REACTIVATION_SYSTEM,
  buildReactivationUser,
} from '../prompts/reactivation.js';

const DEFAULT_SMOKE_LEAD_ID = 'cmppuywni0000lyw4v7cormbt';
const MODEL = 'claude-sonnet-4-5-20250929';
const MAX_TOKENS = 512;
const TEMPERATURE = 0.7;
const MS_PER_DAY = 86_400_000;
const REACTIVATION_KIND = 'reactivation';
const RENEWAL_KIND = 'renewal';

const prisma = new PrismaClient({
  adapter: new PrismaPg({ connectionString: process.env.DATABASE_URL ?? '' }),
});

const cached = (text: string): Array<TextBlockParam> => [
  { type: 'text', text, cache_control: { type: 'ephemeral' } },
];

const GenSchema = z.object({ subject: z.string(), body: z.string() });

const audit = (
  action: string,
  entityId: string | null,
  meta: Prisma.InputJsonValue,
): Promise<unknown> =>
  prisma.auditLog.create({ data: { action, entity: 'seedSmokeTest', entityId, meta } });

const leadId = (process.env.SMOKE_TEST_LEAD_ID?.trim() ?? DEFAULT_SMOKE_LEAD_ID);

const lead = await prisma.lead.findUnique({
  where: { id: leadId },
  include: { enrichment: true },
});
if (lead === null) throw new Error(`Lead not found: ${leadId}`);
let enrichment = lead.enrichment;
if (enrichment === null) throw new Error(`Lead ${leadId} has no enrichment`);
const companyId = lead.hubspotCompanyId;
if (companyId === null) throw new Error(`Lead ${leadId} has no hubspotCompanyId`);

console.log(JSON.stringify({ step: 'lead', name: lead.name, companyId, phoneE164: lead.phoneE164 }));

// Clear blocking voicemail drafts so dropVoicemails can run again later.
const vmReset = await prisma.draft.updateMany({
  where: {
    leadId,
    kind: { in: ['voicemail', 'voicemail-2'] },
    status: { notIn: ['rejected'] },
  },
  data: { status: 'rejected', rejectReason: 'smoke-test-reset' },
});
console.log(JSON.stringify({ step: 'vm-reset', count: vmReset.count }));

// ----- Renewal: stage closed-won deal + run worker -----
const renewalDeal = await hsRetry(() =>
  hs.crm.deals.basicApi.create({
    properties: {
      dealname: `SMOKE - renewal - ${lead.name}`,
      dealstage: 'closedwon',
      pipeline: 'default',
      ss_product_type: 'select',
      ss_renewal_date: new Date(Date.now() + 60 * MS_PER_DAY).toISOString().slice(0, 10),
      ss_contract_term_months: '12',
      closedate: new Date(Date.now() - 305 * MS_PER_DAY).toISOString().slice(0, 10),
    },
  }),
);
await hsRetry(() =>
  hs.crm.associations.v4.basicApi.createDefault('deals', renewalDeal.id, 'companies', companyId),
);
console.log(JSON.stringify({ step: 'renewal-deal-staged', dealId: renewalDeal.id }));

const recentRenewal = await prisma.draft.findFirst({
  where: { leadId, kind: RENEWAL_KIND, createdAt: { gte: new Date(Date.now() - 60 * MS_PER_DAY) } },
  select: { id: true, status: true },
});
let renewalDraftId = recentRenewal?.id ?? null;
if (recentRenewal === null) {
  await generateRenewalWarnings();
  const created = await prisma.draft.findFirst({
    where: { leadId, kind: RENEWAL_KIND, status: 'pending' },
    orderBy: { createdAt: 'desc' },
    select: { id: true },
  });
  renewalDraftId = created?.id ?? null;
}
console.log(JSON.stringify({ step: 'renewal-draft', draftId: renewalDraftId }));

// ----- Reactivation: ensure engagement history + draft -----
let replied = await prisma.draft.findFirst({
  where: {
    leadId,
    OR: [{ kind: 'replied' }, { kind: { startsWith: 'followup-' } }],
  },
  select: { id: true },
});
if (replied === null) {
  replied = await prisma.draft.create({
    data: {
      leadId,
      kind: 'replied',
      subject: 'Re: smoke test',
      body: 'Tell me more about Sobriety Select.',
      specificFacts: [],
      status: 'sent',
      sentAt: new Date(Date.now() - 45 * MS_PER_DAY),
    },
  });
  console.log(JSON.stringify({ step: 'replied-draft-created', id: replied.id }));
}

const recentReactivation = await prisma.draft.findFirst({
  where: { leadId, kind: REACTIVATION_KIND, createdAt: { gte: new Date(Date.now() - 60 * MS_PER_DAY) } },
  select: { id: true, status: true },
});
let reactivationDraftId = recentReactivation?.id ?? null;
if (recentReactivation === null) {
  const openDeal = await hsRetry(() =>
    hs.crm.deals.basicApi.create({
      properties: {
        dealname: `SMOKE - reactivation - ${lead.name}`,
        dealstage: 'qualifiedtobuy',
        pipeline: 'default',
      },
    }),
  );
  await hsRetry(() =>
    hs.crm.associations.v4.basicApi.createDefault('deals', openDeal.id, 'companies', companyId),
  );

  const daysSinceContact = 35;
  const userPrompt = buildReactivationUser(
    { name: openDeal.properties.dealname ?? lead.name },
    lead,
    enrichment,
    daysSinceContact,
  );
  const msg = await claude.messages.create({
    model: MODEL,
    max_tokens: MAX_TOKENS,
    temperature: TEMPERATURE,
    system: cached(REACTIVATION_SYSTEM.replace('{daysSinceContact}', String(daysSinceContact))),
    messages: [{ role: 'user', content: userPrompt }],
  });
  const gen = GenSchema.parse(extractJSON(msg));
  const draft = await prisma.draft.create({
    data: {
      leadId,
      kind: REACTIVATION_KIND,
      subject: gen.subject,
      body: gen.body,
      specificFacts: [],
      status: 'pending',
    },
  });
  reactivationDraftId = draft.id;
  await audit('reactivation.drafted', openDeal.id, { draftId: draft.id, smoke: true });
  console.log(JSON.stringify({ step: 'reactivation-draft-created', draftId: draft.id, dealId: openDeal.id }));
} else {
  console.log(JSON.stringify({ step: 'reactivation-draft-existing', draftId: reactivationDraftId, status: recentReactivation.status }));
}

// ----- Optional VM pipeline: send reactivation → consent → vm-1 -----
const runVm = process.env.RUN_VM_PIPELINE === 'true';
if (runVm && reactivationDraftId !== null) {
  const smokeEmail = process.env.SMOKE_TEST_EMAIL?.trim()
    ?? process.env.BRIEF_RECIPIENT?.trim()
    ?? '';
  if (smokeEmail !== '' && enrichment.ownerEmail === null) {
    enrichment = await prisma.enrichment.update({
      where: { leadId },
      data: { ownerEmail: smokeEmail },
    });
    console.log(JSON.stringify({ step: 'smoke-email-set', email: smokeEmail }));
  }
  await prisma.draft.update({
    where: { id: reactivationDraftId },
    data: { status: 'approved', approvedBy: 'smoke-test' },
  });
  await sendApprovedDraft(reactivationDraftId);

  const sent = await prisma.draft.findUnique({
    where: { id: reactivationDraftId },
    select: { status: true, sentAt: true },
  });
  console.log(JSON.stringify({ step: 'reactivation-sent', status: sent?.status, sentAt: sent?.sentAt }));

  if (sent?.status === 'sent-suppressed') {
    console.log(JSON.stringify({ step: 'vm-pipeline-skipped', reason: 'reactivation send suppressed — set ownerEmail on enrichment' }));
  } else {
    await prisma.lead.update({
      where: { id: leadId },
      data: { priorWrittenConsent: true, priorWrittenConsentAt: new Date() },
    });
    console.log(JSON.stringify({ step: 'consent-granted', leadId }));

    if (process.env.VM_AI_AUTO_SEND !== 'true') {
      console.log(JSON.stringify({ step: 'vm-note', hint: 'Set VM_AI_AUTO_SEND=true on cron/web to auto-dial' }));
    }

    await dropVoicemail(leadId, 'reactivation');
    const vmDraft = await prisma.draft.findFirst({
      where: { leadId, kind: 'voicemail', status: { in: ['pending', 'approved'] } },
      orderBy: { createdAt: 'desc' },
      select: { id: true, status: true },
    });
    console.log(JSON.stringify({ step: 'vm-draft', vmDraft }));

    if (vmDraft !== null && vmDraft.status === 'approved' && process.env.VM_AI_AUTO_SEND === 'true') {
      await sendApprovedDraft(vmDraft.id);
      const after = await prisma.draft.findUnique({
        where: { id: vmDraft.id },
        select: { status: true, twilioCallSid: true },
      });
      console.log(JSON.stringify({ step: 'vm-sent', after }));
    }
  }
}

const pending = await prisma.draft.findMany({
  where: { leadId, status: 'pending' },
  select: { id: true, kind: true },
});
console.log(JSON.stringify({ step: 'done', leadId, pendingInQueue: pending, renewalDraftId, reactivationDraftId }));

await prisma.$disconnect();
