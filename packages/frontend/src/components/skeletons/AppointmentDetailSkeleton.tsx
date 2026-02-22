import SkeletonPulse from './SkeletonPulse';

/**
 * Skeleton loader that matches the AppointmentDetailPanel layout.
 * Shown while appointment detail is loading.
 */
export default function AppointmentDetailSkeleton() {
  return (
    <div className="bg-white rounded-2xl shadow-sm border border-slate-100 overflow-hidden">
      <div className="h-full flex flex-col">
        {/* Header skeleton */}
        <div className="p-4 border-b border-slate-100">
          <div className="flex justify-between items-start">
            <div className="space-y-2">
              <SkeletonPulse className="h-5 w-40" />
              <SkeletonPulse className="h-4 w-56" />
            </div>
            <SkeletonPulse className="h-6 w-20 rounded-full" />
          </div>
          <div className="mt-3 space-y-2">
            <SkeletonPulse className="h-4 w-48" />
            <SkeletonPulse className="h-4 w-52" />
          </div>
        </div>

        {/* Control panel skeleton */}
        <div className="p-4 border-b border-slate-100 bg-slate-50">
          <SkeletonPulse className="h-10 w-full rounded-lg mb-2" />
          <SkeletonPulse className="h-10 w-full rounded-lg" />
        </div>

        {/* Conversation skeleton */}
        <div className="p-4 space-y-3">
          <SkeletonPulse className="h-4 w-32" />
          <div className="space-y-3">
            <div className="p-3 rounded-lg border border-slate-100">
              <SkeletonPulse className="h-3 w-16 mb-2" />
              <SkeletonPulse className="h-4 w-full mb-1" />
              <SkeletonPulse className="h-4 w-3/4" />
            </div>
            <div className="p-3 rounded-lg border border-slate-100">
              <SkeletonPulse className="h-3 w-20 mb-2" />
              <SkeletonPulse className="h-4 w-full mb-1" />
              <SkeletonPulse className="h-4 w-2/3" />
            </div>
            <div className="p-3 rounded-lg border border-slate-100">
              <SkeletonPulse className="h-3 w-14 mb-2" />
              <SkeletonPulse className="h-4 w-full mb-1" />
              <SkeletonPulse className="h-4 w-5/6" />
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
