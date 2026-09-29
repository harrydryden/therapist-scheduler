/**
 * §4.3 — quoted reply text was never stripped, so the thread context grew
 * quadratically and the classifier reacted to our own earlier wording.
 */

import { stripQuotedReply } from '../core/email/inbound/quoted-text';

describe('stripQuotedReply', () => {
  it('drops everything from a Gmail-style attribution line', () => {
    const body = 'Tuesday at 3pm is great.\n\nOn Mon, 28 Sep 2026 at 10:00, Justin <scheduling@spill.chat> wrote:\n> Can you do Tuesday?\n> Or cancel?';
    expect(stripQuotedReply(body)).toBe('Tuesday at 3pm is great.');
  });

  it('handles an attribution line wrapped over two lines', () => {
    const body = 'Yes please.\n\nOn Mon, 28 Sep 2026 at 10:00, Justin Time <\nscheduling@spill.chat> wrote:\n\n> Old text';
    expect(stripQuotedReply(body)).toBe('Yes please.');
  });

  it('drops an Outlook "Original Message" block', () => {
    const body = 'Works for me.\r\n\r\n-----Original Message-----\r\nFrom: Justin\r\nSubject: times';
    expect(stripQuotedReply(body)).toBe('Works for me.');
  });

  it('removes inline ">" quotes but keeps the answers between them', () => {
    const body = '> Which day suits you?\nTuesday\n> What time?\n3pm';
    expect(stripQuotedReply(body)).toBe('Tuesday\n3pm');
  });

  it('returns the original text when everything would be stripped', () => {
    const body = '> only a quote\n> nothing else';
    expect(stripQuotedReply(body)).toBe(body);
  });

  it('leaves a plain reply untouched', () => {
    expect(stripQuotedReply('On Tuesday I can do 3pm.')).toBe('On Tuesday I can do 3pm.');
  });

  it('is linear on hostile input', () => {
    const hostile = 'On '.repeat(200_000) + '\n' + '>'.repeat(200_000);
    const start = Date.now();
    stripQuotedReply(hostile);
    expect(Date.now() - start).toBeLessThan(200);
  });
});
