/**
 * Get or create a session-scoped admin identifier.
 * Uses sessionStorage so the ID doesn't persist across browser sessions.
 */
export function getAdminId(): string {
  const stored = sessionStorage.getItem('admin_id');
  if (stored) return stored;
  const newId = `admin_${Date.now().toString(36)}`;
  sessionStorage.setItem('admin_id', newId);
  return newId;
}
