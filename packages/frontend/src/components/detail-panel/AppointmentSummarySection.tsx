import { useState, useEffect } from 'react';
import type { AppointmentSummary } from '../../types';
import { formatTimeAgo } from '../../utils/date-format';

interface AppointmentSummarySectionProps {
  summary: AppointmentSummary | null;
}

const flagLabels: Record<string, { label: string; color: string }> = {
  stale: { label: 'Stale', color: 'bg-amber-100 text-amber-700' },
  human_control: { label: 'Human Control', color: 'bg-orange-100 text-orange-700' },
  chased: { label: 'Chased', color: 'bg-yellow-100 text-yellow-800' },
  closure_recommended: { label: 'Close', color: 'bg-red-100 text-red-700' },
};


export default function AppointmentSummarySection({ summary }: AppointmentSummarySectionProps) {
  // Re-render every 60s to keep relative timestamps fresh
  const [, setTick] = useState(0);
  useEffect(() => {
    if (!summary?.lastActivityAt) return;
    const interval = setInterval(() => setTick(t => t + 1), 60_000);
    return () => clearInterval(interval);
  }, [summary?.lastActivityAt]);

  if (!summary) {
    return (
      <div className="px-4 py-3 border-b border-slate-100">
        <p className="text-sm text-slate-400 italic">No summary available yet.</p>
      </div>
    );
  }

  return (
    <div className="px-4 py-3 border-b border-slate-100">
      {/* Stage + flags row */}
      <div className="flex items-center gap-2 mb-1.5">
        <p className="text-sm font-semibold text-slate-800">{summary.stage}</p>
        {summary.flags.map((flag) => {
          const style = flagLabels[flag] || { label: flag, color: 'bg-slate-100 text-slate-600' };
          return (
            <span
              key={flag}
              className={`px-1.5 py-0.5 text-[10px] font-medium rounded ${style.color}`}
            >
              {style.label}
            </span>
          );
        })}
      </div>

      {/* Next action */}
      <p className="text-sm text-slate-600 mb-2">{summary.nextAction}</p>

      {/* Key facts */}
      {summary.keyFacts.length > 0 && (
        <div className="space-y-0.5 mb-2">
          {summary.keyFacts.map((fact, i) => (
            <p key={i} className="text-xs text-slate-500">
              {fact}
            </p>
          ))}
        </div>
      )}

      {/* Meta line */}
      <p className="text-xs text-slate-400">
        {summary.messageCount} messages
        {summary.lastActivityAt && <> &middot; last activity {formatTimeAgo(summary.lastActivityAt)}</>}
      </p>
    </div>
  );
}
