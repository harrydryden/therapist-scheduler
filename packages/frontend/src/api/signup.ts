import { fetchApi, unwrap } from './core';

export interface SignupRequest {
  name: string;
  email: string;
  priorTherapy: boolean;
  acknowledgedRealSession: true;
  agreedToFeedback: true;
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
