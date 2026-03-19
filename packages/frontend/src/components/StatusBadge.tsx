import { getStatusColor } from '../config/color-mappings';
import { STATUS_LABELS } from '../types';

interface StatusBadgeProps {
  status: string;
}

export default function StatusBadge({ status }: StatusBadgeProps) {
  return (
    <span className={`inline-flex items-center px-2 py-0.5 rounded-full text-xs font-medium ${getStatusColor(status)}`}>
      {STATUS_LABELS[status as keyof typeof STATUS_LABELS] || status}
    </span>
  );
}
