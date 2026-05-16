/**
 * Application Error Hierarchy
 *
 * Base error class and domain-specific subclasses for consistent error handling.
 * All application errors extend AppError, which carries:
 *   - code: machine-readable error code for API responses
 *   - statusCode: HTTP status code
 *   - isOperational: true = expected error (bad input, not found), false = bug
 *
 * Fastify error handler can check `instanceof AppError` to serialize consistently.
 */

// ─── Base Error ──────────────────────────────────────────────────────────────

export class AppError extends Error {
  public readonly code: string;
  public readonly statusCode: number;
  public readonly isOperational: boolean;

  constructor(
    message: string,
    options: {
      code: string;
      statusCode?: number;
      isOperational?: boolean;
    }
  ) {
    super(message);
    this.name = this.constructor.name;
    this.code = options.code;
    this.statusCode = options.statusCode ?? 500;
    this.isOperational = options.isOperational ?? true;
  }
}

// ─── HTTP Errors ─────────────────────────────────────────────────────────────

export class BadRequestError extends AppError {
  constructor(message: string, code = 'BAD_REQUEST') {
    super(message, { code, statusCode: 400 });
  }
}

export class NotFoundError extends AppError {
  constructor(message: string, code = 'NOT_FOUND') {
    super(message, { code, statusCode: 404 });
  }
}

export class ConflictError extends AppError {
  constructor(message: string, code = 'CONFLICT') {
    super(message, { code, statusCode: 409 });
  }
}

export class RateLimitError extends AppError {
  public readonly retryAfter?: number;

  constructor(message = 'Too many requests', retryAfter?: number) {
    super(message, { code: 'RATE_LIMITED', statusCode: 429 });
    this.retryAfter = retryAfter;
  }
}

// ─── Domain Errors: Appointment Lifecycle ────────────────────────────────────

export class AppointmentNotFoundError extends NotFoundError {
  constructor(appointmentId: string) {
    super(`Appointment ${appointmentId} not found`, 'APPOINTMENT_NOT_FOUND');
  }
}

export class InvalidTransitionError extends BadRequestError {
  constructor(fromStatus: string, toStatus: string) {
    super(
      `Invalid status transition: ${fromStatus} → ${toStatus}`,
      'INVALID_TRANSITION'
    );
  }
}

export class ConcurrentModificationError extends ConflictError {
  constructor(appointmentId: string) {
    super(
      `Appointment ${appointmentId} is being modified by another process`,
      'CONCURRENT_MODIFICATION'
    );
  }
}

// ─── Domain Errors: Validation ───────────────────────────────────────────────

export class ValidationError extends BadRequestError {
  public readonly fields?: Record<string, string>;

  constructor(message: string, fields?: Record<string, string>) {
    super(message, 'VALIDATION_ERROR');
    this.fields = fields;
  }
}
