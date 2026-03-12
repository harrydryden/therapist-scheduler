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

// ============================================
// Auth Adapter Interface
// ============================================

export interface AuthAdapter {
  /** Check if user is currently authenticated */
  isAuthenticated(): boolean;
  /** Get the current auth secret/token for API calls */
  getSecret(): string;
  /** Authenticate with credentials. Returns true on success. */
  login(secret: string): boolean | Promise<boolean>;
  /** Clear authentication state */
  logout(): void;
}

/**
 * Default auth adapter — sessionStorage-based admin secret.
 * Used when running standalone (not embedded in ATS).
 */
export const defaultAuthAdapter: AuthAdapter = {
  isAuthenticated: () => !!getAdminSecret(),
  getSecret: () => getAdminSecret(),
  login: (secret: string) => {
    setAdminSecret(secret);
    return true;
  },
  logout: () => clearAdminSecret(),
};

// ============================================
// React Context
// ============================================

interface AuthContextValue {
  isAuthenticated: boolean;
  getSecret: () => string;
  login: (secret: string) => Promise<boolean>;
  logout: () => void;
}

const AuthContext = createContext<AuthContextValue | null>(null);

interface AuthProviderProps {
  children: ReactNode;
  /** Custom auth adapter for ATS integration. Defaults to sessionStorage-based. */
  adapter?: AuthAdapter;
}

export function AuthProvider({ children, adapter = defaultAuthAdapter }: AuthProviderProps) {
  const [isAuthenticated, setIsAuthenticated] = useState(() => adapter.isAuthenticated());

  // Listen for auth failures from API layer
  useEffect(() => {
    const handleAuthFailed = () => {
      adapter.logout();
      setIsAuthenticated(false);
    };
    window.addEventListener('admin-auth-failed', handleAuthFailed);
    return () => window.removeEventListener('admin-auth-failed', handleAuthFailed);
  }, [adapter]);

  const login = useCallback(async (secret: string) => {
    const result = await adapter.login(secret);
    if (result) {
      setIsAuthenticated(true);
    }
    return result;
  }, [adapter]);

  const logout = useCallback(() => {
    adapter.logout();
    setIsAuthenticated(false);
  }, [adapter]);

  return (
    <AuthContext.Provider value={{
      isAuthenticated,
      getSecret: adapter.getSecret,
      login,
      logout,
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
