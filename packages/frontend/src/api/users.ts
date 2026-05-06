import { fetchAdminApi, unwrap } from './core';

export interface UserListItem {
  id: string;
  odId: string;
  email: string;
  name: string | null;
  country: string;
  subscribed: boolean;
  priorTherapy: boolean | null;
  acknowledgedRealSession: boolean | null;
  agreedToFeedback: boolean | null;
  consentGivenAt: string | null;
  signupSource: 'signup_form' | 'invitation' | 'booking' | 'admin' | 'legacy' | null;
  appointmentCount: number;
  createdAt: string;
  updatedAt: string;
}

export interface UserListResponse {
  items: UserListItem[];
  pagination: { page: number; limit: number; total: number; totalPages: number };
}

export interface UserAppointment {
  id: string;
  therapistName: string;
  therapistEmail: string;
  status: string;
  confirmedDateTimeParsed: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface UserDetail extends Omit<UserListItem, 'appointmentCount'> {
  voucher: {
    strikeCount: number;
    lastVoucherSentAt: string | null;
    lastVoucherUsedAt: string | null;
    unsubscribedAt: string | null;
  } | null;
  appointments: UserAppointment[];
}

export interface UserFilters {
  search?: string;
  subscribed?: 'true' | 'false' | 'all';
  signupSource?: 'signup_form' | 'invitation' | 'booking' | 'admin' | 'legacy' | 'all';
  page?: number;
  limit?: number;
  sortBy?: 'createdAt' | 'email' | 'name' | 'consentGivenAt';
  sortOrder?: 'asc' | 'desc';
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

export async function listUsers(filters: UserFilters = {}): Promise<UserListResponse> {
  return unwrap(
    await fetchAdminApi<UserListResponse>(`/admin/users${buildQueryString(filters)}`),
    'users',
  );
}

export async function getUser(id: string): Promise<UserDetail> {
  return unwrap(await fetchAdminApi<UserDetail>(`/admin/users/${id}`), 'user');
}

export interface UserUpdate {
  name?: string;
  country?: string;
  subscribed?: boolean;
}

export async function updateUser(id: string, updates: UserUpdate) {
  return unwrap(
    await fetchAdminApi<{ id: string; email: string; name: string | null; country: string; subscribed: boolean }>(
      `/admin/users/${id}`,
      { method: 'PATCH', body: JSON.stringify(updates) },
    ),
    'user',
  );
}
