/**
 * Admin Login Component
 *
 * Standalone login form for the admin panel. Extracted from AdminLayout
 * so it can be replaced by the parent ATS app's auth flow.
 *
 * The secret is verified by the auth adapter before the panel opens; the
 * reason for a failed sign-in (wrong secret, lockout with its remaining
 * time, network) or for a session that ended is shown here.
 */

import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { useAuth, formatRetryAfter } from '../context/AuthContext';

/** Seconds left until `lockedUntil`, re-rendering once a second while locked. */
function useSecondsUntil(lockedUntil: number | null): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!lockedUntil) return;
    setNow(Date.now());
    const id = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(id);
  }, [lockedUntil]);
  return lockedUntil ? Math.max(0, Math.ceil((lockedUntil - now) / 1000)) : 0;
}

export default function AdminLogin() {
  const { login, error, clearError } = useAuth();
  const [secretInput, setSecretInput] = useState('');
  const [isSubmitting, setIsSubmitting] = useState(false);

  const lockSecondsLeft = useSecondsUntil(error?.lockedUntil ?? null);
  const isLocked = lockSecondsLeft > 0;
  // Once a lockout has run out, its message would be stale.
  const lockoutExpired = !!error?.lockedUntil && !isLocked;
  const errorMessage = lockoutExpired ? null : error?.message;

  return (
    <div className="min-h-screen bg-slate-50 flex items-center justify-center p-4">
      <div className="bg-white rounded-2xl shadow-lg p-8 max-w-sm w-full">
        <h1 className="text-xl font-bold text-slate-900 mb-2">Admin Login</h1>
        <p className="text-sm text-slate-500 mb-6">
          Enter the admin secret to access the admin panel.
        </p>
        <form
          onSubmit={async (e) => {
            e.preventDefault();
            const secret = secretInput.trim();
            if (!secret || isSubmitting || isLocked) return;
            setIsSubmitting(true);
            try {
              await login(secret);
            } finally {
              setIsSubmitting(false);
            }
          }}
        >
          <label htmlFor="admin-secret" className="block text-sm font-medium text-slate-700 mb-1.5">
            Admin secret
          </label>
          <input
            id="admin-secret"
            type="password"
            autoComplete="current-password"
            value={secretInput}
            onChange={(e) => {
              setSecretInput(e.target.value);
              if (error && !error.lockedUntil) clearError();
            }}
            placeholder="Admin secret"
            aria-invalid={!!errorMessage}
            aria-describedby={errorMessage ? 'admin-login-error' : undefined}
            className="w-full px-4 py-3 border border-slate-200 rounded-lg mb-4 focus:ring-2 focus:ring-spill-blue-800 focus:border-transparent outline-none"
            autoFocus
          />
          {errorMessage && (
            <div
              id="admin-login-error"
              role="alert"
              className="mb-4 px-3 py-2 text-sm text-red-700 bg-red-50 border border-red-200 rounded-lg"
            >
              <p>{errorMessage}</p>
              {isLocked && (
                <p className="mt-1 text-xs text-red-600">
                  You can try again in {formatRetryAfter(lockSecondsLeft)}.
                </p>
              )}
            </div>
          )}
          <button
            type="submit"
            disabled={!secretInput.trim() || isSubmitting || isLocked}
            aria-busy={isSubmitting}
            className="w-full px-4 py-3 bg-spill-blue-800 text-white rounded-lg font-medium hover:bg-spill-blue-900 disabled:opacity-50 transition-colors"
          >
            {isSubmitting ? 'Checking…' : isLocked ? 'Locked — please wait' : 'Enter'}
          </button>
        </form>
        <Link
          to="/"
          className="block mt-4 text-center text-sm text-slate-500 hover:text-slate-700 transition-colors"
        >
          Back to booking site
        </Link>
      </div>
    </div>
  );
}
