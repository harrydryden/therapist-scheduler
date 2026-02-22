/**
 * Frontend environment variable validation
 * Validates required environment variables at startup
 */

interface EnvConfig {
  apiBaseUrl: string;
  isDevelopment: boolean;
  isProduction: boolean;
}

function validateEnv(): EnvConfig {
  const apiBaseUrl = import.meta.env.VITE_API_BASE_URL || '/api';
  const mode = import.meta.env.MODE;

  const isDevelopment = mode === 'development';
  const isProduction = mode === 'production';

  // Validate API base URL format
  if (apiBaseUrl !== '/api' && !apiBaseUrl.startsWith('http')) {
    console.warn(
      `[Config] VITE_API_BASE_URL should be a full URL or '/api'. Got: ${apiBaseUrl}`
    );
  }

  return {
    apiBaseUrl,
    isDevelopment,
    isProduction,
  };
}

// Validate on import
export const env = validateEnv();

// Re-export for backwards compatibility
export const API_BASE = env.apiBaseUrl;

/**
 * FIX #3: Read admin secret from sessionStorage instead of baking VITE_ADMIN_SECRET
 * into the production JS bundle. The admin login page (or admin home) should call
 * setAdminSecret() to store the secret in sessionStorage after the admin enters it.
 */
const ADMIN_SECRET_KEY = 'admin_secret';

export function getAdminSecret(): string {
  return sessionStorage.getItem(ADMIN_SECRET_KEY) || '';
}

export function setAdminSecret(secret: string): void {
  sessionStorage.setItem(ADMIN_SECRET_KEY, secret);
}

export function clearAdminSecret(): void {
  sessionStorage.removeItem(ADMIN_SECRET_KEY);
}
