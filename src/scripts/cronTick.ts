// Railway cron entry — runs every 5 min (UTC), dispatches due PRD §9.1 jobs in ET.
// One cron service replaces 14 separate Render cron services (cheaper on Railway).

import 'dotenv/config';
import { PrismaPg } from '@prisma/adapter-pg';
import { PrismaClient } from '@prisma/client';
import { CRON_JOBS, getEtClock, isDueNow } from '../shared/cronSchedule.js';

const INTERVAL_SLACK_MS = 30_000;

const prisma = new PrismaClient({
  adapter: new PrismaPg({ connectionString: process.env.DATABASE_URL ?? '' }),
});

const ranSince = async (entity: string, since: Date): Promise<boolean> => {
  const row = await prisma.auditLog.findFirst({
    where: { action: 'cron.success', entity, createdAt: { gte: since } },
    select: { id: true },
  });
  return row !== null;
};

const startOfEtDayUtc = (dateKey: string): Date => {
  // dateKey is YYYY-MM-DD in America/New_York — approximate midnight ET as 04:00 UTC (EDT).
  return new Date(`${dateKey}T04:00:00.000Z`);
};

const shouldSkip = async (
  job: (typeof CRON_JOBS)[number],
  dateKey: string,
): Promise<boolean> => {
  if (job.kind === 'interval') {
    const intervalMs = (job.intervalMinutes ?? 0) * 60_000 - INTERVAL_SLACK_MS;
    if (intervalMs <= 0) return true;
    return ranSince(job.name, new Date(Date.now() - intervalMs));
  }
  return ranSince(job.name, startOfEtDayUtc(dateKey));
};

const clock = getEtClock(new Date());
const due = CRON_JOBS.filter((job) => isDueNow(job, clock));

const results: Array<{ name: string; ok: boolean; error?: string; skipped?: boolean }> = [];

for (const job of due) {
  if (await shouldSkip(job, clock.dateKey)) {
    results.push({ name: job.name, ok: true, skipped: true });
    continue;
  }

  try {
    await import(job.modulePath);
    results.push({ name: job.name, ok: true });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    results.push({ name: job.name, ok: false, error: message });
    await prisma.auditLog.create({
      data: {
        action: 'cron.failure',
        entity: job.name,
        meta: { error: message, source: 'cronTick' },
      },
    });
  }
}

await prisma.auditLog.create({
  data: {
    action: 'cron.success',
    entity: 'cronTick',
    meta: { et: clock, due: due.map((j) => j.name), results },
  },
});

console.log(JSON.stringify({ ok: true, et: clock, ran: results }));
