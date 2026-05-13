/**
 * Public surface for the availability bounded context.
 *
 * Three sub-modules under this directory:
 *   - `agent/`     — the LLM agent that collects upcoming availability
 *                    from therapists, plus its tool definitions and
 *                    tool dispatcher.
 *   - `windows/`   — the shared windows datatype + parser +
 *                    therapist-side store + booking-side formatter.
 *   - `resolver.ts`— confirmed-datetime validation used by the
 *                    booking executor before marking complete.
 *
 * Most callers should import from this barrel. Tests that pin a
 * specific submodule (notably the parser and the windows store) can
 * import the submodule path directly to keep their dependency graph
 * narrow.
 */

// Agent surface
export {
  AvailabilityAgentService,
  supersedeActiveTherapistConversationInTx,
  buildAvailabilitySystemPrompt,
  type AvailabilityConversationStateJson,
} from './agent/service';
export { AvailabilityToolExecutorService } from './agent/tool-executor';
export {
  availabilityTools,
  AVAILABILITY_SIDE_EFFECT_TOOLS,
  AVAILABILITY_TERMINAL_TOOLS,
} from './agent/tools';

// Windows / data layer
export {
  windowId,
  parseWindows,
  appendWindowToList,
  getActiveWindows,
  formatWindowsForPrompt,
  MAX_WINDOW_QUOTE_LENGTH,
  type AvailabilityWindow,
  type AppendWindowParams,
  type AppendWindowResult,
  type AppendWindowOptions,
  type FormatWindowsHeaders,
  type FormatWindowsTimezoneTargets,
} from './windows/store';

export {
  getUpcomingAvailability,
  getTherapistSchedulingDataForPrompt,
  addUpcomingAvailability,
  recordTherapistBookingLink,
  formatUpcomingAvailabilityForPrompt,
  MAX_UPCOMING_WINDOWS_PER_THERAPIST,
} from './windows/therapist-store';

export {
  parseDayStringsToSlots,
  buildPersistedAvailability,
} from './windows/parser';

export {
  formatAvailabilityForUser,
  type SlotConfig,
  type FormattedSlot,
  type FormattedAvailability,
  type AvailabilitySlot,
  type TherapistAvailability,
} from './windows/formatter';

// Validation
export {
  AvailabilityResolverService,
  availabilityResolver,
} from './resolver';
