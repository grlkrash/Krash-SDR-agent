// Safe subset of HTML for outbound sales email + the /queue rich-text editor.
// Plain-text bodies stay plain until the operator adds formatting on approve.

const ALLOWED_TAGS = new Set(['b', 'strong', 'i', 'em', 'u', 'a', 'br', 'p', 'div']);
const RICH_TAG_RX = /<(b|strong|i|em|u|a)\b/i;
const TAG_RX = /<\/?([a-zA-Z][a-zA-Z0-9]*)\b([^>]*)>/g;

const escapeHtml = (text: string): string =>
  text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');

const escapeHtmlAttr = (value: string): string =>
  value.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;');

const decodeHtmlEntities = (text: string): string =>
  text
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'");

const sanitizeHref = (raw: string): string | null => {
  const href = raw.trim();
  if (/^https?:\/\//i.test(href)) return href;
  if (/^mailto:/i.test(href)) return href;
  return null;
};

const stripDangerousBlocks = (html: string): string =>
  html
    .replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, '')
    .replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi, '');

/** True when the stored body contains rich formatting (not just line breaks). */
export const isHtmlBody = (body: string): boolean => RICH_TAG_RX.test(body);

export const plainTextToHtmlFragment = (body: string): string =>
  escapeHtml(body).replace(/\r\n/g, '\n').replace(/\n/g, '<br>');

/** Strip tags to a plain-text representation for multipart/alternative text/plain. */
export const htmlToPlainText = (html: string): string => {
  let text = stripDangerousBlocks(html);
  text = text.replace(/\s+on\w+\s*=\s*("[^"]*"|'[^']*'|[^\s>]+)/gi, '');
  text = text.replace(/<br\s*\/?>/gi, '\n');
  text = text.replace(/<\/(div|p)>/gi, '\n');
  text = text.replace(/<(div|p)\b[^>]*>/gi, '');
  text = text.replace(/<[^>]+>/g, '');
  text = decodeHtmlEntities(text);
  return text.replace(/\n{3,}/g, '\n\n').replace(/\r\n/g, '\n').trimEnd();
};

/** Allowlist sanitizer — strips scripts, handlers, and unsafe link targets. */
export const sanitizeEmailHtml = (html: string): string => {
  let s = stripDangerousBlocks(html);
  s = s.replace(/\s+on\w+\s*=\s*("[^"]*"|'[^']*'|[^\s>]+)/gi, '');

  return s.replace(TAG_RX, (match, tagName: string, attrs: string) => {
    const tag = tagName.toLowerCase();
    const closing = match.startsWith('</');
    if (closing) {
      return ALLOWED_TAGS.has(tag) && tag !== 'br' ? `</${tag}>` : '';
    }
    if (tag === 'br') return '<br>';
    if (!ALLOWED_TAGS.has(tag)) return '';
    if (tag === 'a') {
      const hrefMatch = /\bhref\s*=\s*("([^"]*)"|'([^']*)'|([^\s>]+))/i.exec(attrs);
      const rawHref = hrefMatch?.[2] ?? hrefMatch?.[3] ?? hrefMatch?.[4] ?? '';
      const safeHref = sanitizeHref(rawHref);
      if (safeHref === null) return '';
      return `<a href="${escapeHtmlAttr(safeHref)}" style="color:#2563eb;text-decoration:underline;">`;
    }
    return `<${tag}>`;
  });
};

export const hasRichFormatting = (html: string): boolean =>
  RICH_TAG_RX.test(sanitizeEmailHtml(html));

/** HTML fragment suitable for the queue contenteditable initial state. */
export const prepareBodyForEditor = (body: string): string => {
  if (isHtmlBody(body)) return sanitizeEmailHtml(body);
  return plainTextToHtmlFragment(body);
};

/** Normalize editor output on approve — store plain text unless formatting was used. */
export const normalizeApprovedBody = (raw: string): string => {
  const sanitized = sanitizeEmailHtml(raw);
  if (hasRichFormatting(sanitized)) return sanitized;
  return htmlToPlainText(sanitized);
};

export const bodyToHtmlFragment = (body: string): string => {
  if (isHtmlBody(body)) return sanitizeEmailHtml(body);
  return plainTextToHtmlFragment(body);
};

export const bodyToPlainText = (body: string): string => {
  if (isHtmlBody(body)) return htmlToPlainText(body);
  return body;
};
