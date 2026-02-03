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

    // For data URLs, only allow image types
    if (parsed.protocol === 'data:') {
      if (!trimmed.startsWith('data:image/')) {
        console.warn('Blocked non-image data URL');
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
 * Sanitize text to prevent XSS when rendering as HTML
 */
export function sanitizeText(text: string | null | undefined): string {
  if (!text) return '';
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#039;');
}
