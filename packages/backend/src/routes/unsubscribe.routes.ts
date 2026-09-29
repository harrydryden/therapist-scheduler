/**
 * Unsubscribe Routes
 *
 * Public endpoints for email unsubscription.
 *
 *   GET  /api/unsubscribe/:token — confirmation page only. Mail security
 *        scanners (SafeLinks, Mimecast, ...) follow every link in a
 *        message, so a GET that unsubscribed would opt people out without
 *        them ever clicking. The page's button POSTs to the same URL.
 *   POST /api/unsubscribe/:token — performs the unsubscribe. Also the
 *        RFC 8058 one-click endpoint named by the weekly mailing's
 *        `List-Unsubscribe` header: mailbox providers POST
 *        `List-Unsubscribe=One-Click` (form-encoded) to it.
 *
 * The signed token is the only credential; the request body is accepted
 * in any of the shapes providers use (form-encoded, multipart, JSON,
 * empty) and is not otherwise inspected.
 */

import { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import { logger } from '../utils/logger';
import { Errors } from '../utils/response';
import { extractEmailFromToken } from '../utils/unsubscribe-token';
import { prisma } from '../utils/database';

type TokenRequest = FastifyRequest<{ Params: { token: string } }>;

const UNSUBSCRIBE_RATE_LIMIT = {
  rateLimit: {
    max: 10,
    timeWindow: 60000, // 10 requests per minute per IP
  },
};

export async function unsubscribeRoutes(fastify: FastifyInstance) {
  // One-click unsubscribe POSTs are `application/x-www-form-urlencoded`,
  // which Fastify does not parse by default (it would answer 415). Scoped
  // to this plugin; the body is parsed but the token alone authorises.
  fastify.addContentTypeParser(
    'application/x-www-form-urlencoded',
    { parseAs: 'string' },
    (_request, body, done) => {
      done(null, Object.fromEntries(new URLSearchParams(body as string)));
    },
  );

  /**
   * GET /api/unsubscribe/:token
   * Renders a confirmation page. Never changes subscription state.
   */
  fastify.get<{ Params: { token: string } }>(
    '/api/unsubscribe/:token',
    { config: UNSUBSCRIBE_RATE_LIMIT },
    async (request: TokenRequest, reply: FastifyReply) => {
      const { token } = request.params;

      if (!extractEmailFromToken(token)) {
        logger.warn({ requestId: request.id }, 'Invalid unsubscribe token');
        return returnInvalidLinkPage(reply);
      }

      return returnConfirmationPage(reply, token);
    }
  );

  /**
   * POST /api/unsubscribe/:token
   * Performs the unsubscribe (confirmation button and RFC 8058 one-click).
   */
  fastify.post<{ Params: { token: string } }>(
    '/api/unsubscribe/:token',
    { config: UNSUBSCRIBE_RATE_LIMIT },
    async (request: TokenRequest, reply: FastifyReply) => {
      const { token } = request.params;
      const requestId = request.id;
      const wantsJson = request.headers.accept?.includes('application/json') ?? false;

      logger.info({ requestId }, 'Processing unsubscribe request');

      const email = extractEmailFromToken(token);
      if (!email) {
        // FIX L1: Remove token length from logs to prevent information disclosure
        logger.warn({ requestId }, 'Invalid unsubscribe token');
        if (wantsJson) return Errors.badRequest(reply, 'Invalid or expired unsubscribe link');
        return returnInvalidLinkPage(reply);
      }

      try {
        await unsubscribe(email, requestId);

        if (wantsJson) {
          return reply.send({
            success: true,
            message: 'You have been unsubscribed from weekly emails.',
          });
        }
        return returnSuccessPage(reply);
      } catch (err) {
        logger.error({ err, requestId }, 'Failed to process unsubscribe');

        if (wantsJson) {
          return Errors.internal(reply, 'Failed to process unsubscribe request');
        }
        return returnErrorPage(reply);
      }
    }
  );
}

/**
 * Mark the user unsubscribed. Idempotent: an unknown or already
 * unsubscribed address is a success, so the link can't be used to probe
 * which addresses are on the list.
 */
async function unsubscribe(email: string, requestId: string): Promise<void> {
  const normalizedEmail = email.toLowerCase().trim();

  // Find user in Postgres (the source of truth post-Notion-deprecation).
  const user = await prisma.user.findUnique({
    where: { email: normalizedEmail },
    select: { id: true, subscribed: true },
  });

  if (!user) {
    logger.warn({ requestId, email }, 'Unsubscribe for non-existent user');
    return;
  }

  if (!user.subscribed) {
    logger.info({ requestId, email }, 'User already unsubscribed');
    return;
  }

  await prisma.user.update({
    where: { id: user.id },
    data: { subscribed: false },
  });

  // Sync voucher tracking state (non-blocking)
  prisma.voucherTracking.update({
    where: { id: normalizedEmail },
    data: { unsubscribedAt: new Date() },
  }).catch((err) => {
    // Record may not exist if user never received a voucher
    logger.warn({ err, requestId, email }, 'Failed to update voucher tracking on unsubscribe (non-critical)');
  });

  logger.info({ requestId, email }, 'User unsubscribed successfully');
}

// ============================================
// Pages
// ============================================

const PAGE_STYLE = `
        body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; padding: 40px; text-align: center; max-width: 600px; margin: 0 auto; }
        h1 { color: #2d3748; }
        h1.error { color: #e53e3e; }
        h1.success { color: #38a169; }
        p { color: #4a5568; line-height: 1.6; }
        a { color: #3182ce; }
        .check { font-size: 60px; margin-bottom: 20px; }
        button { background: #3182ce; color: #fff; border: 0; border-radius: 6px; padding: 12px 28px; font-size: 16px; cursor: pointer; }
        button:hover { background: #2b6cb0; }`;

function page(title: string, body: string): string {
  return `
    <!DOCTYPE html>
    <html>
    <head>
      <meta charset="utf-8">
      <meta name="viewport" content="width=device-width, initial-scale=1">
      <meta name="robots" content="noindex">
      <title>${title}</title>
      <style>${PAGE_STYLE}
      </style>
    </head>
    <body>
${body}
    </body>
    </html>
  `;
}

function escapeHtmlAttribute(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/"/g, '&quot;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

function returnConfirmationPage(reply: FastifyReply, token: string) {
  const action = escapeHtmlAttribute(`/api/unsubscribe/${encodeURIComponent(token)}`);
  return reply
    .header('Cache-Control', 'no-store')
    .type('text/html')
    .send(page('Unsubscribe', `
      <h1>Unsubscribe from weekly emails?</h1>
      <p>You'll stop receiving our weekly reminder emails. You can still book therapy sessions anytime at <a href="https://free.spill.app">free.spill.app</a></p>
      <form method="POST" action="${action}">
        <input type="hidden" name="List-Unsubscribe" value="One-Click">
        <button type="submit">Unsubscribe</button>
      </form>`));
}

function returnInvalidLinkPage(reply: FastifyReply) {
  return reply.status(400).type('text/html').send(page('Invalid Link', `
      <h1 class="error">Invalid Link</h1>
      <p>This unsubscribe link is invalid or has expired.</p>
      <p>If you're having trouble unsubscribing, please contact us directly.</p>`));
}

function returnErrorPage(reply: FastifyReply) {
  return reply.status(500).type('text/html').send(page('Error', `
      <h1 class="error">Something went wrong</h1>
      <p>We couldn't process your unsubscribe request. Please try again later or contact us directly.</p>`));
}

function returnSuccessPage(reply: FastifyReply) {
  return reply.type('text/html').send(page('Unsubscribed', `
      <div class="check">✓</div>
      <h1 class="success">Unsubscribed</h1>
      <p>You have been unsubscribed from weekly reminder emails.</p>
      <p>You can still book therapy sessions anytime at <a href="https://free.spill.app">free.spill.app</a></p>`));
}
