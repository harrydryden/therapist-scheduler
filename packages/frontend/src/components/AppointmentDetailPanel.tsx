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
      <div className="bg-white rounded-xl border border-slate-200 overflow-hidden">
        <div className="p-8 text-center text-slate-400 h-full flex items-center justify-center min-h-[300px]">
          <div>
            <svg
              className="w-10 h-10 text-slate-200 mx-auto mb-2"
              fill="none"
              stroke="currentColor"
              viewBox="0 0 24 24"
            >
              <path
                strokeLinecap="round"
                strokeLinejoin="round"
                strokeWidth={1.5}
                d="M15 12a3 3 0 11-6 0 3 3 0 016 0z"
              />
              <path
                strokeLinecap="round"
                strokeLinejoin="round"
                strokeWidth={1.5}
                d="M2.458 12C3.732 7.943 7.523 5 12 5c4.478 0 8.268 2.943 9.542 7-1.274 4.057-5.064 7-9.542 7-4.477 0-8.268-2.943-9.542-7z"
              />
            </svg>
            <p className="text-sm">Select an appointment to view details</p>
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
      <div className="bg-white rounded-xl border border-slate-200 overflow-hidden">
        <div className="p-8 text-center text-slate-400 h-full flex items-center justify-center min-h-[300px]">
          <div>
            <p className="font-medium text-slate-600 mb-1 text-sm">Failed to load details</p>
            <p className="text-xs text-slate-400 mb-3">
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
    <div className="bg-white rounded-xl border border-slate-200 overflow-hidden">
      <ErrorBoundary fallback={
        <div className="p-8 text-center text-spill-red-600">
          <p className="font-medium mb-2 text-sm">Failed to render appointment details</p>
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
