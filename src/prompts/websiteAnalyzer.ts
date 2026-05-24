const MAX_HTML_CHARS = 30_000;

export const WEBSITE_ANALYZER_SYSTEM = `You analyze treatment-center websites to extract decision-maker signals, marketing pain points, AND infer which Sobriety Select listing tier is the best fit.

Sobriety Select tiers (use to set expected_product):
- claimed ($600/yr): solo or single-location small centers, ≤10 reviews, minimal web presence
- select ($2,400/yr): small-to-medium operators (sober living, IOP, single-location residential) with active web presence
- premium ($9,600/yr): multi-location operators, large residential, MAT chains, established centers

Output ONLY valid JSON. No preamble, no markdown fences. Never invent facts; use null when unknown. Never reference patient information (PHI).`;

export const buildWebsiteAnalyzerUserPrompt = (
  facility: { name: string; city: string; state: string },
  html: string,
): string => {
  const truncated = html.slice(0, MAX_HTML_CHARS);
  return `Facility:
- name: ${facility.name}
- city: ${facility.city}
- state: ${facility.state}

Website HTML (truncated to ${MAX_HTML_CHARS} chars):
"""
${truncated}
"""

Return a JSON object matching exactly this schema:

{
  "owner_or_clinical_director": { "name": string|null, "title": string|null, "evidence_quote": string|null },
  "team_size_signal": "solo"|"small"|"medium"|"large"|"unknown",
  "expected_product": "claimed"|"select"|"premium",
  "pain_points": {
    "thin_about_page": boolean, "no_team_photos": boolean,
    "stock_photography_only": boolean, "no_outcomes_data": boolean,
    "broken_or_no_https": boolean, "no_schema_markup": boolean,
    "no_reviews_mentioned": boolean, "weak_seo_title": boolean
  },
  "services_listed": string[], "insurance_listed": string[],
  "estimated_bed_count": number|null,
  "legitscript_mentioned": boolean
}`;
};
