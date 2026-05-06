import { fetchApi, unwrap } from './core';

export interface SignupRequest {
  name: string;
  email: string;
  priorTherapy: boolean;
  acknowledgedRealSession: true;
  agreedToFeedback: true;
  /** Present when the user is signing up via an invitation link (?invite=). */
  invitationToken?: string;
}

export interface SignupResponse {
  id: string;
  odId: string;
  email: string;
  name: string | null;
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
