import type {
  SettingsResponse,
  SystemSetting,
  UpdateSettingRequest,
  BulkUpdateSettingsRequest,
} from '../types';
import { fetchApi, fetchAdminApi } from './core';

// System Settings API functions

export async function getSettings(): Promise<SettingsResponse> {
  const response = await fetchAdminApi<SettingsResponse>('/admin/settings');
  if (!response.data) {
    throw new Error('Failed to fetch settings');
  }
  return response.data;
}

export async function getSetting(key: string): Promise<SystemSetting> {
  const response = await fetchAdminApi<SystemSetting>(`/admin/settings/${key}`);
  if (!response.data) {
    throw new Error('Failed to fetch setting');
  }
  return response.data;
}

export async function updateSetting(
  key: string,
  data: UpdateSettingRequest
): Promise<{ key: string; value: string | number | boolean; updatedAt: string }> {
  const response = await fetchAdminApi<{ key: string; value: string | number | boolean; updatedAt: string }>(
    `/admin/settings/${key}`,
    {
      method: 'PUT',
      body: JSON.stringify(data),
    }
  );
  if (!response.data) {
    throw new Error('Failed to update setting');
  }
  return response.data;
}

export async function bulkUpdateSettings(
  data: BulkUpdateSettingsRequest
): Promise<{ updated: number }> {
  const response = await fetchAdminApi<{ updated: number }>('/admin/settings', {
    method: 'PUT',
    body: JSON.stringify(data),
  });
  if (!response.data) {
    throw new Error('Failed to update settings');
  }
  return response.data;
}

export async function resetSetting(
  key: string
): Promise<{ key: string; value: string | number | boolean; isDefault: boolean }> {
  const response = await fetchAdminApi<{ key: string; value: string | number | boolean; isDefault: boolean }>(
    `/admin/settings/${key}/reset`,
    {
      method: 'POST',
    }
  );
  if (!response.data) {
    throw new Error('Failed to reset setting');
  }
  return response.data;
}

// Public Frontend Settings (no auth required)
export interface FrontendSettings {
  'frontend.therapistPageIntro': string;
}

export async function getFrontendSettings(): Promise<FrontendSettings> {
  const response = await fetchApi<FrontendSettings>('/settings/frontend');
  if (!response.data) {
    throw new Error('Failed to fetch frontend settings');
  }
  return response.data;
}
