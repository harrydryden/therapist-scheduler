/**
 * Log-sanitisation helpers.
 *
 * Fastify logs `req.url` on every request. The admin SSE stream can only
 * authenticate via `?secret=`, and unsubscribe / invitation links carry
 * their tokens in the path, so an unredacted request serializer wrote the
 * admin secret and one-click tokens to the logs in plaintext.
 */

/**
 * Strip credentials from a URL before it reaches the request log:
 *  - the whole query string is replaced with `?[redacted]`
 *  - known token-bearing path segments are masked
 *  - any single path segment long enough to be a token/signature is masked
 */
export function sanitizeUrlForLog(url: string | undefined): string | undefined {
  if (!url) return url;
  const qIndex = url.indexOf('?');
  const path = qIndex === -1 ? url : url.slice(0, qIndex);
  const hadQuery = qIndex !== -1;
  const redactedPath = path
    .replace(/(\/api\/unsubscribe\/)[^/?#]+/i, '$1[redacted]')
    .replace(/(\/api\/signup\/invitation\/)[^/?#]+/i, '$1[redacted]')
    .replace(/(\/api\/feedback\/form\/)[^/?#]+/i, '$1[redacted]')
    .replace(/\/[A-Za-z0-9_\-.:=]{40,}(?=\/|$)/g, '/[redacted]');
  return hadQuery ? `${redactedPath}?[redacted]` : redactedPath;
}
