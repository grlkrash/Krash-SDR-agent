// Pulls outbound HubSpot call engagements into AuditLog so the engagement
// dashboard can report call activity that was logged DIRECTLY in HubSpot, not
// just dispositions clicked through /cold-call. Same shape as
// meetingAttribution: a daily cron syncs HubSpot → idempotent AuditLog rows
// (hubspot.call-synced), and emailEngagementStats reads them DB-only.
//
// This is the account-wide superset of outbound calls (it includes the call
// engagements the app itself writes via logHubspotOutboundCall — they're real
// calls — so the dashboard's "all calls" line is always ≥ the app-logged cold
// cadence line). Dedup is by engagement id, so re-runs are cheap and exact.

import { PrismaPg } from '@prisma/adapter-pg';
import { Prisma, PrismaClient } from '@prisma/client';
import { FilterOperatorEnum } from '@hubspot/api-client/lib/codegen/crm/objects/calls/models/Filter.js';
import { hs, hsRetry } from '../shared/hubspot.js';

const MS_PER_DAY = 86_400_000;
const LOOKBACK_DAYS = 30;
const SEARCH_PAGE_SIZE = 100;
const PACING_MS = 80;
const OUTBOUND = 'OUTBOUND';
const APP_CONNECTED_VALUE = 'connected';
const CALL_PROPERTIES = [
  'hs_call_disposition',
  'hs_call_direction',
  'hs_timestamp',
  'hs_createdate',
];

const prisma = new PrismaClient({
  adapter: new PrismaPg({ connectionString: process.env.DATABASE_URL ?? '' }),
});

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

const audit = (
  action: string,
  entityId: string,
  meta: Prisma.InputJsonValue,
): Promise<unknown> =>
  prisma.auditLog.create({ data: { action, entity: 'call', entityId, meta } });

const parseHsMs = (raw: string | null | undefined): number | null => {
  if (raw === null || raw === undefined || raw === '') return null;
  const iso = Date.parse(raw);
  if (!Number.isNaN(iso)) return iso;
  const num = Number(raw);
  if (!Number.isNaN(num) && num > 0) return num;
  return null;
};

// The portal's own "Connected"-type disposition option GUIDs, plus the literal
// value the app writes. Reading the option list keeps us robust to per-portal
// custom dispositions rather than hardcoding HubSpot's default GUIDs.
const loadConnectedDispositionValues = async (): Promise<Set<string>> => {
  const connected = new Set<string>([APP_CONNECTED_VALUE]);
  try {
    const prop = await hsRetry(() =>
      hs.crm.properties.coreApi.getByName('calls', 'hs_call_disposition'),
    );
    for (const option of prop.options ?? []) {
      if (option.label.toLowerCase().includes('connect')) connected.add(option.value);
    }
  } catch {
    // Fall back to the literal app value only — better than failing the sync.
  }
  return connected;
};

export type CallSyncResult = { scanned: number; synced: number; skipped: number };

export const syncRecentCallDispositions = async (): Promise<CallSyncResult> => {
  const now = Date.now();
  const sinceMs = now - LOOKBACK_DAYS * MS_PER_DAY;
  const connectedValues = await loadConnectedDispositionValues();

  let scanned = 0;
  let synced = 0;
  let skipped = 0;
  let after: string | undefined = undefined;

  while (true) {
    const res = await hsRetry(() =>
      hs.crm.objects.calls.searchApi.doSearch({
        filterGroups: [{
          filters: [
            { propertyName: 'hs_timestamp', operator: FilterOperatorEnum.Gte, value: String(sinceMs) },
            { propertyName: 'hs_call_direction', operator: FilterOperatorEnum.Eq, value: OUTBOUND },
          ],
        }],
        properties: CALL_PROPERTIES,
        limit: SEARCH_PAGE_SIZE,
        after: after ?? '',
      }),
    );

    for (const call of res.results) {
      scanned += 1;
      const existing = await prisma.auditLog.findFirst({
        where: { action: 'hubspot.call-synced', entityId: call.id },
        select: { id: true },
      });
      if (existing !== null) {
        skipped += 1;
        continue;
      }
      const disposition = call.properties?.hs_call_disposition ?? null;
      const connected = disposition !== null && connectedValues.has(disposition);
      const atMs = parseHsMs(call.properties?.hs_timestamp ?? call.properties?.hs_createdate) ?? now;
      await audit('hubspot.call-synced', call.id, {
        disposition,
        connected,
        at: new Date(atMs).toISOString(),
      });
      synced += 1;
    }

    const next = res.paging?.next?.after;
    if (next === undefined || next === '') break;
    after = next;
    await sleep(PACING_MS);
  }

  return { scanned, synced, skipped };
};
