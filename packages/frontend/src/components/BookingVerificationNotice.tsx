import { APP } from '../config/constants';
import type { BookingMethod } from '../types';

interface BookingVerificationNoticeProps {
  /** The address the confirmation link was sent to (echoed back by the API). */
  email: string;
  therapistName: string;
  expiresInHours: number;
  bookingMethod?: BookingMethod;
  /** Corrected address when the one entered looks like a typo. */
  suggestedEmail?: string | null;
  onUseSuggestedEmail?: () => void;
  onChangeEmail?: () => void;
  /** Tighter layout for the directory cards. */
  compact?: boolean;
}

/**
 * "Check your email" state after a booking request. Nothing is sent to the
 * therapist until the requester follows the link we emailed and presses
 * Confirm, so this has to say so plainly — and echo the address, because a
 * typo means the link never arrives.
 */
export default function BookingVerificationNotice({
  email,
  therapistName,
  expiresInHours,
  bookingMethod = 'agent_negotiated',
  suggestedEmail,
  onUseSuggestedEmail,
  onChangeEmail,
  compact = false,
}: BookingVerificationNoticeProps) {
  const afterConfirm = bookingMethod === 'direct_link'
    ? `After you confirm, you can pick a time on ${therapistName}'s calendar, and ${APP.COORDINATOR_NAME}, our scheduling assistant, will follow up by email.`
    : `After you confirm, ${APP.COORDINATOR_NAME}, our scheduling assistant, will email you (usually within a few minutes) to find a time that works for you and ${therapistName}.`;

  return (
    <div
      role="status"
      className={`bg-spill-blue-100 border border-spill-blue-200 rounded-xl text-left ${compact ? 'p-4' : 'p-6'}`}
    >
      <h4 className={`font-semibold tracking-[-0.36px] text-black mb-2 ${compact ? 'text-sm' : 'text-lg'}`}>
        Check your email to confirm
      </h4>
      <p className={`${compact ? 'text-xs' : 'text-sm'} text-spill-grey-600`}>
        We&apos;ve sent a link to <strong className="text-black break-all">{email}</strong>. Your request is only
        sent to {therapistName} once you open it and press <strong className="text-black">Confirm</strong>. The
        link works for {expiresInHours} hours.
      </p>
      <p className={`${compact ? 'text-xs' : 'text-sm'} text-spill-grey-600 mt-2`}>{afterConfirm}</p>

      {suggestedEmail && onUseSuggestedEmail && (
        <div className="mt-3 p-3 bg-spill-yellow-100 border border-spill-yellow-200 rounded-lg">
          <p className="text-sm text-black">
            Did you mean <strong className="break-all">{suggestedEmail}</strong>?
          </p>
          <button
            type="button"
            onClick={onUseSuggestedEmail}
            className="mt-2 text-sm font-semibold text-spill-blue-800 hover:underline focus:outline-none focus-visible:ring-2 focus-visible:ring-spill-blue-400 rounded"
          >
            Send the link to {suggestedEmail} instead
          </button>
        </div>
      )}

      <p className={`${compact ? 'text-xs' : 'text-sm'} text-spill-grey-400 mt-3`}>
        Can&apos;t find it? Check your spam folder
        {onChangeEmail ? (
          <>
            , or{' '}
            <button
              type="button"
              onClick={onChangeEmail}
              className="font-medium text-spill-blue-800 underline focus:outline-none focus-visible:ring-2 focus-visible:ring-spill-blue-400 rounded"
            >
              use a different email address
            </button>
          </>
        ) : null}
        . Questions? Email{' '}
        <a href={`mailto:${APP.SUPPORT_EMAIL}`} className="text-spill-blue-800 underline">
          {APP.SUPPORT_EMAIL}
        </a>
        .
      </p>
    </div>
  );
}
