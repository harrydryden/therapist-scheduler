import { fetchAdminApi, unwrap } from './core';

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
  maxStrikes: number;
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

export async function getVouchers(filters: VoucherFilters = {}): Promise<VoucherListResponse> {
  return unwrap(
    await fetchAdminApi<VoucherListResponse>(`/admin/vouchers${buildQueryString(filters)}`),
    'vouchers'
  );
}

export async function issueVoucher(data: {
  email: string;
  expiryDays?: number;
  sendEmail?: boolean;
}): Promise<{ email: string; displayCode: string; expiresAt: string; voucherUrl: string; emailSent: boolean }> {
  return unwrap(
    await fetchAdminApi<{ email: string; displayCode: string; expiresAt: string; voucherUrl: string; emailSent: boolean }>(
      '/admin/vouchers/issue',
      { method: 'POST', body: JSON.stringify(data) }
    ),
    'voucher'
  );
}

export async function resetStrikes(email: string): Promise<{ email: string; strikeCount: number; previousStrikes: number }> {
  return unwrap(
    await fetchAdminApi<{ email: string; strikeCount: number; previousStrikes: number }>(
      `/admin/vouchers/${encodeURIComponent(email)}/reset-strikes`,
      { method: 'POST', body: JSON.stringify({}) }
    ),
    'strike reset'
  );
}

export async function resubscribeUser(email: string): Promise<{ email: string; displayCode: string; expiresAt: string; subscriptionUpdated: boolean }> {
  return unwrap(
    await fetchAdminApi<{ email: string; displayCode: string; expiresAt: string; subscriptionUpdated: boolean }>(
      `/admin/vouchers/${encodeURIComponent(email)}/resubscribe`,
      { method: 'POST', body: JSON.stringify({}) }
    ),
    'resubscribe'
  );
}

export async function revokeVoucher(email: string): Promise<{ email: string; revoked: boolean }> {
  return unwrap(
    await fetchAdminApi<{ email: string; revoked: boolean }>(
      `/admin/vouchers/${encodeURIComponent(email)}/revoke`,
      { method: 'POST', body: JSON.stringify({}) }
    ),
    'voucher revocation'
  );
}
