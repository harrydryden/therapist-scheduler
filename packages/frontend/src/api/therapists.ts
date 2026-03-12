import type {
  Therapist,
  TherapistDetail,
  AppointmentRequest,
} from '../types';
import { fetchApi } from './core';

export async function getTherapists(): Promise<Therapist[]> {
  const response = await fetchApi<Therapist[]>('/therapists');
  return Array.isArray(response?.data) ? response.data : [];
}

export async function getTherapist(id: string): Promise<TherapistDetail> {
  const response = await fetchApi<TherapistDetail>(`/therapists/${id}`);
  if (!response.data) {
    throw new Error('Therapist not found');
  }
  return response.data;
}

export async function submitAppointmentRequest(request: AppointmentRequest): Promise<{ appointmentRequestId: string }> {
  const response = await fetchApi<{ appointmentRequestId: string; status: string; message: string }>(
    '/appointments/request',
    {
      method: 'POST',
      body: JSON.stringify(request),
    }
  );

  if (!response.data) {
    throw new Error('Failed to submit appointment request');
  }

  return response.data;
}
