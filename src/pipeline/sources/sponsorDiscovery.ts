import { Prisma } from '@prisma/client';
import { DISCOVERY } from '../../config/discoveryConfig.js';
import { prisma } from '../../shared/prismaClient.js';

export type SponsorDiscoverySummary = {
  projectSlug: string;
  status: 'skipped';
  reason: string;
  inspectedLeadCount: number;
  limits: {
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
  const summary: SponsorDiscoverySummary = {
    projectSlug,
    status: 'skipped',
    reason: 'sponsor discovery pipeline is not implemented on this branch; durable job plumbing is ready',
    inspectedLeadCount,
    limits: {
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
