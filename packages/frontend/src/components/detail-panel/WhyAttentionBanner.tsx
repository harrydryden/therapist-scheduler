/**
 * "Why this needs attention" banner shown at the top of the
 * appointment detail panel for flagged appointments.
 *
 * Each reason renders as a row with a title, one-line detail, and a
 * concrete suggested next step. The component is purely presentational
 * — the reasons (and their priority ordering) are derived server-side
 * in `deriveAttentionReasons` so the dashboard table and the detail
 * panel agree on what's flagged and why.
 *
 * Renders nothing when `reasons` is empty — keeps healthy
 * appointments visually clean.
 */

import type { AttentionReason } from '../../types';

interface WhyAttentionBannerProps {
  reasons: AttentionReason[];
}

const KIND_STYLES: Record<AttentionReason['kind'], { dot: string; label: string }> = {
  closure_recommended: { dot: 'bg-red-500', label: 'text-red-700' },
  thread_divergence: { dot: 'bg-red-500', label: 'text-red-700' },
  tool_failure: { dot: 'bg-red-500', label: 'text-red-700' },
  stall: { dot: 'bg-amber-500', label: 'text-amber-800' },
  inactivity: { dot: 'bg-amber-500', label: 'text-amber-800' },
  human_control: { dot: 'bg-slate-500', label: 'text-slate-700' },
};

export default function WhyAttentionBanner({ reasons }: WhyAttentionBannerProps) {
  if (reasons.length === 0) return null;

  return (
    <div
      role="region"
      aria-label="Why this appointment needs attention"
      className="px-4 py-3 border-b border-red-100 bg-red-50/60"
    >
      <div className="flex items-center gap-2 mb-2">
        <span aria-hidden className="inline-block w-2 h-2 rounded-full bg-red-500" />
        <p className="text-sm font-semibold text-red-800">
          This appointment needs review
        </p>
      </div>

      <ul className="space-y-2.5">
        {reasons.map((reason) => {
          const style = KIND_STYLES[reason.kind];
          return (
            <li key={reason.kind} className="flex gap-2.5">
              <span
                aria-hidden
                className={`mt-1 inline-block w-1.5 h-1.5 rounded-full shrink-0 ${style.dot}`}
              />
              <div className="min-w-0 flex-1">
                <p className={`text-sm font-medium ${style.label}`}>{reason.title}</p>
                <p className="text-xs text-slate-700 mt-0.5">{reason.detail}</p>
                <p className="text-xs text-slate-500 mt-0.5">
                  <span className="text-slate-400">Suggested:</span> {reason.suggestion}
                </p>
              </div>
            </li>
          );
        })}
      </ul>
    </div>
  );
}
