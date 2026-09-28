/**
 * Voucher token decoding must never throw: it runs during render, and the
 * token is restored from sessionStorage on every load, so one malformed
 * link (truncated by an email client, stray `%`) used to crash the public
 * site until the tab was closed.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { VOUCHER_WORD_LIST } from '@therapist-scheduler/shared';
import {
  getDisplayCodeFromToken,
  isUsableVoucherToken,
  readStoredVoucherToken,
} from '../useVoucher';

const STORAGE_KEY = 'spill_voucher';

function toBase64Url(bytes: number[]): string {
  return btoa(String.fromCharCode(...bytes)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

// Same shape the backend issues: version:timestamp36:payload:signature(base64url)
const signature = toBase64Url([0, 1, 2, 250, 251, 252, 253, 254, 255, 9, 8, 7]);
const VALID_TOKEN = `v1:${Date.now().toString(36)}:dGVzdEBleGFtcGxlLmNvbQ:${signature}`;

function memoryStorage(initial: Record<string, string> = {}): Storage {
  const store = new Map(Object.entries(initial));
  return {
    get length() { return store.size; },
    clear: () => store.clear(),
    getItem: (k: string) => (store.has(k) ? store.get(k)! : null),
    key: (i: number) => Array.from(store.keys())[i] ?? null,
    removeItem: (k: string) => { store.delete(k); },
    setItem: (k: string, v: string) => { store.set(k, String(v)); },
  };
}

describe('getDisplayCodeFromToken', () => {
  it('derives the three-word code from the signature bytes', () => {
    expect(getDisplayCodeFromToken(VALID_TOKEN)).toBe(
      `${VOUCHER_WORD_LIST[0]}-${VOUCHER_WORD_LIST[1]}-${VOUCHER_WORD_LIST[2]}`
    );
  });

  it.each([
    ['invalid base64 character', 'v1:abc:payload:ab%cd'],
    ['length ≡ 1 (mod 4) after truncation', 'v1:abc:payload:abcde'],
    ['signature shorter than 3 bytes', 'v1:abc:payload:AA'],
    ['wrong number of parts', 'v1:abc:payload'],
    ['empty string', ''],
  ])('returns null instead of throwing for %s', (_label, token) => {
    expect(() => getDisplayCodeFromToken(token)).not.toThrow();
    expect(getDisplayCodeFromToken(token)).toBeNull();
    expect(isUsableVoucherToken(token)).toBe(false);
  });
});

describe('readStoredVoucherToken', () => {
  let storage: Storage;

  beforeEach(() => {
    storage = memoryStorage();
    vi.stubGlobal('sessionStorage', storage);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('returns a well-formed stored token', () => {
    storage.setItem(STORAGE_KEY, VALID_TOKEN);
    expect(readStoredVoucherToken()).toBe(VALID_TOKEN);
    expect(storage.getItem(STORAGE_KEY)).toBe(VALID_TOKEN);
  });

  it('drops and clears a malformed stored token so reloads recover', () => {
    storage.setItem(STORAGE_KEY, 'v1:abc:payload:ab%cd');
    expect(readStoredVoucherToken()).toBeNull();
    expect(storage.getItem(STORAGE_KEY)).toBeNull();
  });

  it('returns null when nothing is stored', () => {
    expect(readStoredVoucherToken()).toBeNull();
  });

  it('returns null when sessionStorage is unavailable', () => {
    vi.stubGlobal('sessionStorage', {
      getItem: () => { throw new Error('SecurityError'); },
    });
    expect(readStoredVoucherToken()).toBeNull();
  });
});
