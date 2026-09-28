import type {
  Therapist,
  TherapistDetail,
  AppointmentRequest,
  AppointmentRequestResponse,
} from '../types';
import { fetchApi, unwrap } from './core';

export async function getTherapists(): Promise<Therapist[]> {
  const response = await fetchApi<Therapist[]>('/therapists');
  return Array.isArray(response?.data) ? response.data : [];
}

export async function getTherapist(id: string): Promise<TherapistDetail> {
  return unwrap(await fetchApi<TherapistDetail>(`/therapists/${id}`), 'therapist');
}

/**
 * Submit a booking. Without a voucher the backend answers
 * `verificationRequired: true` (check your email to confirm); with a
 * valid voucher for the same address it starts scheduling straight away.
 */
export async function submitAppointmentRequest(request: AppointmentRequest): Promise<AppointmentRequestResponse> {
  return unwrap(
    await fetchApi<AppointmentRequestResponse>(
      '/appointments/request',
      {
        method: 'POST',
        body: JSON.stringify(request),
      }
    ),
    'appointment request'
  );
}
