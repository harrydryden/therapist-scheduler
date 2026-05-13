import type {
  SettingsResponse,
  UpdateSettingRequest,
} from '../types';
import { fetchApi, fetchAdminApi, unwrap } from './core';

// System Settings API functions

export async function getSettings(): Promise<SettingsResponse> {
  return unwrap(await fetchAdminApi<SettingsResponse>('/admin/settings'), 'settings');
}

export async function updateSetting(
  key: string,
  data: UpdateSettingRequest
): Promise<{ key: string; value: string | number | boolean; updatedAt: string }> {
  return unwrap(
    await fetchAdminApi<{ key: string; value: string | number | boolean; updatedAt: string }>(
      `/admin/settings/${key}`,
      {
        method: 'PUT',
        body: JSON.stringify(data),
      }
    ),
    'setting update'
  );
}

export async function resetSetting(
  key: string
): Promise<{ key: string; value: string | number | boolean; isDefault: boolean }> {
  return unwrap(
    await fetchAdminApi<{ key: string; value: string | number | boolean; isDefault: boolean }>(
      `/admin/settings/${key}/reset`,
      { method: 'POST' }
    ),
    'setting reset'
  );
}

// Public Frontend Settings (no auth required)
export interface FrontendSettings {
  'frontend.therapistPageIntro': string;
  'voucher.enabled': boolean;
  'voucher.required': boolean;
  'voucher.expiryDays': number;
}

export async function getFrontendSettings(): Promise<FrontendSettings> {
  return unwrap(await fetchApi<FrontendSettings>('/settings/frontend'), 'frontend settings');
}
