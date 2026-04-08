import { fetchAdminApi, unwrap } from './core';

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
  return unwrap(await fetchAdminApi<SlackStatus>('/admin/slack/status'), 'Slack status');
}

export async function sendSlackTest(): Promise<{ message: string; sent: boolean }> {
  return unwrap(
    await fetchAdminApi<{ message: string; sent: boolean }>(
      '/admin/slack/test',
      { method: 'POST' }
    ),
    'Slack test'
  );
}

export async function resetSlackCircuit(): Promise<{
  message: string;
  before: { state: string; failures: number };
  after: { state: string; failures: number };
}> {
  return unwrap(
    await fetchAdminApi<{
      message: string;
      before: { state: string; failures: number };
      after: { state: string; failures: number };
    }>('/admin/slack/reset', { method: 'POST' }),
    'circuit reset'
  );
}
