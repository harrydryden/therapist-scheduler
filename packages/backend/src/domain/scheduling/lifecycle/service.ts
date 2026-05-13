/**
 * `appointmentLifecycleService` — the single object that exposes the
 * full transition surface to the rest of the system.
 *
 * Before this refactor it was a class with private helper methods; the
 * helpers turned out to use no `this` state, so the class collapsed
 * into a plain object literal binding the transition functions. Every
 * external caller's API (e.g.
 * `appointmentLifecycleService.transitionToConfirmed(...)`) is
 * preserved exactly.
 */

import {
  transitionToContacted,
  transitionToNegotiating,
  transitionToSessionHeld,
  transitionToFeedbackRequested,
} from './transitions/light';
import { transitionToConfirmed } from './transitions/confirmed';
import { transitionToCompleted } from './transitions/completed';
import { transitionToCancelled } from './transitions/cancelled';
import { adminForceUpdate } from './admin-force';
import { dismissClosureRecommendation } from './closure-dismiss';
import { updateStatus } from './update-status';

export const appointmentLifecycleService = {
  transitionToContacted,
  transitionToNegotiating,
  transitionToConfirmed,
  transitionToSessionHeld,
  transitionToFeedbackRequested,
  transitionToCompleted,
  transitionToCancelled,
  updateStatus,
  adminForceUpdate,
  dismissClosureRecommendation,
};
