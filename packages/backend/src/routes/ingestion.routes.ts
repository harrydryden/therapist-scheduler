import { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import { pdfIngestionService } from '../services/pdf-ingestion.service';
import { logger } from '../utils/logger';
import { verifyWebhookSecret } from '../middleware/auth';
import { sendSuccess, sendError, Errors } from '../utils/response';
import { isCountryCode } from '@therapist-scheduler/shared';

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
  country?: string; // Country code where the therapist is based
}

// Simple email format validation
const EMAIL_REGEX = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

// Maximum chunk accumulation size to prevent memory attacks from infinite streams
const MAX_CHUNK_ACCUMULATION = 15 * 1024 * 1024; // 15MB buffer for safety
const MAX_PDF_SIZE = 10 * 1024 * 1024; // 10MB

// FIX R4: Maximum field value sizes to prevent memory exhaustion from large form fields
const MAX_FIELD_SIZES = {
  additionalInfo: 50000,      // 50KB - for therapist info text
  overrideEmail: 255,         // Standard email length
  notes: 10000,               // 10KB - for admin notes
  arrayField: 5000,           // 5KB - for JSON array fields
  availabilityField: 10000,   // 10KB - for availability JSON
};

// --- Shared multipart parsing helpers ---

/** Read a PDF file part into a Buffer with size limits. Throws on invalid type or overflow. */
async function readPdfFilePart(part: { mimetype: string; file: AsyncIterable<Buffer> }): Promise<Buffer> {
  if (part.mimetype !== 'application/pdf') {
    throw new ValidationError('Only PDF files are accepted');
  }

  const chunks: Buffer[] = [];
  let totalSize = 0;
  for await (const chunk of part.file) {
    totalSize += chunk.length;
    if (totalSize > MAX_CHUNK_ACCUMULATION) {
      throw new ValidationError('File too large. Maximum size is 10MB.', 413);
    }
    chunks.push(chunk);
  }

  const buffer = Buffer.concat(chunks);
  if (buffer.length > MAX_PDF_SIZE) {
    throw new ValidationError('File too large. Maximum size is 10MB.');
  }
  return buffer;
}

/** Validate a field value against a max length. Throws on overflow. */
function validateFieldLength(fieldName: string, value: string, maxLength: number): void {
  if (value.length > maxLength) {
    throw new ValidationError(`${fieldName} exceeds maximum length of ${maxLength} characters`);
  }
}

/** Parse a JSON array field, falling back to comma-separated string. */
function parseArrayField(value: string): string[] {
  try {
    return JSON.parse(value);
  } catch {
    return value.split(',').map((s) => s.trim());
  }
}

class ValidationError extends Error {
  statusCode: number;
  constructor(message: string, statusCode = 400) {
    super(message);
    this.statusCode = statusCode;
  }
}

/** Parse all admin note fields from a multipart field part. */
function parseAdminNoteField(fieldName: string, value: string, adminNotes: AdminNotes): void {
  if (fieldName === 'additionalInfo') {
    validateFieldLength('additionalInfo', value, MAX_FIELD_SIZES.additionalInfo);
    adminNotes.additionalInfo = value;
  } else if (fieldName === 'overrideEmail') {
    validateFieldLength('overrideEmail', value, MAX_FIELD_SIZES.overrideEmail);
    const trimmed = value.trim();
    if (trimmed && !EMAIL_REGEX.test(trimmed)) {
      throw new ValidationError('Invalid email format for overrideEmail');
    }
    adminNotes.overrideEmail = trimmed || undefined;
  } else if (fieldName === 'overrideApproach') {
    validateFieldLength('overrideApproach', value, MAX_FIELD_SIZES.arrayField);
    adminNotes.overrideApproach = parseArrayField(value);
  } else if (fieldName === 'overrideStyle') {
    validateFieldLength('overrideStyle', value, MAX_FIELD_SIZES.arrayField);
    adminNotes.overrideStyle = parseArrayField(value);
  } else if (fieldName === 'overrideAreasOfFocus') {
    validateFieldLength('overrideAreasOfFocus', value, MAX_FIELD_SIZES.arrayField);
    adminNotes.overrideAreasOfFocus = parseArrayField(value);
  } else if (fieldName === 'overrideAvailability') {
    validateFieldLength('overrideAvailability', value, MAX_FIELD_SIZES.availabilityField);
    try {
      adminNotes.overrideAvailability = JSON.parse(value);
    } catch {
      // Ignore invalid JSON
    }
  } else if (fieldName === 'notes') {
    validateFieldLength('notes', value, MAX_FIELD_SIZES.notes);
    adminNotes.notes = value;
  } else if (fieldName === 'country') {
    validateFieldLength('country', value, 8);
    const normalized = value.trim().toUpperCase();
    if (normalized && !isCountryCode(normalized)) {
      throw new ValidationError(`Invalid country code: ${value.trim()}`);
    }
    if (normalized) {
      adminNotes.country = normalized;
    }
  }
}

/** Validate that sufficient source data is available (PDF or additional info). */
function validateSourceData(pdfBuffer: Buffer | null, additionalInfo?: string): void {
  if (!pdfBuffer && (!additionalInfo || additionalInfo.trim().length < 50)) {
    throw new ValidationError('When no PDF is uploaded, additional information is required (minimum 50 characters)');
  }
}

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
            pdfBuffer = await readPdfFilePart(part);
            filename = part.filename;
          } else if (part.type === 'field') {
            parseAdminNoteField(part.fieldname, part.value as string, adminNotes);
          }
        }

        validateSourceData(pdfBuffer, adminNotes.additionalInfo);

        if (pdfBuffer) {
          logger.info(
            { requestId, filename, size: pdfBuffer.length, hasAdminNotes: !!adminNotes.additionalInfo || !!adminNotes.notes },
            'Processing uploaded PDF with admin notes'
          );
        } else {
          logger.info(
            { requestId, hasAdminNotes: true, additionalInfoLength: adminNotes.additionalInfo!.length },
            'Processing therapist from additional info only (no PDF)'
          );
        }

        // Process the PDF (or just additional info) with admin notes
        const result = await pdfIngestionService.ingestPDF(pdfBuffer, requestId, adminNotes);

        if (!result.success) {
          return sendError(reply, 422, result.error);
        }

        return sendSuccess(reply, {
            therapistId: result.therapistId,
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
          }, { statusCode: 201, message: 'Therapist profile successfully extracted and added to directory' });
      } catch (err) {
        if (err instanceof ValidationError) {
          return err.statusCode === 413
            ? sendError(reply, 413, err.message)
            : Errors.badRequest(reply, err.message);
        }
        logger.error({ err, requestId }, 'Failed to process therapist CV');
        return Errors.internal(reply, 'Failed to process uploaded file');
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
        let country: string | null = null;
        let timezone: string | null = null;

        for await (const part of parts) {
          if (part.type === 'file') {
            pdfBuffer = await readPdfFilePart(part);
          } else if (part.type === 'field' && part.fieldname === 'additionalInfo') {
            const value = part.value as string;
            validateFieldLength('additionalInfo', value, MAX_FIELD_SIZES.additionalInfo);
            additionalInfo = value;
          } else if (part.type === 'field' && part.fieldname === 'country') {
            const value = part.value as string;
            validateFieldLength('country', value, 8);
            const normalized = value.trim().toUpperCase();
            if (normalized && !isCountryCode(normalized)) {
              throw new ValidationError(`Invalid country code: ${value.trim()}`);
            }
            country = normalized || null;
          } else if (part.type === 'field' && part.fieldname === 'timezone') {
            const value = part.value as string;
            validateFieldLength('timezone', value, 64);
            timezone = value.trim() || null;
          }
        }

        validateSourceData(pdfBuffer, additionalInfo);

        // Extract text from PDF if provided
        let pdfText = '';
        if (pdfBuffer) {
          pdfText = await pdfIngestionService.extractTextFromPDF(pdfBuffer);
        }

        // Extract profile from PDF text and/or additional info. Country and
        // timezone (when supplied) drive how the AI stamps availability so it
        // matches where the therapist works.
        const profile = await pdfIngestionService.extractTherapistProfile(
          pdfText,
          requestId,
          additionalInfo || undefined,
          country || undefined,
          timezone || undefined,
        );

        return sendSuccess(reply, {
            extractedProfile: profile,
            rawTextLength: pdfText.length,
            additionalInfoProvided: !!additionalInfo,
          }, { message: 'Preview only - no record created. Use /api/ingestion/therapist-cv to create the record.' });
      } catch (err) {
        if (err instanceof ValidationError) {
          return err.statusCode === 413
            ? sendError(reply, 413, err.message)
            : Errors.badRequest(reply, err.message);
        }
        logger.error({ err, requestId }, 'Failed to preview therapist CV');
        return Errors.internal(reply, err instanceof Error ? err.message : 'Failed to process uploaded file');
      }
    }
  );
}
