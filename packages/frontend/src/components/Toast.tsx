import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from 'react';

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
      role="status"
      aria-live="polite"
      className={`fixed bottom-4 right-4 z-50 flex items-center gap-3 px-4 py-3 rounded-lg shadow-lg text-sm font-medium text-white animate-fade-in ${colorClass}`}
    >
      {type === 'error' && (
        <svg className="w-5 h-5 flex-shrink-0" fill="none" stroke="currentColor" viewBox="0 0 24 24" aria-hidden="true">
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
        <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24" aria-hidden="true">
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

const DEFAULT_AUTO_DISMISS_MS = 4000;

/**
 * Internal hook implementation — tracks the auto-dismiss timeout in a ref so
 * (a) it's cancelled on unmount to avoid setState-on-unmounted warnings, and
 * (b) consecutive toasts don't race: a new toast cancels the pending dismiss
 *     timer, so the previous timer never fires against the new toast.
 */
function useToastState(autoDismissMs = DEFAULT_AUTO_DISMISS_MS) {
  const [toast, setToast] = useState<ToastState | null>(null);
  const timeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const clearTimer = useCallback(() => {
    if (timeoutRef.current) {
      clearTimeout(timeoutRef.current);
      timeoutRef.current = null;
    }
  }, []);

  const dismiss = useCallback(() => {
    clearTimer();
    setToast(null);
  }, [clearTimer]);

  const showToast = useCallback(
    (message: string, type: ToastType = 'success') => {
      clearTimer();
      setToast({ message, type });
      if (autoDismissMs > 0) {
        timeoutRef.current = setTimeout(() => {
          timeoutRef.current = null;
          setToast(null);
        }, autoDismissMs);
      }
    },
    [autoDismissMs, clearTimer]
  );

  // Cancel any pending timer on unmount to prevent memory leaks and
  // setState-on-unmounted warnings.
  useEffect(() => clearTimer, [clearTimer]);

  return { toast, showToast, dismiss };
}

/**
 * Standalone toast hook — each component gets its own toast state.
 * Prefer `useToastContext` via `<ToastProvider>` when you want shared state
 * across a subtree.
 */
export function useToast(autoDismissMs = DEFAULT_AUTO_DISMISS_MS) {
  return useToastState(autoDismissMs);
}

// ============================================================================
// Toast Context Provider
//
// App-wide toast provider so any descendant can call `showToast()` without
// wiring state up through its parents. The provider renders a single Toast
// element, guaranteeing consistent positioning and no duplicate toasts.
// ============================================================================

interface ToastContextValue {
  showToast: (message: string, type?: ToastType) => void;
  dismiss: () => void;
}

const ToastContext = createContext<ToastContextValue | null>(null);

interface ToastProviderProps {
  children: ReactNode;
  autoDismissMs?: number;
}

export function ToastProvider({ children, autoDismissMs = DEFAULT_AUTO_DISMISS_MS }: ToastProviderProps) {
  const { toast, showToast, dismiss } = useToastState(autoDismissMs);

  const value = useMemo(() => ({ showToast, dismiss }), [showToast, dismiss]);

  return (
    <ToastContext.Provider value={value}>
      {children}
      {toast && <Toast message={toast.message} type={toast.type} onClose={dismiss} />}
    </ToastContext.Provider>
  );
}

/**
 * Access the app-wide toast from a descendant of `<ToastProvider>`.
 * Throws if called outside a provider so bugs are caught immediately.
 */
export function useToastContext(): ToastContextValue {
  const ctx = useContext(ToastContext);
  if (!ctx) {
    throw new Error('useToastContext must be used within a <ToastProvider>');
  }
  return ctx;
}
