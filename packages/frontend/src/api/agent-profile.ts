/**
 * Admin API client for the Layer C agent profile.
 *
 * Backend routes live in admin-users.routes.ts and admin-therapists.routes.ts.
 * Keeping user and therapist as parallel functions (not collapsed into a
 * single generic helper keyed on an entity string) mirrors the backend's
 * deliberate split — per-entity scoping is the privacy contract, and a
 * unified front-door would invite a future refactor to fold them together.
 */

import { fetchAdminApi, unwrap } from './core';

export type ProfileCategory = 'communication' | 'scheduling' | 'context';

export interface ProfileNote {
  id: string;
  category: ProfileCategory;
  text: string;
  source: 'admin' | 'distilled';
  appointmentId?: string;
  createdAt: string;
}

export interface AgentProfile {
  notes: ProfileNote[];
  updatedAt: string;
  version: 'v1';
}

export interface AddProfileNoteResult {
  added: boolean;
  profile: AgentProfile;
  noteId: string;
}

// ─── User profile ──────────────────────────────────────────────────────────

export async function getUserAgentProfile(userId: string): Promise<AgentProfile> {
  return unwrap(
    await fetchAdminApi<AgentProfile>(`/admin/users/${userId}/agent-profile`),
    'agent profile',
  );
}

export async function addUserAgentProfileNote(
  userId: string,
  note: { category: ProfileCategory; text: string },
): Promise<AddProfileNoteResult> {
  return unwrap(
    await fetchAdminApi<AddProfileNoteResult>(
      `/admin/users/${userId}/agent-profile/notes`,
      { method: 'POST', body: JSON.stringify(note) },
    ),
    'agent profile note',
  );
}

export async function clearUserAgentProfile(userId: string): Promise<{ cleared: boolean }> {
  return unwrap(
    await fetchAdminApi<{ cleared: boolean }>(
      `/admin/users/${userId}/agent-profile`,
      { method: 'DELETE' },
    ),
    'agent profile',
  );
}

// ─── Therapist profile ─────────────────────────────────────────────────────

export async function getTherapistAgentProfile(therapistId: string): Promise<AgentProfile> {
  return unwrap(
    await fetchAdminApi<AgentProfile>(`/admin/therapists/${therapistId}/agent-profile`),
    'agent profile',
  );
}

export async function addTherapistAgentProfileNote(
  therapistId: string,
  note: { category: ProfileCategory; text: string },
): Promise<AddProfileNoteResult> {
  return unwrap(
    await fetchAdminApi<AddProfileNoteResult>(
      `/admin/therapists/${therapistId}/agent-profile/notes`,
      { method: 'POST', body: JSON.stringify(note) },
    ),
    'agent profile note',
  );
}

export async function clearTherapistAgentProfile(therapistId: string): Promise<{ cleared: boolean }> {
  return unwrap(
    await fetchAdminApi<{ cleared: boolean }>(
      `/admin/therapists/${therapistId}/agent-profile`,
      { method: 'DELETE' },
    ),
    'agent profile',
  );
}
