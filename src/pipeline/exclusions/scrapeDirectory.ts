import { chromium } from 'playwright';

const CENTERS_URL = 'https://sobrietyselect.com/centers';
const USER_AGENT = 'Sobriety Select Research/1.0 (sonia@sobrietyselect.com)';
const MIN_LABEL_LEN = 12;

export type ScrapedDirectoryCenter = {
  rawLabel: string;
  slug: string | null;
  href: string | null;
};

const uniqueCenters = (items: ScrapedDirectoryCenter[]): ScrapedDirectoryCenter[] => {
  const seen = new Set<string>();
  const out: ScrapedDirectoryCenter[] = [];
  for (const item of items) {
    const key = item.rawLabel.toLowerCase().trim();
    if (key === '' || seen.has(key)) continue;
    seen.add(key);
    out.push(item);
  }
  return out;
};

// Footer / filter chips sometimes surface as center-details links — require slug
// and a label that looks like a facility card.
export const isLikelyFacilityCard = (center: ScrapedDirectoryCenter): boolean => {
  if (center.slug === null || center.slug.trim() === '') return false;
  if (center.rawLabel.length < MIN_LABEL_LEN) return false;
  if (/insurance accepted/i.test(center.rawLabel)) return true;
  return center.rawLabel.includes(',');
};

export const scrapeDirectoryCenters = async (): Promise<ScrapedDirectoryCenter[]> => {
  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage({ userAgent: USER_AGENT });

  await page.goto(CENTERS_URL, { waitUntil: 'networkidle', timeout: 120_000 });
  await page.waitForTimeout(5000);

  const fromDom = await page.evaluate(() => {
    const anchors = Array.from(document.querySelectorAll('a[href*="/center-details/"]'));
    return anchors.map((a) => {
      const href = a.getAttribute('href');
      const rawLabel = (a.textContent ?? '').replace(/\s+/g, ' ').trim();
      const slug = href?.split('/center-details/')[1]?.split('?')[0] ?? null;
      return { rawLabel, slug, href };
    }).filter((r) => r.rawLabel.length > 2);
  });

  await browser.close();

  return uniqueCenters(fromDom).filter(isLikelyFacilityCard);
};
