// One-off: draft a cold email for ONE named lead and print it.
// Lets you read a single draft without spending a full batch.
//
// Usage:
//   LEAD_NAME="Aspire"           npx tsx src/scripts/_tmpDraftOne.ts
//   LEAD_ID="cmphwjr...."        npx tsx src/scripts/_tmpDraftOne.ts
//
// If a non-rejected draft already exists, the persisted version is printed
// instead of generating a duplicate (matches draftColdEmail's behavior).
// A leak-scan at the end checks the body for $-amounts, pricing words,
// per-year/month framing, and capitalized tier names — these are the
// patterns the data-leak fix in src/prompts/coldEmail.ts is meant to prevent.

import 'dotenv/config';
import { PrismaPg } from '@prisma/adapter-pg';
import { PrismaClient } from '@prisma/client';
import { draftColdEmail } from '../outreach/draftCold.js';

const prisma = new PrismaClient({
  adapter: new PrismaPg({ connectionString: process.env.DATABASE_URL ?? '' }),
});

const LEAD_ID = process.env.LEAD_ID?.trim() ?? null;
const LEAD_NAME = process.env.LEAD_NAME?.trim() ?? null;

if (LEAD_ID === null && LEAD_NAME === null) {
  throw new Error('Set LEAD_ID or LEAD_NAME env var');
}

const lead = LEAD_ID !== null
  ? await prisma.lead.findUnique({
      where: { id: LEAD_ID },
      include: { enrichment: true },
    })
  : await prisma.lead.findFirst({
      where: {
        name: { contains: LEAD_NAME ?? '', mode: 'insensitive' },
        enrichment: { isNot: null },
      },
      include: { enrichment: true },
      orderBy: { googleReviews: 'desc' },
    });

if (lead === null) throw new Error(`No lead found for ${LEAD_ID ?? LEAD_NAME}`);
if (lead.enrichment === null) throw new Error(`Lead ${lead.id} has no enrichment`);

console.log(`Lead:  ${lead.name} (${lead.city}, ${lead.state})`);
console.log(`Id:    ${lead.id}`);
console.log(`Tier:  ${lead.enrichment.expectedProduct ?? '(unknown)'}  [internal — must NEVER appear in the email]`);
console.log('');

const existing = await prisma.draft.findFirst({
  where: { leadId: lead.id, kind: 'cold', status: { not: 'rejected' } },
  orderBy: { createdAt: 'desc' },
});

let subject: string | null;
let body: string;
let pct: number | null;
let specificFacts: string[];

if (existing !== null) {
  console.log('[non-rejected cold draft already exists — printing persisted version, no new LLM call]\n');
  subject = existing.subject;
  body = existing.body;
  pct = existing.personalizationPct;
  specificFacts = existing.specificFacts;
} else {
  const draftId = await draftColdEmail(lead.id);
  if (draftId === null) {
    console.log('draftColdEmail returned null (no email, suppressed, or score-too-low). See AuditLog for reason.');
    await prisma.$disconnect();
    throw new Error('no draft produced');
  }
  const draft = await prisma.draft.findUnique({ where: { id: draftId } });
  if (draft === null) throw new Error('draft missing after create');
  subject = draft.subject;
  body = draft.body;
  pct = draft.personalizationPct;
  specificFacts = draft.specificFacts;
}

console.log(`Subject:         ${subject ?? '(none)'}`);
console.log(`Personalization: ${pct ?? '(none)'}%`);
console.log(`Specific facts:  ${JSON.stringify(specificFacts)}`);
console.log(`\n--- Body ---\n${body}\n--- End ---\n`);

const LEAK_PATTERNS: Array<{ label: string; rx: RegExp }> = [
  { label: 'dollar amount', rx: /\$\s?\d/ },
  { label: 'pricing word', rx: /\b(?:price|pricing|cost|costs|fee|fees|dollars?|USD)\b/i },
  { label: 'per-year/month framing', rx: /\b\d[\d,]*\s*(?:\/\s*(?:yr|mo|year|month)|per\s+(?:year|month))\b/i },
  { label: 'capitalized tier name', rx: /\b(?:Claimed|Select|Premium)\b/ },
];

const hits = LEAK_PATTERNS.flatMap((p) => {
  const m = body.match(p.rx);
  return m === null ? [] : [{ label: p.label, match: m[0] }];
});

if (hits.length === 0) {
  console.log('LEAK SCAN: clean — no price / commission / tier-name patterns in body.');
} else {
  console.log('LEAK SCAN: FAILED — the following patterns appeared in the body:');
  for (const h of hits) console.log(`  - ${h.label}: "${h.match}"`);
  process.exitCode = 1;
}

await prisma.$disconnect();
