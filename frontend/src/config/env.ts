/**
 * Frontend environment variable validation
 * Validates required environment variables at startup
 */

interface EnvConfig {
  apiBaseUrl: string;
  adminSecret: string;
  isDevelopment: boolean;
  isProduction: boolean;
}

function validateEnv(): EnvConfig {
  const apiBaseUrl = import.meta.env.VITE_API_BASE_URL || '/api';
  // Support both VITE_ADMIN_SECRET and legacy VITE_WEBHOOK_SECRET
  const adminSecret = import.meta.env.VITE_ADMIN_SECRET || import.meta.env.VITE_WEBHOOK_SECRET || '';
  const mode = import.meta.env.MODE;

  const isDevelopment = mode === 'development';
  const isProduction = mode === 'production';

  // Warn about missing admin secret in development
  if (!adminSecret && isDevelopment) {
    console.warn(
      '[Config] VITE_ADMIN_SECRET is not set. Admin features will not work correctly.'
    );
  }

  // In production, require admin secret
  if (!adminSecret && isProduction) {
    console.error(
      '[Config] CRITICAL: VITE_ADMIN_SECRET is required in production mode.'
    );
  }

  // Validate API base URL format
  if (apiBaseUrl !== '/api' && !apiBaseUrl.startsWith('http')) {
    console.warn(
      `[Config] VITE_API_BASE_URL should be a full URL or '/api'. Got: ${apiBaseUrl}`
    );
  }

  return {
    apiBaseUrl,
    adminSecret,
    isDevelopment,
    isProduction,
  };
}

// Validate on import
export const env = validateEnv();

// Re-export for backwards compatibility
export const API_BASE = env.apiBaseUrl;
export const ADMIN_SECRET = env.adminSecret;
