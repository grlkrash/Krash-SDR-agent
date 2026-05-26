import 'dotenv/config';

const VOYAGE_API_URL = 'https://api.voyageai.com/v1/embeddings';
const VOYAGE_MODEL = 'voyage-3';
const RETRY_STATUSES = new Set([429, 502, 503]);
const BASE_BACKOFF_MS = 20_000;
const MAX_BACKOFF_MS = 60_000;
const MAX_ATTEMPTS = 5;

interface VoyageEmbeddingResponse {
  data: Array<{ embedding: number[] }>;
}

const sleep = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));

export const embed = async (texts: string[]): Promise<number[][]> => {
  const apiKey = process.env.VOYAGE_API_KEY;
  if (!apiKey) throw new Error('VOYAGE_API_KEY is not set');

  let lastError: Error | null = null;

  for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
    const response = await fetch(VOYAGE_API_URL, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ model: VOYAGE_MODEL, input: texts }),
    });

    if (response.ok) {
      const json = (await response.json()) as VoyageEmbeddingResponse;
      return json.data.map((d) => d.embedding);
    }

    const body = await response.text();
    lastError = new Error(`Voyage AI error ${response.status}: ${body}`);

    if (!RETRY_STATUSES.has(response.status) || attempt === MAX_ATTEMPTS - 1) {
      throw lastError;
    }

    const delay = Math.min(MAX_BACKOFF_MS, BASE_BACKOFF_MS * 2 ** attempt);
    await sleep(delay);
  }

  throw lastError ?? new Error('Voyage AI embed failed');
};
