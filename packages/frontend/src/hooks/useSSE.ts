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
    const secret = getAdminSecret();
    if (!secret) return; // Not authenticated yet

    function connect() {
      // Clean up previous connection
      if (eventSourceRef.current) {
        eventSourceRef.current.close();
      }

      const url = `${API_BASE}/admin/dashboard/events?secret=${encodeURIComponent(secret)}`;
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
              // Invalidate both the list and the specific appointment detail
              queryClient.invalidateQueries({ queryKey: ['appointments'] });
              queryClient.invalidateQueries({ queryKey: ['dashboard-stats'] });
              if (data.appointmentId) {
                queryClient.invalidateQueries({ queryKey: ['appointment', data.appointmentId] });
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
