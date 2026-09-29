/**
 * Tests for email encoding/decoding utilities
 * Covers: decodeHtmlEntities, stripHtml, encodeEmailHeader, truncateText
 */

import {
  decodeHtmlEntities,
  stripHtml,
  encodeEmailHeader,
  truncateText,
  MAX_STRIP_HTML_INPUT_CHARS,
  HTML_TRUNCATION_MARKER,
} from '../utils/email-encoding';

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

  it('removes multiple script/style blocks, with attributes and mixed case', () => {
    const html =
      '<p>a</p><SCRIPT type="text/javascript">x()</SCRIPT><p>b</p>' +
      '<style media="all">p{}</style><p>c</p><script>y()</script >d';
    expect(stripHtml(html)).toBe('a\n\nb\n\nc\n\nd');
  });

  it('tag removal matches the old /<[^>]+>/g semantics on well-formed and odd input', () => {
    // Reference: the pre-fix pipeline (safe to run here — inputs are tiny).
    const legacyStrip = (html: string) =>
      decodeHtmlEntities(
        html
          .replace(/<script[^>]*>[\s\S]*?<\/script>/gi, '')
          .replace(/<style[^>]*>[\s\S]*?<\/style>/gi, '')
          .replace(/<\/p>/gi, '\n\n')
          .replace(/<br\s*\/?>/gi, '\n')
          .replace(/<\/div>/gi, '\n')
          .replace(/<\/li>/gi, '\n')
          .replace(/<\/tr>/gi, '\n')
          .replace(/<\/h[1-6]>/gi, '\n\n')
          .replace(/<[^>]+>/g, '')
          .replace(/[ \t]+/g, ' ')
          .replace(/ *\n */g, '\n')
          .replace(/\n{3,}/g, '\n\n')
          .trim(),
      );
    const inputs = [
      'a <> b',
      'x < y and <b>bold</b>',
      '3 <4',
      '<<a>>text',
      '<div class="gmail_quote"><p>Hi</p><blockquote>On Mon wrote:<br>old</blockquote></div>',
      '<table><tr><td>1</td></tr><tr><td>2</td></tr></table>',
      '<h1>Title</h1><ul><li>one</li><li>two</li></ul>&nbsp;&amp;',
      'hello<script>alert("xss")</script>world<style>p{}</style>!',
    ];
    for (const input of inputs) {
      expect(stripHtml(input)).toBe(legacyStrip(input));
    }
  });

  it('drops the remainder after an unclosed <script> (browser raw-text semantics)', () => {
    expect(stripHtml('<p>Tuesday 3pm works</p><script>var a = 1;')).toBe('Tuesday 3pm works');
  });

  // E12 regression: the old `/<script[^>]*>[\s\S]*?<\/script>/gi` and
  // `/<[^>]+>/g` patterns were quadratic on unclosed tags (128KB of
  // "<script>" ~400ms; 128KB of "<a" ~4s), so any sender could stall the
  // event loop on every poll / thread fetch.
  describe('linear-time on hostile input (E12)', () => {
    const SIZE = 256 * 1024;

    it('strips a 256KB body of unclosed <script> tags in well under 100ms', () => {
      const html = '<script>'.repeat(SIZE / 8);
      expect(html.length).toBe(SIZE);
      const start = process.hrtime.bigint();
      stripHtml(html);
      const ms = Number(process.hrtime.bigint() - start) / 1e6;
      expect(ms).toBeLessThan(100);
    });

    it('strips a 256KB body of unclosed <style tags in well under 100ms', () => {
      const html = 'x<style'.repeat(Math.floor(SIZE / 7));
      const start = process.hrtime.bigint();
      stripHtml(html);
      const ms = Number(process.hrtime.bigint() - start) / 1e6;
      expect(ms).toBeLessThan(100);
    });

    it('strips a 256KB body of "<a" with no closing ">" in well under 100ms', () => {
      const html = '<a'.repeat(SIZE / 2);
      const start = process.hrtime.bigint();
      const out = stripHtml(html);
      const ms = Number(process.hrtime.bigint() - start) / 1e6;
      expect(ms).toBeLessThan(100);
      // No tag ever closes, so the text survives untouched.
      expect(out).toBe(html);
    });
  });

  describe('input size cap', () => {
    it('does not truncate input at or below the cap', () => {
      const html = `<p>${'a'.repeat(1000)}</p>`;
      expect(stripHtml(html)).not.toContain(HTML_TRUNCATION_MARKER);
    });

    it('truncates oversized input, keeps the top of the message and appends a marker', () => {
      const html = `<p>Tuesday 3pm works</p>${'<div>quoted history</div>'.repeat(
        Math.ceil((MAX_STRIP_HTML_INPUT_CHARS * 2) / 25),
      )}<p>TAIL-SENTINEL</p>`;
      const out = stripHtml(html);
      expect(out.startsWith('Tuesday 3pm works')).toBe(true);
      expect(out.endsWith(HTML_TRUNCATION_MARKER)).toBe(true);
      expect(out).not.toContain('TAIL-SENTINEL');
      // The cut never leaves a dangling partial tag in the output.
      expect(out).not.toMatch(/<div/);
    });

    it('handles a multi-megabyte hostile body quickly', () => {
      const html = '<script>'.repeat((4 * 1024 * 1024) / 8);
      const start = process.hrtime.bigint();
      stripHtml(html);
      const ms = Number(process.hrtime.bigint() - start) / 1e6;
      expect(ms).toBeLessThan(100);
    });
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
