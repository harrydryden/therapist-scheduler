import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { sanitizeExternalUrl } from '../sanitize';

describe('sanitizeExternalUrl', () => {
  beforeEach(() => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
  });
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('accepts absolute http(s) URLs', () => {
    expect(sanitizeExternalUrl('https://calendly.com/dr-x/intro')).toBe('https://calendly.com/dr-x/intro');
    expect(sanitizeExternalUrl('  http://example.com/book  ')).toBe('http://example.com/book');
  });

  it.each([
    'javascript:alert(1)',
    ' JavaScript:alert(document.cookie)',
    'data:text/html,<script>alert(1)</script>',
    'vbscript:msgbox(1)',
    '/relative/path',
    '//evil.example.com',
    'calendly.com/dr-x',
    'not a url',
    '',
    null,
    undefined,
  ])('rejects %s', (value) => {
    expect(sanitizeExternalUrl(value as string | null | undefined)).toBeNull();
  });
});
