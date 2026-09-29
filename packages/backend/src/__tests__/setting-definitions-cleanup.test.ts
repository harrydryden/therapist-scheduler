/**
 * Setting definitions: dead settings removed, turn serialisation on by
 * default (review #15 and §4.7).
 *
 * The admin settings page renders from SETTING_DEFINITIONS, so a key that
 * nothing reads is a control that does nothing when an admin changes it.
 */

import { SETTING_DEFINITIONS } from '../config/setting-definitions';

describe('SETTING_DEFINITIONS', () => {
  it.each(['agent.maxRetries', 'general.maxBookingRequestsPerTherapist'])(
    'no longer offers the unread setting %s',
    (key) => {
      expect(SETTING_DEFINITIONS[key]).toBeUndefined();
    },
  );

  it('turns per-appointment turn serialisation on by default', () => {
    expect(SETTING_DEFINITIONS['agent.turnSerialization'].defaultValue).toBe(true);
  });

  it.each([
    'postBooking.meetingLinkCheckDelayHours',
    'postBooking.meetingLinkCheckMinBeforeHours',
    'postBooking.feedbackFormDelayHours',
  ])('keeps the now-wired setting %s', (key) => {
    expect(SETTING_DEFINITIONS[key]?.valueType).toBe('number');
  });
});
