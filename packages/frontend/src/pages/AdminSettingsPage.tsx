import { useState, useMemo, useCallback } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { getSettings, updateSetting, resetSetting, getSlackStatus, sendSlackTest, resetSlackCircuit } from '../api/client';
import type { SlackStatus } from '../api/client';
import type { SystemSetting, SettingCategory } from '../types';
import { getAdminId } from '../utils/admin-id';

// Category display info
const categoryInfo: Record<SettingCategory, { label: string; description: string; icon: string }> = {
  frontend: {
    label: 'Frontend Content',
    description: 'Customize content displayed on the public booking pages',
    icon: 'M4 5a1 1 0 011-1h14a1 1 0 011 1v2a1 1 0 01-1 1H5a1 1 0 01-1-1V5zM4 13a1 1 0 011-1h6a1 1 0 011 1v6a1 1 0 01-1 1H5a1 1 0 01-1-1v-6zM16 13a1 1 0 011-1h2a1 1 0 011 1v6a1 1 0 01-1 1h-2a1 1 0 01-1-1v-6z',
  },
  general: {
    label: 'General',
    description: 'General application settings including timezone configuration',
    icon: 'M10.325 4.317c.426-1.756 2.924-1.756 3.35 0a1.724 1.724 0 002.573 1.066c1.543-.94 3.31.826 2.37 2.37a1.724 1.724 0 001.065 2.572c1.756.426 1.756 2.924 0 3.35a1.724 1.724 0 00-1.066 2.573c.94 1.543-.826 3.31-2.37 2.37a1.724 1.724 0 00-2.572 1.065c-.426 1.756-2.924 1.756-3.35 0a1.724 1.724 0 00-2.573-1.066c-1.543.94-3.31-.826-2.37-2.37a1.724 1.724 0 00-1.065-2.572c-1.756-.426-1.756-2.924 0-3.35a1.724 1.724 0 001.066-2.573c-.94-1.543.826-3.31 2.37-2.37.996.608 2.296.07 2.572-1.065z',
  },
  postBooking: {
    label: 'Post-Booking Follow-up',
    description: 'Configure automated follow-up emails after appointments are confirmed',
    icon: 'M3 8l7.89 5.26a2 2 0 002.22 0L21 8M5 19h14a2 2 0 002-2V7a2 2 0 00-2-2H5a2 2 0 00-2 2v10a2 2 0 002 2z',
  },
  agent: {
    label: 'AI Agent',
    description: 'Configure the scheduling agent behavior',
    icon: 'M9.75 17L9 20l-1 1h8l-1-1-.75-3M3 13h18M5 17h14a2 2 0 002-2V5a2 2 0 00-2-2H5a2 2 0 00-2 2v10a2 2 0 002 2z',
  },
  retention: {
    label: 'Data Retention',
    description: 'Configure how long to keep appointment data before archiving',
    icon: 'M5 8h14M5 8a2 2 0 110-4h14a2 2 0 110 4M5 8v10a2 2 0 002 2h10a2 2 0 002-2V8m-9 4h4',
  },
  emailTemplates: {
    label: 'Email Templates',
    description: 'Customize appointment confirmation and follow-up email content',
    icon: 'M3 8l7.89 5.26a2 2 0 002.22 0L21 8M5 19h14a2 2 0 002-2V7a2 2 0 00-2-2H5a2 2 0 00-2 2v10a2 2 0 002 2z',
  },
  weeklyMailing: {
    label: 'Weekly Mailing',
    description: 'Configure automated weekly promotional emails to subscribed users',
    icon: 'M8 7V3m8 4V3m-9 8h10M5 21h14a2 2 0 002-2V7a2 2 0 00-2-2H5a2 2 0 00-2 2v12a2 2 0 002 2z',
  },
  notifications: {
    label: 'Notifications',
    description: 'Control Slack and email notifications sent during appointment lifecycle',
    icon: 'M15 17h5l-1.405-1.405A2.032 2.032 0 0118 14.158V11a6.002 6.002 0 00-4-5.659V5a2 2 0 10-4 0v.341C7.67 6.165 6 8.388 6 11v3.159c0 .538-.214 1.055-.595 1.436L4 17h5m6 0v1a3 3 0 11-6 0v-1m6 0H9',
  },
};

// ─── Number Stepper Component ────────────────────────────────────────────────

function NumberStepper({
  value,
  onChange,
  min,
  max,
  label,
}: {
  value: number;
  onChange: (val: number) => void;
  min?: number | null;
  max?: number | null;
  label?: string;
}) {
  const numVal = Number(value) || 0;
  const canDecrement = min == null || numVal > min;
  const canIncrement = max == null || numVal < max;

  return (
    <div>
      {label && <p className="text-xs text-slate-500 mb-1.5">{label}</p>}
      <div className="inline-flex items-center border border-slate-200 rounded-lg overflow-hidden">
        <button
          type="button"
          onClick={() => canDecrement && onChange(numVal - 1)}
          disabled={!canDecrement}
          className="w-10 h-10 flex items-center justify-center text-slate-600 hover:bg-slate-50 disabled:text-slate-300 disabled:cursor-not-allowed transition-colors border-r border-slate-200"
          aria-label="Decrease value"
        >
          <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M20 12H4" />
          </svg>
        </button>
        <input
          type="number"
          value={numVal}
          onChange={(e) => onChange(Number(e.target.value))}
          min={min ?? undefined}
          max={max ?? undefined}
          className="w-16 h-10 text-center text-sm font-medium text-slate-900 border-0 outline-none focus:ring-0 [appearance:textfield] [&::-webkit-outer-spin-button]:appearance-none [&::-webkit-inner-spin-button]:appearance-none"
        />
        <button
          type="button"
          onClick={() => canIncrement && onChange(numVal + 1)}
          disabled={!canIncrement}
          className="w-10 h-10 flex items-center justify-center text-slate-600 hover:bg-slate-50 disabled:text-slate-300 disabled:cursor-not-allowed transition-colors border-l border-slate-200"
          aria-label="Increase value"
        >
          <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 4v16m8-8H4" />
          </svg>
        </button>
      </div>
      {(min != null || max != null) && (
        <p className="text-xs text-slate-400 mt-1">
          {min != null && `Min: ${min}`}
          {min != null && max != null && ' · '}
          {max != null && `Max: ${max}`}
        </p>
      )}
    </div>
  );
}

// ─── Toggle Switch Component ─────────────────────────────────────────────────

function ToggleSwitch({
  checked,
  onChange,
  label,
}: {
  checked: boolean;
  onChange: (val: boolean) => void;
  label?: string;
}) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      aria-label={label}
      onClick={() => onChange(!checked)}
      className={`
        relative inline-flex h-6 w-11 items-center rounded-full transition-colors duration-200
        ${checked ? 'bg-spill-blue-800' : 'bg-slate-200'}
      `}
    >
      <span
        className={`
          inline-block h-4 w-4 rounded-full bg-white transition-transform duration-200 shadow-sm
          ${checked ? 'translate-x-6' : 'translate-x-1'}
        `}
      />
    </button>
  );
}

// ─── Slack Diagnostics Panel ────────────────────────────────────────────────

function SlackDiagnosticsPanel({
  status,
  isLoading,
  onRefresh,
  onTest,
  onResetCircuit,
  testPending,
  testResult,
  testError,
  resetPending,
}: {
  status: SlackStatus | undefined;
  isLoading: boolean;
  onRefresh: () => void;
  onTest: () => void;
  onResetCircuit: () => void;
  testPending: boolean;
  testResult?: 'success' | 'error';
  testError?: string;
  resetPending: boolean;
}) {
  const circuitState = status?.circuitBreaker.state;
  const isHealthy = circuitState === 'CLOSED';
  const isOpen = circuitState === 'OPEN';

  const taskStats = status?.backgroundTasks
    ? Object.values(status.backgroundTasks).reduce(
        (acc, t) => ({
          total: acc.total + t.total,
          success: acc.success + t.success,
          failed: acc.failed + t.failed,
          timedOut: acc.timedOut + t.timedOut,
        }),
        { total: 0, success: 0, failed: 0, timedOut: 0 }
      )
    : null;

  const recentErrors = status?.backgroundTasks
    ? Object.entries(status.backgroundTasks)
        .flatMap(([name, t]) => t.recentErrors.map(e => ({ ...e, taskName: name })))
        .sort((a, b) => new Date(b.timestamp).getTime() - new Date(a.timestamp).getTime())
        .slice(0, 5)
    : [];

  return (
    <div className="bg-white rounded-xl border border-slate-200 overflow-hidden">
      <div className="px-6 py-4 border-b border-slate-100 flex items-center justify-between">
        <div>
          <h2 className="text-base font-semibold text-slate-900">Slack Integration</h2>
          <p className="text-sm text-slate-500">Circuit breaker, queue, and delivery health</p>
        </div>
        <button
          type="button"
          onClick={onRefresh}
          aria-label="Refresh Slack status"
          className="p-2 text-slate-400 hover:text-slate-600 hover:bg-slate-50 rounded-lg transition-colors"
        >
          <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 4v5h.582m15.356 2A8.001 8.001 0 004.582 9m0 0H9m11 11v-5h-.581m0 0a8.003 8.003 0 01-15.357-2m15.357 2H15" />
          </svg>
        </button>
      </div>

      <div className="px-6 py-4">
        {isLoading ? (
          <div className="text-center py-4">
            <div className="animate-spin rounded-full h-6 w-6 border-2 border-slate-200 border-t-spill-blue-800 mx-auto"></div>
            <p className="text-sm text-slate-500 mt-2">Loading...</p>
          </div>
        ) : status ? (
          <div className="space-y-4">
            {/* Status grid */}
            <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
              <StatusCard
                label="Circuit Breaker"
                value={circuitState || 'Unknown'}
                variant={isHealthy ? 'success' : isOpen ? 'error' : 'warning'}
              />
              <StatusCard
                label="Webhook"
                value={status.webhookConfigured ? 'Configured' : 'Not Set'}
                variant={status.webhookConfigured ? 'success' : 'error'}
              />
              <StatusCard
                label="Queued"
                value={`${status.queue.inMemory} pending`}
                variant={status.queue.inMemory === 0 ? 'neutral' : 'warning'}
              />
              <StatusCard
                label="Delivery"
                value={taskStats && taskStats.total > 0 ? `${Math.round((taskStats.success / taskStats.total) * 100)}%` : 'No data'}
                variant="neutral"
              />
            </div>

            {!isHealthy && (
              <div className={`rounded-lg p-3 text-sm ${isOpen ? 'bg-red-50 text-red-800 border border-red-100' : 'bg-amber-50 text-amber-800 border border-amber-100'}`}>
                <p className="font-medium">
                  {isOpen ? 'Circuit breaker is OPEN — notifications are being rejected' : 'Circuit breaker is testing recovery'}
                </p>
                <p className="text-xs mt-1 opacity-80">
                  Failures: {status.circuitBreaker.failures} | Rejected: {status.circuitBreaker.rejectedRequests}
                </p>
              </div>
            )}

            {recentErrors.length > 0 && (
              <div>
                <p className="text-xs font-medium text-slate-500 mb-2">Recent Errors</p>
                <div className="space-y-1">
                  {recentErrors.map((err, i) => (
                    <div key={i} className="text-xs bg-red-50 border border-red-100 rounded-lg px-3 py-1.5 font-mono text-red-700 truncate">
                      <span className="text-red-400">{new Date(err.timestamp).toLocaleTimeString()}</span>{' '}
                      [{err.taskName}] {err.error}
                    </div>
                  ))}
                </div>
              </div>
            )}

            <div className="flex flex-wrap gap-2 pt-3 border-t border-slate-100">
              <button
                type="button"
                onClick={onTest}
                disabled={testPending}
                className="px-4 py-2 text-sm font-medium bg-slate-900 text-white rounded-lg hover:bg-slate-800 transition-colors disabled:opacity-50"
              >
                {testPending ? 'Sending...' : 'Send Test'}
              </button>
              {!isHealthy && (
                <button
                  type="button"
                  onClick={onResetCircuit}
                  disabled={resetPending}
                  className="px-4 py-2 text-sm font-medium border border-slate-200 text-slate-700 rounded-lg hover:bg-slate-50 transition-colors disabled:opacity-50"
                >
                  {resetPending ? 'Resetting...' : 'Reset Circuit'}
                </button>
              )}
            </div>

            {testResult === 'success' && (
              <div className="text-sm text-emerald-700 bg-emerald-50 border border-emerald-100 rounded-lg px-4 py-2.5">
                Test notification sent — check your Slack channel.
              </div>
            )}
            {testResult === 'error' && (
              <div className="text-sm text-red-700 bg-red-50 border border-red-100 rounded-lg px-4 py-2.5">
                Failed to send test.{testError ? ` ${testError}` : ''}
              </div>
            )}
          </div>
        ) : (
          <p className="text-sm text-slate-500 text-center py-4">Unable to load Slack status.</p>
        )}
      </div>
    </div>
  );
}

function StatusCard({ label, value, variant }: { label: string; value: string; variant: 'success' | 'error' | 'warning' | 'neutral' }) {
  const styles = {
    success: 'bg-emerald-50 border-emerald-100 text-emerald-700',
    error: 'bg-red-50 border-red-100 text-red-700',
    warning: 'bg-amber-50 border-amber-100 text-amber-700',
    neutral: 'bg-slate-50 border-slate-100 text-slate-700',
  };

  return (
    <div className={`rounded-lg p-3 border ${styles[variant]}`}>
      <p className="text-xs font-medium text-slate-500 mb-0.5">{label}</p>
      <p className="text-sm font-semibold">{value}</p>
    </div>
  );
}

// ─── Main Settings Page ──────────────────────────────────────────────────────

export default function AdminSettingsPage() {
  const queryClient = useQueryClient();
  const [editingKey, setEditingKey] = useState<string | null>(null);
  const [editValue, setEditValue] = useState<string>('');
  const [activeCategory, setActiveCategory] = useState<SettingCategory | 'all'>('all');
  const adminId = useMemo(() => getAdminId(), []);

  const {
    data: settingsData,
    isLoading,
    error,
  } = useQuery({
    queryKey: ['settings'],
    queryFn: getSettings,
  });

  const updateMutation = useMutation({
    mutationFn: ({ key, value }: { key: string; value: string | number | boolean }) =>
      updateSetting(key, { value, adminId }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['settings'] });
      setEditingKey(null);
      setEditValue('');
    },
  });

  const resetMutation = useMutation({
    mutationFn: resetSetting,
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['settings'] });
    },
  });

  const handleEdit = (setting: SystemSetting) => {
    setEditingKey(setting.key);
    setEditValue(String(setting.value));
  };

  const handleSave = (setting: SystemSetting) => {
    let value: string | number | boolean = editValue;
    if (setting.valueType === 'number') {
      value = Number(editValue);
      if (isNaN(value)) return;
    } else if (setting.valueType === 'boolean') {
      value = editValue === 'true';
    }
    updateMutation.mutate({ key: setting.key, value });
  };

  const [resetConfirmSetting, setResetConfirmSetting] = useState<SystemSetting | null>(null);

  const handleReset = useCallback((setting: SystemSetting) => {
    setResetConfirmSetting(setting);
  }, []);

  const confirmReset = useCallback(() => {
    if (resetConfirmSetting) {
      resetMutation.mutate(resetConfirmSetting.key);
      setResetConfirmSetting(null);
    }
  }, [resetConfirmSetting, resetMutation]);

  const handleCancel = () => {
    setEditingKey(null);
    setEditValue('');
  };

  const filteredSettings = settingsData?.settings.filter(
    s => activeCategory === 'all' || s.category === activeCategory
  ) || [];

  const groupedSettings = filteredSettings.reduce((acc, setting) => {
    if (!acc[setting.category]) {
      acc[setting.category] = [];
    }
    acc[setting.category].push(setting);
    return acc;
  }, {} as Record<SettingCategory, SystemSetting[]>);

  const isPending = updateMutation.isPending || resetMutation.isPending;

  const showSlackDiagnostics = activeCategory === 'all' || activeCategory === 'notifications';

  const {
    data: slackStatus,
    isLoading: slackLoading,
    refetch: refetchSlack,
  } = useQuery({
    queryKey: ['slack-status'],
    queryFn: getSlackStatus,
    enabled: showSlackDiagnostics,
    refetchInterval: 30000,
    refetchOnWindowFocus: false,
  });

  const testSlackMutation = useMutation({
    mutationFn: sendSlackTest,
    onSuccess: () => refetchSlack(),
  });

  const resetCircuitMutation = useMutation({
    mutationFn: resetSlackCircuit,
    onSuccess: () => refetchSlack(),
  });

  return (
    <div className="py-8 px-6">
      <div className="max-w-4xl mx-auto">
        {/* Header */}
        <div className="mb-8">
          <h1 className="text-2xl font-bold text-slate-900">Settings</h1>
          <p className="text-slate-500 mt-1">Configure system settings for the scheduling agent and automation</p>
        </div>

        {error && (
          <div className="bg-red-50 border border-red-100 rounded-lg p-4 mb-6">
            <p className="text-red-600 text-sm">{error instanceof Error ? error.message : 'Failed to load settings'}</p>
          </div>
        )}

        {/* Category Filter */}
        <div className="mb-6 flex flex-wrap gap-2">
          <CategoryPill
            active={activeCategory === 'all'}
            onClick={() => setActiveCategory('all')}
            label="All Settings"
          />
          {(Array.isArray(settingsData?.categories) ? settingsData.categories : []).map((cat) => (
            <CategoryPill
              key={cat}
              active={activeCategory === cat}
              onClick={() => setActiveCategory(cat)}
              label={categoryInfo[cat]?.label || cat}
            />
          ))}
        </div>

        {/* Loading */}
        {isLoading ? (
          <div className="bg-white rounded-xl border border-slate-200 p-12 text-center">
            <div className="animate-spin rounded-full h-8 w-8 border-2 border-slate-200 border-t-spill-blue-800 mx-auto"></div>
            <p className="text-sm text-slate-500 mt-3">Loading settings...</p>
          </div>
        ) : (
          <div className="space-y-6">
            {showSlackDiagnostics && (
              <SlackDiagnosticsPanel
                status={slackStatus}
                isLoading={slackLoading}
                onRefresh={() => refetchSlack()}
                onTest={() => testSlackMutation.mutate()}
                onResetCircuit={() => resetCircuitMutation.mutate()}
                testPending={testSlackMutation.isPending}
                testResult={testSlackMutation.isSuccess ? 'success' : testSlackMutation.isError ? 'error' : undefined}
                testError={testSlackMutation.error instanceof Error ? testSlackMutation.error.message : undefined}
                resetPending={resetCircuitMutation.isPending}
              />
            )}

            {Object.entries(groupedSettings).map(([category, settings]) => (
              <div key={category} className="bg-white rounded-xl border border-slate-200 overflow-hidden">
                {/* Category Header */}
                <div className="px-6 py-4 border-b border-slate-100">
                  <div className="flex items-center gap-3">
                    <div className="w-8 h-8 bg-spill-blue-100 rounded-lg flex items-center justify-center">
                      <svg className="w-4 h-4 text-spill-blue-800" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d={categoryInfo[category as SettingCategory]?.icon || 'M12 6v6m0 0v6m0-6h6m-6 0H6'} />
                      </svg>
                    </div>
                    <div>
                      <h2 className="text-base font-semibold text-slate-900">{categoryInfo[category as SettingCategory]?.label || category}</h2>
                      <p className="text-sm text-slate-500">{categoryInfo[category as SettingCategory]?.description}</p>
                    </div>
                  </div>
                </div>

                {/* Settings List */}
                <div className="divide-y divide-slate-100">
                  {settings.map((setting) => (
                    <div key={setting.key} className="px-6 py-5">
                      <div className="flex items-start justify-between gap-6">
                        <div className="flex-1 min-w-0">
                          {/* Label + badges */}
                          <div className="flex items-center gap-2 mb-1">
                            <h3 className="text-sm font-semibold text-slate-900">{setting.label}</h3>
                            {setting.isDefault ? (
                              <span className="px-2 py-0.5 text-[11px] font-medium rounded-full bg-slate-100 text-slate-500">Default</span>
                            ) : (
                              <span className="px-2 py-0.5 text-[11px] font-medium rounded-full bg-spill-blue-100 text-spill-blue-800">Custom</span>
                            )}
                          </div>
                          {setting.description && (
                            <p className="text-sm text-slate-500 mb-3">{setting.description}</p>
                          )}

                          {/* Edit mode */}
                          {editingKey === setting.key ? (
                            <div className="mt-3">
                              {setting.valueType === 'boolean' ? (
                                <div className="flex items-center gap-3">
                                  <ToggleSwitch
                                    checked={editValue === 'true'}
                                    onChange={(val) => setEditValue(String(val))}
                                    label={setting.label}
                                  />
                                  <span className="text-sm text-slate-600">{editValue === 'true' ? 'Enabled' : 'Disabled'}</span>
                                </div>
                              ) : setting.valueType === 'number' ? (
                                <NumberStepper
                                  value={Number(editValue)}
                                  onChange={(val) => setEditValue(String(val))}
                                  min={setting.minValue}
                                  max={setting.maxValue}
                                />
                              ) : setting.key.endsWith('Body') || setting.category === 'frontend' ? (
                                <div>
                                  <textarea
                                    value={editValue}
                                    onChange={(e) => setEditValue(e.target.value)}
                                    rows={setting.category === 'frontend' ? 16 : 12}
                                    className="w-full px-4 py-3 border border-slate-200 rounded-lg text-sm font-mono focus:ring-2 focus:ring-spill-blue-400 focus:border-transparent outline-none resize-y bg-white"
                                    placeholder={setting.category === 'frontend' ? 'Markdown content...' : 'Email template body...'}
                                  />
                                  <p className="text-xs text-slate-400 mt-1.5">
                                    {setting.category === 'frontend' ? (
                                      <>Supports Markdown: <code className="bg-slate-100 px-1 rounded text-xs">**bold**</code>, <code className="bg-slate-100 px-1 rounded text-xs">### headings</code></>
                                    ) : setting.description?.match(/Variables: (.+)/)?.[1] ? (
                                      <>Variables: <code className="bg-slate-100 px-1 rounded text-xs">{setting.description.match(/Variables: (.+)/)?.[1]}</code></>
                                    ) : null}
                                  </p>
                                </div>
                              ) : setting.allowedValues ? (
                                <select
                                  value={editValue}
                                  onChange={(e) => setEditValue(e.target.value)}
                                  className="px-3 py-2 border border-slate-200 rounded-lg text-sm focus:ring-2 focus:ring-spill-blue-400 focus:border-transparent outline-none bg-white"
                                >
                                  {setting.allowedValues.map((v: string) => (
                                    <option key={v} value={v}>{v}</option>
                                  ))}
                                </select>
                              ) : (
                                <input
                                  type="text"
                                  value={editValue}
                                  onChange={(e) => setEditValue(e.target.value)}
                                  className={`${setting.category === 'emailTemplates' ? 'w-full' : 'w-64'} px-3 py-2 border border-slate-200 rounded-lg text-sm focus:ring-2 focus:ring-spill-blue-400 focus:border-transparent outline-none`}
                                />
                              )}

                              {/* Save / Cancel buttons */}
                              <div className="flex gap-2 mt-3">
                                <button
                                  type="button"
                                  onClick={() => handleSave(setting)}
                                  disabled={isPending}
                                  className="px-4 py-2 bg-slate-900 text-white text-sm font-medium rounded-lg hover:bg-slate-800 transition-colors disabled:opacity-50"
                                >
                                  Save
                                </button>
                                <button
                                  type="button"
                                  onClick={handleCancel}
                                  disabled={isPending}
                                  className="px-4 py-2 border border-slate-200 text-slate-600 text-sm font-medium rounded-lg hover:bg-slate-50 transition-colors"
                                >
                                  Cancel
                                </button>
                              </div>
                            </div>
                          ) : (
                            /* Display mode */
                            <div className={`mt-2 ${setting.key.endsWith('Body') || setting.category === 'frontend' ? '' : 'flex items-center gap-3'}`}>
                              {setting.key.endsWith('Body') || setting.category === 'frontend' ? (
                                <div className="bg-slate-50 rounded-lg p-3 border border-slate-100">
                                  <pre className="text-sm font-mono text-slate-600 whitespace-pre-wrap max-h-28 overflow-y-auto leading-relaxed">
                                    {String(setting.value).slice(0, 300)}{String(setting.value).length > 300 ? '...' : ''}
                                  </pre>
                                </div>
                              ) : setting.valueType === 'boolean' ? (
                                <div className="flex items-center gap-2">
                                  <span className={`inline-flex px-2.5 py-1 text-xs font-medium rounded-full ${
                                    setting.value
                                      ? 'bg-emerald-50 text-emerald-700 border border-emerald-100'
                                      : 'bg-slate-100 text-slate-500'
                                  }`}>
                                    {setting.value ? 'Enabled' : 'Disabled'}
                                  </span>
                                </div>
                              ) : (
                                <>
                                  <span className="text-base font-mono font-medium text-slate-800">
                                    {String(setting.value)}
                                  </span>
                                  {setting.valueType === 'number' && setting.key.includes('Hours') && (
                                    <span className="text-sm text-slate-400">hours</span>
                                  )}
                                  {setting.valueType === 'number' && setting.key.includes('Days') && (
                                    <span className="text-sm text-slate-400">days</span>
                                  )}
                                  {setting.valueType === 'number' && setting.key.includes('Minutes') && (
                                    <span className="text-sm text-slate-400">minutes</span>
                                  )}
                                  {!setting.isDefault && (
                                    <span className="text-xs text-slate-400">
                                      (default: {String(setting.defaultValue).slice(0, 50)})
                                    </span>
                                  )}
                                </>
                              )}
                            </div>
                          )}

                          {setting.updatedAt && !setting.isDefault && (
                            <p className="text-xs text-slate-400 mt-2">
                              Updated {new Date(setting.updatedAt).toLocaleDateString()}
                              {setting.updatedBy && ` by ${setting.updatedBy}`}
                            </p>
                          )}
                        </div>

                        {/* Action buttons */}
                        {editingKey !== setting.key && (
                          <div className="flex gap-2 flex-shrink-0 pt-0.5">
                            <button
                              type="button"
                              onClick={() => handleEdit(setting)}
                              className="px-3 py-1.5 text-sm font-medium border border-slate-200 text-slate-700 rounded-lg hover:bg-slate-50 transition-colors"
                            >
                              Edit
                            </button>
                            {!setting.isDefault && (
                              <button
                                type="button"
                                onClick={() => handleReset(setting)}
                                disabled={isPending}
                                className="px-3 py-1.5 text-sm font-medium border border-slate-200 text-slate-500 rounded-lg hover:bg-slate-50 hover:text-orange-600 hover:border-orange-200 transition-colors disabled:opacity-50"
                              >
                                Reset
                              </button>
                            )}
                          </div>
                        )}
                      </div>
                    </div>
                  ))}
                </div>
              </div>
            ))}
          </div>
        )}

        {/* Mutation Errors */}
        {(updateMutation.isError || resetMutation.isError) && (
          <div className="mt-4 bg-red-50 border border-red-100 rounded-lg p-4">
            <p className="text-red-600 text-sm">
              {updateMutation.error instanceof Error
                ? updateMutation.error.message
                : resetMutation.error instanceof Error
                  ? resetMutation.error.message
                  : 'Failed to save changes'}
            </p>
          </div>
        )}

        {/* Help */}
        <div className="mt-8 p-5 bg-white border border-slate-200 rounded-xl">
          <h3 className="text-sm font-semibold text-slate-700 mb-2">About Settings</h3>
          <ul className="text-sm text-slate-500 space-y-1.5">
            <li><strong className="text-slate-600">Default values</strong> are built into the application and used when no custom value is set.</li>
            <li><strong className="text-slate-600">Custom values</strong> override defaults and persist across deployments.</li>
            <li><strong className="text-slate-600">Resetting</strong> removes the custom value and reverts to the default.</li>
            <li>Changes take effect immediately (may take up to 1 minute for cache refresh).</li>
          </ul>
        </div>
      </div>

      {/* Reset Confirmation Dialog */}
      {resetConfirmSetting && (
        <div
          className="fixed inset-0 bg-black/40 flex items-center justify-center z-50"
          onClick={() => setResetConfirmSetting(null)}
          onKeyDown={(e) => { if (e.key === 'Escape') setResetConfirmSetting(null); }}
        >
          <div
            role="dialog"
            aria-modal="true"
            aria-labelledby="reset-confirm-title"
            className="bg-white rounded-xl shadow-lg max-w-md w-full mx-4 p-6"
            onClick={(e) => e.stopPropagation()}
            ref={(el) => el?.focus()}
            tabIndex={-1}
          >
            <h3 id="reset-confirm-title" className="text-lg font-semibold text-slate-900 mb-2">Reset Setting</h3>
            <p className="text-slate-500 mb-6 text-sm">
              Reset "{resetConfirmSetting.label}" to default value ({String(resetConfirmSetting.defaultValue).slice(0, 100)})?
            </p>
            <div className="flex gap-3 justify-end">
              <button
                onClick={() => setResetConfirmSetting(null)}
                className="px-4 py-2 border border-slate-200 text-slate-700 rounded-lg hover:bg-slate-50 transition-colors text-sm font-medium"
              >
                Cancel
              </button>
              <button
                onClick={confirmReset}
                disabled={resetMutation.isPending}
                className="px-4 py-2 bg-slate-900 text-white rounded-lg hover:bg-slate-800 transition-colors disabled:opacity-50 text-sm font-medium"
              >
                {resetMutation.isPending ? 'Resetting...' : 'Reset to Default'}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

function CategoryPill({ active, onClick, label }: { active: boolean; onClick: () => void; label: string }) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-pressed={active}
      className={`px-4 py-1.5 rounded-full text-sm font-medium transition-colors border ${
        active
          ? 'bg-spill-blue-100 text-spill-blue-900 border-spill-blue-200'
          : 'bg-white border-slate-200 text-slate-600 hover:bg-slate-50'
      }`}
    >
      {label}
    </button>
  );
}
