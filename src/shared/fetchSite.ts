import { PrismaPg } from '@prisma/adapter-pg';
import { Prisma, PrismaClient } from '@prisma/client';
import { chromium } from 'playwright';

const adapter = new PrismaPg({ connectionString: process.env.DATABASE_URL ?? '' });
const prisma = new PrismaClient({ adapter });

const NAV_TIMEOUT_MS = 15_000;
const MAX_HTML_CHARS = 200_000;
const USER_AGENT =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';
const BLOCKED_RESOURCES = new Set(['image', 'media', 'font', 'stylesheet']);

const logError = async (url: string, error: string): Promise<void> => {
  await prisma.auditLog.create({
    data: {
      action: 'fetchSite.error',
      entity: 'url',
      entityId: url,
      meta: { error } as Prisma.InputJsonValue,
    },
  });
};

export const fetchSite = async (
  url: string,
): Promise<{ html: string; finalUrl: string } | null> => {
  const browser = await chromium.launch({ headless: true });
  try {
    const context = await browser.newContext({ userAgent: USER_AGENT });
    const page = await context.newPage();
    await page.route('**/*', (route) => {
      if (BLOCKED_RESOURCES.has(route.request().resourceType())) return route.abort();
      return route.continue();
    });
    const response = await page.goto(url, {
      timeout: NAV_TIMEOUT_MS,
      waitUntil: 'domcontentloaded',
    });
    if (!response || !response.ok()) {
      await logError(url, `HTTP ${response?.status() ?? 'no-response'}`);
      return null;
    }
    const html = (await page.content()).slice(0, MAX_HTML_CHARS);
    return { html, finalUrl: page.url() };
  } catch (err) {
    await logError(url, err instanceof Error ? err.message : String(err));
    return null;
  } finally {
    await browser.close();
  }
};
