import type {
  IngestionPreviewResponse,
  IngestionCreateResponse,
  AdminNotes,
} from '../types';
import { API_BASE, getAdminSecret } from '../config/env';
import { HEADERS, TIMEOUTS } from '../config/constants';
import { fetchWithTimeout, safeParseJson } from './core';

// Admin API functions for therapist ingestion

export async function previewTherapistCV(file: File | null, additionalInfo: string): Promise<IngestionPreviewResponse> {
  const formData = new FormData();
  if (file) {
    formData.append('file', file);
  }
  if (additionalInfo) {
    formData.append('additionalInfo', additionalInfo);
  }

  const response = await fetchWithTimeout(
    `${API_BASE}/ingestion/therapist-cv/preview`,
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
    throw new Error((data.error as string) || 'Failed to preview CV');
  }

  return data.data as IngestionPreviewResponse;
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

  const response = await fetchWithTimeout(
    `${API_BASE}/ingestion/therapist-cv`,
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
    throw new Error((data.error as string) || 'Failed to create therapist');
  }

  return data.data as IngestionCreateResponse;
}
