// One-off audit: count drafts with stale calendly links in active queue statuses.
import 'dotenv/config';
import { PrismaPg } from '@prisma/adapter-pg';
import { PrismaClient } from '@prisma/client';
import { getBookingLink } from '../shared/bookingLink.js';

const prisma = new PrismaClient({
  adapter: new PrismaPg({ connectionString: process.env.DATABASE_URL ?? '' }),
});

const booking = getBookingLink();
const drafts = await prisma.draft.findMany({
  where: {
    body: { contains: 'calendly', mode: 'insensitive' },
    status: { in: ['pending', 'approved', 'paused'] },
  },
  select: {
    id: true,
    kind: true,
    status: true,
    createdAt: true,
    body: true,
    lead: { select: { name: true } },
  },
  orderBy: { createdAt: 'desc' },
});

console.log('HUBSPOT_BOOKING_LINK env:', process.env.HUBSPOT_BOOKING_LINK ?? '(unset)');
console.log('getBookingLink():', booking);
console.log('Drafts with calendly (pending/approved/paused):', drafts.length);

const byKind: Record<string, number> = {};
const byStatus: Record<string, number> = {};
for (const d of drafts) {
  byKind[d.kind] = (byKind[d.kind] ?? 0) + 1;
  byStatus[d.status] = (byStatus[d.status] ?? 0) + 1;
}
console.log('By kind:', byKind);
console.log('By status:', byStatus);

const urlSet = new Set<string>();
for (const d of drafts) {
  const matches = d.body.match(/https?:\/\/[^\s]*calendly[^\s]*/gi) ?? [];
  for (const m of matches) urlSet.add(m);
}
console.log('Unique calendly URLs:', [...urlSet]);

if (drafts[0] !== undefined) {
  const lines = drafts[0].body.split('\n').slice(-4);
  console.log('\nSample closing (newest draft):');
  console.log(`  ${drafts[0].lead.name} · ${drafts[0].kind} · ${drafts[0].status}`);
  console.log(lines.join('\n'));
}

await prisma.$disconnect();
