import { useCallback, useState } from 'react';

export type ToastType = 'success' | 'error';

interface ToastProps {
  message: string;
  type?: ToastType;
  onClose: () => void;
}

/**
 * Shared toast notification component.
 * Used by admin pages for transient success/error messages.
 */
export function Toast({ message, type = 'error', onClose }: ToastProps) {
  const colorClass = type === 'success' ? 'bg-green-600' : 'bg-red-600';
  return (
    <div
      className={`fixed bottom-4 right-4 z-50 flex items-center gap-3 px-4 py-3 rounded-lg shadow-lg text-sm font-medium text-white animate-fade-in ${colorClass}`}
    >
      {type === 'error' && (
        <svg className="w-5 h-5 flex-shrink-0" fill="none" stroke="currentColor" viewBox="0 0 24 24">
          <path
            strokeLinecap="round"
            strokeLinejoin="round"
            strokeWidth={2}
            d="M12 9v2m0 4h.01m-6.938 4h13.856c1.54 0 2.502-1.667 1.732-3L13.732 4c-.77-1.333-2.694-1.333-3.464 0L3.34 16c-.77 1.333.192 3 1.732 3z"
          />
        </svg>
      )}
      <span>{message}</span>
      <button
        type="button"
        onClick={onClose}
        aria-label="Dismiss"
        className="ml-2 text-white/80 hover:text-white"
      >
        <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
        </svg>
      </button>
    </div>
  );
}

interface ToastState {
  message: string;
  type: ToastType;
}

/**
 * Hook for managing transient toast notifications with auto-dismiss.
 */
export function useToast(autoDismissMs = 4000) {
  const [toast, setToast] = useState<ToastState | null>(null);

  const dismiss = useCallback(() => setToast(null), []);

  const showToast = useCallback(
    (message: string, type: ToastType = 'success') => {
      setToast({ message, type });
      if (autoDismissMs > 0) {
        setTimeout(() => setToast(null), autoDismissMs);
      }
    },
    [autoDismissMs]
  );

  return { toast, showToast, dismiss };
}
