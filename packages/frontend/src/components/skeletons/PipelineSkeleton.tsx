import SkeletonPulse from './SkeletonPulse';

/**
 * Skeleton loader for the AppointmentPipeline stats section.
 */
export default function PipelineSkeleton() {
  return (
    <div className="bg-white rounded-2xl shadow-sm border border-slate-100 p-6 mb-6">
      <div className="flex gap-4 justify-between mb-4">
        {Array.from({ length: 7 }).map((_, i) => (
          <div key={i} className="flex flex-col items-center gap-2">
            <SkeletonPulse className="h-8 w-8 rounded-full" />
            <SkeletonPulse className="h-3 w-16" />
            <SkeletonPulse className="h-5 w-8" />
          </div>
        ))}
      </div>
      <div className="flex gap-6 pt-4 border-t border-slate-100">
        <div className="flex-1 space-y-2">
          <SkeletonPulse className="h-4 w-28" />
          <div className="flex gap-2">
            <SkeletonPulse className="h-6 w-20 rounded-full" />
            <SkeletonPulse className="h-6 w-24 rounded-full" />
            <SkeletonPulse className="h-6 w-28 rounded-full" />
          </div>
        </div>
      </div>
    </div>
  );
}
