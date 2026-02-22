import { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import { pdfIngestionService } from '../services/pdf-ingestion.service';
import { logger } from '../utils/logger';
import { config } from '../config';
import { verifyWebhookSecret } from '../middleware/auth';

interface AdminNotes {
  additionalInfo?: string; // Free text field for admin to add missing info
  overrideEmail?: string; // Override extracted email if needed
  // Category overrides
  overrideApproach?: string[];
  overrideStyle?: string[];
  overrideAreasOfFocus?: string[];
  overrideAvailability?: {
    timezone: string;
    slots: Array<{ day: string; start: string; end: string }>;
  };
  notes?: string; // Internal admin notes (not shown to users)
}

// Maximum chunk accumulation size to prevent memory attacks from infinite streams
const MAX_CHUNK_ACCUMULATION = 15 * 1024 * 1024; // 15MB buffer for safety

// FIX R4: Maximum field value sizes to prevent memory exhaustion from large form fields
const MAX_FIELD_SIZES = {
  additionalInfo: 50000,      // 50KB - for therapist info text
  overrideEmail: 255,         // Standard email length
  notes: 10000,               // 10KB - for admin notes
  arrayField: 5000,           // 5KB - for JSON array fields
  availabilityField: 10000,   // 10KB - for availability JSON
};

export async function ingestionRoutes(fastify: FastifyInstance) {
  // Auth middleware - require webhook secret for all ingestion routes
  fastify.addHook('preHandler', verifyWebhookSecret);

  // POST /api/ingestion/therapist-cv - Upload and process a therapist CV/application PDF
  fastify.post(
    '/api/ingestion/therapist-cv',
    async (request: FastifyRequest, reply: FastifyReply) => {
      const requestId = request.id;
      logger.info({ requestId }, 'Received therapist CV ingestion request');

      try {
        // Parse multipart form data
        const parts = request.parts();
        let pdfBuffer: Buffer | null = null;
        let filename: string | null = null;
        let adminNotes: AdminNotes = {};

        for await (const part of parts) {
          if (part.type === 'file') {
            // Handle file upload
            if (part.mimetype !== 'application/pdf') {
              return reply.status(400).send({
                success: false,
                error: 'Only PDF files are accepted',
              });
            }

            const chunks: Buffer[] = [];
            let totalSize = 0;
            for await (const chunk of part.file) {
              totalSize += chunk.length;
              // Prevent memory exhaustion from infinite streams
              if (totalSize > MAX_CHUNK_ACCUMULATION) {
                return reply.status(413).send({
                  success: false,
                  error: 'File too large. Maximum size is 10MB.',
                });
              }
              chunks.push(chunk);
            }
            pdfBuffer = Buffer.concat(chunks);
            filename = part.filename;
          } else if (part.type === 'field') {
            // Handle form fields
            const fieldName = part.fieldname;
            const value = part.value as string;

            // FIX R4: Validate field sizes to prevent memory exhaustion
            if (fieldName === 'additionalInfo') {
              if (value.length > MAX_FIELD_SIZES.additionalInfo) {
                return reply.status(400).send({
                  success: false,
                  error: `additionalInfo exceeds maximum length of ${MAX_FIELD_SIZES.additionalInfo} characters`,
                });
              }
              adminNotes.additionalInfo = value;
            } else if (fieldName === 'overrideEmail') {
              if (value.length > MAX_FIELD_SIZES.overrideEmail) {
                return reply.status(400).send({
                  success: false,
                  error: `overrideEmail exceeds maximum length of ${MAX_FIELD_SIZES.overrideEmail} characters`,
                });
              }
              adminNotes.overrideEmail = value;
            } else if (fieldName === 'overrideApproach') {
              if (value.length > MAX_FIELD_SIZES.arrayField) {
                return reply.status(400).send({
                  success: false,
                  error: `overrideApproach exceeds maximum length of ${MAX_FIELD_SIZES.arrayField} characters`,
                });
              }
              try {
                adminNotes.overrideApproach = JSON.parse(value);
              } catch {
                adminNotes.overrideApproach = value.split(',').map((s) => s.trim());
              }
            } else if (fieldName === 'overrideStyle') {
              if (value.length > MAX_FIELD_SIZES.arrayField) {
                return reply.status(400).send({
                  success: false,
                  error: `overrideStyle exceeds maximum length of ${MAX_FIELD_SIZES.arrayField} characters`,
                });
              }
              try {
                adminNotes.overrideStyle = JSON.parse(value);
              } catch {
                adminNotes.overrideStyle = value.split(',').map((s) => s.trim());
              }
            } else if (fieldName === 'overrideAreasOfFocus') {
              if (value.length > MAX_FIELD_SIZES.arrayField) {
                return reply.status(400).send({
                  success: false,
                  error: `overrideAreasOfFocus exceeds maximum length of ${MAX_FIELD_SIZES.arrayField} characters`,
                });
              }
              try {
                adminNotes.overrideAreasOfFocus = JSON.parse(value);
              } catch {
                adminNotes.overrideAreasOfFocus = value.split(',').map((s) => s.trim());
              }
            } else if (fieldName === 'overrideAvailability') {
              if (value.length > MAX_FIELD_SIZES.availabilityField) {
                return reply.status(400).send({
                  success: false,
                  error: `overrideAvailability exceeds maximum length of ${MAX_FIELD_SIZES.availabilityField} characters`,
                });
              }
              try {
                adminNotes.overrideAvailability = JSON.parse(value);
              } catch {
                // Ignore invalid JSON
              }
            } else if (fieldName === 'notes') {
              if (value.length > MAX_FIELD_SIZES.notes) {
                return reply.status(400).send({
                  success: false,
                  error: `notes exceeds maximum length of ${MAX_FIELD_SIZES.notes} characters`,
                });
              }
              adminNotes.notes = value;
            }
          }
        }

        // PDF is now optional - can create therapist from additional info alone
        if (pdfBuffer) {
          // Validate file size (max 10MB)
          const maxSize = 10 * 1024 * 1024;
          if (pdfBuffer.length > maxSize) {
            return reply.status(400).send({
              success: false,
              error: 'File too large. Maximum size is 10MB.',
            });
          }

          logger.info(
            {
              requestId,
              filename,
              size: pdfBuffer.length,
              hasAdminNotes: !!adminNotes.additionalInfo || !!adminNotes.notes,
            },
            'Processing uploaded PDF with admin notes'
          );
        } else {
          // No PDF - require additional info to have enough data
          if (!adminNotes.additionalInfo || adminNotes.additionalInfo.trim().length < 50) {
            return reply.status(400).send({
              success: false,
              error: 'When no PDF is uploaded, additional information is required (minimum 50 characters)',
            });
          }

          logger.info(
            {
              requestId,
              hasAdminNotes: true,
              additionalInfoLength: adminNotes.additionalInfo.length,
            },
            'Processing therapist from additional info only (no PDF)'
          );
        }

        // Process the PDF (or just additional info) with admin notes
        const result = await pdfIngestionService.ingestPDF(pdfBuffer, requestId, adminNotes);

        if (!result.success) {
          return reply.status(422).send({
            success: false,
            error: result.error,
          });
        }

        return reply.status(201).send({
          success: true,
          data: {
            therapistId: result.therapistId,
            notionUrl: result.notionUrl,
            extractedProfile: {
              name: result.extractedData?.name,
              email: result.extractedData?.email,
              approach: result.extractedData?.approach,
              style: result.extractedData?.style,
              areasOfFocus: result.extractedData?.areasOfFocus,
              bio: result.extractedData?.bio ? result.extractedData.bio.slice(0, 200) + '...' : undefined,
            },
            adminNotesApplied: {
              hadAdditionalInfo: !!adminNotes.additionalInfo,
              hadOverrideEmail: !!adminNotes.overrideEmail,
              hadOverrideApproach: !!adminNotes.overrideApproach,
              hadOverrideStyle: !!adminNotes.overrideStyle,
              hadOverrideAreasOfFocus: !!adminNotes.overrideAreasOfFocus,
              hadOverrideAvailability: !!adminNotes.overrideAvailability,
            },
          },
          message: 'Therapist profile successfully extracted and added to directory',
        });
      } catch (err) {
        logger.error({ err, requestId }, 'Failed to process therapist CV');
        return reply.status(500).send({
          success: false,
          error: 'Failed to process uploaded file',
        });
      }
    }
  );

  // POST /api/ingestion/therapist-cv/preview - Preview extraction without creating record
  fastify.post(
    '/api/ingestion/therapist-cv/preview',
    async (request: FastifyRequest, reply: FastifyReply) => {
      const requestId = request.id;
      logger.info({ requestId }, 'Received therapist CV preview request');

      try {
        // Parse multipart form data
        const parts = request.parts();
        let pdfBuffer: Buffer | null = null;
        let additionalInfo: string | null = null;

        for await (const part of parts) {
          if (part.type === 'file') {
            if (part.mimetype !== 'application/pdf') {
              return reply.status(400).send({
                success: false,
                error: 'Only PDF files are accepted',
              });
            }

            const chunks: Buffer[] = [];
            let totalSize = 0;
            for await (const chunk of part.file) {
              totalSize += chunk.length;
              // Prevent memory exhaustion from infinite streams
              if (totalSize > MAX_CHUNK_ACCUMULATION) {
                return reply.status(413).send({
                  success: false,
                  error: 'File too large. Maximum size is 10MB.',
                });
              }
              chunks.push(chunk);
            }
            pdfBuffer = Buffer.concat(chunks);
          } else if (part.type === 'field' && part.fieldname === 'additionalInfo') {
            const value = part.value as string;
            // FIX R4: Validate field size
            if (value.length > MAX_FIELD_SIZES.additionalInfo) {
              return reply.status(400).send({
                success: false,
                error: `additionalInfo exceeds maximum length of ${MAX_FIELD_SIZES.additionalInfo} characters`,
              });
            }
            additionalInfo = value;
          }
        }

        // PDF is now optional - can preview from additional info alone
        let pdfText = '';

        if (pdfBuffer) {
          // Extract text from PDF
          pdfText = await pdfIngestionService.extractTextFromPDF(pdfBuffer);
        } else {
          // No PDF - require additional info
          if (!additionalInfo || additionalInfo.trim().length < 50) {
            return reply.status(400).send({
              success: false,
              error: 'When no PDF is uploaded, additional information is required (minimum 50 characters)',
            });
          }
        }

        // Extract profile from PDF text and/or additional info
        const profile = await pdfIngestionService.extractTherapistProfile(pdfText, requestId, additionalInfo || undefined);

        return reply.send({
          success: true,
          data: {
            extractedProfile: profile,
            rawTextLength: pdfText.length,
            additionalInfoProvided: !!additionalInfo,
          },
          message: 'Preview only - no record created. Use /api/ingestion/therapist-cv to create the record.',
        });
      } catch (err) {
        logger.error({ err, requestId }, 'Failed to preview therapist CV');
        return reply.status(500).send({
          success: false,
          error: err instanceof Error ? err.message : 'Failed to process uploaded file',
        });
      }
    }
  );
}
