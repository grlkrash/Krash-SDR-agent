import { PrismaPg } from '@prisma/adapter-pg';
import { Prisma, PrismaClient, type Contact, type Lead } from '@prisma/client';
import { z } from 'zod';
import { upsertLead } from '../shared/lead.js';
import { enrichLead } from './enrich.js';

const prisma = new PrismaClient({
  adapter: new PrismaPg({ connectionString: process.env.DATABASE_URL ?? '' }),
});

const QuickAddBrandInputSchema = z.object({
  name: z.string().trim().min(1),
  projectSlug: z.string().trim().min(1),
  street: z.string().trim().nullable().optional(),
  city: z.string().trim().min(1),
  state: z.string().trim().min(2),
  zip: z.string().trim().nullable().optional(),
  phone: z.string().trim().nullable().optional(),
  website: z.string().trim().nullable().optional(),
  googleRating: z.number().nullable().optional(),
  googleReviews: z.number().int().nullable().optional(),
  services: z.array(z.string()).optional(),
  placesMatch: z.record(z.string(), z.unknown()).nullable().optional(),
  contactName: z.string().trim().nullable().optional(),
  contactRole: z.string().trim().nullable().optional(),
  contactEmail: z.string().trim().email().nullable().optional(),
});

export type QuickAddBrandInput = z.infer<typeof QuickAddBrandInputSchema>;

export type QuickAddBrandResult = {
  lead: Lead;
  contact: Contact;
};

export const quickAddBrand = async (rawInput: QuickAddBrandInput): Promise<QuickAddBrandResult> => {
  const input = QuickAddBrandInputSchema.parse(rawInput);
  const placesMatch = input.placesMatch ?? null;
  const lead = await upsertLead({
    source: 'quick-add',
    name: input.name,
    street: input.street ?? null,
    city: input.city,
    state: input.state,
    zip: input.zip ?? null,
    phone: input.phone ?? null,
    website: input.website ?? null,
    googleRating: input.googleRating ?? null,
    googleReviews: input.googleReviews ?? null,
    services: input.services ?? [],
    sourceMeta: {
      quickAdd: true,
      projectSlug: input.projectSlug,
      placesMatch,
    },
    contactName: input.contactName ?? null,
    contactRole: input.contactRole ?? null,
    contactEmail: input.contactEmail ?? null,
  });

  const existingContact = await prisma.contact.findFirst({
    where: { leadId: lead.id, isPrimary: true },
  });

  const contact = existingContact ?? await prisma.contact.create({
    data: {
      leadId: lead.id,
      name: lead.contactName ?? lead.name,
      role: lead.contactRole ?? 'Partnerships',
      email: lead.contactEmail ?? null,
      isPrimary: true,
    },
  });

  if (existingContact === null) {
    await prisma.auditLog.create({
      data: {
        action: 'brands.quickAdd.contactCreated',
        entity: 'contact',
        entityId: contact.id,
        meta: {
          leadId: lead.id,
          projectSlug: input.projectSlug,
          placesMatch,
        } as Prisma.InputJsonValue,
      },
    });
  }

  await enrichLead(lead.id);
  return { lead, contact };
};
