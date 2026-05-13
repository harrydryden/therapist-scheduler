/**
 * Feedback Form Routes
 *
 * Public API for the native feedback form system.
 * Replaces the Typeform integration with a built-in solution.
 *
 * Routes:
 * - GET /api/feedback/form - Get form configuration
 * - GET /api/feedback/form/:splCode - Get form config with pre-filled data from SPL code
 * - POST /api/feedback/submit - Submit feedback form
 */

import { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import { z } from 'zod';
import { prisma } from '../utils/database';
import { logger } from '../utils/logger';
import { appointmentLifecycleService } from '../services/appointment-lifecycle.service';
import { slackNotificationService } from '../services/slack-notification.service';
import { runBackgroundTask } from '../utils/background-task';
import { sanitizeName, sanitizeObject } from '../utils/input-sanitizer';
import { firstName } from '../utils/first-name';
import { sendSuccess, sendError, Errors } from '../utils/response';
import { RATE_LIMITS } from '../constants';
import { getOrCreateFeedbackFormConfig } from '../utils/feedback-form-config';
import { validateFeedbackToken } from '../utils/feedback-token';
import type { FormConfig } from '@therapist-scheduler/shared/types/feedback';
import { parseFormQuestions, validateResponses, buildFeedbackDataForSlack } from '@therapist-scheduler/shared/utils/form-utils';

interface PrefilledData {
  trackingCode: string;
  userName: string | null;
  userEmail: string;
  therapistName: string;
  appointmentId: string;
}

// ============================================
// Validation Schemas
// ============================================

const submitFeedbackSchema = z.object({
  trackingCode: z.string().optional(),
  // HMAC-signed proof that the submitter received our feedback email.
  // Required to transition the appointment to `completed`; without it,
  // the feedback row is still stored anonymously but the lifecycle
  // transition is skipped (and admin is alerted).
  feedbackToken: z.string().max(500).optional(),
  // therapistName may be empty for non-SPL submissions where no prefilled data
  // is available. The fallback chain at storage time resolves it:
  // submitted value → appointment.therapistName → 'Unknown'.
  therapistName: z.string().default(''),
  responses: z.record(z.string(), z.union([z.string(), z.number()])),
});

// ============================================
// Routes
// ============================================

export async function feedbackFormRoutes(fastify: FastifyInstance) {
  /**
   * GET /api/feedback/form
   * Get the feedback form configuration (no pre-fill)
   */
  fastify.get('/api/feedback/form', async (request: FastifyRequest, reply: FastifyReply) => {
    try {
      const config = await getOrCreateFeedbackFormConfig();
      if (!config || !config.isActive) {
        return sendError(reply, 404, 'Feedback form not available');
      }

      const formConfig: FormConfig = {
        formName: config.formName,
        description: config.description,
        welcomeTitle: config.welcomeTitle,
        welcomeMessage: config.welcomeMessage,
        thankYouTitle: config.thankYouTitle,
        thankYouMessage: config.thankYouMessage,
        questions: parseFormQuestions(config.questions),
        isActive: config.isActive,
        requireExplanationFor: (config.requireExplanationFor as string[]) ?? ['No', 'Unsure'],
      };

      return sendSuccess(reply, { form: formConfig, prefilled: null });
    } catch (error) {
      logger.error({ error }, 'Failed to get feedback form config');
      return Errors.internal(reply, 'Failed to load form');
    }
  });

  /**
   * GET /api/feedback/form/:splCode
   * Get the feedback form configuration with pre-filled data from SPL code
   */
  // FIX #2: Rate-limit SPL code lookups to prevent brute-force enumeration
  // SECURITY: Pre-fill data (user/therapist names) is only returned when
  // the request includes a valid HMAC-signed feedback token (`?fk=...`).
  // Without a token, the SPL code on its own is treated as untrusted and
  // we return the form config alone — the SPL is no longer a status oracle.
  fastify.get<{ Params: { splCode: string }; Querystring: { fk?: string } }>(
    '/api/feedback/form/:splCode',
    {
      config: {
        rateLimit: {
          max: RATE_LIMITS.PUBLIC_APPOINTMENT_REQUEST.max,
          timeWindow: RATE_LIMITS.PUBLIC_APPOINTMENT_REQUEST.timeWindowMs,
          errorResponseBuilder: () => ({
            success: false,
            error: 'Too many requests. Please wait before trying again.',
          }),
        },
      },
    },
    async (request, reply) => {
      const { splCode } = request.params;
      const { fk: feedbackToken } = request.query;

      try {
        const config = await getOrCreateFeedbackFormConfig();
        if (!config || !config.isActive) {
          return sendError(reply, 404, 'Feedback form not available');
        }

        const formConfig: FormConfig = {
          formName: config.formName,
          description: config.description,
          welcomeTitle: config.welcomeTitle,
          welcomeMessage: config.welcomeMessage,
          thankYouTitle: config.thankYouTitle,
          thankYouMessage: config.thankYouMessage,
          questions: parseFormQuestions(config.questions),
          isActive: config.isActive,
          requireExplanationFor: (config.requireExplanationFor as string[]) ?? ['No', 'Unsure'],
        };

        // Without a valid token, return form-only — never reveal whether
        // the SPL code exists or which appointment it points at.
        const tokenPayload = feedbackToken ? validateFeedbackToken(feedbackToken) : null;
        if (!tokenPayload || tokenPayload.expired) {
          return sendSuccess(reply, { form: formConfig, prefilled: null });
        }

        // Look up appointment by ID from the verified token, then verify
        // the SPL code in the URL matches. Both must check out.
        const appointment = await prisma.appointmentRequest.findFirst({
          where: {
            id: tokenPayload.appointmentId,
            trackingCode: splCode.toUpperCase(),
            status: {
              in: ['confirmed', 'session_held', 'feedback_requested', 'completed'],
            },
          },
          select: {
            id: true,
            userName: true,
            userEmail: true,
            therapistName: true,
            trackingCode: true,
          },
        });

        if (!appointment) {
          logger.warn(
            { splCode, tokenAppointmentId: tokenPayload.appointmentId },
            'Feedback token did not match SPL code or appointment not eligible'
          );
          return sendSuccess(reply, { form: formConfig, prefilled: null });
        }

        const existingFeedback = await prisma.feedbackSubmission.findFirst({
          where: { appointmentRequestId: appointment.id },
        });
        if (existingFeedback) {
          return Errors.badRequest(reply, 'Feedback already submitted');
        }

        const prefilled: PrefilledData = {
          trackingCode: appointment.trackingCode || splCode,
          userName: appointment.userName ? firstName(appointment.userName) : null,
          userEmail: '',
          therapistName: firstName(appointment.therapistName),
          appointmentId: appointment.id,
        };

        return sendSuccess(reply, { form: formConfig, prefilled });
      } catch (error) {
        logger.error({ error, splCode }, 'Failed to get feedback form with prefill');
        return Errors.internal(reply, 'Failed to load form');
      }
    }
  );

  /**
   * POST /api/feedback/submit
   * Submit feedback form responses
   */
  // FIX #16: Rate-limit feedback submissions to prevent abuse
  fastify.post('/api/feedback/submit', {
    config: {
      rateLimit: {
        max: RATE_LIMITS.PUBLIC_APPOINTMENT_REQUEST.max,
        timeWindow: RATE_LIMITS.PUBLIC_APPOINTMENT_REQUEST.timeWindowMs,
        errorResponseBuilder: () => ({
          error: 'Too many submissions. Please wait before trying again.',
        }),
      },
    },
  }, async (request: FastifyRequest, reply: FastifyReply) => {
    try {
      const validation = submitFeedbackSchema.safeParse(request.body);

      if (!validation.success) {
        return Errors.badRequest(reply, 'Invalid form data', validation.error.issues);
      }

      const { trackingCode, feedbackToken, therapistName: rawTherapistName, responses: rawResponses } = validation.data;

      // Sanitize user inputs to prevent XSS and other injection attacks
      const therapistName = sanitizeName(rawTherapistName);
      const responses = sanitizeObject(rawResponses, {
        maxLength: 5000,
        allowNewlines: true,
        allowHtml: false,
      });

      // Get the current form version and config to record with the submission
      const formConfig = await prisma.feedbackFormConfig.findUnique({
        where: { id: 'default' },
        select: { questionsVersion: true, questions: true, requireExplanationFor: true },
      });
      const formVersion = formConfig?.questionsVersion ?? 0;

      // Server-side validation: enforce required fields and explanation text
      const requireExplanationFor = (formConfig?.requireExplanationFor as string[]) ?? ['No', 'Unsure'];
      const questions = parseFormQuestions(formConfig?.questions);
      if (questions.length > 0) {
        const validationError = validateResponses(responses, questions, requireExplanationFor);
        if (validationError) {
          return Errors.badRequest(reply, validationError);
        }
      }

      // SECURITY: Tracking codes have low entropy and arrive in user-clickable
      // emails — anyone who guesses one can submit feedback. Tying the
      // appointment-completion side effect to a verified HMAC token means
      // guessing alone can't drive the appointment to a terminal state or
      // produce a fake admin Slack alert with attacker-supplied content.
      const tokenPayload = feedbackToken ? validateFeedbackToken(feedbackToken) : null;
      const tokenIsValid = !!tokenPayload && !tokenPayload.expired;

      // FIX: Use transaction to prevent TOCTOU race condition
      // Wrap appointment lookup, duplicate check, and create in a single transaction
      const result = await prisma.$transaction(async (tx) => {
        // Look up appointment only when the token is valid AND its
        // appointment ID matches the submitted tracking code. Without
        // both, the submission is stored anonymously (no appointment
        // linkage, no lifecycle transition).
        let appointment = null;
        if (tokenIsValid && trackingCode) {
          appointment = await tx.appointmentRequest.findFirst({
            where: {
              id: tokenPayload!.appointmentId,
              trackingCode: trackingCode.toUpperCase(),
              status: {
                in: ['confirmed', 'session_held', 'feedback_requested', 'completed'],
              },
            },
            select: {
              id: true,
              userName: true,
              userEmail: true,
              therapistName: true,
            },
          });

          // Check for duplicate submission within transaction
          if (appointment) {
            const existingFeedback = await tx.feedbackSubmission.findFirst({
              where: { appointmentRequestId: appointment.id },
            });

            if (existingFeedback) {
              throw new Error('DUPLICATE_FEEDBACK');
            }
          }
        }

        // Create feedback submission - all data stored in JSONB responses column
        const submission = await tx.feedbackSubmission.create({
          data: {
            trackingCode: trackingCode?.toUpperCase() || null,
            appointmentRequestId: appointment?.id || null,
            userEmail: appointment?.userEmail || null,
            userName: appointment?.userName || null,
            therapistName: therapistName || appointment?.therapistName || 'Unknown',
            responses,
            formVersion,
          },
        });

        return { submission, appointment };
      });

      // Note: result is always non-null here. The transaction either returns a value
      // or throws (e.g., Error('DUPLICATE_FEEDBACK')), handled by the catch block below.
      const { submission, appointment } = result;

      logger.info(
        {
          submissionId: submission.id,
          trackingCode,
          appointmentId: appointment?.id,
          therapistName,
        },
        'Feedback submitted successfully'
      );

      // Send success response immediately — feedback is safely stored.
      // Post-processing (feedbackData building, lifecycle transition, Slack)
      // must not affect the client response.
      sendSuccess(reply, { submissionId: submission.id }, { statusCode: 201, message: 'Thank you for your feedback!' });

      // Audit: flag submissions that supplied a tracking code but no valid
      // token. These are either legitimate users on stale emails (issued
      // before we added tokens) or attempted enumeration attacks. The
      // submission is preserved for review but the appointment isn't moved.
      if (trackingCode && !tokenIsValid) {
        logger.warn(
          { submissionId: submission.id, trackingCode, hadToken: !!feedbackToken },
          'Feedback submitted with tracking code but missing/invalid token — admin review'
        );
        runBackgroundTask(
          () => slackNotificationService.sendAlert({
            title: 'Feedback submitted without valid token',
            severity: 'low',
            details:
              `A feedback submission referenced a tracking code but no valid HMAC token. ` +
              `Submission stored anonymously; appointment was NOT auto-completed.`,
            additionalFields: {
              'Submission ID': submission.id,
              'Tracking code': trackingCode,
              'Had token': feedbackToken ? 'yes (invalid/expired)' : 'no',
            },
          }),
          {
            name: 'slack-feedback-token-missing',
            context: { submissionId: submission.id },
          },
        );
      }

      // Post-processing: build Slack data, transition appointment.
      // The lifecycle service fires the Slack notification (now persistently
      // tracked via side-effect-tracker, so the retry runner picks up Slack
      // failures across restarts). We only fire a fallback Slack here in the
      // catch path where the lifecycle transition itself threw — in that case
      // notifyCompleted never ran and the feedback would otherwise be silent.
      let feedbackTransitioned = false;
      try {
        const feedbackData = buildFeedbackDataForSlack(
          parseFormQuestions(formConfig?.questions),
          responses,
        );

        if (appointment) {
          try {
            const lifecycleResult = await appointmentLifecycleService.transitionToCompleted({
              appointmentId: appointment.id,
              source: 'system',
              note: `Feedback received (submission: ${submission.id})`,
              feedbackSubmissionId: submission.id,
              feedbackData,
            });
            feedbackTransitioned = true;
            logger.info(
              { appointmentId: appointment.id, skipped: lifecycleResult.skipped },
              'Appointment transitioned to completed after feedback'
            );
          } catch (lifecycleError) {
            // Lifecycle transition failed; fire fallback Slack below so the
            // feedback isn't silently lost. The feedback row itself is already
            // committed by this point.
            logger.error(
              { error: lifecycleError, appointmentId: appointment.id },
              'Failed to transition appointment to completed'
            );
          }
        }

        if (appointment && !feedbackTransitioned) {
          runBackgroundTask(
            () => slackNotificationService.notifyAppointmentCompleted(
              appointment!.id,
              appointment!.userName,
              appointment!.therapistName,
              submission.id,
              feedbackData,
            ),
            {
              name: 'slack-notify-feedback-fallback-transition-failed',
              context: { appointmentId: appointment.id, submissionId: submission.id },
              retry: true,
              maxRetries: 2,
            },
          );
        }
      } catch (postError) {
        // Building feedbackData / parsing form config blew up — feedback is
        // already saved and the client response is already sent. Fire a
        // minimal Slack so the team knows feedback arrived.
        logger.error({ error: postError, submissionId: submission.id, appointmentId: appointment?.id }, 'Post-submission processing failed');
        if (appointment) {
          runBackgroundTask(
            () => slackNotificationService.notifyAppointmentCompleted(
              appointment!.id,
              appointment!.userName,
              appointment!.therapistName,
              submission.id,
            ),
            { name: 'slack-notify-feedback-fallback', context: { appointmentId: appointment.id, submissionId: submission.id }, retry: true, maxRetries: 2 }
          );
        }
      }

      return reply;
    } catch (error) {
      // Handle duplicate feedback error from transaction
      if (error instanceof Error && error.message === 'DUPLICATE_FEEDBACK') {
        return Errors.badRequest(reply, 'Feedback already submitted');
      }
      logger.error({ error }, 'Failed to submit feedback');
      return Errors.internal(reply, 'Failed to submit feedback');
    }
  });
}
