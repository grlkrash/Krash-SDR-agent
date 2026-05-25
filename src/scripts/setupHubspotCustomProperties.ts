// Idempotent one-shot to provision custom CRM properties on Company, Contact,
// and Deal objects. Safe to re-run: GET first, create only on 404.
//
// All three object types use HubSpot's built-in property groups
// ('companyinformation', 'contactinformation', 'dealinformation') so the
// script needs zero manual setup in the HubSpot UI. The ss_ prefix
// namespaces these fields so they're easy to find.
//
// Run: tsx src/scripts/setupHubspotCustomProperties.ts

import 'dotenv/config';
import {
  PropertyCreate,
  PropertyCreateFieldTypeEnum,
  PropertyCreateTypeEnum,
} from '@hubspot/api-client/lib/codegen/crm/properties/models/PropertyCreate.js';
import type { OptionInput } from '@hubspot/api-client/lib/codegen/crm/properties/models/OptionInput.js';
import { hs, hsRetry } from '../shared/hubspot.js';

const PACING_MS = 100;
const GROUP_COMPANY = 'companyinformation';
const GROUP_CONTACT = 'contactinformation';
const GROUP_DEAL = 'dealinformation';
const NOT_FOUND = 404;

type ObjectType = 'companies' | 'contacts' | 'deals';

type PropSpec = {
  objectType: ObjectType;
  groupName: string;
  name: string;
  label: string;
  description: string;
  type: PropertyCreateTypeEnum;
  fieldType: PropertyCreateFieldTypeEnum;
  options?: OptionInput[];
};

const sleep = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));

// HubSpot SDK ApiException surfaces the HTTP status as `code`.
const getStatusCode = (err: unknown): number | null => {
  if (typeof err !== 'object' || err === null) return null;
  const e = err as Record<string, unknown>;
  return typeof e.code === 'number' ? e.code : null;
};

const buildOptions = (values: string[]): OptionInput[] =>
  values.map((value, index) => ({
    label: value,
    value,
    hidden: false,
    displayOrder: index,
    description: '',
  }));

const PROPERTIES: PropSpec[] = [
  {
    objectType: 'companies',
    groupName: GROUP_COMPANY,
    name: 'ss_source',
    label: 'SS Source',
    description: 'Discovery source that produced this lead.',
    type: PropertyCreateTypeEnum.Enumeration,
    fieldType: PropertyCreateFieldTypeEnum.Select,
    options: buildOptions(['samhsa', 'gmaps', 'psychtoday']),
  },
  {
    objectType: 'companies',
    groupName: GROUP_COMPANY,
    name: 'ss_google_rating',
    label: 'SS Google Rating',
    description: 'Google Maps star rating (0.0–5.0).',
    type: PropertyCreateTypeEnum.Number,
    fieldType: PropertyCreateFieldTypeEnum.Number,
  },
  {
    objectType: 'companies',
    groupName: GROUP_COMPANY,
    name: 'ss_google_reviews',
    label: 'SS Google Reviews',
    description: 'Google Maps total review count.',
    type: PropertyCreateTypeEnum.Number,
    fieldType: PropertyCreateFieldTypeEnum.Number,
  },
  {
    objectType: 'companies',
    groupName: GROUP_COMPANY,
    name: 'ss_expected_product',
    label: 'SS Expected Product',
    description: 'Product tier the scorer expects this account to land on.',
    type: PropertyCreateTypeEnum.Enumeration,
    fieldType: PropertyCreateFieldTypeEnum.Select,
    options: buildOptions(['claimed', 'select', 'premium']),
  },
  {
    objectType: 'companies',
    groupName: GROUP_COMPANY,
    name: 'ss_pain_points',
    label: 'SS Pain Points',
    description: 'Human-readable summary of pain points extracted from enrichment.',
    type: PropertyCreateTypeEnum.String,
    fieldType: PropertyCreateFieldTypeEnum.Textarea,
  },
  {
    objectType: 'companies',
    groupName: GROUP_COMPANY,
    name: 'ss_signals',
    label: 'SS Signals (JSON)',
    description: 'JSON.stringify of the intelligence signals object.',
    type: PropertyCreateTypeEnum.String,
    fieldType: PropertyCreateFieldTypeEnum.Textarea,
  },
  {
    objectType: 'companies',
    groupName: GROUP_COMPANY,
    name: 'ss_legitscript_status',
    label: 'SS LegitScript Status',
    description: 'LegitScript certification status as scraped/enriched.',
    type: PropertyCreateTypeEnum.String,
    fieldType: PropertyCreateFieldTypeEnum.Text,
  },
  {
    objectType: 'contacts',
    groupName: GROUP_CONTACT,
    name: 'ss_linkedin_url',
    label: 'SS LinkedIn URL',
    description: 'LinkedIn profile URL for this contact.',
    type: PropertyCreateTypeEnum.String,
    fieldType: PropertyCreateFieldTypeEnum.Text,
  },
  {
    objectType: 'deals',
    groupName: GROUP_DEAL,
    name: 'ss_renewal_date',
    label: 'SS Renewal Date',
    description: 'Contract renewal date for upsell tracking.',
    type: PropertyCreateTypeEnum.Date,
    fieldType: PropertyCreateFieldTypeEnum.Date,
  },
  {
    objectType: 'deals',
    groupName: GROUP_DEAL,
    name: 'ss_product_type',
    label: 'SS Product Type',
    description: 'Product/service line associated with the deal.',
    type: PropertyCreateTypeEnum.Enumeration,
    fieldType: PropertyCreateFieldTypeEnum.Select,
    options: buildOptions([
      'claimed',
      'select',
      'premium',
      'seo',
      'social',
      'ppc',
      'upsell-bundle',
    ]),
  },
];

const toPropertyCreate = (spec: PropSpec): PropertyCreate => {
  const body: PropertyCreate = {
    name: spec.name,
    label: spec.label,
    description: spec.description,
    type: spec.type,
    fieldType: spec.fieldType,
    groupName: spec.groupName,
  };
  if (spec.options) body.options = spec.options;
  return body;
};

const log = (event: Record<string, unknown>): void => {
  console.log(JSON.stringify(event));
};

let created = 0;
let existed = 0;

for (const spec of PROPERTIES) {
  try {
    await hsRetry(() =>
      hs.crm.properties.coreApi.getByName(spec.objectType, spec.name),
    );
    existed += 1;
    log({ status: 'exists', objectType: spec.objectType, name: spec.name });
  } catch (err) {
    if (getStatusCode(err) !== NOT_FOUND) throw err;
    await hsRetry(() =>
      hs.crm.properties.coreApi.create(spec.objectType, toPropertyCreate(spec)),
    );
    created += 1;
    log({ status: 'created', objectType: spec.objectType, name: spec.name });
  }
  await sleep(PACING_MS);
}

log({ status: 'done', total: PROPERTIES.length, created, existed });
