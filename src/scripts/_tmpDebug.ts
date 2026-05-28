import 'dotenv/config';
import { PrismaPg } from '@prisma/adapter-pg';
import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient({
  adapter: new PrismaPg({ connectionString: process.env.DATABASE_URL ?? '' }),
});

const since = new Date(Date.now() - 30 * 60 * 60_000);
const cronTickRuns = await prisma.auditLog.findMany({
  where: { entity: 'cronTick', action: 'cron.success', createdAt: { gte: since } },
  orderBy: { createdAt: 'desc' },
  take: 20,
});
console.log('--- Last 20 cronTick.cron.success runs (last 30h) ---');
console.log(`Total cronTick runs: ${cronTickRuns.length}`);
for (const r of cronTickRuns.slice(0, 10)) {
  const meta = r.meta as { et?: { hour: number; minute: number; dateKey: string }; due?: string[]; results?: Array<{ name: string; ok: boolean; skipped?: boolean; error?: string }> } | null;
  const due = meta?.due ?? [];
  const fails = (meta?.results ?? []).filter((x) => !x.ok);
  console.log(`[${r.createdAt.toISOString()}] ET ${meta?.et?.dateKey} ${meta?.et?.hour}:${String(meta?.et?.minute).padStart(2, '0')} | due=[${due.join(',')}] fails=${JSON.stringify(fails)}`);
}

const allCron = await prisma.auditLog.findMany({
  where: { action: { in: ['cron.success', 'cron.failure'] }, createdAt: { gte: since } },
  orderBy: { createdAt: 'desc' },
});
console.log(`\n--- All cron audits in last 30h (${allCron.length}) ---`);
const byEntity = new Map<string, { ok: number; fail: number; latest: Date }>();
for (const r of allCron) {
  const cur = byEntity.get(r.entity) ?? { ok: 0, fail: 0, latest: r.createdAt };
  if (r.action === 'cron.success') cur.ok += 1;
  else cur.fail += 1;
  if (r.createdAt > cur.latest) cur.latest = r.createdAt;
  byEntity.set(r.entity, cur);
}
for (const [entity, s] of [...byEntity.entries()].sort()) {
  console.log(`${entity.padEnd(28)} ok=${s.ok} fail=${s.fail} latest=${s.latest.toISOString()}`);
}

console.log(`\n--- Last 15 failure audits (last 30h) ---`);
const failures = await prisma.auditLog.findMany({
  where: { action: { contains: 'failure' }, createdAt: { gte: since } },
  orderBy: { createdAt: 'desc' },
  take: 15,
});
for (const r of failures) {
  console.log(`[${r.createdAt.toISOString()}] ${r.action} entity=${r.entity} ${r.entityId ?? ''} meta=${JSON.stringify(r.meta).slice(0, 300)}`);
}

await prisma.$disconnect();
