import { useState } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { getSettings, updateSetting, resetSetting } from '../api/client';
import type { SystemSetting, SettingCategory } from '../types';

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
  stale: {
    label: 'Stale Detection',
    description: 'Control when appointments are marked as stale and when to alert admins',
    icon: 'M12 8v4l3 3m6-3a9 9 0 11-18 0 9 9 0 0118 0z',
  },
  postBooking: {
    label: 'Post-Booking Follow-up',
    description: 'Configure automated follow-up emails after appointments are confirmed',
    icon: 'M3 8l7.89 5.26a2 2 0 002.22 0L21 8M5 19h14a2 2 0 002-2V7a2 2 0 00-2-2H5a2 2 0 00-2 2v10a2 2 0 002 2z',
  },
  agent: {
    label: 'AI Agent',
    description: 'Configure the Justin Time scheduling agent behavior',
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
};

// Get a persistent admin ID for this browser session
function getAdminId(): string {
  const stored = localStorage.getItem('admin_id');
  if (stored) return stored;
  const newId = `admin_${Date.now().toString(36)}`;
  localStorage.setItem('admin_id', newId);
  return newId;
}

export default function AdminSettingsPage() {
  const queryClient = useQueryClient();
  const [editingKey, setEditingKey] = useState<string | null>(null);
  const [editValue, setEditValue] = useState<string>('');
  const [activeCategory, setActiveCategory] = useState<SettingCategory | 'all'>('all');
  const adminId = getAdminId();

  // Fetch settings
  const {
    data: settingsData,
    isLoading,
    error,
  } = useQuery({
    queryKey: ['settings'],
    queryFn: getSettings,
  });

  // Update mutation
  const updateMutation = useMutation({
    mutationFn: ({ key, value }: { key: string; value: string | number | boolean }) =>
      updateSetting(key, { value, adminId }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['settings'] });
      setEditingKey(null);
      setEditValue('');
    },
  });

  // Reset mutation
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

    // Convert to appropriate type
    if (setting.valueType === 'number') {
      value = Number(editValue);
      if (isNaN(value)) {
        return; // Invalid number
      }
    } else if (setting.valueType === 'boolean') {
      value = editValue === 'true';
    }

    updateMutation.mutate({ key: setting.key, value });
  };

  const handleReset = (setting: SystemSetting) => {
    if (window.confirm(`Reset "${setting.label}" to default value (${setting.defaultValue})?`)) {
      resetMutation.mutate(setting.key);
    }
  };

  const handleCancel = () => {
    setEditingKey(null);
    setEditValue('');
  };

  // Filter settings by category
  const filteredSettings = settingsData?.settings.filter(
    s => activeCategory === 'all' || s.category === activeCategory
  ) || [];

  // Group filtered settings by category for display
  const groupedSettings = filteredSettings.reduce((acc, setting) => {
    if (!acc[setting.category]) {
      acc[setting.category] = [];
    }
    acc[setting.category].push(setting);
    return acc;
  }, {} as Record<SettingCategory, SystemSetting[]>);

  const isPending = updateMutation.isPending || resetMutation.isPending;

  return (
    <div className="min-h-screen bg-slate-50 py-8 px-4">
      <div className="max-w-4xl mx-auto">
        {/* Header */}
        <div className="mb-8">
          <h1 className="text-3xl font-bold text-slate-900">Settings</h1>
          <p className="text-slate-600 mt-1">
            Configure system settings for the scheduling agent and automation
          </p>
        </div>

        {/* Error State */}
        {error && (
          <div className="bg-red-50 border border-red-200 rounded-xl p-4 mb-6">
            <p className="text-red-600">
              {error instanceof Error ? error.message : 'Failed to load settings'}
            </p>
          </div>
        )}

        {/* Category Filter */}
        <div className="mb-6 flex flex-wrap gap-2">
          <button
            type="button"
            onClick={() => setActiveCategory('all')}
            aria-pressed={activeCategory === 'all'}
            aria-label="Show all settings categories"
            className={`px-4 py-2 rounded-lg text-sm font-medium transition-colors ${
              activeCategory === 'all'
                ? 'bg-spill-blue text-white'
                : 'bg-white border border-slate-200 text-slate-600 hover:bg-slate-50'
            }`}
          >
            All Settings
          </button>
          {settingsData?.categories.map((cat) => (
            <button
              key={cat}
              type="button"
              onClick={() => setActiveCategory(cat)}
              aria-pressed={activeCategory === cat}
              aria-label={`Filter to ${categoryInfo[cat]?.label || cat} settings`}
              className={`px-4 py-2 rounded-lg text-sm font-medium transition-colors ${
                activeCategory === cat
                  ? 'bg-spill-blue text-white'
                  : 'bg-white border border-slate-200 text-slate-600 hover:bg-slate-50'
              }`}
            >
              {categoryInfo[cat]?.label || cat}
            </button>
          ))}
        </div>

        {/* Loading State */}
        {isLoading ? (
          <div className="bg-white rounded-2xl shadow-sm border border-slate-100 p-8 text-center">
            <div className="animate-spin rounded-full h-8 w-8 border-2 border-slate-200 border-t-spill-blue mx-auto"></div>
            <p className="text-sm text-slate-500 mt-2">Loading settings...</p>
          </div>
        ) : (
          /* Settings Groups */
          <div className="space-y-6">
            {Object.entries(groupedSettings).map(([category, settings]) => (
              <div
                key={category}
                className="bg-white rounded-2xl shadow-sm border border-slate-100 overflow-hidden"
              >
                {/* Category Header */}
                <div className="p-4 border-b border-slate-100 bg-slate-50">
                  <div className="flex items-center gap-3">
                    <div className="w-10 h-10 bg-primary-50 rounded-lg flex items-center justify-center">
                      <svg
                        className="w-5 h-5 text-spill-blue"
                        fill="none"
                        stroke="currentColor"
                        viewBox="0 0 24 24"
                      >
                        <path
                          strokeLinecap="round"
                          strokeLinejoin="round"
                          strokeWidth={2}
                          d={categoryInfo[category as SettingCategory]?.icon || 'M12 6v6m0 0v6m0-6h6m-6 0H6'}
                        />
                      </svg>
                    </div>
                    <div>
                      <h2 className="font-semibold text-slate-900">
                        {categoryInfo[category as SettingCategory]?.label || category}
                      </h2>
                      <p className="text-sm text-slate-500">
                        {categoryInfo[category as SettingCategory]?.description}
                      </p>
                    </div>
                  </div>
                </div>

                {/* Settings List */}
                <div className="divide-y divide-slate-100">
                  {settings.map((setting) => (
                    <div key={setting.key} className="p-4">
                      <div className="flex items-start justify-between gap-4">
                        <div className="flex-1 min-w-0">
                          <div className="flex items-center gap-2 mb-1">
                            <h3 className="font-medium text-slate-900">{setting.label}</h3>
                            {setting.isDefault && (
                              <span className="px-2 py-0.5 text-xs font-medium rounded-full bg-slate-100 text-slate-500">
                                Default
                              </span>
                            )}
                            {!setting.isDefault && (
                              <span className="px-2 py-0.5 text-xs font-medium rounded-full bg-primary-50 text-primary-700">
                                Custom
                              </span>
                            )}
                          </div>
                          {setting.description && (
                            <p className="text-sm text-slate-500 mb-2">{setting.description}</p>
                          )}

                          {/* Value Display/Edit */}
                          {editingKey === setting.key ? (
                            <div className={`mt-2 ${setting.key.endsWith('Body') ? 'space-y-2' : 'flex items-center gap-2'}`}>
                              {setting.valueType === 'boolean' ? (
                                <select
                                  value={editValue}
                                  onChange={(e) => setEditValue(e.target.value)}
                                  className="px-3 py-1.5 border border-slate-200 rounded-lg text-sm focus:ring-2 focus:ring-spill-blue focus:border-transparent outline-none"
                                >
                                  <option value="true">Enabled</option>
                                  <option value="false">Disabled</option>
                                </select>
                              ) : setting.key.endsWith('Body') || setting.category === 'frontend' ? (
                                /* Multi-line textarea for email body templates and frontend content */
                                <div className="w-full">
                                  <textarea
                                    value={editValue}
                                    onChange={(e) => setEditValue(e.target.value)}
                                    rows={setting.category === 'frontend' ? 16 : 12}
                                    className="w-full px-3 py-2 border border-slate-200 rounded-lg text-sm font-mono focus:ring-2 focus:ring-spill-blue focus:border-transparent outline-none resize-y"
                                    placeholder={setting.category === 'frontend' ? "Markdown content..." : "Email template body..."}
                                  />
                                  <p className="text-xs text-slate-500 mt-1">
                                    {setting.category === 'frontend' ? (
                                      <>Supports Markdown formatting: <code className="bg-slate-100 px-1 rounded">**bold**</code>, <code className="bg-slate-100 px-1 rounded">### headings</code></>
                                    ) : setting.description?.match(/Variables: (.+)/)?.[1] ? (
                                      <>Available variables: <code className="bg-slate-100 px-1 rounded">{setting.description.match(/Variables: (.+)/)?.[1]}</code></>
                                    ) : null}
                                  </p>
                                </div>
                              ) : (
                                <input
                                  type={setting.valueType === 'number' ? 'number' : 'text'}
                                  value={editValue}
                                  onChange={(e) => setEditValue(e.target.value)}
                                  min={setting.minValue ?? undefined}
                                  max={setting.maxValue ?? undefined}
                                  className={`${setting.category === 'emailTemplates' ? 'w-full' : 'w-32'} px-3 py-1.5 border border-slate-200 rounded-lg text-sm focus:ring-2 focus:ring-spill-blue focus:border-transparent outline-none`}
                                />
                              )}
                              {setting.valueType === 'number' && (
                                <span className="text-xs text-slate-400">
                                  {setting.minValue !== null && `Min: ${setting.minValue}`}
                                  {setting.minValue !== null && setting.maxValue !== null && ' | '}
                                  {setting.maxValue !== null && `Max: ${setting.maxValue}`}
                                </span>
                              )}
                              <div className={`flex gap-2 ${setting.key.endsWith('Body') ? '' : ''}`}>
                                <button
                                  type="button"
                                  onClick={() => handleSave(setting)}
                                  disabled={isPending}
                                  aria-label={`Save changes to ${setting.label}`}
                                  aria-busy={isPending}
                                  className="px-3 py-1.5 bg-spill-blue text-white text-sm rounded-lg hover:bg-primary-600 transition-colors disabled:opacity-50"
                                >
                                  Save
                                </button>
                                <button
                                  type="button"
                                  onClick={handleCancel}
                                  disabled={isPending}
                                  aria-label="Cancel editing"
                                  className="px-3 py-1.5 border border-slate-200 text-slate-600 text-sm rounded-lg hover:bg-slate-50 transition-colors"
                                >
                                  Cancel
                                </button>
                              </div>
                            </div>
                          ) : (
                            <div className={`mt-2 ${setting.key.endsWith('Body') || setting.category === 'frontend' ? '' : 'flex items-center gap-3'}`}>
                              {setting.key.endsWith('Body') || setting.category === 'frontend' ? (
                                /* Email body template or frontend content preview */
                                <div className="bg-slate-50 rounded-lg p-3 border border-slate-200">
                                  <pre className="text-sm font-mono text-slate-600 whitespace-pre-wrap max-h-32 overflow-y-auto">
                                    {String(setting.value).slice(0, 300)}{String(setting.value).length > 300 ? '...' : ''}
                                  </pre>
                                  {!setting.isDefault && (
                                    <p className="text-xs text-amber-600 mt-2">
                                      ✎ Customized (click Edit to see full content)
                                    </p>
                                  )}
                                </div>
                              ) : (
                                <>
                                  <div className="flex items-center gap-2">
                                    <span className={`${setting.category === 'emailTemplates' ? 'text-sm' : 'text-lg'} font-mono text-slate-700`}>
                                      {setting.valueType === 'boolean'
                                        ? setting.value ? 'Enabled' : 'Disabled'
                                        : String(setting.value)}
                                    </span>
                                    {setting.valueType === 'number' && setting.key.includes('Hours') && (
                                      <span className="text-sm text-slate-400">hours</span>
                                    )}
                                    {setting.valueType === 'number' && setting.key.includes('Days') && (
                                      <span className="text-sm text-slate-400">days</span>
                                    )}
                                  </div>
                                  {!setting.isDefault && (
                                    <span className="text-xs text-slate-400">
                                      (default: {String(setting.defaultValue).slice(0, 50)}{String(setting.defaultValue).length > 50 ? '...' : ''})
                                    </span>
                                  )}
                                </>
                              )}
                            </div>
                          )}

                          {/* Updated info */}
                          {setting.updatedAt && !setting.isDefault && (
                            <p className="text-xs text-slate-400 mt-2">
                              Last updated: {new Date(setting.updatedAt).toLocaleString()}
                              {setting.updatedBy && ` by ${setting.updatedBy}`}
                            </p>
                          )}
                        </div>

                        {/* Actions */}
                        {editingKey !== setting.key && (
                          <div className="flex gap-2 flex-shrink-0">
                            <button
                              type="button"
                              onClick={() => handleEdit(setting)}
                              aria-label={`Edit ${setting.label} setting`}
                              className="px-3 py-1.5 text-sm border border-slate-200 text-slate-600 rounded-lg hover:bg-slate-50 transition-colors"
                            >
                              Edit
                            </button>
                            {!setting.isDefault && (
                              <button
                                type="button"
                                onClick={() => handleReset(setting)}
                                disabled={isPending}
                                aria-label={`Reset ${setting.label} to default value`}
                                className="px-3 py-1.5 text-sm border border-orange-200 text-orange-600 rounded-lg hover:bg-orange-50 transition-colors disabled:opacity-50"
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
          <div className="mt-4 bg-red-50 border border-red-200 rounded-xl p-4">
            <p className="text-red-600 text-sm">
              {updateMutation.error instanceof Error
                ? updateMutation.error.message
                : resetMutation.error instanceof Error
                  ? resetMutation.error.message
                  : 'Failed to save changes'}
            </p>
          </div>
        )}

        {/* Help Text */}
        <div className="mt-8 p-4 bg-slate-100 rounded-xl">
          <h3 className="font-medium text-slate-700 mb-2">About Settings</h3>
          <ul className="text-sm text-slate-600 space-y-1">
            <li>
              <strong>Default values</strong> are built into the application code and used when no custom value is set.
            </li>
            <li>
              <strong>Custom values</strong> override defaults and persist across deployments.
            </li>
            <li>
              <strong>Resetting</strong> removes the custom value and reverts to the default.
            </li>
            <li>
              Changes take effect immediately after saving (may take up to 1 minute for caching to refresh).
            </li>
          </ul>
        </div>
      </div>
    </div>
  );
}
