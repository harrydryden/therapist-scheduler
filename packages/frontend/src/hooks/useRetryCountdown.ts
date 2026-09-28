import { useEffect, useState } from 'react';
import { ApiError } from '../api/core';

/**
 * When a rate-limited request (HTTP 429) may be retried, as an epoch-ms
 * deadline, or null when the error isn't a rate limit with a Retry-After.
 */
export function retryDeadline(error: unknown, now: number = Date.now()): number | null {
  if (!(error instanceof ApiError) || !error.isRateLimited() || !error.retryAfter) return null;
  return now + error.retryAfter * 1000;
}

/** Whole seconds left until `deadline` (0 once it has passed). */
export function secondsUntil(deadline: number | null, now: number = Date.now()): number {
  if (deadline === null) return 0;
  return Math.max(0, Math.ceil((deadline - now) / 1000));
}

/**
 * Live "try again in N seconds" countdown for a failed public POST. Public
 * forms used to sleep through a 429 silently for up to a minute; now they
 * fail fast and show this instead. Returns 0 when there's nothing to wait for.
 */
export function useRetryCountdown(error: unknown): number {
  const [deadline, setDeadline] = useState<number | null>(null);
  const [remaining, setRemaining] = useState(0);

  useEffect(() => {
    const next = retryDeadline(error);
    setDeadline(next);
    setRemaining(secondsUntil(next));
  }, [error]);

  useEffect(() => {
    if (deadline === null) return;
    const timer = setInterval(() => {
      const left = secondsUntil(deadline);
      setRemaining(left);
      if (left === 0) clearInterval(timer);
    }, 1000);
    return () => clearInterval(timer);
  }, [deadline]);

  return remaining;
}
