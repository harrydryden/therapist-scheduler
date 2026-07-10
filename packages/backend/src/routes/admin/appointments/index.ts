/**
 * Admin appointment routes — top-level plugin.
 *
 * Registers all per-resource route groups under a single Fastify
 * plugin. The `verifyWebhookSecret` preHandler applies to every
 * route in this tree so individual handlers don't have to
 * re-state it.
 *
 * Two URL prefixes are served:
 *   - `/api/admin/dashboard/appointments/...`  — admin dashboard widget
 *   - `/api/admin/appointments/...`            — admin appointments page
 *
 * The split is historical (the dashboard came first; the
 * appointments page was added later with different concerns). Each
 * file documents which prefix it owns.
 */

import { FastifyInstance } from 'fastify';
import { verifyWebhookSecret } from '../../../middleware/auth';

import { dashboardListRoute } from './list-dashboard';
import { listAllRoute } from './list-all';
import { detailRoute } from './detail';
import { humanControlRoutes } from './human-control';
import { deleteRoute } from './delete';
import { patchDashboardRoute } from './patch-dashboard';
import { patchAdminRoute } from './patch-admin';
import { sendMessageRoute } from './send-message';
import { feedbackEmailRoute } from './feedback-email';
import { reRequestFeedbackRoute } from './re-request-feedback';
import { reprocessThreadRoute } from './reprocess-thread';
import { dropdownsRoutes } from './dropdowns';
import { actionClosureRoute } from './action-closure';

export async function adminAppointmentRoutes(fastify: FastifyInstance): Promise<void> {
  fastify.addHook('preHandler', verifyWebhookSecret);

  // List + detail (dashboard widget + appointments page).
  await fastify.register(dashboardListRoute);
  await fastify.register(detailRoute);
  await fastify.register(listAllRoute);

  // Mutations.
  await fastify.register(humanControlRoutes);
  await fastify.register(deleteRoute);
  await fastify.register(patchDashboardRoute);
  await fastify.register(patchAdminRoute);

  // Side-channel actions.
  await fastify.register(sendMessageRoute);
  await fastify.register(feedbackEmailRoute);
  await fastify.register(reRequestFeedbackRoute);
  await fastify.register(reprocessThreadRoute);
  await fastify.register(actionClosureRoute);

  // Dropdown data for the appointments page.
  await fastify.register(dropdownsRoutes);
}
