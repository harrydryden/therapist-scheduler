import { useState } from 'react';
import { useMutation, useQueryClient, type UseMutationResult } from '@tanstack/react-query';

/**
 * Generic hook for edit/save/cancel state management on list items.
 *
 * Extracted from the repeated pattern in AdminKnowledgePage (editingEntry)
 * and AdminSettingsPage (editingKey/editValue).
 *
 * Manages:
 * - Which item is currently being edited (by ID)
 * - A mutation that invalidates the given queryKey on success
 * - startEditing / cancelEditing helpers
 */

interface UseEditableItemOptions<TUpdateArgs, TUpdateResult> {
  /** React Query cache key(s) to invalidate after a successful update */
  queryKey: string[];
  /** The async function that performs the update */
  updateFn: (args: TUpdateArgs) => Promise<TUpdateResult>;
  /** Optional callback after a successful save */
  onSuccess?: (data: TUpdateResult) => void;
}

interface UseEditableItemReturn<TUpdateArgs, TUpdateResult> {
  /** The ID of the item currently being edited, or null */
  editingId: string | null;
  /** Begin editing an item by its ID */
  startEditing: (id: string) => void;
  /** Cancel the current edit */
  cancelEditing: () => void;
  /** The underlying mutation — call .mutate(args) to save */
  updateMutation: UseMutationResult<TUpdateResult, Error, TUpdateArgs>;
}

export function useEditableItem<TUpdateArgs, TUpdateResult = unknown>({
  queryKey,
  updateFn,
  onSuccess,
}: UseEditableItemOptions<TUpdateArgs, TUpdateResult>): UseEditableItemReturn<TUpdateArgs, TUpdateResult> {
  const queryClient = useQueryClient();
  const [editingId, setEditingId] = useState<string | null>(null);

  const updateMutation = useMutation({
    mutationFn: updateFn,
    onSuccess: (data) => {
      queryClient.invalidateQueries({ queryKey });
      setEditingId(null);
      onSuccess?.(data);
    },
  });

  const startEditing = (id: string) => {
    setEditingId(id);
  };

  const cancelEditing = () => {
    setEditingId(null);
  };

  return {
    editingId,
    startEditing,
    cancelEditing,
    updateMutation,
  };
}
