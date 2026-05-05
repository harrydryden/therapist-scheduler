import { fetchAdminApi, unwrap } from './core';

export interface TherapistListItem {
  id: string;
  odId: string;
  /** Legacy Notion page id; null for therapists ingested after the Notion deprecation. */
  notionId: string | null;
  email: string;
  name: string;
  country: string;
  bio: string | null;
  approach: string[];
  style: string[];
  areasOfFocus: string[];
  profileImage: string | null;
  bookingLink: string | null;
  active: boolean;
  availability: unknown;
  ingestedAt: string | null;
  createdAt: string;
  updatedAt: string;
  appointmentCount: number;
  frozen: boolean;
  uniqueRequestCount: number;
}

export interface TherapistListResponse {
  items: TherapistListItem[];
  pagination: { page: number; limit: number; total: number; totalPages: number };
}

export interface TherapistAppointment {
  id: string;
  userName: string | null;
  userEmail: string;
  status: string;
  confirmedDateTimeParsed: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface TherapistDetail extends Omit<TherapistListItem, 'appointmentCount' | 'frozen' | 'uniqueRequestCount'> {
  bookingStatus: {
    frozen: boolean;
    frozenAt: string | null;
    hasConfirmedBooking: boolean;
    confirmedAt: string | null;
    uniqueRequestCount: number;
    adminAlertAt: string | null;
    adminAlertAcknowledged: boolean;
  } | null;
  appointments: TherapistAppointment[];
}

export interface TherapistFilters {
  search?: string;
  active?: 'true' | 'false' | 'all';
  page?: number;
  limit?: number;
  sortBy?: 'createdAt' | 'name' | 'ingestedAt';
  sortOrder?: 'asc' | 'desc';
}

export interface TherapistUpdate {
  name?: string;
  email?: string;
  bio?: string | null;
  country?: string;
  profileImage?: string | null;
  bookingLink?: string | null;
  active?: boolean;
  approach?: string[];
  style?: string[];
  areasOfFocus?: string[];
  availability?: unknown;
}

function buildQueryString(filters: object): string {
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(filters)) {
    if (value !== undefined && value !== '' && value !== null) {
      params.append(key, String(value));
    }
  }
  const qs = params.toString();
  return qs ? `?${qs}` : '';
}

export async function listAdminTherapists(filters: TherapistFilters = {}): Promise<TherapistListResponse> {
  return unwrap(
    await fetchAdminApi<TherapistListResponse>(`/admin/therapists${buildQueryString(filters)}`),
    'therapists',
  );
}

export async function getAdminTherapist(id: string): Promise<TherapistDetail> {
  return unwrap(await fetchAdminApi<TherapistDetail>(`/admin/therapists/${id}`), 'therapist');
}

export async function updateAdminTherapist(id: string, updates: TherapistUpdate) {
  return unwrap(
    await fetchAdminApi<{ id: string; name: string; email: string; active: boolean }>(
      `/admin/therapists/${id}`,
      { method: 'PATCH', body: JSON.stringify(updates) },
    ),
    'therapist',
  );
}

export async function unfreezeAdminTherapist(id: string) {
  return unwrap(
    await fetchAdminApi<{ unfrozen: boolean }>(`/admin/therapists/${id}/unfreeze`, {
      method: 'POST',
      body: JSON.stringify({}),
    }),
    'unfreeze',
  );
}
