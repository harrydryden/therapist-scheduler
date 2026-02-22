FROM node:18-alpine AS builder

WORKDIR /app

# Copy root workspace config and lock file
COPY package.json package-lock.json ./
COPY tsconfig.base.json ./

# Copy package.json files for all workspace packages (for dep resolution)
COPY packages/shared/package.json ./packages/shared/
COPY packages/shared/tsconfig.json ./packages/shared/
COPY packages/backend/package.json ./packages/backend/
COPY packages/backend/tsconfig.json ./packages/backend/
COPY packages/frontend/package.json ./packages/frontend/

# Install all workspace dependencies (hoisted to root node_modules)
RUN npm ci && npm cache clean --force

# Copy source code
COPY packages/shared/src ./packages/shared/src/
COPY packages/backend/src ./packages/backend/src/
COPY packages/backend/prisma ./packages/backend/prisma/
COPY packages/backend/jest.config.js ./packages/backend/
COPY packages/frontend/ ./packages/frontend/

# Generate Prisma client
RUN npx -w packages/backend prisma generate

# Build shared package first, then backend, then frontend
RUN npm run build:all

# Production stage
FROM node:18-alpine AS production

WORKDIR /app

# Install dumb-init for proper signal handling
RUN apk add --no-cache dumb-init

# Create non-root user
RUN addgroup -g 1001 -S nodejs
RUN adduser -S nodeuser -u 1001

# Copy workspace structure (needed for module resolution)
COPY --from=builder --chown=nodeuser:nodejs /app/package.json ./package.json
COPY --from=builder --chown=nodeuser:nodejs /app/node_modules ./node_modules

# Copy shared package (built)
COPY --from=builder --chown=nodeuser:nodejs /app/packages/shared/dist ./packages/shared/dist
COPY --from=builder --chown=nodeuser:nodejs /app/packages/shared/package.json ./packages/shared/package.json

# Copy backend (built + prisma)
COPY --from=builder --chown=nodeuser:nodejs /app/packages/backend/dist ./packages/backend/dist
COPY --from=builder --chown=nodeuser:nodejs /app/packages/backend/package.json ./packages/backend/package.json
COPY --from=builder --chown=nodeuser:nodejs /app/packages/backend/prisma ./packages/backend/prisma

# Copy frontend build output (served by backend via @fastify/static)
COPY --from=builder --chown=nodeuser:nodejs /app/packages/frontend/dist ./dist

USER nodeuser

EXPOSE 3000

# Health check using Node.js (Alpine doesn't have wget/curl by default)
HEALTHCHECK --interval=30s --timeout=3s --start-period=10s --retries=3 \
  CMD node packages/backend/dist/health-check.js || exit 1

ENTRYPOINT ["dumb-init", "--"]
CMD ["node", "packages/backend/dist/server.js"]
