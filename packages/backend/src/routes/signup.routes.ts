import { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import { z } from 'zod';
import { prisma } from '../utils/database';
import { logger } from '../utils/logger';
import { sendSuccess, Errors } from '../utils/response';
import { RATE_LIMITS } from '../constants';
import { getOrCreateUser } from '../utils/unique-id';
import { validateEmail } from '../utils/email-validator';

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

      const { name, email, priorTherapy, acknowledgedRealSession, agreedToFeedback } =
        validation.data;

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
        });
      }

      try {
        // Ensure the row exists with an odId. getOrCreateUser is idempotent —
        // re-signing-up with the same email updates the name and refreshes
        // the consent timestamps below. That's the desired UX: a second
        // signup form submission overwrites stale consent state.
        const user = await getOrCreateUser(email, name);

        const updated = await prisma.user.update({
          where: { id: user.id },
          data: {
            // Refresh name in case it changed since first booking
            name,
            priorTherapy,
            acknowledgedRealSession,
            agreedToFeedback,
            consentGivenAt: new Date(),
            signupSource: 'signup_form',
            // Auto-subscribe to weekly mailing list, matching the booking
            // flow's behaviour (Notion users are auto-subscribed on create).
            subscribed: true,
          },
          select: {
            id: true,
            odId: true,
            email: true,
            name: true,
            consentGivenAt: true,
          },
        });

        logger.info(
          { requestId, userId: updated.id, odId: updated.odId, email: updated.email },
          'User signup recorded',
        );

        return sendSuccess(
          reply,
          {
            id: updated.id,
            odId: updated.odId,
            email: updated.email,
            name: updated.name,
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
}
