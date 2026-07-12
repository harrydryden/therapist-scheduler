/**
 * `resolve_local_time` — wall-clock → ISO 8601 conversion in a
 * supplied IANA timezone.
 *
 * Pure: no DB, no Redis, no audit. Shared with the availability-
 * collection agent's executor — the implementation lives in the
 * shared `core/timezone` module and both executors call through
 * identically. DST-aware: ambiguous fall-back hours and non-existent
 * spring-forward hours surface as specific errors the model can
 * re-prompt around.
 *
 * Bypasses the side-effect gate and idempotency layer — see the
 * comment at the top of `dispatch.ts`.
 */

import { resolveLocalTimeInputSchema } from '../../../../schemas/tool-inputs';
import { resolveWallClock, formatIsoWithOffset } from '../../../../core/timezone';
import type { ToolExecutionResult } from '../../../../services/scheduling-context.service';

export async function handleResolveLocalTime(rawInput: unknown): Promise<ToolExecutionResult> {
  const parsed = resolveLocalTimeInputSchema.safeParse(rawInput);
  if (!parsed.success) {
    return {
      success: false,
      toolName: 'resolve_local_time',
      error: `Invalid input: ${parsed.error.issues.map((i) => i.message).join('; ')}`,
    };
  }
  const { timezone, year, month, day, hour, minute, duration_minutes } = parsed.data;

  const startResult = resolveWallClock(timezone, year, month - 1, day, hour, minute);
  if (!startResult.ok) {
    return {
      success: false,
      toolName: 'resolve_local_time',
      error: `${startResult.error}: ${startResult.detail}`,
    };
  }
  const startsAt = formatIsoWithOffset(startResult.resolved);
  const endUtcMs = startResult.resolved.utcMs + duration_minutes * 60000;

  // Recompute the offset at the end instant so a duration that
  // straddles a DST transition produces an end with the correct
  // post-transition offset.
  const endParts = new Intl.DateTimeFormat('en-GB', {
    timeZone: timezone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  }).formatToParts(new Date(endUtcMs));
  const get = (t: string) => +(endParts.find((p) => p.type === t)?.value ?? '0');
  const endWallMs = Date.UTC(get('year'), get('month') - 1, get('day'), get('hour'), get('minute'));
  const endOffset = Math.round((endWallMs - endUtcMs) / 60000);
  const endsAt = formatIsoWithOffset({ utcMs: endUtcMs, offsetMinutes: endOffset });

  return {
    success: true,
    toolName: 'resolve_local_time',
    resultMessage: JSON.stringify({ starts_at: startsAt, ends_at: endsAt }),
  };
}
