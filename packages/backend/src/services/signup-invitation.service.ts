/**
 * Signup invitation service.
 *
 * Manages the lifecycle of admin-issued one-time signup invitations:
 *
 *   pending  -> accepted (user signed up via the link)
 *            -> revoked  (admin manually cancelled)
 *            -> expired  (passively, when expires_at < now())
 *
 * The status is computed from the row's columns rather than stored
 * directly, so admins can never end up with a "stuck" invitation in an
 * inconsistent state.
 */

import type { Prisma } from '@prisma/client';
import { prisma } from '../utils/database';
import { logger } from '../utils/logger';
import { config } from '../config';
import {
  generateInvitationToken,
  hashInvitationToken,
  isWellFormedInvitationToken,
  buildInvitationUrl,
} from '../utils/invitation-token';
import { getSettingValues } from './settings.service';
import { renderTemplate } from '../utils/email-templates';
import { emailProcessingService } from '../services/email-processing.service';

export type InvitationStatus = 'pending' | 'accepted' | 'revoked' | 'expired';

export interface InvitationView {
  id: string;
  email: string;
  name: string | null;
  invitedBy: string;
  status: InvitationStatus;
  createdAt: Date;
  expiresAt: Date;
  acceptedAt: Date | null;
  acceptedUserId: string | null;
  revokedAt: Date | null;
  lastSentAt: Date;
  sendCount: number;
}

interface SignupInvitationRow {
  id: string;
  email: string;
  name: string | null;
  tokenHash: string;
  invitedBy: string;
  expiresAt: Date;
  acceptedAt: Date | null;
  acceptedUserId: string | null;
  revokedAt: Date | null;
  lastSentAt: Date;
  sendCount: number;
  createdAt: Date;
  updatedAt: Date;
}

/**
 * Compute invitation status from the row's columns. Centralised so the
 * admin list, public lookup, and metrics agree.
 */
export function computeStatus(row: Pick<SignupInvitationRow, 'acceptedAt' | 'revokedAt' | 'expiresAt'>, now: Date = new Date()): InvitationStatus {
  if (row.acceptedAt) return 'accepted';
  if (row.revokedAt) return 'revoked';
  if (row.expiresAt <= now) return 'expired';
  return 'pending';
}

function toView(row: SignupInvitationRow, now: Date = new Date()): InvitationView {
  return {
    id: row.id,
    email: row.email,
    name: row.name,
    invitedBy: row.invitedBy,
    status: computeStatus(row, now),
    createdAt: row.createdAt,
    expiresAt: row.expiresAt,
    acceptedAt: row.acceptedAt,
    acceptedUserId: row.acceptedUserId,
    revokedAt: row.revokedAt,
    lastSentAt: row.lastSentAt,
    sendCount: row.sendCount,
  };
}

interface CreateInvitationParams {
  email: string;
  name?: string | null;
  invitedBy: string;
  expiryDays: number;
}

interface CreateInvitationResult {
  invitation: InvitationView;
  /** Raw token; only available immediately after creation. */
  token: string;
  invitationUrl: string;
}

/**
 * Create a new pending invitation. If a pending invitation exists for the
 * same email, it's auto-revoked first so each prospect has at most one
 * live link at a time.
 */
export async function createInvitation(params: CreateInvitationParams): Promise<CreateInvitationResult> {
  const email = params.email.toLowerCase().trim();
  const { raw, hash } = generateInvitationToken();
  const expiresAt = new Date(Date.now() + params.expiryDays * 24 * 60 * 60 * 1000);
  const now = new Date();

  const created = await prisma.$transaction(async (tx) => {
    // Auto-revoke any active pending invitation for this email so the
    // admin doesn't accidentally hand out two valid links. Done inside
    // the transaction so a concurrent createInvitation can't race past
    // and leave both rows live.
    await tx.signupInvitation.updateMany({
      where: {
        email,
        acceptedAt: null,
        revokedAt: null,
        expiresAt: { gt: now },
      },
      data: { revokedAt: now },
    });

    return tx.signupInvitation.create({
      data: {
        email,
        name: params.name?.trim() || null,
        tokenHash: hash,
        invitedBy: params.invitedBy,
        expiresAt,
        // lastSentAt + sendCount default to "issued once at row creation".
      },
    });
  });

  return {
    invitation: toView(created, now),
    token: raw,
    invitationUrl: buildInvitationUrl(config.backendUrl, raw),
  };
}

interface FindInvitationByTokenResult {
  /** Sanitised view; never contains the token. */
  invitation: InvitationView;
  /** True if the invitation can be used to complete a signup right now. */
  redeemable: boolean;
  /** Reason it isn't redeemable, when redeemable is false. */
  reason?: 'accepted' | 'revoked' | 'expired';
}

/**
 * Look up an invitation by its raw token. Returns null for malformed
 * tokens or unknown hashes (avoids confirming whether a guessed token
 * exists by giving identical responses to both cases).
 */
export async function findInvitationByToken(rawToken: string): Promise<FindInvitationByTokenResult | null> {
  if (!isWellFormedInvitationToken(rawToken)) return null;
  const tokenHash = hashInvitationToken(rawToken);
  const row = await prisma.signupInvitation.findUnique({ where: { tokenHash } });
  if (!row) return null;

  const now = new Date();
  // Archived invitations are treated as non-redeemable. The archival job
  // only touches invites that were already expired or revoked, so this is
  // belt-and-braces, but it ensures an unarchive (manual recovery via SQL)
  // doesn't accidentally let an old token redeem.
  if (row.archivedAt) {
    return { invitation: toView(row, now), redeemable: false, reason: 'expired' };
  }
  const status = computeStatus(row, now);
  if (status === 'pending') {
    return { invitation: toView(row, now), redeemable: true };
  }
  return { invitation: toView(row, now), redeemable: false, reason: status };
}

interface MarkAcceptedParams {
  rawToken: string;
  userId: string;
  /** Caller-provided email of the signup; must match the invite to be honoured. */
  email: string;
}

interface MarkAcceptedResult {
  /** True if the invitation was marked accepted. False if it wasn't found, was already accepted, expired, revoked, or the email didn't match. */
  accepted: boolean;
  reason?: 'not-found' | 'email-mismatch' | 'already-accepted' | 'revoked' | 'expired';
  invitation?: InvitationView;
}

/**
 * Atomically mark an invitation as accepted. Uses an updateMany with a
 * full set of preconditions so concurrent signups can't double-accept the
 * same invitation.
 */
export async function markAccepted(params: MarkAcceptedParams): Promise<MarkAcceptedResult> {
  if (!isWellFormedInvitationToken(params.rawToken)) {
    return { accepted: false, reason: 'not-found' };
  }
  const tokenHash = hashInvitationToken(params.rawToken);

  // Look up first so we can return a precise reason on failure.
  const existing = await prisma.signupInvitation.findUnique({ where: { tokenHash } });
  if (!existing) return { accepted: false, reason: 'not-found' };

  const now = new Date();
  if (existing.acceptedAt) return { accepted: false, reason: 'already-accepted', invitation: toView(existing, now) };
  if (existing.revokedAt) return { accepted: false, reason: 'revoked', invitation: toView(existing, now) };
  if (existing.expiresAt <= now) return { accepted: false, reason: 'expired', invitation: toView(existing, now) };
  if (existing.archivedAt) return { accepted: false, reason: 'expired', invitation: toView(existing, now) };

  if (existing.email.toLowerCase() !== params.email.toLowerCase().trim()) {
    return { accepted: false, reason: 'email-mismatch', invitation: toView(existing, now) };
  }

  // Atomic precondition: only flip to accepted if still pending. updateMany
  // returns count=0 if the row was concurrently mutated, in which case we
  // re-fetch to surface the current state.
  const result = await prisma.signupInvitation.updateMany({
    where: {
      tokenHash,
      acceptedAt: null,
      revokedAt: null,
      archivedAt: null,
      expiresAt: { gt: now },
    },
    data: { acceptedAt: now, acceptedUserId: params.userId },
  });

  if (result.count === 0) {
    const racedRow = await prisma.signupInvitation.findUnique({ where: { tokenHash } });
    if (!racedRow) return { accepted: false, reason: 'not-found' };
    return {
      accepted: false,
      reason: racedRow.acceptedAt ? 'already-accepted' : racedRow.revokedAt ? 'revoked' : 'expired',
      invitation: toView(racedRow, now),
    };
  }

  const updated = await prisma.signupInvitation.findUnique({ where: { tokenHash } });
  return { accepted: true, invitation: updated ? toView(updated, now) : undefined };
}

/**
 * Mark a pending invitation as revoked. Idempotent: revoking an already-
 * revoked invitation is a no-op. Throws if the invitation doesn't exist
 * or is already accepted (acceptance is terminal — admin can't reverse it
 * here without a deeper migration).
 */
export async function revokeInvitation(id: string): Promise<InvitationView> {
  const existing = await prisma.signupInvitation.findUnique({ where: { id } });
  if (!existing) throw new Error('Invitation not found');
  if (existing.acceptedAt) throw new Error('Cannot revoke an already-accepted invitation');

  const now = new Date();
  if (existing.revokedAt) return toView(existing, now); // idempotent

  const updated = await prisma.signupInvitation.update({
    where: { id },
    data: { revokedAt: now },
  });
  return toView(updated, now);
}

interface ResendResult {
  invitation: InvitationView;
  invitationUrl: null;
  emailSent: boolean;
}

/**
 * Re-send the invitation email. Note: the URL itself can't be re-derived
 * (we never persisted the raw token) — so resend just emails a fresh
 * "your link is in the previous message" follow-up. If the original was
 * lost, the admin must revoke and create a new invitation.
 */
export async function resendInvitationEmail(id: string): Promise<ResendResult> {
  const row = await prisma.signupInvitation.findUnique({ where: { id } });
  if (!row) throw new Error('Invitation not found');

  const now = new Date();
  const status = computeStatus(row, now);
  if (status !== 'pending') {
    throw new Error(`Cannot resend a ${status} invitation; revoke and re-issue instead`);
  }

  // We can't include the raw token in the resend (it's not retrievable),
  // so the resend is a "did you receive our previous email?" nudge. Body
  // omits the URL.
  const settings = await getSettingValues<string>([
    'email.invitationSubject',
    'email.invitationBody',
  ]);
  const subjectTemplate = settings.get('email.invitationSubject') as string;
  const subject = renderTemplate(`Reminder: ${subjectTemplate}`, {
    recipientName: row.name || 'there',
  });
  const body =
    `Hi ${row.name || 'there'},\n\n` +
    `Just a reminder about your Spill therapy session invitation. ` +
    `Please use the original signup link sent to you previously. The link ` +
    `expires on ${row.expiresAt.toDateString()}.\n\n` +
    `If you can't find the original email, reply to this message and we'll ` +
    `issue a new invitation.`;

  let emailSent = false;
  try {
    await emailProcessingService.sendEmail({ to: row.email, subject, body });
    emailSent = true;
  } catch (err) {
    logger.error({ err, invitationId: id, email: row.email }, 'Failed to resend invitation email');
  }

  const updated = await prisma.signupInvitation.update({
    where: { id },
    data: { lastSentAt: now, sendCount: { increment: 1 } },
  });

  return { invitation: toView(updated, now), invitationUrl: null, emailSent };
}

interface SendInvitationEmailParams {
  email: string;
  recipientName: string | null;
  invitationUrl: string;
  expiresAt: Date;
}

/**
 * Send the initial invitation email. Called from the admin create endpoint
 * right after persisting the row. Returns whether the send succeeded; on
 * failure the caller still has the invitation record and can resend.
 */
export async function sendInvitationEmail(params: SendInvitationEmailParams): Promise<boolean> {
  const settings = await getSettingValues<string>([
    'email.invitationSubject',
    'email.invitationBody',
  ]);
  const subjectTemplate = settings.get('email.invitationSubject') as string;
  const bodyTemplate = settings.get('email.invitationBody') as string;

  const variables = {
    recipientName: params.recipientName || 'there',
    invitationUrl: params.invitationUrl,
    expiryDate: params.expiresAt.toDateString(),
  };

  const subject = renderTemplate(subjectTemplate, variables);
  const body = renderTemplate(bodyTemplate, variables);

  try {
    await emailProcessingService.sendEmail({ to: params.email, subject, body });
    return true;
  } catch (err) {
    logger.error({ err, email: params.email }, 'Failed to send invitation email');
    return false;
  }
}

export interface InvitationListFilters {
  status?: InvitationStatus | 'all';
  search?: string;
  page?: number;
  limit?: number;
  /**
   * Whether to include archived rows in the result. Default false: archived
   * invitations are hidden from the standard admin listing but the row
   * remains in the database for audit. Pass true to look for old data.
   */
  includeArchived?: boolean;
}

export interface InvitationListResult {
  items: InvitationView[];
  pagination: { page: number; limit: number; total: number; totalPages: number };
  summary: {
    total: number;
    pending: number;
    accepted: number;
    revoked: number;
    expired: number;
  };
}

/**
 * Paginated list with a status filter. Status is computed in code rather
 * than via a denormalised column, so we narrow the DB query as much as
 * possible (acceptedAt/revokedAt/expiresAt direct filters) before passing
 * it through.
 */
export async function listInvitations(filters: InvitationListFilters = {}): Promise<InvitationListResult> {
  const page = filters.page ?? 1;
  const limit = filters.limit ?? 50;
  const status = filters.status ?? 'all';
  const search = filters.search?.trim();
  const now = new Date();

  const where: Prisma.SignupInvitationWhereInput = {};
  if (!filters.includeArchived) {
    where.archivedAt = null;
  }
  if (search) {
    where.OR = [
      { email: { contains: search, mode: 'insensitive' } },
      { name: { contains: search, mode: 'insensitive' } },
    ];
  }
  if (status === 'pending') {
    where.acceptedAt = null;
    where.revokedAt = null;
    where.expiresAt = { gt: now };
  } else if (status === 'accepted') {
    where.acceptedAt = { not: null };
  } else if (status === 'revoked') {
    where.revokedAt = { not: null };
    where.acceptedAt = null;
  } else if (status === 'expired') {
    where.acceptedAt = null;
    where.revokedAt = null;
    where.expiresAt = { lte: now };
  }

  const [rows, total, summaryRaw] = await Promise.all([
    prisma.signupInvitation.findMany({
      where,
      orderBy: { createdAt: 'desc' },
      skip: (page - 1) * limit,
      take: limit,
    }),
    prisma.signupInvitation.count({ where }),
    // Summary across all non-archived rows (ignoring search/status filter)
    // so the badge counts stay stable as the admin narrows the view. We
    // intentionally drop archived rows so the total reflects "live" data
    // rather than an ever-growing audit count.
    prisma.$queryRaw<Array<{
      total: bigint;
      pending: bigint;
      accepted: bigint;
      revoked: bigint;
      expired: bigint;
    }>>`
      SELECT
        COUNT(*) AS total,
        COUNT(*) FILTER (
          WHERE accepted_at IS NULL AND revoked_at IS NULL AND expires_at > ${now}
        ) AS pending,
        COUNT(*) FILTER (WHERE accepted_at IS NOT NULL) AS accepted,
        COUNT(*) FILTER (WHERE revoked_at IS NOT NULL AND accepted_at IS NULL) AS revoked,
        COUNT(*) FILTER (
          WHERE accepted_at IS NULL AND revoked_at IS NULL AND expires_at <= ${now}
        ) AS expired
      FROM signup_invitations
      WHERE archived_at IS NULL
    `,
  ]);

  const summary = summaryRaw[0] ?? {
    total: 0n, pending: 0n, accepted: 0n, revoked: 0n, expired: 0n,
  };

  return {
    items: rows.map((r) => toView(r, now)),
    pagination: {
      page,
      limit,
      total,
      totalPages: Math.max(1, Math.ceil(total / limit)),
    },
    summary: {
      total: Number(summary.total),
      pending: Number(summary.pending),
      accepted: Number(summary.accepted),
      revoked: Number(summary.revoked),
      expired: Number(summary.expired),
    },
  };
}

// ============================================================================
// Lifecycle background operations: reminder emails + archival
// ============================================================================

/**
 * Find invitations whose pre-expiry reminder is due.
 *
 * Selects pending invitations that:
 *   - have not yet had a reminder sent (reminderSentAt IS NULL),
 *   - haven't been accepted, revoked, or archived,
 *   - aren't yet expired,
 *   - and whose expires_at falls within the next `reminderDaysBefore` days.
 *
 * Bounded by `take` so a backlog doesn't fan out into thousands of emails
 * in one tick. The caller (background service) loops via repeated ticks.
 */
export async function findInvitationsNeedingReminder(
  reminderDaysBefore: number,
  take: number = 50,
): Promise<InvitationView[]> {
  if (reminderDaysBefore <= 0) return [];
  const now = new Date();
  const reminderCutoff = new Date(now.getTime() + reminderDaysBefore * 24 * 60 * 60 * 1000);

  const rows = await prisma.signupInvitation.findMany({
    where: {
      acceptedAt: null,
      revokedAt: null,
      archivedAt: null,
      reminderSentAt: null,
      expiresAt: { gt: now, lte: reminderCutoff },
    },
    orderBy: { expiresAt: 'asc' },
    take,
  });

  return rows.map((r) => toView(r, now));
}

/**
 * Send the pre-expiry reminder email and stamp `reminder_sent_at`.
 * Stamping happens inside an updateMany with a precondition so concurrent
 * reminder ticks can't double-fire. If the row was concurrently mutated
 * (accepted, revoked, or already-reminded), the second tick is a no-op.
 *
 * Returns whether a reminder was actually sent.
 */
export async function sendInvitationReminder(invitationId: string): Promise<boolean> {
  const row = await prisma.signupInvitation.findUnique({ where: { id: invitationId } });
  if (!row) return false;

  const now = new Date();
  if (row.acceptedAt || row.revokedAt || row.archivedAt || row.expiresAt <= now) return false;
  if (row.reminderSentAt) return false;

  // Atomic claim: only the first caller to flip reminderSentAt actually
  // sends the email.
  const claimed = await prisma.signupInvitation.updateMany({
    where: {
      id: invitationId,
      acceptedAt: null,
      revokedAt: null,
      archivedAt: null,
      reminderSentAt: null,
      expiresAt: { gt: now },
    },
    data: { reminderSentAt: now },
  });
  if (claimed.count === 0) return false;

  const settings = await getSettingValues<string>([
    'email.invitationReminderSubject',
    'email.invitationReminderBody',
  ]);
  const subjectTemplate = settings.get('email.invitationReminderSubject') as string;
  const bodyTemplate = settings.get('email.invitationReminderBody') as string;

  const msPerDay = 24 * 60 * 60 * 1000;
  const daysRemaining = Math.max(0, Math.ceil((row.expiresAt.getTime() - now.getTime()) / msPerDay));
  const variables = {
    recipientName: row.name || 'there',
    daysRemaining: String(daysRemaining),
    expiryDate: row.expiresAt.toDateString(),
  };

  const subject = renderTemplate(subjectTemplate, variables);
  const body = renderTemplate(bodyTemplate, variables);

  try {
    await emailProcessingService.sendEmail({ to: row.email, subject, body });
    return true;
  } catch (err) {
    // Send failed but the claim has already stamped reminderSentAt — we
    // accept that one missed reminder rather than risk double-sending on
    // retry. Log loudly so an operator can intervene if it's systemic.
    logger.error(
      { err, invitationId, email: row.email },
      'Failed to send invitation reminder after claim — reminderSentAt is set, no retry will occur',
    );
    return false;
  }
}

/**
 * Archive expired and revoked invitations older than `olderThanDays`. Sets
 * `archivedAt` on matching rows; doesn't delete data. Accepted invitations
 * are kept indefinitely for conversion-history reporting.
 *
 * Returns the count of rows archived.
 */
export async function archiveOldInvitations(olderThanDays: number): Promise<number> {
  const cutoff = new Date(Date.now() - olderThanDays * 24 * 60 * 60 * 1000);
  const now = new Date();

  const result = await prisma.signupInvitation.updateMany({
    where: {
      archivedAt: null,
      acceptedAt: null,
      OR: [
        { revokedAt: { lt: cutoff } },
        // Expired = past expires_at AND not accepted AND not revoked.
        // Since acceptedAt is null at this point in the AND chain, this
        // captures expired rows whose expiry was more than olderThanDays
        // ago (so an admin had time to react).
        { revokedAt: null, expiresAt: { lt: cutoff } },
      ],
    },
    data: { archivedAt: now },
  });

  return result.count;
}
