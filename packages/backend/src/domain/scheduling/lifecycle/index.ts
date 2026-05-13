/**
 * Public surface for the appointment lifecycle.
 *
 * Most callers use the `appointmentLifecycleService` singleton. The
 * `runTerminalTransitionTx` helper is exported for tests that drive
 * the terminal-transition skeleton with a mocked $transaction. Types
 * and errors are re-exported here so callers have one import path
 * for the full lifecycle surface.
 *
 * The `tick` periodic service is in a separate module — callers
 * import it via this barrel (`appointmentLifecycleTickService`).
 */

export { appointmentLifecycleService } from './service';
export { appointmentLifecycleTickService } from './tick';

// Errors — re-exported from the centralised error hierarchy for
// backward compatibility with callers that imported them from this
// module before the split.
export {
  AppointmentNotFoundError,
  InvalidTransitionError,
  ConcurrentModificationError,
} from '../../../errors';

// Types
export type {
  TransitionSource,
  TransitionResult,
  BaseTransitionParams,
  TransitionToContactedParams,
  TransitionToNegotiatingParams,
  TransitionToConfirmedParams,
  TransitionToCompletedParams,
  TransitionToCancelledParams,
  TransitionToSessionHeldParams,
  TransitionToFeedbackRequestedParams,
} from './types';

// Terminal-tx helper exported for unit tests that exercise it directly.
export {
  runTerminalTransitionTx,
  type TerminalTxOutcome,
  type RunTerminalTransitionTxArgs,
} from './terminal-tx';
