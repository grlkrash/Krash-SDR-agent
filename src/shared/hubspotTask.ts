import { Prisma, PrismaClient } from '@prisma/client';
import { PrismaPg } from '@prisma/adapter-pg';
import { hs, hsRetry } from './hubspot.js';

const prisma = new PrismaClient({
  adapter: new PrismaPg({ connectionString: process.env.DATABASE_URL ?? '' }),
});

const audit = (
  action: string,
  entityId: string,
  meta: Prisma.InputJsonValue,
): Promise<unknown> =>
  prisma.auditLog.create({ data: { action, entity: 'HubspotTask', entityId, meta } });

export const createHubspotTask = async (opts: {
  subject: string;
  body: string;
  dueAt: Date;
  companyId: string | null;
  draftId: string;
  touchNumber: number;
}): Promise<string | null> => {
  try {
    const created = await hsRetry(() =>
      hs.crm.objects.tasks.basicApi.create({
        properties: {
          hs_task_subject: opts.subject,
          hs_task_body: opts.body,
          hs_task_status: 'NOT_STARTED',
          hs_task_priority: 'HIGH',
          hs_timestamp: opts.dueAt.getTime().toString(),
          hubspot_owner_id: process.env.HUBSPOT_OWNER_ID ?? '',
        },
        associations: [],
      }),
    );
    if (opts.companyId !== null) {
      await hsRetry(() =>
        hs.crm.associations.v4.basicApi.createDefault(
          'tasks',
          created.id,
          'companies',
          opts.companyId ?? '',
        ),
      );
    }
    await audit('hubspotTask.created', opts.draftId, {
      taskId: created.id,
      touchNumber: opts.touchNumber,
      companyId: opts.companyId,
      dueAt: opts.dueAt.toISOString(),
    });
    return created.id;
  } catch (err) {
    await audit('hubspotTask.create-failed', opts.draftId, {
      touchNumber: opts.touchNumber,
      error: err instanceof Error ? err.message : String(err),
    });
    return null;
  }
};

export const completeHubspotTask = async (opts: {
  taskId: string;
  draftId: string;
}): Promise<void> => {
  try {
    await hsRetry(() =>
      hs.crm.objects.tasks.basicApi.update(opts.taskId, {
        properties: { hs_task_status: 'COMPLETED' },
      }),
    );
    await audit('hubspotTask.completed', opts.draftId, { taskId: opts.taskId });
  } catch (err) {
    await audit('hubspotTask.complete-failed', opts.draftId, {
      taskId: opts.taskId,
      error: err instanceof Error ? err.message : String(err),
    });
  }
};
