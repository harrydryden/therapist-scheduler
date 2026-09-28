/**
 * Unsubscribe endpoints (review #13).
 *
 * GET used to unsubscribe on the spot, so mail link scanners (SafeLinks,
 * Mimecast) that follow every link opted people out. Now GET only renders
 * a confirmation page whose button POSTs, and POST — also the RFC 8058
 * one-click target — performs the unsubscribe.
 */

import Fastify, { FastifyInstance } from 'fastify';

jest.mock('../utils/logger', () => require('./_global-mocks').loggerMock());

jest.mock('../utils/unsubscribe-token', () => ({
  extractEmailFromToken: (token: string) => (token.startsWith('good') ? 'Alice@Example.com' : null),
}));

const findUniqueMock = jest.fn();
const updateMock = jest.fn();
jest.mock('../utils/database', () => ({
  prisma: {
    user: {
      findUnique: (...a: unknown[]) => findUniqueMock(...a),
      update: (...a: unknown[]) => updateMock(...a),
    },
    voucherTracking: { update: jest.fn().mockResolvedValue({}) },
  },
}));

import { unsubscribeRoutes } from '../routes/unsubscribe.routes';

let app: FastifyInstance;

beforeEach(async () => {
  jest.clearAllMocks();
  findUniqueMock.mockResolvedValue({ id: 'user-1', subscribed: true });
  updateMock.mockResolvedValue({});
  app = Fastify();
  await app.register(unsubscribeRoutes);
  await app.ready();
});

afterEach(async () => {
  await app.close();
});

describe('GET /api/unsubscribe/:token', () => {
  it('renders a confirmation form that POSTs back, without changing anything', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/unsubscribe/good-token' });

    expect(res.statusCode).toBe(200);
    expect(res.headers['content-type']).toMatch(/text\/html/);
    expect(res.body).toContain('<form method="POST" action="/api/unsubscribe/good-token">');
    expect(findUniqueMock).not.toHaveBeenCalled();
    expect(updateMock).not.toHaveBeenCalled();
  });

  it('does not unsubscribe even when the client asks for JSON', async () => {
    await app.inject({
      method: 'GET',
      url: '/api/unsubscribe/good-token',
      headers: { accept: 'application/json' },
    });

    expect(updateMock).not.toHaveBeenCalled();
  });

  it('shows the invalid-link page for a bad token', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/unsubscribe/bad-token' });

    expect(res.statusCode).toBe(400);
    expect(res.body).toContain('Invalid Link');
  });
});

describe('POST /api/unsubscribe/:token', () => {
  it('accepts the RFC 8058 one-click form body and unsubscribes', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/unsubscribe/good-token',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      payload: 'List-Unsubscribe=One-Click',
    });

    expect(res.statusCode).toBe(200);
    expect(findUniqueMock).toHaveBeenCalledWith(expect.objectContaining({ where: { email: 'alice@example.com' } }));
    expect(updateMock).toHaveBeenCalledWith({ where: { id: 'user-1' }, data: { subscribed: false } });
    expect(res.body).toContain('Unsubscribed');
  });

  it('accepts a JSON request and answers in JSON', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/unsubscribe/good-token',
      headers: { accept: 'application/json' },
      payload: {},
    });

    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ success: true, message: 'You have been unsubscribed from weekly emails.' });
    expect(updateMock).toHaveBeenCalledTimes(1);
  });

  it('accepts a POST with no body (the confirmation button)', async () => {
    const res = await app.inject({ method: 'POST', url: '/api/unsubscribe/good-token' });

    expect(res.statusCode).toBe(200);
    expect(updateMock).toHaveBeenCalledTimes(1);
  });

  it('is idempotent for an already-unsubscribed user', async () => {
    findUniqueMock.mockResolvedValue({ id: 'user-1', subscribed: false });

    const res = await app.inject({ method: 'POST', url: '/api/unsubscribe/good-token' });

    expect(res.statusCode).toBe(200);
    expect(updateMock).not.toHaveBeenCalled();
  });

  it('rejects a bad token without touching the database', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/unsubscribe/bad-token',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      payload: 'List-Unsubscribe=One-Click',
    });

    expect(res.statusCode).toBe(400);
    expect(findUniqueMock).not.toHaveBeenCalled();
  });
});
