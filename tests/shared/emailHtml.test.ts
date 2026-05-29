import { describe, expect, it } from 'vitest';
import {
  bodyToHtmlFragment,
  bodyToPlainText,
  htmlToPlainText,
  isHtmlBody,
  normalizeApprovedBody,
  sanitizeEmailHtml,
} from '../../src/shared/emailHtml.js';

describe('sanitizeEmailHtml', () => {
  it('keeps bold, italic, underline, and safe links', () => {
    const raw =
      '<div>Hi <b>there</b>, <i>please</i> <u>see</u> <a href="https://example.com">this</a></div>';
    const out = sanitizeEmailHtml(raw);
    expect(out).toContain('<b>there</b>');
    expect(out).toContain('<i>please</i>');
    expect(out).toContain('<u>see</u>');
    expect(out).toContain('href="https://example.com"');
  });

  it('strips scripts and javascript links', () => {
    const raw =
      '<script>alert(1)</script>Hi<a href="javascript:alert(1)">bad</a><img onerror="alert(1)">';
    const out = sanitizeEmailHtml(raw);
    expect(out).not.toMatch(/script/i);
    expect(out).not.toMatch(/javascript:/i);
    expect(out).not.toMatch(/onerror/i);
    expect(out).toContain('Hi');
  });
});

describe('normalizeApprovedBody', () => {
  it('collapses unformatted editor HTML back to plain text', () => {
    const raw = '<div>Line one</div><div>Line two</div>';
    expect(normalizeApprovedBody(raw)).toBe('Line one\nLine two');
    expect(isHtmlBody(normalizeApprovedBody(raw))).toBe(false);
  });

  it('keeps formatted bodies as sanitized HTML', () => {
    const raw = '<div>Check <a href="https://sobrietyselect.com">our site</a></div>';
    const out = normalizeApprovedBody(raw);
    expect(isHtmlBody(out)).toBe(true);
    expect(out).toContain('href="https://sobrietyselect.com"');
  });
});

describe('bodyToHtmlFragment / bodyToPlainText', () => {
  it('converts plain bodies for MIME html part', () => {
    expect(bodyToHtmlFragment('Hi\nthere')).toBe('Hi<br>there');
    expect(bodyToPlainText('Hi\nthere')).toBe('Hi\nthere');
  });

  it('round-trips formatted HTML to a plain part', () => {
    const html = '<b>Bold</b> and <a href="https://x.com">link</a>';
    expect(bodyToHtmlFragment(html)).toContain('<b>Bold</b>');
    expect(bodyToPlainText(html)).toBe('Bold and link');
    expect(htmlToPlainText('<div>A<br>B</div>')).toBe('A\nB');
  });
});
