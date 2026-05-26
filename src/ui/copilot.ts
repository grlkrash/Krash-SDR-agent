// curl -X POST 'http://localhost:3000/copilot/ask?pw=$QUEUE_PASSWORD' -H 'Content-Type: application/json' -d '{"question":"How much is the Premium tier?"}'

import { readFileSync, readdirSync, statSync } from 'fs';
import { join, relative } from 'path';
import express from 'express';
import { PrismaPg } from '@prisma/adapter-pg';
import { PrismaClient } from '@prisma/client';
import type { TextBlockParam } from '@anthropic-ai/sdk/resources/messages';
import { z } from 'zod';
import { COPILOT_SYSTEM } from '../prompts/copilot.js';
import { queueAuth } from '../middleware/queueAuth.js';
import { claude, extractText } from '../shared/claude.js';
import { hs, hsRetry } from '../shared/hubspot.js';
import { embed } from '../shared/voyage.js';

const MODEL = 'claude-sonnet-4-5-20250929';
const MAX_TOKENS = 800;
const TEMPERATURE = 0.2;
const RAG_CHUNK_LIMIT = 8;
const KB_DIR = join(process.cwd(), 'kb');

const AskBodySchema = z.object({
  question: z.string().min(1),
  dealId: z.string().optional(),
  mode: z.enum(['rag', 'longctx']).optional(),
});

type KbChunkRow = {
  id: string;
  docPath: string;
  chunkIdx: number;
  content: string;
};

const prisma = new PrismaClient({
  adapter: new PrismaPg({ connectionString: process.env.DATABASE_URL ?? '' }),
});

export const copilotRouter = express.Router();
copilotRouter.use(express.json());

const walkMdFiles = (dir: string): string[] => {
  const results: string[] = [];
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) {
      results.push(...walkMdFiles(full));
    } else if (entry.endsWith('.md')) {
      results.push(full);
    }
  }
  return results;
};

const loadAllKbMarkdown = (): string => {
  const files = walkMdFiles(KB_DIR).sort();
  const parts: string[] = [];
  for (const full of files) {
    const docPath = relative(KB_DIR, full);
    const content = readFileSync(full, 'utf8');
    parts.push(`--- ${docPath} ---\n${content}`);
  }
  return parts.join('\n\n');
};

const fetchDealContext = async (dealId: string): Promise<string | null> => {
  try {
    const deal = await hsRetry(() =>
      hs.crm.deals.basicApi.getById(dealId, ['dealname', 'dealstage']),
    );
    const name = deal.properties.dealname ?? 'Unnamed deal';
    const stage = deal.properties.dealstage ?? 'unknown stage';
    return `${name} (stage: ${stage})`;
  } catch {
    return null;
  }
};

const buildRagSystem = (context: string): TextBlockParam[] => [
  { type: 'text', text: COPILOT_SYSTEM },
  { type: 'text', text: `Knowledge base excerpts:\n\n${context}` },
];

const buildLongctxSystem = (bigKB: string): TextBlockParam[] => [
  { type: 'text', text: COPILOT_SYSTEM },
  { type: 'text', text: bigKB, cache_control: { type: 'ephemeral' } },
];

copilotRouter.post('/copilot/ask', queueAuth, async (req, res) => {
  const parsed = AskBodySchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: 'invalid body' });
    return;
  }

  const { question, dealId } = parsed.data;
  const mode = parsed.data.mode ?? 'rag';

  const dealContext =
    dealId !== undefined && dealId.trim() !== ''
      ? await fetchDealContext(dealId.trim())
      : null;

  let chunks: KbChunkRow[] = [];
  let system: string | TextBlockParam[];

  if (mode === 'rag') {
    const vec = (await embed([question]))[0];
    chunks = await prisma.$queryRawUnsafe<KbChunkRow[]>(
      `SELECT id, "docPath", "chunkIdx", content FROM "KBChunk" ORDER BY embedding <=> $1::vector LIMIT ${RAG_CHUNK_LIMIT}`,
      JSON.stringify(vec),
    );
    const context = chunks
      .map((c) => `[${c.docPath}#${c.chunkIdx}] ${c.content}`)
      .join('\n\n');
    system = buildRagSystem(context);
  } else {
    const bigKB = loadAllKbMarkdown();
    system = buildLongctxSystem(bigKB);
  }

  const userContent = `Deal context: ${dealContext ?? 'none'}\n\nQuestion: ${question}`;

  const msg = await claude.messages.create({
    model: MODEL,
    max_tokens: MAX_TOKENS,
    temperature: TEMPERATURE,
    system,
    messages: [{ role: 'user', content: userContent }],
  });

  res.json({
    answer: extractText(msg),
    citations:
      mode === 'rag' ? chunks.map((c) => `${c.docPath}#${c.chunkIdx}`) : [],
  });
});
