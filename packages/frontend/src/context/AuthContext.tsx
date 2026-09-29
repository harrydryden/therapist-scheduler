/**
 * Auth Context for Admin Module
 *
 * Abstracts the authentication mechanism so the scheduler can run:
 * 1. Standalone — uses sessionStorage-based admin secret (default)
 * 2. As ATS module — parent app provides auth via custom adapter
 *
 * The auth adapter pattern allows the ATS parent to inject its own
 * token/session management without modifying scheduler internals.
 */

import { createContext, useContext, useState, useEffect, useCallback, type ReactNode } from 'react';
import { getAdminSecret, setAdminSecret, clearAdminSecret } from '../config/env';
import {
  AuthError,
  ADMIN_AUTH_FAILED_EVENT,
  verifyAdminSecret,
  type AdminAuthFailureDetail,
} from '../api/core';

// ============================================
// Auth Adapter Interface
// ============================================

export interface AuthAdapter {
  /** Check if user is currently authenticated */
  isAuthenticated(): boolean;
  /** Get the current auth secret/token for API calls */
  getSecret(): string;
  /**
   * Authenticate with credentials. Returns true on success. May instead
   * throw an Error whose message is shown on the login form (an AuthError
   * with status 429 and `retryAfter` is rendered as a lockout).
   */
  login(secret: string): boolean | Promise<boolean>;
  /** Clear authentication state */
  logout(): void;
}

/**
 * Default auth adapter — sessionStorage-based admin secret.
 * Used when running standalone (not embedded in ATS).
 *
 * The secret is checked against the backend before it is stored, so a typo
 * is reported on the login form instead of "logging in" and bouncing back
 * silently on the first data request.
 */
export const defaultAuthAdapter: AuthAdapter = {
  isAuthenticated: () => !!getAdminSecret(),
  getSecret: () => getAdminSecret(),
  login: async (secret: string) => {
    await verifyAdminSecret(secret); // throws AuthError / ApiError on rejection
    setAdminSecret(secret);
    return true;
  },
  logout: () => clearAdminSecret(),
};

// ============================================
// Error presentation
// ============================================

/** A user-facing auth error, plus when a lockout lifts (epoch ms). */
export interface AuthErrorState {
  message: string;
  lockedUntil: number | null;
}

/** "about 5 minutes" / "42 seconds" */
export function formatRetryAfter(seconds: number): string {
  if (seconds < 60) return `${seconds} second${seconds === 1 ? '' : 's'}`;
  const minutes = Math.ceil(seconds / 60);
  return `about ${minutes} minute${minutes === 1 ? '' : 's'}`;
}

function toAuthErrorState(status: number, message: string, retryAfter: number | undefined, context: 'login' | 'session'): AuthErrorState {
  if (status === 429) {
    // With a known Retry-After the login form renders a live countdown
    // from `lockedUntil`, so the message itself doesn't repeat the time.
    return {
      message: 'Too many failed sign-in attempts from this network — admin access is temporarily locked.' +
        (retryAfter ? '' : ' Please try again later.'),
      lockedUntil: retryAfter ? Date.now() + retryAfter * 1000 : null,
    };
  }
  if (status === 401 || status === 403) {
    return {
      message: context === 'login'
        ? 'That admin secret is not correct.'
        : 'Your admin secret was rejected — it may have been changed. Please sign in again.',
      lockedUntil: null,
    };
  }
  return { message: message || 'Sign-in failed. Please try again.', lockedUntil: null };
}

/** Map anything thrown by `adapter.login` to what the login form shows. */
export function describeLoginError(error: unknown): AuthErrorState {
  if (error instanceof AuthError) {
    return toAuthErrorState(error.status, error.message, error.retryAfter, 'login');
  }
  return {
    message: error instanceof Error && error.message ? error.message : 'Sign-in failed. Please try again.',
    lockedUntil: null,
  };
}

// ============================================
// React Context
// ============================================

interface AuthContextValue {
  isAuthenticated: boolean;
  getSecret: () => string;
  /** Resolves true on success; on failure resolves false and sets `error`. */
  login: (secret: string) => Promise<boolean>;
  logout: () => void;
  /** Why the last sign-in failed or the session ended (null when none). */
  error: AuthErrorState | null;
  clearError: () => void;
}

const AuthContext = createContext<AuthContextValue | null>(null);

interface AuthProviderProps {
  children: ReactNode;
  /** Custom auth adapter for ATS integration. Defaults to sessionStorage-based. */
  adapter?: AuthAdapter;
}

export function AuthProvider({ children, adapter = defaultAuthAdapter }: AuthProviderProps) {
  const [isAuthenticated, setIsAuthenticated] = useState(() => adapter.isAuthenticated());
  const [error, setError] = useState<AuthErrorState | null>(null);

  // Listen for auth failures from API layer (401 / lockout on a data request)
  useEffect(() => {
    const handleAuthFailed = (event: Event) => {
      adapter.logout();
      setIsAuthenticated(false);
      const detail = (event as CustomEvent<AdminAuthFailureDetail | undefined>).detail;
      setError(
        detail
          ? toAuthErrorState(detail.status, detail.message, detail.retryAfter, 'session')
          : { message: 'Your admin session ended. Please sign in again.', lockedUntil: null }
      );
    };
    window.addEventListener(ADMIN_AUTH_FAILED_EVENT, handleAuthFailed);
    return () => window.removeEventListener(ADMIN_AUTH_FAILED_EVENT, handleAuthFailed);
  }, [adapter]);

  const login = useCallback(async (secret: string) => {
    setError(null);
    try {
      const result = await adapter.login(secret);
      if (result) {
        setIsAuthenticated(true);
      } else {
        setError({ message: 'Sign-in failed. Please check the admin secret and try again.', lockedUntil: null });
      }
      return result;
    } catch (err) {
      setError(describeLoginError(err));
      return false;
    }
  }, [adapter]);

  const logout = useCallback(() => {
    adapter.logout();
    setIsAuthenticated(false);
    setError(null);
  }, [adapter]);

  const clearError = useCallback(() => setError(null), []);

  return (
    <AuthContext.Provider value={{
      isAuthenticated,
      getSecret: adapter.getSecret,
      login,
      logout,
      error,
      clearError,
    }}>
      {children}
    </AuthContext.Provider>
  );
}

export function useAuth(): AuthContextValue {
  const ctx = useContext(AuthContext);
  if (!ctx) {
    throw new Error('useAuth must be used within an AuthProvider');
  }
  return ctx;
}
