/**
 * Voucher URL helper for non-issuance contexts.
 *
 * `voucher-issuance.service.ts` does two things together: generate +
 * persist a voucher AND send a welcome email. Some callers — the
 * therapist-initiated cancellation flow being the first — need only
 * the URL itself (to embed in a different, non-welcome email) and
 * sending a welcome alongside the cancellation would be confusing.
 *
 * Behaviour:
 *   - Returns `null` when `voucher.enabled === false`.
 *   - If the user already has a non-expired `lastVoucherToken` in
 *     `VoucherTracking`, reconstructs and returns the URL from it.
 *     This means a user with an active weekly-mailing voucher
 *     receives the SAME link in the cancellation email — no
 *     surprise invalidation of a link they may have saved.
 *   - Otherwise issues a fresh token, persists it (upsert into
 *     `VoucherTracking`), and returns the URL. The token-issuance
 *     side effect matches what `voucher-issuance.service` would
 *     do, minus the welcome email send.
 *   - All errors are caught + logged; never throws. Returning null
 *     lets the caller render an email without a voucher line
 *     rather than blocking the cancellation notification.
 */

import { prisma } from '../utils/database';
import { logger } from '../utils/logger';
import { config } from '../config';
import { getSettingValue } from './settings.service';
import {
  generateVoucherUrl,
  validateVoucherToken,
} from '../utils/voucher-token';

/**
 * Resolve a usable voucher URL for the given email. See module
 * docstring for the reuse-vs-issue policy.
 */
export async function ensureVoucherUrlForUser(email: string): Promise<string | null> {
  const lower = email.toLowerCase();
  const logCtx = { email: lower };

  let voucherEnabled = true;
  try {
    voucherEnabled = (await getSettingValue<boolean>('voucher.enabled')) !== false;
  } catch (err) {
    logger.warn({ ...logCtx, err }, 'ensureVoucherUrlForUser: voucher.enabled lookup failed; proceeding');
  }
  if (!voucherEnabled) {
    return null;
  }

  let webAppUrl: string;
  let expiryDays: number;
  try {
    webAppUrl = (await getSettingValue<string>('weeklyMailing.webAppUrl')) || config.frontendUrl;
    expiryDays = await getSettingValue<number>('voucher.expiryDays');
  } catch (err) {
    logger.error({ ...logCtx, err }, 'ensureVoucherUrlForUser: settings lookup failed');
    return null;
  }

  // Reuse an existing valid token when present — the user's existing
  // link (e.g. from a weekly mailing they're sitting on) stays valid
  // and the cancellation email links to the same one rather than
  // silently invalidating it.
  try {
    const existing = await prisma.voucherTracking.findUnique({
      where: { id: lower },
      select: { lastVoucherToken: true },
    });
    if (existing?.lastVoucherToken) {
      const validation = validateVoucherToken(existing.lastVoucherToken, expiryDays);
      if (validation.valid && validation.email === lower) {
        const separator = webAppUrl.includes('?') ? '&' : '?';
        return `${webAppUrl}${separator}voucher=${encodeURIComponent(existing.lastVoucherToken)}`;
      }
    }
  } catch (err) {
    // Fall through to issue a fresh token — losing the read but still
    // delivering a usable URL is better than dropping the voucher.
    logger.warn({ ...logCtx, err }, 'ensureVoucherUrlForUser: existing token lookup failed; issuing fresh');
  }

  // No usable existing token — issue + persist a fresh one. Same
  // tracking-row shape as voucher-issuance.service.ts so the
  // weekly-mailing rotation honours it on the next tick.
  try {
    const result = generateVoucherUrl(lower, webAppUrl, expiryDays);
    const now = new Date();
    await prisma.voucherTracking.upsert({
      where: { id: lower },
      create: {
        id: lower,
        lastVoucherSentAt: now,
        lastVoucherToken: result.token,
        strikeCount: 0,
      },
      update: {
        lastVoucherSentAt: now,
        lastVoucherToken: result.token,
        reminderSentAt: null,
        unsubscribedAt: null,
        strikeCount: 0,
      },
    });
    return result.url;
  } catch (err) {
    logger.error({ ...logCtx, err }, 'ensureVoucherUrlForUser: failed to issue fresh voucher');
    return null;
  }
}
