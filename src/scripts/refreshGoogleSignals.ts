// tsx src/scripts/refreshGoogleSignals.ts
//
// Cron entry (Mondays 4:00 AM ET): refresh Places ratings and re-run hiring
// Serper queries for the top 100 open deals. PRD §9.12 (refreshIntentSignals).

import 'dotenv/config';
import { PrismaPg } from '@prisma/adapter-pg';
import { PrismaClient } from '@prisma/client';
import { refreshIntentSignals } from '../pipeline/refreshIntentSignals.js';

const prisma = new PrismaClient({
  adapter: new PrismaPg({ connectionString: process.env.DATABASE_URL ?? '' }),
});

try {
  const summary = await refreshIntentSignals(prisma);
  await prisma.auditLog.create({
    data: {
      action: 'cron.success',
      entity: 'refreshGoogleSignals',
      meta: summary,
    },
  });
  console.log(JSON.stringify({ ok: true, ...summary }));
} catch (err) {
  const message = err instanceof Error ? err.message : String(err);
  await prisma.auditLog.create({
    data: {
      action: 'cron.failure',
      entity: 'refreshGoogleSignals',
      meta: { error: message },
    },
  });
  throw err;
}
