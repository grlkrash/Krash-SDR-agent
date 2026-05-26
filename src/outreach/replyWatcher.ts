// Inbound-reply watcher.
//
// Poll Gmail every 15 minutes for messages received in the last 30 minutes,
// match each inbound against a Draft we previously sent (by RFC-822
// Message-ID), and ask Claude for a short reply draft. The new Draft lands
// in /queue with status='pending' for Sonia to approve. As a side effect
// we log the inbound to HubSpot as an INCOMING_EMAIL engagement so the
// contact timeline reflects the reply.
//
// Concurrency / race safety:
//
//   `Draft.inboundGmailMessageId` carries a UNIQUE index (Postgres allows
//   multiple NULLs so non-replied rows are unaffected). Two simultaneous
//   checkReplies workers can both pass the AuditLog fast-path, but only
//   one prisma.draft.create wins — the loser raises P2002 and the catch
//   branch re-loads the winner and resumes the HubSpot upsert if needed.
//   The AuditLog lookup remains as a cheap fast-path to skip Gmail/Claude
//   round-trips on the steady-state second pass (30-min lookback × 15-min
//   cron deliberately overlaps).
//
// HubSpot upsert:
//
//   Idempotent on `Draft.hubspotInboundEmailId`. If a prior run crashed
//   between draft.create and the HubSpot create, the next cron sees the
//   draft, finds inbound id null, and retries the HubSpot half only.
//   Direction=INCOMING_EMAIL, timestamp=message internalDate, body=snippet.
//
// Notes:
//
// 1) Gmail's `-from:me` query operator misses BCC-to-self, filter
//    re-delivery, and group-alias routes. The From-header check below is
//    the hard guard.
//
// 2) We thread-match on parsed In-Reply-To AND References. References can
//    contain the whole-thread chain. The matched Draft might be the cold
//    OR any followup-N; we always pass the COLD draft to buildRepliedUser
//    so the model sees the original pitch, not the last follow-up nudge.
//
// 3) OAuth client is duplicated from src/shared/gmail.ts rather than
//    exported. That file's helper is private and tightly bound to the
//    send flow; factoring it out is a neighboring refactor outside this
//    prompt's scope.

import { PrismaPg } from '@prisma/adapter-pg';
import { Prisma, PrismaClient } from '@prisma/client';
import type { Draft } from '@prisma/client';
import { google } from 'googleapis';
import { OAuth2Client } from 'google-auth-library';
import { FilterOperatorEnum } from '@hubspot/api-client/lib/codegen/crm/companies/models/Filter.js';
import { claude, extractText } from '../shared/claude.js';
import { hs, hsRetry } from '../shared/hubspot.js';
import { REPLIED_SYSTEM, buildRepliedUser } from '../prompts/replied.js';

const MODEL = 'claude-sonnet-4-5-20250929';
const MAX_TOKENS = 512;
const TEMPERATURE = 0.5;
const LOOKBACK_QUERY = 'newer_than:30m -from:me';
const MAX_RESULTS = 50;
const OOO_SUBJECT_PREFIXES = ['Out of Office', 'Automatic reply'] as const;
const OOO_BODY_MARKERS = [
  'I am out of the office',
  'currently out of the office',
] as const;
const TERMINAL_DEDUP_ACTIONS = [
  'reply.draft-created',
  'reply.ooo-detected',
] as const;
const HUBSPOT_INBOUND_DIRECTION = 'INCOMING_EMAIL';
// HubSpot rejects email bodies above ~64KB; matches logSentEmail.ts.
const HUBSPOT_BODY_MAX_CHARS = 60000;
const HUBSPOT_CONTACT_SEARCH_LIMIT = 1;
// Cap for the snippet copy we stash in AuditLog.meta. 10× the daily-brief
// display cap (240) so the brief never has to truncate against the audit
// row, but bounded so the JSONB column stays small and historical rows
// don't bloat the table. Anything longer is still readable via the
// HubSpot fallback path in dailyBrief.
const INBOUND_SNIPPET_AUDIT_MAX_CHARS = 2000;

const prisma = new PrismaClient({
  adapter: new PrismaPg({ connectionString: process.env.DATABASE_URL ?? '' }),
});

const requireEnv = (name: string): string => {
  const v = process.env[name];
  if (v === undefined || v === '') throw new Error(`${name} is not set`);
  return v;
};

const buildOAuthClient = (): OAuth2Client => {
  const client = new google.auth.OAuth2({
    clientId: requireEnv('GMAIL_CLIENT_ID'),
    clientSecret: requireEnv('GMAIL_CLIENT_SECRET'),
  });
  client.setCredentials({ refresh_token: requireEnv('GMAIL_REFRESH_TOKEN') });
  return client;
};

const audit = (
  action: string,
  entity: string,
  entityId: string | null,
  meta: Prisma.InputJsonValue,
): Promise<unknown> =>
  prisma.auditLog.create({ data: { action, entity, entityId, meta } });

type GmailHeader = { name?: string | null; value?: string | null };

const headerValue = (
  headers: GmailHeader[] | undefined,
  name: string,
): string | undefined => {
  if (headers === undefined) return undefined;
  const lower = name.toLowerCase();
  for (const h of headers) {
    if (h.name?.toLowerCase() === lower && h.value !== null && h.value !== undefined) {
      return h.value;
    }
  }
  return undefined;
};

const parseRfc822MessageIds = (...values: Array<string | undefined>): string[] => {
  const ids = new Set<string>();
  for (const v of values) {
    if (v === undefined) continue;
    for (const token of v.split(/\s+/)) {
      const stripped = token.replace(/^<+/, '').replace(/>+$/, '').trim();
      if (stripped !== '') ids.add(stripped);
    }
  }
  return [...ids];
};

const isOOO = (subject: string, body: string): boolean => {
  for (const prefix of OOO_SUBJECT_PREFIXES) {
    if (subject.startsWith(prefix)) return true;
  }
  for (const marker of OOO_BODY_MARKERS) {
    if (body.includes(marker)) return true;
  }
  return false;
};

// Best-effort RFC 5322 From-address extraction. Gmail returns From in either
// `"Display Name" <addr@host>` or bare `addr@host` form; we want the addr for
// contact lookup. Falls back to the raw header value if no angle-brackets.
const extractFromAddress = (rawFrom: string): string => {
  const m = rawFrom.match(/<([^>]+)>/);
  return (m?.[1] ?? rawFrom).trim().toLowerCase();
};

const alreadyHandled = async (inboundMessageId: string): Promise<boolean> => {
  const existing = await prisma.auditLog.findFirst({
    where: {
      action: { in: [...TERMINAL_DEDUP_ACTIONS] },
      meta: { path: ['inboundMessageId'], equals: inboundMessageId },
    },
    select: { id: true },
  });
  return existing !== null;
};

const findContactIdByEmail = async (email: string): Promise<string | null> => {
  const res = await hsRetry(() =>
    hs.crm.contacts.searchApi.doSearch({
      filterGroups: [{
        filters: [{
          propertyName: 'email',
          operator: FilterOperatorEnum.Eq,
          value: email,
        }],
      }],
      properties: ['email'],
      limit: HUBSPOT_CONTACT_SEARCH_LIMIT,
    }),
  );
  return res.results[0]?.id ?? null;
};

// Logs the inbound reply as an INCOMING_EMAIL engagement and writes the
// HubSpot engagement id back to Draft.hubspotInboundEmailId. Idempotent:
// short-circuits if hubspotInboundEmailId is already set. Best-effort —
// HubSpot failures are audited but never propagate. The DB-side replied
// Draft is the source of truth; HubSpot is timeline decoration.
const logInboundReplyToHubspot = async (opts: {
  draftId: string;
  fromAddress: string;
  subject: string;
  snippet: string;
  receivedAt: Date;
  companyId: string | null;
}): Promise<void> => {
  try {
    const draft = await prisma.draft.findUnique({
      where: { id: opts.draftId },
      select: { hubspotInboundEmailId: true },
    });
    if (draft === null) return;
    if (draft.hubspotInboundEmailId !== null) return;

    const contactId = await findContactIdByEmail(opts.fromAddress);
    if (contactId === null && opts.companyId === null) {
      await audit('hubspotInboundEngagement.skipped-no-associations', 'Draft', opts.draftId, {
        fromAddress: opts.fromAddress,
      });
      return;
    }

    const created = await hsRetry(() =>
      hs.crm.objects.emails.basicApi.create({
        properties: {
          hs_timestamp: opts.receivedAt.getTime().toString(),
          hs_email_direction: HUBSPOT_INBOUND_DIRECTION,
          hs_email_subject: opts.subject,
          hs_email_text: opts.snippet.slice(0, HUBSPOT_BODY_MAX_CHARS),
          hs_email_headers: JSON.stringify({ from: opts.fromAddress }),
        },
        associations: [],
      }),
    );

    if (contactId !== null) {
      await hsRetry(() =>
        hs.crm.associations.v4.basicApi.createDefault('emails', created.id, 'contacts', contactId),
      );
    }
    const companyId = opts.companyId;
    if (companyId !== null) {
      await hsRetry(() =>
        hs.crm.associations.v4.basicApi.createDefault('emails', created.id, 'companies', companyId),
      );
    }

    await prisma.draft.update({
      where: { id: opts.draftId },
      data: { hubspotInboundEmailId: created.id },
    });
    await audit('hubspotInboundEngagement.logged', 'Draft', opts.draftId, {
      emailId: created.id,
      contactId,
      companyId: opts.companyId,
      receivedAt: opts.receivedAt.toISOString(),
    });
  } catch (err) {
    await audit('hubspotInboundEngagement.failed', 'Draft', opts.draftId, {
      error: err instanceof Error ? err.message : String(err),
    });
  }
};

type ProcessOutcome =
  | { kind: 'created'; draft: Draft }
  | { kind: 'resumed'; draft: Draft }
  | { kind: 'noop' };

const persistRepliedDraft = async (opts: {
  inboundMessageId: string;
  leadId: string;
  subject: string | null;
  body: string;
}): Promise<ProcessOutcome> => {
  try {
    const draft = await prisma.draft.create({
      data: {
        leadId: opts.leadId,
        kind: 'replied',
        subject: opts.subject,
        body: opts.body,
        status: 'pending',
        inboundGmailMessageId: opts.inboundMessageId,
      },
    });
    return { kind: 'created', draft };
  } catch (err) {
    // P2002 = a concurrent worker already inserted the row. Re-load so the
    // caller can still resume the HubSpot upsert half if it was skipped.
    if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002') {
      const existing = await prisma.draft.findUnique({
        where: { inboundGmailMessageId: opts.inboundMessageId },
      });
      if (existing === null) return { kind: 'noop' };
      return { kind: 'resumed', draft: existing };
    }
    throw err;
  }
};

export const checkReplies = async (): Promise<void> => {
  const gmailFrom = requireEnv('GMAIL_FROM').toLowerCase();
  const gmail = google.gmail({ version: 'v1', auth: buildOAuthClient() });

  const list = await gmail.users.messages.list({
    userId: 'me',
    q: LOOKBACK_QUERY,
    maxResults: MAX_RESULTS,
  });

  const messages = list.data.messages ?? [];
  if (messages.length === 0) return;

  for (const meta of messages) {
    const inboundId = meta.id ?? undefined;
    if (inboundId === undefined) continue;

    // Cheap fast-path: skip Gmail fetch + Claude call when we've already
    // reached a terminal outcome for this inbound. Race-safe correctness
    // is guaranteed downstream by the UNIQUE index on inboundGmailMessageId.
    if (await alreadyHandled(inboundId)) {
      // Still attempt the HubSpot half — a prior run might have written
      // the draft but failed on the HubSpot create. logInboundReplyToHubspot
      // short-circuits when hubspotInboundEmailId is already set.
      const drafted = await prisma.draft.findUnique({
        where: { inboundGmailMessageId: inboundId },
        include: { lead: true },
      });
      if (drafted !== null && drafted.hubspotInboundEmailId === null) {
        const got = await gmail.users.messages.get({
          userId: 'me',
          id: inboundId,
          format: 'metadata',
          metadataHeaders: ['From', 'Subject'],
        });
        const headers = got.data.payload?.headers ?? undefined;
        const rawFrom = headerValue(headers, 'From') ?? '';
        const subject = headerValue(headers, 'Subject') ?? '';
        const receivedAtMs = Number(got.data.internalDate ?? Date.now());
        await logInboundReplyToHubspot({
          draftId: drafted.id,
          fromAddress: extractFromAddress(rawFrom),
          subject,
          snippet: got.data.snippet ?? '',
          receivedAt: new Date(receivedAtMs),
          companyId: drafted.lead.hubspotCompanyId,
        });
      }
      continue;
    }

    const got = await gmail.users.messages.get({
      userId: 'me',
      id: inboundId,
      format: 'metadata',
      metadataHeaders: ['From', 'In-Reply-To', 'References', 'Subject', 'Message-Id'],
    });

    const headers = got.data.payload?.headers ?? undefined;
    const from = headerValue(headers, 'From') ?? '';
    const subject = headerValue(headers, 'Subject') ?? '';
    const inReplyTo = headerValue(headers, 'In-Reply-To');
    const references = headerValue(headers, 'References');
    const snippet = got.data.snippet ?? '';
    const receivedAtMs = Number(got.data.internalDate ?? Date.now());
    const receivedAt = new Date(receivedAtMs);

    if (from.toLowerCase().includes(gmailFrom)) continue;

    if (isOOO(subject, snippet)) {
      await audit('reply.ooo-detected', 'Gmail', null, {
        inboundMessageId: inboundId,
        from,
        subject,
      });
      continue;
    }

    const candidateIds = parseRfc822MessageIds(inReplyTo, references);
    if (candidateIds.length === 0) continue;

    const matched = await prisma.draft.findFirst({
      where: { gmailMessageId: { in: candidateIds } },
      orderBy: { sentAt: 'desc' },
    });
    if (matched === null) continue;

    // A reply to a followup-N still gets the COLD draft as context — that's
    // the original pitch the model needs to ground its response in.
    const coldDraft = matched.kind === 'cold'
      ? matched
      : await prisma.draft.findFirst({
          where: { leadId: matched.leadId, kind: 'cold' },
          orderBy: { sentAt: 'asc' },
        });
    if (coldDraft === null) continue;

    const lead = await prisma.lead.findUnique({
      where: { id: matched.leadId },
      include: { enrichment: true },
    });
    if (lead === null) continue;

    const userPrompt = buildRepliedUser(coldDraft, snippet, lead, lead.enrichment);

    const msg = await claude.messages.create({
      model: MODEL,
      max_tokens: MAX_TOKENS,
      temperature: TEMPERATURE,
      system: REPLIED_SYSTEM,
      messages: [{ role: 'user', content: userPrompt }],
    });
    const body = extractText(msg).trim();
    if (body === '') continue;

    const baseSubject = coldDraft.subject?.trim() ?? '';
    const replySubject = baseSubject === ''
      ? null
      : baseSubject.toLowerCase().startsWith('re:')
        ? baseSubject
        : `Re: ${baseSubject}`;

    const outcome = await persistRepliedDraft({
      inboundMessageId: inboundId,
      leadId: matched.leadId,
      subject: replySubject,
      body,
    });
    if (outcome.kind === 'noop') continue;

    // Only emit reply.draft-created on the first-write path. Resumed rows
    // already audited on their original create.
    if (outcome.kind === 'created') {
      await audit('reply.draft-created', 'Draft', outcome.draft.id, {
        inboundMessageId: inboundId,
        matchedDraftId: matched.id,
        matchedDraftKind: matched.kind,
        coldDraftId: coldDraft.id,
        leadId: matched.leadId,
        from,
        subject,
        receivedAt: receivedAt.toISOString(),
        // Stash the snippet here so the daily brief can render it without a
        // HubSpot round-trip. Bounded copy — see INBOUND_SNIPPET_AUDIT_MAX_CHARS.
        inboundSnippet: snippet.slice(0, INBOUND_SNIPPET_AUDIT_MAX_CHARS),
      });
    }

    await logInboundReplyToHubspot({
      draftId: outcome.draft.id,
      fromAddress: extractFromAddress(from),
      subject,
      snippet,
      receivedAt,
      companyId: lead.hubspotCompanyId,
    });
  }
};
