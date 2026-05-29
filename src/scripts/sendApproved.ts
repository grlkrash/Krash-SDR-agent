// tsx src/scripts/sendApproved.ts
//
// Cron entry: send every approved-but-not-yet-sent draft. Routing happens
// in sendApprovedDraft (sender.ts): email kinds (cold/followup-N/replied
// /quarterly/renewal/upsell/reactivation/nudge) ship via Gmail; voicemail
// kinds (voicemail, voicemail-2) ship via Twilio. The 200ms pacing keeps
// us under Gmail's per-second send quota and gives HubSpot's
// engagement-create rate limit headroom too; voicemail Twilio calls
// inherit the same pace, which is plenty for the lookups/calls APIs.
//
// Voicemail sends do NOT depend on Gmail credentials — only email kinds do.

import 'dotenv/config';
import { PrismaPg } from '@prisma/adapter-pg';
import { PrismaClient } from '@prisma/client';
import { sendApprovedDraft } from '../outreach/sender.js';
import { hasGmailCredentials } from '../shared/gmail.js';

const PACING_MS = 200;
const VOICEMAIL_KINDS = new Set(['voicemail', 'voicemail-2']);

const prisma = new PrismaClient({
  adapter: new PrismaPg({ connectionString: process.env.DATABASE_URL ?? '' }),
});

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

const isVoicemailKind = (kind: string): boolean => VOICEMAIL_KINDS.has(kind);

const main = async (): Promise<void> => {
  const gmailReady = hasGmailCredentials();

  try {
    const drafts = await prisma.draft.findMany({
      where: {
        status: 'approved',
        sentAt: null,
      },
      select: { id: true, kind: true },
      orderBy: { createdAt: 'asc' },
    });

    let ok = 0;
    let fail = 0;
    let skippedEmail = 0;
    for (const draft of drafts) {
      if (!isVoicemailKind(draft.kind) && !gmailReady) {
        skippedEmail += 1;
        continue;
      }
      try {
        await sendApprovedDraft(draft.id);
        ok += 1;
      } catch (err) {
        fail += 1;
        await prisma.auditLog.create({ data: {
          action: 'sender.failure',
          entity: 'Draft',
          entityId: draft.id,
          meta: { error: err instanceof Error ? err.message : String(err) },
        } });
      }
      await sleep(PACING_MS);
    }

    if (!gmailReady && skippedEmail > 0) {
      await prisma.auditLog.create({ data: {
        action: 'cron.skipped',
        entity: 'sendApproved',
        entityId: null,
        meta: {
          reason: 'GMAIL credentials incomplete — email drafts left approved',
          skippedEmail,
        },
      } });
    }

    await prisma.auditLog.create({ data: {
      action: 'cron.success',
      entity: 'sendApproved',
      meta: {
        total: drafts.length,
        ok,
        fail,
        skippedEmail,
        gmailReady,
      },
    } });
    console.log(JSON.stringify({ total: drafts.length, ok, fail, skippedEmail, gmailReady }));
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    await prisma.auditLog.create({ data: {
      action: 'cron.failure',
      entity: 'sendApproved',
      meta: { error: message },
    } });
    throw err;
  }
};

await main();
