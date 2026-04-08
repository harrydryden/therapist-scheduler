import type {
  Therapist,
  TherapistDetail,
  AppointmentRequest,
} from '../types';
import { fetchApi, unwrap } from './core';

export async function getTherapists(): Promise<Therapist[]> {
  const response = await fetchApi<Therapist[]>('/therapists');
  return Array.isArray(response?.data) ? response.data : [];
}

export async function getTherapist(id: string): Promise<TherapistDetail> {
  return unwrap(await fetchApi<TherapistDetail>(`/therapists/${id}`), 'therapist');
}

export async function submitAppointmentRequest(request: AppointmentRequest): Promise<{ appointmentRequestId: string }> {
  return unwrap(
    await fetchApi<{ appointmentRequestId: string; status: string; message: string }>(
      '/appointments/request',
      {
        method: 'POST',
        body: JSON.stringify(request),
      }
    ),
    'appointment request'
  );
}
