import { useState, useEffect, useRef, useMemo } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
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

export interface AppointmentControls {
  adminId: string;
  mutationError: string | null;
  dismissError: () => void;

  // Human control
  takeControlMutation: ReturnType<typeof useMutation<unknown, Error, { id: string; reason?: string }>>;
  releaseControlMutation: ReturnType<typeof useMutation<unknown, Error, string>>;

  // Edit
  showEditPanel: boolean;
  setShowEditPanel: (show: boolean) => void;
  editStatus: string | null;
  setEditStatus: (status: string) => void;
  editConfirmedDateTime: string;
  setEditConfirmedDateTime: (value: string) => void;
  editWarning: string | null;
  updateAppointmentMutation: ReturnType<typeof useMutation<{ warning?: string }, Error, { id: string; status?: string; confirmedDateTime?: string | null }>>;

  // Messaging
  sendMessageMutation: ReturnType<typeof useMutation<unknown, Error, { id: string; to: string; subject: string; body: string }>>;

  // Reprocess
  previewReprocessMutation: ReturnType<typeof useMutation<ReprocessPreviewResult, Error, string>>;
  reprocessThreadMutation: ReturnType<typeof useMutation<ReprocessThreadResult, Error, { id: string; forceMessageIds?: string[] }>>;
  reprocessPreview: ReprocessPreviewResult | null;
  reprocessResult: ReprocessThreadResult | null;
  dismissReprocessPreview: () => void;
  dismissReprocessResult: () => void;

  // Delete
  deleteAppointmentMutation: ReturnType<typeof useMutation<unknown, Error, { id: string; reason?: string; forceDeleteConfirmed?: boolean }>>;
}

export function useAppointmentControls(
  selectedAppointment: string | null,
  appointmentDetail: AppointmentDetail | undefined,
  onClearSelection: () => void,
): AppointmentControls {
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

  // Sync edit form state when appointment detail loads, but not while editing
  useEffect(() => {
    if (appointmentDetail && !showEditPanel) {
      setEditStatus(appointmentDetail.status);
      setEditConfirmedDateTime(appointmentDetail.confirmedDateTime || '');
    }
  }, [appointmentDetail, showEditPanel]);

  // Clear editWarning timeout on unmount
  useEffect(() => {
    return () => {
      if (editWarningTimeoutRef.current) {
        clearTimeout(editWarningTimeoutRef.current);
      }
    };
  }, []);

  const invalidateDetail = () =>
    queryClient.invalidateQueries({ queryKey: ['appointment', selectedAppointment] });
  const invalidateList = () =>
    queryClient.invalidateQueries({ queryKey: ['appointments'], refetchType: 'none' });
  const invalidateStats = () =>
    queryClient.invalidateQueries({ queryKey: ['dashboard-stats'], refetchType: 'none' });

  const takeControlMutation = useMutation({
    mutationFn: ({ id, reason }: { id: string; reason?: string }) =>
      takeControl(id, { adminId, reason }),
    onMutate: async () => {
      setMutationError(null);
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
    onSuccess: () => { invalidateDetail(); invalidateList(); setMutationError(null); },
    onError: (error, _vars, context) => {
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
    onSuccess: () => { invalidateDetail(); invalidateList(); setMutationError(null); },
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
    onSuccess: () => { invalidateDetail(); setMutationError(null); },
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
      invalidateStats();
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
      invalidateDetail();
      invalidateList();
      invalidateStats();
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
    onSuccess: (data) => { setReprocessPreview(data); setMutationError(null); },
    onError: (error) => {
      setMutationError(error instanceof Error ? error.message : 'Failed to preview thread');
    },
  });

  const reprocessThreadMutation = useMutation({
    mutationFn: ({ id, forceMessageIds }: { id: string; forceMessageIds?: string[] }) =>
      reprocessThread(id, forceMessageIds),
    onMutate: () => { setMutationError(null); },
    onSuccess: (data) => {
      invalidateDetail();
      queryClient.invalidateQueries({ queryKey: ['appointments'] });
      setReprocessPreview(null);
      setReprocessResult(data);
      setMutationError(null);
    },
    onError: (error) => {
      setMutationError(error instanceof Error ? error.message : 'Failed to reprocess thread');
    },
  });

  return {
    adminId,
    mutationError,
    dismissError: () => setMutationError(null),
    takeControlMutation,
    releaseControlMutation,
    showEditPanel,
    setShowEditPanel,
    editStatus,
    setEditStatus,
    editConfirmedDateTime,
    setEditConfirmedDateTime,
    editWarning,
    updateAppointmentMutation,
    sendMessageMutation,
    previewReprocessMutation,
    reprocessThreadMutation,
    reprocessPreview,
    reprocessResult,
    dismissReprocessPreview: () => setReprocessPreview(null),
    dismissReprocessResult: () => setReprocessResult(null),
    deleteAppointmentMutation,
  };
}
