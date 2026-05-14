/**
 * "Last action" section on the appointment detail panel.
 *
 * Renders the most recent entry from the appointment's conversation
 * log: typically the agent's narration of an action it just took
 * (e.g. "Done! I've emailed X asking for availability"), an
 * inbound email, or an admin / system note.
 *
 * Named "Last action" rather than "Last message" because for agent
 * entries the content is the assistant's reasoning + summary of
 * the action it performed via tool calls — not a literal message
 * sent. The underlying data field is still `lastMessagePreview`
 * (accurate at the conversation-log layer); the user-facing label
 * favours clarity over symmetry.
 *
 * Renders a role badge ("Agent" / "Admin" / "Inbound") plus the
 * full untruncated content. Empty when the appointment has no
 * conversation entries yet — a useful early-lifecycle signal.
 */

import type { AppointmentListItem } from '../../types';

interface LastActionSectionProps {
  preview: AppointmentListItem['lastMessagePreview'];
}

const ROLE_LABELS: Record<'agent' | 'admin' | 'inbound', { label: string; className: string }> = {
  agent: { label: 'Agent', className: 'bg-spill-blue-100 text-spill-blue-800' },
  admin: { label: 'Admin', className: 'bg-slate-200 text-slate-700' },
  inbound: { label: 'Inbound', className: 'bg-emerald-100 text-emerald-800' },
};

export default function LastActionSection({ preview }: LastActionSectionProps) {
  return (
    <section
      aria-label="Last action on this appointment"
      className="px-4 py-3 border-b border-slate-100"
    >
      <h3 className="text-xs font-semibold text-slate-500 uppercase tracking-wider mb-2">
        Last action
      </h3>

      {preview === null ? (
        <p className="text-sm text-slate-400 italic">No activity yet.</p>
      ) : (
        <>
          <span
            className={`inline-flex items-center px-1.5 py-0.5 rounded text-[10px] font-medium mb-1.5 ${
              ROLE_LABELS[preview.role].className
            }`}
          >
            {ROLE_LABELS[preview.role].label}
          </span>
          {/*
            `whitespace-pre-wrap` so paragraph breaks in agent /
            admin emails render as multi-line text rather than one
            wall of words. Constrained max-height + overflow-y-auto
            so a 50-line agent monologue doesn't dominate the panel
            — the operator can scroll within the section if they
            need the full text.
          */}
          <p className="text-sm text-slate-700 leading-snug whitespace-pre-wrap max-h-60 overflow-y-auto">
            {preview.snippet}
          </p>
        </>
      )}
    </section>
  );
}
