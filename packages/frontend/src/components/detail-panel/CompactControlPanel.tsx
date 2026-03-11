import { useState } from 'react';
import type { AppointmentDetail } from '../../types';
import type { AppointmentControls } from '../../hooks/useAppointmentControls';
import HumanControlSection from './HumanControlSection';
import ScanResultsPanel from './ScanResultsPanel';
import DeleteSection from './DeleteSection';

type ControlView = null | 'control' | 'scan' | 'delete';

interface CompactControlPanelProps {
  appointment: AppointmentDetail;
  controls: AppointmentControls;
}

export default function CompactControlPanel({
  appointment,
  controls,
}: CompactControlPanelProps) {
  const [expandedView, setExpandedView] = useState<ControlView>(null);

  const hasThreads = appointment.gmailThreadId || appointment.therapistGmailThreadId;
  const isControlActive = appointment.humanControlEnabled;

  // Auto-expand human control section if control is active
  const effectiveExpanded = isControlActive && expandedView === null ? 'control' : expandedView;

  return (
    <div className="border-b border-slate-100">
      {/* Compact button row */}
      <div className="px-4 py-2 flex gap-2">
        <button
          onClick={() => setExpandedView(effectiveExpanded === 'control' ? null : 'control')}
          className={`flex-1 px-3 py-1.5 text-xs font-medium rounded-lg border transition-colors ${
            isControlActive
              ? 'bg-orange-50 border-orange-300 text-orange-700 hover:bg-orange-100'
              : effectiveExpanded === 'control'
                ? 'bg-slate-100 border-slate-300 text-slate-700'
                : 'border-slate-200 text-slate-600 hover:bg-slate-50'
          }`}
        >
          {isControlActive ? 'Human Control' : 'Take Control'}
        </button>

        {hasThreads && (
          <button
            onClick={() => {
              if (effectiveExpanded !== 'scan') {
                setExpandedView('scan');
                // Auto-trigger scan
                if (!controls.reprocessPreview && !controls.previewReprocessMutation.isPending) {
                  controls.previewReprocessMutation.mutate(appointment.id);
                }
              } else {
                setExpandedView(null);
              }
            }}
            disabled={controls.previewReprocessMutation.isPending}
            className={`flex-1 px-3 py-1.5 text-xs font-medium rounded-lg border transition-colors ${
              effectiveExpanded === 'scan'
                ? 'bg-slate-100 border-slate-300 text-slate-700'
                : 'border-slate-200 text-slate-600 hover:bg-slate-50'
            } disabled:opacity-50`}
          >
            {controls.previewReprocessMutation.isPending ? 'Scanning...' : 'Scan Messages'}
          </button>
        )}

        <button
          onClick={() => setExpandedView(effectiveExpanded === 'delete' ? null : 'delete')}
          className={`px-3 py-1.5 text-xs font-medium rounded-lg border transition-colors ${
            effectiveExpanded === 'delete'
              ? 'bg-red-50 border-red-300 text-red-600'
              : 'border-red-200 text-red-500 hover:bg-red-50'
          }`}
        >
          Delete
        </button>
      </div>

      {/* Expanded panels */}
      {effectiveExpanded === 'control' && (
        <HumanControlSection
          appointment={appointment}
          controls={controls}
        />
      )}

      {effectiveExpanded === 'scan' && !isControlActive && (
        <div className="px-4 pb-3">
          <ScanResultsPanel
            appointmentId={appointment.id}
            previewReprocessMutation={controls.previewReprocessMutation}
            reprocessThreadMutation={controls.reprocessThreadMutation}
            reprocessPreview={controls.reprocessPreview}
            reprocessResult={controls.reprocessResult}
            onDismissPreview={controls.dismissReprocessPreview}
            onDismissResult={controls.dismissReprocessResult}
          />
        </div>
      )}

      {effectiveExpanded === 'delete' && (
        <div className="px-4 pb-3">
          <DeleteSection
            appointment={appointment}
            deleteMutation={controls.deleteAppointmentMutation}
          />
        </div>
      )}
    </div>
  );
}
