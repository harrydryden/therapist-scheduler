/**
 * Rendering for the four one-shot confirm/cancel transition emails
 * (client + therapist confirmation, client + therapist cancellation).
 *
 * Extracted out of appointment-notifications.service.ts so the same
 * rendering logic has exactly one implementation, callable both from the
 * original send site (`runReplayableTrackedSideEffect`'s `renderPayload`)
 * and from side-effect-retry.service.ts's null-payload fallback — the
 * retry path a pre-commit-registered row takes if the process crashed
 * before the original render ever ran. Mirrors the finalizer-extraction
 * pattern used for periodic effects in periodic-effect-finalizers.ts.
 *
 * See docs/agent-harness-review/register-in-tx-design.md §4.
 */

import { loadEmailTemplate } from '../utils/email-templates';
import { ensureVoucherUrlForUser, resolveBookingUrl } from './voucher-url.service';
import { firstName } from '../utils/first-name';
import { formatEmailDateFromSettings } from '../utils/date';
import { resolveRecipientTimezone } from '../core/timezone';

export interface RenderedTransitionEmail {
  to: string;
  subject: string;
  body: string;
  threadId?: string | null;
}

export async function renderClientConfirmationEmail(params: {
  userEmail: string;
  userName: string | null;
  therapistName: string | null;
  confirmedDateTime: string;
  confirmedDateTimeParsed?: Date | null;
}): Promise<RenderedTransitionEmail> {
  const { userEmail, userName, therapistName, confirmedDateTime, confirmedDateTimeParsed } = params;
  const therapistFirstName = firstName(therapistName, 'your therapist');
  const clientGreetingName = firstName(userName);

  const recipientTz = await resolveRecipientTimezone(userEmail);
  const formattedDateTime = await formatEmailDateFromSettings(
    confirmedDateTimeParsed,
    confirmedDateTime,
    recipientTz ?? undefined,
  );
  const { subject, body } = await loadEmailTemplate(
    'clientConfirmation',
    {
      therapistName: therapistFirstName,
      confirmedDateTime: formattedDateTime,
    },
    {
      userName: clientGreetingName,
      therapistName: therapistFirstName,
      confirmedDateTime: formattedDateTime,
    },
  );
  return { to: userEmail, subject, body };
}

export async function renderTherapistConfirmationEmail(params: {
  therapistEmail: string;
  therapistName: string | null;
  userName: string | null;
  userEmail: string;
  confirmedDateTime: string;
  confirmedDateTimeParsed?: Date | null;
}): Promise<RenderedTransitionEmail> {
  const { therapistEmail, therapistName, userName, userEmail, confirmedDateTime, confirmedDateTimeParsed } = params;
  const therapistFirstName = firstName(therapistName, 'your therapist');
  const clientFirstName = firstName(userName, 'the client');

  const recipientTz = await resolveRecipientTimezone(therapistEmail);
  const formattedDateTime = await formatEmailDateFromSettings(
    confirmedDateTimeParsed,
    confirmedDateTime,
    recipientTz ?? undefined,
  );
  const { subject, body } = await loadEmailTemplate(
    'therapistConfirmation',
    { confirmedDateTime: formattedDateTime },
    {
      therapistFirstName,
      clientFirstName,
      userEmail,
      confirmedDateTime: formattedDateTime,
    },
  );
  return { to: therapistEmail, subject, body };
}

export type CancellationInitiator = 'client' | 'therapist' | 'admin' | 'system';

export async function renderClientCancellationEmail(params: {
  userEmail: string;
  userName: string | null;
  therapistName: string | null;
  cancelledBy: CancellationInitiator;
  reason: string;
  confirmedDateTime: string | null;
  confirmedDateTimeParsed: Date | null;
  gmailThreadId: string | null;
}): Promise<RenderedTransitionEmail> {
  const {
    userEmail,
    userName,
    therapistName,
    cancelledBy,
    reason,
    confirmedDateTime,
    confirmedDateTimeParsed,
    gmailThreadId,
  } = params;
  const therapistFirstName = firstName(therapistName, 'your therapist');
  const clientGreetingName = firstName(userName);
  // Legacy reason injection — only used for the neutral (admin/system)
  // branch where templates carry the line.
  const cancellationReasonForClient = cancelledBy === 'therapist' ? `\nReason: ${reason}` : '';

  const recipientTz = await resolveRecipientTimezone(userEmail);
  const formattedDateTime = await formatEmailDateFromSettings(
    confirmedDateTimeParsed,
    confirmedDateTime,
    recipientTz ?? undefined,
  );

  if (cancelledBy === 'therapist') {
    // Therapist-initiated → apology + voucher link. {voucherLine} is
    // ALWAYS a markdown link so the HTML conversion wraps it in <a href>
    // regardless of which branch fired. Falls back to the platform's
    // general booking URL when no voucher can be issued.
    const [voucherUrl, fallbackUrl] = await Promise.all([
      ensureVoucherUrlForUser(userEmail),
      resolveBookingUrl(),
    ]);
    const url = voucherUrl ?? fallbackUrl;
    const voucherLine = `[Book another session](${url})`;
    const { subject, body } = await loadEmailTemplate(
      'clientCancellationByTherapist',
      { therapistName: therapistFirstName },
      {
        userName: clientGreetingName,
        therapistName: therapistFirstName,
        confirmedDateTime: formattedDateTime,
        voucherLine,
        cancellationReason: cancellationReasonForClient,
      },
    );
    return { to: userEmail, subject, body, threadId: gmailThreadId || null };
  }

  // Default branch: neutral template (client-initiated, admin-initiated,
  // or system-initiated cancellations).
  const { subject, body } = await loadEmailTemplate(
    'clientCancellation',
    { therapistName: therapistFirstName },
    {
      userName: clientGreetingName,
      therapistName: therapistFirstName,
      confirmedDateTime: formattedDateTime,
      cancellationReason: cancellationReasonForClient,
    },
  );
  return { to: userEmail, subject, body, threadId: gmailThreadId || null };
}

export async function renderTherapistCancellationEmail(params: {
  therapistEmail: string;
  therapistName: string | null;
  userName: string | null;
  cancelledBy: CancellationInitiator;
  reason: string;
  confirmedDateTime: string | null;
  confirmedDateTimeParsed: Date | null;
  therapistGmailThreadId: string | null;
}): Promise<RenderedTransitionEmail> {
  const {
    therapistEmail,
    therapistName,
    userName,
    cancelledBy,
    reason,
    confirmedDateTime,
    confirmedDateTimeParsed,
    therapistGmailThreadId,
  } = params;
  const therapistFirstName = firstName(therapistName, 'your therapist');
  const clientFirstName = firstName(userName, 'the client');
  const cancellationReasonForTherapist = cancelledBy === 'client' ? `\nReason: ${reason}` : '';

  const recipientTz = await resolveRecipientTimezone(therapistEmail);
  const formattedDateTime = await formatEmailDateFromSettings(
    confirmedDateTimeParsed,
    confirmedDateTime,
    recipientTz ?? undefined,
  );

  if (cancelledBy === 'client') {
    // Client-initiated → apology + reassurance to therapist.
    const { subject, body } = await loadEmailTemplate(
      'therapistCancellationByClient',
      { clientFirstName },
      {
        therapistFirstName,
        clientFirstName,
        confirmedDateTime: formattedDateTime,
        cancellationReason: cancellationReasonForTherapist,
      },
    );
    return { to: therapistEmail, subject, body, threadId: therapistGmailThreadId };
  }

  // Default branch: neutral confirmation.
  const { subject, body } = await loadEmailTemplate(
    'therapistCancellation',
    { clientFirstName },
    {
      therapistFirstName,
      clientFirstName,
      confirmedDateTime: formattedDateTime,
      cancellationReason: cancellationReasonForTherapist,
    },
  );
  return { to: therapistEmail, subject, body, threadId: therapistGmailThreadId };
}
