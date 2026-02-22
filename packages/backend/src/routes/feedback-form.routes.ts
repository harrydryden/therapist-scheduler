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
import { sanitizeFeedback, sanitizeName, sanitizeObject } from '../utils/input-sanitizer';
import { RATE_LIMITS } from '../constants';
import type { FormQuestion, FormConfig } from '@therapist-scheduler/shared/types/feedback';

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
  therapistName: z.string().min(1, 'Therapist name is required'),
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
      let config = await prisma.feedbackFormConfig.findUnique({
        where: { id: 'default' },
      });

      if (!config || !config.isActive) {
        return reply.status(404).send({ error: 'Feedback form not available' });
      }

      // Auto-populate if questions are empty or still the initial seed (version 0)
      const questions = config.questions as unknown[];
      const needsDefaults = !questions || !Array.isArray(questions) || questions.length === 0 || config.questionsVersion === 0;
      if (needsDefaults) {
        const { DEFAULT_QUESTIONS } = await import('./admin-forms.routes');
        config = await prisma.feedbackFormConfig.update({
          where: { id: 'default' },
          data: { questions: DEFAULT_QUESTIONS, requiresAuth: true, questionsVersion: 1 },
        });
      }

      const formConfig: FormConfig = {
        formName: config.formName,
        description: config.description,
        welcomeTitle: config.welcomeTitle,
        welcomeMessage: config.welcomeMessage,
        thankYouTitle: config.thankYouTitle,
        thankYouMessage: config.thankYouMessage,
        questions: config.questions as unknown as FormQuestion[],
        isActive: config.isActive,
      };

      return reply.send({ form: formConfig, prefilled: null });
    } catch (error) {
      logger.error({ error }, 'Failed to get feedback form config');
      return reply.status(500).send({ error: 'Failed to load form' });
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
        // Get form config
        let config = await prisma.feedbackFormConfig.findUnique({
          where: { id: 'default' },
        });

        if (!config || !config.isActive) {
          return reply.status(404).send({ error: 'Feedback form not available' });
        }

        // Auto-populate if questions are empty or still the initial seed (version 0)
        const questions = config.questions as unknown[];
        const needsDefaults = !questions || !Array.isArray(questions) || questions.length === 0 || config.questionsVersion === 0;
        if (needsDefaults) {
          const { DEFAULT_QUESTIONS } = await import('./admin-forms.routes');
          config = await prisma.feedbackFormConfig.update({
            where: { id: 'default' },
            data: { questions: DEFAULT_QUESTIONS, requiresAuth: true, questionsVersion: 1 },
          });
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
          questions: config.questions as unknown as FormQuestion[],
          isActive: config.isActive,
        };

        // If no appointment found, return form without prefilled data
        if (!appointment) {
          logger.warn({ splCode }, 'No appointment found for SPL code');
          return reply.send({
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
          return reply.status(400).send({
            error: 'Feedback already submitted',
            message: 'You have already submitted feedback for this session.',
          });
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

        return reply.send({ form: formConfig, prefilled });
      } catch (error) {
        logger.error({ error, splCode }, 'Failed to get feedback form with prefill');
        return reply.status(500).send({ error: 'Failed to load form' });
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
        return reply.status(400).send({
          error: 'Invalid form data',
          details: validation.error.issues,
        });
      }

      const { trackingCode, therapistName: rawTherapistName, responses: rawResponses } = validation.data;

      // Sanitize user inputs to prevent XSS and other injection attacks
      const therapistName = sanitizeName(rawTherapistName);
      const responses = sanitizeObject(rawResponses, {
        maxLength: 5000,
        allowNewlines: true,
        allowHtml: false,
      });

      // Extract scores from responses for easy querying
      const safetyScore =
        typeof responses.safety_comfort === 'number' ? responses.safety_comfort : null;
      const listenedToScore =
        typeof responses.listened_to === 'number' ? responses.listened_to : null;
      const professionalScore =
        typeof responses.professional === 'number' ? responses.professional : null;
      const understoodScore =
        typeof responses.understood === 'number' ? responses.understood : null;
      const wouldBookAgain =
        typeof responses.would_book_again === 'string'
          ? responses.would_book_again.toLowerCase()
          : null;
      const wouldBookAgainText =
        typeof responses.would_book_again_text === 'string'
          ? sanitizeFeedback(responses.would_book_again_text)
          : null;
      const wouldRecommend =
        typeof responses.would_recommend === 'string'
          ? responses.would_recommend.toLowerCase()
          : null;
      const wouldRecommendText =
        typeof responses.would_recommend_text === 'string'
          ? sanitizeFeedback(responses.would_recommend_text)
          : null;
      const sessionBenefits =
        typeof responses.session_benefits === 'string'
          ? sanitizeFeedback(responses.session_benefits)
          : null;
      const improvementSuggestions =
        typeof responses.improvement_suggestions === 'string'
          ? sanitizeFeedback(responses.improvement_suggestions)
          : null;
      const additionalComments =
        typeof responses.additional_comments === 'string'
          ? sanitizeFeedback(responses.additional_comments)
          : null;

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

        // Create feedback submission
        const submission = await tx.feedbackSubmission.create({
          data: {
            trackingCode: trackingCode?.toUpperCase() || null,
            appointmentRequestId: appointment?.id || null,
            userEmail: appointment?.userEmail || null,
            userName: appointment?.userName || null,
            therapistName: therapistName || appointment?.therapistName || 'Unknown',
            responses,
            safetyScore,
            listenedToScore,
            professionalScore,
            understoodScore,
            wouldBookAgain,
            wouldBookAgainText,
            wouldRecommend,
            wouldRecommendText,
            sessionBenefits,
            improvementSuggestions,
            additionalComments,
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

      // If linked to appointment, transition to completed using lifecycle service
      // This handles all side effects: Slack notification, Notion sync, audit trail

      // Fetch form config to get the configured scale max per question (avoids hardcoded /5)
      const formConfig = await prisma.feedbackFormConfig.findUnique({
        where: { id: 'default' },
        select: { questions: true },
      });
      const formQuestions = (formConfig?.questions as unknown as FormQuestion[]) || [];
      const scaleMaxByQuestionId = new Map<string, number>();
      for (const q of formQuestions) {
        if (q.type === 'scale' && q.scaleMax != null) {
          scaleMaxByQuestionId.set(q.id, q.scaleMax);
        }
      }

      const feedbackData: Record<string, string> = {};
      if (safetyScore !== null) feedbackData['Safety & Comfort'] = `${safetyScore}/${scaleMaxByQuestionId.get('safety_comfort') ?? 5}`;
      if (professionalScore !== null) feedbackData['Professionalism'] = `${professionalScore}/${scaleMaxByQuestionId.get('professional') ?? 5}`;
      if (listenedToScore !== null) feedbackData['Felt Listened To'] = `${listenedToScore}/${scaleMaxByQuestionId.get('listened_to') ?? 5}`;
      if (understoodScore !== null) feedbackData['Felt Understood'] = `${understoodScore}/${scaleMaxByQuestionId.get('understood') ?? 5}`;
      if (wouldBookAgain) feedbackData['Would Book Again'] = wouldBookAgain;
      if (wouldBookAgainText) feedbackData['Would Book Again (Detail)'] = wouldBookAgainText;
      if (wouldRecommend) feedbackData['Would Recommend'] = wouldRecommend;
      if (wouldRecommendText) feedbackData['Would Recommend (Detail)'] = wouldRecommendText;
      if (sessionBenefits) feedbackData['Session Benefits'] = sessionBenefits;
      if (improvementSuggestions) feedbackData['Improvement Suggestions'] = improvementSuggestions;
      if (additionalComments) feedbackData['Additional Comments'] = additionalComments;

      if (appointment) {
        try {
          const result = await appointmentLifecycleService.transitionToCompleted({
            appointmentId: appointment.id,
            source: 'system',
            note: `Feedback received (submission: ${submission.id})`,
            feedbackSubmissionId: submission.id,
            feedbackData,
          });
          logger.info({ appointmentId: appointment.id, skipped: result.skipped }, 'Appointment transitioned to completed after feedback');

          // If transition was skipped (already completed), the lifecycle service
          // won't send the Slack notification. Send it directly so feedback is always reported.
          if (result.skipped) {
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
        } catch (error) {
          // Log but don't fail the feedback submission.
          // Still send Slack notification so feedback isn't silently lost.
          logger.error({ error, appointmentId: appointment.id }, 'Failed to transition appointment to completed');
          runBackgroundTask(
            () => slackNotificationService.notifyAppointmentCompleted(
              appointment!.id,
              appointment!.userName,
              appointment!.therapistName,
              submission.id,
              feedbackData,
            ),
            { name: 'slack-notify-feedback-received-fallback', context: { appointmentId: appointment.id, submissionId: submission.id }, retry: true, maxRetries: 2 }
          );
        }
      }

      return reply.status(201).send({
        success: true,
        submissionId: submission.id,
        message: 'Thank you for your feedback!',
      });
    } catch (error) {
      // Handle duplicate feedback error from transaction
      if (error instanceof Error && error.message === 'DUPLICATE_FEEDBACK') {
        return reply.status(400).send({
          error: 'Feedback already submitted',
          message: 'You have already submitted feedback for this session.',
        });
      }
      logger.error({ error }, 'Failed to submit feedback');
      return reply.status(500).send({ error: 'Failed to submit feedback' });
    }
  });
}
