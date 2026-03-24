/**
 * Redis Lua Scripts
 *
 * Centralized collection of Lua scripts used with Redis EVAL.
 * Lua scripts execute atomically on the Redis server, preventing
 * race conditions that would occur with separate read-check-write commands.
 */

/**
 * Lua script for atomic cleanup counter check-and-reset.
 * Prevents race condition where two instances both read >= threshold
 * and both run cleanup. Only the instance whose INCR crosses the
 * threshold resets the counter and gets permission to run cleanup.
 *
 * KEYS[1] = counter key
 * ARGV[1] = threshold
 * Returns: 1 if this instance should run cleanup, 0 otherwise
 */
export const CLEANUP_CHECK_AND_RESET_SCRIPT = `
local key = KEYS[1]
local threshold = tonumber(ARGV[1])
local current = redis.call('INCR', key)
if current >= threshold then
  redis.call('SET', key, '0')
  return 1
end
return 0
`;

/**
 * Lua script for atomic lock acquisition + processed-set check.
 * Combines two operations that must happen atomically to prevent
 * TOCTOU (time-of-check-to-time-of-use) race conditions:
 *   1. Check if the message was already processed (exists in ZSET)
 *   2. Try to acquire a distributed lock (SET NX EX)
 *
 * KEYS[1] = lock key (e.g., "email:lock:{messageId}")
 * KEYS[2] = processed messages ZSET key
 * ARGV[1] = message ID to check in the ZSET
 * ARGV[2] = trace ID used as the lock value (for ownership verification)
 * ARGV[3] = lock TTL in seconds
 *
 * Returns:
 * -  1: Lock acquired, message not previously processed
 * -  0: Already being processed by another worker (lock exists)
 * - -1: Already processed (message found in ZSET)
 */
export const ATOMIC_LOCK_CHECK_SCRIPT = `
local lockKey = KEYS[1]
local processedKey = KEYS[2]
local messageId = ARGV[1]
local traceId = ARGV[2]
local lockTtl = tonumber(ARGV[3])

-- Check if already processed first
local score = redis.call('ZSCORE', processedKey, messageId)
if score then
  return -1
end

-- Try to acquire lock
local lockResult = redis.call('SET', lockKey, traceId, 'NX', 'EX', lockTtl)
if lockResult then
  return 1
else
  return 0
end
`;
