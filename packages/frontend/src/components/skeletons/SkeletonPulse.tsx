/**
 * Reusable skeleton pulse element for loading states.
 * Uses CSS animation for the shimmer effect.
 */
interface SkeletonPulseProps {
  className?: string;
}

export default function SkeletonPulse({ className = '' }: SkeletonPulseProps) {
  return (
    <div className={`animate-pulse bg-slate-200 rounded ${className}`} />
  );
}
