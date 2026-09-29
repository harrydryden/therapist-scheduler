import { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import { z } from 'zod';
import { prisma } from '../utils/database';
import { logger } from '../utils/logger';
import { sendSuccess, Errors } from '../utils/response';
import { RATE_LIMITS } from '../constants';
import { getOrCreateUser } from '../utils/unique-id';
import { validateEmail } from '../utils/email-validator';
import {
  findInvitationByToken,
  markAccepted,
} from '../services/signup-invitation.service';
import { slackNotificationService } from '../services/slack-notification.service';
import { issueWelcomeVoucher } from '../services/voucher-issuance.service';
import { consumeAddressQuota } from '../services/booking-verification.service';
import { normalizeEmail } from '../utils/email-equals';
import { parseCountryCode, DEFAULT_COUNTRY, UNSUPPORTED_COUNTRY_MESSAGE } from '@therapist-scheduler/shared';

/**
 * Public signup endpoint. Captures the consent + intake fields the public
 * /signup form collects and writes them to the User row in Postgres.
 *
 * This is independent of the booking flow: it doesn't create an
 * AppointmentRequest, doesn't pick a therapist, and doesn't email the user.
 * It simply populates the user database so admins can later see who has
 * signed up vs. who has only ever booked.
 */

const signupSchema = z.object({
  name: z.string().trim().min(1, 'Name is required').max(100),
  email: z.string().trim().email('Invalid email address').max(255),
  // Consent fields. The form requires the latter two to be true (the user
  // must acknowledge the session is real and agree to the feedback form),
  // and asks (without requiring) whether they have prior therapy experience.
  priorTherapy: z.boolean({
    required_error: 'Please indicate whether you have experienced therapy before',
  }),
  acknowledgedRealSession: z.literal(true, {
    errorMap: () => ({
      message: 'You must acknowledge this is a real therapy session before signing up',
    }),
  }),
  agreedToFeedback: z.literal(true, {
    errorMap: () => ({
      message: 'You must agree to complete the post-session feedback form',
    }),
  }),
  /**
   * Optional invitation token. When present, the signup is bound to a
   * specific pending invitation: the email must match the invited address
   * and the invitation is marked accepted.
   */
  invitationToken: z.string().trim().min(1).max(256).optional(),
  // Country code (UK, IE, US, etc — see shared/constants/countries.ts).
  // Drives the IANA timezone every email salutation/time block uses for
  // this user (resolveRecipientTimezone reads User.country). Defaults to
  // UK to match the column default — legacy users were stamped UK by the
  // 20260427 migration. Validated by the one shared validator every write
  // path uses; an unknown code is rejected, never stored.
  country: z
    .unknown()
    .optional()
    .transform((value, ctx) => {
      if (value === undefined) return DEFAULT_COUNTRY;
      const code = parseCountryCode(value);
      if (!code) {
        ctx.addIssue({ code: z.ZodIssueCode.custom, message: UNSUPPORTED_COUNTRY_MESSAGE });
        return z.NEVER;
      }
      return code;
    }),
  /**
   * Explicit opt-in to the weekly availability email. Unticked by default
   * on the form; `subscribed` is only ever set from a tick (see handler).
   */
  weeklyEmails: z.boolean().optional().default(false),
});

type SignupBody = z.infer<typeof signupSchema>;

export async function signupRoutes(fastify: FastifyInstance) {
  fastify.post<{ Body: SignupBody }>(
    '/api/signup',
    {
      config: {
        // Reuse the public-appointment rate limit (5/min). Same threat model:
        // public, unauthenticated, writes a row to the users table.
        rateLimit: {
          max: RATE_LIMITS.PUBLIC_APPOINTMENT_REQUEST.max,
          timeWindow: RATE_LIMITS.PUBLIC_APPOINTMENT_REQUEST.timeWindowMs,
          errorResponseBuilder: () => ({
            success: false,
            error: 'Too many signup attempts. Please wait a minute before trying again.',
          }),
        },
      },
    },
    async (request: FastifyRequest<{ Body: SignupBody }>, reply: FastifyReply) => {
      const requestId = request.id;

      const validation = signupSchema.safeParse(request.body);
      if (!validation.success) {
        return Errors.validationFailed(reply, validation.error.errors);
      }

      const {
        name,
        email,
        priorTherapy,
        acknowledgedRealSession,
        agreedToFeedback,
        invitationToken,
        country,
        weeklyEmails,
      } = validation.data;

      // If an invitation token is supplied, verify it before doing any
      // other work. Pre-checking lets us return a precise error and avoids
      // creating/updating a User row that we'd have to roll back.
      if (invitationToken) {
        const lookup = await findInvitationByToken(invitationToken);
        if (!lookup) {
          return reply.status(400).send({
            success: false,
            error: 'Invitation link is invalid or has been revoked.',
            code: 'INVITATION_INVALID',
          });
        }
        if (!lookup.redeemable) {
          const reasonMessage =
            lookup.reason === 'accepted'
              ? 'This invitation has already been used.'
              : lookup.reason === 'revoked'
                ? 'This invitation has been revoked.'
                : 'This invitation has expired.';
          return reply.status(400).send({
            success: false,
            error: reasonMessage,
            code: `INVITATION_${lookup.reason?.toUpperCase()}`,
          });
        }
        if (lookup.invitation.email.toLowerCase() !== email.toLowerCase().trim()) {
          return reply.status(400).send({
            success: false,
            error: 'Email address does not match the invitation. Use the email the invitation was sent to.',
            code: 'INVITATION_EMAIL_MISMATCH',
          });
        }
      }

      // Per-address cap on top of the per-IP route limit: every signup
      // emails a welcome voucher, so one address can't be flooded from
      // many IPs.
      const addressQuota = await consumeAddressQuota('signup', email);
      if (!addressQuota.allowed) {
        logger.warn({ requestId, retryAfter: addressQuota.retryAfterSeconds }, 'Per-address signup rate limit exceeded');
        reply.header('Retry-After', String(addressQuota.retryAfterSeconds));
        return reply.status(429).send({
          success: false,
          error: 'Too many signups for this email address. Please try again later, or check your inbox for the email we already sent.',
          code: 'ADDRESS_RATE_LIMITED',
          retryAfter: addressQuota.retryAfterSeconds,
        });
      }

      // Same email validation we run for booking: MX records, disposable
      // detection, typo suggestions. We don't want signups from bogus
      // addresses polluting the user database.
      const emailValidation = await validateEmail(email, {
        checkMx: true,
        blockDisposable: true,
        suggestTypos: true,
      });

      if (!emailValidation.isValid) {
        logger.info(
          { requestId, email, errors: emailValidation.errors },
          'Signup rejected: invalid email',
        );
        return reply.status(400).send({
          success: false,
          error: emailValidation.errors[0] || 'Invalid email address',
          details: emailValidation.errors,
          suggestions: emailValidation.suggestions,
          suggestedEmail: emailValidation.suggestedEmail ?? null,
        });
      }

      try {
        // Whether this signup creates the User row. Case-insensitive so a
        // legacy mixed-case row counts as existing (getOrCreateUser adopts
        // it rather than creating a new one).
        const preExisting = await prisma.user.findFirst({
          where: { email: { equals: normalizeEmail(email), mode: 'insensitive' } },
          select: { id: true, subscribed: true },
        });

        // Ensure the row exists with an odId. getOrCreateUser is idempotent —
        // re-signing-up with the same email updates the name and refreshes
        // the consent timestamps below. That's the desired UX: a second
        // signup form submission overwrites stale consent state. This runs
        // outside the consent+accept tx below: a fresh User row with no
        // consent flags is a normal pre-signup state, so committing it
        // independently is safe.
        const user = await getOrCreateUser(email, name, country);

        // Atomically commit the consent update AND (if invitation-bound)
        // the invitation acceptance. Previously these ran as two separate
        // writes — a crash between them left a fully-consented User row
        // alongside a `pending` invitation, which is hard to reconcile
        // after the fact. Serializable isn't needed here (the writes don't
        // depend on phantom-read-sensitive queries); the default isolation
        // plus markAccepted's atomic precondition is sufficient.
        const { updated, acceptResult } = await prisma.$transaction(
          async (tx) => {
            const updated = await tx.user.update({
              where: { id: user.id },
              data: {
                // Refresh name in case it changed since first booking
                name,
                // Refresh country too — a returning user signing up from a
                // new location should get times in their current zone.
                country,
                priorTherapy,
                acknowledgedRealSession,
                agreedToFeedback,
                consentGivenAt: new Date(),
                // Distinguish organic /signup-form completions from invitation
                // acceptances so the admin user filter can split conversion
                // attribution (a self-service signup vs. a prospect we invited).
                signupSource: invitationToken ? 'invitation' : 'signup_form',
                // Weekly-email consent comes only from the explicit opt-in
                // tick. A user this signup creates gets exactly what they
                // ticked (the column default would silently subscribe them).
                // An EXISTING user is never changed: this form is public
                // and unverified, so it must not be able to re-subscribe an
                // address that opted out (or unsubscribe one) — anyone who
                // knows the email could otherwise flip it.
                ...(preExisting ? {} : { subscribed: weeklyEmails }),
              },
              select: {
                id: true,
                odId: true,
                email: true,
                name: true,
                consentGivenAt: true,
              },
            });

            const acceptResult = invitationToken
              ? await markAccepted(
                  {
                    rawToken: invitationToken,
                    userId: updated.id,
                    email: updated.email,
                  },
                  tx,
                )
              : null;

            return { updated, acceptResult };
          },
          { timeout: 10_000 },
        );

        // Post-commit side effects. The accept-flip's outcome is observed
        // here AFTER commit so a Slack notification never fires for a tx
        // that ultimately rolled back.
        if (acceptResult && !acceptResult.accepted) {
          // The invitation slipped state between the pre-check and the
          // accept (e.g. admin revoked mid-flight). The signup itself
          // succeeded; we just log and continue.
          logger.warn(
            { requestId, email, reason: acceptResult.reason },
            'Invitation accept-flip failed after signup committed',
          );
        } else if (acceptResult?.accepted && acceptResult.invitation) {
          // Fire-and-forget Slack notification so admins see the
          // conversion in real time. Failure here doesn't affect the
          // signup outcome.
          slackNotificationService
            .notifyInvitationAccepted({
              invitationId: acceptResult.invitation.id,
              email: updated.email,
              name: updated.name,
              invitedBy: acceptResult.invitation.invitedBy,
            })
            .catch((err) => {
              logger.warn(
                { err, requestId, invitationId: acceptResult.invitation?.id },
                'Failed to send Slack notification for invitation acceptance',
              );
            });
        }

        // Fire-and-forget: issue the user's first booking voucher
        // immediately so they don't have to wait for the next weekly
        // tick to be able to book. Without this, freshly-signed-up
        // users with `voucher.required=true` are stranded for up to
        // a week. Failure here is logged loudly but does NOT fail
        // the signup — the admin-vouchers UI can re-issue manually.
        issueWelcomeVoucher({
          email: updated.email,
          name: updated.name,
          traceId: requestId,
          // Only an explicit opt-in may clear a previous weekly-mail opt-out
          // or strike count on the voucher tracking row.
          optedIn: weeklyEmails && (!preExisting || preExisting.subscribed),
        }).catch((err) => {
          logger.error(
            { err, requestId, userId: updated.id, email: updated.email },
            'Failed to issue welcome voucher (signup itself succeeded; admin can re-issue)',
          );
        });

        logger.info(
          { requestId, userId: updated.id, odId: updated.odId, email: updated.email, viaInvitation: !!invitationToken },
          'User signup recorded',
        );

        return sendSuccess(
          reply,
          {
            id: updated.id,
            odId: updated.odId,
            email: updated.email,
            name: updated.name,
            // What the weekly-email opt-in did (existing users are left as
            // they were, see above).
            weeklyEmails: preExisting ? preExisting.subscribed : weeklyEmails,
          },
          {
            statusCode: 201,
            message: 'Signup recorded. Welcome!',
          },
        );
      } catch (err) {
        logger.error({ err, requestId, email }, 'Failed to record signup');
        return Errors.internal(reply, 'Failed to record signup');
      }
    },
  );

  // GET /api/signup/invitation/:token
  //
  // Public endpoint used by the signup page to look up an invitation when
  // the URL has `?invite=<token>`. Returns the invitee's email/name only
  // when the token is currently redeemable, so the form can prefill and
  // lock the email field. For every non-redeemable case (malformed,
  // unknown, expired, revoked, accepted) the response is a uniform
  // 200 + { redeemable: false, reason: 'invalid' }.
  //
  // The 256-bit random token space makes brute force computationally
  // infeasible regardless of response shape, but uniform responses still
  // matter as defence-in-depth: a leaked token (HTTP referer, browser
  // history, screenshot) can't be probed to confirm it ever pointed at a
  // real invitation, so an attacker can't use the public endpoint as a
  // free oracle for "did Alice receive an invite?". HTTP status is also
  // uniform (200 always) so reverse-proxy logs don't leak presence either.
  fastify.get<{ Params: { token: string } }>(
    '/api/signup/invitation/:token',
    {
      config: {
        rateLimit: {
          max: RATE_LIMITS.PUBLIC_APPOINTMENT_REQUEST.max,
          timeWindow: RATE_LIMITS.PUBLIC_APPOINTMENT_REQUEST.timeWindowMs,
        },
      },
    },
    async (request, reply) => {
      const { token } = request.params;
      const lookup = await findInvitationByToken(token);
      if (!lookup || !lookup.redeemable) {
        return sendSuccess(reply, { redeemable: false, reason: 'invalid' as const });
      }

      return sendSuccess(reply, {
        redeemable: true as const,
        email: lookup.invitation.email,
        name: lookup.invitation.name,
        expiresAt: lookup.invitation.expiresAt.toISOString(),
      });
    },
  );
}
