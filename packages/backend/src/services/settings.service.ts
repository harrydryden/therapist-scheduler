/**
 * Settings Service
 *
 * FIX #9: Extracted from admin-settings.routes.ts to fix dependency inversion.
 * Services should not import from route files. This module provides the
 * getSettingValue function for use by other services.
 *
 * The SETTING_DEFINITIONS remain in admin-settings.routes.ts since they
 * include route-specific metadata (labels, descriptions, validation).
 * This module re-exports from there.
 */

// Re-export getSettingValue and SettingKey from their canonical location.
// This provides a clean import path for services: '../services/settings.service'
// instead of importing from '../routes/admin-settings.routes'.
export { getSettingValue, getSettingValues, type SettingKey } from '../routes/admin-settings.routes';
