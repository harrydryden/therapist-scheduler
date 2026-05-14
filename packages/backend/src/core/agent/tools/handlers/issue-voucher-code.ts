/**
 * `issue_voucher_code` — generate a one-time voucher code for the
 * conversation's user and email-able URL.
 *
 * Security: voucher issuance is bound to `context.userEmail`, NOT
 * the `email` argument supplied by the agent. A user could otherwise
 * prompt-inject the agent into issuing a valid voucher to an
 * attacker-controlled address, bypassing the `voucher.required`
 * gate at booking time. If the agent supplies a non-matching email
 * we log + warn but proceed with the context email.
 *
 * Persistence: upserts a `VoucherTracking` row by the user's email
 * (lowercased) — stores the token + sent-at and resets reminder /
 * unsubscribe / strike-count fields so each new voucher starts
 * clean.
 */

import { logger } from '../../../../utils/logger';
import { prisma } from '../../../../utils/database';
import { generateVoucherUrl } from '../../../../utils/voucher-token';
import { getSettingValue } from '../../../../services/settings.service';
import { issueVoucherCodeInputSchema } from '../../../../schemas/tool-inputs';
import type {
  SchedulingContext,
  ToolExecutionResult,
} from '../../../../services/scheduling-context.service';

export async function handleIssueVoucherCode(
  rawInput: unknown,
  context: SchedulingContext,
  traceId: string,
): Promise<ToolExecutionResult> {
  const parsed = issueVoucherCodeInputSchema.safeParse(rawInput);
  if (!parsed.success) {
    return { success: false, toolName: 'issue_voucher_code', error: `Invalid input: ${parsed.error.message}` };
  }

  // SECURITY: bind voucher issuance to the conversation's user, not
  // the agent's chosen `email` argument.
  const requestedLower = parsed.data.email.toLowerCase().trim();
  const userLower = context.userEmail.toLowerCase().trim();
  if (requestedLower !== userLower) {
    logger.warn(
      {
        traceId,
        appointmentRequestId: context.appointmentRequestId,
        attemptedEmail: requestedLower,
        contextUserEmail: userLower,
      },
      'Agent attempted to issue voucher to non-context email — overriding to context.userEmail',
    );
  }
  const emailLower = userLower;

  const expiryDays = await getSettingValue<number>('voucher.expiryDays');
  const webAppUrl = await getSettingValue<string>('weeklyMailing.webAppUrl');
  const voucherResult = generateVoucherUrl(emailLower, webAppUrl, expiryDays);

  const now = new Date();
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
      unsubscribedAt: null,
      strikeCount: 0,
    },
  });

  logger.info(
    { traceId, email: emailLower, displayCode: voucherResult.displayCode },
    'Agent issued voucher code for user',
  );

  const voucherExpiry = voucherResult.expiresAt.toLocaleDateString('en-GB', {
    day: 'numeric', month: 'long', year: 'numeric',
  });
  return {
    success: true,
    toolName: 'issue_voucher_code',
    resultMessage: `Voucher issued successfully. Display code: ${voucherResult.displayCode}. Booking URL: ${voucherResult.url}. Expires: ${voucherExpiry}. Share the display code and booking URL with the user.`,
    // Informational: the upsert into VoucherTracking is keyed on the
    // user's email so re-issuance overwrites the prior code idempotently.
    // No need for the dispatch-level idempotency mark / counter increment
    // / 'executed' audit event. See ToolExecutionResult docstring.
    bypassPostSuccessBookkeeping: true,
  };
}
