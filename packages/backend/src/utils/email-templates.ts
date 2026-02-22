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
