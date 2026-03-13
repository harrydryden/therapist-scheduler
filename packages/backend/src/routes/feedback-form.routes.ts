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
        questions: config.questions as unknown as FormQuestion[],
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
          questions: config.questions as unknown as FormQuestion[],
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
      if (formConfig?.questions) {
        const questions = formConfig.questions as unknown as FormQuestion[];

        // Helper: check if a conditional question's condition is met
        const isConditionMet = (q: FormQuestion): boolean => {
          if (!q.conditionalOn) return true;
          const parentVal = responses[q.conditionalOn.questionId];
          if (typeof parentVal !== 'string') return false;
          return q.conditionalOn.values.some(
            (v) => v.toLowerCase() === parentVal.toLowerCase()
          );
        };

        for (const q of questions) {
          // Skip validation for conditional questions whose condition is not met
          if (!isConditionMet(q)) continue;

          // Validate required fields have a response
          if (q.required) {
            const val = responses[q.id];
            if (val === undefined || val === null || (typeof val === 'string' && !val.trim())) {
              return Errors.badRequest(reply, `Please answer "${q.question}"`);
            }
          }

          // For choice_with_text, enforce explanation text for configured answers
          if (q.type === 'choice_with_text') {
            const choiceVal = responses[q.id];
            if (typeof choiceVal !== 'string') continue;
            const needsExplanation = requireExplanationFor.some(
              (opt) => opt.toLowerCase() === choiceVal.toLowerCase()
            );
            if (needsExplanation) {
              const textVal = responses[`${q.id}_text`];
              if (!textVal || (typeof textVal === 'string' && !textVal.trim())) {
                return Errors.badRequest(reply, `Please provide an explanation for "${q.question}" when answering "${choiceVal}"`);
              }
            }
          }
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

      // If linked to appointment, transition to completed using lifecycle service
      // This handles all side effects: Slack notification, Notion sync, audit trail

      // Build feedback data for Slack dynamically from form questions + responses.
      //
      // Conditional sub-questions are handled specially for compact, coherent output:
      //  - Text sub-questions merge inline with their parent answer using — "detail"
      //  - Choice sub-questions render with a ↳ prefix for visual hierarchy
      //  - Sub-questions whose parent condition is NOT met are filtered out
      //
      // Truncation limits are intentionally tight because these values are rendered
      // inline in a single Slack section block (3 000-char limit). The full,
      // unabridged responses are always accessible via the admin forms dashboard.
      const LABEL_MAX = 50;
      const CHOICE_TEXT_MAX = 80;
      const FREE_TEXT_MAX = 100;

      const formQuestions = (formConfig?.questions as unknown as FormQuestion[]) || [];

      // Helper: check if a conditional question's parent condition is met
      const isSlackConditionMet = (q: FormQuestion): boolean => {
        if (!q.conditionalOn) return true;
        const parentVal = responses[q.conditionalOn.questionId];
        if (typeof parentVal !== 'string') return false;
        return q.conditionalOn.values.some(
          (v) => v.toLowerCase() === parentVal.toLowerCase()
        );
      };

      // Build a lookup of question IDs to their labels for parent-child merging
      const questionById = new Map(formQuestions.map(q => [q.id, q]));

      // Track which parent questions have had a text sub-answer merged inline
      const mergedTextChildren = new Set<string>();

      // First pass: identify conditional text sub-questions that should merge
      // with their parent's answer (e.g. "No" → 'No — "detail text"')
      for (const q of formQuestions) {
        if (
          q.type === 'text' &&
          q.conditionalOn &&
          isSlackConditionMet(q) &&
          responses[q.id] != null &&
          responses[q.id] !== ''
        ) {
          const parent = questionById.get(q.conditionalOn.questionId);
          if (parent && (parent.type === 'choice' || parent.type === 'choice_with_text')) {
            mergedTextChildren.add(q.id);
          }
        }
      }

      const feedbackData: Record<string, string> = {};
      for (const q of formQuestions) {
        const val = responses[q.id];
        if (val == null || val === '') continue;

        // Skip conditional questions whose parent condition is not met
        if (!isSlackConditionMet(q)) continue;

        // Skip text sub-questions that were merged into their parent
        if (mergedTextChildren.has(q.id)) continue;

        const isSubQuestion = !!q.conditionalOn;
        const rawLabel = q.question.length > LABEL_MAX ? q.question.slice(0, LABEL_MAX - 3) + '...' : q.question;
        // Prefix conditional choice sub-questions with ↳ for visual hierarchy
        const label = isSubQuestion ? `↳ ${rawLabel}` : rawLabel;

        if (q.type === 'scale') {
          feedbackData[label] = `${val}/${q.scaleMax ?? 5}`;
        } else if (q.type === 'choice' || q.type === 'choice_with_text') {
          let answer = String(val);

          // Merge inline choice_with_text explanations
          const textVal = responses[`${q.id}_text`];
          if (textVal && typeof textVal === 'string' && textVal.trim()) {
            const truncated = textVal.length > CHOICE_TEXT_MAX ? textVal.slice(0, CHOICE_TEXT_MAX - 3) + '...' : textVal;
            answer += ` — "${truncated}"`;
          }

          // Merge conditional text sub-question answers inline with parent
          if (!isSubQuestion) {
            for (const child of formQuestions) {
              if (mergedTextChildren.has(child.id) && child.conditionalOn?.questionId === q.id) {
                const childVal = String(responses[child.id]);
                const truncated = childVal.length > CHOICE_TEXT_MAX ? childVal.slice(0, CHOICE_TEXT_MAX - 3) + '...' : childVal;
                answer += ` — "${truncated}"`;
                break; // Only merge the first text child to keep compact
              }
            }
          }

          feedbackData[label] = answer;
        } else if (q.type === 'text') {
          const strVal = String(val);
          feedbackData[label] = strVal.length > FREE_TEXT_MAX ? strVal.slice(0, FREE_TEXT_MAX - 3) + '...' : strVal;
        }
      }

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
        } catch (error) {
          // Log but don't fail the feedback submission.
          logger.error({ error, appointmentId: appointment.id }, 'Failed to transition appointment to completed');
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

      return sendSuccess(reply, { submissionId: submission.id }, { statusCode: 201, message: 'Thank you for your feedback!' });
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
