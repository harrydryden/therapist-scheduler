/**
 * Target resolution for scripts/e2e-test.ts.
 *
 * The e2e script creates, confirms and cancels REAL bookings and sends real
 * email. It used to default to the production API when TEST_API_BASE was
 * unset, so running it bare exercised production. The target is now
 * mandatory, and production is refused outright.
 */

/** Hosts the e2e script must never run against. */
export const PRODUCTION_API_HOSTS: readonly string[] = ['backend-production-fe25.up.railway.app'];

export class E2eTargetError extends Error {}

export function resolveE2eApiBase(env: Record<string, string | undefined>): string {
  const raw = env.TEST_API_BASE?.trim();
  if (!raw) {
    throw new E2eTargetError(
      'TEST_API_BASE is required (e.g. http://localhost:3000 or a staging URL). ' +
        'The e2e script creates real bookings and sends real email; it has no default target.',
    );
  }

  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new E2eTargetError(`TEST_API_BASE is not a valid URL: ${raw}`);
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new E2eTargetError(`TEST_API_BASE must be an http(s) URL: ${raw}`);
  }

  const host = url.hostname.toLowerCase();
  if (PRODUCTION_API_HOSTS.includes(host) || host.includes('production')) {
    throw new E2eTargetError(`Refusing to run the e2e script against production (${host}).`);
  }

  return url.origin + url.pathname.replace(/\/+$/, '');
}
