import type { PrismaClient } from '@prisma/client';
import {
  COST_CAPS,
  TOTAL_CAP_USD,
  WARN_FRACTION,
  capForProvider,
  monthKey,
  startOfUtcMonth,
  type CostProvider,
} from '../shared/costCaps.js';
import { sendEmail } from '../shared/gmail.js';

type Threshold = '80' | '100';

type ProviderSpend = {
  provider: CostProvider;
  label: string;
  capUsd: number;
  mtdUsd: number;
  pct: number;
  autoTrack: boolean;
};

const fmtUsd = (n: number): string => `$${n.toFixed(2)}`;

const aggregateMtdSpend = async (
  prisma: PrismaClient,
  monthStart: Date,
): Promise<Map<CostProvider, number>> => {
  const rows = await prisma.auditLog.findMany({
    where: { action: 'cost.usage', createdAt: { gte: monthStart } },
    select: { entity: true, meta: true },
  });

  const totals = new Map<CostProvider, number>();
  for (const row of rows) {
    const provider = row.entity as CostProvider;
    const meta = row.meta;
    if (meta === null || typeof meta !== 'object' || Array.isArray(meta)) continue;
    const raw = (meta as Record<string, unknown>).estimatedUsd;
    const estimatedUsd = typeof raw === 'number' ? raw : Number(raw);
    if (!Number.isFinite(estimatedUsd)) continue;
    totals.set(provider, (totals.get(provider) ?? 0) + estimatedUsd);
  }
  return totals;
};

const buildProviderRows = (totals: Map<CostProvider, number>): ProviderSpend[] =>
  COST_CAPS.map((cap) => {
    const mtdUsd =
      cap.provider === 'infra'
        ? cap.monthlyCapUsd
        : cap.autoTrack
          ? (totals.get(cap.provider) ?? 0)
          : 0;
    const pct = cap.monthlyCapUsd > 0 ? (mtdUsd / cap.monthlyCapUsd) * 100 : 0;
    return {
      provider: cap.provider,
      label: cap.label,
      capUsd: cap.monthlyCapUsd,
      mtdUsd,
      pct,
      autoTrack: cap.autoTrack,
    };
  });

const alertAlreadySent = async (
  prisma: PrismaClient,
  entity: string,
  threshold: Threshold,
  month: string,
): Promise<boolean> => {
  const rows = await prisma.auditLog.findMany({
    where: {
      action: 'costCap.alert-sent',
      entity,
      createdAt: { gte: startOfUtcMonth(new Date()) },
    },
    select: { meta: true },
    take: 50,
  });
  return rows.some((row) => {
    const meta = row.meta;
    if (meta === null || typeof meta !== 'object' || Array.isArray(meta)) return false;
    const m = meta as Record<string, unknown>;
    return m.threshold === threshold && m.month === month;
  });
};

const markAlertSent = async (
  prisma: PrismaClient,
  entity: string,
  threshold: Threshold,
  month: string,
  mtdUsd: number,
  capUsd: number,
): Promise<void> => {
  await prisma.auditLog.create({
    data: {
      action: 'costCap.alert-sent',
      entity,
      meta: { threshold, month, mtdUsd, capUsd },
    },
  });
};

const formatReport = (rows: ProviderSpend[], totalMtd: number, now: Date): string => {
  const lines = [
    `SSA cost report — ${now.toISOString().slice(0, 10)} (UTC)`,
    '',
    'Provider                     MTD est.   Cap      %',
    '------------------------------------------------',
  ];
  for (const row of rows) {
    const trackNote = row.autoTrack ? '' : row.provider === 'infra' ? ' (fixed)' : ' (manual)';
    lines.push(
      `${row.label.padEnd(28)} ${fmtUsd(row.mtdUsd).padStart(8)}  ${fmtUsd(row.capUsd).padStart(7)}  ${row.pct.toFixed(0).padStart(3)}%${trackNote}`,
    );
  }
  lines.push(
    '',
    `Total tracked + fixed infra: ${fmtUsd(totalMtd)} / ${fmtUsd(TOTAL_CAP_USD)} (${((totalMtd / TOTAL_CAP_USD) * 100).toFixed(0)}%)`,
    '',
    'Auto-tracked: Claude, Voyage, Google Places, Serper (via AuditLog cost.usage rows).',
    'Manual check: Twilio, ElevenLabs dashboards; Mailwarm billing page.',
    'Railway is a flat ~$12/mo — included in total, not usage-based.',
  );
  return lines.join('\n');
};

export type CostCapAlertResult = {
  emailed: boolean;
  alerts: string[];
  report: string;
};

export const checkCostCapsAndAlert = async (prisma: PrismaClient): Promise<CostCapAlertResult> => {
  const now = new Date();
  const month = monthKey(now);
  const monthStart = startOfUtcMonth(now);
  const totals = await aggregateMtdSpend(prisma, monthStart);
  const rows = buildProviderRows(totals);

  const trackedMtd = rows
    .filter((r) => r.autoTrack)
    .reduce((sum, r) => sum + r.mtdUsd, 0);
  const totalMtd = trackedMtd + (capForProvider('infra')?.monthlyCapUsd ?? 0);
  const report = formatReport(rows, totalMtd, now);

  const alerts: string[] = [];
  const candidates: Array<{ provider: CostProvider; threshold: Threshold; row: ProviderSpend }> =
    [];

  for (const row of rows) {
    if (!row.autoTrack || row.capUsd <= 0) continue;
    if (row.mtdUsd >= row.capUsd) {
      candidates.push({ provider: row.provider, threshold: '100', row });
    } else if (row.mtdUsd >= row.capUsd * WARN_FRACTION) {
      candidates.push({ provider: row.provider, threshold: '80', row });
    }
  }

  if (totalMtd >= TOTAL_CAP_USD) {
    candidates.push({
      provider: 'infra',
      threshold: '100',
      row: {
        provider: 'infra',
        label: 'Total infra+APIs',
        capUsd: TOTAL_CAP_USD,
        mtdUsd: totalMtd,
        pct: (totalMtd / TOTAL_CAP_USD) * 100,
        autoTrack: true,
      },
    });
  } else if (totalMtd >= TOTAL_CAP_USD * WARN_FRACTION) {
    candidates.push({
      provider: 'infra',
      threshold: '80',
      row: {
        provider: 'infra',
        label: 'Total infra+APIs',
        capUsd: TOTAL_CAP_USD,
        mtdUsd: totalMtd,
        pct: (totalMtd / TOTAL_CAP_USD) * 100,
        autoTrack: true,
      },
    });
  }

  for (const { provider, threshold, row } of candidates) {
    const entity = row.label === 'Total infra+APIs' ? 'total' : provider;
    if (await alertAlreadySent(prisma, entity, threshold, month)) continue;
    alerts.push(
      `${row.label}: ${fmtUsd(row.mtdUsd)} / ${fmtUsd(row.capUsd)} (${row.pct.toFixed(0)}%)`,
    );
    await markAlertSent(prisma, entity, threshold, month, row.mtdUsd, row.capUsd);
  }

  const recipient = process.env.BRIEF_RECIPIENT ?? '';
  if (alerts.length > 0 && recipient !== '') {
    const subject =
      alerts.some((a) => a.includes('Total infra'))
        ? `[SSA] Cost cap alert — total at ${((totalMtd / TOTAL_CAP_USD) * 100).toFixed(0)}%`
        : `[SSA] Cost cap alert — ${alerts.length} provider(s) approaching limits`;
    await sendEmail({
      to: recipient,
      subject,
      body: `${alerts.join('\n')}\n\n${report}`,
    });
  }

  return { emailed: alerts.length > 0 && recipient !== '', alerts, report };
};
