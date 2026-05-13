/**
 * Unit tests for the timezone guidance section that the system prompt builder
 * embeds in the agent's system prompt. The function is pure (no I/O) so we
 * test it directly without mocking the rest of the prompt assembly.
 */

import { buildTimezoneSection } from '../services/timezone-section';
import type { SchedulingContext } from '../services/scheduling-context.service';

function makeContext(partial: Partial<SchedulingContext>): SchedulingContext {
  return {
    appointmentRequestId: 'apt-1',
    userName: 'Alice',
    userEmail: 'alice@example.com',
    therapistEmail: 'bob@example.com',
    therapistName: 'Bob',
    therapistAvailability: null,
    bookingMethod: 'agent_negotiated',
    userCountry: 'UK',
    therapistCountry: 'UK',
    ...partial,
  };
}

describe('buildTimezoneSection', () => {
  it('always reminds the agent that database times stay in UK time', () => {
    const section = buildTimezoneSection(makeContext({}), 'Europe/London');
    expect(section).toMatch(/database/i);
    expect(section).toMatch(/Europe\/London/);
    expect(section).toMatch(/UK time/);
  });

  it('uses single timezones inline when both parties are in single-timezone countries', () => {
    const section = buildTimezoneSection(
      makeContext({ userCountry: 'IE', therapistCountry: 'UK' }),
      'Europe/London',
    );
    expect(section).toContain('Ireland');
    expect(section).toContain('Europe/Dublin');
    expect(section).toContain('United Kingdom');
    expect(section).toContain('Europe/London');
    // No "ask the client where they are based" language for single-timezone clients
    expect(section).not.toMatch(/MUST ask the client where they are based/i);
  });

  it('instructs the agent to ask the client when their country has multiple timezones', () => {
    const section = buildTimezoneSection(
      makeContext({ userCountry: 'US', therapistCountry: 'UK' }),
      'Europe/London',
    );
    expect(section).toMatch(/ask the client where they are based/i);
    // Must list the candidate IANA timezones
    expect(section).toContain('America/New_York');
    expect(section).toContain('America/Los_Angeles');
  });

  it('instructs the agent to ask the therapist when their country has multiple timezones', () => {
    const section = buildTimezoneSection(
      makeContext({ userCountry: 'UK', therapistCountry: 'AU' }),
      'Europe/London',
    );
    expect(section).toMatch(/ask the therapist where they are based/i);
    expect(section).toContain('Australia/Sydney');
    expect(section).toContain('Australia/Perth');
  });

  it('defaults to UK when country codes are missing', () => {
    const section = buildTimezoneSection(
      makeContext({ userCountry: '', therapistCountry: '' }),
      'Europe/London',
    );
    // Both parties presented as based in the United Kingdom
    const ukMatches = section.match(/United Kingdom/g);
    expect(ukMatches?.length ?? 0).toBeGreaterThanOrEqual(2);
  });

  it('tells the agent to include UK equivalents when timezones differ', () => {
    const section = buildTimezoneSection(
      makeContext({ userCountry: 'IE', therapistCountry: 'UK' }),
      'Europe/London',
    );
    expect(section).toMatch(/UK equivalent|equivalent UK time/i);
  });

  it('mentions both parties by name', () => {
    const section = buildTimezoneSection(
      makeContext({ userName: 'Cara', therapistName: 'Devon', userCountry: 'FR', therapistCountry: 'DE' }),
      'Europe/London',
    );
    expect(section).toContain('Cara');
    expect(section).toContain('Devon');
    expect(section).toContain('Europe/Paris');
    expect(section).toContain('Europe/Berlin');
  });

  // Once the booking agent has recorded an explicit zone via
  // record_user_timezone / record_therapist_timezone, the prompt must
  // STOP asking — otherwise the agent re-asks the same question on
  // every subsequent turn. These tests pin that behaviour.
  it('uses the explicit User.timezone when set, and does NOT instruct the agent to ask the client', () => {
    const section = buildTimezoneSection(
      makeContext({
        userCountry: 'US',
        userTimezone: 'America/Los_Angeles',
        therapistCountry: 'UK',
      }),
      'Europe/London',
    );
    // The explicit zone is shown alongside the country label.
    expect(section).toContain('America/Los_Angeles (United States, on file)');
    // No ASK directive on the client line.
    expect(section).not.toMatch(/ask the client where they are based/i);
  });

  it('uses the explicit Therapist.timezone when set, and does NOT instruct the agent to ask the therapist', () => {
    const section = buildTimezoneSection(
      makeContext({
        userCountry: 'UK',
        therapistCountry: 'AU',
        therapistTimezone: 'Australia/Brisbane',
      }),
      'Europe/London',
    );
    expect(section).toContain('Australia/Brisbane (Australia, on file)');
    expect(section).not.toMatch(/ask the therapist where they are based/i);
  });

  it('asks the client but NOT the therapist when only the client is multi-zone-unknown', () => {
    const section = buildTimezoneSection(
      makeContext({
        userCountry: 'US',
        therapistCountry: 'AU',
        therapistTimezone: 'Australia/Sydney',
      }),
      'Europe/London',
    );
    expect(section).toMatch(/ask the client where they are based/i);
    expect(section).not.toMatch(/ask the therapist where they are based/i);
    expect(section).toContain('Australia/Sydney (Australia, on file)');
  });
});
