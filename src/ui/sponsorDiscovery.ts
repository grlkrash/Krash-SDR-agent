import express from 'express';
import { z } from 'zod';
import { queueAuth } from '../middleware/queueAuth.js';
import { prisma } from '../shared/prismaClient.js';

const RECENT_LIMIT = 20;
const OPEN_STATUSES = ['pending', 'running'] as const;

const JobParamsSchema = z.object({
  projectSlug: z.string().trim().min(1),
});

const escapeHtml = (s: string): string =>
  s.replace(/[&<>"']/g, (c) => {
    if (c === '&') return '&amp;';
    if (c === '<') return '&lt;';
    if (c === '>') return '&gt;';
    if (c === '"') return '&quot;';
    return '&#39;';
  });

const defaultProjectSlug = (): string =>
  (process.env.DEFAULT_PROJECT_SLUG ?? process.env.SCHEDULE_PROJECTS?.split(',')[0] ?? '').trim();

const projectSlugFromParams = (params: unknown): string | null => {
  const parsed = JobParamsSchema.safeParse(params);
  return parsed.success ? parsed.data.projectSlug : null;
};

const hasOpenJobForProject = async (projectSlug: string): Promise<boolean> => {
  const jobs = await prisma.job.findMany({
    where: { type: 'sponsorDiscovery', status: { in: [...OPEN_STATUSES] } },
    orderBy: { createdAt: 'desc' },
    take: RECENT_LIMIT,
  });
  return jobs.some((job) => projectSlugFromParams(job.params) === projectSlug);
};

const renderPage = async (flash = '', projectSlug = defaultProjectSlug()): Promise<string> => {
  const [jobs, audits] = await Promise.all([
    prisma.job.findMany({
      where: { type: 'sponsorDiscovery' },
      orderBy: { createdAt: 'desc' },
      take: RECENT_LIMIT,
    }),
    prisma.auditLog.findMany({
      where: {
        OR: [
          { action: { startsWith: 'sponsorDiscovery' } },
          { action: { startsWith: 'job.sponsorDiscovery' } },
          { action: { startsWith: 'scheduler.' } },
        ],
      },
      orderBy: { createdAt: 'desc' },
      take: RECENT_LIMIT,
    }),
  ]);

  const jobRows = jobs.length === 0
    ? '<tr><td colspan="6">No sponsor discovery jobs yet.</td></tr>'
    : jobs.map((job) => {
      const params = projectSlugFromParams(job.params) ?? JSON.stringify(job.params);
      const result = job.result === null ? '' : JSON.stringify(job.result).slice(0, 240);
      return `<tr>
        <td>${escapeHtml(job.createdAt.toISOString())}</td>
        <td>${escapeHtml(job.status)}</td>
        <td>${escapeHtml(params)}</td>
        <td>${String(job.attempts)}</td>
        <td>${escapeHtml(job.scheduledAt?.toISOString() ?? '')}</td>
        <td><code>${escapeHtml(result)}</code></td>
      </tr>`;
    }).join('\n');

  const auditRows = audits.length === 0
    ? '<tr><td colspan="4">No sponsor discovery audit rows yet.</td></tr>'
    : audits.map((row) => `<tr>
        <td>${escapeHtml(row.createdAt.toISOString())}</td>
        <td>${escapeHtml(row.action)}</td>
        <td>${escapeHtml(row.entityId ?? '')}</td>
        <td><code>${escapeHtml(JSON.stringify(row.meta).slice(0, 300))}</code></td>
      </tr>`).join('\n');

  const flashHtml = flash === '' ? '' : `<div class="flash">${escapeHtml(flash)}</div>`;

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width,initial-scale=1" />
<title>Sponsor Discovery</title>
<style>
body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif; margin: 0; padding: 24px; background: #f8fafc; color: #0f172a; }
.wrap { max-width: 1100px; margin: 0 auto; }
a { color: #2563eb; text-decoration: none; }
.card { background: #fff; border-radius: 8px; padding: 18px 20px; margin: 16px 0; box-shadow: 0 1px 3px rgba(0,0,0,0.06); }
.flash { background: #ecfdf5; border: 1px solid #86efac; color: #166534; border-radius: 6px; padding: 10px 12px; margin: 12px 0; }
input { padding: 9px 11px; border: 1px solid #d1d5db; border-radius: 6px; min-width: 280px; }
button { background: #2563eb; color: #fff; border: 0; padding: 10px 14px; border-radius: 6px; font-weight: 600; cursor: pointer; }
table { width: 100%; border-collapse: collapse; font-size: 13px; }
th, td { border-bottom: 1px solid #e5e7eb; padding: 8px; text-align: left; vertical-align: top; }
code { white-space: pre-wrap; word-break: break-word; }
.note { color: #64748b; font-size: 14px; line-height: 1.5; }
</style>
</head>
<body>
<div class="wrap">
  <p><a href="/queue">← Approval queue</a></p>
  <h1>Sponsor Discovery</h1>
  <p class="note">Enqueues durable <code>sponsorDiscovery</code> jobs for the worker. In this repo, discovered contact details are stored on <code>Enrichment.owner*</code>, not a separate local Contact table.</p>
  ${flashHtml}
  <div class="card">
    <form method="post" action="/sponsor-discovery">
      <label for="projectSlug">Project slug</label><br />
      <input id="projectSlug" name="projectSlug" value="${escapeHtml(projectSlug)}" placeholder="default project slug" />
      <button type="submit">Start sponsor discovery</button>
    </form>
  </div>
  <div class="card">
    <h2>Recent jobs</h2>
    <table><thead><tr><th>Created</th><th>Status</th><th>Project</th><th>Attempts</th><th>Scheduled</th><th>Result</th></tr></thead><tbody>${jobRows}</tbody></table>
  </div>
  <div class="card">
    <h2>Recent audit log</h2>
    <table><thead><tr><th>Created</th><th>Action</th><th>Entity ID</th><th>Meta</th></tr></thead><tbody>${auditRows}</tbody></table>
  </div>
</div>
</body>
</html>`;
};

export const sponsorDiscoveryRouter = express.Router();
sponsorDiscoveryRouter.use(express.urlencoded({ extended: false }));

sponsorDiscoveryRouter.get('/sponsor-discovery', queueAuth, async (req, res) => {
  const flash = typeof req.query.flash === 'string' ? req.query.flash : '';
  const projectSlug = typeof req.query.project === 'string' ? req.query.project : defaultProjectSlug();
  res.type('html').send(await renderPage(flash, projectSlug));
});

sponsorDiscoveryRouter.post('/sponsor-discovery', queueAuth, async (req, res) => {
  const body = typeof req.body === 'object' && req.body !== null ? req.body : {};
  const rawProjectSlug = 'projectSlug' in body ? body.projectSlug : '';
  const projectSlug = typeof rawProjectSlug === 'string' ? rawProjectSlug.trim() : '';
  if (projectSlug === '') {
    res.redirect(303, '/sponsor-discovery?flash=Project%20slug%20is%20required.');
    return;
  }

  if (await hasOpenJobForProject(projectSlug)) {
    res.redirect(303, `/sponsor-discovery?project=${encodeURIComponent(projectSlug)}&flash=${encodeURIComponent('Sponsor discovery already has a pending or running job for this project.')}`);
    return;
  }

  const job = await prisma.job.create({
    data: {
      type: 'sponsorDiscovery',
      params: { projectSlug },
      status: 'pending',
      scheduledAt: new Date(),
    },
  });
  await prisma.auditLog.create({
    data: {
      action: 'sponsorDiscovery.request',
      entity: 'project',
      entityId: projectSlug,
      meta: { jobId: job.id },
    },
  });

  res.redirect(303, `/sponsor-discovery?project=${encodeURIComponent(projectSlug)}&flash=${encodeURIComponent('Sponsor discovery enqueued. Worker will process it shortly.')}`);
});
