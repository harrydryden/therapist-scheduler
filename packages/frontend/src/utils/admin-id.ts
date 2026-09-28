/**
 * Admin identity shown in "Taken by", settings `updatedBy` and the audit
 * trail.
 *
 * It used to be a random per-tab id (`admin_<base36 time>`), which told
 * nobody who had acted and made one person's two tabs 409 each other on
 * take-control. Admins now enter a display name once; it's kept in
 * localStorage (per browser, across tabs and sessions) and sent as the
 * `adminId`. NOTE: it is still self-asserted — the backend has no admin
 * accounts — so it identifies, it does not authenticate.
 */

const DISPLAY_NAME_KEY = 'admin_display_name';
const LEGACY_SESSION_ID_KEY = 'admin_id';
export const MAX_ADMIN_NAME_LENGTH = 60;

/** Trim / collapse whitespace; null when nothing usable is left. */
export function normalizeAdminDisplayName(input: string | null | undefined): string | null {
  const name = (input ?? '').replace(/\s+/g, ' ').trim().slice(0, MAX_ADMIN_NAME_LENGTH);
  return name.length > 0 ? name : null;
}

function readStorage(storage: Storage | undefined, key: string): string | null {
  try {
    return storage?.getItem(key) ?? null;
  } catch {
    return null;
  }
}

/** The stored display name, or null when the admin hasn't set one yet. */
export function getAdminDisplayName(): string | null {
  return normalizeAdminDisplayName(readStorage(globalThis.localStorage, DISPLAY_NAME_KEY));
}

export function setAdminDisplayName(name: string): string | null {
  const normalized = normalizeAdminDisplayName(name);
  if (!normalized) return null;
  try {
    globalThis.localStorage?.setItem(DISPLAY_NAME_KEY, normalized);
  } catch {
    // Storage unavailable (private mode): the name still applies to this page.
  }
  return normalized;
}

/**
 * The `adminId` to send with admin actions: the display name when set,
 * otherwise (only before the name prompt has been answered) a legacy
 * per-session id so actions still work.
 */
export function getAdminId(): string {
  const name = getAdminDisplayName();
  if (name) return name;
  const stored = readStorage(globalThis.sessionStorage, LEGACY_SESSION_ID_KEY);
  if (stored) return stored;
  const newId = `admin_${Date.now().toString(36)}`;
  try {
    globalThis.sessionStorage?.setItem(LEGACY_SESSION_ID_KEY, newId);
  } catch {
    // ignore
  }
  return newId;
}
