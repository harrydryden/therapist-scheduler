import { fetchAdminApi } from './core';

// Slack Diagnostics API functions

export interface SlackStatus {
  enabled: boolean;
  webhookConfigured: boolean;
  circuitBreaker: {
    state: 'CLOSED' | 'OPEN' | 'HALF_OPEN';
    failures: number;
    successes: number;
    lastFailure: string | null;
    lastSuccess: string | null;
    totalRequests: number;
    rejectedRequests: number;
  };
  queue: {
    inMemory: number;
    oldestAge?: number;
  };
  backgroundTasks: Record<string, {
    total: number;
    success: number;
    failed: number;
    timedOut: number;
    recentErrors: Array<{ timestamp: string; error: string }>;
  }>;
}

export async function getSlackStatus(): Promise<SlackStatus> {
  const response = await fetchAdminApi<SlackStatus>('/admin/slack/status');
  if (!response.data) {
    throw new Error('Failed to fetch Slack status');
  }
  return response.data;
}

export async function sendSlackTest(): Promise<{ message: string; sent: boolean }> {
  const response = await fetchAdminApi<{ message: string; sent: boolean }>(
    '/admin/slack/test',
    { method: 'POST' }
  );
  if (!response.data) {
    throw new Error('Failed to send test notification');
  }
  return response.data;
}

export async function resetSlackCircuit(): Promise<{
  message: string;
  before: { state: string; failures: number };
  after: { state: string; failures: number };
}> {
  const response = await fetchAdminApi<{
    message: string;
    before: { state: string; failures: number };
    after: { state: string; failures: number };
  }>('/admin/slack/reset', { method: 'POST' });
  if (!response.data) {
    throw new Error('Failed to reset circuit breaker');
  }
  return response.data;
}
