import { Prisma, type Job } from '@prisma/client';
import { z } from 'zod';
import { runSponsorDiscovery } from '../pipeline/sources/sponsorDiscovery.js';
import { prisma } from '../shared/prismaClient.js';

const POLL_INTERVAL_MS = Number(process.env.WORKER_POLL_MS ?? 5_000);
const MAX_ATTEMPTS = Number(process.env.WORKER_MAX_ATTEMPTS ?? 3);
const POST_JOB_PAUSE_MS = 200;
const RETRY_BASE_MS = 60_000;
const RETRY_CAP_MS = 5 * 60_000;

const JobParamsSchema = z.object({
  projectSlug: z.string().trim().min(1),
});

let shouldStop = false;

const sleep = (ms: number): Promise<void> =>
  new Promise((resolve) => {
    setTimeout(resolve, ms);
  });

const writeStderr = (event: string, meta: Record<string, unknown>): void => {
  process.stderr.write(`${JSON.stringify({ event, ...meta })}\n`);
};

const processSponsorDiscoveryJob = async (job: Job): Promise<void> => {
  const claimed = await prisma.job.update({
    where: { id: job.id },
    data: { status: 'running', attempts: { increment: 1 } },
  });

  try {
    await prisma.auditLog.create({
      data: {
        action: 'job.sponsorDiscovery.started',
        entity: 'job',
        entityId: claimed.id,
        meta: { params: claimed.params } as Prisma.InputJsonValue,
      },
    });

    const params = JobParamsSchema.parse(claimed.params);
    const summary = await runSponsorDiscovery(params.projectSlug);

    await prisma.job.update({
      where: { id: claimed.id },
      data: {
        status: 'complete',
        result: summary as unknown as Prisma.InputJsonValue,
      },
    });
    await prisma.auditLog.create({
      data: {
        action: 'job.sponsorDiscovery.finished',
        entity: 'job',
        entityId: claimed.id,
        meta: summary as unknown as Prisma.InputJsonValue,
      },
    });
  } catch (err) {
    const errorMsg = err instanceof Error ? err.message : String(err);
    if (claimed.attempts >= MAX_ATTEMPTS) {
      await prisma.job.update({
        where: { id: claimed.id },
        data: {
          status: 'failed',
          result: { error: errorMsg } as Prisma.InputJsonValue,
        },
      });
      await prisma.auditLog.create({
        data: {
          action: 'job.sponsorDiscovery.failed',
          entity: 'job',
          entityId: claimed.id,
          meta: { error: errorMsg, attempts: claimed.attempts } as Prisma.InputJsonValue,
        },
      });
      return;
    }

    const backoffMs = Math.min(RETRY_BASE_MS * claimed.attempts, RETRY_CAP_MS);
    await prisma.job.update({
      where: { id: claimed.id },
      data: {
        status: 'pending',
        scheduledAt: new Date(Date.now() + backoffMs),
        result: { error: errorMsg } as Prisma.InputJsonValue,
      },
    });
    await prisma.auditLog.create({
      data: {
        action: 'job.sponsorDiscovery.retryScheduled',
        entity: 'job',
        entityId: claimed.id,
        meta: {
          error: errorMsg,
          attempts: claimed.attempts,
          retryInMs: backoffMs,
        } as Prisma.InputJsonValue,
      },
    });
  }
};

const failUnsupportedJob = async (job: Job): Promise<void> => {
  await prisma.job.update({
    where: { id: job.id },
    data: {
      status: 'failed',
      result: { error: 'unsupported job type' } as Prisma.InputJsonValue,
    },
  });
  await prisma.auditLog.create({
    data: {
      action: 'job.unknownType',
      entity: 'job',
      entityId: job.id,
      meta: { type: job.type } as Prisma.InputJsonValue,
    },
  });
};

const pollOnce = async (): Promise<boolean> => {
  const now = new Date();
  const job = await prisma.job.findFirst({
    where: {
      status: 'pending',
      OR: [{ scheduledAt: null }, { scheduledAt: { lte: now } }],
    },
    orderBy: { createdAt: 'asc' },
  });
  if (job === null) return false;

  if (job.type === 'sponsorDiscovery') {
    await processSponsorDiscoveryJob(job);
  } else {
    await failUnsupportedJob(job);
  }
  return true;
};

export const pollLoop = async (): Promise<void> => {
  while (!shouldStop) {
    try {
      const processed = await pollOnce();
      await sleep(processed ? POST_JOB_PAUSE_MS : POLL_INTERVAL_MS);
    } catch (err) {
      writeStderr('sponsorDiscoveryWorker.pollError', {
        error: err instanceof Error ? err.message : String(err),
      });
      await sleep(POLL_INTERVAL_MS);
    }
  }
};

process.on('SIGINT', () => {
  shouldStop = true;
});

process.on('SIGTERM', () => {
  shouldStop = true;
});

await pollLoop();
