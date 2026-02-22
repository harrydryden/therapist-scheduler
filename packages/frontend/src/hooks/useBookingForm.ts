import { useState } from 'react';
import { useMutation } from '@tanstack/react-query';
import { submitAppointmentRequest } from '../api/client';
import type { AppointmentRequest } from '../types';

// FIX #38: Shared booking form hook extracted from BookingForm.tsx and TherapistCard.tsx
// to eliminate duplicated firstName, email, mutation, and handleSubmit logic.

interface UseBookingFormOptions {
  therapistNotionId: string;
  therapistName?: string;
  onSuccess?: () => void;
}

export function useBookingForm({ therapistNotionId, therapistName, onSuccess }: UseBookingFormOptions) {
  const [firstName, setFirstName] = useState('');
  const [email, setEmail] = useState('');

  const mutation = useMutation({
    mutationFn: (request: AppointmentRequest) => submitAppointmentRequest(request),
    onSuccess,
  });

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    if (!firstName.trim() || !email.trim()) return;

    mutation.mutate({
      userName: firstName.trim(),
      userEmail: email,
      therapistNotionId,
      therapistName,
    });
  };

  const canSubmit = firstName.trim().length > 0 && email.trim().length > 0 && !mutation.isPending;

  return {
    firstName,
    setFirstName,
    email,
    setEmail,
    mutation,
    handleSubmit,
    canSubmit,
  };
}
