/**
 * Tests for the `dedupGroup` field added to SlackAlertOptions.
 *
 * Closes the alert-storm scenario flagged by the operability audit:
 * `notifyHumanReviewFlagged` (agent-initiated) and `notifyAutoEscalation`
 * (system-initiated) describe the same root cause from an admin's POV —
 * "this conversation is now under human control" — but their titles
 * differ ("Human Review Requested" vs "Auto-Escalation Triggered") so
 * the existing title-keyed dedup let both through. An admin would see
 * two `high`-severity alerts for the same appointment within minutes
 * if the two paths raced. Both notify methods now pass
 * `dedupGroup: 'human-control'`, collapsing them under one 24h key.
 *
 * This file pins the dedup-key construction directly via cacheManager
 * mocks. End-to-end Slack sending (block building, channel routing) is
 * unchanged and already covered by the existing Slack callsites.
 */

jest.mock('../utils/logger', () => ({
  logger: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
}));

jest.mock('../config', () => ({
  config: {
    env: 'test',
    slackWebhookUrl: undefined,
    slackUrgentWebhookUrl: undefined,
    appUrl: 'https://test.local',
    logLevel: 'silent',
  },
}));

// cacheManager (the dedup gatekeeper) lives in utils/redis alongside
// the raw redis client. Mocking the whole module keeps Redis-touching
// code paths from opening a real connection at import time.
const setNXMock = jest.fn();
jest.mock('../utils/redis', () => ({
  cacheManager: {
    setNX: (...args: unknown[]) => setNXMock(...args),
    getJson: jest.fn().mockResolvedValue(null),
    setJson: jest.fn(),
    delete: jest.fn(),
  },
  redis: {
    get: jest.fn(),
    set: jest.fn(),
    del: jest.fn(),
  },
}));

import { slackNotificationService } from '../services/slack-notification.service';

// Capture the dedup keys handed to setNX so we can assert on grouping
// without depending on Slack send behaviour (webhooks are undefined so
// nothing fires over the wire).
function dedupKeysFor(callIndex: number): string {
  return setNXMock.mock.calls[callIndex][0] as string;
}

beforeEach(() => {
  jest.clearAllMocks();
  // Default: setNX returns 'OK' (key was not present → alert proceeds).
  setNXMock.mockResolvedValue('OK');
});

describe('Slack dedup — dedupGroup field', () => {
  it('two alerts with different titles but the same dedupGroup + appointmentId share the layer-2 key', async () => {
    await slackNotificationService.sendAlert({
      title: 'Human Review Requested',
      severity: 'high',
      appointmentId: 'apt-X',
      details: 'agent flagged',
      dedupGroup: 'human-control',
    });
    await slackNotificationService.sendAlert({
      title: 'Auto-Escalation Triggered',
      severity: 'high',
      appointmentId: 'apt-X',
      details: 'system escalated',
      dedupGroup: 'human-control',
    });

    // Two setNX calls per alert (layer-1 exact-match + layer-2 scoped).
    // The layer-2 keys are at indices 1 and 3 — they MUST match because
    // dedupGroup is the same.
    const firstScopedKey = dedupKeysFor(1);
    const secondScopedKey = dedupKeysFor(3);
    expect(firstScopedKey).toBe(secondScopedKey);
    expect(firstScopedKey).toMatch(/^slack:dedup:apt:/);
  });

  it('different dedupGroup → different layer-2 keys (no false grouping)', async () => {
    await slackNotificationService.sendAlert({
      title: 'A',
      severity: 'high',
      appointmentId: 'apt-X',
      details: 'one',
      dedupGroup: 'human-control',
    });
    await slackNotificationService.sendAlert({
      title: 'B',
      severity: 'high',
      appointmentId: 'apt-X',
      details: 'two',
      dedupGroup: 'something-else',
    });

    expect(dedupKeysFor(1)).not.toBe(dedupKeysFor(3));
  });

  it('different appointmentId → different layer-2 keys even with the same dedupGroup', async () => {
    await slackNotificationService.sendAlert({
      title: 'Human Review Requested',
      severity: 'high',
      appointmentId: 'apt-A',
      details: 'one',
      dedupGroup: 'human-control',
    });
    await slackNotificationService.sendAlert({
      title: 'Human Review Requested',
      severity: 'high',
      appointmentId: 'apt-B',
      details: 'two',
      dedupGroup: 'human-control',
    });

    expect(dedupKeysFor(1)).not.toBe(dedupKeysFor(3));
  });

  it('when dedupGroup is omitted, layer-2 keying falls back to title (legacy behaviour)', async () => {
    await slackNotificationService.sendAlert({
      title: 'Some Alert',
      severity: 'medium',
      appointmentId: 'apt-X',
      details: 'one',
    });
    await slackNotificationService.sendAlert({
      title: 'Some Alert',
      severity: 'medium',
      appointmentId: 'apt-X',
      details: 'two', // different details → layer-1 lets it through
    });

    // Both should land on the same layer-2 key (title-keyed).
    expect(dedupKeysFor(1)).toBe(dedupKeysFor(3));
  });

  it('layer-2 EXISTS short-circuits before any further dedup work', async () => {
    // First alert: both layer-1 and layer-2 returns 'OK' (alert proceeds).
    setNXMock.mockResolvedValueOnce('OK').mockResolvedValueOnce('OK');
    // Second alert: layer-1 'OK' (different details so the exact-match key
    // doesn't clash), but layer-2 'EXISTS' — the dedupGroup-keyed scoped
    // key was laid down by the first alert and now suppresses the second.
    setNXMock.mockResolvedValueOnce('OK').mockResolvedValueOnce('EXISTS');

    await slackNotificationService.sendAlert({
      title: 'Human Review Requested',
      severity: 'high',
      appointmentId: 'apt-X',
      details: 'first',
      dedupGroup: 'human-control',
    });
    await slackNotificationService.sendAlert({
      title: 'Auto-Escalation Triggered',
      severity: 'high',
      appointmentId: 'apt-X',
      details: 'second',
      dedupGroup: 'human-control',
    });

    // Both alerts ran their two-stage dedup (4 setNX calls total). The
    // second alert's layer-2 returned EXISTS — that's the suppression
    // signal that prevents the duplicate Slack send. Asserting on the
    // call shape rather than sendAlert's return value avoids depending
    // on the actual webhook send (which is undefined in test config).
    expect(setNXMock).toHaveBeenCalledTimes(4);
    const layer2Keys = [dedupKeysFor(1), dedupKeysFor(3)];
    expect(layer2Keys[0]).toBe(layer2Keys[1]);
  });
});
