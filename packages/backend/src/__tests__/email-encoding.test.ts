/**
 * Tests for email encoding/decoding utilities
 * Covers: decodeQuotedPrintable, decodeHtmlEntities, stripHtml,
 *         encodeEmailHeader, normalizeLineEndings, truncateText
 */

import {
  decodeQuotedPrintable,
  decodeHtmlEntities,
  stripHtml,
  encodeEmailHeader,
  normalizeLineEndings,
  truncateText,
} from '../utils/email-encoding';

describe('decodeQuotedPrintable', () => {
  it('joins soft line breaks (lines ending with =)', () => {
    expect(decodeQuotedPrintable('hello=\r\nworld')).toBe('helloworld');
    expect(decodeQuotedPrintable('hello=\nworld')).toBe('helloworld');
  });

  it('decodes =XX hex sequences', () => {
    expect(decodeQuotedPrintable('=3D')).toBe('=');
    expect(decodeQuotedPrintable('=0D=0A')).toBe('\r\n');
  });

  it('decodes mixed content', () => {
    expect(decodeQuotedPrintable('Hello=20World=21')).toBe('Hello World!');
  });

  it('handles text without encoding', () => {
    expect(decodeQuotedPrintable('plain text')).toBe('plain text');
  });

  it('decodes equals sign (=3D)', () => {
    expect(decodeQuotedPrintable('a=3Db')).toBe('a=b');
  });
});

describe('decodeHtmlEntities', () => {
  it('decodes &nbsp;', () => {
    expect(decodeHtmlEntities('hello&nbsp;world')).toBe('hello world');
  });

  it('decodes &amp;', () => {
    expect(decodeHtmlEntities('foo&amp;bar')).toBe('foo&bar');
  });

  it('decodes &lt; and &gt;', () => {
    expect(decodeHtmlEntities('&lt;div&gt;')).toBe('<div>');
  });

  it('decodes &quot;', () => {
    expect(decodeHtmlEntities('&quot;hello&quot;')).toBe('"hello"');
  });

  it('decodes &#39; and &apos;', () => {
    expect(decodeHtmlEntities('it&#39;s')).toBe("it's");
    expect(decodeHtmlEntities('it&apos;s')).toBe("it's");
  });

  it('decodes numeric entities (&#NNN;)', () => {
    expect(decodeHtmlEntities('&#65;')).toBe('A');
    expect(decodeHtmlEntities('&#97;')).toBe('a');
  });

  it('decodes hex entities (&#xNN;)', () => {
    expect(decodeHtmlEntities('&#x41;')).toBe('A');
    expect(decodeHtmlEntities('&#x61;')).toBe('a');
  });

  it('decodes typographic entities', () => {
    expect(decodeHtmlEntities('&ndash;')).toBe('\u2013');
    expect(decodeHtmlEntities('&mdash;')).toBe('\u2014');
    expect(decodeHtmlEntities('&hellip;')).toBe('\u2026');
    expect(decodeHtmlEntities('&lsquo;')).toBe('\u2018');
    expect(decodeHtmlEntities('&rsquo;')).toBe('\u2019');
    expect(decodeHtmlEntities('&ldquo;')).toBe('\u201C');
    expect(decodeHtmlEntities('&rdquo;')).toBe('\u201D');
  });
});

describe('stripHtml', () => {
  it('removes HTML tags', () => {
    expect(stripHtml('<b>bold</b> text')).toBe('bold text');
  });

  it('converts </p> to newlines', () => {
    const result = stripHtml('<p>paragraph 1</p><p>paragraph 2</p>');
    expect(result).toContain('paragraph 1');
    expect(result).toContain('paragraph 2');
    expect(result).toContain('\n');
  });

  it('converts <br> to newlines', () => {
    expect(stripHtml('line1<br>line2')).toBe('line1\nline2');
    expect(stripHtml('line1<br/>line2')).toBe('line1\nline2');
    expect(stripHtml('line1<br />line2')).toBe('line1\nline2');
  });

  it('removes script tags and their content', () => {
    expect(stripHtml('hello<script>alert("xss")</script>world')).toBe('helloworld');
  });

  it('removes style tags and their content', () => {
    expect(stripHtml('hello<style>body{color:red}</style>world')).toBe('helloworld');
  });

  it('collapses excessive whitespace', () => {
    const result = stripHtml('<p>  hello   world  </p>');
    expect(result).not.toMatch(/\s{3,}/);
  });

  it('decodes HTML entities after stripping', () => {
    expect(stripHtml('<p>foo &amp; bar</p>')).toContain('foo & bar');
  });
});

describe('encodeEmailHeader', () => {
  it('returns ASCII strings unchanged', () => {
    expect(encodeEmailHeader('Hello World')).toBe('Hello World');
  });

  it('encodes non-ASCII characters using RFC 2047', () => {
    const result = encodeEmailHeader('Héllo Wörld');
    expect(result).toMatch(/^=\?UTF-8\?B\?/);
    expect(result).toMatch(/\?=$/);
  });

  it('produces decodable output', () => {
    const original = 'Café résumé';
    const encoded = encodeEmailHeader(original);
    // Extract the Base64 payload
    const match = encoded.match(/=\?UTF-8\?B\?(.+)\?=/);
    if (match) {
      const decoded = Buffer.from(match[1], 'base64').toString('utf-8');
      expect(decoded).toBe(original);
    }
  });
});

describe('normalizeLineEndings', () => {
  it('converts LF to CRLF', () => {
    expect(normalizeLineEndings('line1\nline2')).toBe('line1\r\nline2');
  });

  it('keeps existing CRLF intact (no duplication)', () => {
    expect(normalizeLineEndings('line1\r\nline2')).toBe('line1\r\nline2');
  });

  it('converts standalone CR to CRLF', () => {
    expect(normalizeLineEndings('line1\rline2')).toBe('line1\r\nline2');
  });

  it('handles mixed line endings', () => {
    const input = 'line1\nline2\r\nline3\rline4';
    const result = normalizeLineEndings(input);
    const lines = result.split('\r\n');
    expect(lines).toEqual(['line1', 'line2', 'line3', 'line4']);
  });
});

describe('truncateText', () => {
  it('returns short text unchanged', () => {
    expect(truncateText('hello', 100)).toBe('hello');
  });

  it('truncates long text to maxLength', () => {
    const longText = 'a'.repeat(5000);
    const result = truncateText(longText, 1000);
    expect(result.length).toBeLessThanOrEqual(1000);
  });

  it('includes truncation indicator', () => {
    const longText = 'a'.repeat(5000);
    const result = truncateText(longText, 1000);
    expect(result).toContain('TRUNCATED');
    expect(result).toContain('characters removed');
  });

  it('preserves start and end of text', () => {
    const longText = 'START' + 'x'.repeat(5000) + 'END';
    const result = truncateText(longText, 1000);
    expect(result).toContain('START');
    expect(result).toContain('END');
  });

  it('uses default maxLength of 3000', () => {
    const longText = 'a'.repeat(5000);
    const result = truncateText(longText);
    expect(result.length).toBeLessThanOrEqual(3000);
  });

  it('handles edge case where indicator exceeds maxLength', () => {
    const longText = 'a'.repeat(100);
    const result = truncateText(longText, 10);
    expect(result.length).toBeLessThanOrEqual(100);
  });
});
