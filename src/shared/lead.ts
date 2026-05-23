import { createHash } from 'node:crypto';
import { PrismaPg } from '@prisma/adapter-pg';
import { Prisma, PrismaClient, type Lead } from '@prisma/client';
import { parsePhoneNumberFromString } from 'libphonenumber-js';
import { z } from 'zod';

const adapter = new PrismaPg({ connectionString: process.env.DATABASE_URL ?? '' });
const prisma = new PrismaClient({ adapter });
const SUFFIX_RE = /\s*(?:llc|inc|corp|center|recovery|treatment|services)\s*$/i;

export const LeadInput = z.object({
  source: z.enum(['samhsa', 'gmaps', 'psychtoday']),
  name: z.string(),
  street: z.string().nullable(),
  city: z.string(),
  state: z.string(),
  zip: z.string().nullable(),
  phone: z.string().nullable(),
  website: z.string().nullable(),
  googleRating: z.number().nullable(),
  googleReviews: z.number().int().nullable(),
  services: z.array(z.string()),
  sourceMeta: z.record(z.string(), z.unknown()),
});

export const normalizeName = (name: string): string => {
  let s = name.toLowerCase().trim().replace(/[,.]/g, '');
  while (SUFFIX_RE.test(s)) s = s.replace(SUFFIX_RE, '').trim();
  return s.replace(/\s+/g, ' ').trim();
};

export const addressHash = (street: string | null, zip: string | null): string =>
  createHash('sha256')
    .update(`${(street ?? '').toLowerCase().replace(/[^a-z0-9]/g, '')}|${zip ?? ''}`)
    .digest('hex');

export const toE164 = (raw: string | null | undefined): string | null => {
  if (raw === null || raw === undefined || raw === '') return null;
  const p = parsePhoneNumberFromString(raw, 'US');
  return p?.isValid() ? p.format('E.164') : null;
};

const toLeadRow = (input: z.infer<typeof LeadInput>) => ({
  source: input.source,
  name: input.name,
  nameNormalized: normalizeName(input.name),
  street: input.street,
  city: input.city,
  state: input.state,
  zip: input.zip,
  addressHash: addressHash(input.street, input.zip),
  phoneE164: toE164(input.phone),
  website: input.website,
  googleRating: input.googleRating,
  googleReviews: input.googleReviews,
  services: input.services,
  sourceMeta: input.sourceMeta as Prisma.InputJsonValue,
});

export const upsertLead = async (input: z.infer<typeof LeadInput>): Promise<Lead> => {
  const data = toLeadRow(input);
  return prisma.lead.upsert({
    where: {
      nameNormalized_addressHash: {
        nameNormalized: data.nameNormalized,
        addressHash: data.addressHash,
      },
    },
    create: data,
    update: data,
  });
};
