import { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import { z } from 'zod';
import { prisma } from '../utils/database';
import { logger } from '../utils/logger';
import { verifyWebhookSecret } from '../middleware/auth';
import { RATE_LIMITS, INACTIVITY_THRESHOLDS, POST_BOOKING, CONVERSATION_LIMITS, CLAUDE_API, DATA_RETENTION, APP_DEFAULTS, STALL_DETECTION } from '../constants';
import { cacheManager } from '../utils/redis';
import { adminNotificationService } from '../services/admin-notification.service';

// Settings cache key prefix
const SETTINGS_CACHE_PREFIX = 'settings:';
const SETTINGS_CACHE_TTL = 60; // 1 minute cache

// In-memory cache layer to avoid Redis round-trips on every getSettingValue call
const memoryCache = new Map<string, { value: unknown; expiresAt: number }>();
const MEMORY_CACHE_TTL_MS = 30_000; // 30 seconds

function memoryCacheGet<T>(key: string): T | undefined {
  const entry = memoryCache.get(key);
  if (!entry) return undefined;
  if (Date.now() > entry.expiresAt) {
    memoryCache.delete(key);
    return undefined;
  }
  return entry.value as T;
}

function memoryCacheSet(key: string, value: unknown): void {
  memoryCache.set(key, { value, expiresAt: Date.now() + MEMORY_CACHE_TTL_MS });
}

function memoryCacheInvalidate(key: string): void {
  memoryCache.delete(key);
}

function memoryCacheInvalidateAll(): void {
  memoryCache.clear();
}

// Setting definition type
interface SettingDefinition {
  category: string;
  label: string;
  description: string;
  valueType: 'number' | 'string' | 'boolean';
  minValue?: number;
  maxValue?: number;
  defaultValue: number | string | boolean;
  allowedValues?: string[]; // For enum-like string settings
}

// Define all configurable settings with their metadata
// These are the settings that will be exposed in the admin UI
const SETTING_DEFINITIONS: Record<string, SettingDefinition> = {
  // Post-booking follow-up settings
  'postBooking.meetingLinkCheckDelayHours': {
    category: 'postBooking',
    label: 'Meeting Link Check Delay (hours)',
    description: 'Hours after confirmation before sending meeting link check email',
    valueType: 'number',
    minValue: 1,
    maxValue: 72,
    defaultValue: POST_BOOKING.MEETING_LINK_CHECK_DELAY_HOURS,
  },
  'postBooking.meetingLinkCheckMinBeforeHours': {
    category: 'postBooking',
    label: 'Minimum Hours Before Appointment',
    description: 'Stop sending meeting link checks this close to the appointment',
    valueType: 'number',
    minValue: 1,
    maxValue: 24,
    defaultValue: POST_BOOKING.MEETING_LINK_CHECK_MIN_BEFORE_HOURS,
  },
  'postBooking.feedbackFormDelayHours': {
    category: 'postBooking',
    label: 'Feedback Form Delay (hours)',
    description: 'Hours after appointment before sending feedback form',
    valueType: 'number',
    minValue: 1,
    maxValue: 168,
    defaultValue: POST_BOOKING.FEEDBACK_FORM_DELAY_HOURS,
  },
  'postBooking.feedbackReminderDelayHours': {
    category: 'postBooking',
    label: 'Feedback Reminder Delay (hours)',
    description: 'Hours after sending feedback form before sending a reminder',
    valueType: 'number',
    minValue: 12,
    maxValue: 168,
    defaultValue: POST_BOOKING.FEEDBACK_REMINDER_DELAY_HOURS,
  },
  'postBooking.sessionReminderHoursBefore': {
    category: 'postBooking',
    label: 'Session Reminder (hours before)',
    description: 'Hours before the appointment to send session reminder to both user and therapist',
    valueType: 'number',
    minValue: 1,
    maxValue: 48,
    defaultValue: POST_BOOKING.SESSION_REMINDER_HOURS_BEFORE,
  },

  // Agent conversation settings
  'agent.maxMessages': {
    category: 'agent',
    label: 'Max Conversation Messages',
    description: 'Maximum messages to keep in conversation state',
    valueType: 'number',
    minValue: 20,
    maxValue: 500,
    defaultValue: CONVERSATION_LIMITS.MAX_MESSAGES,
  },
  'agent.trimToMessages': {
    category: 'agent',
    label: 'Trim To Messages',
    description: 'Number of messages to keep when trimming conversation',
    valueType: 'number',
    minValue: 10,
    maxValue: 250,
    defaultValue: CONVERSATION_LIMITS.TRIM_TO_MESSAGES,
  },
  'agent.maxRetries': {
    category: 'agent',
    label: 'Max Claude API Retries',
    description: 'Maximum retry attempts for rate-limited Claude API calls',
    valueType: 'number',
    minValue: 1,
    maxValue: 10,
    defaultValue: CLAUDE_API.MAX_RETRIES,
  },
  'agent.languageStyle': {
    category: 'agent',
    label: 'Language Style',
    description: 'Grammar and spelling style for agent communications (UK or US English)',
    valueType: 'string',
    defaultValue: 'UK',
    allowedValues: ['UK', 'US'],
  },

  // Data retention settings
  'retention.cancelledDays': {
    category: 'retention',
    label: 'Cancelled Retention (days)',
    description: 'Days to keep cancelled appointments before archiving',
    valueType: 'number',
    minValue: 30,
    maxValue: 365,
    defaultValue: DATA_RETENTION.CANCELLED_RETENTION_DAYS,
  },
  'retention.completedDays': {
    category: 'retention',
    label: 'Completed Retention (days)',
    description: 'Days to keep completed appointments before archiving',
    valueType: 'number',
    minValue: 90,
    maxValue: 730, // 2 years
    defaultValue: DATA_RETENTION.COMPLETED_RETENTION_DAYS,
  },

  // General settings
  'general.timezone': {
    category: 'general',
    label: 'Default Timezone',
    description: 'IANA timezone identifier for date/time parsing (e.g., Europe/London, America/New_York)',
    valueType: 'string',
    defaultValue: APP_DEFAULTS.TIMEZONE,
  },
  'general.maxActiveThreadsPerUser': {
    category: 'general',
    label: 'Max Active Threads Per User',
    description: 'Maximum number of active appointment requests a single user can have at once. Set to 0 to disable limit.',
    valueType: 'number',
    minValue: 0,
    maxValue: 10,
    defaultValue: 2,
  },

  // === EMAIL TEMPLATES ===
  'email.clientConfirmationSubject': {
    category: 'emailTemplates',
    label: 'Client Confirmation - Subject',
    description: 'Subject line for client booking confirmation. Variables: {therapistName}, {confirmedDateTime}',
    valueType: 'string',
    defaultValue: 'Confirmed: Therapy session with {therapistName} - {confirmedDateTime}',
  },
  'email.clientConfirmationBody': {
    category: 'emailTemplates',
    label: 'Client Confirmation - Body',
    description: 'Email body for client confirmation. Variables: {userName}, {therapistName}, {confirmedDateTime}',
    valueType: 'string',
    defaultValue: `Hi {userName},

Great news! Your therapy session with {therapistName} has been confirmed for {confirmedDateTime}.

{therapistName} will send you the meeting link and any pre-session information directly.

If you have any questions before your session, feel free to reply to this email.

Best wishes

Justin`,
  },
  'email.therapistConfirmationSubject': {
    category: 'emailTemplates',
    label: 'Therapist Confirmation - Subject',
    description: 'Subject line for therapist booking confirmation. Variables: {confirmedDateTime}',
    valueType: 'string',
    defaultValue: 'Booking Confirmed: Session on {confirmedDateTime}',
  },
  'email.therapistConfirmationBody': {
    category: 'emailTemplates',
    label: 'Therapist Confirmation - Body',
    description: 'Email body for therapist confirmation. Variables: {therapistFirstName}, {clientFirstName}, {userEmail}, {confirmedDateTime}',
    valueType: 'string',
    defaultValue: `Hi {therapistFirstName},

Thanks for confirming! The session with {clientFirstName} is all set:

**Session Details:**
- Client Email: {userEmail}
- Date/Time: {confirmedDateTime}
- Duration: 50 minutes

Please send {clientFirstName} the meeting link and any pre-session information at {userEmail}.

Best wishes

Justin`,
  },
  'email.meetingLinkCheckSubject': {
    category: 'emailTemplates',
    label: 'Meeting Link Check - Subject',
    description: 'Subject line for meeting link reminder. Variables: {therapistName}',
    valueType: 'string',
    defaultValue: 'Meeting link for your session with {therapistName}',
  },
  'email.meetingLinkCheckBody': {
    category: 'emailTemplates',
    label: 'Meeting Link Check - Body',
    description: 'Email body asking client if they received meeting link. Variables: {userName}, {therapistName}, {confirmedDateTime}',
    valueType: 'string',
    defaultValue: `Hi {userName},

Just checking in - have you received the meeting link from {therapistName} for your session on {confirmedDateTime}?

If you haven't received it yet, please let us know and we'll follow up with your therapist.

Best wishes

Justin`,
  },
  'email.feedbackFormSubject': {
    category: 'emailTemplates',
    label: 'Feedback Form - Subject',
    description: 'Subject line for post-session feedback request. Variables: {therapistName}',
    valueType: 'string',
    defaultValue: 'How was your session with {therapistName}?',
  },
  'email.feedbackFormBody': {
    category: 'emailTemplates',
    label: 'Feedback Form - Body',
    description: 'Email body requesting session feedback. Variables: {userName}, {therapistName}, {feedbackFormUrl}',
    valueType: 'string',
    defaultValue: `Hi {userName},

We hope your session with {therapistName} went well!

We'd love to hear about your experience - [please share your feedback here]({feedbackFormUrl}). It only takes a minute and really helps us improve.

Thank you for using Spill!

Best wishes

Justin`,
  },
  'email.feedbackReminderSubject': {
    category: 'emailTemplates',
    label: 'Feedback Reminder - Subject',
    description: 'Subject line for feedback reminder. Variables: {therapistName}',
    valueType: 'string',
    defaultValue: 'Spill - Quick reminder: Share your feedback',
  },
  'email.feedbackReminderBody': {
    category: 'emailTemplates',
    label: 'Feedback Reminder - Body',
    description: 'Email body for feedback reminder. Variables: {userName}, {therapistName}, {feedbackFormUrl}',
    valueType: 'string',
    defaultValue: `Hi {userName},

Just a gentle reminder - we'd still love to hear how your session with {therapistName} went.

[Share your feedback here]({feedbackFormUrl}) - it only takes a minute!

Thanks!

Best wishes,

Justin`,
  },
  'email.sessionReminderSubject': {
    category: 'emailTemplates',
    label: 'Session Reminder - Subject',
    description: 'Subject line for session reminder. Variables: {therapistName}, {recipientType}',
    valueType: 'string',
    defaultValue: 'Reminder: Your upcoming session',
  },
  'email.sessionReminderBody': {
    category: 'emailTemplates',
    label: 'Session Reminder - Body',
    description: 'Email body for session reminder sent before appointment. Variables: {recipientName}, {otherPartyName}, {confirmedDateTime}, {recipientType}',
    valueType: 'string',
    defaultValue: `Hi {recipientName},

Just a friendly reminder that you have a session coming up soon:

**Session Details:**
- Date/Time: {confirmedDateTime}
- Duration: 50 minutes
- With: {otherPartyName}

If you need to reschedule or have any questions, please let us know as soon as possible.

Best wishes

Justin`,
  },

  // === CANCELLATION EMAILS ===
  'email.clientCancellationSubject': {
    category: 'emailTemplates',
    label: 'Client Cancellation - Subject',
    description: 'Subject line for client cancellation notification. Variables: {therapistName}',
    valueType: 'string',
    defaultValue: 'Your Spill session with {therapistName} has been cancelled',
  },
  'email.clientCancellationBody': {
    category: 'emailTemplates',
    label: 'Client Cancellation - Body',
    description: 'Email body for client cancellation notification. Variables: {userName}, {therapistName}, {confirmedDateTime}, {cancellationReason}',
    valueType: 'string',
    defaultValue: `Hi {userName},

Your Spill session on {confirmedDateTime} with {therapistName} has been cancelled.{cancellationReason}

Please feel free to [book another session](https://free.spill.app).

Best wishes

Justin`,
  },
  'email.therapistCancellationSubject': {
    category: 'emailTemplates',
    label: 'Therapist Cancellation - Subject',
    description: 'Subject line for therapist cancellation notification. Variables: {clientFirstName}',
    valueType: 'string',
    defaultValue: 'Your Spill session with {clientFirstName} has been cancelled',
  },
  'email.therapistCancellationBody': {
    category: 'emailTemplates',
    label: 'Therapist Cancellation - Body',
    description: 'Email body for therapist cancellation notification. Variables: {therapistFirstName}, {clientFirstName}, {confirmedDateTime}, {cancellationReason}',
    valueType: 'string',
    defaultValue: `Hi {therapistFirstName},

Your Spill session on {confirmedDateTime} with {clientFirstName} has been cancelled.{cancellationReason}

We will organise another session as soon as we can.

Best wishes

Justin`,
  },

  // === INITIAL AGENT EMAILS ===
  'email.initialClientWithAvailabilitySubject': {
    category: 'emailTemplates',
    label: 'Initial to Client (With Availability) - Subject',
    description: 'Subject when first contacting client with available slots. Variables: {therapistName}',
    valueType: 'string',
    defaultValue: 'Booking your therapy session with {therapistName}',
  },
  'email.initialClientWithAvailabilityBody': {
    category: 'emailTemplates',
    label: 'Initial to Client (With Availability) - Body',
    description: 'First email to client presenting available slots. Variables: {userName}, {therapistName}. Note: Available time slots will be inserted by the agent.',
    valueType: 'string',
    defaultValue: `Hi {userName},

I'm Justin, the scheduling assistant for Spill. I'm here to help you book your therapy session with {therapistName}.

{therapistName} has the following times available:

[AVAILABILITY_SLOTS]

Please let me know which of these times works best for you, or if none of them suit your schedule.

Best wishes,

Justin`,
  },
  'email.initialTherapistWithAvailabilitySubject': {
    category: 'emailTemplates',
    label: 'Initial to Therapist (With Availability) - Subject',
    description: 'Subject when notifying therapist of new client interest (availability already known). Variables: {clientFirstName}',
    valueType: 'string',
    defaultValue: 'New client interested: {clientFirstName}',
  },
  'email.initialTherapistWithAvailabilityBody': {
    category: 'emailTemplates',
    label: 'Initial to Therapist (With Availability) - Body',
    description: 'First email to therapist when availability is already on file. Variables: {therapistFirstName}, {clientFirstName}',
    valueType: 'string',
    defaultValue: `Hi {therapistFirstName},

I have a new client, {clientFirstName}, who would like to book a 50-minute therapy session with you.

I've shared your availability with them and will be in touch once they've selected a time that works for them.

Best wishes,

Justin`,
  },
  'email.initialTherapistNoAvailabilitySubject': {
    category: 'emailTemplates',
    label: 'Initial to Therapist (No Availability) - Subject',
    description: 'Subject when first contacting therapist to request availability.',
    valueType: 'string',
    defaultValue: 'Availability request for new client',
  },
  'email.initialTherapistNoAvailabilityBody': {
    category: 'emailTemplates',
    label: 'Initial to Therapist (No Availability) - Body',
    description: 'First email to therapist asking for availability. Variables: {therapistFirstName}, {clientFirstName}',
    valueType: 'string',
    defaultValue: `Hi {therapistFirstName},

I have a new client, {clientFirstName}, who would like to book a 50-minute therapy session with you.

Could you please share your availability for the coming week or two? For example:
- Which days work for you
- What time slots are available

Once I have your availability, I'll coordinate with {clientFirstName} to find a suitable time.

Best wishes,

Justin`,
  },
  'email.slotConfirmationToTherapistSubject': {
    category: 'emailTemplates',
    label: 'Slot Confirmation Request - Subject',
    description: 'Subject when asking therapist to confirm a selected time. Variables: {selectedDateTime}',
    valueType: 'string',
    defaultValue: 'Please confirm: Session on {selectedDateTime}',
  },
  'email.slotConfirmationToTherapistBody': {
    category: 'emailTemplates',
    label: 'Slot Confirmation Request - Body',
    description: 'Email asking therapist to confirm client-selected time. Variables: {therapistFirstName}, {clientFirstName}, {selectedDateTime}',
    valueType: 'string',
    defaultValue: `Hi {therapistFirstName},

Great news! {clientFirstName} has selected a time for their 50-minute session:

**{selectedDateTime}**

Can you confirm this time still works for you? Once confirmed, please send {clientFirstName} a meeting link and any pre-session information directly.

Best wishes,

Justin`,
  },

  // === FRONTEND CONTENT ===
  'frontend.therapistPageIntro': {
    category: 'frontend',
    label: 'Therapist Page Introduction',
    description: 'Markdown text displayed on the therapist selection page above the filters. Supports basic markdown formatting.',
    valueType: 'string',
    defaultValue: `### **Help us select the top therapists**

At Spill, we are uncompromising about quality. Less than 5% of applicants pass our rigorous screening process, which requires full BACP or NCPS registration and a minimum of 200 hours of clinical experience.

### **The final step? Helping you.**

We are offering free sessions with our final-round candidates. It's a chance for you to speak with a fully qualified and experienced therapist at no cost. In exchange, we simply ask that you complete a quick feedback form afterward to help us decide if they meet the high standards we set for our customers.

All you need to do is select a therapist below. Enter your first name and email and someone from the Spill team will help schedule in the session. Once a time is agreed a session invite will come from the therapist. The session is entirely private and confidential to discuss whatever is going on for you.`,
  },

  // === WEEKLY MAILING LIST ===
  'weeklyMailing.enabled': {
    category: 'weeklyMailing',
    label: 'Enable Weekly Mailing',
    description: 'Enable or disable the weekly promotional email service',
    valueType: 'boolean',
    defaultValue: false,
  },
  'weeklyMailing.sendDay': {
    category: 'weeklyMailing',
    label: 'Send Day',
    description: 'Day of the week to send weekly emails (0=Sunday, 1=Monday, ...6=Saturday)',
    valueType: 'number',
    minValue: 0,
    maxValue: 6,
    defaultValue: 1, // Monday
  },
  'weeklyMailing.sendHour': {
    category: 'weeklyMailing',
    label: 'Send Hour (24h format)',
    description: 'Hour of the day to send weekly emails (0-23 in configured timezone)',
    valueType: 'number',
    minValue: 0,
    maxValue: 23,
    defaultValue: 9, // 9 AM
  },
  'weeklyMailing.webAppUrl': {
    category: 'weeklyMailing',
    label: 'Web App URL',
    description: 'URL to the booking web application (used in weekly emails)',
    valueType: 'string',
    defaultValue: 'https://free.spill.app/book',
  },
  'email.weeklyMailingSubject': {
    category: 'emailTemplates',
    label: 'Weekly Mailing - Subject',
    description: 'Subject line for weekly promotional email. Variables: {userName}',
    valueType: 'string',
    defaultValue: 'Book your therapy session with Spill',
  },
  'email.weeklyMailingBody': {
    category: 'emailTemplates',
    label: 'Weekly Mailing - Body',
    description: 'Email body for weekly promotional email. Variables: {userName}, {webAppUrl}. Supports markdown links: [text](url)',
    valueType: 'string',
    defaultValue: `Hi {userName},

The are new therapists available for free sessions. If you have an issue or goal you would like support with have a look at their profiles and request a session. Our only ask is that you complete a short feedback form after the session. You can have as many free sessions with different therapists as you like.

[Book your session]({webAppUrl})

Best wishes,

Justin

---
You're receiving this because you've indicated you are interested in free therapy. To unsubscribe from these reminders, simply reply to this email asking to be removed.`,
  },

  // === NOTIFICATION SETTINGS ===
  // Slack notifications
  'notifications.slack.requested': {
    category: 'notifications',
    label: 'Slack: New Appointment Request',
    description: 'Send Slack notification when a new appointment request is created',
    valueType: 'boolean',
    defaultValue: true,
  },
  'notifications.slack.confirmed': {
    category: 'notifications',
    label: 'Slack: Appointment Confirmed',
    description: 'Send Slack notification when an appointment is confirmed',
    valueType: 'boolean',
    defaultValue: true,
  },
  'notifications.slack.completed': {
    category: 'notifications',
    label: 'Slack: Appointment Completed',
    description: 'Send Slack notification when an appointment is completed (feedback received)',
    valueType: 'boolean',
    defaultValue: true,
  },
  'notifications.slack.cancelled': {
    category: 'notifications',
    label: 'Slack: Appointment Cancelled',
    description: 'Send Slack notification when an appointment is cancelled',
    valueType: 'boolean',
    defaultValue: false,
  },
  'notifications.slack.escalation': {
    category: 'notifications',
    label: 'Slack: Auto-Escalation Alerts',
    description: 'Send Slack notification when a conversation is auto-escalated to human control',
    valueType: 'boolean',
    defaultValue: true,
  },

  // Email notifications
  'notifications.email.clientConfirmation': {
    category: 'notifications',
    label: 'Email: Client Confirmation',
    description: 'Send confirmation email to client when appointment is confirmed',
    valueType: 'boolean',
    defaultValue: true,
  },
  'notifications.email.therapistConfirmation': {
    category: 'notifications',
    label: 'Email: Therapist Confirmation',
    description: 'Send confirmation email to therapist when appointment is confirmed',
    valueType: 'boolean',
    defaultValue: true,
  },
  'notifications.email.sessionReminder': {
    category: 'notifications',
    label: 'Email: Session Reminder',
    description: 'Send reminder emails before scheduled sessions',
    valueType: 'boolean',
    defaultValue: true,
  },
  'notifications.email.feedbackForm': {
    category: 'notifications',
    label: 'Email: Feedback Form',
    description: 'Send feedback form email after sessions',
    valueType: 'boolean',
    defaultValue: true,
  },
  'notifications.email.feedbackReminder': {
    category: 'notifications',
    label: 'Email: Feedback Reminder',
    description: 'Send reminder email if feedback not received',
    valueType: 'boolean',
    defaultValue: true,
  },

  // Inactivity alerts (unified setting for admin alert + auto-unfreeze)
  'notifications.inactivityAlertHours': {
    category: 'notifications',
    label: 'Inactivity Alert (hours)',
    description: 'Alert admin and auto-unfreeze therapist after this many hours of no conversation activity',
    valueType: 'number',
    minValue: 24,
    maxValue: 336, // 2 weeks
    defaultValue: INACTIVITY_THRESHOLDS.ALERT_HOURS,
  },

  // Stall detection (activity but no progress)
  'notifications.stallDetectionHours': {
    category: 'notifications',
    label: 'Stall Detection (hours)',
    description: 'Flag conversation as stalled if no tool execution despite activity for this long (auto-escalates to human control)',
    valueType: 'number',
    minValue: 12,
    maxValue: 168, // 1 week
    defaultValue: STALL_DETECTION.STALL_THRESHOLD_HOURS,
  },
};

export type SettingKey = keyof typeof SETTING_DEFINITIONS;

// Maximum string value size for settings (prevents excessive memory/DB usage)
const MAX_SETTING_STRING_LENGTH = 50 * 1024; // 50KB max for string settings

// Validation schema for updating a setting
const updateSettingSchema = z.object({
  value: z.union([z.string().max(MAX_SETTING_STRING_LENGTH), z.number(), z.boolean()]),
  adminId: z.string().min(1).max(255),
});

// Validation schema for bulk update
const bulkUpdateSchema = z.object({
  settings: z.array(z.object({
    key: z.string().max(255),
    value: z.union([z.string().max(MAX_SETTING_STRING_LENGTH), z.number(), z.boolean()]),
  })).max(50), // Limit bulk updates to 50 settings at once
  adminId: z.string().min(1).max(255),
});

/**
 * Get a setting value from cache or database
 * Returns the default value if not set
 */
export async function getSettingValue<T>(key: SettingKey): Promise<T> {
  const definition = SETTING_DEFINITIONS[key];
  if (!definition) {
    throw new Error(`Unknown setting: ${key}`);
  }

  // Check in-memory cache first (avoids Redis round-trip)
  const memCached = memoryCacheGet<T>(key);
  if (memCached !== undefined) {
    return memCached;
  }

  try {
    // Try Redis cache
    const cached = await cacheManager.getJson<T>(`${SETTINGS_CACHE_PREFIX}${key}`);
    if (cached !== null) {
      memoryCacheSet(key, cached);
      return cached;
    }

    // Try database
    const setting = await prisma.systemSetting.findUnique({
      where: { id: key },
    });

    if (setting) {
      const value = JSON.parse(setting.value) as T;
      await cacheManager.setJson(`${SETTINGS_CACHE_PREFIX}${key}`, value, SETTINGS_CACHE_TTL);
      memoryCacheSet(key, value);
      return value;
    }

    // Return default (also cache it to avoid repeated DB misses)
    memoryCacheSet(key, definition.defaultValue);
    return definition.defaultValue as T;
  } catch (err) {
    logger.warn({ err, key }, 'Failed to get setting, using default');
    return definition.defaultValue as T;
  }
}

/**
 * Batch fetch multiple settings in a single DB query.
 * Returns a Map of key → value, falling back to defaults for missing keys.
 */
export async function getSettingValues<T = unknown>(keys: SettingKey[]): Promise<Map<SettingKey, T>> {
  const result = new Map<SettingKey, T>();
  const uncachedKeys: SettingKey[] = [];

  // Check in-memory cache first
  for (const key of keys) {
    const memCached = memoryCacheGet<T>(key);
    if (memCached !== undefined) {
      result.set(key, memCached);
    } else {
      uncachedKeys.push(key);
    }
  }

  if (uncachedKeys.length === 0) return result;

  try {
    // Single batch DB query for all uncached keys
    const settings = await prisma.systemSetting.findMany({
      where: { id: { in: uncachedKeys } },
    });

    const dbMap = new Map(settings.map(s => [s.id, s.value]));

    for (const key of uncachedKeys) {
      const definition = SETTING_DEFINITIONS[key];
      const raw = dbMap.get(key);

      let value: T;
      if (raw !== undefined) {
        try {
          value = JSON.parse(raw) as T;
        } catch {
          value = definition.defaultValue as T;
        }
      } else {
        value = definition.defaultValue as T;
      }

      memoryCacheSet(key, value);
      result.set(key, value);
    }
  } catch (err) {
    // Fall back to defaults for all uncached keys
    logger.warn({ err, keyCount: uncachedKeys.length }, 'Batch settings fetch failed, using defaults');
    for (const key of uncachedKeys) {
      const definition = SETTING_DEFINITIONS[key];
      result.set(key, definition.defaultValue as T);
    }
  }

  return result;
}

/**
 * Get all settings for a category
 * FIX #18: Batch query instead of N+1 sequential getSettingValue calls
 */
export async function getCategorySettings(category: string): Promise<Record<string, unknown>> {
  const categoryKeys = Object.entries(SETTING_DEFINITIONS)
    .filter(([, def]) => def.category === category)
    .map(([key]) => key);

  if (categoryKeys.length === 0) return {};

  // Single batch query for all settings in this category
  const dbSettings = await prisma.systemSetting.findMany({
    where: { id: { in: categoryKeys } },
  });

  const dbMap = new Map(dbSettings.map(s => [s.id, s.value]));
  const categorySettings: Record<string, unknown> = {};

  for (const key of categoryKeys) {
    const definition = SETTING_DEFINITIONS[key];
    const rawValue = dbMap.get(key);

    if (rawValue !== undefined) {
      try {
        const value = JSON.parse(rawValue);
        // Cache each value for subsequent getSettingValue calls
        await cacheManager.setJson(`${SETTINGS_CACHE_PREFIX}${key}`, value, SETTINGS_CACHE_TTL);
        categorySettings[key] = value;
      } catch {
        categorySettings[key] = definition.defaultValue;
      }
    } else {
      categorySettings[key] = definition.defaultValue;
    }
  }

  return categorySettings;
}

export async function adminSettingsRoutes(fastify: FastifyInstance) {
  // Auth middleware - require webhook secret for admin access
  fastify.addHook('preHandler', verifyWebhookSecret);

  /**
   * GET /api/admin/settings
   * Get all settings with their current values and metadata
   */
  fastify.get('/api/admin/settings', async (request: FastifyRequest, reply: FastifyReply) => {
    const requestId = request.id;
    logger.info({ requestId }, 'Fetching all settings');

    try {
      // Get all stored settings
      const storedSettings = await prisma.systemSetting.findMany();
      const storedMap = new Map(storedSettings.map(s => [s.id, s]));

      // Build response with all settings including defaults
      const settings = await Promise.all(
        Object.entries(SETTING_DEFINITIONS).map(async ([key, definition]) => {
          const stored = storedMap.get(key);
          const currentValue = stored
            ? JSON.parse(stored.value)
            : definition.defaultValue;

          return {
            key,
            value: currentValue,
            ...definition,
            isDefault: !stored,
            updatedAt: stored?.updatedAt || null,
            updatedBy: stored?.updatedBy || null,
          };
        })
      );

      // Group by category
      const grouped = settings.reduce((acc, setting) => {
        if (!acc[setting.category]) {
          acc[setting.category] = [];
        }
        acc[setting.category].push(setting);
        return acc;
      }, {} as Record<string, typeof settings>);

      return reply.send({
        success: true,
        data: {
          settings,
          grouped,
          categories: [...new Set(Object.values(SETTING_DEFINITIONS).map(d => d.category))],
        },
      });
    } catch (err) {
      logger.error({ err, requestId }, 'Failed to fetch settings');
      return reply.status(500).send({
        success: false,
        error: 'Failed to fetch settings',
      });
    }
  });

  /**
   * GET /api/admin/settings/:key
   * Get a single setting by key
   */
  fastify.get<{ Params: { key: string } }>(
    '/api/admin/settings/:key',
    async (request: FastifyRequest<{ Params: { key: string } }>, reply: FastifyReply) => {
      const { key } = request.params;
      const requestId = request.id;

      const definition = SETTING_DEFINITIONS[key as SettingKey];
      if (!definition) {
        return reply.status(404).send({
          success: false,
          error: 'Setting not found',
        });
      }

      try {
        const stored = await prisma.systemSetting.findUnique({
          where: { id: key },
        });

        const currentValue = stored
          ? JSON.parse(stored.value)
          : definition.defaultValue;

        return reply.send({
          success: true,
          data: {
            key,
            value: currentValue,
            ...definition,
            isDefault: !stored,
            updatedAt: stored?.updatedAt || null,
            updatedBy: stored?.updatedBy || null,
          },
        });
      } catch (err) {
        logger.error({ err, requestId, key }, 'Failed to fetch setting');
        return reply.status(500).send({
          success: false,
          error: 'Failed to fetch setting',
        });
      }
    }
  );

  /**
   * PUT /api/admin/settings/:key
   * Update a single setting
   */
  fastify.put<{ Params: { key: string } }>(
    '/api/admin/settings/:key',
    {
      config: {
        rateLimit: {
          max: RATE_LIMITS.ADMIN_MUTATIONS.max,
          timeWindow: RATE_LIMITS.ADMIN_MUTATIONS.timeWindowMs,
        },
      },
    },
    async (request: FastifyRequest<{ Params: { key: string } }>, reply: FastifyReply) => {
      const { key } = request.params;
      const requestId = request.id;

      const definition = SETTING_DEFINITIONS[key as SettingKey];
      if (!definition) {
        return reply.status(404).send({
          success: false,
          error: 'Setting not found',
        });
      }

      const validation = updateSettingSchema.safeParse(request.body);
      if (!validation.success) {
        return reply.status(400).send({
          success: false,
          error: 'Invalid request body',
          details: validation.error.errors,
        });
      }

      const { value, adminId } = validation.data;

      // Validate value type and range
      if (definition.valueType === 'number') {
        const numValue = Number(value);
        if (isNaN(numValue)) {
          return reply.status(400).send({
            success: false,
            error: 'Value must be a number',
          });
        }
        if (definition.minValue !== undefined && numValue < definition.minValue) {
          return reply.status(400).send({
            success: false,
            error: `Value must be at least ${definition.minValue}`,
          });
        }
        if (definition.maxValue !== undefined && numValue > definition.maxValue) {
          return reply.status(400).send({
            success: false,
            error: `Value must be at most ${definition.maxValue}`,
          });
        }
      }

      // Validate allowedValues for string settings with restricted options
      if (definition.valueType === 'string' && definition.allowedValues) {
        const strValue = String(value);
        if (!definition.allowedValues.includes(strValue)) {
          return reply.status(400).send({
            success: false,
            error: `Value must be one of: ${definition.allowedValues.join(', ')}`,
          });
        }
      }

      try {
        // Invalidate both in-memory and Redis cache BEFORE write
        memoryCacheInvalidate(key);
        await cacheManager.delete(`${SETTINGS_CACHE_PREFIX}${key}`);

        const setting = await prisma.systemSetting.upsert({
          where: { id: key },
          create: {
            id: key,
            value: JSON.stringify(value),
            category: definition.category,
            label: definition.label,
            description: definition.description || null,
            valueType: definition.valueType,
            minValue: definition.minValue || null,
            maxValue: definition.maxValue || null,
            defaultValue: JSON.stringify(definition.defaultValue),
            updatedBy: adminId,
          },
          update: {
            value: JSON.stringify(value),
            updatedBy: adminId,
          },
        });

        // Double-invalidate after write to ensure consistency
        memoryCacheInvalidate(key);
        await cacheManager.delete(`${SETTINGS_CACHE_PREFIX}${key}`);

        logger.info({ requestId, key, value, adminId }, 'Setting updated');

        return reply.send({
          success: true,
          data: {
            key,
            value,
            updatedAt: setting.updatedAt,
            updatedBy: setting.updatedBy,
          },
        });
      } catch (err) {
        logger.error({ err, requestId, key }, 'Failed to update setting');
        return reply.status(500).send({
          success: false,
          error: 'Failed to update setting',
        });
      }
    }
  );

  /**
   * PUT /api/admin/settings
   * Bulk update multiple settings
   */
  fastify.put(
    '/api/admin/settings',
    {
      config: {
        rateLimit: {
          max: RATE_LIMITS.ADMIN_MUTATIONS.max,
          timeWindow: RATE_LIMITS.ADMIN_MUTATIONS.timeWindowMs,
        },
      },
    },
    async (request: FastifyRequest, reply: FastifyReply) => {
      const requestId = request.id;

      const validation = bulkUpdateSchema.safeParse(request.body);
      if (!validation.success) {
        return reply.status(400).send({
          success: false,
          error: 'Invalid request body',
          details: validation.error.errors,
        });
      }

      const { settings, adminId } = validation.data;

      // Validate all settings first
      const errors: Array<{ key: string; error: string }> = [];
      for (const { key, value } of settings) {
        const definition = SETTING_DEFINITIONS[key as SettingKey];
        if (!definition) {
          errors.push({ key, error: 'Unknown setting' });
          continue;
        }

        if (definition.valueType === 'number') {
          const numValue = Number(value);
          if (isNaN(numValue)) {
            errors.push({ key, error: 'Value must be a number' });
          } else if (definition.minValue !== undefined && numValue < definition.minValue) {
            errors.push({ key, error: `Value must be at least ${definition.minValue}` });
          } else if (definition.maxValue !== undefined && numValue > definition.maxValue) {
            errors.push({ key, error: `Value must be at most ${definition.maxValue}` });
          }
        }

        // Validate allowedValues for string settings with restricted options
        if (definition.valueType === 'string' && definition.allowedValues) {
          const strValue = String(value);
          if (!definition.allowedValues.includes(strValue)) {
            errors.push({ key, error: `Value must be one of: ${definition.allowedValues.join(', ')}` });
          }
        }
      }

      if (errors.length > 0) {
        return reply.status(400).send({
          success: false,
          error: 'Validation failed',
          details: errors,
        });
      }

      try {
        // Invalidate in-memory cache for all keys
        for (const { key } of settings) memoryCacheInvalidate(key);

        // RACE CONDITION FIX: Invalidate Redis cache BEFORE write
        const preInvalidationResults = await Promise.allSettled(
          settings.map(({ key }) => cacheManager.delete(`${SETTINGS_CACHE_PREFIX}${key}`))
        );
        const preInvalidationFailures = preInvalidationResults.filter(r => r.status === 'rejected');
        if (preInvalidationFailures.length > 0) {
          logger.warn(
            { requestId, failures: preInvalidationFailures.length, total: settings.length },
            'Some cache pre-invalidations failed during bulk update'
          );
        }

        // Update all settings in a transaction
        const updated = await prisma.$transaction(
          settings.map(({ key, value }) => {
            const definition = SETTING_DEFINITIONS[key as SettingKey];
            return prisma.systemSetting.upsert({
              where: { id: key },
              create: {
                id: key,
                value: JSON.stringify(value),
                category: definition.category,
                label: definition.label,
                description: definition.description || null,
                valueType: definition.valueType,
                minValue: definition.minValue || null,
                maxValue: definition.maxValue || null,
                defaultValue: JSON.stringify(definition.defaultValue),
                updatedBy: adminId,
              },
              update: {
                value: JSON.stringify(value),
                updatedBy: adminId,
              },
            });
          })
        );

        // Double-invalidate after write
        for (const { key } of settings) memoryCacheInvalidate(key);
        const postInvalidationResults = await Promise.allSettled(
          settings.map(({ key }) => cacheManager.delete(`${SETTINGS_CACHE_PREFIX}${key}`))
        );
        const postInvalidationFailures = postInvalidationResults.filter(r => r.status === 'rejected');
        if (postInvalidationFailures.length > 0) {
          logger.warn(
            { requestId, failures: postInvalidationFailures.length, total: settings.length },
            'Some cache post-invalidations failed during bulk update'
          );
        }

        logger.info({ requestId, settingsCount: settings.length, adminId }, 'Bulk settings update');

        return reply.send({
          success: true,
          data: {
            updated: updated.length,
            settings: updated.map(s => ({
              key: s.id,
              value: JSON.parse(s.value),
              updatedAt: s.updatedAt,
            })),
          },
        });
      } catch (err) {
        logger.error({ err, requestId }, 'Failed to bulk update settings');
        return reply.status(500).send({
          success: false,
          error: 'Failed to update settings',
        });
      }
    }
  );

  /**
   * POST /api/admin/settings/:key/reset
   * Reset a setting to its default value
   */
  fastify.post<{ Params: { key: string } }>(
    '/api/admin/settings/:key/reset',
    {
      config: {
        rateLimit: {
          max: RATE_LIMITS.ADMIN_MUTATIONS.max,
          timeWindow: RATE_LIMITS.ADMIN_MUTATIONS.timeWindowMs,
        },
      },
    },
    async (request: FastifyRequest<{ Params: { key: string } }>, reply: FastifyReply) => {
      const { key } = request.params;
      const requestId = request.id;

      const definition = SETTING_DEFINITIONS[key as SettingKey];
      if (!definition) {
        return reply.status(404).send({
          success: false,
          error: 'Setting not found',
        });
      }

      try {
        // Invalidate both caches before delete
        memoryCacheInvalidate(key);
        await cacheManager.delete(`${SETTINGS_CACHE_PREFIX}${key}`);

        // Delete the custom setting (reverts to default)
        await prisma.systemSetting.delete({
          where: { id: key },
        }).catch(() => {
          // Ignore if doesn't exist
        });

        // Double-invalidate after delete
        memoryCacheInvalidate(key);
        await cacheManager.delete(`${SETTINGS_CACHE_PREFIX}${key}`);

        logger.info({ requestId, key, defaultValue: definition.defaultValue }, 'Setting reset to default');

        return reply.send({
          success: true,
          data: {
            key,
            value: definition.defaultValue,
            isDefault: true,
          },
        });
      } catch (err) {
        logger.error({ err, requestId, key }, 'Failed to reset setting');
        return reply.status(500).send({
          success: false,
          error: 'Failed to reset setting',
        });
      }
    }
  );

  // ==========================================
  // Admin Alert Endpoints (FIX TODO)
  // ==========================================

  /**
   * GET /api/admin/alerts
   * Get all unacknowledged alerts for admin dashboard
   */
  fastify.get('/api/admin/alerts', async (request: FastifyRequest, reply: FastifyReply) => {
    const requestId = request.id;
    logger.info({ requestId }, 'Fetching admin alerts');

    try {
      const alerts = await adminNotificationService.getUnacknowledgedAlerts();
      return reply.send({
        success: true,
        alerts,
        count: alerts.length,
      });
    } catch (error) {
      logger.error({ requestId, error }, 'Failed to get admin alerts');
      return reply.status(500).send({
        success: false,
        error: 'Failed to get alerts',
      });
    }
  });

  /**
   * GET /api/admin/alerts/count
   * Get count of unacknowledged alerts (for dashboard badge)
   */
  fastify.get('/api/admin/alerts/count', async (request: FastifyRequest, reply: FastifyReply) => {
    const requestId = request.id;

    try {
      const count = await adminNotificationService.getAlertCount();
      return reply.send({
        success: true,
        count,
      });
    } catch (error) {
      logger.error({ requestId, error }, 'Failed to get alert count');
      return reply.status(500).send({
        success: false,
        error: 'Failed to get alert count',
      });
    }
  });

  /**
   * POST /api/admin/alerts/:id/acknowledge
   * Acknowledge a specific alert
   */
  fastify.post<{
    Params: { id: string };
  }>('/api/admin/alerts/:id/acknowledge', async (request, reply) => {
    const requestId = request.id;
    const alertId = request.params.id;

    logger.info({ requestId, alertId }, 'Acknowledging admin alert');

    try {
      await adminNotificationService.acknowledgeAlert(alertId);
      return reply.send({
        success: true,
        message: 'Alert acknowledged',
      });
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : 'Unknown error';
      logger.error({ requestId, alertId, error: errorMessage }, 'Failed to acknowledge alert');
      return reply.status(400).send({
        success: false,
        error: errorMessage,
      });
    }
  });

  /**
   * POST /api/admin/alerts/acknowledge-all
   * Acknowledge all alerts of a specific type
   */
  fastify.post<{
    Body: { type: 'thread_divergence' | 'conversation_stall' | 'tool_failure' | 'therapist_alert' };
  }>('/api/admin/alerts/acknowledge-all', async (request, reply) => {
    const requestId = request.id;
    const { type } = request.body || {};

    if (!type) {
      return reply.status(400).send({
        success: false,
        error: 'Missing required field: type',
      });
    }

    logger.info({ requestId, type }, 'Acknowledging all alerts of type');

    try {
      const count = await adminNotificationService.acknowledgeAllByType(type);
      return reply.send({
        success: true,
        message: `Acknowledged ${count} alerts`,
        count,
      });
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : 'Unknown error';
      logger.error({ requestId, type, error: errorMessage }, 'Failed to acknowledge alerts');
      return reply.status(400).send({
        success: false,
        error: errorMessage,
      });
    }
  });

  // ==========================================
  // Health Status Endpoints
  // ==========================================

  /**
   * GET /api/admin/health
   * Get health status for all active conversations
   * Returns green/yellow/red status based on activity, progress, and issues
   */
  fastify.get('/api/admin/health', async (request: FastifyRequest, reply: FastifyReply) => {
    const requestId = request.id;
    logger.info({ requestId }, 'Fetching conversation health statuses');

    try {
      const healthData = await adminNotificationService.getConversationHealthStatuses();
      return reply.send({
        success: true,
        ...healthData,
      });
    } catch (error) {
      logger.error({ requestId, error }, 'Failed to get health statuses');
      return reply.status(500).send({
        success: false,
        error: 'Failed to get health statuses',
      });
    }
  });

  /**
   * GET /api/admin/health/:appointmentId
   * Get health status for a specific appointment
   */
  fastify.get<{
    Params: { appointmentId: string };
  }>('/api/admin/health/:appointmentId', async (request, reply) => {
    const requestId = request.id;
    const { appointmentId } = request.params;

    logger.info({ requestId, appointmentId }, 'Fetching appointment health status');

    try {
      const health = await adminNotificationService.getAppointmentHealth(appointmentId);

      if (!health) {
        return reply.status(404).send({
          success: false,
          error: 'Appointment not found',
        });
      }

      return reply.send({
        success: true,
        appointmentId,
        health,
      });
    } catch (error) {
      logger.error({ requestId, appointmentId, error }, 'Failed to get appointment health');
      return reply.status(500).send({
        success: false,
        error: 'Failed to get health status',
      });
    }
  });

  /**
   * GET /api/admin/dashboard/overview
   * Get combined dashboard data: alerts + health overview
   * Provides a unified view for the admin dashboard
   */
  fastify.get('/api/admin/dashboard/overview', async (request: FastifyRequest, reply: FastifyReply) => {
    const requestId = request.id;
    logger.info({ requestId }, 'Fetching dashboard overview');

    try {
      const overview = await adminNotificationService.getDashboardOverview();
      return reply.send({
        success: true,
        ...overview,
      });
    } catch (error) {
      logger.error({ requestId, error }, 'Failed to get dashboard overview');
      return reply.status(500).send({
        success: false,
        error: 'Failed to get dashboard overview',
      });
    }
  });
}

/**
 * Public settings routes - no authentication required
 * Only exposes frontend category settings
 */
export async function publicSettingsRoutes(fastify: FastifyInstance) {
  /**
   * GET /api/settings/frontend
   * Get all frontend settings (public, no auth required)
   */
  fastify.get(
    '/api/settings/frontend',
    {
      config: {
        rateLimit: {
          max: RATE_LIMITS.PUBLIC_THERAPIST_LIST.max,
          timeWindow: RATE_LIMITS.PUBLIC_THERAPIST_LIST.timeWindowMs,
        },
      },
    },
    async (request: FastifyRequest, reply: FastifyReply) => {
      const requestId = request.id;
      logger.debug({ requestId }, 'Fetching public frontend settings');

      try {
        // Get only frontend category settings
        const frontendSettings = await getCategorySettings('frontend');

        return reply.send({
          success: true,
          data: frontendSettings,
        });
      } catch (err) {
        logger.error({ err, requestId }, 'Failed to fetch frontend settings');
        return reply.status(500).send({
          success: false,
          error: 'Failed to fetch settings',
        });
      }
    }
  );

  /**
   * GET /api/settings/frontend/:key
   * Get a specific frontend setting (public, no auth required)
   */
  fastify.get<{ Params: { key: string } }>(
    '/api/settings/frontend/:key',
    {
      config: {
        rateLimit: {
          max: RATE_LIMITS.PUBLIC_THERAPIST_LIST.max,
          timeWindow: RATE_LIMITS.PUBLIC_THERAPIST_LIST.timeWindowMs,
        },
      },
    },
    async (request: FastifyRequest<{ Params: { key: string } }>, reply: FastifyReply) => {
      const { key } = request.params;
      const fullKey = `frontend.${key}`;
      const requestId = request.id;

      const definition = SETTING_DEFINITIONS[fullKey as SettingKey];

      // Only allow access to frontend category settings
      if (!definition || definition.category !== 'frontend') {
        return reply.status(404).send({
          success: false,
          error: 'Setting not found',
        });
      }

      try {
        const value = await getSettingValue(fullKey as SettingKey);

        return reply.send({
          success: true,
          data: {
            key: fullKey,
            value,
          },
        });
      } catch (err) {
        logger.error({ err, requestId, key: fullKey }, 'Failed to fetch frontend setting');
        return reply.status(500).send({
          success: false,
          error: 'Failed to fetch setting',
        });
      }
    }
  );
}
