import { useState, useEffect } from 'react';
import { VOUCHER_WORD_LIST } from '@therapist-scheduler/shared';

const SESSION_STORAGE_KEY = 'spill_voucher';

/**
 * Derive the what3words-style display code from a voucher token (client-side).
 * Must match the backend's getDisplayCodeFromToken exactly.
 */
function getDisplayCodeFromToken(token: string): string | null {
  const parts = token.split(':');
  if (parts.length !== 4) return null;

  const signature = parts[3];
  // Decode base64url to bytes
  const binaryStr = atob(signature.replace(/-/g, '+').replace(/_/g, '/'));
  const bytes = new Uint8Array(binaryStr.length);
  for (let i = 0; i < binaryStr.length; i++) {
    bytes[i] = binaryStr.charCodeAt(i);
  }

  const word1 = VOUCHER_WORD_LIST[bytes[0] % VOUCHER_WORD_LIST.length];
  const word2 = VOUCHER_WORD_LIST[bytes[1] % VOUCHER_WORD_LIST.length];
  const word3 = VOUCHER_WORD_LIST[bytes[2] % VOUCHER_WORD_LIST.length];

  return `${word1}-${word2}-${word3}`;
}

/**
 * Check if a voucher token is expired by decoding the timestamp.
 * Returns true if expired, false if valid, null if unable to parse.
 */
function isTokenExpired(token: string, expiryDays: number = 14): boolean | null {
  const parts = token.split(':');
  if (parts.length !== 4) return null;

  const timestamp = parseInt(parts[1], 36);
  if (isNaN(timestamp)) return null;

  const maxAge = expiryDays * 24 * 60 * 60 * 1000;
  return Date.now() - timestamp > maxAge;
}

/**
 * Get the expiry date from a voucher token.
 */
function getExpiresAt(token: string, expiryDays: number = 14): Date | null {
  const parts = token.split(':');
  if (parts.length !== 4) return null;

  const timestamp = parseInt(parts[1], 36);
  if (isNaN(timestamp)) return null;

  return new Date(timestamp + expiryDays * 24 * 60 * 60 * 1000);
}

export interface VoucherState {
  /** The full HMAC token to send to the backend */
  voucherToken: string | null;
  /** The what3words-style display code (e.g., "gentle-river-bloom") */
  displayCode: string | null;
  /** Whether the voucher has expired (client-side check) */
  isExpired: boolean;
  /** When the voucher expires */
  expiresAt: Date | null;
  /** Clear the stored voucher */
  clearVoucher: () => void;
}

/**
 * Hook to capture, store, and expose voucher tokens from email links.
 *
 * On mount:
 * 1. Reads ?voucher= from the URL (if present)
 * 2. Stores in sessionStorage for persistence across page navigations
 * 3. Cleans the URL by removing the voucher param
 *
 * Returns the token, display code, and expiry status.
 */
export function useVoucher(expiryDays: number = 14): VoucherState {
  const [voucherToken, setVoucherToken] = useState<string | null>(() => {
    // Initialize from sessionStorage
    try {
      return sessionStorage.getItem(SESSION_STORAGE_KEY);
    } catch {
      return null;
    }
  });

  useEffect(() => {
    // Check URL for voucher parameter
    const params = new URLSearchParams(window.location.search);
    const urlVoucher = params.get('voucher');

    if (urlVoucher) {
      // Store in sessionStorage
      try {
        sessionStorage.setItem(SESSION_STORAGE_KEY, urlVoucher);
      } catch {
        // sessionStorage unavailable (e.g., private browsing)
      }
      setVoucherToken(urlVoucher);

      // Clean the URL to prevent accidental sharing of voucher links
      params.delete('voucher');
      const newSearch = params.toString();
      const newUrl = `${window.location.pathname}${newSearch ? `?${newSearch}` : ''}${window.location.hash}`;
      window.history.replaceState({}, '', newUrl);
    }
  }, []);

  const displayCode = voucherToken ? getDisplayCodeFromToken(voucherToken) : null;
  const expired = voucherToken ? isTokenExpired(voucherToken, expiryDays) : null;
  const expiresAt = voucherToken ? getExpiresAt(voucherToken, expiryDays) : null;

  const clearVoucher = () => {
    try {
      sessionStorage.removeItem(SESSION_STORAGE_KEY);
    } catch {
      // ignore
    }
    setVoucherToken(null);
  };

  return {
    voucherToken,
    displayCode,
    isExpired: expired === true,
    expiresAt,
    clearVoucher,
  };
}
