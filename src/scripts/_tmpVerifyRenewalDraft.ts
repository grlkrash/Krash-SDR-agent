// One-off: verify the renewal-warning acceptance check.
// Looks up the AuditLog row for the staged deal, then fetches the
// associated Draft and asserts the body satisfies the spec.
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

console.log('\nDraft row:');
console.log('  id:                ', draft.id);
console.log('  kind:              ', draft.kind);
console.log('  status:            ', draft.status);
console.log('  leadId:            ', draft.leadId);
console.log('  subject:           ', draft.subject);
console.log('\n--- Body ---\n');
console.log(draft.body);
console.log('\n--- End ---');

const checks: Array<{ label: string; passed: boolean }> = [
  { label: "kind === 'renewal'", passed: draft.kind === 'renewal' },
  { label: "status === 'pending'", passed: draft.status === 'pending' },
  { label: 'body contains "$2,400"', passed: draft.body.includes('$2,400') },
  { label: 'body contains a "select" tier mention', passed: /select/i.test(draft.body) },
  { label: 'body contains a literal "{placeholder}" token', passed: /\{[a-zA-Z_][a-zA-Z0-9_ -]*\}/.test(draft.body) },
];

console.log('\nAcceptance checks:');
let failed = 0;
for (const c of checks) {
  console.log(`  ${c.passed ? 'PASS' : 'FAIL'}  ${c.label}`);
  if (!c.passed) failed += 1;
}

await prisma.$disconnect();
if (failed > 0) {
  process.exitCode = 1;
  throw new Error(`${failed} check(s) failed`);
}
console.log('\nAll acceptance checks passed.');
