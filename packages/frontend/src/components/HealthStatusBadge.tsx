import type { HealthStatus } from '../types';
import { getHealthColor, HEALTH_LABELS, HEALTH_SHORT_LABELS } from '../config/color-mappings';

interface HealthStatusBadgeProps {
  status: HealthStatus;
  score?: number;
  showScore?: boolean;
  /** Visible text next to the dot, so status isn't conveyed by colour alone. */
  showLabel?: boolean;
  size?: 'sm' | 'md';
  pulse?: boolean;
}

/**
 * Health status indicator dot with optional score
 * - Green: Healthy conversation
 * - Yellow: Needs monitoring (approaching thresholds)
 * - Red: Needs attention (has issues)
 */
export default function HealthStatusBadge({
  status,
  score,
  showScore = false,
  showLabel = false,
  size = 'sm',
  pulse = true,
}: HealthStatusBadgeProps) {
  const sizeClasses = size === 'sm' ? 'w-2.5 h-2.5' : 'w-3.5 h-3.5';
  const colorClass = getHealthColor(status);

  // Pulse animation only for red status
  const pulseClass = pulse && status === 'red' ? 'animate-pulse' : '';

  const statusLabel = HEALTH_LABELS[status] ?? HEALTH_LABELS.green;
  const textColor = status === 'red' ? 'text-spill-red-600' : status === 'yellow' ? 'text-spill-yellow-600' : 'text-slate-500';

  return (
    <span
      className="inline-flex items-center gap-1.5"
      title={`Health: ${status}${score !== undefined ? ` (${score}%)` : ''}`}
      aria-label={`Health status: ${statusLabel}${score !== undefined ? `, score ${score}%` : ''}`}
    >
      <span className={`${sizeClasses} ${colorClass} ${pulseClass} rounded-full inline-block`} aria-hidden="true" />
      {showLabel && (
        <span className={`text-[11px] font-medium ${textColor}`} aria-hidden="true">
          {HEALTH_SHORT_LABELS[status] ?? HEALTH_SHORT_LABELS.green}
        </span>
      )}
      {showScore && score !== undefined && (
        <span className="text-xs text-slate-500" aria-hidden="true">{score}%</span>
      )}
    </span>
  );
}
