/**
 * Sanitize a URL to prevent XSS attacks
 * Only allows http, https, and data (for base64 images) protocols
 */
export function sanitizeImageUrl(url: string | null | undefined): string | null {
  if (!url) return null;

  // Trim whitespace
  const trimmed = url.trim();
  if (!trimmed) return null;

  // Parse the URL to validate it
  try {
    const parsed = new URL(trimmed);

    // Only allow safe protocols
    const allowedProtocols = ['http:', 'https:', 'data:'];
    if (!allowedProtocols.includes(parsed.protocol)) {
      console.warn('Blocked unsafe image URL protocol:', parsed.protocol);
      return null;
    }

    // For data URLs, only allow safe image types (no SVG - can contain scripts)
    if (parsed.protocol === 'data:') {
      const safeDataTypes = ['data:image/jpeg', 'data:image/png', 'data:image/gif', 'data:image/webp'];
      if (!safeDataTypes.some(t => trimmed.startsWith(t))) {
        console.warn('Blocked unsafe data URL type');
        return null;
      }
    }

    return trimmed;
  } catch {
    // If URL parsing fails, it might be a relative URL or invalid
    // Only allow relative URLs that start with /
    if (trimmed.startsWith('/') && !trimmed.startsWith('//')) {
      return trimmed;
    }

    console.warn('Blocked invalid image URL:', trimmed);
    return null;
  }
}

/**
 * Validate an external link (e.g. a therapist's booking page) before it is
 * rendered as an href or opened. Only absolute http(s) URLs pass;
 * `javascript:`, `data:`, relative and unparseable values return null.
 *
 * Therapist booking links can be written by the scheduling agent from
 * email text, and zod's `.url()` on the backend accepts `javascript:`, so
 * the frontend must not trust them.
 */
export function sanitizeExternalUrl(url: string | null | undefined): string | null {
  if (!url) return null;
  const trimmed = url.trim();
  if (!trimmed) return null;

  try {
    const parsed = new URL(trimmed);
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
      console.warn('Blocked unsafe external URL protocol:', parsed.protocol);
      return null;
    }
    return parsed.href;
  } catch {
    return null;
  }
}

// Note: sanitizeText was removed as it was dead code.
// AdminDashboardPage uses DOMPurify.sanitize() for HTML stripping,
// and JSX auto-escapes text content, making HTML entity encoding unnecessary.
