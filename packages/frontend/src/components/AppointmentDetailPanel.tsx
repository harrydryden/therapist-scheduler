import { useState, useEffect, useRef, useMemo } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { ErrorBoundary } from './ErrorBoundary';
import {
  takeControl,
  releaseControl,
  sendAdminMessage,
  deleteAppointment,
  updateAppointment,
  previewReprocessThread,
  reprocessThread,
} from '../api/client';
import type { ReprocessPreviewResult, ReprocessThreadResult } from '../api/client';
import type { AppointmentDetail } from '../types';
import { getAdminId } from '../utils/admin-id';
import DetailHeader from './detail-panel/DetailHeader';
import HumanControlSection from './detail-panel/HumanControlSection';
import DeleteSection from './detail-panel/DeleteSection';
import ConversationSection from './detail-panel/ConversationSection';
import AppointmentDetailSkeleton from './skeletons/AppointmentDetailSkeleton';

interface AppointmentDetailPanelProps {
  selectedAppointment: string | null;
  appointmentDetail: AppointmentDetail | undefined;
  loadingDetail: boolean;
  onClearSelection: () => void;
}

export default function AppointmentDetailPanel({
  selectedAppointment,
  appointmentDetail,
  loadingDetail,
  onClearSelection,
}: AppointmentDetailPanelProps) {
  const queryClient = useQueryClient();
  const adminId = useMemo(() => getAdminId(), []);

  const [mutationError, setMutationError] = useState<string | null>(null);
  const [showEditPanel, setShowEditPanel] = useState(false);
  const [editStatus, setEditStatus] = useState<string | null>(null);
  const [editConfirmedDateTime, setEditConfirmedDateTime] = useState('');
  const [editWarning, setEditWarning] = useState<string | null>(null);
  const editWarningTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const [reprocessPreview, setReprocessPreview] = useState<ReprocessPreviewResult | null>(null);
  const [reprocessResult, setReprocessResult] = useState<ReprocessThreadResult | null>(null);

  // Reset state when switching appointments
  useEffect(() => {
    setMutationError(null);
    setShowEditPanel(false);
    setEditWarning(null);
    setReprocessPreview(null);
    setReprocessResult(null);
  }, [selectedAppointment]);

  // Sync edit form state when appointment detail loads
  useEffect(() => {
    if (appointmentDetail) {
      setEditStatus(appointmentDetail.status);
      setEditConfirmedDateTime(appointmentDetail.confirmedDateTime || '');
    }
  }, [appointmentDetail]);

  // Clear editWarning timeout on unmount
  useEffect(() => {
    return () => {
      if (editWarningTimeoutRef.current) {
        clearTimeout(editWarningTimeoutRef.current);
      }
    };
  }, []);

  // Mutations with optimistic updates for immediate UI feedback
  const takeControlMutation = useMutation({
    mutationFn: ({ id, reason }: { id: string; reason?: string }) =>
      takeControl(id, { adminId, reason }),
    onMutate: async () => {
      setMutationError(null);
      // Optimistically update the appointment detail cache
      await queryClient.cancelQueries({ queryKey: ['appointment', selectedAppointment] });
      const previous = queryClient.getQueryData<AppointmentDetail>(['appointment', selectedAppointment]);
      if (previous) {
        queryClient.setQueryData(['appointment', selectedAppointment], {
          ...previous,
          humanControlEnabled: true,
          humanControlTakenBy: adminId,
          humanControlTakenAt: new Date().toISOString(),
        });
      }
      return { previous };
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['appointment', selectedAppointment] });
      queryClient.invalidateQueries({ queryKey: ['appointments'] });
      setMutationError(null);
    },
    onError: (error, _vars, context) => {
      // Rollback optimistic update on error
      if (context?.previous) {
        queryClient.setQueryData(['appointment', selectedAppointment], context.previous);
      }
      setMutationError(error instanceof Error ? error.message : 'Failed to take control');
    },
  });

  const releaseControlMutation = useMutation({
    mutationFn: (id: string) => releaseControl(id),
    onMutate: async () => {
      setMutationError(null);
      await queryClient.cancelQueries({ queryKey: ['appointment', selectedAppointment] });
      const previous = queryClient.getQueryData<AppointmentDetail>(['appointment', selectedAppointment]);
      if (previous) {
        queryClient.setQueryData(['appointment', selectedAppointment], {
          ...previous,
          humanControlEnabled: false,
          humanControlTakenBy: null,
          humanControlTakenAt: null,
        });
      }
      return { previous };
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['appointment', selectedAppointment] });
      queryClient.invalidateQueries({ queryKey: ['appointments'] });
      setMutationError(null);
    },
    onError: (error, _vars, context) => {
      if (context?.previous) {
        queryClient.setQueryData(['appointment', selectedAppointment], context.previous);
      }
      setMutationError(error instanceof Error ? error.message : 'Failed to release control');
    },
  });

  const sendMessageMutation = useMutation({
    mutationFn: ({ id, to, subject, body }: { id: string; to: string; subject: string; body: string }) =>
      sendAdminMessage(id, { to, subject, body, adminId }),
    onMutate: () => { setMutationError(null); },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['appointment', selectedAppointment] });
      setMutationError(null);
    },
    onError: (error) => {
      setMutationError(error instanceof Error ? error.message : 'Failed to send message');
    },
  });

  const deleteAppointmentMutation = useMutation({
    mutationFn: ({ id, reason, forceDeleteConfirmed: force }: { id: string; reason?: string; forceDeleteConfirmed?: boolean }) =>
      deleteAppointment(id, { adminId, reason, forceDeleteConfirmed: force }),
    onMutate: () => { setMutationError(null); },
    onSuccess: () => {
      onClearSelection();
      queryClient.invalidateQueries({ queryKey: ['appointments'] });
      queryClient.invalidateQueries({ queryKey: ['dashboard-stats'] });
      setMutationError(null);
    },
    onError: (error) => {
      setMutationError(error instanceof Error ? error.message : 'Failed to delete appointment');
    },
  });

  const updateAppointmentMutation = useMutation({
    mutationFn: ({ id, status, confirmedDateTime }: { id: string; status?: string; confirmedDateTime?: string | null }) =>
      updateAppointment(id, {
        status: status as 'pending' | 'contacted' | 'negotiating' | 'confirmed' | 'cancelled' | undefined,
        confirmedDateTime,
        adminId,
      }),
    onMutate: () => { setMutationError(null); },
    onSuccess: (data) => {
      queryClient.invalidateQueries({ queryKey: ['appointment', selectedAppointment] });
      queryClient.invalidateQueries({ queryKey: ['appointments'] });
      queryClient.invalidateQueries({ queryKey: ['dashboard-stats'] });
      setShowEditPanel(false);
      setMutationError(null);
      if (data.warning) {
        setEditWarning(data.warning);
        if (editWarningTimeoutRef.current) {
          clearTimeout(editWarningTimeoutRef.current);
        }
        editWarningTimeoutRef.current = setTimeout(() => setEditWarning(null), 5000);
      }
    },
    onError: (error) => {
      setMutationError(error instanceof Error ? error.message : 'Failed to update appointment');
    },
  });

  const previewReprocessMutation = useMutation({
    mutationFn: (id: string) => previewReprocessThread(id),
    onMutate: () => { setMutationError(null); setReprocessResult(null); },
    onSuccess: (data) => {
      setReprocessPreview(data);
      setMutationError(null);
    },
    onError: (error) => {
      setMutationError(error instanceof Error ? error.message : 'Failed to preview thread');
    },
  });

  const reprocessThreadMutation = useMutation({
    mutationFn: ({ id, forceMessageIds }: { id: string; forceMessageIds?: string[] }) =>
      reprocessThread(id, forceMessageIds),
    onMutate: () => { setMutationError(null); },
    onSuccess: (data) => {
      queryClient.invalidateQueries({ queryKey: ['appointment', selectedAppointment] });
      queryClient.invalidateQueries({ queryKey: ['appointments'] });
      setReprocessPreview(null);
      setReprocessResult(data);
      setMutationError(null);
    },
    onError: (error) => {
      setMutationError(error instanceof Error ? error.message : 'Failed to reprocess thread');
    },
  });

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

  if (!appointmentDetail) return null;

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
        <div className="h-full flex flex-col">
          <DetailHeader appointment={appointmentDetail} />

          <HumanControlSection
            appointment={appointmentDetail}
            mutationError={mutationError}
            onDismissError={() => setMutationError(null)}
            takeControlMutation={takeControlMutation}
            releaseControlMutation={releaseControlMutation}
            updateAppointmentMutation={updateAppointmentMutation}
            sendMessageMutation={sendMessageMutation}
            previewReprocessMutation={previewReprocessMutation}
            reprocessThreadMutation={reprocessThreadMutation}
            reprocessPreview={reprocessPreview}
            reprocessResult={reprocessResult}
            onDismissReprocessPreview={() => setReprocessPreview(null)}
            onDismissReprocessResult={() => setReprocessResult(null)}
            showEditPanel={showEditPanel}
            onShowEditPanel={setShowEditPanel}
            editStatus={editStatus}
            onEditStatusChange={setEditStatus}
            editConfirmedDateTime={editConfirmedDateTime}
            onEditConfirmedDateTimeChange={setEditConfirmedDateTime}
            editWarning={editWarning}
          />

          <div className="p-4 border-b border-slate-100 bg-slate-50">
            <DeleteSection
              appointment={appointmentDetail}
              deleteMutation={deleteAppointmentMutation}
            />
          </div>

          <ConversationSection conversation={appointmentDetail.conversation} />
        </div>
      </ErrorBoundary>
    </div>
  );
}
