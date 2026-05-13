/**
 * Tests for the availability-collection agent's system prompt
 * timezone-handling branches.
 *
 * Three load-bearing prompt behaviours we want to keep stable:
 *   1. When the therapist is in a single-zone country (or has a
 *      stamped timezone), the prompt uses that zone for "today" and
 *      does NOT emit the clarification-needed copy.
 *   2. When the therapist is in a multi-zone country with no stamp,
 *      the prompt EMITS the clarification-needed copy and warns the
 *      agent NOT to silently use the platform default.
 *   3. The prompt instructs the agent to call resolve_local_time
 *      rather than computing ISO 8601 offsets itself.
 *
 * The boundary checks (the resolver itself, the audit classifier) are
 * tested in their own files; this file checks that the resolver's
 * output actually flows into the prompt string.
 */

jest.mock('../config', () => ({
  config: {
    jwtSecret: 'test',
    webhookSecret: 'test',
    backendUrl: 'https://backend.test',
    redisUrl: 'redis://localhost:6379',
    env: 'test',
    timezone: 'Europe/London',
  },
}));
jest.mock('../utils/logger', () => ({
  logger: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
}));
jest.mock('../utils/database', () => ({
  prisma: {
    therapist: {
      findUnique: jest.fn().mockResolvedValue(null),
    },
    therapistConversation: {
      findUnique: jest.fn().mockResolvedValue(null),
    },
  },
}));
jest.mock('../services/settings.service', () => ({
  getSettingValue: jest.fn().mockResolvedValue('Europe/London'),
  getSettingValues: jest.fn().mockResolvedValue(new Map()),
}));

import { buildAvailabilitySystemPrompt } from '../services/availability-agent.service';
import type { Therapist } from '@prisma/client';

const baseTherapist: Pick<
  Therapist,
  'id' | 'name' | 'email' | 'country' | 'availability' | 'bookingLink'
> = {
  id: 'tx-1',
  name: 'Sam Therapist',
  email: 'sam@example.com',
  country: 'UK',
  availability: null,
  bookingLink: null,
};

const baseContext = {
  conversationId: 'conv-1',
  therapistId: 'tx-1',
  therapistEmail: 'sam@example.com',
  therapistName: 'Sam Therapist',
  therapistCountry: 'UK',
  kind: 'onboarding' as const,
};

describe('availability-agent prompt — timezone branches', () => {
  it('renders today in the country default for a single-zone country', async () => {
    const prompt = await buildAvailabilitySystemPrompt(
      { ...baseTherapist, country: 'UK' },
      baseContext,
    );
    expect(prompt).toMatch(/Today's date[\s\S]*\(Europe\/London/);
    expect(prompt).not.toMatch(/Timezone clarification needed/);
  });

  it('uses the stamped timezone when one exists, even for a multi-zone country', async () => {
    const prompt = await buildAvailabilitySystemPrompt(
      {
        ...baseTherapist,
        country: 'US',
        availability: { timezone: 'America/Los_Angeles', slots: [] } as unknown as Therapist['availability'],
      },
      baseContext,
    );
    expect(prompt).toMatch(/\(America\/Los_Angeles/);
    expect(prompt).not.toMatch(/Timezone clarification needed/);
  });

  it('emits the clarification-needed copy when the country is multi-zone and no timezone is stamped', async () => {
    const prompt = await buildAvailabilitySystemPrompt(
      { ...baseTherapist, country: 'US', availability: null },
      baseContext,
    );
    // Load-bearing copy: the prompt must tell the agent to ASK, and
    // explicitly warn against silently using the platform default.
    expect(prompt).toMatch(/Timezone clarification needed/);
    expect(prompt).toMatch(/Do NOT silently use Europe\/London/);
    // Today should still render in SOME timezone (the platform default
    // as a placeholder) — but the agent is instructed not to rely on it.
    expect(prompt).toMatch(/Today's date/);
  });

  it('flags Australia with no stamp the same way as US', async () => {
    const prompt = await buildAvailabilitySystemPrompt(
      { ...baseTherapist, country: 'AU', availability: null },
      baseContext,
    );
    expect(prompt).toMatch(/Timezone clarification needed/);
  });

  it('instructs the agent to use resolve_local_time rather than computing offsets itself', async () => {
    const prompt = await buildAvailabilitySystemPrompt(baseTherapist, baseContext);
    expect(prompt).toMatch(/resolve_local_time/);
    expect(prompt).toMatch(/do NOT compute the ISO 8601 offset yourself/i);
  });

  it('labels the country-default tz with the country in the date line', async () => {
    const prompt = await buildAvailabilitySystemPrompt(
      { ...baseTherapist, country: 'IE' },
      baseContext,
    );
    // The line includes "— country default for IE" when we fell back
    // to the country default rather than a stamped zone.
    expect(prompt).toMatch(/country default for IE/);
  });
});
