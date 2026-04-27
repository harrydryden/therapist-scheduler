import type {
  IngestionPreviewResponse,
  IngestionCreateResponse,
  AdminNotes,
} from '../types';
import { API_BASE, getAdminSecret } from '../config/env';
import { HEADERS, TIMEOUTS } from '../config/constants';
import { ApiError, fetchWithTimeout, safeParseJson } from './core';

// Admin API functions for therapist ingestion
//
// Note: uses fetchWithTimeout directly (not fetchAdminApi) because the body
// is multipart/form-data — we must not set Content-Type: application/json.

async function postMultipart<T>(
  endpoint: string,
  formData: FormData,
  resource: string
): Promise<T> {
  const response = await fetchWithTimeout(
    `${API_BASE}${endpoint}`,
    {
      method: 'POST',
      body: formData,
      headers: {
        [HEADERS.WEBHOOK_SECRET]: getAdminSecret(),
      },
    },
    TIMEOUTS.LONG_MS
  );

  const data = await safeParseJson(response) as Record<string, unknown>;

  if (!response.ok) {
    throw new ApiError(
      (data.error as string) || `Failed to ${resource}`,
      data.code as string | undefined,
      data.details as ApiError['details']
    );
  }

  return data.data as T;
}

export async function previewTherapistCV(file: File | null, additionalInfo: string): Promise<IngestionPreviewResponse> {
  const formData = new FormData();
  if (file) {
    formData.append('file', file);
  }
  if (additionalInfo) {
    formData.append('additionalInfo', additionalInfo);
  }

  return postMultipart<IngestionPreviewResponse>(
    '/ingestion/therapist-cv/preview',
    formData,
    'preview CV'
  );
}

export async function createTherapistFromCV(file: File | null, adminNotes: AdminNotes): Promise<IngestionCreateResponse> {
  const formData = new FormData();
  if (file) {
    formData.append('file', file);
  }

  if (adminNotes.additionalInfo) {
    formData.append('additionalInfo', adminNotes.additionalInfo);
  }
  if (adminNotes.overrideEmail) {
    formData.append('overrideEmail', adminNotes.overrideEmail);
  }
  // Category overrides
  if (adminNotes.overrideApproach) {
    formData.append('overrideApproach', JSON.stringify(adminNotes.overrideApproach));
  }
  if (adminNotes.overrideStyle) {
    formData.append('overrideStyle', JSON.stringify(adminNotes.overrideStyle));
  }
  if (adminNotes.overrideAreasOfFocus) {
    formData.append('overrideAreasOfFocus', JSON.stringify(adminNotes.overrideAreasOfFocus));
  }
  if (adminNotes.overrideAvailability) {
    formData.append('overrideAvailability', JSON.stringify(adminNotes.overrideAvailability));
  }
  if (adminNotes.notes) {
    formData.append('notes', adminNotes.notes);
  }
  if (adminNotes.country) {
    formData.append('country', adminNotes.country);
  }

  return postMultipart<IngestionCreateResponse>(
    '/ingestion/therapist-cv',
    formData,
    'create therapist'
  );
}
