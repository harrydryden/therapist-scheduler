import { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import { z } from 'zod';
import { prisma } from '../utils/database';
import { logger } from '../utils/logger';
import { verifyWebhookSecret } from '../middleware/auth';
import { RATE_LIMITS } from '../constants';
import { cacheManager } from '../utils/redis';
import { adminNotificationService } from '../services/admin-notification.service';
import {
  SETTING_DEFINITIONS,
  type SettingKey,
  type SettingDefinition,
  getSettingValue,
  getCategorySettings,
  memoryCacheInvalidate,
  memoryCacheInvalidateAll,
} from '../services/settings.service';

// Re-export for existing consumers that import from this file
export { getSettingValue, getSettingValues, getCategorySettings, type SettingKey } from '../services/settings.service';

// Cache key prefix (must match settings.service.ts)
const SETTINGS_CACHE_PREFIX = 'settings:';

// Maximum string value size for settings (prevents excessive memory/DB usage)
const MAX_SETTING_STRING_LENGTH = 50 * 1024; // 50KB max for string settings

// Validation schema for updating a setting
const updateSettingSchema = z.object({
  value: z.union([z.string().max(MAX_SETTING_STRING_LENGTH), z.number(), z.boolean()]),
  adminId: z.string().min(1).max(255),
});

// Validation schema for bulk update
const bulkUpdateSchema = z.object({
  settings: z.array(z.object({
    key: z.string().max(255),
    value: z.union([z.string().max(MAX_SETTING_STRING_LENGTH), z.number(), z.boolean()]),
  })).max(50),
  adminId: z.string().min(1).max(255),
});

export async function adminSettingsRoutes(fastify: FastifyInstance) {
  // Auth middleware - require webhook secret for admin access
  fastify.addHook('preHandler', verifyWebhookSecret);

  /**
   * GET /api/admin/settings
   * Get all settings with their current values and metadata
   */
  fastify.get('/api/admin/settings', async (request: FastifyRequest, reply: FastifyReply) => {
    const requestId = request.id;
    logger.info({ requestId }, 'Fetching all settings');

    try {
      // Get all stored settings
      const storedSettings = await prisma.systemSetting.findMany();
      const storedMap = new Map(storedSettings.map(s => [s.id, s as { id: string; value: string; updatedAt: Date; updatedBy: string | null }]));

      // Build response with all settings including defaults
      const settings = await Promise.all(
        Object.entries(SETTING_DEFINITIONS).map(async ([key, definition]) => {
          const stored = storedMap.get(key);
          const currentValue = stored
            ? JSON.parse(stored.value)
            : definition.defaultValue;

          return {
            key,
            value: currentValue,
            ...definition,
            isDefault: !stored,
            updatedAt: stored?.updatedAt ?? null,
            updatedBy: stored?.updatedBy ?? null,
          };
        })
      );

      // Group by category
      const grouped = settings.reduce((acc, setting) => {
        if (!acc[setting.category]) {
          acc[setting.category] = [];
        }
        acc[setting.category].push(setting);
        return acc;
      }, {} as Record<string, typeof settings>);

      return reply.send({
        success: true,
        data: {
          settings,
          grouped,
          categories: [...new Set(Object.values(SETTING_DEFINITIONS).map(d => d.category))],
        },
      });
    } catch (err) {
      logger.error({ err, requestId }, 'Failed to fetch settings');
      return reply.status(500).send({
        success: false,
        error: 'Failed to fetch settings',
      });
    }
  });

  /**
   * GET /api/admin/settings/:key
   * Get a single setting by key
   */
  fastify.get<{ Params: { key: string } }>(
    '/api/admin/settings/:key',
    async (request: FastifyRequest<{ Params: { key: string } }>, reply: FastifyReply) => {
      const { key } = request.params;
      const requestId = request.id;

      const definition = SETTING_DEFINITIONS[key as SettingKey];
      if (!definition) {
        return reply.status(404).send({
          success: false,
          error: 'Setting not found',
        });
      }

      try {
        const stored = await prisma.systemSetting.findUnique({
          where: { id: key },
        });

        const currentValue = stored
          ? JSON.parse(stored.value)
          : definition.defaultValue;

        return reply.send({
          success: true,
          data: {
            key,
            value: currentValue,
            ...definition,
            isDefault: !stored,
            updatedAt: stored?.updatedAt || null,
            updatedBy: stored?.updatedBy || null,
          },
        });
      } catch (err) {
        logger.error({ err, requestId, key }, 'Failed to fetch setting');
        return reply.status(500).send({
          success: false,
          error: 'Failed to fetch setting',
        });
      }
    }
  );

  /**
   * PUT /api/admin/settings/:key
   * Update a single setting
   */
  fastify.put<{ Params: { key: string } }>(
    '/api/admin/settings/:key',
    {
      config: {
        rateLimit: {
          max: RATE_LIMITS.ADMIN_MUTATIONS.max,
          timeWindow: RATE_LIMITS.ADMIN_MUTATIONS.timeWindowMs,
        },
      },
    },
    async (request: FastifyRequest<{ Params: { key: string } }>, reply: FastifyReply) => {
      const { key } = request.params;
      const requestId = request.id;

      const definition = SETTING_DEFINITIONS[key as SettingKey];
      if (!definition) {
        return reply.status(404).send({
          success: false,
          error: 'Setting not found',
        });
      }

      const validation = updateSettingSchema.safeParse(request.body);
      if (!validation.success) {
        return reply.status(400).send({
          success: false,
          error: 'Invalid request body',
          details: validation.error.errors,
        });
      }

      const { value, adminId } = validation.data;

      // Validate value type and range
      if (definition.valueType === 'number') {
        const numValue = Number(value);
        if (isNaN(numValue)) {
          return reply.status(400).send({
            success: false,
            error: 'Value must be a number',
          });
        }
        if (definition.minValue !== undefined && numValue < definition.minValue) {
          return reply.status(400).send({
            success: false,
            error: `Value must be at least ${definition.minValue}`,
          });
        }
        if (definition.maxValue !== undefined && numValue > definition.maxValue) {
          return reply.status(400).send({
            success: false,
            error: `Value must be at most ${definition.maxValue}`,
          });
        }
      }

      // Validate allowedValues for string settings with restricted options
      if (definition.valueType === 'string' && definition.allowedValues) {
        const strValue = String(value);
        if (!definition.allowedValues.includes(strValue)) {
          return reply.status(400).send({
            success: false,
            error: `Value must be one of: ${definition.allowedValues.join(', ')}`,
          });
        }
      }

      try {
        // Invalidate both in-memory and Redis cache BEFORE write
        memoryCacheInvalidate(key);
        await cacheManager.delete(`${SETTINGS_CACHE_PREFIX}${key}`);

        const setting = await prisma.systemSetting.upsert({
          where: { id: key },
          create: {
            id: key,
            value: JSON.stringify(value),
            category: definition.category,
            label: definition.label,
            description: definition.description || null,
            valueType: definition.valueType,
            minValue: definition.minValue || null,
            maxValue: definition.maxValue || null,
            defaultValue: JSON.stringify(definition.defaultValue),
            updatedBy: adminId,
          },
          update: {
            value: JSON.stringify(value),
            updatedBy: adminId,
          },
        });

        // Double-invalidate after write to ensure consistency
        memoryCacheInvalidate(key);
        await cacheManager.delete(`${SETTINGS_CACHE_PREFIX}${key}`);

        logger.info({ requestId, key, value, adminId }, 'Setting updated');

        return reply.send({
          success: true,
          data: {
            key,
            value,
            updatedAt: setting.updatedAt,
            updatedBy: setting.updatedBy,
          },
        });
      } catch (err) {
        logger.error({ err, requestId, key }, 'Failed to update setting');
        return reply.status(500).send({
          success: false,
          error: 'Failed to update setting',
        });
      }
    }
  );

  /**
   * PUT /api/admin/settings
   * Bulk update multiple settings
   */
  fastify.put(
    '/api/admin/settings',
    {
      config: {
        rateLimit: {
          max: RATE_LIMITS.ADMIN_MUTATIONS.max,
          timeWindow: RATE_LIMITS.ADMIN_MUTATIONS.timeWindowMs,
        },
      },
    },
    async (request: FastifyRequest, reply: FastifyReply) => {
      const requestId = request.id;

      const validation = bulkUpdateSchema.safeParse(request.body);
      if (!validation.success) {
        return reply.status(400).send({
          success: false,
          error: 'Invalid request body',
          details: validation.error.errors,
        });
      }

      const { settings, adminId } = validation.data;

      // Validate all settings first
      const errors: Array<{ key: string; error: string }> = [];
      for (const { key, value } of settings) {
        const definition = SETTING_DEFINITIONS[key as SettingKey];
        if (!definition) {
          errors.push({ key, error: 'Unknown setting' });
          continue;
        }

        if (definition.valueType === 'number') {
          const numValue = Number(value);
          if (isNaN(numValue)) {
            errors.push({ key, error: 'Value must be a number' });
          } else if (definition.minValue !== undefined && numValue < definition.minValue) {
            errors.push({ key, error: `Value must be at least ${definition.minValue}` });
          } else if (definition.maxValue !== undefined && numValue > definition.maxValue) {
            errors.push({ key, error: `Value must be at most ${definition.maxValue}` });
          }
        }

        // Validate allowedValues for string settings with restricted options
        if (definition.valueType === 'string' && definition.allowedValues) {
          const strValue = String(value);
          if (!definition.allowedValues.includes(strValue)) {
            errors.push({ key, error: `Value must be one of: ${definition.allowedValues.join(', ')}` });
          }
        }
      }

      if (errors.length > 0) {
        return reply.status(400).send({
          success: false,
          error: 'Validation failed',
          details: errors,
        });
      }

      try {
        // Invalidate in-memory cache for all keys
        for (const { key } of settings) memoryCacheInvalidate(key);

        // RACE CONDITION FIX: Invalidate Redis cache BEFORE write
        const preInvalidationResults = await Promise.allSettled(
          settings.map(({ key }) => cacheManager.delete(`${SETTINGS_CACHE_PREFIX}${key}`))
        );
        const preInvalidationFailures = preInvalidationResults.filter(r => r.status === 'rejected');
        if (preInvalidationFailures.length > 0) {
          logger.warn(
            { requestId, failures: preInvalidationFailures.length, total: settings.length },
            'Some cache pre-invalidations failed during bulk update'
          );
        }

        // Update all settings in a transaction
        const updated = await prisma.$transaction(
          settings.map(({ key, value }) => {
            const definition = SETTING_DEFINITIONS[key as SettingKey];
            return prisma.systemSetting.upsert({
              where: { id: key },
              create: {
                id: key,
                value: JSON.stringify(value),
                category: definition.category,
                label: definition.label,
                description: definition.description || null,
                valueType: definition.valueType,
                minValue: definition.minValue || null,
                maxValue: definition.maxValue || null,
                defaultValue: JSON.stringify(definition.defaultValue),
                updatedBy: adminId,
              },
              update: {
                value: JSON.stringify(value),
                updatedBy: adminId,
              },
            });
          })
        );

        // Double-invalidate after write
        for (const { key } of settings) memoryCacheInvalidate(key);
        const postInvalidationResults = await Promise.allSettled(
          settings.map(({ key }) => cacheManager.delete(`${SETTINGS_CACHE_PREFIX}${key}`))
        );
        const postInvalidationFailures = postInvalidationResults.filter(r => r.status === 'rejected');
        if (postInvalidationFailures.length > 0) {
          logger.warn(
            { requestId, failures: postInvalidationFailures.length, total: settings.length },
            'Some cache post-invalidations failed during bulk update'
          );
        }

        logger.info({ requestId, settingsCount: settings.length, adminId }, 'Bulk settings update');

        return reply.send({
          success: true,
          data: {
            updated: updated.length,
            settings: updated.map(s => ({
              key: s.id,
              value: JSON.parse(s.value),
              updatedAt: s.updatedAt,
            })),
          },
        });
      } catch (err) {
        logger.error({ err, requestId }, 'Failed to bulk update settings');
        return reply.status(500).send({
          success: false,
          error: 'Failed to update settings',
        });
      }
    }
  );

  /**
   * POST /api/admin/settings/:key/reset
   * Reset a setting to its default value
   */
  fastify.post<{ Params: { key: string } }>(
    '/api/admin/settings/:key/reset',
    {
      config: {
        rateLimit: {
          max: RATE_LIMITS.ADMIN_MUTATIONS.max,
          timeWindow: RATE_LIMITS.ADMIN_MUTATIONS.timeWindowMs,
        },
      },
    },
    async (request: FastifyRequest<{ Params: { key: string } }>, reply: FastifyReply) => {
      const { key } = request.params;
      const requestId = request.id;

      const definition = SETTING_DEFINITIONS[key as SettingKey];
      if (!definition) {
        return reply.status(404).send({
          success: false,
          error: 'Setting not found',
        });
      }

      try {
        // Invalidate both caches before delete
        memoryCacheInvalidate(key);
        await cacheManager.delete(`${SETTINGS_CACHE_PREFIX}${key}`);

        // Delete the custom setting (reverts to default)
        await prisma.systemSetting.delete({
          where: { id: key },
        }).catch(() => {
          // Ignore if doesn't exist
        });

        // Double-invalidate after delete
        memoryCacheInvalidate(key);
        await cacheManager.delete(`${SETTINGS_CACHE_PREFIX}${key}`);

        logger.info({ requestId, key, defaultValue: definition.defaultValue }, 'Setting reset to default');

        return reply.send({
          success: true,
          data: {
            key,
            value: definition.defaultValue,
            isDefault: true,
          },
        });
      } catch (err) {
        logger.error({ err, requestId, key }, 'Failed to reset setting');
        return reply.status(500).send({
          success: false,
          error: 'Failed to reset setting',
        });
      }
    }
  );

  // ==========================================
  // Admin Alert Endpoints (FIX TODO)
  // ==========================================

  /**
   * GET /api/admin/alerts
   * Get all unacknowledged alerts for admin dashboard
   */
  fastify.get('/api/admin/alerts', async (request: FastifyRequest, reply: FastifyReply) => {
    const requestId = request.id;
    logger.info({ requestId }, 'Fetching admin alerts');

    try {
      const alerts = await adminNotificationService.getUnacknowledgedAlerts();
      return reply.send({
        success: true,
        alerts,
        count: alerts.length,
      });
    } catch (error) {
      logger.error({ requestId, error }, 'Failed to get admin alerts');
      return reply.status(500).send({
        success: false,
        error: 'Failed to get alerts',
      });
    }
  });

  /**
   * GET /api/admin/alerts/count
   * Get count of unacknowledged alerts (for dashboard badge)
   */
  fastify.get('/api/admin/alerts/count', async (request: FastifyRequest, reply: FastifyReply) => {
    const requestId = request.id;

    try {
      const count = await adminNotificationService.getAlertCount();
      return reply.send({
        success: true,
        count,
      });
    } catch (error) {
      logger.error({ requestId, error }, 'Failed to get alert count');
      return reply.status(500).send({
        success: false,
        error: 'Failed to get alert count',
      });
    }
  });

  /**
   * POST /api/admin/alerts/:id/acknowledge
   * Acknowledge a specific alert
   */
  fastify.post<{
    Params: { id: string };
  }>('/api/admin/alerts/:id/acknowledge', async (request, reply) => {
    const requestId = request.id;
    const alertId = request.params.id;

    logger.info({ requestId, alertId }, 'Acknowledging admin alert');

    try {
      await adminNotificationService.acknowledgeAlert(alertId);
      return reply.send({
        success: true,
        message: 'Alert acknowledged',
      });
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : 'Unknown error';
      logger.error({ requestId, alertId, error: errorMessage }, 'Failed to acknowledge alert');
      return reply.status(400).send({
        success: false,
        error: errorMessage,
      });
    }
  });

  /**
   * POST /api/admin/alerts/acknowledge-all
   * Acknowledge all alerts of a specific type
   */
  fastify.post<{
    Body: { type: 'thread_divergence' | 'conversation_stall' | 'tool_failure' | 'therapist_alert' };
  }>('/api/admin/alerts/acknowledge-all', async (request, reply) => {
    const requestId = request.id;
    const { type } = request.body || {};

    if (!type) {
      return reply.status(400).send({
        success: false,
        error: 'Missing required field: type',
      });
    }

    logger.info({ requestId, type }, 'Acknowledging all alerts of type');

    try {
      const count = await adminNotificationService.acknowledgeAllByType(type);
      return reply.send({
        success: true,
        message: `Acknowledged ${count} alerts`,
        count,
      });
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : 'Unknown error';
      logger.error({ requestId, type, error: errorMessage }, 'Failed to acknowledge alerts');
      return reply.status(400).send({
        success: false,
        error: errorMessage,
      });
    }
  });

  // ==========================================
  // Health Status Endpoints
  // ==========================================

  /**
   * GET /api/admin/health
   * Get health status for all active conversations
   * Returns green/yellow/red status based on activity, progress, and issues
   */
  fastify.get('/api/admin/health', async (request: FastifyRequest, reply: FastifyReply) => {
    const requestId = request.id;
    logger.info({ requestId }, 'Fetching conversation health statuses');

    try {
      const healthData = await adminNotificationService.getConversationHealthStatuses();
      return reply.send({
        success: true,
        ...healthData,
      });
    } catch (error) {
      logger.error({ requestId, error }, 'Failed to get health statuses');
      return reply.status(500).send({
        success: false,
        error: 'Failed to get health statuses',
      });
    }
  });

  /**
   * GET /api/admin/health/:appointmentId
   * Get health status for a specific appointment
   */
  fastify.get<{
    Params: { appointmentId: string };
  }>('/api/admin/health/:appointmentId', async (request, reply) => {
    const requestId = request.id;
    const { appointmentId } = request.params;

    logger.info({ requestId, appointmentId }, 'Fetching appointment health status');

    try {
      const health = await adminNotificationService.getAppointmentHealth(appointmentId);

      if (!health) {
        return reply.status(404).send({
          success: false,
          error: 'Appointment not found',
        });
      }

      return reply.send({
        success: true,
        appointmentId,
        health,
      });
    } catch (error) {
      logger.error({ requestId, appointmentId, error }, 'Failed to get appointment health');
      return reply.status(500).send({
        success: false,
        error: 'Failed to get health status',
      });
    }
  });

  /**
   * GET /api/admin/dashboard/overview
   * Get combined dashboard data: alerts + health overview
   * Provides a unified view for the admin dashboard
   */
  fastify.get('/api/admin/dashboard/overview', async (request: FastifyRequest, reply: FastifyReply) => {
    const requestId = request.id;
    logger.info({ requestId }, 'Fetching dashboard overview');

    try {
      const overview = await adminNotificationService.getDashboardOverview();
      return reply.send({
        success: true,
        ...overview,
      });
    } catch (error) {
      logger.error({ requestId, error }, 'Failed to get dashboard overview');
      return reply.status(500).send({
        success: false,
        error: 'Failed to get dashboard overview',
      });
    }
  });
}

/**
 * Public settings routes - no authentication required
 * Only exposes frontend category settings
 */
export async function publicSettingsRoutes(fastify: FastifyInstance) {
  /**
   * GET /api/settings/frontend
   * Get all frontend settings (public, no auth required)
   */
  fastify.get(
    '/api/settings/frontend',
    {
      config: {
        rateLimit: {
          max: RATE_LIMITS.PUBLIC_THERAPIST_LIST.max,
          timeWindow: RATE_LIMITS.PUBLIC_THERAPIST_LIST.timeWindowMs,
        },
      },
    },
    async (request: FastifyRequest, reply: FastifyReply) => {
      const requestId = request.id;
      logger.debug({ requestId }, 'Fetching public frontend settings');

      try {
        // Get only frontend category settings
        const frontendSettings = await getCategorySettings('frontend');

        return reply.send({
          success: true,
          data: frontendSettings,
        });
      } catch (err) {
        logger.error({ err, requestId }, 'Failed to fetch frontend settings');
        return reply.status(500).send({
          success: false,
          error: 'Failed to fetch settings',
        });
      }
    }
  );

  /**
   * GET /api/settings/frontend/:key
   * Get a specific frontend setting (public, no auth required)
   */
  fastify.get<{ Params: { key: string } }>(
    '/api/settings/frontend/:key',
    {
      config: {
        rateLimit: {
          max: RATE_LIMITS.PUBLIC_THERAPIST_LIST.max,
          timeWindow: RATE_LIMITS.PUBLIC_THERAPIST_LIST.timeWindowMs,
        },
      },
    },
    async (request: FastifyRequest<{ Params: { key: string } }>, reply: FastifyReply) => {
      const { key } = request.params;
      const fullKey = `frontend.${key}`;
      const requestId = request.id;

      const definition = SETTING_DEFINITIONS[fullKey as SettingKey];

      // Only allow access to frontend category settings
      if (!definition || definition.category !== 'frontend') {
        return reply.status(404).send({
          success: false,
          error: 'Setting not found',
        });
      }

      try {
        const value = await getSettingValue(fullKey as SettingKey);

        return reply.send({
          success: true,
          data: {
            key: fullKey,
            value,
          },
        });
      } catch (err) {
        logger.error({ err, requestId, key: fullKey }, 'Failed to fetch frontend setting');
        return reply.status(500).send({
          success: false,
          error: 'Failed to fetch setting',
        });
      }
    }
  );
}
