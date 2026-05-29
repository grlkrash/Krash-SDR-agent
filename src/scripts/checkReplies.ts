// tsx src/scripts/checkReplies.ts
//
// Cron entry (~every 5 min via cronTick): poll Gmail for inbound replies in the
// last 15 minutes, dedup against AuditLog, and draft a 'replied' Draft per match.
// All real work — Gmail fetch, header parsing, OOO detection, draft
// generation, per-inbound audit — lives in checkReplies(); this script
// just wraps it in cron success/failure bookkeeping.

import 'dotenv/config';
import { PrismaPg } from '@prisma/adapter-pg';
import { PrismaClient } from '@prisma/client';
import { checkReplies } from '../outreach/replyWatcher.js';
import { hasGmailCredentials } from '../shared/gmail.js';

const prisma = new PrismaClient({
  adapter: new PrismaPg({ connectionString: process.env.DATABASE_URL ?? '' }),
});

const main = async (): Promise<void> => {
  if (!hasGmailCredentials()) {
    await prisma.auditLog.create({ data: {
      action: 'cron.skipped',
      entity: 'checkReplies',
      entityId: null,
      meta: { reason: 'Gmail OAuth env incomplete (GMAIL_CLIENT_ID/SECRET/REFRESH_TOKEN)' },
    } });
    console.log(JSON.stringify({ status: 'skipped', reason: 'Gmail credentials incomplete' }));
    return;
  }

  try {
    await checkReplies();
    await prisma.auditLog.create({ data: {
      action: 'cron.success',
      entity: 'checkReplies',
      meta: {},
    } });
    console.log(JSON.stringify({ ok: true }));
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    await prisma.auditLog.create({ data: {
      action: 'cron.failure',
      entity: 'checkReplies',
      meta: { error: message },
    } });
    throw err;
  }
};

await main();
