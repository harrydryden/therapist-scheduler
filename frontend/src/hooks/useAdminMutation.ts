import { useMutation, useQueryClient, QueryKey } from '@tanstack/react-query';
import { useState, useCallback } from 'react';

interface UseAdminMutationOptions<TData, TVariables, TError = Error> {
  /** Keys to invalidate on success */
  invalidateKeys?: QueryKey[];
  /** Additional success callback */
  onSuccess?: (data: TData, variables: TVariables) => void;
  /** Additional error callback */
  onError?: (error: TError, variables: TVariables) => void;
  /** Reset form state on success (e.g., close modals) */
  resetOnSuccess?: () => void;
}

interface UseAdminMutationReturn<TData, TVariables, TError = Error> {
  /** The underlying mutation object */
  mutation: ReturnType<typeof useMutation<TData, TError, TVariables>>;
  /** Current error message, if any */
  error: string | null;
  /** Clear the error message */
  clearError: () => void;
  /** Whether the mutation is in progress */
  isPending: boolean;
  /** Execute the mutation */
  mutate: (variables: TVariables) => void;
  /** Execute the mutation and return a promise */
  mutateAsync: (variables: TVariables) => Promise<TData>;
}

/**
 * Custom hook for admin mutations with standardized error handling and query invalidation.
 * Reduces boilerplate for common mutation patterns in admin pages.
 *
 * @example
 * ```tsx
 * const { mutate, error, clearError, isPending } = useAdminMutation(
 *   (data) => updateSetting(data.key, data.value),
 *   {
 *     invalidateKeys: [['settings']],
 *     resetOnSuccess: () => setEditingKey(null),
 *   }
 * );
 * ```
 */
export function useAdminMutation<TData, TVariables, TError = Error>(
  mutationFn: (variables: TVariables) => Promise<TData>,
  options: UseAdminMutationOptions<TData, TVariables, TError> = {}
): UseAdminMutationReturn<TData, TVariables, TError> {
  const queryClient = useQueryClient();
  const [error, setError] = useState<string | null>(null);

  const { invalidateKeys = [], onSuccess, onError, resetOnSuccess } = options;

  const mutation = useMutation<TData, TError, TVariables>({
    mutationFn,
    onSuccess: (data, variables) => {
      // Clear any previous error
      setError(null);

      // Invalidate specified query keys
      invalidateKeys.forEach((key) => {
        queryClient.invalidateQueries({ queryKey: key });
      });

      // Call reset function if provided
      resetOnSuccess?.();

      // Call additional success handler
      onSuccess?.(data, variables);
    },
    onError: (err, variables) => {
      // Set error message
      const message =
        err instanceof Error
          ? err.message
          : typeof err === 'string'
            ? err
            : 'An unexpected error occurred';
      setError(message);

      // Call additional error handler
      onError?.(err, variables);
    },
  });

  const clearError = useCallback(() => {
    setError(null);
  }, []);

  return {
    mutation,
    error,
    clearError,
    isPending: mutation.isPending,
    mutate: mutation.mutate,
    mutateAsync: mutation.mutateAsync,
  };
}

/**
 * Specialized hook for admin mutations that operate on a single resource ID
 */
export function useAdminResourceMutation<TData, TError = Error>(
  resourceKey: string,
  mutationFn: (id: string, ...args: unknown[]) => Promise<TData>,
  options: Omit<UseAdminMutationOptions<TData, { id: string }, TError>, 'invalidateKeys'> & {
    /** Additional keys to invalidate beyond the resource */
    additionalInvalidateKeys?: QueryKey[];
  } = {}
) {
  const { additionalInvalidateKeys = [], ...restOptions } = options;

  return useAdminMutation<TData, { id: string; [key: string]: unknown }, TError>(
    ({ id, ...args }) => mutationFn(id, args),
    {
      ...restOptions,
      invalidateKeys: [[resourceKey], ...additionalInvalidateKeys],
    }
  );
}
