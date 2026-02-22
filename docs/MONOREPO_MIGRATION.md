# Monorepo Migration Guide

## Why Merge Into a Monorepo

The frontend and backend are currently in separate repositories. This causes several problems:

1. **Duplicated types that have drifted** — Types like `AppointmentListItem`, `AppointmentDetail`, `KnowledgeEntry`, `PaginationInfo`, and `ApiResponse` are defined in both repos with subtle differences (e.g., `Date` vs `string` for date fields, different `ApiResponse` shapes).

2. **Duplicated config** — `therapist-categories.ts` is copy-pasted across both repos with nearly identical content.

3. **No CI/CD** — Neither repo has GitHub Actions. A monorepo enables a single CI workflow that builds, lints, and tests both packages together.

4. **Coordination overhead** — API changes require modifying two repos, two PRs, and careful deploy ordering.

## Target Structure

```
therapist-scheduler/
├── .github/
│   └── workflows/
│       └── ci.yml
├── packages/
│   ├── shared/
│   │   ├── src/
│   │   │   ├── types/          # Shared API types, model types
│   │   │   ├── config/         # therapist-categories.ts, etc.
│   │   │   └── constants/      # Status enums, shared constants
│   │   ├── package.json
│   │   └── tsconfig.json
│   ├── frontend/
│   │   ├── src/
│   │   ├── package.json
│   │   ├── vite.config.ts
│   │   └── tsconfig.json
│   └── backend/
│       ├── src/
│       ├── prisma/
│       ├── package.json
│       └── tsconfig.json
├── docker-compose.yml
├── Dockerfile
├── package.json              # Workspace root
├── tsconfig.base.json        # Shared TS config
└── README.md
```

## Step-by-Step Migration

### 1. Create the monorepo

```bash
# Option A: Use the frontend repo as the base (it already has frontend/ and docker configs)
# Option B: Create a fresh repo and move both in

# Using Option A:
cd therapist-scheduler-frontend
```

### 2. Set up npm workspaces

Create a root `package.json`:

```json
{
  "name": "therapist-scheduler",
  "private": true,
  "workspaces": [
    "packages/shared",
    "packages/frontend",
    "packages/backend"
  ],
  "scripts": {
    "dev:frontend": "npm -w packages/frontend run dev",
    "dev:backend": "npm -w packages/backend run dev",
    "build": "npm -w packages/shared run build && npm -w packages/backend run build && npm -w packages/frontend run build",
    "test": "npm -w packages/backend run test",
    "lint": "npm -w packages/frontend run lint && npm -w packages/backend run lint",
    "typecheck": "tsc -b packages/shared packages/backend packages/frontend"
  }
}
```

### 3. Move code into packages/

```bash
# Move frontend
mkdir -p packages
mv frontend packages/frontend

# Copy backend from the other repo
cp -r ../therapist-scheduler-backend packages/backend

# Remove vestigial backend/ directory (currently empty)
rm -rf backend/
```

### 4. Create the shared package

```bash
mkdir -p packages/shared/src/{types,config,constants}
```

**packages/shared/package.json:**
```json
{
  "name": "@therapist-scheduler/shared",
  "version": "1.0.0",
  "main": "src/index.ts",
  "types": "src/index.ts",
  "scripts": {
    "build": "tsc",
    "typecheck": "tsc --noEmit"
  },
  "devDependencies": {
    "typescript": "^5.3.3"
  }
}
```

### 5. Extract shared types

Move these types from both repos into `packages/shared/src/types/`:

| Type | Frontend location | Backend location |
|------|-------------------|------------------|
| `AppointmentListItem` | `frontend/src/types/index.ts` | `backend/src/types/index.ts` |
| `AppointmentDetail` | `frontend/src/types/index.ts` | `backend/src/types/index.ts` |
| `KnowledgeEntry` | `frontend/src/types/index.ts` | `backend/src/types/index.ts` |
| `PaginationInfo` | `frontend/src/types/index.ts` | `backend/src/types/index.ts` |
| `ApiResponse` | `frontend/src/types/index.ts` | `backend/src/types/index.ts` |
| `TherapistCategories` | `frontend/src/config/therapist-categories.ts` | `backend/src/config/therapist-categories.ts` |
| `CategoryOption` | `frontend/src/config/therapist-categories.ts` | `backend/src/config/therapist-categories.ts` |

**Important:** Reconcile the drifted types. Use `string` for dates in the shared API types (since JSON serialization produces strings), and convert to `Date` in the backend's internal layer.

### 6. Extract shared config

Merge `therapist-categories.ts` into `packages/shared/src/config/`:
- Keep the core data (options, explainers, helper functions)
- Move the backend-specific Notion property names to the backend
- Move the frontend-specific CSS color mappings to the frontend

### 7. Update imports

In both packages, replace local type imports with:

```typescript
import type { AppointmentListItem, ApiResponse } from '@therapist-scheduler/shared';
```

### 8. Set up TypeScript project references

**packages/shared/tsconfig.json:**
```json
{
  "extends": "../../tsconfig.base.json",
  "compilerOptions": {
    "outDir": "./dist",
    "rootDir": "./src",
    "composite": true
  },
  "include": ["src"]
}
```

**packages/frontend/tsconfig.json** and **packages/backend/tsconfig.json:**
```json
{
  "references": [{ "path": "../shared" }]
}
```

### 9. Add GitHub Actions CI

**.github/workflows/ci.yml:**
```yaml
name: CI

on:
  push:
    branches: [main]
  pull_request:
    branches: [main]

jobs:
  build-and-test:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with:
          node-version: '20'
          cache: 'npm'
      - run: npm ci
      - run: npm run typecheck
      - run: npm run lint
      - run: npm test
      - run: npm run build
```

### 10. Update deployment configs

**Vercel:** Set root directory to `packages/frontend` in Vercel project settings.

**Railway:** Set root directory to `packages/backend` in Railway project settings, or update the Dockerfile to build from the monorepo root.

## Verification Checklist

- [ ] `npm install` succeeds at the root
- [ ] `npm run typecheck` passes (no type errors across all packages)
- [ ] `npm run build` builds shared, then backend, then frontend
- [ ] `npm test` passes backend tests
- [ ] Frontend dev server starts with `npm run dev:frontend`
- [ ] Backend dev server starts with `npm run dev:backend`
- [ ] Docker build still works
- [ ] Vercel deployment succeeds
- [ ] Railway deployment succeeds
