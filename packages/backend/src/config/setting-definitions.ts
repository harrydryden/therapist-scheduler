/**
 * Setting Definitions — Single source of truth for all admin-configurable settings.
 *
 * Extracted from settings.service.ts to separate metadata from caching/retrieval logic.
 * Each setting definition includes its category, label, description, type, constraints,
 * and default value. The defaults reference centralized constants.
 */

import {
  INACTIVITY_THRESHOLDS,
  POST_BOOKING,
  CONVERSATION_LIMITS,
  CLAUDE_API,
  DATA_RETENTION,
  APP_DEFAULTS,
  STALL_DETECTION,
  CHASE_FOLLOWUP,
  STALE_THRESHOLDS,
  THERAPIST_BOOKING,
  EMAIL,
} from '../constants';

export interface SettingDefinition {
  category: string;
  label: string;
  description: string;
  valueType: 'number' | 'string' | 'boolean';
  minValue?: number;
  maxValue?: number;
  defaultValue: number | string | boolean;
  allowedValues?: string[];
}

export const SETTING_DEFINITIONS: Record<string, SettingDefinition> = {
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
  'postBooking.feedbackFormUrl': {
    category: 'postBooking',
    label: 'Feedback Form URL (fallback)',
    description: 'Fallback URL for the feedback form when no tracking code is available. Used only for legacy appointments without tracking codes.',
    valueType: 'string',
    defaultValue: '',
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
  'agent.toneStyle': {
    category: 'agent',
    label: 'Tone Style',
    description: 'The overall tone Justin uses in emails. Controls formality, warmth, and communication style.',
    valueType: 'string',
    defaultValue: 'warm-casual',
    allowedValues: ['formal', 'warm-casual', 'friendly'],
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
    maxValue: 730,
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
  'general.staleThresholdHours': {
    category: 'general',
    label: 'Stale Threshold (hours)',
    description: 'Mark conversations as stale after this many hours of inactivity. Used for the visual stale indicator and health scoring.',
    valueType: 'number',
    minValue: 12,
    maxValue: 168,
    defaultValue: STALE_THRESHOLDS.MARK_STALE_HOURS,
  },
  'general.minBookingLeadHours': {
    category: 'general',
    label: 'Minimum Booking Lead Time (hours)',
    description: 'Minimum hours in advance that an appointment can be booked. Slots sooner than this are excluded.',
    valueType: 'number',
    minValue: 1,
    maxValue: 48,
    defaultValue: 4,
  },
  'general.maxBookingRequestsPerTherapist': {
    category: 'general',
    label: 'Max Active Requests Per Therapist',
    description: 'Maximum active booking requests a therapist can have before being frozen (no new bookings accepted).',
    valueType: 'number',
    minValue: 1,
    maxValue: 10,
    defaultValue: THERAPIST_BOOKING.MAX_UNIQUE_REQUESTS,
  },

  // Agent identity and behaviour
  'agent.fromName': {
    category: 'agent',
    label: 'Agent Display Name',
    description: 'The name used in email signatures and the From field. Appears as the sender name in all outgoing emails.',
    valueType: 'string',
    defaultValue: EMAIL.FROM_NAME,
  },
  'agent.sessionDurationMinutes': {
    category: 'agent',
    label: 'Session Duration (minutes)',
    description: 'Default therapy session duration in minutes. Used in email templates and scheduling instructions.',
    valueType: 'number',
    minValue: 15,
    maxValue: 180,
    defaultValue: 50,
  },
  'agent.maxSlotsPerGroup': {
    category: 'agent',
    label: 'Max Slots Per Group',
    description: 'Maximum number of time slots to show per week group (This Week, Next Week, etc.) to reduce decision fatigue.',
    valueType: 'number',
    minValue: 3,
    maxValue: 20,
    defaultValue: 6,
  },
  'agent.maxTotalSlots': {
    category: 'agent',
    label: 'Max Total Slots',
    description: 'Maximum total time slots to present to the user across all week groups.',
    valueType: 'number',
    minValue: 6,
    maxValue: 50,
    defaultValue: 12,
  },

  // === EMAIL DATE FORMAT ===
  'email.use24HourTime': {
    category: 'emailTemplates',
    label: 'Use 24-Hour Clock in Emails',
    description: 'When enabled, times in emails display as 14:30 instead of 2:30pm',
    valueType: 'boolean',
    defaultValue: true,
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
  'email.therapistFeedbackNotificationSubject': {
    category: 'emailTemplates',
    label: 'Therapist Feedback Notification - Subject',
    description: 'Subject line for post-session notification to therapist. Variables: {therapistFirstName}, {clientFirstName}',
    valueType: 'string',
    defaultValue: 'Spill - Session with {clientFirstName} complete',
  },
  'email.therapistFeedbackNotificationBody': {
    category: 'emailTemplates',
    label: 'Therapist Feedback Notification - Body',
    description: 'Email body for post-session notification to therapist with invoicing details. Variables: {therapistFirstName}, {clientFirstName}',
    valueType: 'string',
    defaultValue: `Hi {therapistFirstName}

I hope your session with {clientFirstName} went well.
That is the end of the Spill recruitment process. We will reach out to you in the next few days with an update.

In the meantime, please do invoice us for the session.

Invoice amount: £40
Email invoices to: accounts@spill.chat
Address invoices to:
Spill App Limited
9th Floor 107 Cheapside,
London,
United Kingdom,
EC2V 6DN`,
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
    description: 'First email to therapist when availability is already on file. Variables: {therapistFirstName}, {clientFirstName}, {userEmail}',
    valueType: 'string',
    defaultValue: `Hi {therapistFirstName},

I have a new client, {clientFirstName} ({userEmail}), who would like to book a 50-minute therapy session with you.

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
    description: 'First email to therapist asking for availability. Variables: {therapistFirstName}, {clientFirstName}, {userEmail}',
    valueType: 'string',
    defaultValue: `Hi {therapistFirstName},

I have a new client, {clientFirstName} ({userEmail}), who would like to book a 50-minute therapy session with you.

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
    description: 'Email asking therapist to confirm client-selected time. Variables: {therapistFirstName}, {clientFirstName}, {selectedDateTime}, {userEmail}',
    valueType: 'string',
    defaultValue: `Hi {therapistFirstName},

Great news! {clientFirstName} has selected a time for their 50-minute session:

**{selectedDateTime}**

Can you confirm this time still works for you? Once confirmed, please send {clientFirstName} the meeting link and any pre-session information at {userEmail}.

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
    defaultValue: 1,
  },
  'weeklyMailing.sendHour': {
    category: 'weeklyMailing',
    label: 'Send Hour (24h format)',
    description: 'Hour of the day to send weekly emails (0-23 in configured timezone)',
    valueType: 'number',
    minValue: 0,
    maxValue: 23,
    defaultValue: 9,
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
    defaultValue: 'Your weekly therapy update',
  },
  'email.weeklyMailingBody': {
    category: 'emailTemplates',
    label: 'Weekly Mailing - Body',
    description: 'Email body for weekly promotional email. Variables: {userName}, {newTherapistsSection}, {voucherSection}, {webAppUrl}, {unsubscribeUrl}. Supports markdown links: [text](url)',
    valueType: 'string',
    defaultValue: `Hi {userName},

Here's your weekly update from Spill.
{newTherapistsSection}
{voucherSection}

[Book your free session]({webAppUrl})

Our only ask is that you complete a short feedback form after the session.

Best wishes,

Justin

---
You're receiving this because you've indicated you are interested in free therapy. [Unsubscribe from these reminders]({unsubscribeUrl}).`,
  },

  // === CHASE FOLLOW-UP EMAIL TEMPLATES ===
  'email.chaseUserSubject': {
    category: 'emailTemplates',
    label: 'Chase User - Subject',
    description: 'Subject line for follow-up to unresponsive user. Variables: {therapistName}',
    valueType: 'string',
    defaultValue: 'Spill - Are you still looking to book with {therapistName}?',
  },
  'email.chaseUserBody': {
    category: 'emailTemplates',
    label: 'Chase User - Body',
    description: 'Email body for follow-up chase to unresponsive user. Variables: {userName}, {therapistName}',
    valueType: 'string',
    defaultValue: `Hi {userName},

I just wanted to check in - are you still interested in booking a session with {therapistName}?

If your circumstances have changed or you'd prefer a different therapist, just let me know and I can help.

If I don't hear back I'll close this request, but you're always welcome to book again at any time.

Best wishes,

Justin`,
  },
  'email.chaseTherapistSubject': {
    category: 'emailTemplates',
    label: 'Chase Therapist - Subject',
    description: 'Subject line for follow-up to unresponsive therapist. Variables: {clientFirstName}',
    valueType: 'string',
    defaultValue: 'Spill - Following up on scheduling with {clientFirstName}',
  },
  'email.chaseTherapistBody': {
    category: 'emailTemplates',
    label: 'Chase Therapist - Body',
    description: 'Email body for follow-up chase to unresponsive therapist. Variables: {therapistFirstName}, {clientFirstName}',
    valueType: 'string',
    defaultValue: `Hi {therapistFirstName},

Just following up on the session request from {clientFirstName}. Are you still able to see them?

If you could share your availability or let me know if anything has changed, that would be great.

Best wishes,

Justin`,
  },

  // === CHASE FOLLOW-UP SETTINGS ===
  'chase.afterStaleHours': {
    category: 'notifications',
    label: 'Chase After Stale (hours)',
    description: 'Send a follow-up chase email to the non-responding party after this many hours of inactivity',
    valueType: 'number',
    minValue: 24,
    maxValue: 336,
    defaultValue: CHASE_FOLLOWUP.CHASE_AFTER_STALE_HOURS,
  },
  'chase.closureRecommendationHours': {
    category: 'notifications',
    label: 'Closure Recommendation (hours)',
    description: 'Recommend admin close the thread if no response after this many hours post-chase',
    valueType: 'number',
    minValue: 24,
    maxValue: 336,
    defaultValue: CHASE_FOLLOWUP.CLOSURE_RECOMMENDATION_HOURS,
  },
  'chase.enabled': {
    category: 'notifications',
    label: 'Enable Chase Follow-ups',
    description: 'Enable automatic chase emails to unresponsive users/therapists',
    valueType: 'boolean',
    defaultValue: true,
  },
  'chase.autoCompleteFeedback': {
    category: 'notifications',
    label: 'Auto-Complete Unanswered Feedback',
    description: 'Automatically mark feedback_requested appointments as completed if no feedback received after the reminder goes unanswered',
    valueType: 'boolean',
    defaultValue: true,
  },
  'chase.maxChaseBatchSize': {
    category: 'notifications',
    label: 'Max Chase Batch Size',
    description: 'Maximum conversations to send chase follow-up emails to per cycle (prevents email rate limiting)',
    valueType: 'number',
    minValue: 1,
    maxValue: 50,
    defaultValue: CHASE_FOLLOWUP.MAX_CHASE_BATCH_SIZE,
  },
  'chase.maxClosureBatchSize': {
    category: 'notifications',
    label: 'Max Closure Batch Size',
    description: 'Maximum conversations to recommend for closure per cycle',
    valueType: 'number',
    minValue: 1,
    maxValue: 100,
    defaultValue: CHASE_FOLLOWUP.MAX_CLOSURE_BATCH_SIZE,
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
  'notifications.email.therapistFeedbackNotification': {
    category: 'notifications',
    label: 'Email: Therapist Feedback Notification',
    description: 'Send post-session notification to therapist with invoicing details when feedback form is sent to user',
    valueType: 'boolean',
    defaultValue: true,
  },
  'notifications.email.clientCancellation': {
    category: 'notifications',
    label: 'Email: Client Cancellation',
    description: 'Send cancellation notification email to the client when an appointment is cancelled',
    valueType: 'boolean',
    defaultValue: true,
  },
  'notifications.email.therapistCancellation': {
    category: 'notifications',
    label: 'Email: Therapist Cancellation',
    description: 'Send cancellation notification email to the therapist when an appointment is cancelled',
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
    maxValue: 336,
    defaultValue: INACTIVITY_THRESHOLDS.ALERT_HOURS,
  },

  // Stall detection (activity but no progress)
  'notifications.stallDetectionHours': {
    category: 'notifications',
    label: 'Stall Detection (hours)',
    description: 'Flag conversation as stalled if no tool execution despite activity for this long (auto-escalates to human control)',
    valueType: 'number',
    minValue: 12,
    maxValue: 168,
    defaultValue: STALL_DETECTION.STALL_THRESHOLD_HOURS,
  },

  // === VOUCHER SYSTEM ===
  'voucher.enabled': {
    category: 'weeklyMailing',
    label: 'Enable Voucher Codes',
    description: 'Enable expiring voucher codes in weekly promotional emails. When enabled, each email includes a personal code valid for 14 days.',
    valueType: 'boolean',
    defaultValue: false,
  },
  'voucher.expiryDays': {
    category: 'weeklyMailing',
    label: 'Voucher Expiry (days)',
    description: 'Number of days each voucher code is valid for',
    valueType: 'number',
    minValue: 7,
    maxValue: 30,
    defaultValue: 14,
  },
  'voucher.maxStrikes': {
    category: 'weeklyMailing',
    label: 'Max Expired Vouchers Before Unsubscribe',
    description: 'Auto-unsubscribe users from mailing list after this many consecutive expired (unused) voucher codes',
    valueType: 'number',
    minValue: 1,
    maxValue: 10,
    defaultValue: 3,
  },
  'voucher.required': {
    category: 'weeklyMailing',
    label: 'Require Voucher to Book',
    description: 'If enabled, users must have a valid voucher code to submit a booking request. Users without a code see a message directing them to check their email.',
    valueType: 'boolean',
    defaultValue: true,
  },

  // === VOUCHER EMAIL TEMPLATES ===
  // Voucher reminders are now part of the unified weekly email body
  // (see email.weeklyMailingBody / {voucherSection}).
  'email.voucherFinalNoticeSubject': {
    category: 'emailTemplates',
    label: 'Voucher Final Notice - Subject',
    description: 'Subject line for final notice before auto-unsubscribe. Variables: {userName}',
    valueType: 'string',
    defaultValue: 'We\'re freeing up your therapy spot',
  },
  'email.voucherFinalNoticeBody': {
    category: 'emailTemplates',
    label: 'Voucher Final Notice - Body',
    description: 'Email body sent when user is auto-unsubscribed after consecutive expired vouchers. Variables: {userName}, {unsubscribeUrl}',
    valueType: 'string',
    defaultValue: `Hi {userName},

We've noticed you haven't used your session codes recently, so we're freeing up your spot for someone else.

If you'd like to start receiving session codes again, just reply to this email and we'll re-subscribe you.

Best wishes,

Justin`,
  },

  // === THERAPIST NUDGE SETTINGS ===
  'therapistNudge.enabled': {
    category: 'therapistNudge',
    label: 'Enable Therapist Nudge Emails',
    description: 'When enabled, sends periodic emails to active therapists who have not yet been matched with a client, to let them know we are still looking.',
    valueType: 'boolean',
    defaultValue: true,
  },
  'therapistNudge.intervalWeeks': {
    category: 'therapistNudge',
    label: 'Nudge Interval (weeks)',
    description: 'How often (in weeks) to send a nudge email to unmatched therapists. Measured from the later of their ingestion date or last nudge.',
    valueType: 'number',
    minValue: 1,
    maxValue: 12,
    defaultValue: 2,
  },
  'email.therapistNudgeSubject': {
    category: 'emailTemplates',
    label: 'Therapist Nudge - Subject',
    description: 'Subject line for the periodic nudge email sent to unmatched therapists. Variables: {therapistFirstName}',
    valueType: 'string',
    defaultValue: 'Spill update - still finding you a client',
  },
  'email.therapistNudgeBody': {
    category: 'emailTemplates',
    label: 'Therapist Nudge - Body',
    description: 'Email body for the periodic nudge email sent to unmatched therapists. Variables: {therapistFirstName}, {agentFirstName}',
    valueType: 'string',
    defaultValue: `Hi {therapistFirstName},

Just a quick note to let you know we haven't forgotten about you! We're still actively looking for a client to match with you for a session.

We really appreciate your patience — as soon as we have someone, we'll be in touch to get things booked in.

Best wishes

{agentFirstName}`,
  },

  // === SIGNUP INVITATIONS ===
  'invitation.expiryDays': {
    category: 'general',
    label: 'Invitation Expiry (days)',
    description: 'How long an invitation link stays valid before passively expiring.',
    valueType: 'number',
    minValue: 1,
    maxValue: 90,
    defaultValue: 30,
  },
  'invitation.reminderDaysBefore': {
    category: 'general',
    label: 'Invitation Reminder (days before expiry)',
    description: 'Send a pre-expiry reminder this many days before the invitation expires. Set to 0 to disable reminders. Each invitation gets at most one reminder.',
    valueType: 'number',
    minValue: 0,
    maxValue: 30,
    defaultValue: 3,
  },
  'invitation.archiveAfterDays': {
    category: 'general',
    label: 'Invitation Archive Lookback (days)',
    description: 'Archive expired or revoked invitations older than this many days. Accepted invitations are kept indefinitely. Archived rows stay in the database for audit but disappear from the default admin listing.',
    valueType: 'number',
    minValue: 30,
    maxValue: 365,
    defaultValue: 90,
  },
  'email.invitationReminderSubject': {
    category: 'emailTemplates',
    label: 'Signup Invitation Reminder - Subject',
    description: 'Subject line for the pre-expiry reminder email. Variables: {recipientName}, {daysRemaining}',
    valueType: 'string',
    defaultValue: 'Your Spill therapy invitation expires in {daysRemaining} days',
  },
  'email.invitationReminderBody': {
    category: 'emailTemplates',
    label: 'Signup Invitation Reminder - Body',
    description: 'Email body for the pre-expiry reminder. Variables: {recipientName}, {daysRemaining}, {expiryDate}. The link itself is not included because the raw token is not retrievable; the reminder asks the recipient to use the original email.',
    valueType: 'string',
    defaultValue: `Hi {recipientName},

Just a quick reminder: your invitation to book a free therapy session at Spill expires on {expiryDate} ({daysRemaining} days from now).

Use the original email we sent you to complete signup before then. If you can't find it, reply to this message and we'll re-issue.`,
  },
  'email.invitationSubject': {
    category: 'emailTemplates',
    label: 'Signup Invitation - Subject',
    description: 'Subject line for invitation emails. Variables: {recipientName}',
    valueType: 'string',
    defaultValue: 'You\'re invited to a free therapy session at Spill',
  },
  'email.invitationBody': {
    category: 'emailTemplates',
    label: 'Signup Invitation - Body',
    description: 'Email body for invitation emails. Variables: {recipientName}, {invitationUrl}, {expiryDate}. Supports markdown links.',
    valueType: 'string',
    defaultValue: `Hi {recipientName},

As Spill continues to grow, our top priority is maintaining the quality of our therapy. We accept less than 5% of the counsellors who apply to work with us, and the most critical part of their evaluation is a live, real therapy session.

We are quietly opening up a free therapy platform specifically for this final stage, and we'd like to invite you to participate.

You would have access to free sessions with highly qualified, experienced therapists. In exchange, our only ask is that you complete a 5-minute feedback form afterward to help us determine if the counsellor meets Spill's standards.

[Complete signup]({invitationUrl})

This invitation expires on {expiryDate}.

Please note this is a private invitation for you and cannot be forwarded.`,
  },
  'email.welcomeBookingSubject': {
    category: 'emailTemplates',
    label: 'Welcome (post-signup) - Subject',
    description: 'Subject line for the welcome email sent immediately after signup, carrying the booking link with embedded voucher. Variables: {userName}',
    valueType: 'string',
    defaultValue: 'Welcome to Spill — book your first session',
  },
  'email.welcomeBookingBody': {
    category: 'emailTemplates',
    label: 'Welcome (post-signup) - Body',
    description: 'Email body sent immediately after signup, containing the booking URL with embedded voucher. Variables: {userName}, {voucherSection}, {webAppUrl}, {unsubscribeUrl}. {voucherSection} renders the same copy used in weekly mailings (single source of truth in utils/voucher-section.ts) — keeps voucher language coherent across welcome / weekly / reminder emails.',
    valueType: 'string',
    defaultValue: `Hi {userName},

Thanks for signing up to Spill.

{voucherSection}

[Book a session]({webAppUrl})

If you have any questions, just reply to this email.

Best wishes,
The Spill team`,
  },
};

export type SettingKey = keyof typeof SETTING_DEFINITIONS;
