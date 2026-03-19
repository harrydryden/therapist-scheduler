import { fetchAdminApi } from './core';

export interface VoucherRecord {
  email: string;
  displayCode: string | null;
  status: 'active' | 'expired' | 'used' | 'unsubscribed';
  strikeCount: number;
  maxStrikes: number;
  lastVoucherSentAt: string | null;
  lastVoucherUsedAt: string | null;
  expiresAt: string | null;
  reminderSentAt: string | null;
  unsubscribedAt: string | null;
  createdAt: string;
}

export interface VoucherSummary {
  total: number;
  active: number;
  used: number;
  atRisk: number;
  unsubscribed: number;
}

export interface VoucherListResponse {
  items: VoucherRecord[];
  summary: VoucherSummary;
  pagination: {
    page: number;
    limit: number;
    total: number;
    totalPages: number;
  };
}

export interface VoucherFilters {
  status?: string;
  search?: string;
  minStrikes?: number;
  page?: number;
  limit?: number;
  sortBy?: string;
  sortOrder?: string;
}

export async function getVouchers(filters: VoucherFilters = {}): Promise<VoucherListResponse> {
  const params = new URLSearchParams();
  Object.entries(filters).forEach(([key, value]) => {
    if (value !== undefined && value !== '') {
      params.append(key, String(value));
    }
  });

  const queryString = params.toString();
  const response = await fetchAdminApi<VoucherListResponse>(
    `/admin/vouchers${queryString ? `?${queryString}` : ''}`
  );

  return response.data!;
}

export async function getVoucher(email: string): Promise<VoucherRecord> {
  const response = await fetchAdminApi<VoucherRecord>(
    `/admin/vouchers/${encodeURIComponent(email)}`
  );
  return response.data!;
}

export async function issueVoucher(data: {
  email: string;
  expiryDays?: number;
  sendEmail?: boolean;
}): Promise<{ email: string; displayCode: string; expiresAt: string; emailSent: boolean }> {
  const response = await fetchAdminApi<{ email: string; displayCode: string; expiresAt: string; emailSent: boolean }>(
    '/admin/vouchers/issue',
    { method: 'POST', body: JSON.stringify(data) }
  );
  return response.data!;
}

export async function resetStrikes(email: string): Promise<{ email: string; strikeCount: number; previousStrikes: number }> {
  const response = await fetchAdminApi<{ email: string; strikeCount: number; previousStrikes: number }>(
    `/admin/vouchers/${encodeURIComponent(email)}/reset-strikes`,
    { method: 'POST', body: JSON.stringify({}) }
  );
  return response.data!;
}

export async function resubscribeUser(email: string): Promise<{ email: string; displayCode: string; expiresAt: string; notionUpdated: boolean }> {
  const response = await fetchAdminApi<{ email: string; displayCode: string; expiresAt: string; notionUpdated: boolean }>(
    `/admin/vouchers/${encodeURIComponent(email)}/resubscribe`,
    { method: 'POST', body: JSON.stringify({}) }
  );
  return response.data!;
}

export async function revokeVoucher(email: string): Promise<{ email: string; revoked: boolean }> {
  const response = await fetchAdminApi<{ email: string; revoked: boolean }>(
    `/admin/vouchers/${encodeURIComponent(email)}/revoke`,
    { method: 'POST', body: JSON.stringify({}) }
  );
  return response.data!;
}
