import { PrismaPg } from '@prisma/adapter-pg';
import { PrismaClient } from '@prisma/client';
import { z } from 'zod';

const prisma = new PrismaClient({
  adapter: new PrismaPg({ connectionString: process.env.DATABASE_URL ?? '' }),
});

const HIRING_SPIKE_LIMIT = 10;

const HiringSpikeMetaSchema = z.object({
  leadId: z.string(),
  facility: z.string(),
  city: z.string(),
  state: z.string(),
  roleTitles: z.array(z.string()).optional(),
});

export interface HiringSpikeRow {
  dealId: string;
  facility: string;
  city: string;
  state: string;
  roles: string;
}

export const buildHiringSpikeRows = async (since: Date): Promise<HiringSpikeRow[]> => {
  const rows = await prisma.auditLog.findMany({
    where: { action: 'intent.hiring-spike', createdAt: { gte: since } },
    orderBy: { createdAt: 'desc' },
    take: HIRING_SPIKE_LIMIT,
  });
  const out: HiringSpikeRow[] = [];
  for (const row of rows) {
    if (row.entityId === null) continue;
    const parsed = HiringSpikeMetaSchema.safeParse(row.meta);
    if (!parsed.success) continue;
    const roles = (parsed.data.roleTitles ?? []).slice(0, 2).join(', ');
    out.push({
      dealId: row.entityId,
      facility: parsed.data.facility,
      city: parsed.data.city,
      state: parsed.data.state,
      roles: roles === '' ? 'open roles' : roles,
    });
  }
  return out;
};

export const renderHiringSpikes = (rows: HiringSpikeRow[]): string => {
  if (rows.length === 0) {
    return '## 🚨 Hiring spikes (24h)\n\n_None — no new hiring activity on open deals._';
  }
  const header = `## 🚨 Hiring spikes (24h) — ${rows.length}`;
  const items = rows.map((r) =>
    `- **${r.facility}** (${r.city}, ${r.state}) — now hiring: ${r.roles}`,
  ).join('\n');
  return `${header}\n\n${items}`;
};
