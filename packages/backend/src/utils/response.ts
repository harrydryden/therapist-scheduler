import { FastifyReply } from 'fastify';

/**
 * Standardized API response utilities
 * Ensures consistent response format across all endpoints
 */

export interface SuccessResponse<T = unknown> {
  success: true;
  data?: T;
  message?: string;
  count?: number;
  pagination?: {
    page: number;
    limit: number;
    total: number;
    totalPages: number;
  };
}

export interface ErrorResponse {
  success: false;
  error: string;
  details?: unknown;
}

/**
 * Send a successful response with data
 */
export function sendSuccess<T>(
  reply: FastifyReply,
  data: T,
  options?: {
    statusCode?: number;
    message?: string;
    count?: number;
    pagination?: SuccessResponse['pagination'];
  }
): FastifyReply {
  const response: SuccessResponse<T> = {
    success: true,
    data,
  };

  if (options?.message) response.message = options.message;
  if (options?.count !== undefined) response.count = options.count;
  if (options?.pagination) response.pagination = options.pagination;

  return reply.status(options?.statusCode ?? 200).send(response);
}

/**
 * Send an error response
 */
export function sendError(
  reply: FastifyReply,
  statusCode: number,
  error: string,
  details?: unknown
): FastifyReply {
  const response: ErrorResponse = {
    success: false,
    error,
  };

  if (details !== undefined) response.details = details;

  return reply.status(statusCode).send(response);
}

/**
 * Common error responses
 */
export const Errors = {
  unauthorized: (reply: FastifyReply) =>
    sendError(reply, 401, 'Unauthorized'),

  notFound: (reply: FastifyReply, resource = 'Resource') =>
    sendError(reply, 404, `${resource} not found`),

  badRequest: (reply: FastifyReply, message = 'Invalid request', details?: unknown) =>
    sendError(reply, 400, message, details),

  internal: (reply: FastifyReply, message = 'Internal server error') =>
    sendError(reply, 500, message),

  validationFailed: (reply: FastifyReply, errors: unknown) =>
    sendError(reply, 400, 'Invalid request body', errors),
};
