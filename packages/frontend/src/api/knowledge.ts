import type {
  KnowledgeEntry,
  CreateKnowledgeRequest,
  UpdateKnowledgeRequest,
} from '../types';
import { fetchAdminApi, unwrap } from './core';

// Knowledge Base API functions

export async function getKnowledgeEntries(): Promise<KnowledgeEntry[]> {
  const response = await fetchAdminApi<KnowledgeEntry[]>('/admin/knowledge');
  return Array.isArray(response?.data) ? response.data : [];
}

export async function createKnowledgeEntry(
  data: CreateKnowledgeRequest
): Promise<KnowledgeEntry> {
  return unwrap(
    await fetchAdminApi<KnowledgeEntry>('/admin/knowledge', {
      method: 'POST',
      body: JSON.stringify(data),
    }),
    'knowledge entry'
  );
}

export async function updateKnowledgeEntry(
  id: string,
  data: UpdateKnowledgeRequest
): Promise<KnowledgeEntry> {
  return unwrap(
    await fetchAdminApi<KnowledgeEntry>(`/admin/knowledge/${id}`, {
      method: 'PATCH',
      body: JSON.stringify(data),
    }),
    'knowledge entry'
  );
}

export async function deleteKnowledgeEntry(id: string): Promise<void> {
  await fetchAdminApi<void>(`/admin/knowledge/${id}`, {
    method: 'DELETE',
  });
}
