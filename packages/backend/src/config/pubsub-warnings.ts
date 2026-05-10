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
 *     verify. Less catastrophic than full auth-disabled but still a
 *     silent downgrade vs. the intended security posture.
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
    'GOOGLE_PUBSUB_AUDIENCE is unset in production. The Gmail push ' +
    'webhook still verifies that tokens come from a Google service ' +
    'account, but it does NOT check the audience claim — meaning a ' +
    'token minted for any GCP push subscription pointing at this ' +
    'host would verify. Set GOOGLE_PUBSUB_AUDIENCE to the audience ' +
    'configured on the Pub/Sub push subscription (typically the full ' +
    'webhook URL: https://<host>/api/webhooks/gmail/push).';

  emitInsecureConfigBanner(message);
  scheduleRecurring(message);
}

/** Test-only helper to reset the once-per-process guards. Not part of
 *  the public API; only the test file imports this. */
export function _resetPubsubWarningGuardsForTesting(): void {
  pubsubAuthWarningArmed = false;
  pubsubAudienceWarningArmed = false;
}
