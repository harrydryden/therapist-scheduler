# Node 22 (LTS) in both stages. Node 18 has been end-of-life since April 2025.
FROM node:22-alpine AS builder

# Prisma requires OpenSSL to run its schema and migration engines on Alpine
RUN apk add --no-cache openssl

WORKDIR /app

# Copy root workspace config and lock file
COPY package.json package-lock.json .npmrc ./
COPY tsconfig.base.json ./

# Copy package.json files for all workspace packages (for dep resolution)
COPY packages/shared/package.json ./packages/shared/
COPY packages/shared/tsconfig.json ./packages/shared/
COPY packages/backend/package.json ./packages/backend/
COPY packages/backend/tsconfig.json packages/backend/tsconfig.build.json ./packages/backend/
COPY packages/frontend/package.json ./packages/frontend/

# Install all workspace dependencies (hoisted to root node_modules)
RUN npm ci && npm cache clean --force

# Copy source code (.dockerignore keeps host node_modules, build output,
# .vite caches and .env* files out of the context)
COPY packages/shared/src ./packages/shared/src/
COPY packages/backend/src ./packages/backend/src/
COPY packages/backend/prisma ./packages/backend/prisma/
COPY packages/backend/scripts ./packages/backend/scripts/
COPY packages/frontend/ ./packages/frontend/

# Build shared package first, then backend (runs `prisma generate`, compiles
# with tsconfig.build.json — tests are not compiled), then frontend.
RUN npm run build

# Production dependencies: the builder's node_modules with devDependencies
# pruned. A separate stage (rather than a prune inside the runtime stage)
# because pruning after a COPY would leave the dev packages in the copied
# layer; and the builder keeps its full install for docker-compose.dev.yml
# (target: builder), which runs `tsx watch`. The prisma CLI is a runtime
# dependency (the entrypoint runs `prisma migrate deploy`); the generated
# client in node_modules/.prisma survives the prune.
FROM builder AS prod-deps
RUN npm prune --omit=dev && npm cache clean --force

# Production stage
FROM node:22-alpine AS production

# Pin the process timezone explicitly. All date logic is written to be
# server-TZ-independent (Intl-based, explicit IANA zones), so this is a
# determinism guarantee rather than a behavioural knob: chrono's relative-date
# resolution and any residual Date construction behave identically across
# hosts. Keep as UTC — do NOT "fix" times by changing this; pass an explicit
# timezone at the call site instead.
ENV TZ=UTC

WORKDIR /app

# Install dumb-init for proper signal handling and OpenSSL for Prisma migrations
RUN apk add --no-cache dumb-init openssl

# Create non-root user
RUN addgroup -g 1001 -S nodejs
RUN adduser -S nodeuser -u 1001

# Copy workspace structure (needed for module resolution) and the pruned,
# production-only node_modules
COPY --from=builder --chown=nodeuser:nodejs /app/package.json ./package.json
COPY --from=prod-deps --chown=nodeuser:nodejs /app/node_modules ./node_modules

# Copy shared package (built)
COPY --from=builder --chown=nodeuser:nodejs /app/packages/shared/dist ./packages/shared/dist
COPY --from=builder --chown=nodeuser:nodejs /app/packages/shared/package.json ./packages/shared/package.json

# Copy backend (built + prisma + entrypoint)
COPY --from=builder --chown=nodeuser:nodejs /app/packages/backend/dist ./packages/backend/dist
COPY --from=builder --chown=nodeuser:nodejs /app/packages/backend/package.json ./packages/backend/package.json
COPY --from=builder --chown=nodeuser:nodejs /app/packages/backend/prisma ./packages/backend/prisma
COPY --from=builder --chown=nodeuser:nodejs /app/packages/backend/scripts/docker-entrypoint.sh ./packages/backend/scripts/docker-entrypoint.sh
# One-time bootstrap for a NEW empty database (refuses production URLs);
# see docs/SCHEMA_MIGRATIONS.md.
COPY --from=builder --chown=nodeuser:nodejs /app/packages/backend/scripts/bootstrap-dev-db.sh ./packages/backend/scripts/bootstrap-dev-db.sh
# Copy backend workspace-local node_modules if it exists (includes @prisma/client when not hoisted).
# The trailing slash + wildcard pattern ensures the COPY is a no-op when the directory is absent,
# which happens when npm hoists all deps to the root node_modules.
COPY --from=prod-deps --chown=nodeuser:nodejs /app/packages/backend/node_module[s] ./packages/backend/node_modules

# Copy frontend build output (served by backend via @fastify/static)
COPY --from=builder --chown=nodeuser:nodejs /app/packages/frontend/dist ./dist

USER nodeuser

EXPOSE 3000

# Health check using Node.js (Alpine doesn't have wget/curl by default).
# health-check.js probes 127.0.0.1 (the server binds IPv4 0.0.0.0; 'localhost'
# may resolve to ::1). start-period accounts for migration time on deploys
# with schema changes.
HEALTHCHECK --interval=30s --timeout=5s --start-period=60s --retries=3 \
  CMD node packages/backend/dist/health-check.js || exit 1

ENTRYPOINT ["dumb-init", "--"]
CMD ["sh", "packages/backend/scripts/docker-entrypoint.sh"]
