import SkeletonPulse from './SkeletonPulse';

/**
 * Skeleton loader that matches the TherapistGroupList layout.
 * Shows 4 fake therapist group headers while loading.
 */
export default function TherapistGroupSkeleton() {
  return (
    <div className="bg-white rounded-2xl shadow-sm border border-slate-100 overflow-hidden">
      <div className="p-4 border-b border-slate-100">
        <SkeletonPulse className="h-5 w-28 mb-1" />
        <SkeletonPulse className="h-4 w-48" />
      </div>
      <div>
        {Array.from({ length: 4 }).map((_, i) => (
          <div key={i} className="p-4 border-b border-slate-100">
            <div className="flex justify-between items-start">
              <div className="flex-1 space-y-2">
                <SkeletonPulse className="h-5 w-36" />
                <SkeletonPulse className="h-4 w-52" />
              </div>
              <SkeletonPulse className="h-5 w-5 rounded" />
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}
