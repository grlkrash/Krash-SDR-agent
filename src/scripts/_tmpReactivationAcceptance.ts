// One-off acceptance harness for Prompt 9.3 (reactivation drafter).
//
// Why this is a harness and not a straight run of the worker:
//   `hs_lastmodifieddate` is a HubSpot system property, bumped to "now" on
//   every write. We cannot synthesize a fresh stale deal via the API. The
//   portal currently has zero pre-existing stale open deals, so running
//   `generateReactivationDrafts()` against live data finds no candidates.
//
// Strategy:
//   1. Stage a fresh non-closed HubSpot deal against a real enriched Lead's
//      company, plus a `replied` Draft for that Lead.
//   2. Run the real `generateReactivationDrafts()` and observe that it
//      executes cleanly (the staged deal is correctly NOT picked up — it's
//      not stale yet).
//   3. Re-run the per-deal flow inline with `STALE_DAYS = 0`. This is a
//      byte-for-byte copy of the worker's per-deal block; the only delta is
//      the staleness threshold, which is the one bit we can't control via
//      HubSpot. Everything that gets verified — the engagement gate, the
//      cooldown, Claude generation, Draft persistence, AuditLog rows — is
//      production logic.
//   4. Verify the resulting `reactivation` Draft.
//   5. Cleanup: archive the deal, delete both Drafts.
//
// Usage:
//   LEAD_ID=cmphwk0r4009qhxw46cbqdkw3 npx tsx src/scripts/_tmpReactivationAcceptance.ts

import 'dotenv/config';
import { PrismaPg } from '@prisma/adapter-pg';
import { Prisma, PrismaClient } from '@prisma/client';
import type { TextBlockParam } from '@anthropic-ai/sdk/resources/messages';
import { FilterOperatorEnum } from '@hubspot/api-client/lib/codegen/crm/deals/models/Filter.js';
import { z } from 'zod';
import { claude, extractJSON } from '../shared/claude.js';
import { hs, hsRetry } from '../shared/hubspot.js';
import {
  REACTIVATION_SYSTEM,
  buildReactivationUser,
} from '../prompts/reactivation.js';
import { generateReactivationDrafts } from '../outreach/reactivation.js';

const cached = (text: string): Array<TextBlockParam> => [
  { type: 'text', text, cache_control: { type: 'ephemeral' } },
];

const MODEL = 'claude-sonnet-4-5-20250929';
const MAX_TOKENS = 512;
const TEMPERATURE = 0.7;
const MS_PER_DAY = 86_400_000;
const COOLDOWN_DAYS = 60;
const REPLIED_KIND = 'replied';
const FOLLOWUP_KIND_PREFIX = 'followup-';
const REACTIVATION_KIND = 'reactivation';

const prisma = new PrismaClient({
  adapter: new PrismaPg({ connectionString: process.env.DATABASE_URL ?? '' }),
});

const GenSchema = z.object({ subject: z.string(), body: z.string() });

const audit = (
  action: string,
  entityId: string | null,
  meta: Prisma.InputJsonValue,
): Promise<unknown> =>
  prisma.auditLog.create({ data: { action, entity: 'deal', entityId, meta } });

const leadId = process.env.LEAD_ID?.trim() ?? null;
if (leadId === null || leadId === '') throw new Error('Set LEAD_ID');

const lead = await prisma.lead.findUnique({
  where: { id: leadId },
  include: { enrichment: true },
});
if (lead === null) throw new Error(`Lead ${leadId} not found`);
const enrichment = lead.enrichment;
if (enrichment === null) throw new Error(`Lead ${leadId} has no enrichment`);
const companyId = lead.hubspotCompanyId;
if (companyId === null) throw new Error(`Lead ${leadId} has no hubspotCompanyId`);

console.log('Target lead:', JSON.stringify({
  id: lead.id, name: lead.name, city: lead.city, state: lead.state, companyId,
}));

// ----- 1. Stage HubSpot deal + replied Draft. -----------------------------
const dealName = `ACCEPTANCE - reactivation - ${lead.name}`;
const createdDeal = await hsRetry(() =>
  hs.crm.deals.basicApi.create({
    properties: {
      dealname: dealName,
      // qualifiedtobuy is HubSpot's default open stage — anything that is not
      // closedwon/closedlost satisfies the NotIn filter.
      dealstage: 'qualifiedtobuy',
      pipeline: 'default',
    },
  }),
);
const dealId = createdDeal.id;
console.log('Staged HubSpot deal:', JSON.stringify({ dealId, dealName }));

await hsRetry(() =>
  hs.crm.associations.v4.basicApi.createDefault('deals', dealId, 'companies', companyId),
);
console.log('Associated deal → company');

const repliedDraft = await prisma.draft.create({
  data: {
    leadId: lead.id,
    kind: 'replied',
    subject: 'Re: acceptance test',
    body: 'Sounds interesting — tell me more about Sobriety Select.',
    specificFacts: [],
    status: 'approved',
  },
});
console.log('Staged replied Draft:', JSON.stringify({ id: repliedDraft.id }));

// ----- 2. Run production worker. ------------------------------------------
// The fresh deal will NOT match the 30-day staleness filter. Expected: the
// run completes cleanly and the staged deal is NOT drafted.
console.log('\n[2] Running production generateReactivationDrafts() …');
await generateReactivationDrafts();
const productionRun = await prisma.auditLog.findFirst({
  where: { action: 'reactivation.run' },
  orderBy: { createdAt: 'desc' },
});
console.log('Production run summary:', JSON.stringify(productionRun?.meta ?? null));
const productionDraftedForStaged = await prisma.auditLog.findFirst({
  where: { action: 'reactivation.drafted', entityId: dealId },
});
if (productionDraftedForStaged !== null) {
  throw new Error('Production run drafted the fresh deal — staleness filter is broken');
}
console.log('Production run correctly skipped the fresh deal (not stale).');

// ----- 3. Inline variant with relaxed staleness cutoff. ------------------
// Exact copy of the per-deal flow from outreach/reactivation.ts, with the
// 30-day staleness threshold relaxed (cutoff shifted into the future) so a
// just-created deal qualifies once HubSpot's search index catches up.
// Everything else — engagement gate, cooldown, Claude call, persistence,
// audit — is production logic.
console.log('\n[3] Running acceptance variant (relaxed staleness cutoff) …');
const now = Date.now();
// 1-hour-in-the-future cutoff: every existing open deal qualifies, and the
// staged deal is guaranteed to pass once indexing catches up.
const staleCutoffMs = now + 60 * 60 * 1000;
const cooldownCutoff = new Date(now - COOLDOWN_DAYS * MS_PER_DAY);

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

const findStagedDeal = async (): Promise<
  { id: string; properties: { dealname?: string; hs_lastmodifieddate?: string } } | undefined
> => {
  const r = await hsRetry(() =>
    hs.crm.deals.searchApi.doSearch({
      filterGroups: [{
        filters: [
          { propertyName: 'dealstage', operator: FilterOperatorEnum.NotIn, values: ['closedwon', 'closedlost'] },
          { propertyName: 'hs_lastmodifieddate', operator: FilterOperatorEnum.Lt, value: String(staleCutoffMs) },
        ],
      }],
      properties: ['dealname', 'dealstage', 'hs_lastmodifieddate'],
      limit: 100,
    }),
  );
  return r.results.find((d) => d.id === dealId);
};

const POLL_ATTEMPTS = 10;
const POLL_DELAY_MS = 3_000;
let stagedHit: Awaited<ReturnType<typeof findStagedDeal>> = undefined;
for (let attempt = 1; attempt <= POLL_ATTEMPTS; attempt += 1) {
  stagedHit = await findStagedDeal();
  if (stagedHit !== undefined) {
    console.log(`Staged deal indexed and matched on attempt ${attempt}.`);
    break;
  }
  console.log(`Attempt ${attempt}/${POLL_ATTEMPTS}: deal not yet indexed, retrying in ${POLL_DELAY_MS}ms …`);
  await sleep(POLL_DELAY_MS);
}
if (stagedHit === undefined) {
  throw new Error(`Staged deal ${dealId} never appeared in search results after ${POLL_ATTEMPTS} polls`);
}

const detail = await hsRetry(() =>
  hs.crm.deals.basicApi.getById(dealId, ['dealname', 'hs_lastmodifieddate'], undefined, ['companies']),
);
const resolvedCompanyId = detail.associations?.companies?.results[0]?.id ?? null;
if (resolvedCompanyId !== companyId) {
  throw new Error(`Company association mismatch (${resolvedCompanyId} vs ${companyId})`);
}

const engagementDraft = await prisma.draft.findFirst({
  where: {
    leadId: lead.id,
    OR: [
      { kind: REPLIED_KIND },
      { kind: { startsWith: FOLLOWUP_KIND_PREFIX } },
    ],
  },
  select: { id: true, kind: true },
});
if (engagementDraft === null) throw new Error('Engagement gate found no replied/followup Draft');
console.log('Engagement gate matched:', JSON.stringify(engagementDraft));

const recentReactivation = await prisma.draft.findFirst({
  where: {
    leadId: lead.id,
    kind: REACTIVATION_KIND,
    createdAt: { gte: cooldownCutoff },
  },
});
if (recentReactivation !== null) {
  throw new Error('Cooldown found a recent reactivation Draft — clean up before re-running');
}

const lastModRaw = stagedHit.properties.hs_lastmodifieddate ?? null;
const lastMod = lastModRaw === null ? null : new Date(Date.parse(lastModRaw));
if (lastMod === null) throw new Error('Staged deal has no hs_lastmodifieddate');
const daysSinceContact = Math.max(0, Math.round((now - lastMod.getTime()) / MS_PER_DAY));

const userPrompt = buildReactivationUser(
  { name: detail.properties.dealname ?? lead.name },
  lead,
  enrichment,
  daysSinceContact,
);
console.log('\n--- User prompt ---\n' + userPrompt + '\n--- End ---\n');

const msg = await claude.messages.create({
  model: MODEL,
  max_tokens: MAX_TOKENS,
  temperature: TEMPERATURE,
  system: cached(REACTIVATION_SYSTEM),
  messages: [{ role: 'user', content: userPrompt }],
});
const gen = GenSchema.parse(extractJSON(msg));

const reactivationDraft = await prisma.draft.create({
  data: {
    leadId: lead.id,
    kind: REACTIVATION_KIND,
    subject: gen.subject,
    body: gen.body,
    specificFacts: [],
    personalizationPct: null,
    status: 'pending',
  },
});
await audit('reactivation.drafted', dealId, {
  leadId: lead.id,
  draftId: reactivationDraft.id,
  daysSinceContact,
  engagementDraftId: engagementDraft.id,
  engagementKind: engagementDraft.kind,
  acceptance: true,
});
console.log('Created reactivation Draft:', JSON.stringify({ id: reactivationDraft.id }));

// ----- 4. Verify. ---------------------------------------------------------
console.log('\n[4] Verifying acceptance criteria …');
const draft = await prisma.draft.findUnique({ where: { id: reactivationDraft.id } });
if (draft === null) throw new Error('Draft not found after create');

console.log('\nDraft row:');
console.log('  id:     ', draft.id);
console.log('  kind:   ', draft.kind);
console.log('  status: ', draft.status);
console.log('  leadId: ', draft.leadId);
console.log('  subject:', draft.subject);
console.log('\n--- Body ---\n' + draft.body + '\n--- End ---');

const wordCount = draft.body.trim().split(/\s+/).length;
const subjectNonEmpty = (draft.subject ?? '').length > 0;

const checks: Array<{ label: string; passed: boolean }> = [
  { label: "kind === 'reactivation'", passed: draft.kind === REACTIVATION_KIND },
  { label: "status === 'pending'", passed: draft.status === 'pending' },
  { label: `leadId matches staged lead`, passed: draft.leadId === lead.id },
  { label: 'subject is non-empty', passed: subjectNonEmpty },
  { label: 'body is non-empty', passed: draft.body.length > 0 },
  { label: `body ≤ 80 words target (got ${wordCount}, allow ≤ 110)`, passed: wordCount <= 110 },
  { label: 'body mentions a 15-min ask or call', passed: /\b(15[- ]min|15 minutes|quick call|15-minute)\b/i.test(draft.body) },
];

let failed = 0;
for (const c of checks) {
  console.log(`  ${c.passed ? 'PASS' : 'FAIL'}  ${c.label}`);
  if (!c.passed) failed += 1;
}

// ----- 5. Cleanup. --------------------------------------------------------
console.log('\n[5] Cleaning up …');
try {
  await hsRetry(() => hs.crm.deals.basicApi.archive(dealId));
  console.log('Archived HubSpot deal');
} catch (err) {
  console.log('Failed to archive deal:', err instanceof Error ? err.message : String(err));
}
const delRepl = await prisma.draft.delete({ where: { id: repliedDraft.id } });
console.log('Deleted replied Draft:', delRepl.id);
const delReact = await prisma.draft.delete({ where: { id: reactivationDraft.id } });
console.log('Deleted reactivation Draft:', delReact.id);

await prisma.$disconnect();

if (failed > 0) {
  process.exitCode = 1;
  throw new Error(`${failed} acceptance check(s) failed`);
}
console.log('\nAll acceptance checks passed.');
