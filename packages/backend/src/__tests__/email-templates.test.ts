/**
 * Tests for email template rendering security
 * Covers: header injection prevention, XSS prevention, basic rendering
 */

// Mock logger to prevent actual logging during tests
jest.mock('../utils/logger', () => ({
  logger: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
}));

import { renderTemplate } from '../utils/email-templates';

describe('renderTemplate', () => {
  it('replaces simple variables', () => {
    const result = renderTemplate('Hello {name}!', { name: 'Alice' });
    expect(result).toBe('Hello Alice!');
  });

  it('replaces multiple occurrences of the same variable', () => {
    const result = renderTemplate('{name} said hello to {name}', { name: 'Bob' });
    expect(result).toBe('Bob said hello to Bob');
  });

  it('replaces multiple different variables', () => {
    const result = renderTemplate('{greeting} {name}!', { greeting: 'Hi', name: 'Charlie' });
    expect(result).toBe('Hi Charlie!');
  });

  it('leaves unreferenced placeholders unchanged', () => {
    const result = renderTemplate('{name} at {time}', { name: 'Alice' });
    expect(result).toBe('Alice at {time}');
  });

  it('skips undefined variables', () => {
    const result = renderTemplate('Hello {name}!', { name: undefined as any });
    expect(result).toBe('Hello {name}!');
  });

  describe('header injection prevention', () => {
    it('strips \\r\\n from variable values', () => {
      const result = renderTemplate('Subject: {subject}', {
        subject: 'Hello\r\nBcc: attacker@evil.com',
      });
      expect(result).not.toContain('\r');
      expect(result).not.toContain('\n');
      expect(result).toBe('Subject: HelloBcc: attacker@evil.com');
    });

    it('strips \\n alone from variable values', () => {
      const result = renderTemplate('{value}', { value: 'line1\nline2' });
      expect(result).toBe('line1line2');
    });

    it('strips \\r alone from variable values', () => {
      const result = renderTemplate('{value}', { value: 'line1\rline2' });
      expect(result).toBe('line1line2');
    });
  });

  describe('XSS prevention', () => {
    it('HTML-escapes < and > in variable values', () => {
      const result = renderTemplate('{value}', { value: '<script>alert("xss")</script>' });
      expect(result).not.toContain('<script>');
      expect(result).toContain('&lt;script&gt;');
    });

    it('HTML-escapes ampersands', () => {
      const result = renderTemplate('{value}', { value: 'foo & bar' });
      expect(result).toContain('&amp;');
    });

    it('HTML-escapes quotes', () => {
      const result = renderTemplate('{value}', {
        value: 'onclick="alert(1)" onmouseover=\'alert(2)\'',
      });
      expect(result).toContain('&quot;');
      expect(result).toContain('&#39;');
    });

    it('does not double-escape already-safe template HTML', () => {
      // The template itself should not be escaped, only the variables
      const template = '<div class="greeting">Hello {name}!</div>';
      const result = renderTemplate(template, { name: 'Alice' });
      expect(result).toBe('<div class="greeting">Hello Alice!</div>');
    });
  });
});
