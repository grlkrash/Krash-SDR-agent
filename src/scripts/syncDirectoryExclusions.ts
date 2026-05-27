// Cron entry (6:15 AM ET): scrape sobrietyselect.com/centers and auto-flag
// matching scraper leads so draftColdBatch skips them.

import 'dotenv/config';
import { PrismaPg } from '@prisma/adapter-pg';
import { PrismaClient } from '@prisma/client';
import { syncDirectoryListings } from '../pipeline/exclusions/syncDirectoryListings.js';

const prisma = new PrismaClient({
  adapter: new PrismaPg({ connectionString: process.env.DATABASE_URL ?? '' }),
});

try {
  const result = await syncDirectoryListings(prisma);
  await prisma.auditLog.create({
    data: {
      action: 'cron.success',
      entity: 'syncDirectoryExclusions',
      meta: result,
    },
  });
  console.log(JSON.stringify(result));
} catch (err) {
  const message = err instanceof Error ? err.message : String(err);
  await prisma.auditLog.create({
    data: {
      action: 'cron.failure',
      entity: 'syncDirectoryExclusions',
      meta: { error: message },
    },
  });
  throw err;
}
