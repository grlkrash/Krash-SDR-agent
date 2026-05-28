import { PrismaPg } from '@prisma/adapter-pg';
import { PrismaClient } from '@prisma/client';
import { callHint, formatPhoneForDisplay } from './shared.js';

const prisma = new PrismaClient({
  adapter: new PrismaPg({ connectionString: process.env.DATABASE_URL ?? '' }),
});

export const MANUAL_VM_SKIPPED_STATUS = 'voicemail-skipped-state-law';
export const MANUAL_VM_CALLED_STATUS = 'manual-vm-called';

export const MANUAL_VM_BRIEF_LIMIT = 10;
export const MANUAL_VM_QUEUE_LIMIT = 100;

export interface ManualVoicemailRow {
  draftId: string;
  facility: string;
  city: string;
  state: string;
  phone: string;
  phoneE164: string;
  ownerName: string | null;
  reason: string;
  hint: string;
  flaggedAt: Date;
  priorWrittenConsent: boolean;
}

const parseReasonFromBody = (body: string): string => {
  const reasonMatch = body.match(/skipped — ([^;]+);/);
  return reasonMatch === null ? 'state-law restricted' : reasonMatch[1] ?? 'state-law restricted';
};

export const buildManualVoicemailRows = async (opts: {
  since?: Date;
  limit: number;
  includeCalled?: boolean;
}): Promise<ManualVoicemailRow[]> => {
  const statuses = opts.includeCalled === true
    ? [MANUAL_VM_SKIPPED_STATUS, MANUAL_VM_CALLED_STATUS]
    : [MANUAL_VM_SKIPPED_STATUS];

  const drafts = await prisma.draft.findMany({
    where: {
      kind: 'voicemail',
      status: { in: statuses },
      ...(opts.since === undefined ? {} : { createdAt: { gte: opts.since } }),
    },
    orderBy: { createdAt: 'desc' },
    take: opts.limit,
    include: { lead: { include: { enrichment: true } } },
  });

  const out: ManualVoicemailRow[] = [];
  for (const d of drafts) {
    const lead = d.lead;
    if (lead.phoneE164 === null) continue;
    out.push({
      draftId: d.id,
      facility: lead.name,
      city: lead.city,
      state: lead.state,
      phone: formatPhoneForDisplay(lead.phoneE164),
      phoneE164: lead.phoneE164,
      ownerName: lead.enrichment?.ownerName ?? null,
      reason: parseReasonFromBody(d.body),
      hint: callHint(lead.state),
      flaggedAt: d.createdAt,
      priorWrittenConsent: lead.priorWrittenConsent,
    });
  }
  return out;
};

export const countOpenManualVm = async (): Promise<number> =>
  prisma.draft.count({
    where: { kind: 'voicemail', status: MANUAL_VM_SKIPPED_STATUS },
  });

export const renderManualVoicemailRequired = (
  rows: ManualVoicemailRow[],
  publicUrl: string,
  openCount: number,
): string => {
  const queueUrl = `${publicUrl}/manual-vm-queue`;
  const header = '## 🚨 Manual VM required — state-law restricted';
  if (rows.length === 0 && openCount === 0) {
    return `${header}\n\n_None — no restricted-state leads awaiting manual outreach._`;
  }
  const backlogNote = openCount > rows.length
    ? `\n\n_${openCount} total open in [manual VM queue](${queueUrl}); showing newest ${rows.length} from last 24h._`
    : `\n\n_[Open manual VM queue](${queueUrl}) (${openCount} pending)_`;
  if (rows.length === 0) {
    return `${header}${backlogNote}`;
  }
  const items = rows.map((r, i) => {
    const owner = r.ownerName ?? '—';
    const consent = r.priorWrittenConsent ? ' · consent on file' : '';
    return `${i + 1}. **${r.facility}** (${r.city}, ${r.state}) — ${r.phone} · ${owner} · ${r.hint} · _${r.reason}_${consent}`;
  }).join('\n');
  return `${header} (24h snapshot)${backlogNote}\n\n${items}`;
};
