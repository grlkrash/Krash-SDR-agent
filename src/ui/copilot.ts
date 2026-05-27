// curl -X POST 'http://localhost:3000/copilot/ask?pw=$QUEUE_PASSWORD' -H 'Content-Type: application/json' -d '{"question":"How much is the Premium tier?"}'
// Browser: GET /copilot?pw=$QUEUE_PASSWORD — same auth cookie as /queue.

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

const FormBodySchema = z.object({
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

type CopilotAskInput = z.infer<typeof AskBodySchema>;

type CopilotAskResult = {
  answer: string;
  citations: string[];
};

type CopilotPageState = {
  question: string;
  dealId: string;
  mode: 'rag' | 'longctx';
  answer?: string;
  citations?: string[];
  error?: string;
};

const prisma = new PrismaClient({
  adapter: new PrismaPg({ connectionString: process.env.DATABASE_URL ?? '' }),
});

export const copilotRouter = express.Router();
copilotRouter.use(express.json());
copilotRouter.use(express.urlencoded({ extended: false }));

const escapeHtml = (s: string): string =>
  s.replace(/[&<>"']/g, (c) => {
    if (c === '&') return '&amp;';
    if (c === '<') return '&lt;';
    if (c === '>') return '&gt;';
    if (c === '"') return '&quot;';
    return '&#39;';
  });

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

const answerCopilotQuestion = async (input: CopilotAskInput): Promise<CopilotAskResult> => {
  const { question } = input;
  const mode = input.mode ?? 'rag';
  const dealId = input.dealId?.trim();

  const dealContext =
    dealId !== undefined && dealId !== ''
      ? await fetchDealContext(dealId)
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

  return {
    answer: extractText(msg),
    citations:
      mode === 'rag' ? chunks.map((c) => `${c.docPath}#${c.chunkIdx}`) : [],
  };
};

const PAGE_STYLE = `
  body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif; max-width: 720px; margin: 0 auto; padding: 24px 16px 48px; color: #111; background: #f9fafb; }
  h1 { font-size: 22px; margin: 0 0 4px; }
  .sub { color: #6b7280; font-size: 14px; margin: 0 0 20px; }
  .nav { margin-bottom: 20px; font-size: 14px; }
  .nav a { color: #2563eb; text-decoration: none; }
  .nav a:hover { text-decoration: underline; }
  .card { background: white; border: 1px solid #e5e7eb; border-radius: 10px; padding: 16px; margin-bottom: 16px; box-shadow: 0 1px 2px rgba(0,0,0,0.04); }
  label { display: block; font-size: 13px; font-weight: 600; color: #374151; margin-bottom: 6px; }
  input[type=text], textarea, select { width: 100%; box-sizing: border-box; font-family: inherit; font-size: 14px; padding: 8px 10px; border: 1px solid #d4d4d8; border-radius: 6px; margin-bottom: 12px; }
  textarea { min-height: 88px; resize: vertical; line-height: 1.45; }
  .field-row { display: grid; grid-template-columns: 1fr 140px; gap: 12px; }
  @media (max-width: 560px) { .field-row { grid-template-columns: 1fr; } }
  .btn { background: #2563eb; color: white; border: none; padding: 10px 18px; border-radius: 6px; font-size: 14px; font-weight: 600; cursor: pointer; }
  .btn:hover { background: #1d4ed8; }
  .btn:disabled { opacity: 0.6; cursor: wait; }
  .answer { white-space: pre-wrap; line-height: 1.5; font-size: 15px; color: #0f172a; }
  .citations { margin-top: 12px; font-size: 13px; color: #64748b; }
  .citations ul { margin: 6px 0 0; padding-left: 18px; }
  .error { color: #b91c1c; font-size: 14px; margin-bottom: 12px; }
  .hint { font-size: 12px; color: #9ca3af; margin-top: -8px; margin-bottom: 12px; }
`;

const renderCopilotPage = (state: CopilotPageState): string => {
  const ragSel = state.mode === 'rag' ? ' selected' : '';
  const longSel = state.mode === 'longctx' ? ' selected' : '';
  const answerBlock =
    state.error !== undefined
      ? `<div class="error">${escapeHtml(state.error)}</div>`
      : state.answer !== undefined
        ? `<div class="card">
      <h2 style="font-size:16px;margin:0 0 12px;">Answer</h2>
      <div class="answer">${escapeHtml(state.answer)}</div>
      ${
        state.citations !== undefined && state.citations.length > 0
          ? `<div class="citations"><strong>Sources</strong><ul>${state.citations.map((c) => `<li><code>${escapeHtml(c)}</code></li>`).join('')}</ul></div>`
          : ''
      }
    </div>`
        : '';

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width,initial-scale=1" />
<title>Sales Co-pilot</title>
<style>${PAGE_STYLE}</style>
</head>
<body>
  <div class="nav"><a href="/queue">← Approval queue</a></div>
  <h1>Sales Co-pilot</h1>
  <p class="sub">KB-backed answers for live calls — cite chunks like <code>[doc#0]</code>.</p>
  ${answerBlock}
  <div class="card">
    <form method="post" action="/copilot" id="copilot-form">
      <label for="question">Question</label>
      <textarea id="question" name="question" required placeholder="e.g. How much is the Premium tier?">${escapeHtml(state.question)}</textarea>
      <div class="field-row">
        <div>
          <label for="dealId">HubSpot deal ID <span style="font-weight:400;color:#9ca3af">(optional)</span></label>
          <input type="text" id="dealId" name="dealId" value="${escapeHtml(state.dealId)}" placeholder="123456789" />
        </div>
        <div>
          <label for="mode">Mode</label>
          <select id="mode" name="mode">
            <option value="rag"${ragSel}>RAG (fast)</option>
            <option value="longctx"${longSel}>Full KB</option>
          </select>
        </div>
      </div>
      <p class="hint">First visit: add <code>?pw=…</code> to the URL (same password as /queue). Cookie lasts 30 days.</p>
      <button type="submit" class="btn" id="submit-btn">Ask</button>
    </form>
  </div>
  <script>
  document.getElementById('copilot-form').addEventListener('submit', function () {
    var btn = document.getElementById('submit-btn');
    if (btn) { btn.disabled = true; btn.textContent = 'Thinking…'; }
  });
  </script>
</body>
</html>`;
};

const emptyPageState = (): CopilotPageState => ({
  question: '',
  dealId: '',
  mode: 'rag',
});

copilotRouter.get('/copilot', queueAuth, (_req, res) => {
  res.type('html').send(renderCopilotPage(emptyPageState()));
});

copilotRouter.post('/copilot', queueAuth, async (req, res) => {
  const parsed = FormBodySchema.safeParse(req.body);
  if (!parsed.success) {
    res
      .type('html')
      .send(
        renderCopilotPage({
          ...emptyPageState(),
          question: typeof req.body?.question === 'string' ? req.body.question : '',
          dealId: typeof req.body?.dealId === 'string' ? req.body.dealId : '',
          mode: req.body?.mode === 'longctx' ? 'longctx' : 'rag',
          error: 'Enter a question.',
        }),
      );
    return;
  }

  const { question, dealId, mode } = parsed.data;
  const pageBase: CopilotPageState = {
    question,
    dealId: dealId ?? '',
    mode: mode ?? 'rag',
  };

  try {
    const result = await answerCopilotQuestion({
      question,
      dealId: dealId !== undefined && dealId.trim() !== '' ? dealId.trim() : undefined,
      mode: mode ?? 'rag',
    });
    res.type('html').send(
      renderCopilotPage({
        ...pageBase,
        answer: result.answer,
        citations: result.citations,
      }),
    );
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    res.type('html').send(
      renderCopilotPage({
        ...pageBase,
        error: message,
      }),
    );
  }
});

copilotRouter.post('/copilot/ask', queueAuth, async (req, res) => {
  const parsed = AskBodySchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: 'invalid body' });
    return;
  }

  try {
    const result = await answerCopilotQuestion(parsed.data);
    res.json(result);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    res.status(500).json({ error: message });
  }
});
