import { PrismaPg } from '@prisma/adapter-pg';
import { Prisma, PrismaClient } from '@prisma/client';
import { hs, hsRetry } from './hubspot.js';

const prisma = new PrismaClient({
  adapter: new PrismaPg({ connectionString: process.env.DATABASE_URL ?? '' }),
});

const audit = (
  action: string,
  entityId: string,
  meta: Prisma.InputJsonValue,
): Promise<unknown> =>
  prisma.auditLog.create({ data: { action, entity: 'note', entityId, meta } });

export const logHubspotNote = async (opts: {
  leadId: string;
  companyId: string | null;
  body: string;
}): Promise<string | null> => {
  const trimmed = opts.body.trim();
  if (trimmed === '') return null;
  if (opts.companyId === null) {
    await audit('hubspotNote.skipped-no-company', opts.leadId, {});
    return null;
  }
  try {
    const created = await hsRetry(() =>
      hs.crm.objects.notes.basicApi.create({
        properties: {
          hs_timestamp: Date.now().toString(),
          hs_note_body: trimmed,
          hubspot_owner_id: process.env.HUBSPOT_OWNER_ID ?? '',
        },
        associations: [],
      }),
    );
    const noteId = created.id;
    if (noteId === null || noteId === undefined) {
      throw new Error('HubSpot did not return a note id');
    }
    await hsRetry(() =>
      hs.crm.associations.v4.basicApi.createDefault(
        'notes', noteId, 'companies', opts.companyId ?? '',
      ),
    );
    await audit('hubspotNote.logged', opts.leadId, {
      noteId: created.id,
      companyId: opts.companyId,
      chars: trimmed.length,
    });
    return created.id;
  } catch (err) {
    await audit('hubspotNote.failed', opts.leadId, {
      error: err instanceof Error ? err.message : String(err),
    });
    return null;
  }
};
