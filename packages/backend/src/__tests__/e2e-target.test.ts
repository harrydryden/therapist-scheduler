/**
 * scripts/e2e-test.ts creates, confirms and cancels REAL bookings and sends
 * real email. It used to default to the production API when TEST_API_BASE
 * was unset (review §4.5). The target is now required and production is
 * refused.
 */

// scripts/ sits outside tsconfig.json's rootDir (src/), so the module is
// loaded at runtime rather than imported; it is typechecked by
// tsconfig.scripts.json (`npm run typecheck`).
type E2eTargetModule = {
  resolveE2eApiBase(env: Record<string, string | undefined>): string;
  E2eTargetError: new (message: string) => Error;
  PRODUCTION_API_HOSTS: readonly string[];
};
// eslint-disable-next-line @typescript-eslint/no-var-requires
const { resolveE2eApiBase, E2eTargetError, PRODUCTION_API_HOSTS } = require('../../scripts/lib/e2e-target') as E2eTargetModule;

it('requires TEST_API_BASE — there is no default target', () => {
  expect(() => resolveE2eApiBase({})).toThrow(E2eTargetError);
  expect(() => resolveE2eApiBase({ TEST_API_BASE: '   ' })).toThrow(/TEST_API_BASE is required/);
});

it('refuses the production API host', () => {
  for (const host of PRODUCTION_API_HOSTS) {
    expect(() => resolveE2eApiBase({ TEST_API_BASE: `https://${host}` })).toThrow(/production/);
    expect(() => resolveE2eApiBase({ TEST_API_BASE: `https://${host.toUpperCase()}/` })).toThrow(/production/);
  }
  expect(() => resolveE2eApiBase({ TEST_API_BASE: 'https://backend-production-abcd.up.railway.app' })).toThrow(/production/);
});

it('rejects non-http(s) and malformed URLs', () => {
  expect(() => resolveE2eApiBase({ TEST_API_BASE: 'not a url' })).toThrow(/valid URL/);
  expect(() => resolveE2eApiBase({ TEST_API_BASE: 'ftp://staging.example.com' })).toThrow(/http\(s\)/);
});

it('accepts local and staging targets (trailing slash trimmed)', () => {
  expect(resolveE2eApiBase({ TEST_API_BASE: 'http://localhost:3000/' })).toBe('http://localhost:3000');
  expect(resolveE2eApiBase({ TEST_API_BASE: 'https://backend-staging.up.railway.app' })).toBe(
    'https://backend-staging.up.railway.app',
  );
});
