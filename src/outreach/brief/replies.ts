import { PrismaPg } from '@prisma/adapter-pg';
import { PrismaClient, type Lead, type Enrichment } from '@prisma/client';
import { z } from 'zod';
import { hs, hsRetry } from '../../shared/hubspot.js';
import {
  SNIPPET_PLACEHOLDER,
  buildRelativeTime,
  cleanSnippet,
} from './shared.js';

const prisma = new PrismaClient({
  adapter: new PrismaPg({ connectionString: process.env.DATABASE_URL ?? '' }),
});

export const REPLY_SNIPPET_MAX = 240;

const ReplyDraftMetaSchema = z.object({
  receivedAt: z.string(),
  inboundSnippet: z.string(),
}).partial();

export interface ReplyRow {
  draftId: string;
  facility: string;
  city: string;
  state: string;
  ownerName: string | null;
  relativeTime: string;
  snippet: string;
}

export type RepliedDraftRow = {
  id: string;
  createdAt: Date;
  hubspotInboundEmailId: string | null;
  lead: Lead & { enrichment: Enrichment | null };
};

const fetchInboundSnippet = async (
  hubspotInboundEmailId: string | null,
): Promise<string | null> => {
  if (hubspotInboundEmailId === null) return null;
  try {
    const obj = await hsRetry(() =>
      hs.crm.objects.emails.basicApi.getById(hubspotInboundEmailId, ['hs_email_text']),
    );
    const text = obj.properties.hs_email_text ?? null;
    return text === null || text.trim() === '' ? null : text;
  } catch {
    return null;
  }
};

export const buildReplyRows = async (
  drafts: RepliedDraftRow[],
  now: Date,
): Promise<ReplyRow[]> => {
  if (drafts.length === 0) return [];

  const auditRows = await prisma.auditLog.findMany({
    where: { action: 'reply.draft-created', entityId: { in: drafts.map((d) => d.id) } },
  });
  const receivedByDraft = new Map<string, Date>();
  const snippetByDraft = new Map<string, string>();
  for (const row of auditRows) {
    if (row.entityId === null) continue;
    const parsed = ReplyDraftMetaSchema.safeParse(row.meta);
    if (!parsed.success) continue;
    if (parsed.data.receivedAt !== undefined) {
      const ts = Date.parse(parsed.data.receivedAt);
      if (!Number.isNaN(ts)) receivedByDraft.set(row.entityId, new Date(ts));
    }
    const persisted = parsed.data.inboundSnippet;
    if (persisted !== undefined && persisted.trim() !== '') {
      snippetByDraft.set(row.entityId, persisted);
    }
  }

  const rows: ReplyRow[] = [];
  for (const d of drafts) {
    const persisted = snippetByDraft.get(d.id) ?? null;
    const rawSnippet = persisted ?? (await fetchInboundSnippet(d.hubspotInboundEmailId));
    const snippet = rawSnippet === null
      ? SNIPPET_PLACEHOLDER
      : cleanSnippet(rawSnippet, REPLY_SNIPPET_MAX);
    const received = receivedByDraft.get(d.id) ?? d.createdAt;
    rows.push({
      draftId: d.id,
      facility: d.lead.name,
      city: d.lead.city,
      state: d.lead.state,
      ownerName: d.lead.enrichment?.ownerName ?? null,
      relativeTime: buildRelativeTime(received, now),
      snippet,
    });
  }
  return rows;
};

export const renderNewReplies = (rows: ReplyRow[], publicUrl: string): string => {
  if (rows.length === 0) {
    return '## 📬 New replies (24h)\n\n_None — quiet day on inbound._';
  }
  const header = `## 📬 New replies (24h) — ${rows.length}`;
  const items = rows.map((r) => {
    const owner = r.ownerName ?? '—';
    const link = `${publicUrl}/queue#draft-${r.draftId}`;
    return [
      `- **${r.facility}** (${r.city}, ${r.state}) · ${owner} · ${r.relativeTime}`,
      `  > ${r.snippet}`,
      `  [→ Review in queue](${link})`,
    ].join('\n');
  }).join('\n');
  return `${header}\n\n${items}`;
};
