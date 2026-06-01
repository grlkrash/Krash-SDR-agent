// One-off lead de-duplication + addressHash backfill.
//
// Why both at once: tightening addressHash (normalizeStreet + 5-digit zip in
// src/shared/lead.ts) changes the (nameNormalized, addressHash) unique key, so
// every existing row's stored hash is now stale. We MUST recompute it or the
// next scrape would create a fresh dupe instead of matching. Recomputing also
// collapses the address-formatting dupes that the old brittle hash let through.
//
// Pass A — recompute addressHash for every lead; where the new
//   (nameNormalized, addressHash) collides, merge the rows.
// Pass B — among survivors, merge rows sharing phoneE164 + domain +
//   nameNormalized (same facility scraped with a genuinely different address
//   string). High-confidence: identical name AND phone AND domain.
//
// Safety: a merge group spanning two DIFFERENT non-null hubspotCompanyId values
// is SKIPPED and flagged — we never silently drop a distinct HubSpot link.
// Merges reassign drafts, carry over enrichment/hubspotCompanyId when the
// canonical lacks them, then delete the dupe (Enrichment/Draft cascade).
//
// Uses NO Claude/LLM calls. Dry-run by default; set APPLY=1 to write.

import 'dotenv/config';
import { PrismaPg } from '@prisma/adapter-pg';
import { PrismaClient } from '@prisma/client';
import { addressHash } from '../shared/lead.js';
import { extractDomain } from '../shared/domain.js';

const APPLY = process.env.APPLY === '1';
const REJECTED = 'rejected';
const COLD = 'cold';

const prisma = new PrismaClient({
  adapter: new PrismaPg({ connectionString: process.env.DATABASE_URL ?? '' }),
});

type LeadRow = {
  id: string;
  name: string;
  nameNormalized: string;
  street: string | null;
  zip: string | null;
  addressHash: string;
  phoneE164: string | null;
  website: string | null;
  hubspotCompanyId: string | null;
  createdAt: Date;
  enrichmentId: string | null;
  draftCount: number;
};

const stats = { mergedRows: 0, mergedGroups: 0, skipped: 0 };
const skippedDetail: string[] = [];

// Most "complete" row wins: synced > enriched > most drafts > oldest > id.
const pickCanonical = (group: LeadRow[]): LeadRow =>
  [...group].sort((a, b) => {
    const sync = Number(b.hubspotCompanyId !== null) - Number(a.hubspotCompanyId !== null);
    if (sync !== 0) return sync;
    const enr = Number(b.enrichmentId !== null) - Number(a.enrichmentId !== null);
    if (enr !== 0) return enr;
    if (b.draftCount !== a.draftCount) return b.draftCount - a.draftCount;
    const age = a.createdAt.getTime() - b.createdAt.getTime();
    if (age !== 0) return age;
    return a.id.localeCompare(b.id);
  })[0]!;

// Merge `group` into one canonical row: reassign drafts, carry over
// enrichment/hubspotCompanyId when the canonical lacks them, delete the dupes.
// addressHash is intentionally NOT written here — the global two-phase rewrite
// (rewriteAllHashes) sets every survivor's hash afterward, which avoids
// transient unique-key collisions during the migration. Returns the canonical
// id, or null if the group was skipped for safety.
const mergeGroup = async (
  group: LeadRow[],
  reason: string,
): Promise<string | null> => {
  const companyIds = new Set(group.map((l) => l.hubspotCompanyId).filter((x): x is string => x !== null));
  if (companyIds.size > 1) {
    stats.skipped += 1;
    skippedDetail.push(`${reason}: ${group[0]!.nameNormalized} — spans companies ${[...companyIds].join(', ')}`);
    return null;
  }

  const canonical = pickCanonical(group);
  const dupes = group.filter((l) => l.id !== canonical.id);
  const carryCompanyId = canonical.hubspotCompanyId ?? group.find((l) => l.hubspotCompanyId !== null)?.hubspotCompanyId ?? null;
  const needEnrichmentFromDupe = canonical.enrichmentId === null
    ? dupes.find((l) => l.enrichmentId !== null)?.id ?? null
    : null;

  console.log(
    `${reason}: keep ${canonical.id} (${canonical.name}) <- merge ${dupes.length} [${dupes.map((d) => d.id).join(', ')}]`,
  );
  stats.mergedGroups += 1;
  stats.mergedRows += dupes.length;

  if (!APPLY) return canonical.id;

  await prisma.$transaction(async (tx) => {
    // unique_active_cold_draft allows only one non-rejected cold draft per lead.
    // Keep the canonical's (or the first dupe's) and reject any further active
    // cold drafts before reassigning, so the partial index isn't violated.
    let activeColdTaken =
      (await tx.draft.count({ where: { leadId: canonical.id, kind: COLD, status: { not: REJECTED } } })) > 0;
    for (const dupe of dupes) {
      const dupeActiveCold =
        (await tx.draft.count({ where: { leadId: dupe.id, kind: COLD, status: { not: REJECTED } } })) > 0;
      if (dupeActiveCold) {
        if (activeColdTaken) {
          await tx.draft.updateMany({
            where: { leadId: dupe.id, kind: COLD, status: { not: REJECTED } },
            data: { status: REJECTED, rejectReason: 'dedupe-merged-into-canonical' },
          });
        } else {
          activeColdTaken = true;
        }
      }
      await tx.draft.updateMany({ where: { leadId: dupe.id }, data: { leadId: canonical.id } });
      if (needEnrichmentFromDupe === dupe.id) {
        await tx.enrichment.update({ where: { leadId: dupe.id }, data: { leadId: canonical.id } });
      }
      await tx.lead.delete({ where: { id: dupe.id } });
    }
    if (canonical.hubspotCompanyId === null && carryCompanyId !== null) {
      await tx.lead.update({ where: { id: canonical.id }, data: { hubspotCompanyId: carryCompanyId } });
    }
    await tx.auditLog.create({
      data: {
        action: 'lead.dedupe.merge',
        entity: 'lead',
        entityId: canonical.id,
        meta: { reason, mergedLeadIds: dupes.map((d) => d.id), name: canonical.name },
      },
    });
  }, { timeout: 120_000, maxWait: 30_000 });
  return canonical.id;
};

const loadLeads = async (): Promise<LeadRow[]> => {
  const rows = await prisma.lead.findMany({
    select: {
      id: true, name: true, nameNormalized: true, street: true, zip: true,
      addressHash: true, phoneE164: true, website: true, hubspotCompanyId: true,
      createdAt: true,
      enrichment: { select: { id: true } },
      _count: { select: { drafts: true } },
    },
  });
  return rows.map((r) => ({
    id: r.id, name: r.name, nameNormalized: r.nameNormalized, street: r.street, zip: r.zip,
    addressHash: r.addressHash, phoneE164: r.phoneE164, website: r.website,
    hubspotCompanyId: r.hubspotCompanyId, createdAt: r.createdAt,
    enrichmentId: r.enrichment?.id ?? null, draftCount: r._count.drafts,
  }));
};

const run = async (): Promise<void> => {
  console.log(`Mode: ${APPLY ? 'APPLY (will merge + rewrite hashes)' : 'DRY-RUN (no writes)'}`);
  const leads = await loadLeads();
  console.log(`Total leads: ${leads.length}`);

  // ---- Pass A: merge rows that collide on (name, new addressHash) ----
  const byNewKey = new Map<string, LeadRow[]>();
  for (const l of leads) {
    const key = `${l.nameNormalized}::${addressHash(l.street, l.zip)}`;
    const rows = byNewKey.get(key) ?? [];
    rows.push(l);
    byNewKey.set(key, rows);
  }

  console.log('\n=== Pass A: addressHash collision merge ===');
  const survived = new Set(leads.map((l) => l.id));
  for (const rows of byNewKey.values()) {
    if (rows.length === 1) continue;
    const canonicalId = await mergeGroup(rows, 'addr-collision');
    if (canonicalId !== null) for (const r of rows) if (r.id !== canonicalId) survived.delete(r.id);
  }

  // ---- Pass B: phone + domain + name (survivors only) ----
  console.log('\n=== Pass B: phone + domain + name merge ===');
  const byPhoneKey = new Map<string, LeadRow[]>();
  for (const l of leads) {
    if (!survived.has(l.id)) continue;
    const domain = extractDomain(l.website);
    if (l.phoneE164 === null || domain === null) continue;
    const key = `${l.phoneE164}::${domain}::${l.nameNormalized}`;
    const arr = byPhoneKey.get(key) ?? [];
    arr.push(l);
    byPhoneKey.set(key, arr);
  }
  for (const rows of byPhoneKey.values()) {
    if (rows.length === 1) continue;
    const canonicalId = await mergeGroup(rows, 'phone-domain-name');
    if (canonicalId !== null) for (const r of rows) if (r.id !== canonicalId) survived.delete(r.id);
  }

  // ---- Two-phase addressHash rewrite over all survivors ----
  // Phase 1 parks every hash at its (globally unique) id so Phase 2 can write
  // the tightened hashes without tripping the (nameNormalized, addressHash)
  // unique key on a transient old==new collision. Post-merge, survivors are
  // unique on (name, newHash), so Phase 2 is collision-free.
  const dryHashChanges = leads.filter(
    (l) => survived.has(l.id) && l.addressHash !== addressHash(l.street, l.zip),
  ).length;

  if (APPLY) {
    console.log('\n=== rewriting addressHash (two-phase) ===');
    await prisma.$executeRawUnsafe('UPDATE "Lead" SET "addressHash" = "id"');
    const fresh = await prisma.lead.findMany({ select: { id: true, street: true, zip: true } });
    for (const l of fresh) {
      await prisma.lead.update({ where: { id: l.id }, data: { addressHash: addressHash(l.street, l.zip) } });
    }
    console.log(`rewrote hashes for ${fresh.length} survivors`);
  }

  console.log('\n=== summary ===');
  console.log(`hash rewrites (changed): ${dryHashChanges}`);
  console.log(`groups merged:           ${stats.mergedGroups}`);
  console.log(`${APPLY ? 'rows deleted' : 'rows would delete'}:        ${stats.mergedRows}`);
  console.log(`groups skipped (safety): ${stats.skipped}`);
  for (const s of skippedDetail.slice(0, 20)) console.log('  -', s);
  if (!APPLY) console.log('\nRe-run with APPLY=1 to write.');

  await prisma.$disconnect();
};

await run();
