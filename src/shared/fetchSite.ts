import { PrismaPg } from '@prisma/adapter-pg';
import { Prisma, PrismaClient } from '@prisma/client';
import { chromium, type Page } from 'playwright';

const adapter = new PrismaPg({ connectionString: process.env.DATABASE_URL ?? '' });
const prisma = new PrismaClient({ adapter });

const NAV_TIMEOUT_MS = 15_000;
const ABOUT_NAV_TIMEOUT_MS = 10_000;
const MAX_HTML_CHARS = 200_000;
const USER_AGENT =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';
const BLOCKED_RESOURCES = new Set(['image', 'media', 'font', 'stylesheet']);
// Tokens scored against href + anchor text. Higher-priority tokens listed first.
const ABOUT_TOKENS = ['leadership', 'our-team', 'our-staff', 'clinical-staff', 'team', 'staff', 'about-us', 'about', 'people', 'meet'];

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

const findAboutLink = async (page: Page, homepageOrigin: string): Promise<string | null> => {
  return page.evaluate(
    ({ tokens, origin }) => {
      const links = Array.from(document.querySelectorAll<HTMLAnchorElement>('a[href]'));
      let best: { href: string; score: number } | null = null;
      for (const a of links) {
        const href = a.href;
        if (!href.startsWith('http')) continue;
        if (!href.startsWith(origin)) continue;
        const lowerHref = href.toLowerCase();
        const text = (a.textContent ?? '').toLowerCase();
        let score = 0;
        for (let i = 0; i < tokens.length; i += 1) {
          const t = tokens[i];
          const weight = tokens.length - i;
          if (lowerHref.includes(t)) score += weight * 2;
          if (text.includes(t)) score += weight;
        }
        if (score > 0 && (best === null || score > best.score)) best = { href, score };
      }
      return best?.href ?? null;
    },
    { tokens: ABOUT_TOKENS, origin: homepageOrigin },
  );
};

const safeFetchAbout = async (page: Page, aboutUrl: string): Promise<string | null> => {
  try {
    const r = await page.goto(aboutUrl, {
      timeout: ABOUT_NAV_TIMEOUT_MS,
      waitUntil: 'domcontentloaded',
    });
    if (!r || !r.ok()) return null;
    return await page.content();
  } catch {
    return null;
  }
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
    const response = await page.goto(url, { timeout: NAV_TIMEOUT_MS, waitUntil: 'domcontentloaded' });
    if (!response || !response.ok()) {
      await logError(url, `HTTP ${response?.status() ?? 'no-response'}`);
      return null;
    }
    const finalUrl = page.url();
    const homepageHtml = await page.content();
    const origin = new URL(finalUrl).origin;
    const aboutUrl = await findAboutLink(page, origin);
    const aboutHtml =
      aboutUrl !== null && aboutUrl !== finalUrl ? await safeFetchAbout(page, aboutUrl) : null;
    // About page goes first so the analyzer's truncation window catches leadership content.
    const combined =
      aboutHtml !== null
        ? `<!-- ABOUT: ${aboutUrl} -->\n${aboutHtml}\n<!-- HOMEPAGE: ${finalUrl} -->\n${homepageHtml}`
        : homepageHtml;
    return { html: combined.slice(0, MAX_HTML_CHARS), finalUrl };
  } catch (err) {
    await logError(url, err instanceof Error ? err.message : String(err));
    return null;
  } finally {
    await browser.close();
  }
};
