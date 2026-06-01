// One-off backfill: repair HubSpot company records whose name/city/state were
// clobbered by the old domain-only dedup (last-writer-wins). When several
// facilities share one corporate domain (e.g. newseason.com, va.gov) they all
// map to a single HubSpot company; the prior sync overwrote that company's
// identity with whichever location synced last.
//
// Strategy: for every company id referenced by >1 lead, compute the canonical
// name as the most frequent lead name (tie-break: shortest, then alphabetical),
// and align city/state to a lead carrying that name. Only writes when HubSpot's
// current name differs — idempotent and self-limiting to the mislabeled records.
//
// Uses NO Claude/LLM calls, so the Anthropic rate limit does not apply.
// Dry-run by default; set APPLY=1 to write.

import 'dotenv/config';
import { PrismaPg } from '@prisma/adapter-pg';
import { PrismaClient } from '@prisma/client';
import { hs, hsRetry } from '../shared/hubspot.js';

const APPLY = process.env.APPLY === '1';

const prisma = new PrismaClient({
  adapter: new PrismaPg({ connectionString: process.env.DATABASE_URL ?? '' }),
});

type LeadIdentity = { name: string; city: string; state: string };

const mostFrequent = <T>(items: T[], score: (key: string) => number = () => 0): T => {
  const counts = new Map<string, { item: T; count: number }>();
  for (const item of items) {
    const key = JSON.stringify(item);
    const existing = counts.get(key);
    if (existing === undefined) counts.set(key, { item, count: 1 });
    else existing.count += 1;
  }
  const ranked = [...counts.entries()].sort((a, b) => {
    if (b[1].count !== a[1].count) return b[1].count - a[1].count;
    const extra = score(a[0]) - score(b[0]);
    if (extra !== 0) return extra;
    return a[0].localeCompare(b[0]);
  });
  return ranked[0]![1].item;
};

const canonicalIdentity = (leads: LeadIdentity[]): LeadIdentity => {
  // Most frequent name; tie-break toward the longer (more descriptive) name,
  // then alphabetical — a fuller name reads better in HubSpot than an acronym.
  const name = mostFrequent(
    leads.map((l) => l.name),
    (key) => -(JSON.parse(key).length as number),
  );
  // City/state from leads carrying the canonical name (most frequent pair).
  const matching = leads.filter((l) => l.name === name);
  const pool = matching.length > 0 ? matching : leads;
  const { city, state } = mostFrequent(pool.map((l) => ({ city: l.city, state: l.state })));
  return { name, city, state };
};

const run = async (): Promise<void> => {
  console.log(`Mode: ${APPLY ? 'APPLY (will write to HubSpot)' : 'DRY-RUN (no writes)'}`);

  const leads = await prisma.lead.findMany({
    where: { hubspotCompanyId: { not: null } },
    select: { hubspotCompanyId: true, name: true, city: true, state: true },
  });

  const byCompany = new Map<string, LeadIdentity[]>();
  for (const l of leads) {
    const id = l.hubspotCompanyId!;
    const list = byCompany.get(id) ?? [];
    list.push({ name: l.name, city: l.city, state: l.state });
    byCompany.set(id, list);
  }

  const shared = [...byCompany.entries()].filter(([, list]) => list.length > 1);
  console.log(`Companies referenced by >1 lead: ${shared.length}`);

  let checked = 0;
  let renamed = 0;
  let alreadyOk = 0;
  const failures: string[] = [];

  for (const [companyId, list] of shared) {
    checked += 1;
    const canonical = canonicalIdentity(list);

    let current: { name: string; city: string; state: string };
    try {
      const c = await hsRetry(() =>
        hs.crm.companies.basicApi.getById(companyId, ['name', 'city', 'state']),
      );
      current = {
        name: c.properties?.name ?? '',
        city: c.properties?.city ?? '',
        state: c.properties?.state ?? '',
      };
    } catch (e) {
      failures.push(`${companyId} getById: ${e instanceof Error ? e.message.slice(0, 120) : String(e)}`);
      continue;
    }

    if (current.name.trim() === canonical.name.trim()) {
      alreadyOk += 1;
      continue;
    }

    console.log(
      `${companyId}: "${current.name}" → "${canonical.name}" (${canonical.city}, ${canonical.state}) [${list.length} leads]`,
    );
    renamed += 1;

    if (!APPLY) continue;

    try {
      await hsRetry(() =>
        hs.crm.companies.basicApi.update(companyId, {
          properties: { name: canonical.name, city: canonical.city, state: canonical.state },
        }),
      );
      await prisma.auditLog.create({
        data: {
          action: 'hubspotSync.backfill.company-name-repair',
          entity: 'company',
          entityId: companyId,
          meta: {
            from: current,
            to: canonical,
            leadCount: list.length,
          },
        },
      });
    } catch (e) {
      failures.push(`${companyId} update: ${e instanceof Error ? e.message.slice(0, 120) : String(e)}`);
    }
  }

  console.log('\n=== summary ===');
  console.log(`checked:            ${checked}`);
  console.log(`already correct:    ${alreadyOk}`);
  console.log(`${APPLY ? 'renamed' : 'would rename'}:        ${renamed}`);
  console.log(`failures:           ${failures.length}`);
  for (const f of failures) console.log('  -', f);
  if (!APPLY && renamed > 0) console.log('\nRe-run with APPLY=1 to write these changes.');

  await prisma.$disconnect();
};

await run();
