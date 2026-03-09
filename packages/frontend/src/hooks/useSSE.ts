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

    function connect() {
      // Get fresh secret on each reconnect to pick up re-authentication
      const currentSecret = getAdminSecret();
      if (!currentSecret) return;

      // Clean up previous connection
      if (eventSourceRef.current) {
        eventSourceRef.current.close();
      }

      // SECURITY NOTE: Admin secret passed as URL query parameter (appears in server logs,
      // browser history, proxy logs). Accepted risk for EventSource API limitation.
      // TODO: Migrate to httpOnly cookie auth when SSE auth is reworked.
      const url = `${API_BASE}/admin/dashboard/events?secret=${encodeURIComponent(currentSecret)}`;
      const es = new EventSource(url);
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
              // Only invalidate the specific appointment detail (less disruptive)
              if (data.appointmentId) {
                queryClient.invalidateQueries({ queryKey: ['appointment', data.appointmentId] });
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

        // Exponential backoff: 2s, 4s, 8s, 16s, then cap at 30s
        const delay = Math.min(2000 * Math.pow(2, reconnectAttemptsRef.current), 30000);
        reconnectAttemptsRef.current++;

        reconnectTimerRef.current = setTimeout(connect, delay);
      };
    }

    connect();

    return () => {
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
