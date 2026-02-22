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

// Note: sanitizeText was removed as it was dead code.
// AdminDashboardPage uses DOMPurify.sanitize() for HTML stripping,
// and JSX auto-escapes text content, making HTML entity encoding unnecessary.
