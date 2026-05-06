import { fetchApi, fetchAdminApi, unwrap } from './core';

export type InvitationStatus = 'pending' | 'accepted' | 'revoked' | 'expired';

export interface Invitation {
  id: string;
  email: string;
  name: string | null;
  invitedBy: string;
  status: InvitationStatus;
  createdAt: string;
  expiresAt: string;
  acceptedAt: string | null;
  acceptedUserId: string | null;
  revokedAt: string | null;
  lastSentAt: string;
  sendCount: number;
}

export interface InvitationListResponse {
  items: Invitation[];
  pagination: { page: number; limit: number; total: number; totalPages: number };
  summary: {
    total: number;
    pending: number;
    accepted: number;
    revoked: number;
    expired: number;
  };
}

export interface InvitationFilters {
  status?: InvitationStatus | 'all';
  search?: string;
  page?: number;
  limit?: number;
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

export async function listInvitations(filters: InvitationFilters = {}): Promise<InvitationListResponse> {
  return unwrap(
    await fetchAdminApi<InvitationListResponse>(`/admin/invitations${buildQueryString(filters)}`),
    'invitations',
  );
}

export interface CreateInvitationResponse {
  invitation: Invitation;
  invitationUrl: string;
  emailSent: boolean;
}

export interface CreateInvitationParams {
  email: string;
  name?: string;
  invitedBy?: string;
  expiryDays?: number;
  sendEmail?: boolean;
}

export async function createInvitation(params: CreateInvitationParams): Promise<CreateInvitationResponse> {
  return unwrap(
    await fetchAdminApi<CreateInvitationResponse>('/admin/invitations', {
      method: 'POST',
      body: JSON.stringify(params),
    }),
    'invitation',
  );
}

export async function revokeInvitation(id: string): Promise<Invitation> {
  return unwrap(
    await fetchAdminApi<Invitation>(`/admin/invitations/${id}/revoke`, {
      method: 'POST',
      body: JSON.stringify({}),
    }),
    'invitation',
  );
}

export async function resendInvitation(id: string): Promise<{ invitation: Invitation; emailSent: boolean }> {
  return unwrap(
    await fetchAdminApi<{ invitation: Invitation; emailSent: boolean }>(
      `/admin/invitations/${id}/resend`,
      { method: 'POST', body: JSON.stringify({}) },
    ),
    'invitation',
  );
}

// Public lookup for the signup page when ?invite= is present in the URL.
export interface InvitationLookup {
  email: string;
  name: string | null;
  status: InvitationStatus;
  redeemable: boolean;
  expiresAt: string;
}

export async function lookupInvitation(token: string): Promise<InvitationLookup | null> {
  try {
    return unwrap(
      await fetchApi<InvitationLookup>(`/signup/invitation/${encodeURIComponent(token)}`),
      'invitation',
    );
  } catch {
    return null;
  }
}
