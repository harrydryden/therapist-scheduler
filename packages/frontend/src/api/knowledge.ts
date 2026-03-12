import type {
  KnowledgeEntry,
  CreateKnowledgeRequest,
  UpdateKnowledgeRequest,
} from '../types';
import { fetchAdminApi } from './core';

// Knowledge Base API functions

export async function getKnowledgeEntries(): Promise<KnowledgeEntry[]> {
  const response = await fetchAdminApi<KnowledgeEntry[]>('/admin/knowledge');
  return Array.isArray(response?.data) ? response.data : [];
}

export async function createKnowledgeEntry(
  data: CreateKnowledgeRequest
): Promise<KnowledgeEntry> {
  const response = await fetchAdminApi<KnowledgeEntry>('/admin/knowledge', {
    method: 'POST',
    body: JSON.stringify(data),
  });
  if (!response.data) {
    throw new Error('Failed to create knowledge entry');
  }
  return response.data;
}

export async function updateKnowledgeEntry(
  id: string,
  data: UpdateKnowledgeRequest
): Promise<KnowledgeEntry> {
  const response = await fetchAdminApi<KnowledgeEntry>(`/admin/knowledge/${id}`, {
    method: 'PUT',
    body: JSON.stringify(data),
  });
  if (!response.data) {
    throw new Error('Failed to update knowledge entry');
  }
  return response.data;
}

export async function deleteKnowledgeEntry(id: string): Promise<void> {
  await fetchAdminApi<void>(`/admin/knowledge/${id}`, {
    method: 'DELETE',
  });
}
