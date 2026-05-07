/**
 * Voucher issuance service
 *
 * Issues a fresh booking voucher to a user and emails them the booking
 * link (with voucher embedded as a query parameter). Used by:
 *   - signup.routes.ts: post-commit, immediately after a successful
 *     signup so the user doesn't have to wait for the next weekly tick
 *     to get their first voucher. Without this they're stranded
 *     post-signup if `voucher.required` is enabled.
 *   - admin-vouchers.routes.ts (future migration): the manual-issue
 *     endpoint duplicates this logic inline today; it should converge
 *     here in a follow-up.
 *
 * Behaviour:
 *   - Skips silently when `voucher.enabled === false` (vouchers are off
 *     platform-wide; nothing to issue).
 *   - Generates a fresh HMAC-signed voucher token tied to the user's
 *     email + expiry window.
 *   - Upserts `voucherTracking` so the weekly mailing won't issue a
 *     second voucher and overwrite this one. `strikeCount` resets to 0
 *     and `unsubscribedAt` clears (re-subscribes a previously
 *     unsubscribed user).
 *   - Renders the welcome template (`email.welcomeBookingSubject` /
 *     `email.welcomeBookingBody`) and sends via the email queue.
 *   - Returns a result object so callers can log; never throws.
 *
 * Failure modes (each logged, never raised):
 *   - voucher.enabled lookup fails → treat as enabled and proceed
 *     (safer than silently skipping the dispatch).
 *   - tracking upsert fails → no token persisted; skip the email
 *     send and return failure. Caller logs; admin can re-issue
 *     manually via the admin-vouchers UI.
 *   - email send fails → token IS persisted; user can still book if
 *     someone shares the URL out of band. Caller logs.
 */

import { prisma } from '../utils/database';
import { logger } from '../utils/logger';
import { config } from '../config';
import { getSettingValue } from './settings.service';
import { generateVoucherUrl } from '../utils/voucher-token';
import { generateUnsubscribeUrl } from '../utils/unsubscribe-token';
import { renderTemplate } from '../utils/email-templates';
import { emailProcessingService } from './email-processing.service';

interface IssueWelcomeVoucherParams {
  email: string;
  /** Used to personalise the welcome email. Falls back to the email's local-part if absent. */
  name?: string | null;
  traceId?: string;
}

interface IssueWelcomeVoucherResult {
  /** True if a token was persisted to voucherTracking. */
  tokenIssued: boolean;
  /** True if the welcome email was sent successfully. */
  emailSent: boolean;
  /** What3Words-style display code (logged for ops; never sent in logs unredacted). */
  displayCode?: string;
  /** Skipped because vouchers are disabled platform-wide. */
  skippedDisabled?: boolean;
}

export async function issueWelcomeVoucher(
  params: IssueWelcomeVoucherParams,
): Promise<IssueWelcomeVoucherResult> {
  const emailLower = params.email.toLowerCase();
  const traceId = params.traceId;
  const logCtx = { traceId, email: emailLower };

  // Honour the platform-wide `voucher.enabled` toggle. If vouchers
  // are off, there's nothing to issue. Lookup failure defaults to
  // enabled — safer to risk an unnecessary issue than to silently
  // strand the user.
  let voucherEnabled = true;
  try {
    voucherEnabled = (await getSettingValue<boolean>('voucher.enabled')) !== false;
  } catch (err) {
    logger.warn({ ...logCtx, err }, 'voucher.enabled lookup failed; proceeding with issuance');
  }
  if (!voucherEnabled) {
    return { tokenIssued: false, emailSent: false, skippedDisabled: true };
  }

  // Generate the voucher.
  let voucherResult: ReturnType<typeof generateVoucherUrl>;
  try {
    const expiryDays = await getSettingValue<number>('voucher.expiryDays');
    const webAppUrl = (await getSettingValue<string>('weeklyMailing.webAppUrl')) || config.frontendUrl;
    voucherResult = generateVoucherUrl(emailLower, webAppUrl, expiryDays);
  } catch (err) {
    logger.error({ ...logCtx, err }, 'Failed to generate welcome voucher URL');
    return { tokenIssued: false, emailSent: false };
  }

  // Persist tracking row. If this fails, we don't send the email —
  // sending a token that isn't recorded would mean the booking
  // endpoint's revoke check (lastVoucherToken === null) couldn't
  // disable the token if needed.
  const now = new Date();
  try {
    await prisma.voucherTracking.upsert({
      where: { id: emailLower },
      create: {
        id: emailLower,
        lastVoucherSentAt: now,
        lastVoucherToken: voucherResult.token,
        strikeCount: 0,
      },
      update: {
        lastVoucherSentAt: now,
        lastVoucherToken: voucherResult.token,
        reminderSentAt: null,
        // Re-subscribe in case the user previously unsubscribed and
        // is now signing up again — admin-issued vouchers do the same.
        unsubscribedAt: null,
        strikeCount: 0,
      },
    });
  } catch (err) {
    logger.error({ ...logCtx, err }, 'Failed to upsert voucherTracking for welcome voucher');
    return { tokenIssued: false, emailSent: false, displayCode: voucherResult.displayCode };
  }

  // Render + send the welcome email.
  let emailSent = false;
  try {
    const userName = params.name?.trim() || emailLower.split('@')[0];
    const subjectTemplate = await getSettingValue<string>('email.welcomeBookingSubject');
    const bodyTemplate = await getSettingValue<string>('email.welcomeBookingBody');
    const voucherExpiry = voucherResult.expiresAt.toLocaleDateString('en-GB', {
      day: 'numeric',
      month: 'long',
      year: 'numeric',
    });
    const subject = renderTemplate(subjectTemplate, {
      userName,
      voucherCode: voucherResult.displayCode,
    });
    const body = renderTemplate(bodyTemplate, {
      userName,
      voucherCode: voucherResult.displayCode,
      voucherExpiry,
      webAppUrl: voucherResult.url,
      // Unsubscribe URL is included in the body footer if the template
      // references {unsubscribeUrl}. Default template doesn't, but
      // expose it so admins editing the template can add it.
      unsubscribeUrl: generateUnsubscribeUrl(emailLower, config.backendUrl),
    });
    await emailProcessingService.sendEmail({ to: emailLower, subject, body });
    emailSent = true;
  } catch (err) {
    // Token is already persisted at this point — the user can still
    // book if someone shares the URL. Log loudly so ops can spot the
    // failure and resend manually if needed.
    logger.error({ ...logCtx, err }, 'Failed to send welcome voucher email (token already persisted)');
  }

  logger.info(
    { ...logCtx, displayCode: voucherResult.displayCode, emailSent },
    'Issued welcome voucher',
  );

  return {
    tokenIssued: true,
    emailSent,
    displayCode: voucherResult.displayCode,
  };
}
