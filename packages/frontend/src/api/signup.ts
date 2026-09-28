import { fetchApi, unwrap } from './core';
import type { CountryCode } from '@therapist-scheduler/shared';

export interface SignupRequest {
  name: string;
  email: string;
  priorTherapy: boolean;
  acknowledgedRealSession: true;
  agreedToFeedback: true;
  /** Present when the user is signing up via an invitation link (?invite=). */
  invitationToken?: string;
  /** Country code — drives recipient timezone for every email this user receives. */
  country: CountryCode;
  /** Explicit opt-in to the weekly availability email (unticked by default). */
  weeklyEmails: boolean;
}

export interface SignupResponse {
  id: string;
  odId: string;
  email: string;
  name: string | null;
  /** Whether the address is subscribed to the weekly email after this signup. */
  weeklyEmails?: boolean;
}

export async function submitSignup(request: SignupRequest): Promise<SignupResponse> {
  return unwrap(
    await fetchApi<SignupResponse>('/signup', {
      method: 'POST',
      body: JSON.stringify(request),
    }),
    'signup',
  );
}
