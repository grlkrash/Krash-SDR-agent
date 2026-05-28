// Scrape public directory listings and flag matching Lead rows for cold exclusion.

import { Prisma, type PrismaClient } from '@prisma/client';
import { applyExclusionToLead } from './applyExclusion.js';
import { buildLeadIndex, matchRowToLead } from './matchLead.js';
import type { ExclusionImportRow } from './normalizeRow.js';
import { parseScrapedLabel } from './parseScrapedLabel.js';
import { fetchDirectoryCatalogStats } from './fetchDirectoryApi.js';
import { scrapeDirectoryCenters } from './scrapeDirectory.js';

const SOURCE_FILE = 'sobrietyselect.com/directory-api';
const SOURCE_TAG = 'directory-scrape-auto';

export type SyncDirectoryResult = {
  scrapedCenters: number;
  verifiedSubscribe: number;
  verifiedAds: number;
  catalogTotalEstimate: number;
  matched: number;
  applied: number;
  ambiguous: number;
  unmatchedOnSite: number;
  cancelledDrafts: number;
  hubspotLeadCount: number;
  hubspotCrossoverCount: number;
  hubspotCrossoverSamples: Array<{
    leadId: string;
    leadName: string;
    city: string;
    state: string;
    hubspotCompanyId: string;
  }>;
  appliedSamples: Array<{ leadId: string; leadName: string; city: string; state: string }>;
};

export const syncDirectoryListings = async (
  prisma: PrismaClient,
): Promise<SyncDirectoryResult> => {
  const scraped = await scrapeDirectoryCenters();
  const catalogStats = await fetchDirectoryCatalogStats();

  const leads = await prisma.lead.findMany({
    select: {
      id: true,
      name: true,
      nameNormalized: true,
      addressHash: true,
      city: true,
      state: true,
      website: true,
      hubspotCompanyId: true,
    },
  });
  const index = buildLeadIndex(leads);

  const result: SyncDirectoryResult = {
    scrapedCenters: scraped.length,
    verifiedSubscribe: scraped.filter((c) => c.subscriptionType === 'subscribe').length,
    verifiedAds: scraped.filter((c) => c.subscriptionType === 'ads').length,
    catalogTotalEstimate: catalogStats.catalogTotalEstimate,
    matched: 0,
    applied: 0,
    ambiguous: 0,
    unmatchedOnSite: 0,
    cancelledDrafts: 0,
    hubspotLeadCount: leads.filter((l) => l.hubspotCompanyId !== null).length,
    hubspotCrossoverCount: 0,
    hubspotCrossoverSamples: [],
    appliedSamples: [],
  };

  const matchedLeadIds = new Set<string>();

  for (const center of scraped) {
    const cleaned = center.name !== ''
      ? { name: center.name, city: center.city, state: center.state }
      : parseScrapedLabel(center.rawLabel);
    const row: ExclusionImportRow = {
      externalId: center.slug,
      name: cleaned.name,
      street: center.address,
      city: cleaned.city,
      state: cleaned.state,
      zip: null,
      website: null,
      domain: null,
      email: null,
      phone: null,
      tier: center.subscriptionType,
      status: 'active',
    };

    const match = matchRowToLead(row, index, leads);
    if (match.status === 'unmatched') {
      result.unmatchedOnSite += 1;
      continue;
    }
    if (match.status === 'ambiguous') {
      result.ambiguous += 1;
      await prisma.auditLog.create({
        data: {
          action: 'exclusion.directory-ambiguous',
          entity: 'exclusion',
          meta: {
            rawLabel: center.rawLabel,
            leadIds: match.leadIds,
            slug: center.slug,
          } as Prisma.InputJsonValue,
        },
      });
      continue;
    }

    result.matched += 1;
    matchedLeadIds.add(match.leadId);

    const applied = await applyExclusionToLead(prisma, {
      leadId: match.leadId,
      kind: 'directory-listed',
      row,
      matchConfidence: match.confidence,
      sourceFile: SOURCE_FILE,
      sourceTag: SOURCE_TAG,
    });
    result.applied += 1;
    result.cancelledDrafts += applied.cancelledDrafts;

    const lead = leads.find((l) => l.id === match.leadId);
    if (lead !== undefined && result.appliedSamples.length < 30) {
      result.appliedSamples.push({
        leadId: lead.id,
        leadName: lead.name,
        city: lead.city,
        state: lead.state,
      });
    }

    await prisma.auditLog.create({
      data: {
        action: 'exclusion.directory-auto-applied',
        entity: 'lead',
        entityId: match.leadId,
        meta: {
          rawLabel: center.rawLabel,
          slug: center.slug,
          confidence: match.confidence,
          cancelledDrafts: applied.cancelledDrafts,
        } as Prisma.InputJsonValue,
      },
    });
  }

  for (const lead of leads) {
    if (lead.hubspotCompanyId === null) continue;
    if (!matchedLeadIds.has(lead.id)) continue;
    result.hubspotCrossoverCount += 1;
    if (result.hubspotCrossoverSamples.length < 30) {
      result.hubspotCrossoverSamples.push({
        leadId: lead.id,
        leadName: lead.name,
        city: lead.city,
        state: lead.state,
        hubspotCompanyId: lead.hubspotCompanyId,
      });
    }
  }

  await prisma.auditLog.create({
    data: {
      action: 'exclusion.directory-sync-complete',
      entity: 'exclusion',
      meta: result as unknown as Prisma.InputJsonValue,
    },
  });

  return result;
};
