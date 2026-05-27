import { z } from 'zod';
import { extractDomain } from '../../shared/domain.js';

const firstNonEmpty = (rec: Record<string, string>, keys: string[]): string | null => {
  for (const key of keys) {
    const v = rec[key]?.trim();
    if (v !== undefined && v !== '') return v;
  }
  return null;
};

const RawRow = z.record(z.string(), z.string());

export const ExclusionImportRow = z.object({
  externalId: z.string().nullable(),
  name: z.string().min(1),
  street: z.string().nullable(),
  city: z.string().nullable(),
  state: z.string().nullable(),
  zip: z.string().nullable(),
  website: z.string().nullable(),
  domain: z.string().nullable(),
  email: z.string().nullable(),
  phone: z.string().nullable(),
  tier: z.string().nullable(),
  status: z.string().nullable(),
});
export type ExclusionImportRow = z.infer<typeof ExclusionImportRow>;

export const normalizeImportRow = (rec: Record<string, string>): ExclusionImportRow | null => {
  const raw = RawRow.parse(rec);
  const name = firstNonEmpty(raw, [
    'name',
    'facility_name',
    'facility name',
    'company',
    'company_name',
    'company name',
    'dealname',
  ]);
  if (name === null) return null;

  const website = firstNonEmpty(raw, ['website', 'url', 'domain', 'company_domain', 'website_url']);
  const domainFromCol = firstNonEmpty(raw, ['domain', 'company_domain']);
  const domain = domainFromCol ?? (website !== null ? extractDomain(website) : null);

  const status = firstNonEmpty(raw, ['status', 'listing_status', 'active']);
  if (status !== null) {
    const s = status.toLowerCase();
    if (['inactive', 'removed', 'deleted', 'draft', 'archived'].includes(s)) return null;
  }

  return ExclusionImportRow.parse({
    externalId: firstNonEmpty(raw, [
      'id',
      'facility_id',
      'facility id',
      'listing_id',
      'hubspot_company_id',
      'company_id',
      'hs_object_id',
    ]),
    name,
    street: firstNonEmpty(raw, ['street', 'address', 'address1', 'street_address']),
    city: firstNonEmpty(raw, ['city']),
    state: firstNonEmpty(raw, ['state', 'region']),
    zip: firstNonEmpty(raw, ['zip', 'zipcode', 'postal', 'postal_code']),
    website,
    domain,
    email: firstNonEmpty(raw, ['email', 'owner_email', 'contact_email', 'primary_email']),
    phone: firstNonEmpty(raw, ['phone', 'phone_e164', 'main_phone']),
    tier: firstNonEmpty(raw, [
      'tier',
      'listing_tier',
      'product',
      'ss_product_type',
      'expected_product',
      'plan',
    ]),
    status,
  });
};
