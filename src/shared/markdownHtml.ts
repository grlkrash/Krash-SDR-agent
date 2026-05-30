// Markdown → HTML for prep briefs and daily pipeline brief (browser + Gmail).
// Covers headings, bullets (- * •), ordered lists, **bold**, *italic*, `code`,
// blockquotes, [links](url), paragraphs.

type MarkdownVariant = 'document' | 'email';

const escapeHtml = (s: string): string =>
  s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

const escapeHtmlAttr = (s: string): string =>
  s.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;');

const LINK_RX = /\[([^\]]+)\]\(([^)]+)\)/g;
const LINK_STYLE = 'color:#2563eb;text-decoration:underline;';

const sanitizeLinkHref = (raw: string): string | null => {
  const href = raw.trim();
  if (/^https?:\/\//i.test(href)) return href;
  return null;
};

const renderInline = (s: string): string => {
  const parts: string[] = [];
  let lastIndex = 0;
  for (const match of s.matchAll(LINK_RX)) {
    const index = match.index ?? 0;
    parts.push(formatTextSegment(s.slice(lastIndex, index)));
    const label = match[1] ?? '';
    const url = match[2] ?? '';
    const safeHref = sanitizeLinkHref(url);
    parts.push(
      safeHref === null
        ? escapeHtml(match[0])
        : `<a href="${escapeHtmlAttr(safeHref)}" style="${LINK_STYLE}">${escapeHtml(label)}</a>`,
    );
    lastIndex = index + match[0].length;
  }
  parts.push(formatTextSegment(s.slice(lastIndex)));
  return parts.join('');
};

const formatTextSegment = (s: string): string => {
  const esc = escapeHtml(s);
  return esc
    .replace(/`([^`]+)`/g, '<code>$1</code>')
    .replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
    .replace(/(^|[^\w*])\*([^*\n]+)\*(?!\w)/g, '$1<em>$2</em>')
    .replace(/(^|[^\w_])_([^_\n]+)_(?!\w)/g, '$1<em>$2</em>');
};

const HEADING_RX = /^(#{1,6})\s+(.*)$/;
const UL_RX = /^[-*•]\s+(.*)$/;
const OL_RX = /^\d+\.\s+(.*)$/;
const BLOCKQUOTE_RX = /^\s*>\s?(.*)$/;

type ListState = 'ul' | 'ol' | null;

const EMAIL_STYLES = {
  h1: 'font-size:20px;font-weight:700;margin:0 0 10px;line-height:1.3;color:#111111;',
  h2: 'font-size:17px;font-weight:600;margin:20px 0 8px;padding-bottom:4px;border-bottom:1px solid #e5e5e5;line-height:1.3;color:#111111;',
  h3: 'font-size:15px;font-weight:600;margin:16px 0 6px;line-height:1.3;color:#111111;',
  p: 'margin:8px 0;line-height:1.5;color:#222222;',
  ul: 'margin:8px 0 12px;padding-left:22px;',
  ol: 'margin:8px 0 12px;padding-left:22px;',
  li: 'margin:5px 0;line-height:1.45;color:#222222;',
  blockquote:
    'border-left:3px solid #d1d5db;margin:10px 0;padding:4px 12px;color:#4b5563;font-size:14px;line-height:1.45;',
  code: 'background:#f4f4f5;padding:1px 4px;border-radius:3px;font-size:13px;',
  strong: 'font-weight:600;',
} as const;

const styledTag = (tag: string, style: string, inner: string): string =>
  `<${tag} style="${style}">${inner}</${tag}>`;

const headingTag = (level: number, inner: string, variant: MarkdownVariant): string => {
  const tag = `h${level}`;
  if (variant === 'document') return `<${tag}>${inner}</${tag}>`;
  const style = level === 1 ? EMAIL_STYLES.h1 : level === 2 ? EMAIL_STYLES.h2 : EMAIL_STYLES.h3;
  return styledTag(tag, style, inner);
};

const listOpen = (kind: 'ul' | 'ol', variant: MarkdownVariant): string => {
  if (variant === 'document') return `<${kind}>`;
  const style = kind === 'ul' ? EMAIL_STYLES.ul : EMAIL_STYLES.ol;
  return `<${kind} style="${style}">`;
};

const listClose = (kind: 'ul' | 'ol'): string => `</${kind}>`;

const listItem = (inner: string, variant: MarkdownVariant): string => {
  if (variant === 'document') return `<li>${inner}</li>`;
  return styledTag('li', EMAIL_STYLES.li, inner);
};

const paragraph = (inner: string, variant: MarkdownVariant): string => {
  if (variant === 'document') return `<p>${inner}</p>`;
  return styledTag('p', EMAIL_STYLES.p, inner);
};

const blockquote = (inner: string, variant: MarkdownVariant): string => {
  if (variant === 'document') return `<blockquote>${inner}</blockquote>`;
  return styledTag('blockquote', EMAIL_STYLES.blockquote, inner);
};

const applyEmailCodeStyles = (html: string): string =>
  html.replace(/<code>/g, `<code style="${EMAIL_STYLES.code}">`);

/** Semantic HTML for /prep-brief browser view (styled via page CSS). */
export const markdownToDocumentHtml = (md: string): string =>
  renderMarkdownHtml(md, 'document');

/** HTML fragment with inline styles for Gmail clients. */
export const markdownToEmailHtmlFragment = (md: string): string => {
  const html = renderMarkdownHtml(md, 'email');
  return applyEmailCodeStyles(html);
};

const renderMarkdownHtml = (md: string, variant: MarkdownVariant): string => {
  const lines = md.replace(/\r\n/g, '\n').split('\n');
  const out: string[] = [];
  let list: ListState = null;

  const closeList = (): void => {
    if (list === 'ul') out.push(listClose('ul'));
    else if (list === 'ol') out.push(listClose('ol'));
    list = null;
  };

  for (const raw of lines) {
    const line = raw.replace(/\s+$/, '').trimStart();
    if (line === '') {
      closeList();
      continue;
    }
    const heading = line.match(HEADING_RX);
    if (heading !== null) {
      closeList();
      const level = Math.min(heading[1].length, 3);
      out.push(headingTag(level, renderInline(heading[2]), variant));
      continue;
    }
    const ulMatch = line.match(UL_RX);
    if (ulMatch !== null) {
      if (list !== 'ul') {
        closeList();
        out.push(listOpen('ul', variant));
        list = 'ul';
      }
      out.push(listItem(renderInline(ulMatch[1]), variant));
      continue;
    }
    const olMatch = line.match(OL_RX);
    if (olMatch !== null) {
      if (list !== 'ol') {
        closeList();
        out.push(listOpen('ol', variant));
        list = 'ol';
      }
      out.push(listItem(renderInline(olMatch[1]), variant));
      continue;
    }
    const bqMatch = line.match(BLOCKQUOTE_RX);
    if (bqMatch !== null) {
      closeList();
      out.push(blockquote(renderInline(bqMatch[1]), variant));
      continue;
    }
    closeList();
    out.push(paragraph(renderInline(line), variant));
  }
  closeList();
  return out.join('\n');
};

/** Plain-text part for multipart prep-brief emails (no raw ## or **). */
export const markdownToPlainText = (md: string): string => {
  const lines = md.replace(/\r\n/g, '\n').split('\n');
  const out: string[] = [];

  for (const raw of lines) {
    const line = raw.replace(/\s+$/, '').trimStart();
    if (line === '') {
      out.push('');
      continue;
    }
    const heading = line.match(HEADING_RX);
    if (heading !== null) {
      out.push(heading[2].trim());
      continue;
    }
    const ulMatch = line.match(UL_RX);
    if (ulMatch !== null) {
      out.push(`• ${stripInlineMarkdown(ulMatch[1])}`);
      continue;
    }
    const olMatch = line.match(OL_RX);
    if (olMatch !== null) {
      out.push(stripInlineMarkdown(line));
      continue;
    }
    const bqMatch = line.match(BLOCKQUOTE_RX);
    if (bqMatch !== null) {
      out.push(stripInlineMarkdown(bqMatch[1]));
      continue;
    }
    out.push(stripInlineMarkdown(line));
  }
  return out.join('\n').replace(/\n{3,}/g, '\n\n').trimEnd();
};

const stripInlineMarkdown = (s: string): string =>
  s
    .replace(LINK_RX, '$1 ($2)')
    .replace(/`([^`]+)`/g, '$1')
    .replace(/\*\*([^*]+)\*\*/g, '$1')
    .replace(/(^|[^\w*])\*([^*\n]+)\*(?!\w)/g, '$1$2')
    .replace(/(^|[^\w_])_([^_\n]+)_(?!\w)/g, '$1$2');
