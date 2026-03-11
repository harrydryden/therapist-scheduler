import { useQueryClient } from '@tanstack/react-query';
import { ErrorBoundary } from './ErrorBoundary';
import { actionClosure } from '../api/client';
import type { AppointmentDetail } from '../types';
import { useAppointmentControls } from '../hooks/useAppointmentControls';
import DetailHeader from './detail-panel/DetailHeader';
import ClosureRecommendationSection from './detail-panel/ClosureRecommendationSection';
import AppointmentSummarySection from './detail-panel/AppointmentSummarySection';
import CompactControlPanel from './detail-panel/CompactControlPanel';
import AppointmentDetailSkeleton from './skeletons/AppointmentDetailSkeleton';

interface AppointmentDetailPanelProps {
  selectedAppointment: string | null;
  appointmentDetail: AppointmentDetail | undefined;
  loadingDetail: boolean;
  detailError: Error | null;
  onClearSelection: () => void;
}

export default function AppointmentDetailPanel({
  selectedAppointment,
  appointmentDetail,
  loadingDetail,
  detailError,
  onClearSelection,
}: AppointmentDetailPanelProps) {
  const queryClient = useQueryClient();
  const controls = useAppointmentControls(selectedAppointment, appointmentDetail, onClearSelection);

  if (!selectedAppointment) {
    return (
      <div className="bg-white rounded-2xl shadow-sm border border-slate-100 overflow-hidden">
        <div className="p-8 text-center text-slate-500 h-full flex items-center justify-center min-h-[400px]">
          <div>
            <svg
              className="w-12 h-12 text-slate-300 mx-auto mb-3"
              fill="none"
              stroke="currentColor"
              viewBox="0 0 24 24"
            >
              <path
                strokeLinecap="round"
                strokeLinejoin="round"
                strokeWidth={2}
                d="M8 12h.01M12 12h.01M16 12h.01M21 12c0 4.418-4.03 8-9 8a9.863 9.863 0 01-4.255-.949L3 20l1.395-3.72C3.512 15.042 3 13.574 3 12c0-4.418 4.03-8 9-8s9 3.582 9 8z"
              />
            </svg>
            <p>Select an appointment to view details</p>
          </div>
        </div>
      </div>
    );
  }

  if (loadingDetail) {
    return <AppointmentDetailSkeleton />;
  }

  if (!appointmentDetail) {
    return (
      <div className="bg-white rounded-2xl shadow-sm border border-slate-100 overflow-hidden">
        <div className="p-8 text-center text-slate-500 h-full flex items-center justify-center min-h-[400px]">
          <div>
            <svg
              className="w-12 h-12 text-red-300 mx-auto mb-3"
              fill="none"
              stroke="currentColor"
              viewBox="0 0 24 24"
            >
              <path
                strokeLinecap="round"
                strokeLinejoin="round"
                strokeWidth={2}
                d="M12 8v4m0 4h.01M21 12a9 9 0 11-18 0 9 9 0 0118 0z"
              />
            </svg>
            <p className="font-medium text-slate-700 mb-1">Failed to load appointment details</p>
            <p className="text-sm text-slate-400 mb-3">
              {detailError?.message || 'The appointment data could not be retrieved.'}
            </p>
            <button
              onClick={onClearSelection}
              className="text-sm text-spill-blue-800 hover:underline"
            >
              Go back to list
            </button>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="bg-white rounded-2xl shadow-sm border border-slate-100 overflow-hidden">
      <ErrorBoundary fallback={
        <div className="p-8 text-center text-red-500">
          <p className="font-medium mb-2">Failed to render appointment details</p>
          <button onClick={onClearSelection} className="text-sm text-spill-blue-800 hover:underline">
            Go back to list
          </button>
        </div>
      }>
        <div className="flex flex-col">
          <DetailHeader appointment={appointmentDetail} />

          <AppointmentSummarySection summary={appointmentDetail.summary} />

          <ClosureRecommendationSection
            appointment={appointmentDetail}
            onAction={async (action) => {
              await actionClosure(appointmentDetail.id, action);
              queryClient.invalidateQueries({ queryKey: ['appointment', selectedAppointment] });
              queryClient.invalidateQueries({ queryKey: ['appointments'], refetchType: 'none' });
              queryClient.invalidateQueries({ queryKey: ['dashboard-stats'], refetchType: 'none' });
              if (action === 'cancel') {
                onClearSelection();
              }
            }}
          />

          <CompactControlPanel
            appointment={appointmentDetail}
            controls={controls}
          />
        </div>
      </ErrorBoundary>
    </div>
  );
}
