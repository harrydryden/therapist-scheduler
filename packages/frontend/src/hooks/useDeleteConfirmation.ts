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
 *
 * UX reliability: the confirmation dialog is kept open while the mutation is
 * in flight so the user sees the loading state, and it only closes on success.
 * On failure, the dialog remains open and `deleteMutation.error` can be shown
 * in context. Previously the dialog closed immediately on click, hiding all
 * feedback and making it look like nothing happened.
 */

interface UseDeleteConfirmationOptions<T extends { id: string }> {
  /** React Query cache key(s) to invalidate after a successful delete */
  queryKey: string[];
  /** The async function that performs the deletion. Receives the item's id. */
  deleteFn: (id: string) => Promise<void>;
  /** Optional callback after a successful delete */
  onSuccess?: () => void;
  /** Optional callback when the delete fails */
  onError?: (error: Error) => void;
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
  /** Confirm and execute the delete. Dialog stays open until the mutation finishes. */
  confirmDelete: () => void;
  /** The underlying mutation for checking isPending, isError, etc. */
  deleteMutation: UseMutationResult<void, Error, string>;
}

export function useDeleteConfirmation<T extends { id: string }>({
  queryKey,
  deleteFn,
  onSuccess,
  onError,
  getId,
}: UseDeleteConfirmationOptions<T>): UseDeleteConfirmationReturn<T> {
  const queryClient = useQueryClient();
  const [pendingDelete, setPendingDelete] = useState<T | null>(null);

  const deleteMutation = useMutation({
    mutationFn: deleteFn,
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey });
      // Only close the dialog once the delete has actually succeeded so the
      // user sees the transition rather than a dialog that vanishes silently.
      setPendingDelete(null);
      onSuccess?.();
    },
    onError: (error) => {
      // Keep the dialog open so the error can be shown in context and the
      // user can retry or cancel.
      onError?.(error);
    },
  });

  const requestDelete = (item: T) => {
    // Reset any previous error state when opening a fresh dialog.
    deleteMutation.reset();
    setPendingDelete(item);
  };

  const cancelDelete = () => {
    // Ignore cancel clicks while a delete is in flight — the user has already
    // confirmed and letting them cancel mid-request would leave the UI in an
    // inconsistent state (mutation resolved but dialog already closed).
    if (deleteMutation.isPending) return;
    deleteMutation.reset();
    setPendingDelete(null);
  };

  const confirmDelete = () => {
    if (!pendingDelete || deleteMutation.isPending) return;
    const id = getId ? getId(pendingDelete) : pendingDelete.id;
    deleteMutation.mutate(id);
  };

  return {
    pendingDelete,
    requestDelete,
    cancelDelete,
    confirmDelete,
    deleteMutation,
  };
}
