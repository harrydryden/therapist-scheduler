/**
 * Settings Service
 *
 * Central module for setting definitions, caching, and value retrieval.
 * All services that need setting values should import from this module.
 *
 * Architecture:
 *   settings.service.ts (this file) — definitions + cache + getSettingValue
 *   admin-settings.routes.ts          — HTTP routes that import from here
 *
 * Caching strategy (3-tier):
 *   1. In-memory Map  (30 s TTL) — avoids Redis round-trips
 *   2. Redis           (60 s TTL) — shared across server instances
 *   3. PostgreSQL                 — source of truth, falls back to hardcoded defaults
 */

import { prisma } from '../utils/database';
import { logger } from '../utils/logger';
import { cacheManager } from '../utils/redis';
import { subscribeToSettingsInvalidation } from '../utils/settings-pubsub';
import { SettingDefinition, SETTING_DEFINITIONS, SettingKey } from '../config/setting-definitions';
export { SettingDefinition, SETTING_DEFINITIONS, SettingKey };

// ============================================
// Cache Layer
// ============================================

const SETTINGS_CACHE_PREFIX = 'settings:';
const SETTINGS_CACHE_TTL = 60; // 1 minute Redis cache

const memoryCache = new Map<string, { value: unknown; expiresAt: number }>();
const MEMORY_CACHE_TTL_MS = 30_000; // 30 seconds

function memoryCacheGet<T>(key: string): T | undefined {
  const entry = memoryCache.get(key);
  if (!entry) return undefined;
  if (Date.now() > entry.expiresAt) {
    memoryCache.delete(key);
    return undefined;
  }
  return entry.value as T;
}

function memoryCacheSet(key: string, value: unknown): void {
  memoryCache.set(key, { value, expiresAt: Date.now() + MEMORY_CACHE_TTL_MS });
}

export function memoryCacheInvalidate(key: string): void {
  memoryCache.delete(key);
}

export function memoryCacheInvalidateAll(): void {
  memoryCache.clear();
}

// Subscribe at module load so peer instances' admin updates clear THIS
// instance's in-memory cache. Without this, a setting change took up to
// 30 s to propagate across instances (the memory-cache TTL); during that
// window, ops-critical toggles like `voucher.required` were inconsistent
// across the fleet. Test-env safe — `subscribeToSettingsInvalidation` is
// a no-op when Redis is unavailable.
subscribeToSettingsInvalidation((keys) => {
  for (const key of keys) memoryCache.delete(key);
});

// ============================================
// Public API
// ============================================

/**
 * Get a setting value from cache or database.
 * Returns the default value if not set.
 */
export async function getSettingValue<T>(key: SettingKey): Promise<T> {
  const definition = SETTING_DEFINITIONS[key];
  if (!definition) {
    throw new Error(`Unknown setting: ${key}`);
  }

  // Check in-memory cache first (avoids Redis round-trip)
  const memCached = memoryCacheGet<T>(key);
  if (memCached !== undefined) {
    return memCached;
  }

  try {
    // Try Redis cache
    const cached = await cacheManager.getJson<T>(`${SETTINGS_CACHE_PREFIX}${key}`);
    if (cached !== null) {
      memoryCacheSet(key, cached);
      return cached;
    }

    // Try database
    const setting = await prisma.systemSetting.findUnique({
      where: { id: key },
    });

    if (setting) {
      const value = JSON.parse(setting.value) as T;
      await cacheManager.setJson(`${SETTINGS_CACHE_PREFIX}${key}`, value, SETTINGS_CACHE_TTL);
      memoryCacheSet(key, value);
      return value;
    }

    // Return default (also cache it to avoid repeated DB misses)
    memoryCacheSet(key, definition.defaultValue);
    return definition.defaultValue as T;
  } catch (err) {
    logger.warn({ err, key }, 'Failed to get setting, using default');
    return definition.defaultValue as T;
  }
}

/**
 * Batch fetch multiple settings in a single DB query.
 * Returns a Map of key → value, falling back to defaults for missing keys.
 */
export async function getSettingValues<T = unknown>(keys: SettingKey[]): Promise<Map<SettingKey, T>> {
  const result = new Map<SettingKey, T>();
  const uncachedKeys: SettingKey[] = [];

  // Check in-memory cache first
  for (const key of keys) {
    const memCached = memoryCacheGet<T>(key);
    if (memCached !== undefined) {
      result.set(key, memCached);
    } else {
      uncachedKeys.push(key);
    }
  }

  if (uncachedKeys.length === 0) return result;

  try {
    // Single batch DB query for all uncached keys
    const settings = await prisma.systemSetting.findMany({
      where: { id: { in: uncachedKeys } },
    });

    const dbMap = new Map<string, string>(settings.map(s => [s.id, s.value]));

    for (const key of uncachedKeys) {
      const definition = SETTING_DEFINITIONS[key];
      const raw = dbMap.get(key);

      let value: T;
      if (raw !== undefined) {
        try {
          value = JSON.parse(raw) as T;
        } catch {
          value = definition.defaultValue as T;
        }
      } else {
        value = definition.defaultValue as T;
      }

      memoryCacheSet(key, value);
      result.set(key, value);
    }
  } catch (err) {
    // Fall back to defaults for all uncached keys
    logger.warn({ err, keyCount: uncachedKeys.length }, 'Batch settings fetch failed, using defaults');
    for (const key of uncachedKeys) {
      const definition = SETTING_DEFINITIONS[key];
      result.set(key, definition.defaultValue as T);
    }
  }

  return result;
}

/**
 * Get all settings for a category.
 * Uses a single batch DB query.
 */
export async function getCategorySettings(category: string): Promise<Record<string, unknown>> {
  const categoryKeys = Object.entries(SETTING_DEFINITIONS)
    .filter(([, def]) => def.category === category)
    .map(([key]) => key);

  if (categoryKeys.length === 0) return {};

  // Single batch query for all settings in this category
  const dbSettings = await prisma.systemSetting.findMany({
    where: { id: { in: categoryKeys } },
  });

  const dbMap = new Map<string, string>(dbSettings.map(s => [s.id, s.value]));
  const categorySettings: Record<string, unknown> = {};

  for (const key of categoryKeys) {
    const definition = SETTING_DEFINITIONS[key as SettingKey];
    const rawValue = dbMap.get(key);

    if (rawValue !== undefined) {
      try {
        const value = JSON.parse(rawValue);
        await cacheManager.setJson(`${SETTINGS_CACHE_PREFIX}${key}`, value, SETTINGS_CACHE_TTL);
        categorySettings[key] = value;
      } catch {
        categorySettings[key] = definition.defaultValue;
      }
    } else {
      categorySettings[key] = definition.defaultValue;
    }
  }

  return categorySettings;
}
