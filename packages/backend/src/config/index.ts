import { z } from 'zod';

const configSchema = z.object({
  env: z.enum(['development', 'production', 'test']).default('development'),
  port: z.coerce.number().default(3000),
  host: z.string().default('0.0.0.0'),

  // Database
  databaseUrl: z.string(),

  // Redis
  redisUrl: z.string().default('redis://localhost:6379'),

  // JWT
  jwtSecret: z.string(),
  jwtExpiresIn: z.string().default('24h'),

  // AI Services
  anthropicApiKey: z.string(),

  // Webhooks
  webhookSecret: z.string(),

  // Google Cloud Pub/Sub
  googlePubsubTopic: z.string().optional(),
  googlePubsubAudience: z.string().optional(), // Expected audience for Pub/Sub push token verification
  requirePubsubAuth: z.preprocess(
    (val) => (typeof val === 'string' ? val !== 'false' : val),
    z.boolean().default(true)
  ), // Require authentication on Pub/Sub push endpoint
  
  // Rate limiting - adjusted for small-scale production
  rateLimitMax: z.coerce.number().default(200), // Increased for small scale
  rateLimitWindow: z.coerce.number().default(60000), // 1 minute
  
  // CORS
  cors: z.object({
    origin: z.union([z.string(), z.array(z.string()), z.boolean()]).default(true),
    credentials: z.preprocess(
      (val) => (typeof val === 'string' ? val !== 'false' : val),
      z.boolean().default(true)
    ),
  }).default({}),
  
  // Logging
  logLevel: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace']).default('info'),
  
  // Streaming - adjusted for small-scale production
  sseHeartbeatInterval: z.coerce.number().default(30000), // 30 seconds
  sseMaxConnections: z.coerce.number().default(100), // Increased for small scale
  
  // Token bucket rate limiting - adjusted for small-scale production
  tokenBucket: z.object({
    capacity: z.coerce.number().default(200), // Increased for small scale
    refillRate: z.coerce.number().default(20), // Increased tokens per second
    refillInterval: z.coerce.number().default(1000), // milliseconds
  }).default({}),
  
  // Performance monitoring
  performanceMonitoring: z.object({
    enabled: z.preprocess(
      (val) => (typeof val === 'string' ? val !== 'false' : val),
      z.boolean().default(true)
    ),
    logInterval: z.coerce.number().default(300000), // 5 minutes
    maxSamples: z.coerce.number().default(100), // Keep last 100 samples
    slowQueryThreshold: z.coerce.number().default(1000), // 1 second
    slowMessageThreshold: z.coerce.number().default(5000), // 5 seconds
    slowAIThreshold: z.coerce.number().default(30000), // 30 seconds
  }).default({}),
  
  // Connection limits - appropriate for small scale
  connections: z.object({
    maxPerUser: z.coerce.number().default(3),
    maxTotal: z.coerce.number().default(50),
    timeout: z.coerce.number().default(300000), // 5 minutes
  }).default({}),

  // Timezone configuration
  // Default to Europe/London for UK-based therapy service
  timezone: z.string().default('Europe/London'),

  // Backend URL for generating links (unsubscribe, etc.)
  // FIX: In production, require explicit BACKEND_URL to prevent broken unsubscribe links
  backendUrl: z.string().refine(
    (val) => {
      // In production, reject localhost URLs
      if (process.env.NODE_ENV === 'production' && val.includes('localhost')) {
        return false;
      }
      return true;
    },
    { message: 'BACKEND_URL must be set to a non-localhost URL in production' }
  ).default('http://localhost:3000'),

  // Frontend URL for generating links to user-facing routes
  // (e.g. signup invitations land on /signup which is served by the frontend
  // host, NOT the backend). Mirrors backendUrl's prod-validation: localhost
  // is rejected in prod so a missed env-var doesn't ship 404-ing invite links.
  frontendUrl: z.string().refine(
    (val) => {
      if (process.env.NODE_ENV === 'production' && val.includes('localhost')) {
        return false;
      }
      return true;
    },
    { message: 'FRONTEND_URL must be set to a non-localhost URL in production' }
  ).default('http://localhost:5173'),
});

// SECURITY: requirePubsubAuth gates the unauthenticated Gmail push
// webhook. The original H5 fix refused to validate config in production
// when REQUIRE_PUBSUB_AUTH=false, which crash-looped any service
// already running with that override. We now log the misconfig
// loudly at boot (and on a recurring interval thereafter) but do NOT
// abort startup — availability beats hard-failing here, since the
// inbound webhook is one piece of a wider product and other endpoints
// should keep working while ops removes the override.
//
// The loud-warning approach is a deliberate trade-off:
//   - PRO: prevents an outage when the env var is set wrong
//   - CON: leaves the inbound-email path effectively unauthenticated
//     until ops removes the override
// Operators MUST treat the warning as a P1 ticket. The recurring log
// (and Slack alert when configured) is intended to make the warning
// impossible to ignore. See docs around `REQUIRE_PUBSUB_AUTH` in the
// repo README for the canonical fix (configure Pub/Sub OIDC auth on
// the GCP side and unset the override).
function checkProductionPubsubAuth(cfg: { env: string; requirePubsubAuth: boolean }): void {
  if (cfg.env !== 'production' || cfg.requirePubsubAuth !== false) return;

  const banner = (msg: string): void => {
    // eslint-disable-next-line no-console
    console.error(
      '\n' +
        '!!! '.repeat(20) + '\n' +
        '!!! INSECURE CONFIG: ' + msg + '\n' +
        '!!! '.repeat(20),
    );
  };

  const warningMessage =
    'REQUIRE_PUBSUB_AUTH=false in production. The Gmail push webhook is ' +
    'accepting unauthenticated POSTs — forged Pub/Sub notifications can ' +
    'drive bounce, cancel, and reschedule flows. Configure GCP Pub/Sub ' +
    'OIDC auth (set GOOGLE_PUBSUB_AUDIENCE) and unset this override.';

  banner(warningMessage);

  // Keep yelling. A single startup line is too easy to scroll past;
  // recurring lines (every 10 minutes) keep the warning visible in the
  // log stream and pageable for monitoring tools.
  const RECUR_MS = 10 * 60 * 1000;
  const interval = setInterval(() => banner(warningMessage), RECUR_MS);
  // Don't keep the event loop alive solely for this timer.
  if (typeof interval.unref === 'function') interval.unref();
}

function loadConfig() {
  const rawConfig = {
    env: process.env.NODE_ENV,
    port: process.env.PORT,
    host: process.env.HOST,
    databaseUrl: process.env.DATABASE_URL,
    redisUrl: process.env.REDIS_URL,
    jwtSecret: process.env.JWT_SECRET,
    jwtExpiresIn: process.env.JWT_EXPIRES_IN,
    anthropicApiKey: process.env.ANTHROPIC_API_KEY,
    webhookSecret: process.env.WEBHOOK_SECRET,
    googlePubsubTopic: process.env.GOOGLE_PUBSUB_TOPIC,
    googlePubsubAudience: process.env.GOOGLE_PUBSUB_AUDIENCE,
    requirePubsubAuth: process.env.REQUIRE_PUBSUB_AUTH,
    rateLimitMax: process.env.RATE_LIMIT_MAX,
    rateLimitWindow: process.env.RATE_LIMIT_WINDOW,
    logLevel: process.env.LOG_LEVEL,
    sseHeartbeatInterval: process.env.SSE_HEARTBEAT_INTERVAL,
    sseMaxConnections: process.env.SSE_MAX_CONNECTIONS,
    cors: {
      // In production, require explicit CORS_ORIGIN to prevent CSRF attacks
      // In development, allow all origins for easier testing
      origin: process.env.CORS_ORIGIN
        ? process.env.CORS_ORIGIN.split(',').map(s => s.trim())
        : (process.env.NODE_ENV === 'production' ? false : true),
      credentials: process.env.CORS_CREDENTIALS,
    },
    tokenBucket: {
      capacity: process.env.TOKEN_BUCKET_CAPACITY,
      refillRate: process.env.TOKEN_BUCKET_REFILL_RATE,
      refillInterval: process.env.TOKEN_BUCKET_REFILL_INTERVAL,
    },
    performanceMonitoring: {
      enabled: process.env.PERFORMANCE_MONITORING,
      logInterval: process.env.PERFORMANCE_LOG_INTERVAL,
      maxSamples: process.env.PERFORMANCE_MAX_SAMPLES,
      slowQueryThreshold: process.env.SLOW_QUERY_THRESHOLD,
      slowMessageThreshold: process.env.SLOW_MESSAGE_THRESHOLD,
      slowAIThreshold: process.env.SLOW_AI_THRESHOLD,
    },
    connections: {
      maxPerUser: process.env.MAX_CONNECTIONS_PER_USER,
      maxTotal: process.env.MAX_TOTAL_CONNECTIONS,
      timeout: process.env.CONNECTION_TIMEOUT,
    },
    timezone: process.env.TIMEZONE,
    backendUrl: process.env.BACKEND_URL,
    frontendUrl: process.env.FRONTEND_URL,
  };

  try {
    const parsed = configSchema.parse(rawConfig);
    // Run the production-mode pubsub-auth check AFTER successful parse —
    // it logs a recurring warning when the production override is set,
    // but does not abort startup. See checkProductionPubsubAuth above
    // for the security trade-off.
    checkProductionPubsubAuth(parsed);
    return parsed;
  } catch (error) {
    // NOTE: Using console.error here is intentional - logger depends on config,
    // so we can't use structured logging for config validation errors.
    // This runs at startup before any other services are initialized.
    console.error('Configuration validation failed:', error);
    process.exit(1);
  }
}

export const config = loadConfig();

export type Config = z.infer<typeof configSchema>;

// Re-export model configuration for convenience
export { CLAUDE_MODELS, MODEL_CONFIG } from './models';
export type { ClaudeModel, ModelConfigKey } from './models';



