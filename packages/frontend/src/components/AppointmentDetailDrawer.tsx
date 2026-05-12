/**
 * Slide-over drawer wrapping AppointmentDetailPanel.
 *
 * Replaces the previous right-hand-column position of the detail panel
 * with a dismissible drawer triggered from a row click in the new
 * AppointmentsTable. The panel content itself is unchanged; this is a
 * thin presentation wrapper that handles:
 *   - mounting/unmounting based on selection
 *   - esc-to-close + click-outside-to-close
 *   - body scroll lock while open
 *   - mobile full-screen, desktop sliding from the right
 */

import { useEffect } from 'react';
import AppointmentDetailPanel from './AppointmentDetailPanel';
import type { AppointmentDetail } from '../types';

interface AppointmentDetailDrawerProps {
  selectedAppointment: string | null;
  appointmentDetail: AppointmentDetail | undefined;
  loadingDetail: boolean;
  detailError: Error | null;
  onClearSelection: () => void;
}

export default function AppointmentDetailDrawer({
  selectedAppointment,
  appointmentDetail,
  loadingDetail,
  detailError,
  onClearSelection,
}: AppointmentDetailDrawerProps) {
  const isOpen = !!selectedAppointment;

  // Esc closes; body scroll locked while open so the panel scroll is the
  // only scroller. Both effects are no-ops when the drawer is closed.
  useEffect(() => {
    if (!isOpen) return;
    const handleKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClearSelection();
    };
    document.addEventListener('keydown', handleKey);
    const prevOverflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    return () => {
      document.removeEventListener('keydown', handleKey);
      document.body.style.overflow = prevOverflow;
    };
  }, [isOpen, onClearSelection]);

  if (!isOpen) return null;

  return (
    <div
      className="fixed inset-0 z-40 flex justify-end"
      role="dialog"
      aria-modal="true"
      aria-label="Appointment detail"
    >
      {/* Backdrop */}
      <button
        type="button"
        aria-label="Close detail panel"
        onClick={onClearSelection}
        className="absolute inset-0 bg-black/30 transition-opacity"
      />

      {/* Drawer body. max-w on desktop, full-screen below md. */}
      <div className="relative bg-white w-full md:w-[640px] lg:w-[720px] h-full overflow-y-auto shadow-xl border-l border-slate-200 animate-in slide-in-from-right duration-200">
        {/* Close affordance pinned top-right so it's reachable while
            scrolling the panel content. */}
        <button
          type="button"
          onClick={onClearSelection}
          aria-label="Close"
          className="absolute top-3 right-3 z-10 p-1.5 rounded-md text-slate-400 hover:text-slate-700 hover:bg-slate-100 transition-colors"
        >
          <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
          </svg>
        </button>

        <AppointmentDetailPanel
          selectedAppointment={selectedAppointment}
          appointmentDetail={appointmentDetail}
          loadingDetail={loadingDetail}
          detailError={detailError}
          onClearSelection={onClearSelection}
        />
      </div>
    </div>
  );
}
