// One-off: swap stale calendly.com URLs in queue drafts for getBookingLink().
// Preserves personalized body/subject/scores — no Claude calls.
//
// Usage:
//   npx tsx src/scripts/_tmpPatchBookingLinks.ts          # dry-run (default)
//   APPLY=1 npx tsx src/scripts/_tmpPatchBookingLinks.ts  # write updates

import 'dotenv/config';
import { PrismaPg } from '@prisma/adapter-pg';
import { PrismaClient } from '@prisma/client';
import { getBookingLink } from '../shared/bookingLink.js';

const APPLY = process.env.APPLY === '1';
const QUEUE_STATUSES = ['pending', 'approved', 'paused'] as const;

const CALENDLY_URL_RE = /https?:\/\/[^\s]*calendly[^\s]*/gi;

const prisma = new PrismaClient({
  adapter: new PrismaPg({ connectionString: process.env.DATABASE_URL ?? '' }),
});

const bookingLink = getBookingLink();
console.log(`Mode:       ${APPLY ? 'APPLY (writes)' : 'dry-run'}`);
console.log(`New link:   ${bookingLink}\n`);

const drafts = await prisma.draft.findMany({
  where: {
    body: { contains: 'calendly', mode: 'insensitive' },
    status: { in: [...QUEUE_STATUSES] },
  },
  select: { id: true, leadId: true, kind: true, status: true, body: true, lead: { select: { name: true } } },
  orderBy: { createdAt: 'desc' },
});

console.log(`Found ${drafts.length} draft(s) to patch.\n`);

let patched = 0;
for (const draft of drafts) {
  const matches = draft.body.match(CALENDLY_URL_RE) ?? [];
  if (matches.length === 0) continue;

  const newBody = draft.body.replace(CALENDLY_URL_RE, bookingLink);
  if (newBody === draft.body) continue;

  console.log(`${draft.lead.name} · ${draft.kind} · ${draft.status}`);
  console.log(`  draft ${draft.id}`);
  console.log(`  old: ${matches[0]}`);
  console.log(`  new: ${bookingLink}`);

  if (APPLY) {
    await prisma.draft.update({ where: { id: draft.id }, data: { body: newBody } });
    await prisma.auditLog.create({
      data: {
        action: 'draft.patch-booking-link',
        entity: 'Draft',
        entityId: draft.id,
        meta: { leadId: draft.leadId, oldUrl: matches[0], newUrl: bookingLink },
      },
    });
  }
  patched += 1;
}

console.log(`\n=== summary ===`);
console.log(`matched:  ${drafts.length}`);
console.log(`patched:  ${patched}`);
console.log(APPLY ? 'Done.' : 'Dry-run only — re-run with APPLY=1 to write.');

await prisma.$disconnect();
