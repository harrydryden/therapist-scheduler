import { useState } from 'react';
import { useMutation, useQueryClient, type UseMutationResult } from '@tanstack/react-query';

/**
 * Generic hook for delete-confirmation modal state.
 *
 * Extracted from the repeated pattern in AdminKnowledgePage (deleteConfirmEntry)
 * and AdminSettingsPage (resetConfirmSetting).
 *
 * Manages:
 * - The item pending deletion (shown in the confirmation dialog)
 * - requestDelete / cancelDelete / confirmDelete helpers
 * - A mutation that calls deleteFn and invalidates the given queryKey
 */

interface UseDeleteConfirmationOptions<T extends { id: string }> {
  /** React Query cache key(s) to invalidate after a successful delete */
  queryKey: string[];
  /** The async function that performs the deletion. Receives the item's id. */
  deleteFn: (id: string) => Promise<void>;
  /** Optional callback after a successful delete */
  onSuccess?: () => void;
  /**
   * Optional: extract the identifier to pass to deleteFn.
   * Defaults to `(item) => item.id`.
   * Useful when the delete API expects a key other than `id` (e.g. a setting key).
   */
  getId?: (item: T) => string;
}

interface UseDeleteConfirmationReturn<T> {
  /** The item currently pending deletion, or null */
  pendingDelete: T | null;
  /** Open the confirmation dialog for a given item */
  requestDelete: (item: T) => void;
  /** Dismiss the confirmation dialog without deleting */
  cancelDelete: () => void;
  /** Confirm and execute the delete */
  confirmDelete: () => void;
  /** The underlying mutation for checking isPending, isError, etc. */
  deleteMutation: UseMutationResult<void, Error, string>;
}

export function useDeleteConfirmation<T extends { id: string }>({
  queryKey,
  deleteFn,
  onSuccess,
  getId,
}: UseDeleteConfirmationOptions<T>): UseDeleteConfirmationReturn<T> {
  const queryClient = useQueryClient();
  const [pendingDelete, setPendingDelete] = useState<T | null>(null);

  const deleteMutation = useMutation({
    mutationFn: deleteFn,
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey });
      onSuccess?.();
    },
  });

  const requestDelete = (item: T) => {
    setPendingDelete(item);
  };

  const cancelDelete = () => {
    setPendingDelete(null);
  };

  const confirmDelete = () => {
    if (pendingDelete) {
      const id = getId ? getId(pendingDelete) : pendingDelete.id;
      deleteMutation.mutate(id);
      setPendingDelete(null);
    }
  };

  return {
    pendingDelete,
    requestDelete,
    cancelDelete,
    confirmDelete,
    deleteMutation,
  };
}
