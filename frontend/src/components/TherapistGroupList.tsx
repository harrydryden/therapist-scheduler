import { memo } from 'react';
import type { AppointmentListItem, AppointmentFilters, PaginationInfo } from '../types';
import { getStatusColor, getStageLabel } from '../config/color-mappings';
import HealthStatusBadge from './HealthStatusBadge';

// Group appointments by therapist
interface TherapistGroup {
  therapistName: string;
  therapistEmail: string;
  therapistNotionId: string;
  appointments: AppointmentListItem[];
  pendingCount: number;
  negotiatingCount: number;
  confirmedCount: number;
  completedCount: number;
  healthRed: number;
  healthYellow: number;
}

interface TherapistGroupListProps {
  therapistGroups: TherapistGroup[];
  filters: AppointmentFilters;
  pagination: PaginationInfo | undefined;
  loadingList: boolean;
  selectedAppointment: string | null;
  expandedTherapists: Set<string>;
  onSelectAppointment: (id: string) => void;
  onToggleTherapist: (id: string) => void;
  onPageChange: (page: number) => void;
}

export type { TherapistGroup };

export default memo(function TherapistGroupList({
  therapistGroups,
  filters,
  pagination,
  loadingList,
  selectedAppointment,
  expandedTherapists,
  onSelectAppointment,
  onToggleTherapist,
  onPageChange,
}: TherapistGroupListProps) {
  return (
    <div className="bg-white rounded-2xl shadow-sm border border-slate-100 overflow-hidden">
      <div className="p-4 border-b border-slate-100">
        <h2 className="font-semibold text-slate-900">By Therapist</h2>
        <p className="text-sm text-slate-500">
          {therapistGroups.length} therapist{therapistGroups.length !== 1 ? 's' : ''}
          {therapistGroups.reduce((sum, g) => sum + g.pendingCount + g.negotiatingCount, 0) > 0 &&
            ` • ${therapistGroups.reduce((sum, g) => sum + g.pendingCount + g.negotiatingCount, 0)} active conversations`}
        </p>
      </div>

      {/* Pagination Controls */}
      {pagination && pagination.total > 0 && (
        <div className="p-3 border-b border-slate-100 flex items-center justify-between bg-slate-50">
          <span className="text-sm text-slate-600">
            {pagination.total <= (filters.limit ?? 20) ? (
              `Showing all ${pagination.total} appointment${pagination.total !== 1 ? 's' : ''}`
            ) : (
              `Showing ${(((filters.page ?? 1) - 1) * (filters.limit ?? 20)) + 1}-${Math.min((filters.page ?? 1) * (filters.limit ?? 20), pagination.total)} of ${pagination.total}`
            )}
          </span>
          {pagination.total > (filters.limit ?? 20) && (
            <div className="flex gap-2">
              <button
                onClick={() => onPageChange((filters.page ?? 1) - 1)}
                disabled={(filters.page ?? 1) <= 1}
                aria-label="Previous page"
                className="px-3 py-1 text-sm border border-slate-200 rounded hover:bg-slate-100 disabled:opacity-50 disabled:cursor-not-allowed"
              >
                &larr; Prev
              </button>
              <span className="px-3 py-1 text-sm text-slate-600">
                Page {filters.page ?? 1} of {Math.ceil(pagination.total / (filters.limit ?? 20))}
              </span>
              <button
                onClick={() => onPageChange((filters.page ?? 1) + 1)}
                disabled={(filters.page ?? 1) >= Math.ceil(pagination.total / (filters.limit ?? 20))}
                aria-label="Next page"
                className="px-3 py-1 text-sm border border-slate-200 rounded hover:bg-slate-100 disabled:opacity-50 disabled:cursor-not-allowed"
              >
                Next &rarr;
              </button>
            </div>
          )}
        </div>
      )}

      {loadingList ? (
        <div className="p-8 text-center">
          <div className="animate-spin rounded-full h-8 w-8 border-2 border-slate-200 border-t-spill-blue-800 mx-auto"></div>
          <p className="text-sm text-slate-500 mt-2">Loading...</p>
        </div>
      ) : (
        <div className="max-h-[600px] overflow-y-auto">
          {therapistGroups.length === 0 ? (
            <div className="p-8 text-center text-slate-500">No appointments found</div>
          ) : (
            therapistGroups.map((group) => {
              const isExpanded = expandedTherapists.has(group.therapistNotionId);
              const hasMultipleUsers = group.appointments.length > 1;

              return (
                <div key={group.therapistNotionId} className="border-b border-slate-100 last:border-b-0">
                  {/* Therapist Header */}
                  <button
                    onClick={() => onToggleTherapist(group.therapistNotionId)}
                    aria-expanded={expandedTherapists.has(group.therapistNotionId)}
                    aria-label={`${group.therapistName}: ${group.appointments.length} clients. ${expandedTherapists.has(group.therapistNotionId) ? 'Click to collapse' : 'Click to expand'}`}
                    className={`w-full p-4 text-left hover:bg-slate-50 transition-colors ${
                      group.healthRed > 0 ? 'bg-spill-red-100' : group.healthYellow > 0 ? 'bg-spill-yellow-50' : ''
                    }`}
                  >
                    <div className="flex justify-between items-start">
                      <div className="flex-1">
                        <div className="flex items-center gap-2">
                          <p className="font-semibold text-slate-900">{group.therapistName}</p>
                          {group.healthRed > 0 && (
                            <span className="px-2 py-0.5 text-xs font-medium rounded-full bg-spill-red-200 text-spill-red-600">
                              {group.healthRed} need attention
                            </span>
                          )}
                          {group.healthYellow > 0 && group.healthRed === 0 && (
                            <span className="px-2 py-0.5 text-xs font-medium rounded-full bg-spill-yellow-200 text-spill-yellow-600">
                              {group.healthYellow} monitoring
                            </span>
                          )}
                        </div>
                        <p className="text-sm text-slate-500 mt-0.5">
                          {group.appointments.length} client{group.appointments.length !== 1 ? 's' : ''}
                          {group.pendingCount > 0 && ` • ${group.pendingCount} pending`}
                          {group.negotiatingCount > 0 && ` • ${group.negotiatingCount} negotiating`}
                          {group.confirmedCount > 0 && ` • ${group.confirmedCount} confirmed`}
                          {group.completedCount > 0 && ` • ${group.completedCount} completed`}
                        </p>
                      </div>
                      <div className="flex items-center gap-2">
                        {hasMultipleUsers && (
                          <span className="px-2 py-1 text-xs font-medium rounded-full bg-purple-100 text-purple-800">
                            {group.appointments.length} users
                          </span>
                        )}
                        <svg
                          className={`w-5 h-5 text-slate-400 transition-transform ${isExpanded ? 'rotate-180' : ''}`}
                          fill="none"
                          stroke="currentColor"
                          viewBox="0 0 24 24"
                        >
                          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 9l-7 7-7-7" />
                        </svg>
                      </div>
                    </div>
                  </button>

                  {/* Expanded User List */}
                  {isExpanded && (
                    <div className="bg-slate-50 divide-y divide-slate-100">
                      {group.appointments.map((apt) => (
                        <div
                          key={apt.id}
                          role="button"
                          tabIndex={0}
                          onClick={() => onSelectAppointment(apt.id)}
                          onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); onSelectAppointment(apt.id); } }}
                          aria-label={`View appointment for ${apt.userName || apt.userEmail}`}
                          aria-pressed={selectedAppointment === apt.id}
                          className={`p-4 pl-8 cursor-pointer hover:bg-slate-100 transition-colors ${
                            selectedAppointment === apt.id ? 'bg-primary-50 border-l-4 border-l-spill-blue-800' : ''
                          }`}
                        >
                          <div className="flex justify-between items-start mb-1">
                            <div className="flex items-start gap-2">
                              {/* Health indicator */}
                              <div className="pt-1.5">
                                <HealthStatusBadge status={apt.healthStatus} size="sm" />
                              </div>
                              <div>
                                <p className="font-medium text-slate-900">
                                  {apt.userName || apt.userEmail}
                                </p>
                                <p className="text-xs text-slate-500">{apt.userEmail}</p>
                              </div>
                            </div>
                            <div className="flex flex-col gap-1 items-end">
                              {/* Progress indicator */}
                              {apt.status !== 'confirmed' && apt.status !== 'cancelled' && apt.checkpointProgress > 0 && (
                                <span className="px-2 py-0.5 text-xs font-medium rounded-full bg-spill-blue-100 text-spill-blue-800">
                                  {apt.checkpointProgress}%
                                </span>
                              )}
                              <span
                                className={`px-2 py-0.5 text-xs font-medium rounded-full ${getStatusColor(apt.status)}`}
                              >
                                {apt.status}
                              </span>
                              {apt.humanControlEnabled && (
                                <span className="px-2 py-0.5 text-xs font-medium rounded-full bg-orange-100 text-orange-800">
                                  Human
                                </span>
                              )}
                            </div>
                          </div>
                          {/* Stage label */}
                          {apt.checkpointStage && apt.status !== 'confirmed' && apt.status !== 'cancelled' && (
                            <p className="text-xs text-slate-600 mb-1 pl-4">
                              Stage: {getStageLabel(apt.checkpointStage)}
                            </p>
                          )}
                          {/* Alert badges */}
                          <div className="flex flex-wrap gap-1 mb-1 pl-4">
                            {apt.isStale && (
                              <span className="px-2 py-0.5 text-xs font-medium rounded-full bg-red-100 text-red-800">
                                Stale
                              </span>
                            )}
                            {apt.isStalled && (
                              <span className="px-2 py-0.5 text-xs font-medium rounded-full bg-orange-100 text-orange-800">
                                Stalled
                              </span>
                            )}
                            {apt.hasThreadDivergence && (
                              <span className="px-2 py-0.5 text-xs font-medium rounded-full bg-purple-100 text-purple-800">
                                Diverged
                              </span>
                            )}
                            {apt.hasToolFailure && (
                              <span className="px-2 py-0.5 text-xs font-medium rounded-full bg-red-100 text-red-800">
                                Tool Error
                              </span>
                            )}
                          </div>
                          <div className="flex gap-3 text-xs text-slate-500 pl-4">
                            <span>{apt.messageCount} msgs</span>
                            <span>{new Date(apt.updatedAt).toLocaleDateString()}</span>
                          </div>
                          {apt.status === 'confirmed' && apt.confirmedDateTime && (
                            <p className="text-xs text-green-600 mt-1 font-medium pl-4">
                              Booked: {apt.confirmedDateTime}
                            </p>
                          )}
                        </div>
                      ))}
                    </div>
                  )}
                </div>
              );
            })
          )}
        </div>
      )}
    </div>
  );
});
