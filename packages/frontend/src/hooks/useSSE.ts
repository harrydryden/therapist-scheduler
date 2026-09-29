/**
 * useSSE — Server-Sent Events hook for real-time dashboard updates.
 *
 * Connects to the backend SSE endpoint and invalidates React Query caches
 * when appointment status, health, or human control changes occur.
 * Falls back to polling if SSE is unavailable (connection error, auth failure).
 */

import { useEffect, useRef } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { API_BASE, getAdminSecret } from '../config/env';
import { AuthError } from '../api/core';
import { getSseTicket } from '../api/appointments';

/**
 * The stream URL for one connection. Carries a single-use, 60-second ticket
 * minted by an authenticated POST — never the admin secret, which used to
 * sit in this URL (and so in proxy logs and browser history).
 */
export function buildEventStreamUrl(ticket: string): string {
  return `${API_BASE}/admin/dashboard/events?ticket=${encodeURIComponent(ticket)}`;
}

/** Reconnect delay: 2s, 4s, 8s, 16s, then capped at 30s. */
export function reconnectDelayMs(attempt: number): number {
  return Math.min(2000 * Math.pow(2, attempt), 30000);
}

interface SSEEvent {
  type: string;
  appointmentId?: string;
  data?: Record<string, unknown>;
  connectionId?: string;
}

export function useSSE() {
  const queryClient = useQueryClient();
  const eventSourceRef = useRef<EventSource | null>(null);
  const reconnectTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const reconnectAttemptsRef = useRef(0);

  useEffect(() => {
    if (!getAdminSecret()) return; // Not authenticated yet
    let cancelled = false;

    function scheduleReconnect() {
      if (cancelled) return;
      const delay = reconnectDelayMs(reconnectAttemptsRef.current);
      reconnectAttemptsRef.current++;
      reconnectTimerRef.current = setTimeout(() => void connect(), delay);
    }

    async function connect() {
      // Re-check on every (re)connect to pick up logout / re-authentication.
      if (cancelled || !getAdminSecret()) return;

      // Clean up previous connection
      if (eventSourceRef.current) {
        eventSourceRef.current.close();
        eventSourceRef.current = null;
      }

      // A fresh single-use ticket for every connection attempt (header-
      // authenticated POST); EventSource can't send the secret as a header.
      let ticket: string;
      try {
        ticket = (await getSseTicket()).ticket;
      } catch (err) {
        // Wrong secret / lockout: AdminLayout shows the login screen; stop.
        if (err instanceof AuthError) return;
        scheduleReconnect();
        return;
      }
      if (cancelled) return;

      const es = new EventSource(buildEventStreamUrl(ticket));
      eventSourceRef.current = es;

      es.onmessage = (event) => {
        try {
          const data: SSEEvent = JSON.parse(event.data);

          switch (data.type) {
            case 'connected':
              // Reset reconnect counter on successful connection
              reconnectAttemptsRef.current = 0;
              break;

            case 'appointment:status-changed':
            case 'appointment:human-control':
              // Invalidate dashboard stats and the specific appointment only.
              // The full list will refresh via its polling interval (30s),
              // avoiding a full re-fetch + re-render cascade on every SSE event.
              queryClient.invalidateQueries({ queryKey: ['dashboard-stats'] });
              if (data.appointmentId) {
                queryClient.invalidateQueries({ queryKey: ['appointment', data.appointmentId] });
                // Optimistically update the list cache entry if it exists
                queryClient.invalidateQueries({
                  queryKey: ['appointments'],
                  refetchType: 'none', // Mark stale without immediate refetch
                });
              }
              break;

            case 'appointment:activity':
              // New message / chase / admin email: refetch the open detail
              // drawer for that appointment (an active query refetches on
              // invalidation), and mark the list stale.
              if (data.appointmentId) {
                queryClient.invalidateQueries({ queryKey: ['appointment', data.appointmentId] });
                queryClient.invalidateQueries({ queryKey: ['appointments'], refetchType: 'none' });
              }
              break;

            case 'stats:updated':
              queryClient.invalidateQueries({ queryKey: ['dashboard-stats'] });
              break;
          }
        } catch {
          // Ignore malformed events (e.g., heartbeat comments)
        }
      };

      es.onerror = () => {
        es.close();
        eventSourceRef.current = null;
        // The ticket is spent; the next attempt fetches a new one.
        scheduleReconnect();
      };
    }

    void connect();

    return () => {
      cancelled = true;
      if (eventSourceRef.current) {
        eventSourceRef.current.close();
        eventSourceRef.current = null;
      }
      if (reconnectTimerRef.current) {
        clearTimeout(reconnectTimerRef.current);
        reconnectTimerRef.current = null;
      }
    };
  }, [queryClient]);
}
