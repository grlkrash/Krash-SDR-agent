// Generate the voicemail eligibility matrix as PDF + HTML in data/exports/.
//
//   npm run compliance:matrix
//   npm run compliance:matrix -- --output ./data/exports/my-matrix.pdf

import 'dotenv/config';
import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';
import { buildVoicemailMatrixHtml } from '../shared/voicemailMatrixHtml.js';

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const DEFAULT_EXPORT_DIR = join(REPO_ROOT, 'data/exports');

const todayStamp = (): string => new Date().toISOString().slice(0, 10);

const defaultPdfPath = (): string =>
  join(DEFAULT_EXPORT_DIR, `voicemail-eligibility-matrix-${todayStamp()}.pdf`);

const defaultHtmlPath = (pdfPath: string): string =>
  pdfPath.replace(/\.pdf$/i, '.html');

const printUsage = (): void => {
  console.error(`Usage:
  npm run compliance:matrix
  npm run compliance:matrix -- --output ./data/exports/custom-name.pdf`);
};

const parseOutputArg = (): string | null => {
  const idx = process.argv.indexOf('--output');
  if (idx < 0) return null;
  const val = process.argv[idx + 1];
  if (val === undefined || val.startsWith('--')) return null;
  return resolve(val);
};

const main = async (): Promise<void> => {
  if (process.argv.includes('--help') || process.argv.includes('-h')) {
    printUsage();
    return;
  }

  const pdfPath = parseOutputArg() ?? defaultPdfPath();
  const htmlPath = defaultHtmlPath(pdfPath);
  const generatedAt = new Date().toISOString();
  const html = buildVoicemailMatrixHtml(generatedAt);

  await mkdir(dirname(pdfPath), { recursive: true });
  await writeFile(htmlPath, html, 'utf8');

  const browser = await chromium.launch({ headless: true });
  try {
    const page = await browser.newPage();
    await page.setContent(html, { waitUntil: 'load' });
    await page.pdf({
      path: pdfPath,
      format: 'Letter',
      printBackground: true,
      margin: { top: '0.45in', right: '0.45in', bottom: '0.45in', left: '0.45in' },
    });
  } finally {
    await browser.close();
  }

  console.log(JSON.stringify({ pdf: pdfPath, html: htmlPath, generatedAt }));
};

await main();
