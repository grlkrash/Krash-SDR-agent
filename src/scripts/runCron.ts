// Run one cron job by name — for manual runs or a dedicated Railway cron service.
// Usage: CRON_JOB=checkCostCaps tsx src/scripts/runCron.ts

import 'dotenv/config';
import { CRON_JOBS } from '../shared/cronSchedule.js';

const jobName = process.env.CRON_JOB ?? process.argv[2] ?? '';
const job = CRON_JOBS.find((row) => row.name === jobName);

if (jobName === '' || job === undefined) {
  const names = CRON_JOBS.filter((row) => row.enabled).map((row) => row.name).join(', ');
  throw new Error(`CRON_JOB required. Enabled jobs: ${names}`);
}

if (!job.enabled) {
  throw new Error(`Cron job "${jobName}" is not enabled yet (script missing).`);
}

await import(job.modulePath);
