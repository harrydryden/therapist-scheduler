/**
 * Admin Dashboard Routes — Aggregation Module
 *
 * Registers the admin route modules that back the dashboard UI:
 *
 * - admin-appointments.routes.ts      — CRUD, status transitions, human control
 * - admin-appointment-create.routes.ts — Create (isolated to keep heavy imports
 *                                        out of the appointments CRUD file)
 * - admin-monitoring.routes.ts        — Stats, flagged therapists, data sync/
 *                                        backfill, SSE stream, queue health
 *
 * server.ts registers this aggregator plus:
 *   - adminContentRoutes     (knowledge + forms)
 *   - adminSettingsRoutes, adminWorkReportRoutes, adminVoucherRoutes
 *   - adminRoutes            (diagnostics — Gmail / Slack / weekly-mailing)
 */
import { FastifyInstance } from 'fastify';
import { adminAppointmentRoutes } from './admin/appointments';
import { adminAppointmentCreateRoutes } from './admin-appointment-create.routes';
import { adminMonitoringRoutes } from './admin-monitoring.routes';

export async function adminDashboardRoutes(fastify: FastifyInstance) {
  await fastify.register(adminAppointmentRoutes);
  await fastify.register(adminAppointmentCreateRoutes);
  await fastify.register(adminMonitoringRoutes);
}
