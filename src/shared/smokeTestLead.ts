// Smoke-test lead detection. Seeded lanes use the "SMOKE " name prefix and
// sourceMeta.smokeLane; SMOKE_TEST_LEAD_ID covers the operator's Twilio VM test
// row. These leads must never appear in production call queues or engagement
// metrics — they're operator inbox validation only.

import type { PrismaClient } from '@prisma/client';

const SMOKE_NAME_PREFIX = 'SMOKE ';

const smokeTestLeadId = (): string | null => {
  const raw = process.env.SMOKE_TEST_LEAD_ID?.trim() ?? '';
  return raw === '' ? null : raw;
};

export type SmokeTestLeadInput = {
  id: string;
  name: string;
  sourceMeta?: unknown;
};

export const isSmokeTestLead = (leadId: string): boolean => {
  const configured = smokeTestLeadId();
  return configured !== null && configured === leadId;
};

const hasSmokeLaneMeta = (meta: unknown): boolean => {
  if (meta === null || typeof meta !== 'object') return false;
  const lane = (meta as { smokeLane?: unknown }).smokeLane;
  return typeof lane === 'string' && lane !== '';
};

export const isSmokeTestLeadRecord = (lead: SmokeTestLeadInput): boolean => {
  if (isSmokeTestLead(lead.id)) return true;
  if (lead.name.startsWith(SMOKE_NAME_PREFIX)) return true;
  if (hasSmokeLaneMeta(lead.sourceMeta)) return true;
  return false;
};

export const loadSmokeTestLeadIds = async (prisma: PrismaClient): Promise<Set<string>> => {
  const ids = new Set<string>();
  const configured = smokeTestLeadId();
  if (configured !== null) ids.add(configured);

  const leads = await prisma.lead.findMany({
    where: {
      OR: [
        { name: { startsWith: SMOKE_NAME_PREFIX } },
        { id: configured ?? '__none__' },
      ],
    },
    select: { id: true, name: true, sourceMeta: true },
  });
  for (const lead of leads) {
    if (isSmokeTestLeadRecord(lead)) ids.add(lead.id);
  }
  return ids;
};
