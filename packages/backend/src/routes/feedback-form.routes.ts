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
import { sendSuccess, sendError, Errors } from '../utils/response';
import { RATE_LIMITS } from '../constants';
import { getOrCreateFeedbackFormConfig } from '../utils/feedback-form-config';
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
  fastify.get<{ Params: { splCode: string } }>(
    '/api/feedback/form/:splCode',
    {
      config: {
        rateLimit: {
          max: RATE_LIMITS.PUBLIC_APPOINTMENT_REQUEST.max,
          timeWindow: RATE_LIMITS.PUBLIC_APPOINTMENT_REQUEST.timeWindowMs,
          errorResponseBuilder: () => ({
            error: 'Too many requests. Please wait before trying again.',
          }),
        },
      },
    },
    async (request, reply) => {
      const { splCode } = request.params;

      try {
        const config = await getOrCreateFeedbackFormConfig();
        if (!config || !config.isActive) {
          return sendError(reply, 404, 'Feedback form not available');
        }

        // Look up appointment by tracking code
        // Find the most recent completed/confirmed appointment with this tracking code
        const appointment = await prisma.appointmentRequest.findFirst({
          where: {
            trackingCode: splCode.toUpperCase(),
            status: {
              in: ['confirmed', 'session_held', 'feedback_requested', 'completed'],
            },
          },
          orderBy: { confirmedAt: 'desc' },
          select: {
            id: true,
            userName: true,
            userEmail: true,
            therapistName: true,
            trackingCode: true,
          },
        });

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

        // If no appointment found, return form without prefilled data
        if (!appointment) {
          logger.warn({ splCode }, 'No appointment found for SPL code');
          return sendSuccess(reply, {
            form: formConfig,
            prefilled: null,
            warning: 'Could not find appointment for this code',
          });
        }

        // Check if feedback already submitted for this appointment
        const existingFeedback = await prisma.feedbackSubmission.findFirst({
          where: { appointmentRequestId: appointment.id },
        });

        if (existingFeedback) {
          return Errors.badRequest(reply, 'Feedback already submitted');
        }

        // FIX #2: Redact PII from prefilled data to prevent leaking via SPL code brute-force.
        // Only return what the feedback form needs: tracking code and therapist first name.
        const prefilled: PrefilledData = {
          trackingCode: appointment.trackingCode || splCode,
          userName: appointment.userName ? appointment.userName.split(' ')[0] : null,
          userEmail: '', // Redacted - not needed for form display
          therapistName: appointment.therapistName.split(' ')[0], // First name only
          appointmentId: appointment.id,
        };

        logger.info(
          { splCode, appointmentId: appointment.id },
          'Loaded feedback form with prefilled data'
        );

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

      const { trackingCode, therapistName: rawTherapistName, responses: rawResponses } = validation.data;

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

      // FIX: Use transaction to prevent TOCTOU race condition
      // Wrap appointment lookup, duplicate check, and create in a single transaction
      const result = await prisma.$transaction(async (tx) => {
        // Look up appointment if tracking code provided
        let appointment = null;
        if (trackingCode) {
          appointment = await tx.appointmentRequest.findFirst({
            where: {
              trackingCode: trackingCode.toUpperCase(),
              status: {
                in: ['confirmed', 'session_held', 'feedback_requested', 'completed'],
              },
            },
            orderBy: { confirmedAt: 'desc' },
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

      // Post-processing: build Slack data, transition appointment, notify.
      // Wrapped in its own try/catch so errors here never affect the client
      // and never prevent the Slack notification from firing.
      try {
        // Build compact Slack notification data from form questions + responses.
        // Full responses are always accessible via the admin forms dashboard.
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
            logger.info({ appointmentId: appointment.id, skipped: lifecycleResult.skipped }, 'Appointment transitioned to completed after feedback');
          } catch (lifecycleError) {
            // Log but don't fail the feedback submission.
            logger.error({ error: lifecycleError, appointmentId: appointment.id }, 'Failed to transition appointment to completed');
          }

          // Always send Slack notification directly from the form route so feedback
          // is never silently lost. Previously, the normal success path relied on the
          // lifecycle service's un-awaited fire-and-forget notifyCompleted() call,
          // which could silently fail. The notification dedup mechanism (120s window)
          // prevents duplicates if the lifecycle service also sends one.
          runBackgroundTask(
            () => slackNotificationService.notifyAppointmentCompleted(
              appointment!.id,
              appointment!.userName,
              appointment!.therapistName,
              submission.id,
              feedbackData,
            ),
            { name: 'slack-notify-feedback-received', context: { appointmentId: appointment.id, submissionId: submission.id }, retry: true, maxRetries: 2 }
          );
        }
      } catch (postError) {
        // Post-processing failed but feedback is already saved and response sent.
        // Still attempt Slack notification without feedback data so it's not silently lost.
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
