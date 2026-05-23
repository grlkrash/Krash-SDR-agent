import { z } from 'zod';
import { upsertLead } from '../../shared/lead.js';

const BASE_URL = 'https://findtreatment.gov/locator/exportsAsJson/v2';
const PAGE_SIZE = 2000;
const METERS_PER_MILE = 1609.34;
const USER_AGENT = 'Cardwell-Beach Sobriety-Select Research/1.0 (sonia@sobrietyselect.com)';

const SERVICE_CODE_MAP: Record<string, string> = {
  OTP: 'mat',
  BU: 'mat',
  NU: 'mat',
  DM: 'detox',
  IOP: 'iop',
  PHP: 'php',
  RES: 'residential',
  OUTPATIENT: 'outpatient',
};

const SamhsaServiceSchema = z.object({
  f1: z.string().optional(),
  f2: z.string().optional(),
  f3: z.string().optional(),
});

const SamhsaRowSchema = z
  .object({
    name1: z.string().nullable().optional(),
    name2: z.string().nullable().optional(),
    street1: z.string().nullable().optional(),
    street2: z.string().nullable().optional(),
    city: z.string(),
    state: z.string(),
    zip: z.string().nullable().optional(),
    phone: z.string().nullable().optional(),
    website: z.string().nullable().optional(),
    services: z.array(SamhsaServiceSchema).optional(),
  })
  .passthrough();

const SamhsaResponseSchema = z.object({
  page: z.number(),
  totalPages: z.number(),
  recordCount: z.number(),
  rows: z.array(SamhsaRowSchema),
});

const parseServices = (services: z.infer<typeof SamhsaServiceSchema>[] | undefined): string[] => {
  const mapped = new Set<string>();
  for (const svc of services ?? []) {
    for (const field of [svc.f1, svc.f2, svc.f3]) {
      if (field === undefined || field === '') continue;
      const target = SERVICE_CODE_MAP[field];
      if (target !== undefined) mapped.add(target);
    }
  }
  return [...mapped];
};

const buildStreet = (street1: string | null | undefined, street2: string | null | undefined): string | null => {
  const parts = [street1, street2].filter((p): p is string => Boolean(p?.trim()));
  if (parts.length === 0) return null;
  return parts.join(', ');
};

const fetchPage = async (
  lat: number,
  lng: number,
  meters: number,
  page: number,
): Promise<z.infer<typeof SamhsaResponseSchema>> => {
  const params = new URLSearchParams({
    sAddr: `${lat},${lng}`,
    limitType: '2',
    limitValue: String(meters),
    pageSize: String(PAGE_SIZE),
    page: String(page),
    sType: 'sa',
  });
  const res = await fetch(`${BASE_URL}?${params.toString()}`, {
    headers: { 'User-Agent': USER_AGENT },
  });
  if (!res.ok) {
    throw new Error(`SAMHSA fetch failed: ${res.status} ${res.statusText}`);
  }
  const json: unknown = await res.json();
  return SamhsaResponseSchema.parse(json);
};

export const scrapeSamhsa = async (lat: number, lng: number, radiusMiles: number): Promise<number> => {
  const meters = Math.round(radiusMiles * METERS_PER_MILE);
  let totalPages = 1;
  let upserted = 0;

  for (let page = 1; page <= totalPages; page++) {
    const data = await fetchPage(lat, lng, meters, page);
    totalPages = data.totalPages;

    for (const row of data.rows) {
      const name = (row.name1 || row.name2 || '').trim();
      if (name === '') continue;

      await upsertLead({
        source: 'samhsa',
        name,
        street: buildStreet(row.street1, row.street2),
        city: row.city,
        state: row.state,
        zip: row.zip ?? null,
        phone: row.phone ?? null,
        website: row.website ?? null,
        googleRating: null,
        googleReviews: null,
        services: parseServices(row.services),
        sourceMeta: row,
      });
      upserted += 1;
    }
  }

  return upserted;
};
