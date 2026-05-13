import { useState } from 'react';
import { useMutation } from '@tanstack/react-query';
import { submitAppointmentRequest } from '../api/client';
import type { AppointmentRequest, BookingMethod } from '../types';

// FIX #38: Shared booking form hook extracted from BookingForm.tsx and TherapistCard.tsx
// to eliminate duplicated firstName, email, mutation, and handleSubmit logic.

// Basic email validation — catches common typos before server round-trip
const EMAIL_REGEX = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

function isValidEmail(email: string): boolean {
  return EMAIL_REGEX.test(email);
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

  const emailValid = isValidEmail(email.trim());

  const submitWithMethod = (bookingMethod: BookingMethod = 'agent_negotiated') => {
    if (!firstName.trim() || !emailValid) return;

    mutation.mutate({
      userName: firstName.trim(),
      userEmail: email.trim(),
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

  const canSubmit = firstName.trim().length > 0 && emailValid && !mutation.isPending;

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
  };
}
