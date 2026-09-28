/**
 * Deploy / build / CI configuration invariants (review §3 #5, #14, §4.5, §8).
 *
 * These files are not TypeScript, so nothing else would catch a regression:
 * a Node 18 base image, a `localhost` health check, the baseline.sh fallback
 * coming back, dev dependencies or compiled tests shipped in the image,
 * Postgres published on every interface, or CI losing a step.
 */

import { readFileSync, existsSync } from 'fs';
import { execFileSync } from 'child_process';
import * as path from 'path';

const BACKEND = path.resolve(__dirname, '../..');
const ROOT = path.resolve(BACKEND, '../..');
const read = (p: string) => readFileSync(path.join(ROOT, p), 'utf8');
const json = (p: string) => JSON.parse(read(p));

describe('Dockerfile', () => {
  const dockerfile = read('Dockerfile');

  it('uses Node 22 in every stage', () => {
    const bases = [...dockerfile.matchAll(/^FROM\s+(\S+)/gm)].map((m) => m[1]);
    expect(bases.length).toBeGreaterThanOrEqual(2);
    for (const base of bases) {
      expect(base === 'builder' || base.startsWith('node:22')).toBe(true);
    }
  });

  it('ships production-only node_modules (devDependencies pruned)', () => {
    expect(dockerfile).toMatch(/npm prune --omit=dev/);
    expect(dockerfile).toMatch(/COPY --from=prod-deps [^\n]*\/app\/node_modules \.\/node_modules/);
  });

  it('runs the fail-fast entrypoint (no baseline script anywhere)', () => {
    expect(dockerfile).toMatch(/docker-entrypoint\.sh/);
    expect(dockerfile).not.toMatch(/baseline/);
  });
});

describe('.dockerignore', () => {
  it('keeps host dependencies, build output and env files out of the context', () => {
    const lines = read('.dockerignore').split('\n').map((l) => l.trim());
    for (const entry of ['**/node_modules', '**/.vite', '**/dist', '**/coverage', '**/.env', '**/.env.*', '.git']) {
      expect(lines).toContain(entry);
    }
  });
});

describe('health check', () => {
  it('probes 127.0.0.1, not localhost (which may resolve to ::1)', () => {
    jest.isolateModules(() => {
      const request = jest.fn(() => ({ on: jest.fn(), end: jest.fn(), destroy: jest.fn() }));
      jest.doMock('http', () => ({ request }));
      const exit = jest.spyOn(process, 'exit').mockImplementation((() => undefined) as never);
      try {
        require('../health-check');
        expect(request).toHaveBeenCalledTimes(1);
        expect((request.mock.calls[0] as unknown[])[0]).toMatchObject({ hostname: '127.0.0.1', path: '/health' });
      } finally {
        exit.mockRestore();
        jest.dontMock('http');
      }
    });
  });
});

describe('migrations on deploy', () => {
  it('baseline.sh is gone and nothing references it', () => {
    expect(existsSync(path.join(BACKEND, 'prisma/baseline.sh'))).toBe(false);
    expect(read('packages/backend/package.json')).not.toMatch(/baseline/);
  });

  it('the entrypoint runs plain prisma migrate deploy and fails fast', () => {
    const commands = read('packages/backend/scripts/docker-entrypoint.sh')
      .split('\n')
      .filter((line) => !line.trim().startsWith('#'))
      .join('\n');
    expect(commands).toMatch(/^set -eu$/m);
    expect(commands).toMatch(/prisma migrate deploy/);
    expect(commands).not.toMatch(/migrate resolve|baseline|\|\| true|timeout/);
  });

  it('bootstrap-dev-db.sh refuses a production-looking DATABASE_URL before touching anything', () => {
    for (const url of [
      'postgresql://u:p@containers-us-west-1.RAILWAY.app:5432/railway',
      'postgresql://u:p@db-prod.internal:5432/app',
    ]) {
      let status = 0;
      let stderr = '';
      try {
        execFileSync('sh', [path.join(BACKEND, 'scripts/bootstrap-dev-db.sh')], {
          env: { ...process.env, DATABASE_URL: url, PATH: '/usr/bin:/bin' },
          stdio: 'pipe',
        });
      } catch (err) {
        const e = err as { status: number; stderr: Buffer };
        status = e.status;
        stderr = e.stderr.toString();
      }
      expect(status).toBe(1);
      expect(stderr).toMatch(/refusing to run/);
    }
  });
});

describe('packages', () => {
  it('prisma CLI is a runtime dependency of the backend (the entrypoint needs it after the prune)', () => {
    const pkg = json('packages/backend/package.json');
    expect(pkg.dependencies.prisma).toBeDefined();
    expect(pkg.devDependencies.prisma).toBeUndefined();
  });

  it('pins Node >= 22 at the root and in the backend', () => {
    expect(json('package.json').engines.node).toBe('>=22');
    expect(json('packages/backend/package.json').engines.node).toBe('>=22');
  });

  it('.npmrc does not make missing scripts pass silently', () => {
    expect(read('.npmrc')).not.toMatch(/if-present/);
  });

  it('root test:all runs the frontend tests too', () => {
    expect(json('package.json').scripts['test:all']).toMatch(/therapist-scheduling-frontend run test/);
  });

  it('the build does not compile the tests into dist/, and typecheck covers scripts/', () => {
    const pkg = json('packages/backend/package.json');
    expect(pkg.scripts.build).toMatch(/tsc -p tsconfig\.build\.json/);
    expect(read('packages/backend/tsconfig.build.json')).toMatch(/"src\/__tests__"/);
    expect(pkg.scripts.typecheck).toMatch(/tsconfig\.scripts\.json/);
    expect(read('packages/backend/tsconfig.scripts.json')).toMatch(/"scripts\/\*\*\/\*\.ts"/);
  });
});

describe('docker-compose.yml', () => {
  const compose = read('docker-compose.yml');

  it('publishes Postgres and Redis on 127.0.0.1 only', () => {
    expect(compose).toMatch(/"127\.0\.0\.1:5432:5432"/);
    expect(compose).toMatch(/"127\.0\.0\.1:6379:6379"/);
    expect(compose).not.toMatch(/- "5432:5432"|- "6379:6379"/);
  });

  it('wires the app to its own Postgres and Redis by default', () => {
    expect(compose).toMatch(/DATABASE_URL=\$\{DATABASE_URL:-postgresql:\/\/[^\n]*@postgres:5432\//);
    expect(compose).toMatch(/REDIS_URL=\$\{REDIS_URL:-redis:\/\/redis:6379\}/);
  });

  it('defaults SINGLE_INSTANCE_MODE to false, like the code', () => {
    expect(compose).toMatch(/SINGLE_INSTANCE_MODE=\$\{SINGLE_INSTANCE_MODE:-false\}/);
  });
});

describe('CI workflow', () => {
  const ci = read('.github/workflows/ci.yml');

  it('runs on push and pull_request with Node 22', () => {
    expect(ci).toMatch(/^on:\n\s+push:\n\s+pull_request:/m);
    expect(ci).toMatch(/node-version: 22/);
  });

  it('has exactly two jobs', () => {
    const jobsBlock = ci.slice(ci.indexOf('\njobs:\n'));
    const jobs = [...jobsBlock.matchAll(/^ {2}([a-z-]+):$/gm)].map((m) => m[1]);
    expect(jobs).toEqual(['checks', 'integration']);
  });

  it.each([
    'npm ci',
    'npm -w @therapist-scheduler/shared run build',
    'npm -w therapist-scheduler-backend run typecheck',
    'npm -w therapist-scheduler-backend run lint',
    'npm -w therapist-scheduling-frontend run typecheck',
    'npm -w therapist-scheduling-frontend run lint',
    'npm -w therapist-scheduler-backend run test -- --forceExit',
    'npm -w therapist-scheduling-frontend run test',
    'prisma validate',
    'npm run check:schema-migration',
    'docker compose -f docker-compose.yml config',
    'image: postgres:16',
    'npm -w therapist-scheduler-backend run db:bootstrap-dev',
    'npm -w therapist-scheduler-backend run test:integration',
  ])('runs `%s`', (step) => {
    expect(ci).toContain(step);
  });

  it('diffs the schema against the PR base', () => {
    expect(ci).toMatch(/BASE_REF: .*github\.base_ref/);
    expect(ci).toMatch(/fetch-depth: 0/);
  });
});
