/**
 * Shared Zod schemas + the last-message-preview helper used by the
 * admin appointment routes.
 *
 * Kept in one module so the same shapes back the two list endpoints
 * (dashboard + appointments-page), the two PATCH endpoints, and the
 * mutation endpoints (take-control, send-message). Each route file
 * imports only the schemas it needs.
 */

import { z } from 'zod';
import { PAGINATION } from '../../../constants';

/** Dashboard list (admin dashboard widget). */
export const listAppointmentsSchema = z.object({
  status: z
    .enum(['pending', 'contacted', 'negotiating', 'confirmed', 'cancelled', 'all'])
    .optional(),
  therapistId: z.string().optional(),
  dateFrom: z.string().optional(),
  dateTo: z.string().optional(),
  page: z.coerce.number().min(1).default(PAGINATION.DEFAULT_PAGE),
  limit: z.coerce.number().min(1).max(PAGINATION.MAX_LIMIT).default(PAGINATION.DEFAULT_LIMIT),
  sortBy: z.enum(['createdAt', 'updatedAt', 'status']).default('updatedAt'),
  sortOrder: z.enum(['asc', 'desc']).default('desc'),
});

/** Admin appointments-page list (supports comma-separated statuses + free-text search). */
export const listAllAppointmentsSchema = z.object({
  status: z.string().optional(),
  search: z.string().optional(),
  page: z.coerce.number().min(1).default(PAGINATION.DEFAULT_PAGE),
  limit: z.coerce.number().min(1).max(PAGINATION.MAX_LIMIT).default(PAGINATION.DEFAULT_LIMIT),
  sortBy: z.enum(['createdAt', 'updatedAt', 'status']).default('updatedAt'),
  sortOrder: z.enum(['asc', 'desc']).default('desc'),
});

export const takeControlSchema = z.object({
  adminId: z.string().min(1),
  reason: z.string().optional(),
});

export const sendMessageSchema = z.object({
  to: z.string().email(),
  subject: z.string().min(1),
  body: z.string().min(1),
  adminId: z.string().min(1),
});

/** PATCH /api/admin/dashboard/appointments/:id (requires human control). */
export const updateAppointmentSchema = z.object({
  status: z.enum([
    'pending',
    'contacted',
    'negotiating',
    'confirmed',
    'session_held',
    'feedback_requested',
    'completed',
    'cancelled',
  ]).optional(),
  confirmedDateTime: z.string().nullable().optional(),
  adminId: z.string().min(1),
  reason: z.string().optional(),
});

/** PATCH /api/admin/appointments/:id (no human-control requirement). */
export const adminUpdateSchema = updateAppointmentSchema;

/**
 * Build the lastMessagePreview field shape from a raw JSONB extraction.
 *
 * The dashboard list endpoint pulls the last conversation message's
 * role and a snippet of its content via Postgres JSONB ops (avoiding
 * a full conversationState blob load). This helper normalises the
 * row into the shape the API returns, collapsing assistant→agent,
 * dropping admin system notes (they're not "messages" in the
 * conversational sense), and trimming whitespace + bracketed system
 * markers from snippets.
 */
export function buildLastMessagePreview(
  row: { role: string | null; content: string | null } | undefined,
): { role: 'agent' | 'inbound' | 'admin'; snippet: string } | null {
  if (!row || !row.role || !row.content) return null;
  const trimmed = row.content.replace(/\s+/g, ' ').trim();
  if (!trimmed) return null;
  const role: 'agent' | 'inbound' | 'admin' =
    row.role === 'assistant' ? 'agent' : row.role === 'admin' ? 'admin' : 'inbound';
  return { role, snippet: trimmed };
}

/** Filter for the ceiling-tripped appointment subset. Centralised so
 *  the count + bulk-release endpoints stay in sync. */
export const CEILING_TRIPPED_WHERE = {
  humanControlEnabled: true,
  humanControlTakenBy: 'agent-flagged',
  humanControlReason: { contains: 'Tool execution ceiling reached' },
} as const;
