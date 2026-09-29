/**
 * Production-mode boot warnings for misconfigured Pub/Sub.
 *
 * Pulled out of `config/index.ts` so unit tests can exercise the real
 * helpers without booting `loadConfig()` (which requires every prod
 * env var to be set or it process.exit(1)s).
 *
 * History:
 *   - Original H5 fix (#191) refused to validate config when production
 *     had REQUIRE_PUBSUB_AUTH=false. That crash-looped any service
 *     already running with the override.
 *   - Hotfix (#195) softened that to a recurring banner that doesn't
 *     abort startup — availability beats hard-failing, since the
 *     inbound webhook is one piece of a wider product and other
 *     endpoints should keep working while ops removes the override.
 *   - This module now also warns when GOOGLE_PUBSUB_AUDIENCE is unset
 *     in production — without it, the webhook's verifyIdToken call
 *     passes `audience: undefined`, which means Google's library skips
 *     the audience claim check entirely. Tokens minted for any
 *     audience (or by any GCP push subscription pointing at us) would
 *     verify, and on the history-gap path a forged notification could
 *     steer the sync checkpoint.
 *   - The webhook now REJECTS pushes (401 + deduped Slack alert) in that
 *     configuration — see `isPubsubAudienceRequiredButMissing`. Still
 *     NOT a startup failure: boot keeps working (the backup poller keeps
 *     mail flowing) so a tightened check cannot crash-loop the service
 *     the way #191 did.
 *
 * Both warnings share the same `INSECURE CONFIG` banner shape so log
 * monitoring tools can match a single string and page on either.
 *
 * Operators MUST treat these warnings as P1. The recurring log
 * (every 10 minutes) is intended to make them impossible to ignore.
 */

const RECUR_MS = 10 * 60 * 1000;

// Module-level guards so we never schedule more than one recurring
// interval per process for each warning kind. Without these, anything
// that re-imports this module (some Jest setups, hot-reload tooling)
// would leak intervals and multiply the banner spam.
let pubsubAuthWarningArmed = false;
let pubsubAudienceWarningArmed = false;

// Track scheduled intervals so test setup can clear them between
// cases. unref() alone makes the interval not block process exit, but
// Jest's "worker did not exit gracefully" check still sees them as
// pending handles. Clearing them on teardown silences that warning
// and unmasks any actual leaks.
const scheduledIntervals: NodeJS.Timeout[] = [];

function emitInsecureConfigBanner(message: string): void {
  // eslint-disable-next-line no-console
  console.error(
    '\n' +
      '!!! '.repeat(20) + '\n' +
      '!!! INSECURE CONFIG: ' + message + '\n' +
      '!!! '.repeat(20),
  );
}

/** Schedule a recurring re-emit; unref so it never blocks process exit. */
function scheduleRecurring(message: string): void {
  const interval = setInterval(() => emitInsecureConfigBanner(message), RECUR_MS);
  if (typeof interval.unref === 'function') interval.unref();
  scheduledIntervals.push(interval);
}

/** Warn loudly if the Pub/Sub auth check is disabled in production. */
export function checkProductionPubsubAuth(
  cfg: { env: string; requirePubsubAuth: boolean },
): void {
  if (cfg.env !== 'production' || cfg.requirePubsubAuth !== false) return;
  if (pubsubAuthWarningArmed) return;
  pubsubAuthWarningArmed = true;

  const message =
    'REQUIRE_PUBSUB_AUTH=false in production. The Gmail push webhook is ' +
    'accepting unauthenticated POSTs — forged Pub/Sub notifications can ' +
    'drive bounce, cancel, and reschedule flows. Configure GCP Pub/Sub ' +
    'OIDC auth (set GOOGLE_PUBSUB_AUDIENCE) and unset this override.';

  emitInsecureConfigBanner(message);
  scheduleRecurring(message);
}

/** Warn loudly if production is missing GOOGLE_PUBSUB_AUDIENCE. */
export function checkProductionPubsubAudience(
  cfg: { env: string; googlePubsubAudience?: string },
): void {
  if (cfg.env !== 'production') return;
  if (cfg.googlePubsubAudience && cfg.googlePubsubAudience.length > 0) return;
  if (pubsubAudienceWarningArmed) return;
  pubsubAudienceWarningArmed = true;

  const message =
    'GOOGLE_PUBSUB_AUDIENCE is unset in production. Without it the ' +
    'audience claim of Pub/Sub push tokens cannot be checked (a token ' +
    'minted for ANY GCP push subscription pointing at this host would ' +
    'verify), so while GOOGLE_PUBSUB_TOPIC is set the Gmail push webhook ' +
    'REJECTS every push with 401 and inbound mail arrives only via the ' +
    'backup poll. Set GOOGLE_PUBSUB_AUDIENCE to the audience configured ' +
    'on the Pub/Sub push subscription (typically the full webhook URL: ' +
    'https://<host>/api/webhooks/gmail/push).';

  emitInsecureConfigBanner(message);
  scheduleRecurring(message);
}

/**
 * True when the Gmail push webhook must refuse pushes because production
 * is configured for push (GOOGLE_PUBSUB_TOPIC set) without the audience
 * that makes token verification meaningful. The explicit
 * REQUIRE_PUBSUB_AUTH=false override (its own P1 banner above) is left in
 * charge of its unauthenticated mode.
 */
export function isPubsubAudienceRequiredButMissing(cfg: {
  env: string;
  googlePubsubTopic?: string;
  googlePubsubAudience?: string;
  requirePubsubAuth: boolean;
}): boolean {
  if (cfg.env !== 'production') return false;
  if (cfg.requirePubsubAuth === false) return false;
  if (!cfg.googlePubsubTopic) return false;
  return !cfg.googlePubsubAudience || cfg.googlePubsubAudience.length === 0;
}

/** Test-only helper to reset the once-per-process guards AND clear
 *  any scheduled recurring intervals from prior test cases. Not part
 *  of the public API; only the test file imports this. Calling it in
 *  `afterEach` keeps Jest from complaining about unstopped handles. */
export function _resetPubsubWarningGuardsForTesting(): void {
  pubsubAuthWarningArmed = false;
  pubsubAudienceWarningArmed = false;
  for (const id of scheduledIntervals) clearInterval(id);
  scheduledIntervals.length = 0;
}
