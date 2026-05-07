/**
 * Voucher section renderer
 *
 * Single source of truth for the "you have a fresh voucher / your
 * voucher is about to expire" text block injected into voucher
 * emails. Used by:
 *   - weekly-mailing-list.service.ts (new-voucher and reminder paths)
 *   - voucher-issuance.service.ts (welcome email after signup)
 *
 * Centralised so admins editing voucher copy only have to change one
 * piece of text and all downstream emails (weekly, reminder, welcome,
 * future admin-issue) stay coherent. Previously the welcome template
 * had its own inline copy that could drift from the weekly text.
 */

/**
 * Format a voucher expiry date as a human-readable string,
 * e.g. "21 May 2026". UK locale matches the existing convention in
 * weekly-mailing-list.service.ts.
 */
export function formatVoucherExpiry(date: Date): string {
  return date.toLocaleDateString('en-GB', {
    day: 'numeric',
    month: 'long',
    year: 'numeric',
  });
}

interface VoucherSectionParams {
  /**
   * True for "your voucher expires soon" reminder copy, false for
   * the "fresh voucher allocated" copy.
   */
  isReminder: boolean;
  /** Human-readable expiry, e.g. "21 May 2026". */
  voucherExpiry: string;
  /** Only used for reminder copy: how many days until expiry. */
  daysRemaining?: number;
}

/**
 * Render the voucher block for inclusion in a voucher email body.
 * Keeps the user-facing copy identical across every voucher path so
 * a tweak to one line shows up everywhere.
 */
export function renderVoucherSection(params: VoucherSectionParams): string {
  if (params.isReminder) {
    const daysText =
      params.daysRemaining !== undefined && params.daysRemaining >= 0
        ? `in ${params.daysRemaining} day${params.daysRemaining === 1 ? '' : 's'}`
        : `on ${params.voucherExpiry}`;
    return `Just a reminder — your personal booking link expires ${daysText}. Don't miss out on your free therapy session.`;
  }
  return `You've been allocated a new personal booking link. It expires on ${params.voucherExpiry}, so please book before then. Once it's gone, your spot will be offered to someone else.`;
}
