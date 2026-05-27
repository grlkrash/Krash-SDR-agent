// Cold-outreach exclusion metadata stored on Lead.sourceMeta and/or
// Enrichment.signals. Paying clients and directory listings must not receive
// cold "join our directory" mail; opt-out / kill uses doNotContact instead.

import { z } from 'zod';

export const EXCLUSION_KINDS = ['directory-listed', 'existing-client'] as const;
export type ExclusionKind = (typeof EXCLUSION_KINDS)[number];

export const MATCH_CONFIDENCE = ['domain', 'address', 'name-city-state'] as const;
export type MatchConfidence = (typeof MATCH_CONFIDENCE)[number];

export const ExclusionRecord = z.object({
  excludeFromCold: z.boolean(),
  kind: z.enum(EXCLUSION_KINDS),
  tier: z.string().nullable(),
  source: z.string(),
  importedAt: z.string(),
  matchConfidence: z.enum(MATCH_CONFIDENCE),
  externalId: z.string().nullable(),
  sourceFile: z.string().nullable(),
});
export type ExclusionRecord = z.infer<typeof ExclusionRecord>;

const ExclusionEnvelope = z.object({ exclusion: ExclusionRecord });

export const getExclusion = (json: unknown): ExclusionRecord | null => {
  const parsed = ExclusionEnvelope.safeParse(json);
  return parsed.success ? parsed.data.exclusion : null;
};

export const isExcludedFromCold = (lead: {
  sourceMeta: unknown;
  enrichment: { signals: unknown } | null;
}): boolean => {
  if (getExclusion(lead.enrichment?.signals ?? null)?.excludeFromCold === true) return true;
  if (getExclusion(lead.sourceMeta)?.excludeFromCold === true) return true;
  return false;
};

export const mergeExclusionIntoJson = (
  existing: unknown,
  exclusion: ExclusionRecord,
): Record<string, unknown> => {
  const base =
    typeof existing === 'object' && existing !== null && !Array.isArray(existing)
      ? { ...(existing as Record<string, unknown>) }
      : {};
  return { ...base, exclusion };
};
