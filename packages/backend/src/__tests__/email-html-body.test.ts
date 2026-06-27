/**
 * Tests for convertPlainTextToHtml — the plain-text → HTML email body
 * formatter used by the outbound send path.
 *
 * The headline case here is the "Session Details" regression: a block that
 * starts with a non-list header line and is followed by `-` list items
 * (as the therapist-confirmation and session-reminder templates do) used to
 * be flattened onto one line, because list detection required EVERY line in
 * the paragraph to be a list marker. It now renders the header as a <p> and
 * the items as a real <ul>.
 */

import { convertPlainTextToHtml } from '../utils/email-html-body';

describe('convertPlainTextToHtml', () => {
  describe('mixed header + list block (the Session Details regression)', () => {
    // Mirrors the email.therapistConfirmationBody template shape.
    const body = `Hi Harry,

Thanks for confirming! The session with Sam is all set:

**Session Details:**
- Client Email: sam@example.com
- Date/Time: Tuesday 17 February at 11:00
- Duration: 50 minutes

Please send Sam the meeting link.

Best wishes

Justin`;

    it('renders the list as a real <ul> with one <li> per item', () => {
      const html = convertPlainTextToHtml(body);
      expect(html).toContain('<ul');
      expect(html).toContain('<li>Client Email: sam@example.com</li>');
      expect(html).toContain('<li>Date/Time: Tuesday 17 February at 11:00</li>');
      expect(html).toContain('<li>Duration: 50 minutes</li>');
    });

    it('does NOT flatten the items onto one line with literal dashes', () => {
      const html = convertPlainTextToHtml(body);
      // The old bug produced "...Details:</strong> - Client Email: ... - Date/Time: ..."
      expect(html).not.toMatch(/Client Email:[^<]*-\s*Date\/Time:/);
    });

    it('renders the **bold** header and keeps it out of the list', () => {
      const html = convertPlainTextToHtml(body);
      expect(html).toContain('<strong>Session Details:</strong>');
      // The header is its own paragraph, immediately followed by the list.
      expect(html).toMatch(/<strong>Session Details:<\/strong><\/p>\s*<ul/);
    });
  });

  describe('preserves existing behaviour', () => {
    it('renders a pure list block as a single <ul>', () => {
      const html = convertPlainTextToHtml('- one\n- two\n- three');
      expect(html).toContain('<ul');
      expect((html.match(/<li>/g) || []).length).toBe(3);
      expect(html).not.toContain('<p');
    });

    it('joins a wrapped plain paragraph with spaces (mobile reflow)', () => {
      const html = convertPlainTextToHtml('This is a single\nparagraph split\nacross lines.');
      expect(html).toContain('<p style="margin: 0 0 16px 0;">This is a single paragraph split across lines.</p>');
    });

    it('keeps signature line breaks with <br>', () => {
      const html = convertPlainTextToHtml('Best wishes\nJustin');
      expect(html).toContain('Best wishes<br>Justin');
    });

    it('separates paragraphs split by blank lines', () => {
      const html = convertPlainTextToHtml('First paragraph.\n\nSecond paragraph.');
      expect((html.match(/<p /g) || []).length).toBe(2);
    });

    it('renders markdown links as anchors', () => {
      const html = convertPlainTextToHtml('Book here: [Book a session](https://free.spill.app/)');
      expect(html).toContain('<a href="https://free.spill.app/"');
      expect(html).toContain('>Book a session</a>');
    });
  });

  describe('runs of text and list interleaved', () => {
    it('emits <p>, <ul>, <p> in order for text → list → text', () => {
      const html = convertPlainTextToHtml('Here are the options:\n- option A\n- option B\nLet me know which works.');
      const pFirst = html.indexOf('Here are the options');
      const ul = html.indexOf('<ul');
      const pLast = html.indexOf('Let me know which works');
      expect(pFirst).toBeGreaterThan(-1);
      expect(ul).toBeGreaterThan(pFirst);
      expect(pLast).toBeGreaterThan(ul);
    });
  });

  it('escapes HTML special characters in body text', () => {
    const html = convertPlainTextToHtml('Tom & Jerry <script>alert(1)</script>');
    expect(html).toContain('Tom &amp; Jerry');
    expect(html).not.toContain('<script>');
  });
});
