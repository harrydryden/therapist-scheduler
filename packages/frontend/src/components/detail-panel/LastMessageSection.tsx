/**
 * "Last message" section on the appointment detail panel.
 *
 * Replaces the dashboard table's right-most column, which clipped
 * long agent / admin messages and bled into adjacent rows when the
 * content ran past the row height. The detail panel has room to
 * render the full untruncated message body, so the preview lives
 * here instead.
 *
 * Renders a role badge ("Agent" / "Admin" / "Inbound") plus the
 * full message snippet. Empty when the appointment has no messages
 * yet — useful early-lifecycle signal that the agent hasn't
 * started the thread.
 */

import type { AppointmentListItem } from '../../types';

interface LastMessageSectionProps {
  preview: AppointmentListItem['lastMessagePreview'];
}

const ROLE_LABELS: Record<'agent' | 'admin' | 'inbound', { label: string; className: string }> = {
  agent: { label: 'Agent', className: 'bg-spill-blue-100 text-spill-blue-800' },
  admin: { label: 'Admin', className: 'bg-slate-200 text-slate-700' },
  inbound: { label: 'Inbound', className: 'bg-emerald-100 text-emerald-800' },
};

export default function LastMessageSection({ preview }: LastMessageSectionProps) {
  return (
    <section
      aria-label="Last message in thread"
      className="px-4 py-3 border-b border-slate-100"
    >
      <h3 className="text-xs font-semibold text-slate-500 uppercase tracking-wider mb-2">
        Last message
      </h3>

      {preview === null ? (
        <p className="text-sm text-slate-400 italic">No messages yet.</p>
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
