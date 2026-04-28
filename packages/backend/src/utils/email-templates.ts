import { getSettingValue } from '../services/settings.service';

/**
 * Variables available for email template rendering
 */
export interface TemplateVariables {
  userName?: string;
  therapistName?: string;
  therapistFirstName?: string;
  clientFirstName?: string;
  userEmail?: string;
  confirmedDateTime?: string;
  feedbackFormUrl?: string;
  webAppUrl?: string;
  unsubscribeUrl?: string;
  selectedDateTime?: string;
  // Session reminder variables (Edge Case #6)
  recipientName?: string;
  otherPartyName?: string;
  recipientType?: 'user' | 'therapist';
  // Cancellation variables
  cancellationReason?: string;
  // Voucher variables (weekly mailing with voucher codes)
  voucherCode?: string;
  voucherExpiry?: string;
  // Allow arbitrary template variables
  [key: string]: string | undefined;
}

/**
 * Escape a string for safe inclusion in HTML content.
 * Prevents XSS when user-controlled values are rendered in HTML email bodies.
 */
function escapeHtml(str: string): string {
  return str
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/**
 * Render an email template by replacing variable placeholders with actual values
 * Placeholders are in the format {variableName}
 *
 * Values are HTML-escaped to prevent XSS and stripped of \r\n to prevent header injection.
 */
export function renderTemplate(template: string, variables: TemplateVariables): string {
  let rendered = template;
  for (const [key, value] of Object.entries(variables)) {
    if (value !== undefined) {
      // Strip \r\n to prevent email header injection, HTML-escape to prevent XSS
      const sanitizedValue = escapeHtml(String(value).replace(/[\r\n]/g, ''));
      rendered = rendered.replace(new RegExp(`\\{${key}\\}`, 'g'), sanitizedValue);
    }
  }
  return rendered;
}

/**
 * Get and render an email subject template
 * @param templateKey - Base key without 'email.' prefix and 'Subject' suffix (e.g., 'clientConfirmation')
 * @param variables - Variables to substitute in the template
 */
export async function getEmailSubject(
  templateKey: string,
  variables: TemplateVariables
): Promise<string> {
  const settingKey = `email.${templateKey}Subject` as Parameters<typeof getSettingValue>[0];
  const template = await getSettingValue<string>(settingKey);
  return renderTemplate(template, variables);
}

/**
 * Get and render an email body template
 * @param templateKey - Base key without 'email.' prefix and 'Body' suffix (e.g., 'clientConfirmation')
 * @param variables - Variables to substitute in the template
 */
export async function getEmailBody(
  templateKey: string,
  variables: TemplateVariables
): Promise<string> {
  const settingKey = `email.${templateKey}Body` as Parameters<typeof getSettingValue>[0];
  const template = await getSettingValue<string>(settingKey);
  return renderTemplate(template, variables);
}

/**
 * Load and render both subject and body for an email template in parallel,
 * aggregating partial failures into a single thrown error.
 *
 * Without this helper the lifecycle's notification dispatch repeats the
 * same Promise.allSettled + manual rejection-unpacking shape four times. The
 * variable maps for subject and body often differ slightly (subject typically
 * needs fewer fields), so accept them separately.
 */
export async function loadEmailTemplate(
  templateKey: string,
  subjectVariables: TemplateVariables,
  bodyVariables: TemplateVariables = subjectVariables,
): Promise<{ subject: string; body: string }> {
  const results = await Promise.allSettled([
    getEmailSubject(templateKey, subjectVariables),
    getEmailBody(templateKey, bodyVariables),
  ]);

  const failures = results.filter((r): r is PromiseRejectedResult => r.status === 'rejected');
  if (failures.length > 0) {
    const reasons = failures.map((r) => (r.reason instanceof Error ? r.reason.message : String(r.reason)));
    throw new Error(`Email template '${templateKey}' load failed: ${reasons.join('; ')}`);
  }

  // Both fulfilled at this point.
  const [subjectResult, bodyResult] = results as [
    PromiseFulfilledResult<string>,
    PromiseFulfilledResult<string>,
  ];
  return { subject: subjectResult.value, body: bodyResult.value };
}
