import { memo, useMemo } from 'react';
import type { DashboardStats, AppointmentListItem, HealthStatus } from '../types';

interface AppointmentPipelineProps {
  stats: DashboardStats | undefined;
  appointments: AppointmentListItem[] | undefined;
}

export default memo(function AppointmentPipeline({ stats, appointments }: AppointmentPipelineProps) {
  const healthData = useMemo(() => {
    if (!appointments || appointments.length === 0) return null;
    const activeAppointments = appointments.filter(
      (apt) => !['confirmed', 'session_held', 'feedback_requested', 'completed', 'cancelled'].includes(apt.status)
    );
    const healthCounts = activeAppointments.reduce(
      (acc, apt) => {
        if (apt.healthStatus && ['green', 'yellow', 'red'].includes(apt.healthStatus)) {
          acc[apt.healthStatus as HealthStatus]++;
        }
        return acc;
      },
      { green: 0, yellow: 0, red: 0 } as Record<HealthStatus, number>
    );
    return { activeAppointments, healthCounts, total: activeAppointments.length || 1 };
  }, [appointments]);

  const controlData = useMemo(() => {
    if (!appointments || appointments.length === 0) return null;
    const humanControlCount = appointments.filter((apt) => apt.humanControlEnabled).length;
    const agentControlCount = appointments.length - humanControlCount;
    return { humanControlCount, agentControlCount, total: appointments.length || 1 };
  }, [appointments]);

  return (
    <>
      {/* Appointment Lifecycle Stats */}
      {stats && (
        <div className="bg-white rounded-2xl shadow-sm border border-slate-100 p-6 mb-6">
          <h2 className="font-semibold text-slate-900 mb-4">Appointment Pipeline</h2>

          {/* Pipeline Flow */}
          <div className="overflow-x-auto -mx-2 px-2">
          <div className="flex items-stretch gap-1 mb-6 min-w-[700px]">
            {/* Pre-booking stages */}
            <div className="flex-1 min-w-0">
              <div className="bg-amber-50 rounded-l-xl p-4 h-full border border-amber-200">
                <p className="text-xs font-medium text-amber-600 uppercase tracking-wide mb-1">Pending</p>
                <p className="text-3xl font-bold text-amber-700">{stats.byStatus.pending || 0}</p>
                <p className="text-xs text-amber-600 mt-1">Awaiting first contact</p>
              </div>
            </div>
            <div className="flex items-center text-slate-300">&rarr;</div>
            <div className="flex-1 min-w-0">
              <div className="bg-blue-50 p-4 h-full border-y border-blue-200">
                <p className="text-xs font-medium text-blue-600 uppercase tracking-wide mb-1">Contacted</p>
                <p className="text-3xl font-bold text-blue-700">{stats.byStatus.contacted || 0}</p>
                <p className="text-xs text-blue-600 mt-1">Initial outreach made</p>
              </div>
            </div>
            <div className="flex items-center text-slate-300">&rarr;</div>
            <div className="flex-1 min-w-0">
              <div className="bg-indigo-50 p-4 h-full border-y border-indigo-200">
                <p className="text-xs font-medium text-indigo-600 uppercase tracking-wide mb-1">Negotiating</p>
                <p className="text-3xl font-bold text-indigo-700">{stats.byStatus.negotiating || 0}</p>
                <p className="text-xs text-indigo-600 mt-1">Finding a time</p>
              </div>
            </div>
            <div className="flex items-center text-slate-300">&rarr;</div>
            {/* Post-booking stages */}
            <div className="flex-1 min-w-0">
              <div className="bg-green-50 p-4 h-full border-y border-green-200">
                <p className="text-xs font-medium text-green-600 uppercase tracking-wide mb-1">Confirmed</p>
                <p className="text-3xl font-bold text-green-700">{stats.byStatus.confirmed || 0}</p>
                <p className="text-xs text-green-600 mt-1">Session booked</p>
              </div>
            </div>
            <div className="flex items-center text-slate-300">&rarr;</div>
            <div className="flex-1 min-w-0">
              <div className="bg-teal-50 p-4 h-full border-y border-teal-200">
                <p className="text-xs font-medium text-teal-600 uppercase tracking-wide mb-1">Session Held</p>
                <p className="text-3xl font-bold text-teal-700">{stats.byStatus.session_held || 0}</p>
                <p className="text-xs text-teal-600 mt-1">Session complete</p>
              </div>
            </div>
            <div className="flex items-center text-slate-300">&rarr;</div>
            <div className="flex-1 min-w-0">
              <div className="bg-cyan-50 p-4 h-full border-y border-cyan-200">
                <p className="text-xs font-medium text-cyan-600 uppercase tracking-wide mb-1">Feedback Requested</p>
                <p className="text-3xl font-bold text-cyan-700">{stats.byStatus.feedback_requested || 0}</p>
                <p className="text-xs text-cyan-600 mt-1">Awaiting response</p>
              </div>
            </div>
            <div className="flex items-center text-slate-300">&rarr;</div>
            <div className="flex-1 min-w-0">
              <div className="bg-emerald-50 rounded-r-xl p-4 h-full border border-emerald-200">
                <p className="text-xs font-medium text-emerald-600 uppercase tracking-wide mb-1">Completed</p>
                <p className="text-3xl font-bold text-emerald-700">{stats.byStatus.completed || 0}</p>
                <p className="text-xs text-emerald-600 mt-1">Feedback received</p>
              </div>
            </div>
          </div>
          </div>

          {/* Summary row */}
          <div className="flex items-center justify-between pt-4 border-t border-slate-100">
            <div className="flex items-center gap-6">
              <div>
                <p className="text-sm text-slate-500">Active (pre-booking)</p>
                <p className="text-xl font-bold text-slate-800">
                  {(stats.byStatus.pending || 0) + (stats.byStatus.contacted || 0) + (stats.byStatus.negotiating || 0)}
                </p>
              </div>
              <div className="h-8 w-px bg-slate-200" />
              <div>
                <p className="text-sm text-slate-500">Confirmed (7d)</p>
                <p className="text-xl font-bold text-green-600">{stats.confirmedLast7Days}</p>
              </div>
              <div className="h-8 w-px bg-slate-200" />
              <div>
                <p className="text-sm text-slate-500">Cancelled</p>
                <p className="text-xl font-bold text-slate-400">{stats.byStatus.cancelled || 0}</p>
              </div>
            </div>
          </div>
        </div>
      )}

      {/* Health & Control Overview - Combined Card */}
      {healthData && controlData && (
        <div className="bg-white rounded-2xl shadow-sm border border-slate-100 p-6 mb-6">
          <div className="grid grid-cols-1 md:grid-cols-2 gap-8">
            {/* Health Status Section */}
            <div>
              <h3 className="font-semibold text-slate-700 mb-4 flex items-center gap-2">
                <span className="w-2 h-2 bg-slate-400 rounded-full"></span>
                Health Status
                <span className="text-xs font-normal text-slate-400">(active appointments only)</span>
              </h3>
              <div className="space-y-3">
                {/* Health bar visualization */}
                <div className="flex h-3 rounded-full overflow-hidden bg-slate-100">
                  {healthData.healthCounts.green > 0 && (
                    <div
                      className="bg-spill-teal-400 transition-all"
                      style={{ width: `${(healthData.healthCounts.green / healthData.total) * 100}%` }}
                    />
                  )}
                  {healthData.healthCounts.yellow > 0 && (
                    <div
                      className="bg-spill-yellow-400 transition-all"
                      style={{ width: `${(healthData.healthCounts.yellow / healthData.total) * 100}%` }}
                    />
                  )}
                  {healthData.healthCounts.red > 0 && (
                    <div
                      className="bg-spill-red-400 transition-all"
                      style={{ width: `${(healthData.healthCounts.red / healthData.total) * 100}%` }}
                    />
                  )}
                </div>
                {/* Legend */}
                <div className="flex items-center gap-6 text-sm">
                  <div className="flex items-center gap-2">
                    <span className="w-3 h-3 bg-spill-teal-400 rounded-full" />
                    <span className="text-slate-600">Healthy</span>
                    <span className="font-semibold text-spill-teal-600">{healthData.healthCounts.green}</span>
                  </div>
                  <div className="flex items-center gap-2">
                    <span className="w-3 h-3 bg-spill-yellow-400 rounded-full" />
                    <span className="text-slate-600">Monitoring</span>
                    <span className="font-semibold text-spill-yellow-600">{healthData.healthCounts.yellow}</span>
                  </div>
                  <div className="flex items-center gap-2">
                    <span className="w-3 h-3 bg-spill-red-400 rounded-full animate-pulse" />
                    <span className="text-slate-600">Needs Attention</span>
                    <span className="font-semibold text-spill-red-600">{healthData.healthCounts.red}</span>
                  </div>
                </div>
              </div>
            </div>

            {/* Control Status Section */}
            <div>
              <h3 className="font-semibold text-slate-700 mb-4 flex items-center gap-2">
                <span className="w-2 h-2 bg-slate-400 rounded-full"></span>
                Control Status
                <span className="text-xs font-normal text-slate-400">(all appointments)</span>
              </h3>
              <div className="space-y-3">
                {/* Control bar visualization */}
                <div className="flex h-3 rounded-full overflow-hidden bg-slate-100">
                  {controlData.agentControlCount > 0 && (
                    <div
                      className="bg-spill-blue-800 transition-all"
                      style={{ width: `${(controlData.agentControlCount / controlData.total) * 100}%` }}
                    />
                  )}
                  {controlData.humanControlCount > 0 && (
                    <div
                      className="bg-orange-400 transition-all"
                      style={{ width: `${(controlData.humanControlCount / controlData.total) * 100}%` }}
                    />
                  )}
                </div>
                {/* Legend */}
                <div className="flex items-center gap-6 text-sm">
                  <div className="flex items-center gap-2">
                    <span className="text-lg">🤖</span>
                    <span className="text-slate-600">Agent Control</span>
                    <span className="font-semibold text-spill-blue-800">{controlData.agentControlCount}</span>
                  </div>
                  <div className="flex items-center gap-2">
                    <span className="text-lg">👤</span>
                    <span className="text-slate-600">Human Control</span>
                    <span className="font-semibold text-orange-600">{controlData.humanControlCount}</span>
                  </div>
                </div>
              </div>
            </div>
          </div>
        </div>
      )}
    </>
  );
});
