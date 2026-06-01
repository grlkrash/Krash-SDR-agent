import 'dotenv/config';
import express from 'express';
import { PrismaPg } from '@prisma/adapter-pg';
import { PrismaClient } from '@prisma/client';
import { queueRouter } from './ui/queue.js';
import { manualVmQueueRouter } from './ui/manualVmQueue.js';
import { renewalsCallRouter } from './ui/renewalsCall.js';
import { coldCallRouter } from './ui/coldCall.js';
import { prepBriefRouter } from './ui/prepBrief.js';
import { copilotRouter } from './ui/copilot.js';
import { unsubscribeRouter } from './routes/unsubscribe.js';
import { openTrackRouter } from './routes/openTrack.js';
import { phoneConsentRouter } from './routes/phoneConsent.js';
import { twilioRouter } from './routes/twilioHooks.js';
import { hs, hsRetry } from './shared/hubspot.js';
import { claude } from './shared/claude.js';

const VERSION = '1.2.0';
const DEFAULT_PORT = 3000;
const MS_PER_MINUTE = 60_000;
const CRON_LOOKBACK = 50;
const HUBSPOT_PROBE_LIMIT = 1;
const CLAUDE_PROBE_MAX_TOKENS = 5;
const QUEUE_DEPTH_FAILED = -1;

const prisma = new PrismaClient({
  adapter: new PrismaPg({ connectionString: process.env.DATABASE_URL ?? '' }),
});

const app = express();

const checkPostgres = async (): Promise<void> => {
  await prisma.$queryRaw`SELECT 1`;
};

const checkHubspot = async (): Promise<void> => {
  // SDK path is hs.crm.contacts.basicApi.getPage, not hs.crm.objects.contacts —
  // the latter type-errors against @hubspot/api-client (ObjectsDiscovery has no
  // .contacts). Matches existing usage in src/outreach/prepBrief.ts etc.
  await hsRetry(() => hs.crm.contacts.basicApi.getPage(HUBSPOT_PROBE_LIMIT));
};

const checkClaude = async (): Promise<void> => {
  await claude.messages.create({
    model: 'claude-haiku-4-5-20251001',
    max_tokens: CLAUDE_PROBE_MAX_TOKENS,
    messages: [{ role: 'user', content: 'hi' }],
  });
};

const getQueueDepth = async (): Promise<number> =>
  prisma.draft.count({ where: { status: 'pending' } });

const getCronStatus = async (): Promise<
  Record<string, { lastRunMinutesAgo: number; ok: true }>
> => {
  // AuditLog stores the job name on the top-level `entity` column (see
  // src/scripts/*.ts), not under meta.entity. We dedupe in JS: rows are
  // pulled in createdAt-desc order, so the first sighting per entity wins.
  const cronRows = await prisma.auditLog.findMany({
    where: { action: 'cron.success' },
    orderBy: { createdAt: 'desc' },
    take: CRON_LOOKBACK,
  });

  const now = Date.now();
  const crons: Record<string, { lastRunMinutesAgo: number; ok: true }> = {};
  for (const row of cronRows) {
    if (crons[row.entity] !== undefined) continue;
    crons[row.entity] = {
      lastRunMinutesAgo: Math.floor((now - row.createdAt.getTime()) / MS_PER_MINUTE),
      ok: true,
    };
  }
  return crons;
};

const isFulfilled = (
  r: PromiseSettledResult<unknown>,
): r is PromiseFulfilledResult<unknown> => r.status === 'fulfilled';

// Railway deploy gate only — no DB or external APIs (see railway.toml healthcheckPath).
app.get('/health/live', (_req, res) => {
  res.status(200).json({ ok: true, uptime: process.uptime(), version: VERSION });
});

app.get('/health', async (_req, res) => {
  const [pgRes, hsRes, claudeRes, queueRes, cronRes] = await Promise.allSettled([
    checkPostgres(),
    checkHubspot(),
    checkClaude(),
    getQueueDepth(),
    getCronStatus(),
  ]);

  const crons = cronRes.status === 'fulfilled' ? cronRes.value : {};

  const postgresOk = isFulfilled(pgRes);
  const hubspotOk = isFulfilled(hsRes);
  const claudeOk = isFulfilled(claudeRes);
  const queueOk = queueRes.status === 'fulfilled';
  const queueDepth = queueRes.status === 'fulfilled' ? queueRes.value : QUEUE_DEPTH_FAILED;

  const ok = postgresOk && hubspotOk && claudeOk && queueOk;

  res.json({
    ok,
    uptime: process.uptime(),
    version: VERSION,
    checks: {
      postgres: { ok: postgresOk },
      hubspot: { ok: hubspotOk },
      claude: { ok: claudeOk },
      queueDepth,
    },
    crons,
  });
});

app.use('/', queueRouter);
app.use('/', openTrackRouter);
app.use('/', manualVmQueueRouter);
app.use('/', renewalsCallRouter);
app.use('/', coldCallRouter);
app.use('/', prepBriefRouter);
app.use('/', copilotRouter);
app.use('/', unsubscribeRouter);
app.use('/', phoneConsentRouter);
app.use('/', twilioRouter);

const port = Number(process.env.PORT) || DEFAULT_PORT;
const host = '0.0.0.0';

app.listen(port, host, () => {
  console.error(`[ssa-web] listening on http://${host}:${port}`);
});
