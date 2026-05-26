export type CostProvider =
  | 'infra'
  | 'claude'
  | 'voyage'
  | 'places'
  | 'serper'
  | 'twilio'
  | 'elevenlabs'
  | 'mailwarm';

export type CostCapRow = {
  provider: CostProvider;
  label: string;
  monthlyCapUsd: number;
  /** false = fixed subscription or external dashboard only */
  autoTrack: boolean;
};

/** PRD §16 — first 60 days */
export const COST_CAPS: CostCapRow[] = [
  { provider: 'infra', label: 'Railway web + Postgres + cron', monthlyCapUsd: 12, autoTrack: false },
  { provider: 'claude', label: 'Claude API', monthlyCapUsd: 80, autoTrack: true },
  { provider: 'voyage', label: 'Voyage AI (embeddings)', monthlyCapUsd: 5, autoTrack: true },
  { provider: 'places', label: 'Google Places', monthlyCapUsd: 50, autoTrack: true },
  { provider: 'serper', label: 'Serper (incl. signals)', monthlyCapUsd: 50, autoTrack: true },
  { provider: 'twilio', label: 'Twilio (voice + lookups)', monthlyCapUsd: 30, autoTrack: false },
  { provider: 'elevenlabs', label: 'ElevenLabs', monthlyCapUsd: 22, autoTrack: false },
  { provider: 'mailwarm', label: 'Mailwarm or equivalent', monthlyCapUsd: 50, autoTrack: false },
];

export const TOTAL_CAP_USD = 299;
export const WARN_FRACTION = 0.8;

/** Serper Developer tier — ~$0.001/search at volume */
export const SERPER_USD_PER_CALL = 0.001;

/** Places Text Search (New) — ~$32 / 1k requests */
export const PLACES_USD_PER_SEARCH = 0.032;

/** Claude Sonnet 4.5 list pricing (May 2026) */
export const CLAUDE_INPUT_USD_PER_TOKEN = 3 / 1_000_000;
export const CLAUDE_OUTPUT_USD_PER_TOKEN = 15 / 1_000_000;

/** Voyage-3 — ~$0.06 / 1M tokens; ~500 tokens per chunk is a safe embed average */
export const VOYAGE_USD_PER_EMBED = 0.00003;

export const capForProvider = (provider: CostProvider): CostCapRow | undefined =>
  COST_CAPS.find((row) => row.provider === provider);

export const monthKey = (d: Date): string =>
  `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}`;

export const startOfUtcMonth = (d: Date): Date =>
  new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), 1));
