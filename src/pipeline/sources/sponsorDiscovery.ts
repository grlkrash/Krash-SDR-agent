import { Prisma } from '@prisma/client';
import { DISCOVERY } from '../../config/discoveryConfig.js';
import { prisma } from '../../shared/prismaClient.js';
import { enrichLead } from '../enrich.js';

const DEFAULT_LEADS_PER_RUN = 10;
const MAX_LEADS_PER_RUN = Number(process.env.SPONSOR_DISCOVERY_LEAD_LIMIT ?? DEFAULT_LEADS_PER_RUN);

export type SponsorDiscoverySummary = {
  projectSlug: string;
  status: 'complete';
  inspectedLeadCount: number;
  enrichedLeadCount: number;
  failedLeadCount: number;
  skippedReason: string | null;
  limits: {
    maxLeadsPerRun: number;
    maxSerperQueriesPerLead: number;
    maxLinkedInProfilesPerLead: number;
    maxClaudeCallsPerLead: number;
  };
};

export const runSponsorDiscovery = async (projectSlug: string): Promise<SponsorDiscoverySummary> => {
  if (projectSlug.trim() === '') {
    throw new Error('projectSlug is required for sponsor discovery');
  }

  await prisma.auditLog.create({
    data: {
      action: 'sponsorDiscovery.request',
      entity: 'project',
      entityId: projectSlug,
      meta: {} as Prisma.InputJsonValue,
    },
  });

  const inspectedLeadCount = await prisma.lead.count({ where: { doNotContact: false } });
  const shouldRunEnrichment = DISCOVERY.MAX_CLAUDE_CALLS_PER_LEAD > 0 && MAX_LEADS_PER_RUN > 0;
  let enrichedLeadCount = 0;
  let failedLeadCount = 0;
  let skippedReason: string | null = null;

  if (shouldRunEnrichment) {
    const leads = await prisma.lead.findMany({
      where: {
        doNotContact: false,
        enrichment: null,
      },
      select: { id: true },
      orderBy: { createdAt: 'desc' },
      take: MAX_LEADS_PER_RUN,
    });

    for (const lead of leads) {
      try {
        await enrichLead(lead.id);
        enrichedLeadCount += 1;
      } catch (err) {
        failedLeadCount += 1;
        await prisma.auditLog.create({
          data: {
            action: 'sponsorDiscovery.enrichFailed',
            entity: 'lead',
            entityId: lead.id,
            meta: {
              projectSlug,
              error: err instanceof Error ? err.message : String(err),
            } as Prisma.InputJsonValue,
          },
        });
      }
    }
  } else {
    skippedReason = 'sponsor discovery enrichment skipped by config limits';
  }

  const summary: SponsorDiscoverySummary = {
    projectSlug,
    status: 'complete',
    inspectedLeadCount,
    enrichedLeadCount,
    failedLeadCount,
    skippedReason,
    limits: {
      maxLeadsPerRun: MAX_LEADS_PER_RUN,
      maxSerperQueriesPerLead: DISCOVERY.MAX_SERPER_QUERIES_PER_LEAD,
      maxLinkedInProfilesPerLead: DISCOVERY.MAX_LINKEDIN_PROFILES_PER_LEAD,
      maxClaudeCallsPerLead: DISCOVERY.MAX_CLAUDE_CALLS_PER_LEAD,
    },
  };

  await prisma.auditLog.create({
    data: {
      action: 'sponsorDiscovery.complete',
      entity: 'project',
      entityId: projectSlug,
      meta: summary as unknown as Prisma.InputJsonValue,
    },
  });

  return summary;
};
