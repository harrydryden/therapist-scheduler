import { useState } from 'react';
import { useMutation } from '@tanstack/react-query';
import { submitAppointmentRequest, ApiError } from '../api/client';
import type {
  AppointmentRequest,
  AppointmentRequestResponse,
  BookingMethod,
  BookingVerificationPendingResponse,
} from '../types';
import { useRetryCountdown } from './useRetryCountdown';

// FIX #38: Shared booking form hook extracted from BookingForm.tsx and TherapistCard.tsx
// to eliminate duplicated firstName, email, mutation, and handleSubmit logic.

// Basic email validation — catches common typos before server round-trip
const EMAIL_REGEX = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

function isValidEmail(email: string): boolean {
  return EMAIL_REGEX.test(email);
}

/**
 * "You can have up to N active requests" copy, from the
 * `general.maxActiveThreadsPerUser` setting. Null when there is no limit
 * (0) or the setting isn't known yet — better no line than a wrong number.
 */
export function activeRequestLimitCopy(maxActive: number | undefined | null): string | null {
  if (!maxActive || maxActive < 1) return null;
  return `You can have up to ${maxActive} active appointment request${maxActive === 1 ? '' : 's'} at a time.`;
}

/** The typo suggestion from a response or a validation error, if any. */
export function suggestedEmailFrom(
  data: AppointmentRequestResponse | undefined,
  error: unknown,
  currentEmail: string,
): string | null {
  const suggestion = data?.verificationRequired
    ? data.suggestedEmail
    : error instanceof ApiError
      ? error.suggestedEmail ?? null
      : null;
  if (!suggestion || suggestion.toLowerCase() === currentEmail.trim().toLowerCase()) return null;
  return suggestion;
}

interface UseBookingFormOptions {
  therapistHandle: string;
  onSuccess?: () => void;
  /** HMAC-signed voucher token from weekly email (optional) */
  voucherToken?: string | null;
}

export function useBookingForm({ therapistHandle, onSuccess, voucherToken }: UseBookingFormOptions) {
  const [firstName, setFirstName] = useState('');
  const [email, setEmail] = useState('');

  const mutation = useMutation({
    mutationFn: (request: AppointmentRequest) => submitAppointmentRequest(request),
    onSuccess,
  });

  const retryInSeconds = useRetryCountdown(mutation.error);
  const emailValid = isValidEmail(email.trim());

  const submitWithMethod = (bookingMethod: BookingMethod = 'agent_negotiated', emailOverride?: string) => {
    const address = (emailOverride ?? email).trim();
    if (!firstName.trim() || !isValidEmail(address)) return;

    mutation.mutate({
      userName: firstName.trim(),
      userEmail: address,
      therapistHandle,
      ...(voucherToken ? { voucherToken } : {}),
      bookingMethod,
    });
  };

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    submitWithMethod('agent_negotiated');
  };

  const handleDirectBooking = () => {
    submitWithMethod('direct_link');
  };

  const canSubmit = firstName.trim().length > 0 && emailValid && !mutation.isPending && retryInSeconds === 0;

  // Method of the request that actually SUCCEEDED (undefined until then).
  // Read from the mutation itself rather than set on click, so a failed
  // "Book now" attempt followed by a successful "Request booking" shows the
  // right success copy.
  const succeededBookingMethod: BookingMethod | undefined = mutation.isSuccess
    ? mutation.variables?.bookingMethod ?? 'agent_negotiated'
    : undefined;

  /** Set while we wait for the requester to confirm by email. */
  const pendingVerification: BookingVerificationPendingResponse | null =
    mutation.isSuccess && mutation.data?.verificationRequired ? mutation.data : null;

  const suggestedEmail = suggestedEmailFrom(mutation.data, mutation.error, email);

  /** Re-submit with the suggested (typo-corrected) address. */
  const applySuggestedEmail = () => {
    if (!suggestedEmail) return;
    setEmail(suggestedEmail);
    submitWithMethod(mutation.variables?.bookingMethod ?? 'agent_negotiated', suggestedEmail);
  };

  /** Back to the form (e.g. to type a different address). */
  const editDetails = () => mutation.reset();

  // Show validation hint only after user has typed something
  const showEmailError = email.trim().length > 0 && !emailValid;

  return {
    firstName,
    setFirstName,
    email,
    setEmail,
    mutation,
    handleSubmit,
    handleDirectBooking,
    canSubmit,
    showEmailError,
    succeededBookingMethod,
    pendingVerification,
    suggestedEmail,
    applySuggestedEmail,
    editDetails,
    retryInSeconds,
  };
}
