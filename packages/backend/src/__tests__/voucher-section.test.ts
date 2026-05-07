/**
 * Tests for the shared voucher-section helper. Both the weekly
 * mailing and the welcome (post-signup) email render their voucher
 * block via this helper, so a tweak here ripples coherently. These
 * specs pin the public copy so anyone editing it has to update the
 * tests in lockstep.
 */

import { renderVoucherSection, formatVoucherExpiry } from '../utils/voucher-section';

describe('renderVoucherSection', () => {
  it('returns the first-issue copy when isReminder is false', () => {
    const out = renderVoucherSection({
      isReminder: false,
      voucherExpiry: '21 May 2026',
    });

    expect(out).toContain("You've been allocated a new personal booking link");
    expect(out).toContain('21 May 2026');
    expect(out).toContain('please book before then');
    // First-issue copy must NOT use reminder-only phrasing.
    expect(out).not.toContain('Just a reminder');
  });

  it('uses days-remaining phrasing in reminder copy when daysRemaining is provided', () => {
    const out = renderVoucherSection({
      isReminder: true,
      voucherExpiry: '21 May 2026',
      daysRemaining: 3,
    });

    expect(out).toContain('Just a reminder');
    expect(out).toContain('in 3 days');
    // Falls back to the date phrasing only when daysRemaining is omitted —
    // assert that didn't happen here.
    expect(out).not.toContain('on 21 May 2026');
  });

  it('singularises "1 day" correctly (no "1 days")', () => {
    const out = renderVoucherSection({
      isReminder: true,
      voucherExpiry: 'tomorrow',
      daysRemaining: 1,
    });

    expect(out).toContain('in 1 day');
    expect(out).not.toContain('in 1 days');
  });

  it('uses date-based phrasing when daysRemaining is omitted from a reminder', () => {
    const out = renderVoucherSection({
      isReminder: true,
      voucherExpiry: '21 May 2026',
    });

    expect(out).toContain('on 21 May 2026');
  });

  it('treats negative daysRemaining as the date-fallback path (already expired)', () => {
    const out = renderVoucherSection({
      isReminder: true,
      voucherExpiry: '21 May 2026',
      daysRemaining: -1,
    });

    // daysRemaining < 0 means the voucher already lapsed; fall back
    // to the absolute date so the copy doesn't read "in -1 days".
    expect(out).toContain('on 21 May 2026');
    expect(out).not.toContain('-1 day');
  });
});

describe('formatVoucherExpiry', () => {
  it('formats UK long-form date', () => {
    const date = new Date('2026-05-21T00:00:00Z');
    const formatted = formatVoucherExpiry(date);

    expect(formatted).toMatch(/\d{1,2} \w+ \d{4}/);
    expect(formatted).toContain('2026');
    expect(formatted).toContain('May');
  });
});
