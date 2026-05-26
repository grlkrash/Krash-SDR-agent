// One-off: verify the renewal-warning acceptance check.
// Looks up the AuditLog row for the staged deal, then fetches the
// associated Draft and asserts the body satisfies the spec.
//
// Prompt 9.2.1 acceptance criteria (revised):
//   - kind='renewal', status='pending'
//   - body references the renewal calendar date
//   - body references the facility name + city
//   - body contains NO dollar figure (price never reaches the model)
//   - body contains NO raw {placeholder} curly tokens — only the
//     [OPTIONAL: ...] bracket form is permitted, and it may be absent
//   - body offers two specific call times
//   - body word count in [60, 110] (target 70-80, with tolerance for an
//     optional bracket and the standard sign-off lines)
//
// Usage:
//   DEAL_ID="327014281936" npx tsx src/scripts/_tmpVerifyRenewalDraft.ts

import 'dotenv/config';
import { PrismaPg } from '@prisma/adapter-pg';
import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient({
  adapter: new PrismaPg({ connectionString: process.env.DATABASE_URL ?? '' }),
});

const dealId = process.env.DEAL_ID?.trim() ?? null;
if (dealId === null || dealId === '') throw new Error('Set DEAL_ID');

const drafted = await prisma.auditLog.findFirst({
  where: { action: 'renewalWarning.drafted', entityId: dealId },
  orderBy: { createdAt: 'desc' },
});
const runRow = await prisma.auditLog.findFirst({
  where: { action: 'renewalWarning.run' },
  orderBy: { createdAt: 'desc' },
});
const cronRow = await prisma.auditLog.findFirst({
  where: { action: 'cron.success', entity: 'renewalWarnings' },
  orderBy: { createdAt: 'desc' },
});

console.log('AuditLog rows:');
console.log('  drafted:', drafted === null ? 'MISSING' : JSON.stringify(drafted.meta));
console.log('  run:    ', runRow === null ? 'MISSING' : JSON.stringify(runRow.meta));
console.log('  cron:   ', cronRow === null ? 'MISSING' : JSON.stringify({ id: cronRow.id, createdAt: cronRow.createdAt.toISOString() }));

if (drafted === null) {
  console.log('\nFAIL: no renewalWarning.drafted audit row for this deal.');
  await prisma.$disconnect();
  process.exitCode = 1;
  throw new Error('no draft for deal');
}

const meta = drafted.meta as { draftId?: string; tier?: string; tierPrice?: number; leadId?: string };
const draftId = meta.draftId ?? '';
const draft = await prisma.draft.findUnique({ where: { id: draftId } });
if (draft === null) {
  console.log('FAIL: draftId from audit not found in Draft table.');
  await prisma.$disconnect();
  process.exitCode = 1;
  throw new Error('draft row missing');
}

const lead = await prisma.lead.findUnique({ where: { id: draft.leadId } });
if (lead === null) {
  console.log('FAIL: lead row missing for draft.');
  await prisma.$disconnect();
  process.exitCode = 1;
  throw new Error('lead row missing');
}

console.log('\nDraft row:');
console.log('  id:                ', draft.id);
console.log('  kind:              ', draft.kind);
console.log('  status:            ', draft.status);
console.log('  leadId:            ', draft.leadId);
console.log('  subject:           ', draft.subject);
console.log('\n--- Body ---\n');
console.log(draft.body);
console.log('\n--- End ---');

const MONTH_RE = /\b(January|February|March|April|May|June|July|August|September|October|November|December)\b/;
const DOLLAR_RE = /\$\s*\d|\b\d{1,3}(?:,\d{3})+\b/;
const RAW_PLACEHOLDER_RE = /\{[a-zA-Z_][a-zA-Z0-9_ -]*\}/;
// Two distinct "Day, Month Date(rd|th|st|nd)? at TIME" references is the
// simplest reliable proxy for "ends with two calendar options". The
// optional ordinal suffix matters: `27th` has no \b between `7` and `t`.
const DAY_TIME_RE = /\b(Mon|Tue|Tues|Wed|Thu|Thur|Thurs|Fri|Sat|Sun|Monday|Tuesday|Wednesday|Thursday|Friday|Saturday|Sunday)[a-z]*,?\s+\w+\s+\d{1,2}(?:st|nd|rd|th)?\s+at\s+\d{1,2}/gi;
const dayTimeHits = draft.body.match(DAY_TIME_RE) ?? [];

const wordCount = draft.body.trim().split(/\s+/).length;

// Subject is "meaningful" if it isn't empty and references the facility,
// the renewal month, or the word "renew*". The Prompt 9.2.1 spec doesn't
// mandate any specific token — confident subjects like "Families First of
// Florida — planning for July 2026" pass.
const subjectText = draft.subject ?? '';
const subjectMeaningful = subjectText.length > 0 && (
  subjectText.includes(lead.name) ||
  MONTH_RE.test(subjectText) ||
  /renew/i.test(subjectText)
);

const checks: Array<{ label: string; passed: boolean }> = [
  { label: "kind === 'renewal'", passed: draft.kind === 'renewal' },
  { label: "status === 'pending'", passed: draft.status === 'pending' },
  { label: 'subject is meaningful (facility, renewal month, or renew*)', passed: subjectMeaningful },
  { label: 'body references a calendar month (renewal date anchor)', passed: MONTH_RE.test(draft.body) },
  { label: 'body references facility name', passed: draft.body.includes(lead.name) },
  { label: 'body references city', passed: draft.body.includes(lead.city) },
  { label: 'body contains NO dollar figure', passed: !DOLLAR_RE.test(draft.body) },
  { label: 'body contains NO raw {placeholder} curly tokens', passed: !RAW_PLACEHOLDER_RE.test(draft.body) },
  { label: 'body offers two specific call times', passed: dayTimeHits.length >= 2 },
  { label: `body word count 60-110 (got ${wordCount}, target 70-80)`, passed: wordCount >= 60 && wordCount <= 110 },
];

console.log('\nAcceptance checks:');
let failed = 0;
for (const c of checks) {
  console.log(`  ${c.passed ? 'PASS' : 'FAIL'}  ${c.label}`);
  if (!c.passed) failed += 1;
}

console.log('\nObservability:');
console.log('  day/time hits in body:', JSON.stringify(dayTimeHits));
console.log('  word count:           ', wordCount);
const optionalHits = draft.body.match(/\[OPTIONAL:[^\]]*\]/g) ?? [];
console.log('  [OPTIONAL] brackets:  ', JSON.stringify(optionalHits));

await prisma.$disconnect();
if (failed > 0) {
  process.exitCode = 1;
  throw new Error(`${failed} check(s) failed`);
}
console.log('\nAll acceptance checks passed.');
