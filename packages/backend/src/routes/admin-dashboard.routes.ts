/**
 * Admin Dashboard Routes — Aggregation Module
 *
 * FIX #10: Decomposed from a single 1500-line file into focused modules:
 * - admin-appointments.routes.ts  — CRUD, status transitions, human control
 * - admin-therapists.routes.ts    — Flagged therapist management
 * - admin-stats.routes.ts         — Dashboard summary statistics
 * - admin-data.routes.ts          — Sync, backfill, and migration utilities
 *
 * This file registers all sub-modules under a single Fastify plugin
 * so that server.ts can continue importing `adminDashboardRoutes`.
 */
import { FastifyInstance } from 'fastify';
import { adminAppointmentRoutes } from './admin-appointments.routes';
import { adminAppointmentCreateRoutes } from './admin-appointment-create.routes';
import { adminTherapistRoutes } from './admin-therapists.routes';
import { adminStatsRoutes } from './admin-stats.routes';
import { adminDataRoutes } from './admin-data.routes';

export async function adminDashboardRoutes(fastify: FastifyInstance) {
  await fastify.register(adminAppointmentRoutes);
  await fastify.register(adminAppointmentCreateRoutes);
  await fastify.register(adminTherapistRoutes);
  await fastify.register(adminStatsRoutes);
  await fastify.register(adminDataRoutes);
}
