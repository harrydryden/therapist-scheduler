import { fetchAdminApi, unwrap } from './core';

export interface WeeklyMailingPreview {
  /** Whether the weekly mailing toggle is on. Disabled previews still render
   *  the templates so the admin can verify content while it's off. */
  enabled: boolean;
  /** Number of users who would receive this send right now. */
  recipientCount: number;
  /** Subject with `{userName}` resolved to a placeholder. */
  subjectPreview: string;
  /** Body with all template variables resolved (voucher section shown in
   *  the "new voucher" form a fresh recipient would see). */
  bodyPreview: string;
}

export interface WeeklyMailingTriggerResult {
  message: string;
  sent: number;
  failed: number;
  total: number;
}

export async function getWeeklyMailingPreview(): Promise<WeeklyMailingPreview> {
  return unwrap(
    await fetchAdminApi<WeeklyMailingPreview>('/admin/weekly-mailing/preview'),
    'weekly mailing preview',
  );
}

export async function triggerWeeklyMailing(): Promise<WeeklyMailingTriggerResult> {
  return unwrap(
    await fetchAdminApi<WeeklyMailingTriggerResult>(
      '/admin/weekly-mailing/trigger',
      { method: 'POST' },
    ),
    'weekly mailing trigger',
  );
}
