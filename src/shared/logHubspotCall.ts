import { PrismaPg } from '@prisma/adapter-pg';
import { Prisma, PrismaClient } from '@prisma/client';
import { hs, hsRetry } from './hubspot.js';

const HUBSPOT_CALL_DIRECTION = 'OUTBOUND';

const prisma = new PrismaClient({
  adapter: new PrismaPg({ connectionString: process.env.DATABASE_URL ?? '' }),
});

const audit = (
  action: string,
  draftId: string,
  meta: Prisma.InputJsonValue,
): Promise<unknown> =>
  prisma.auditLog.create({ data: { action, entity: 'Draft', entityId: draftId, meta } });

export const logHubspotOutboundCall = async (opts: {
  draftId: string;
  companyId: string | null;
  disposition: string;
  callStatus?: string;
}): Promise<void> => {
  try {
    if (opts.companyId === null) {
      await audit('voicemail.hubspot-skipped-no-company', opts.draftId, {});
      return;
    }
    const created = await hsRetry(() =>
      hs.crm.objects.calls.basicApi.create({
        properties: {
          hs_timestamp: Date.now().toString(),
          hs_call_direction: HUBSPOT_CALL_DIRECTION,
          hs_call_status: opts.callStatus ?? 'COMPLETED',
          hs_call_disposition: opts.disposition,
          hubspot_owner_id: process.env.HUBSPOT_OWNER_ID ?? '',
        },
        associations: [],
      }),
    );
    await hsRetry(() =>
      hs.crm.associations.v4.basicApi.createDefault(
        'calls', created.id, 'companies', opts.companyId ?? '',
      ),
    );
    await audit('voicemail.hubspot-logged', opts.draftId, {
      callEngagementId: created.id,
      companyId: opts.companyId,
      disposition: opts.disposition,
    });
  } catch (err) {
    await audit('voicemail.hubspot-failed', opts.draftId, {
      error: err instanceof Error ? err.message : String(err),
    });
  }
};
