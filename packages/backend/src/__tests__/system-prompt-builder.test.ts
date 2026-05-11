/**
 * Tests for the agent system-prompt builder.
 *
 * The prompt's exact text is the single biggest input that steers the
 * Claude tool loop — it's the spec the model follows. A drift in
 * structure, a missing privacy clause, or a swapped section order
 * silently changes agent behaviour everywhere.
 *
 * These tests pin:
 *   1. Section ordering: stable content first (identity / tone / privacy
 *      / tools), variable per-turn content last (facts / memory / stage).
 *      The reorder in PR #194 was specifically for prompt-cache friendliness
 *      and reasoning quality; this guards against a future cleanup
 *      accidentally re-flipping it.
 *   2. Section presence: every named section (Privacy, Tools, etc.) is
 *      reachable from the rendered prompt for typical inputs.
 *   3. Interpolation: agent name, client name, therapist name, language
 *      style, tone style all flow through to the rendered prompt.
 *   4. Conditional branches: direct-booking vs agent-negotiated workflows
 *      render the right instructions.
 *   5. Memory wiring: when notes/availability windows exist for the
 *      appointment, their formatted blocks appear in the prompt.
 *   6. Tools: every scheduling tool the agent can call is named in the
 *      prompt (otherwise the model can't be guided to use them).
 *
 * What we deliberately don't pin: the exact wording of any individual
 * sentence. That would make every prompt copy edit a test change.
 */

jest.mock('../utils/logger', () => require('./_global-mocks').loggerMock());

jest.mock('../services/knowledge.service', () => ({
  knowledgeService: {
    getKnowledgeForPrompt: jest.fn().mockResolvedValue({
      forTherapist: 'TEST_KNOWLEDGE_THERAPIST_BLOCK',
      forUser: 'TEST_KNOWLEDGE_USER_BLOCK',
    }),
  },
}));

/** Build a fresh default-settings Map. Defined inside the factory
 *  closure too — Jest hoists `jest.mock(...)` above any top-level
 *  declarations, so a module-scope `const` would still be in the TDZ
 *  when the factory ran. */
function buildDefaultSettings(): Map<string, string | number> {
  return new Map<string, string | number>([
    ['email.initialClientWithAvailabilitySubject', 'subj-client-avail'],
    ['email.initialClientWithAvailabilityBody', 'body-client-avail'],
    ['email.initialTherapistWithAvailabilitySubject', 'subj-tx-avail'],
    ['email.initialTherapistWithAvailabilityBody', 'body-tx-avail'],
    ['email.initialTherapistNoAvailabilitySubject', 'subj-tx-no-avail'],
    ['email.initialTherapistNoAvailabilityBody', 'body-tx-no-avail'],
    ['email.slotConfirmationToTherapistSubject', 'subj-confirm-tx'],
    ['email.slotConfirmationToTherapistBody', 'body-confirm-tx'],
    ['agent.languageStyle', 'UK'],
    ['agent.toneStyle', 'warm-casual'],
    ['agent.fromName', 'Justin Time'],
    ['agent.sessionDurationMinutes', 50],
    ['agent.maxSlotsPerGroup', 3],
    ['agent.maxTotalSlots', 6],
    ['general.timezone', 'Europe/London'],
  ]);
}

jest.mock('../services/settings.service', () => ({
  getSettingValues: jest.fn(async () => {
    // Lazy: re-evaluated each call. Tests that need different settings
    // call mockResolvedValueOnce on the spy.
    const map = new Map<string, string | number>([
      ['email.initialClientWithAvailabilitySubject', 'subj-client-avail'],
      ['email.initialClientWithAvailabilityBody', 'body-client-avail'],
      ['email.initialTherapistWithAvailabilitySubject', 'subj-tx-avail'],
      ['email.initialTherapistWithAvailabilityBody', 'body-tx-avail'],
      ['email.initialTherapistNoAvailabilitySubject', 'subj-tx-no-avail'],
      ['email.initialTherapistNoAvailabilityBody', 'body-tx-no-avail'],
      ['email.slotConfirmationToTherapistSubject', 'subj-confirm-tx'],
      ['email.slotConfirmationToTherapistBody', 'body-confirm-tx'],
      ['agent.languageStyle', 'UK'],
      ['agent.toneStyle', 'warm-casual'],
      ['agent.fromName', 'Justin Time'],
      ['agent.sessionDurationMinutes', 50],
      ['agent.maxSlotsPerGroup', 3],
      ['agent.maxTotalSlots', 6],
      ['general.timezone', 'Europe/London'],
    ]);
    return map;
  }),
}));

jest.mock('../utils/database', () => ({
  prisma: {
    appointmentRequest: {
      findUnique: jest.fn().mockResolvedValue({ memory: null }),
    },
    // Layer C profile lookups. Default: no row (returns null), which the
    // service maps to an empty profile that renders nothing.
    user: {
      findUnique: jest.fn().mockResolvedValue(null),
    },
    therapist: {
      findUnique: jest.fn().mockResolvedValue(null),
    },
  },
}));

jest.mock('../services/timezone-section', () => ({
  buildTimezoneSection: jest.fn().mockReturnValue('TEST_TIMEZONE_SECTION_MARKER\n'),
}));

// Simple availability formatter stub — when the test passes a context
// with slots, this returns a deterministic summary.
jest.mock('../services/availability-formatter.service', () => ({
  formatAvailabilityForUser: jest.fn().mockReturnValue({
    summary: 'TEST_AVAIL_SUMMARY',
    therapistTimezone: 'America/New_York',
  }),
}));

import { buildSystemPrompt } from '../services/system-prompt-builder';
import type { SchedulingContext } from '../services/scheduling-context.service';

const baseContext: SchedulingContext = {
  appointmentRequestId: 'apt-test-1',
  userName: 'Maria',
  userEmail: 'maria@example.com',
  therapistEmail: 'dr.j@example.com',
  therapistName: 'Doctor Jones',
  therapistAvailability: null,
  bookingMethod: 'agent_negotiated',
  userCountry: 'UK',
  therapistCountry: 'US',
};

describe('buildSystemPrompt — section presence', () => {
  it('includes every load-bearing section for an agent-negotiated appointment', async () => {
    const prompt = await buildSystemPrompt(baseContext);

    // Identity and configuration sections
    expect(prompt).toContain('## Your Identity');
    expect(prompt).toContain('## Tone & Communication Style');
    expect(prompt).toContain('## Current Scheduling Request');

    // Workflow + post-booking
    expect(prompt).toContain('## Detecting Booking Links in Emails');
    expect(prompt).toContain('## Availability Context');
    expect(prompt).toContain('## Important Guidelines');
    expect(prompt).toContain('## Appointment Rescheduling');
    expect(prompt).toContain('## Post-Booking Issues');

    // Privacy section is a security guardrail — must always be present
    expect(prompt).toContain('## Privacy & Confidentiality');

    // Tools and stage sections
    expect(prompt).toContain('## Available Tools');
    expect(prompt).toContain('## Session Configuration');
    expect(prompt).toContain('## Current Conversation Stage');

    // External knowledge + timezone wiring
    expect(prompt).toContain('TEST_TIMEZONE_SECTION_MARKER');
  });

  it('includes the privacy guardrails verbatim phrases that the prompt-injection defenses depend on', async () => {
    // These phrases are referenced in test-injection scenarios elsewhere;
    // dropping them would silently weaken the agent's resistance to
    // social-engineering messages.
    const prompt = await buildSystemPrompt(baseContext);
    expect(prompt).toMatch(/do not comply/i);
    expect(prompt).toMatch(/flag_for_human_review/);
  });
});

describe('buildSystemPrompt — section ordering (PR #194)', () => {
  // Stable per-appointment content must precede variable per-turn
  // content, so prompt caching can sit between them and reasoning is
  // anchored on identity / privacy before the model sees facts/memory.
  const stableThenVariable = async (): Promise<string> => buildSystemPrompt(baseContext);

  it('places Identity before the variable conversation-stage section', async () => {
    const prompt = await stableThenVariable();
    expect(prompt.indexOf('## Your Identity')).toBeLessThan(
      prompt.indexOf('## Current Conversation Stage'),
    );
  });

  it('places Privacy & Confidentiality before facts/memory/stage', async () => {
    const prompt = await stableThenVariable();
    expect(prompt.indexOf('## Privacy & Confidentiality')).toBeLessThan(
      prompt.indexOf('## Current Conversation Stage'),
    );
  });

  it('places Available Tools before the variable conversation-stage section', async () => {
    const prompt = await stableThenVariable();
    expect(prompt.indexOf('## Available Tools')).toBeLessThan(
      prompt.indexOf('## Current Conversation Stage'),
    );
  });

  it('places Session Configuration before the knowledge/timezone/variable block', async () => {
    const prompt = await stableThenVariable();
    expect(prompt.indexOf('## Session Configuration')).toBeLessThan(
      prompt.indexOf('TEST_TIMEZONE_SECTION_MARKER'),
    );
  });
});

describe('buildSystemPrompt — interpolation', () => {
  it('interpolates the agent name (from agent.fromName)', async () => {
    const prompt = await buildSystemPrompt(baseContext);
    expect(prompt).toContain('Justin Time');
    expect(prompt).toContain('Justin Time - Scheduling Coordinator');
  });

  it("uses the agent's first name only in signature guidance", async () => {
    // The signature should use first-name-only ("Justin"), not the full
    // "Justin Time", in the line `Best wishes\n${agentFirstName}`.
    const prompt = await buildSystemPrompt(baseContext);
    expect(prompt).toMatch(/Best wishes\nJustin\b/);
  });

  it('interpolates the client name', async () => {
    const prompt = await buildSystemPrompt({ ...baseContext, userName: 'Maria' });
    expect(prompt).toContain('Maria');
  });

  it('interpolates the therapist name', async () => {
    const prompt = await buildSystemPrompt({ ...baseContext, therapistName: 'Doctor Jones' });
    expect(prompt).toContain('Doctor Jones');
  });

  it('renders UK English when languageStyle is UK', async () => {
    const prompt = await buildSystemPrompt(baseContext);
    expect(prompt).toContain('Use UK English');
    // UK examples should appear, US examples should not
    expect(prompt).toContain('organise');
    expect(prompt).not.toContain('"organize"');
  });

  it('renders US English when languageStyle is US', async () => {
    const settingsService = jest.requireMock('../services/settings.service');
    const usMap = buildDefaultSettings();
    usMap.set('agent.languageStyle', 'US');
    settingsService.getSettingValues.mockResolvedValueOnce(usMap);

    const prompt = await buildSystemPrompt(baseContext);
    expect(prompt).toContain('Use US English');
    expect(prompt).toContain('organize');
  });
});

describe('buildSystemPrompt — workflow branch', () => {
  it('renders the direct-booking workflow when bookingMethod is direct_link', async () => {
    const prompt = await buildSystemPrompt({ ...baseContext, bookingMethod: 'direct_link' });
    expect(prompt).toContain('DIRECT BOOKING');
    expect(prompt).toContain('booked directly through');
  });

  it('renders the agent-negotiated workflow by default', async () => {
    const prompt = await buildSystemPrompt(baseContext);
    expect(prompt).not.toContain('DIRECT BOOKING — Client Used External Booking Link');
  });
});

describe('buildSystemPrompt — tools listing', () => {
  // Each tool the agent can invoke must be named in the prompt's tool
  // list, otherwise the model lacks the guidance to choose it. If a
  // tool is added/removed in agent-tool-loop, this test forces the
  // documenter to update both places.
  const REQUIRED_TOOL_MENTIONS = [
    'send_email',
    'update_therapist_availability',
    'mark_scheduling_complete',
    'initiate_reschedule',
    'cancel_appointment',
    'recommend_cancel_match',
    'issue_voucher_code',
    'flag_for_human_review',
    'remember',
    'record_availability_window',
  ];

  it.each(REQUIRED_TOOL_MENTIONS)('mentions the %s tool in the Available Tools section', async (tool) => {
    const prompt = await buildSystemPrompt(baseContext);
    expect(prompt).toContain(tool);
  });
});

describe('buildSystemPrompt — memory wiring', () => {
  it('renders thread notes when present on the appointment', async () => {
    const prismaMock = jest.requireMock('../utils/database');
    prismaMock.prisma.appointmentRequest.findUnique.mockResolvedValueOnce({
      memory: {
        notes: [
          {
            id: 'n1',
            category: 'preference',
            text: 'TEST_NOTE_PREFERS_MORNINGS',
            createdAt: '2026-01-01T00:00:00Z',
          },
        ],
        availabilityWindows: [],
      },
    });

    const prompt = await buildSystemPrompt(baseContext);
    expect(prompt).toContain('TEST_NOTE_PREFERS_MORNINGS');
    expect(prompt).toContain('Notes from earlier in this conversation');
  });

  it('renders availability windows when present and in the future', async () => {
    const future = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString();
    const futureEnd = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000 + 3600_000).toISOString();
    const prismaMock = jest.requireMock('../utils/database');
    prismaMock.prisma.appointmentRequest.findUnique.mockResolvedValueOnce({
      memory: {
        notes: [],
        availabilityWindows: [
          {
            id: 'w1',
            startsAt: future,
            endsAt: futureEnd,
            status: 'available',
            source: 'therapist',
            quote: 'TEST_WINDOW_THIS_FRIDAY',
            recordedAt: '2026-01-01T00:00:00Z',
          },
        ],
      },
    });

    const prompt = await buildSystemPrompt(baseContext);
    expect(prompt).toContain('TEST_WINDOW_THIS_FRIDAY');
    expect(prompt).toContain('Ad-hoc availability mentioned');
  });

  it('omits the memory section entirely when there are no notes or windows', async () => {
    const prompt = await buildSystemPrompt(baseContext);
    expect(prompt).not.toContain('Notes from earlier in this conversation');
    expect(prompt).not.toContain('Ad-hoc availability mentioned');
  });

  it('reads memory STRICTLY by appointment ID — never by other identifiers', async () => {
    // This is the cross-thread isolation guarantee in code form. If
    // anyone replaces findUnique with findFirst or adds a fallback
    // query path, this test fails.
    const prismaMock = jest.requireMock('../utils/database');
    prismaMock.prisma.appointmentRequest.findUnique.mockClear();

    await buildSystemPrompt(baseContext);

    expect(prismaMock.prisma.appointmentRequest.findUnique).toHaveBeenCalledTimes(1);
    expect(prismaMock.prisma.appointmentRequest.findUnique).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: 'apt-test-1' },
      }),
    );
  });
});

describe('buildSystemPrompt — Layer C profile wiring', () => {
  it('omits both profile sections when userId/therapistId are absent (legacy rows)', async () => {
    const prismaMock = jest.requireMock('../utils/database');
    prismaMock.prisma.user.findUnique.mockClear();
    prismaMock.prisma.therapist.findUnique.mockClear();

    const prompt = await buildSystemPrompt(baseContext);

    expect(prompt).not.toContain('What we know about this client from prior bookings');
    expect(prompt).not.toContain('What we know about this therapist from prior bookings');
    // No lookup at all when ids absent — saves a DB roundtrip.
    expect(prismaMock.prisma.user.findUnique).not.toHaveBeenCalled();
    expect(prismaMock.prisma.therapist.findUnique).not.toHaveBeenCalled();
  });

  it('renders the user profile section when userId is set and the user has notes', async () => {
    const prismaMock = jest.requireMock('../utils/database');
    prismaMock.prisma.user.findUnique.mockResolvedValueOnce({
      agentNotes: {
        notes: [
          {
            id: 'u1',
            category: 'communication',
            text: 'TEST_USER_PROFILE_NOTE',
            source: 'admin',
            createdAt: '2026-01-01T00:00:00Z',
          },
        ],
        updatedAt: '2026-01-01T00:00:00Z',
        version: 'v1',
      },
    });

    const prompt = await buildSystemPrompt({ ...baseContext, userId: 'user-1' });
    expect(prompt).toContain('## What we know about this client from prior bookings');
    expect(prompt).toContain('TEST_USER_PROFILE_NOTE');
  });

  it('renders the therapist profile section when therapistId is set and notes exist', async () => {
    const prismaMock = jest.requireMock('../utils/database');
    // The prompt builder now makes TWO therapist.findUnique calls when
    // therapistId is set:
    //   (1) getTherapistProfile (Layer C agent notes)
    //   (2) getTherapistSchedulingDataForPrompt (upcomingAvailability +
    //       bookingLink — populated by the availability-collection
    //       agent). Both go through findUnique with primary-key where.
    // Use mockImplementation so either-order resolution returns the
    // right shape for each select.
    prismaMock.prisma.therapist.findUnique.mockImplementation(
      ({ select }: { select?: Record<string, unknown> }) => {
        if (select?.agentNotes) {
          return Promise.resolve({
            agentNotes: {
              notes: [
                {
                  id: 't1',
                  category: 'scheduling',
                  text: 'TEST_THERAPIST_PROFILE_NOTE',
                  source: 'admin',
                  createdAt: '2026-01-01T00:00:00Z',
                },
              ],
              updatedAt: '2026-01-01T00:00:00Z',
              version: 'v1',
            },
          });
        }
        if (select?.upcomingAvailability || select?.bookingLink) {
          return Promise.resolve({ upcomingAvailability: null, bookingLink: null });
        }
        return Promise.resolve(null);
      },
    );

    const prompt = await buildSystemPrompt({ ...baseContext, therapistId: 'thx-1' });
    expect(prompt).toContain('## What we know about this therapist from prior bookings');
    expect(prompt).toContain('TEST_THERAPIST_PROFILE_NOTE');
  });

  it('reads profile STRICTLY by primary key — never via email or other fields', async () => {
    // The cross-thread isolation guarantee for Layer C, mirrored from
    // Layer B's equivalent test. If anyone replaces findUnique with
    // findFirst or adds a fallback query path, this test fails.
    //
    // After phase-6 booking-side wiring, therapist.findUnique is called
    // TWICE per prompt build: once for Layer C agent notes, once for
    // the per-therapist upcomingAvailability + bookingLink. Both use a
    // primary-key where clause; the strict-scoping intent is preserved
    // — every call goes through `where: { id: X }`, never findFirst,
    // never email or any other identifier.
    const prismaMock = jest.requireMock('../utils/database');
    prismaMock.prisma.user.findUnique.mockClear();
    prismaMock.prisma.therapist.findUnique.mockClear();

    await buildSystemPrompt({ ...baseContext, userId: 'user-1', therapistId: 'thx-1' });

    expect(prismaMock.prisma.user.findUnique).toHaveBeenCalledTimes(1);
    expect(prismaMock.prisma.user.findUnique).toHaveBeenCalledWith(
      expect.objectContaining({ where: { id: 'user-1' } }),
    );
    expect(prismaMock.prisma.therapist.findUnique).toHaveBeenCalledTimes(2);
    // Every call to therapist.findUnique must use a primary-key where.
    for (const call of prismaMock.prisma.therapist.findUnique.mock.calls) {
      expect(call[0]).toEqual(expect.objectContaining({ where: { id: 'thx-1' } }));
    }
  });

  it('omits a profile section when the row exists but has no notes', async () => {
    const prismaMock = jest.requireMock('../utils/database');
    prismaMock.prisma.user.findUnique.mockResolvedValueOnce({ agentNotes: null });

    const prompt = await buildSystemPrompt({ ...baseContext, userId: 'user-1' });
    expect(prompt).not.toContain('What we know about this client from prior bookings');
  });
});

describe('buildSystemPrompt — knowledge wiring', () => {
  it('includes the therapist and user knowledge blocks', async () => {
    const prompt = await buildSystemPrompt(baseContext);
    expect(prompt).toContain('TEST_KNOWLEDGE_THERAPIST_BLOCK');
    expect(prompt).toContain('TEST_KNOWLEDGE_USER_BLOCK');
  });

  it('still builds successfully when the knowledge service returns empty', async () => {
    // Models the timeout-fallback path: withTimeout rejects, the catch
    // sets knowledge to {forTherapist:'', forUser:''}, the rest of the
    // prompt still assembles. Don't drive the actual timeout in unit
    // tests (5s real wall clock); just simulate the post-catch state.
    const knowledge = jest.requireMock('../services/knowledge.service');
    knowledge.knowledgeService.getKnowledgeForPrompt.mockResolvedValueOnce({
      forTherapist: '',
      forUser: '',
    });

    const prompt = await buildSystemPrompt(baseContext);
    expect(prompt).toContain('## Your Identity');
    expect(prompt).toContain('## Available Tools');
  });
});
