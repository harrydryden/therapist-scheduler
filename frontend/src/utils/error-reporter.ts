/**
 * Error Reporter
 *
 * Thin abstraction over error monitoring. Currently logs to console,
 * but provides the integration point for Sentry or similar services.
 *
 * When Sentry is installed:
 * 1. npm install @sentry/react
 * 2. Set VITE_SENTRY_DSN in environment
 * 3. Call initErrorReporter() in main.tsx before React renders
 */

import type { ErrorInfo } from 'react';

interface ErrorReporter {
  captureException(error: Error, extra?: Record<string, unknown>): void;
  captureMessage(message: string, level?: 'info' | 'warning' | 'error'): void;
}

// Default reporter: logs to console (always available)
const consoleReporter: ErrorReporter = {
  captureException(error: Error, extra?: Record<string, unknown>): void {
    console.error('[ErrorReporter]', error, extra);
  },
  captureMessage(message: string, level = 'error'): void {
    const logFn = level === 'info' ? console.info : level === 'warning' ? console.warn : console.error;
    logFn('[ErrorReporter]', message);
  },
};

let activeReporter: ErrorReporter = consoleReporter;

/**
 * Initialize error reporting with Sentry (or another service).
 * Call this in main.tsx before rendering the app.
 *
 * @example
 * // In main.tsx:
 * import { initErrorReporter } from './utils/error-reporter';
 * initErrorReporter(); // reads VITE_SENTRY_DSN from env
 */
export async function initErrorReporter(): Promise<void> {
  const dsn = import.meta.env.VITE_SENTRY_DSN;

  if (!dsn) {
    // No DSN configured — use console reporter (no-op in terms of external services)
    return;
  }

  try {
    // Dynamic import so Sentry is only loaded when configured
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const Sentry: any = await import('@sentry/react' as string);
    Sentry.init({
      dsn,
      environment: import.meta.env.MODE,
      // Only send errors in production by default
      enabled: import.meta.env.PROD,
    });

    activeReporter = {
      captureException(error: Error, extra?: Record<string, unknown>): void {
        Sentry.captureException(error, { extra });
      },
      captureMessage(message: string, level = 'error'): void {
        Sentry.captureMessage(message, level);
      },
    };
  } catch {
    // @sentry/react not installed — fall back to console
    console.warn('[ErrorReporter] VITE_SENTRY_DSN is set but @sentry/react is not installed. Run: npm install @sentry/react');
  }
}

/**
 * Report an error caught by React ErrorBoundary
 */
export function reportError(error: Error, errorInfo?: ErrorInfo): void {
  activeReporter.captureException(error, {
    componentStack: errorInfo?.componentStack,
  });
}

/**
 * Report a message (non-exception) for monitoring
 */
export function reportMessage(message: string, level?: 'info' | 'warning' | 'error'): void {
  activeReporter.captureMessage(message, level);
}
