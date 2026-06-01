// Seeds four operator smoke-test leads — one per queue lane — so Sonia can
// exercise cold send → reply → daily brief, renewal call queue + prep brief,
// and reactivation without colliding on a single SMOKE_TEST_LEAD_ID row.
//
// Usage:
//   npx tsx src/scripts/seedSmokeTestLanes.ts
//
// Optional env:
//   SMOKE_TEST_EMAIL     — ownerEmail on all lanes (default: BRIEF_RECIPIENT)
//   SMOKE_TEST_PHONE     — E.164 or US local (default: SONIA_PHONE)
//   FORCE_RESET=true     — reject pending smoke drafts before re-seeding
//   SEND_COLD=true       — approve + send the cold-lane draft after seeding
//   SEND_RENEWAL=true    — approve + send the renewal-lane draft after seeding

import 'dotenv/config';
import { PrismaPg } from '@prisma/adapter-pg';
import { Prisma, PrismaClient } from '@prisma/client';
import { hs, hsRetry } from '../shared/hubspot.js';
import { upsertLead } from '../shared/lead.js';
import { syncLeadToHubspot } from '../pipeline/hubspotSync.js';
import { appendPostSalePhoneFooter } from '../shared/phoneConsentFooter.js';
import { sendApprovedDraft } from '../outreach/sender.js';

const MS_PER_DAY = 86_400_000;
const SMOKE_PREFIX = 'SMOKE ';

const prisma = new PrismaClient({
  adapter: new PrismaPg({ connectionString: process.env.DATABASE_URL ?? '' }),
});

const smokeEmail = (): string => {
  const raw = process.env.SMOKE_TEST_EMAIL?.trim()
    ?? process.env.BRIEF_RECIPIENT?.trim()
    ?? '';
  if (raw === '') throw new Error('Set SMOKE_TEST_EMAIL or BRIEF_RECIPIENT');
  return raw;
};

const smokePhone = (): string => {
  const raw = process.env.SMOKE_TEST_PHONE?.trim()
    ?? process.env.SONIA_PHONE?.trim()
    ?? '+15135550101';
  return raw;
};

const publicUrl = (): string =>
  (process.env.PUBLIC_URL ?? 'http://localhost:3000').replace(/\/+$/, '');

const queuePw = (): string => process.env.QUEUE_PASSWORD?.trim() ?? '';

type LaneKind = 'cold' | 'renewal' | 'reactivation' | 'reply';

type LaneDef = {
  kind: LaneKind;
  name: string;
  street: string;
  city: string;
  state: string;
  zip: string;
  website: string;
};

const LANES: LaneDef[] = [
  {
    kind: 'cold',
    name: `${SMOKE_PREFIX}Cold Test Recovery LLC`,
    street: '100 Cold Smoke Test Blvd',
    city: 'Austin',
    state: 'TX',
    zip: '78701',
    website: 'https://www.smokecoldtest.com',
  },
  {
    kind: 'renewal',
    name: `${SMOKE_PREFIX}Renewal Test Recovery LLC`,
    street: '200 Renewal Smoke Test Dr',
    city: 'Columbus',
    state: 'OH',
    zip: '43215',
    website: 'https://www.smokerenewaltest.com',
  },
  {
    kind: 'reactivation',
    name: `${SMOKE_PREFIX}Reactivation Test Recovery LLC`,
    street: '300 Reactivation Smoke Test Way',
    city: 'Denver',
    state: 'CO',
    zip: '80202',
    website: 'https://www.smokereactivationtest.com',
  },
  {
    kind: 'reply',
    name: `${SMOKE_PREFIX}Reply Test Recovery LLC`,
    street: '400 Reply Smoke Test Ave',
    city: 'Phoenix',
    state: 'AZ',
    zip: '85004',
    website: 'https://www.smokereplytest.com',
  },
];

const audit = (
  action: string,
  entityId: string | null,
  meta: Prisma.InputJsonValue,
): Promise<unknown> =>
  prisma.auditLog.create({ data: { action, entity: 'seedSmokeTestLanes', entityId, meta } });

const enrichmentFields = (ownerEmail: string) => ({
  ownerName: 'Mark Thompson',
  ownerTitle: 'Executive Director',
  ownerEmail,
  ownerLinkedIn: 'https://linkedin.com/in/smoke-test-mark',
  teamSizeSignal: '12–25 beds',
  expectedProduct: 'select',
  painPoints: [
    'Families cannot find IOP page in search',
    'Intake coordinator role open 60+ days',
    'No listing on competing directories',
  ],
  signals: {
    hiring: ['Intake Coordinator', 'Admissions Counselor'],
    missingCompetingDirectories: ['Psychology Today', 'Rehab.com'],
    expansion: 'Adding outpatient track Q3',
  },
  legitscriptStatus: 'verified',
  evidenceQuote: 'We meet families where they are — private pay and insurance.',
});

const findOpenDraft = async (leadId: string, kind: string) =>
  prisma.draft.findFirst({
    where: { leadId, kind, status: { in: ['pending', 'approved'] } },
    orderBy: { createdAt: 'desc' },
    select: { id: true },
  });

const findRecentReplied = async (leadId: string) =>
  prisma.draft.findFirst({
    where: {
      leadId,
      kind: 'replied',
      createdAt: { gte: new Date(Date.now() - MS_PER_DAY) },
    },
    orderBy: { createdAt: 'desc' },
    select: { id: true },
  });

const resetSmokeDrafts = async (leadId: string): Promise<number> => {
  const result = await prisma.draft.updateMany({
    where: { leadId, status: { in: ['pending', 'approved'] } },
    data: { status: 'rejected', rejectReason: 'smoke-lanes-reset' },
  });
  return result.count;
};

const ensureEnrichment = async (leadId: string, ownerEmail: string) => {
  await prisma.enrichment.upsert({
    where: { leadId },
    create: { leadId, ...enrichmentFields(ownerEmail) },
    update: {
      ownerEmail,
      ownerName: 'Mark Thompson',
      ownerTitle: 'Executive Director',
      expectedProduct: 'select',
    },
  });
};

const ensureHubSpot = async (leadId: string): Promise<string> => {
  const lead = await prisma.lead.findUnique({ where: { id: leadId } });
  if (lead?.hubspotCompanyId !== null && lead?.hubspotCompanyId !== undefined) {
    return lead.hubspotCompanyId;
  }
  const synced = await syncLeadToHubspot(leadId);
  return synced.companyId;
};

const createDeal = async (
  lane: LaneDef,
  companyId: string,
  leadId: string,
  existingDealId: string | null,
): Promise<string> => {
  if (existingDealId !== null && existingDealId !== '') {
    try {
      await hsRetry(() => hs.crm.deals.basicApi.getById(existingDealId, ['dealname']));
      return existingDealId;
    } catch {
      // stale id — create fresh below
    }
  }
  const isRenewal = lane.kind === 'renewal';
  const created = await hsRetry(() =>
    hs.crm.deals.basicApi.create({
      properties: {
        dealname: `${lane.kind.toUpperCase()} — ${lane.name}`,
        dealstage: isRenewal ? 'closedwon' : 'qualifiedtobuy',
        pipeline: 'default',
        ss_product_type: 'select',
        ...(isRenewal
          ? {
              ss_renewal_date: new Date(Date.now() + 60 * MS_PER_DAY).toISOString().slice(0, 10),
              ss_contract_term_months: '12',
              closedate: new Date(Date.now() - 305 * MS_PER_DAY).toISOString().slice(0, 10),
              amount: '2400',
            }
          : { amount: '2400' }),
      },
    }),
  );
  await hsRetry(() =>
    hs.crm.associations.v4.basicApi.createDefault('deals', created.id, 'companies', companyId),
  );
  await prisma.lead.update({
    where: { id: leadId },
    data: {
      sourceMeta: {
        smokeLane: lane.kind,
        smokeDealId: created.id,
        seededAt: new Date().toISOString(),
      },
    },
  });
  return created.id;
};

type LaneResult = {
  kind: LaneKind;
  leadId: string;
  name: string;
  dealId: string;
  companyId: string;
  drafts: Record<string, string | null>;
  urls: Record<string, string>;
};

const seedLane = async (lane: LaneDef, ownerEmail: string, phone: string): Promise<LaneResult> => {
  const lead = await upsertLead({
    source: 'gmaps',
    name: lane.name,
    street: lane.street,
    city: lane.city,
    state: lane.state,
    zip: lane.zip,
    phone,
    website: lane.website,
    googleRating: 4.6,
    googleReviews: 42,
    services: ['Residential', 'IOP', 'Detox'],
    sourceMeta: { smokeLane: lane.kind, seededAt: new Date().toISOString() },
  });

  if (process.env.FORCE_RESET === 'true') {
    const n = await resetSmokeDrafts(lead.id);
    console.log(JSON.stringify({ step: 'reset', kind: lane.kind, leadId: lead.id, rejected: n }));
  }

  await ensureEnrichment(lead.id, ownerEmail);
  const companyId = await ensureHubSpot(lead.id);
  const meta = lead.sourceMeta as { smokeDealId?: string } | null;
  const dealId = await createDeal(lane, companyId, lead.id, meta?.smokeDealId ?? null);

  const drafts: Record<string, string | null> = {
    cold: null,
    renewal: null,
    reactivation: null,
    replied: null,
    sentCold: null,
  };

  if (lane.kind === 'cold') {
    const existing = await findOpenDraft(lead.id, 'cold');
    if (existing !== null) {
      drafts.cold = existing.id;
    } else {
      const draft = await prisma.draft.create({
      data: {
        leadId: lead.id,
        kind: 'cold',
        subject: `${lane.name} — why ${lane.city} families aren't finding your IOP`,
        body: [
          'Mark,',
          '',
          `Families in ${lane.city} are searching for IOP right now. While reviewing local providers, two things stood out on your ${lane.name} site: the IOP page has no schema markup, and you're not listed on Psychology Today. Both make it harder for searching families to find you.`,
          '',
          'Sobriety Select helps families searching for care find centers like yours. Worth 15 minutes to walk through it? I can do Tuesday at 2:00 PM CT or Thursday at 10:00 AM CT.',
          '',
          'Sonia',
        ].join('\n'),
        specificFacts: [`${lane.city} IOP search`, 'missing Psychology Today listing'],
        status: 'pending',
      },
    });
    drafts.cold = draft.id;
    await audit('smoke.cold-drafted', draft.id, { leadId: lead.id, dealId });
    }
  }

  if (lane.kind === 'renewal') {
    const existing = await findOpenDraft(lead.id, 'renewal');
    if (existing !== null) {
      drafts.renewal = existing.id;
    } else {
    const body = appendPostSalePhoneFooter(
      [
        'Mark,',
        '',
        `Your renewal for ${lane.name} is coming up, and I wanted to reach out early to make sure there's no gap in coverage for the families you serve.`,
        '',
        "It's been a good run together, and I'd like to keep it going into the next contract period.",
        '',
        'Can you do Tuesday at 2:00 PM ET or Thursday at 10:00 AM ET for a quick call?',
        '',
        'Talk soon,',
        'Sonia',
      ].join('\n'),
      lead.id,
      { priorWrittenConsent: false },
    );
    const draft = await prisma.draft.create({
      data: {
        leadId: lead.id,
        kind: 'renewal',
        subject: `${lane.name} — renewal check-in (smoke test)`,
        body,
        specificFacts: [],
        status: 'pending',
      },
    });
    drafts.renewal = draft.id;
    await audit('smoke.renewal-drafted', draft.id, { leadId: lead.id, dealId });
    }
  }

  if (lane.kind === 'reactivation') {
    const existing = await findOpenDraft(lead.id, 'reactivation');
    if (existing !== null) {
      drafts.reactivation = existing.id;
    } else {
    const draft = await prisma.draft.create({
      data: {
        leadId: lead.id,
        kind: 'reactivation',
        subject: `Re: ${lane.name} — still helping families find you?`,
        body: [
          'Mark,',
          '',
          `It's been about five weeks since we last connected about ${lane.name}. Intake teams in ${lane.state} are still seeing strong private-pay search volume — wanted to see if timing is better now.`,
          '',
          'Open to a quick call this week?',
          '',
          'Sonia',
        ].join('\n'),
        specificFacts: [],
        status: 'pending',
      },
    });
    drafts.reactivation = draft.id;
    await audit('smoke.reactivation-drafted', draft.id, { leadId: lead.id, dealId });
    }
  }

  if (lane.kind === 'reply') {
    const existingReplied = await findRecentReplied(lead.id);
    if (existingReplied !== null) {
      drafts.replied = existingReplied.id;
      const sent = await prisma.draft.findFirst({
        where: { leadId: lead.id, kind: 'cold', status: 'sent' },
        orderBy: { sentAt: 'desc' },
        select: { id: true },
      });
      drafts.sentCold = sent?.id ?? null;
    } else {
    const sentCold = await prisma.draft.create({
      data: {
        leadId: lead.id,
        kind: 'cold',
        subject: `${lane.name} — quick question about intake visibility`,
        body: [
          'Mark,',
          '',
          'Noticed your facility ranks below two competitors for "IOP near me" in Phoenix — families may be missing you.',
          '',
          'Worth a 15-min look?',
          '',
          'Sonia',
        ].join('\n'),
        specificFacts: ['Phoenix IOP visibility'],
        status: 'sent',
        sentAt: new Date(Date.now() - 2 * MS_PER_DAY),
      },
    });
    drafts.sentCold = sentCold.id;

    const replied = await prisma.draft.create({
      data: {
        leadId: lead.id,
        kind: 'replied',
        subject: `Re: ${lane.name} — quick question about intake visibility`,
        body: 'Yes — Thursday at 10am works. Can you send a prep doc before the call?',
        specificFacts: [],
        status: 'pending',
      },
    });
    drafts.replied = replied.id;
    await prisma.auditLog.create({
      data: {
        action: 'reply.draft-created',
        entity: 'Draft',
        entityId: replied.id,
        meta: {
          leadId: lead.id,
          receivedAt: new Date().toISOString(),
          inboundSnippet: 'Yes — Thursday at 10am works. Can you send a prep doc before the call?',
          smoke: true,
        },
      },
    });
    await audit('smoke.reply-drafted', replied.id, { leadId: lead.id, dealId });
    }
  }

  const pw = queuePw();
  const pwQ = pw === '' ? '' : `?pw=${encodeURIComponent(pw)}`;
  const base = publicUrl();

  return {
    kind: lane.kind,
    leadId: lead.id,
    name: lane.name,
    dealId,
    companyId,
    drafts,
    urls: {
      queue: `${base}/queue${pwQ}`,
      prepBrief: `${base}/prep-brief/${dealId}${pwQ}`,
      prepBriefEmail: `${base}/prep-brief/${dealId}${pwQ}${pwQ === '' ? '?' : '&'}send=email`,
      renewalsCall: `${base}/renewals-call${pwQ}`,
    },
  };
};

const email = smokeEmail();
const phone = smokePhone();
const results: LaneResult[] = [];

for (const lane of LANES) {
  results.push(await seedLane(lane, email, phone));
}

if (process.env.SEND_COLD === 'true') {
  const cold = results.find((r) => r.kind === 'cold');
  const draftId = cold?.drafts.cold ?? null;
  if (draftId !== null) {
    await prisma.draft.update({ where: { id: draftId }, data: { status: 'approved', approvedBy: 'smoke-lanes' } });
    await sendApprovedDraft(draftId);
    console.log(JSON.stringify({ step: 'cold-sent', draftId }));
  }
}

if (process.env.SEND_RENEWAL === 'true') {
  const renewal = results.find((r) => r.kind === 'renewal');
  const draftId = renewal?.drafts.renewal ?? null;
  if (draftId !== null) {
    await prisma.draft.update({ where: { id: draftId }, data: { status: 'approved', approvedBy: 'smoke-lanes' } });
    await sendApprovedDraft(draftId);
    console.log(JSON.stringify({ step: 'renewal-sent', draftId }));
  }
}

console.log('\n=== Smoke test lanes seeded ===\n');
for (const r of results) {
  console.log(`${r.kind.toUpperCase()} — ${r.name}`);
  console.log(`  leadId:    ${r.leadId}`);
  console.log(`  dealId:    ${r.dealId}`);
  console.log(`  drafts:    ${JSON.stringify(r.drafts)}`);
  console.log(`  prep brief (browser): ${r.urls.prepBrief}`);
  console.log(`  prep brief (email):   ${r.urls.prepBriefEmail}`);
  console.log('');
}

console.log('Next steps:');
console.log('  1. Open /queue — filter by lane (Cold / Post-sale / Replies)');
console.log('  2. Reply lane already has a pending replied draft → run: npx tsx src/scripts/sendDailyBrief.ts');
console.log('  3. Cold lane: approve pending cold → sendApproved → reply from your inbox to test live replyWatcher');
console.log('  4. Renewal lane: approve + send → appears on /renewals-call after flagRenewalForCall');
console.log('  5. Set SMOKE_TEST_LEAD_ID to the cold leadId if testing Twilio VM bypass');
console.log(`\nSuggested: SMOKE_TEST_LEAD_ID=${results.find((r) => r.kind === 'cold')?.leadId ?? ''}`);

await prisma.$disconnect();
