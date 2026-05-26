// One-off: confirm the prep-brief Draft + AuditLog row landed after the
// acceptance run. Read-only.

import 'dotenv/config';
import { PrismaPg } from '@prisma/adapter-pg';
import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient({
  adapter: new PrismaPg({ connectionString: process.env.DATABASE_URL ?? '' }),
});

const drafts = await prisma.draft.findMany({
  where: { kind: 'prep-brief' },
  orderBy: { createdAt: 'desc' },
  take: 3,
  select: { id: true, leadId: true, subject: true, status: true, sentAt: true, createdAt: true },
});
console.log('drafts:', JSON.stringify(drafts, null, 2));

const audits = await prisma.auditLog.findMany({
  where: { action: 'prepBrief.generated' },
  orderBy: { createdAt: 'desc' },
  take: 3,
});
console.log('audits:', JSON.stringify(audits, null, 2));

await prisma.$disconnect();
