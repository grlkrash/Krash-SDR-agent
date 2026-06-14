import { Prisma, type Job } from '@prisma/client';
import { z } from 'zod';
import { prisma } from '../shared/prismaClient.js';

const DAYS_THRESHOLD = Number(process.env.SCHEDULE_DAYS_THRESHOLD ?? 7);
const MS_PER_DAY = 24 * 60 * 60 * 1_000;
const RECENT_COMPLETE_SCAN_LIMIT = 50;

const JobParamsSchema = z.object({
  projectSlug: z.string().trim().min(1),
});

const logInfo = (message: string, meta: Record<string, unknown> = {}): void => {
  process.stdout.write(`${JSON.stringify({ level: 'info', message, ...meta })}\n`);
};

const logError = (message: string, meta: Record<string, unknown> = {}): void => {
  process.stderr.write(`${JSON.stringify({ level: 'error', message, ...meta })}\n`);
};

const auditSchedulerFailure = async (projectSlug: string, error: string): Promise<void> => {
  try {
    await prisma.auditLog.create({
      data: {
        action: 'scheduler.enqueueFailed',
        entity: 'project',
        entityId: projectSlug,
        meta: { error } as Prisma.InputJsonValue,
      },
    });
  } catch (auditErr) {
    logError('Failed to write scheduler failure audit', {
      projectSlug,
      error: auditErr instanceof Error ? auditErr.message : String(auditErr),
    });
  }
};

const projectSlugFromJob = (job: Pick<Job, 'params'>): string | null => {
  const parsed = JobParamsSchema.safeParse(job.params);
  return parsed.success ? parsed.data.projectSlug : null;
};

const getProjects = (): string[] =>
  (process.env.SCHEDULE_PROJECTS ?? '')
    .split(',')
    .map((s) => s.trim())
    .filter((s) => s !== '');

const hasRecentOrPendingJob = async (
  projectSlug: string,
  daysThreshold = DAYS_THRESHOLD,
): Promise<boolean> => {
  const openJobs = await prisma.job.findMany({
    where: {
      type: 'sponsorDiscovery',
      status: { in: ['pending', 'running'] },
    },
    orderBy: { createdAt: 'desc' },
  });
  for (const job of openJobs) {
    if (projectSlugFromJob(job) === projectSlug) return true;
  }

  const cutoff = new Date(Date.now() - daysThreshold * MS_PER_DAY);
  const recentComplete = await prisma.job.findMany({
    where: {
      type: 'sponsorDiscovery',
      status: 'complete',
      createdAt: { gte: cutoff },
    },
    orderBy: { createdAt: 'desc' },
    take: RECENT_COMPLETE_SCAN_LIMIT,
  });
  for (const job of recentComplete) {
    if (projectSlugFromJob(job) === projectSlug) return true;
  }

  return false;
};

const enqueue = async (projectSlug: string): Promise<Job> => {
  const job = await prisma.job.create({
    data: {
      type: 'sponsorDiscovery',
      params: { projectSlug } as Prisma.InputJsonValue,
      status: 'pending',
      scheduledAt: new Date(),
    },
  });
  await prisma.auditLog.create({
    data: {
      action: 'scheduler.jobEnqueued',
      entity: 'job',
      entityId: job.id,
      meta: { projectSlug } as Prisma.InputJsonValue,
    },
  });
  return job;
};

export const runScheduler = async (): Promise<void> => {
  const projects = getProjects();
  if (projects.length === 0) {
    logInfo('No projects configured to schedule', {
      hint: 'Set SCHEDULE_PROJECTS to a comma-separated list.',
    });
    return;
  }

  for (const projectSlug of projects) {
    try {
      const skip = await hasRecentOrPendingJob(projectSlug);
      if (skip) {
        logInfo('Skipping project with recent or pending job', { projectSlug });
        continue;
      }

      const job = await enqueue(projectSlug);
      logInfo('Enqueued sponsorDiscovery job', { jobId: job.id, projectSlug });
    } catch (err) {
      const error = err instanceof Error ? err.message : String(err);
      logError('Failed to enqueue sponsorDiscovery job', { projectSlug, error });
      await auditSchedulerFailure(projectSlug, error);
      process.exitCode = 1;
    }
  }
};

await runScheduler();
