import type {
  AppointmentListItem,
  AppointmentDetail,
  PaginationInfo,
  DashboardStats,
  AppointmentFilters,
  TakeControlRequest,
  SendMessageRequest,
  UpdateAppointmentRequest,
  AdminUser,
  AdminTherapist,
  CreateAdminAppointmentRequest,
  CreateAdminAppointmentResponse,
} from '../types';
import { fetchAdminApi, EMPTY_PAGINATION } from './core';
import { TIMEOUTS } from '../config/constants';

export async function getAppointments(filters: AppointmentFilters = {}): Promise<{
  data: AppointmentListItem[];
  pagination: PaginationInfo;
}> {
  const params = new URLSearchParams();
  Object.entries(filters).forEach(([key, value]) => {
    if (value !== undefined && value !== '') {
      params.append(key, String(value));
    }
  });

  const queryString = params.toString();
  const response = await fetchAdminApi<AppointmentListItem[]>(
    `/admin/dashboard/appointments${queryString ? `?${queryString}` : ''}`
  );

  return {
    data: Array.isArray(response?.data) ? response.data : [],
    pagination: response.pagination || EMPTY_PAGINATION,
  };
}

export async function getAppointmentDetail(id: string): Promise<AppointmentDetail> {
  const response = await fetchAdminApi<AppointmentDetail>(`/admin/dashboard/appointments/${id}`);
  if (!response.data) {
    throw new Error('Appointment not found');
  }
  return response.data;
}

export async function getDashboardStats(): Promise<DashboardStats> {
  const response = await fetchAdminApi<DashboardStats>('/admin/dashboard/stats');
  if (!response.data) {
    throw new Error('Failed to fetch stats');
  }
  return response.data;
}

// Human control API functions

export async function takeControl(
  appointmentId: string,
  data: TakeControlRequest
): Promise<{ humanControlEnabled: boolean; humanControlTakenBy: string; humanControlTakenAt: string }> {
  const response = await fetchAdminApi<{
    humanControlEnabled: boolean;
    humanControlTakenBy: string;
    humanControlTakenAt: string;
  }>(`/admin/dashboard/appointments/${appointmentId}/take-control`, {
    method: 'POST',
    body: JSON.stringify(data),
  });
  if (!response.data) {
    throw new Error('Failed to take control');
  }
  return response.data;
}

export async function releaseControl(
  appointmentId: string
): Promise<{ humanControlEnabled: boolean }> {
  const response = await fetchAdminApi<{ humanControlEnabled: boolean }>(
    `/admin/dashboard/appointments/${appointmentId}/release-control`,
    {
      method: 'POST',
      body: JSON.stringify({}), // Empty body to satisfy Content-Type: application/json
    }
  );
  if (!response.data) {
    throw new Error('Failed to release control');
  }
  return response.data;
}

export async function sendAdminMessage(
  appointmentId: string,
  data: SendMessageRequest
): Promise<{ messageId: string; sentAt: string }> {
  const response = await fetchAdminApi<{ messageId: string; sentAt: string }>(
    `/admin/dashboard/appointments/${appointmentId}/send-message`,
    {
      method: 'POST',
      body: JSON.stringify(data),
    }
  );
  if (!response.data) {
    throw new Error('Failed to send message');
  }
  return response.data;
}

export async function deleteAppointment(
  appointmentId: string,
  data: { adminId: string; reason?: string; forceDeleteConfirmed?: boolean }
): Promise<{ id: string; message: string }> {
  const response = await fetchAdminApi<{ id: string; message: string }>(
    `/admin/dashboard/appointments/${appointmentId}`,
    {
      method: 'DELETE',
      body: JSON.stringify(data),
    }
  );
  if (!response.data) {
    throw new Error('Failed to delete appointment');
  }
  return response.data;
}

export async function updateAppointment(
  appointmentId: string,
  data: UpdateAppointmentRequest
): Promise<{
  id: string;
  status: string;
  confirmedDateTime: string | null;
  confirmedAt: string | null;
  updatedAt: string;
  previousStatus?: string;
  warning?: string;
}> {
  const response = await fetchAdminApi<{
    id: string;
    status: string;
    confirmedDateTime: string | null;
    confirmedAt: string | null;
    updatedAt: string;
    previousStatus?: string;
    warning?: string;
  }>(`/admin/dashboard/appointments/${appointmentId}`, {
    method: 'PATCH',
    body: JSON.stringify(data),
  });
  if (!response.data) {
    throw new Error('Failed to update appointment');
  }
  return response.data;
}

// Thread reprocessing API

export interface ThreadMessagePreview {
  messageId: string;
  from: string;
  subject: string;
  date: string;
  status: 'processed' | 'unprocessed';
  snippet: string;
}

export interface ReprocessPreviewResult {
  appointmentId: string;
  userName: string;
  therapistName: string;
  dryRun: true;
  threads: Array<{ threadId: string; type: string; messages: ThreadMessagePreview[] }>;
  totalMessages: number;
  unprocessedCount: number;
  message: string;
}

export interface ReprocessThreadResult {
  appointmentId: string;
  userName: string;
  therapistName: string;
  threads: Array<{ threadId: string; type: string; cleared: number; reprocessed: number }>;
  totalCleared: number;
  totalReprocessed: number;
  message: string;
}

export async function previewReprocessThread(
  appointmentId: string
): Promise<ReprocessPreviewResult> {
  const response = await fetchAdminApi<ReprocessPreviewResult>(
    `/admin/dashboard/appointments/${appointmentId}/reprocess-thread`,
    {
      method: 'POST',
      body: JSON.stringify({ dryRun: true }),
    },
    TIMEOUTS.LONG_MS
  );
  if (!response.data) {
    throw new Error('Failed to preview thread');
  }
  return response.data;
}

export async function reprocessThread(
  appointmentId: string,
  forceMessageIds?: string[]
): Promise<ReprocessThreadResult> {
  const response = await fetchAdminApi<ReprocessThreadResult>(
    `/admin/dashboard/appointments/${appointmentId}/reprocess-thread`,
    {
      method: 'POST',
      body: JSON.stringify(forceMessageIds ? { forceMessageIds } : {}),
    },
    TIMEOUTS.LONG_MS
  );
  if (!response.data) {
    throw new Error('Failed to reprocess thread');
  }
  return response.data;
}

// Admin Appointments Management API functions

export async function getAdminUsers(): Promise<AdminUser[]> {
  const response = await fetchAdminApi<AdminUser[]>('/admin/appointments/users');
  return Array.isArray(response?.data) ? response.data : [];
}

export async function getAdminTherapists(): Promise<AdminTherapist[]> {
  const response = await fetchAdminApi<AdminTherapist[]>('/admin/appointments/therapists');
  return Array.isArray(response?.data) ? response.data : [];
}

export async function getAllAppointments(filters: {
  status?: string;
  search?: string;
  page?: number;
  limit?: number;
  sortBy?: string;
  sortOrder?: string;
} = {}): Promise<{
  data: AppointmentListItem[];
  pagination: PaginationInfo;
}> {
  const params = new URLSearchParams();
  Object.entries(filters).forEach(([key, value]) => {
    if (value !== undefined && value !== '') {
      params.append(key, String(value));
    }
  });

  const queryString = params.toString();
  const response = await fetchAdminApi<{ items: AppointmentListItem[]; pagination: PaginationInfo }>(
    `/admin/appointments/all${queryString ? `?${queryString}` : ''}`
  );

  return {
    data: Array.isArray(response?.data?.items) ? response.data.items : [],
    pagination: response?.data?.pagination || EMPTY_PAGINATION,
  };
}

export async function updateAdminAppointment(
  appointmentId: string,
  data: { status?: string; confirmedDateTime?: string | null; adminId: string; reason?: string }
): Promise<{
  id: string;
  status: string;
  confirmedDateTime: string | null;
  confirmedDateTimeParsed: string | null;
  confirmedAt: string | null;
  updatedAt: string;
  previousStatus?: string;
  warning?: string;
}> {
  const response = await fetchAdminApi<{
    id: string;
    status: string;
    confirmedDateTime: string | null;
    confirmedDateTimeParsed: string | null;
    confirmedAt: string | null;
    updatedAt: string;
    previousStatus?: string;
    warning?: string;
  }>(`/admin/appointments/${appointmentId}`, {
    method: 'PATCH',
    body: JSON.stringify(data),
  });
  if (!response.data) {
    throw new Error('Failed to update appointment');
  }
  return response.data;
}

export async function createAdminAppointment(
  data: CreateAdminAppointmentRequest
): Promise<CreateAdminAppointmentResponse> {
  const response = await fetchAdminApi<CreateAdminAppointmentResponse>(
    '/admin/appointments/create',
    {
      method: 'POST',
      body: JSON.stringify(data),
    }
  );
  if (!response.data) {
    throw new Error('Failed to create appointment');
  }
  return response.data;
}

export async function actionClosure(
  appointmentId: string,
  action: 'cancel' | 'dismiss'
): Promise<{ success: boolean; action: string }> {
  const response = await fetchAdminApi<{ success: boolean; action: string }>(
    `/admin/dashboard/appointments/${appointmentId}/action-closure`,
    {
      method: 'POST',
      body: JSON.stringify({ action }),
    }
  );
  if (!response.data) {
    throw new Error('Failed to action closure recommendation');
  }
  return response.data;
}
