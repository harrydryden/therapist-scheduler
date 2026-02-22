/**
 * Email Classification and Intent Detection
 *
 * Pre-processes incoming emails to:
 * - Classify intent (slot selection, rescheduling, cancellation, etc.)
 * - Detect sentiment (positive, frustrated, confused)
 * - Extract mentioned time slots
 * - Detect therapist confirmations
 *
 * This enables the agent to respond more accurately and
 * allows urgent/frustrated messages to trigger special handling.
 */

import { logger } from './logger';

export type EmailIntent =
  | 'slot_selection'      // User selecting a time slot
  | 'availability_question' // Asking about availability
  | 'reschedule_request'  // Wants to change time
  | 'cancellation'        // Wants to cancel
  | 'confirmation'        // Confirming something
  | 'meeting_link_issue'  // Problem with meeting link
  | 'general_question'    // General inquiry
  | 'off_topic'           // Unrelated to scheduling
  | 'urgent'              // Time-sensitive request
  | 'unknown';

export type EmailSentiment =
  | 'positive'            // Happy, grateful, excited
  | 'neutral'             // Standard, professional
  | 'frustrated'          // Annoyed, impatient
  | 'confused'            // Unclear, asking for clarification
  | 'urgent';             // Time pressure

export interface ExtractedSlot {
  raw: string;            // Original text: "Monday at 10am"
  dayOfWeek?: string;     // "Monday"
  time?: string;          // "10:00"
  date?: string;          // "February 10th" if mentioned
  isRange?: boolean;      // "Monday-Wednesday" or "10am-2pm"
}

export interface TherapistConfirmation {
  isConfirmed: boolean;
  confirmationType?: 'slot' | 'meeting_link' | 'booking';
  confirmedSlot?: string; // If they confirmed a specific slot
  willSendLink?: boolean; // If they said they'll send meeting link
}

export interface EmailClassification {
  intent: EmailIntent;
  confidence: number;     // 0-1 confidence score
  sentiment: EmailSentiment;
  extractedSlots: ExtractedSlot[];
  therapistConfirmation: TherapistConfirmation | null;
  isFromTherapist: boolean;
  urgencyLevel: 'low' | 'medium' | 'high';
  suggestedAction?: string; // Hint for the agent
  flags: {
    mentionsMultipleSlots: boolean;
    mentionsPreferences: boolean;
    mentionsConstraints: boolean;
    mentionsRescheduling: boolean;
    mentionsCancellation: boolean;
    isOutOfOffice: boolean;
  };
}

// Intent detection patterns
const INTENT_PATTERNS: Record<EmailIntent, RegExp[]> = {
  slot_selection: [
    /(?:i(?:'d| would) like|let(?:'s|s) (?:do|go with)|(?:can we do|how about))\s+(?:the\s+)?(\w+day|\d{1,2}(?:st|nd|rd|th)?)/i,
    /(?:works? for me|sounds? good|that(?:'s|s)? (?:fine|great|perfect))/i,
    /(?:please book|book me|schedule me)/i,
    /(\w+day)\s+(?:at\s+)?(\d{1,2}(?::\d{2})?(?:am|pm)?)/i,
    /(?:i(?:'ll| will) take|i choose|i(?:'d| would) prefer)/i,
  ],
  availability_question: [
    /(?:what|which)\s+(?:times?|slots?|days?)\s+(?:are|do you have)/i,
    /(?:are you|is \w+)\s+(?:available|free)/i,
    /(?:do you have)\s+(?:any|anything)\s+(?:available|open)/i,
    /(?:when can|what about|how about)/i,
  ],
  reschedule_request: [
    /(?:reschedule|change|move|postpone)\s+(?:the|my|our)?\s*(?:appointment|session|meeting)/i,
    /(?:something (?:came up|has come up)|can(?:'t|not) make (?:it|that time))/i,
    /(?:need to|have to)\s+(?:reschedule|change|move)/i,
    /(?:different|another|new)\s+(?:time|day|slot)/i,
  ],
  cancellation: [
    /(?:cancel|call off)\s+(?:the|my|our)?\s*(?:appointment|session|meeting|booking)/i,
    /(?:no longer|don(?:'t|t) want to|won(?:'t|t) be)\s+(?:need|able|proceeding)/i,
    /(?:please cancel|cancel please)/i,
  ],
  confirmation: [
    /(?:yes|yep|yeah|confirmed|correct|that(?:'s|s)? (?:right|correct))/i,
    /(?:sounds? good|perfect|great|wonderful|excellent)/i,
    /(?:see you|looking forward)/i,
    /(?:booked|confirmed|all set)/i,
  ],
  meeting_link_issue: [
    /(?:meeting|video|zoom|teams?|google meet)\s*(?:link|invitation)/i,
    /(?:didn(?:'t|t)|haven(?:'t|t))\s+(?:receive|get|got)\s+(?:the|a|any)?\s*(?:link|invite)/i,
    /(?:where|how)\s+(?:do i|can i)\s+(?:join|access|find)/i,
    /(?:link (?:doesn(?:'t|t) work|is broken|expired))/i,
  ],
  general_question: [
    /(?:question|wondering|curious)\s+(?:about|if|whether)/i,
    /(?:can you|could you)\s+(?:tell me|explain|clarify)/i,
    /(?:what is|who is|how does)/i,
  ],
  off_topic: [
    /(?:invoice|payment|billing|receipt)/i,
    /(?:unsubscribe|opt.?out|remove me)/i,
    /(?:wrong (?:person|email|address))/i,
  ],
  urgent: [
    /(?:urgent|asap|emergency|immediately|today)/i,
    /(?:very important|time.?sensitive|critical)/i,
    /(?:as soon as possible|right away)/i,
  ],
  unknown: [],
};

// Sentiment detection patterns
const SENTIMENT_PATTERNS: Record<EmailSentiment, RegExp[]> = {
  positive: [
    /(?:thank(?:s| you)|grateful|appreciate)/i,
    /(?:wonderful|fantastic|excellent|amazing|great(?:!|\.))/i,
    /(?:excited|looking forward|can(?:'t|not) wait)/i,
    /(?:love|perfect|exactly what)/i,
  ],
  neutral: [],
  frustrated: [
    /(?:frustrat|annoyed|upset|disappointed)/i,
    /(?:still waiting|no response|haven(?:'t|t) heard)/i,
    /(?:again|another email|follow(?:ing)? up)/i,
    /(?:this is (?:the|my) (?:second|third|fourth))/i,
    /(?:unacceptable|ridiculous|terrible)/i,
    /!{2,}/,
  ],
  confused: [
    /(?:confused|unclear|don(?:'t|t) understand)/i,
    /(?:what do you mean|can you clarify|not sure)/i,
    /(?:which one|what exactly|i(?:'m| am) lost)/i,
    /\?{2,}/,
  ],
  urgent: [
    /(?:urgent|asap|emergency|immediately)/i,
    /(?:today|right now|within the hour)/i,
    /(?:time.?sensitive|critical|pressing)/i,
  ],
};

// Time/slot extraction patterns
const SLOT_PATTERNS = [
  // "Monday at 10am"
  /(\w+day)\s+(?:at\s+)?(\d{1,2}(?::\d{2})?)\s*(am|pm)?/gi,
  // "10am on Monday"
  /(\d{1,2}(?::\d{2})?)\s*(am|pm)?\s+(?:on\s+)?(\w+day)/gi,
  // "February 10th at 2pm"
  /(\w+)\s+(\d{1,2})(?:st|nd|rd|th)?\s+(?:at\s+)?(\d{1,2}(?::\d{2})?)\s*(am|pm)?/gi,
  // "the 10am slot"
  /the\s+(\d{1,2}(?::\d{2})?)\s*(am|pm)?\s+(?:slot|option|time)/gi,
  // Time ranges: "between 9am and 11am"
  /(?:between|from)\s+(\d{1,2}(?::\d{2})?)\s*(am|pm)?\s+(?:and|to|-)\s+(\d{1,2}(?::\d{2})?)\s*(am|pm)?/gi,
];

// Therapist confirmation patterns
// FIX RSA-3: Tightened patterns to avoid false positives
// Patterns must now be more specific to avoid matching questions or conditional statements
const CONFIRMATION_PATTERNS = {
  slotConfirmed: [
    // More specific patterns that indicate definitive confirmation
    /(?:(?:that(?:'s|s)?|this)\s+(?:works?|is fine|is good|is confirmed|is great|is perfect))(?:\s*[.!]|$)/i,
    /(?:i(?:'ll|'m|ve| will| am| have)\s+(?:put|marked|blocked|reserved)\s+(?:that|this|it|you)\s+(?:down|in|off))/i,
    /(?:confirmed|booked|scheduled)\s+(?:for|at)/i,
    /(?:see you|looking forward|look forward)\s+(?:to\s+)?(?:it|then|speaking|the session)/i,
    /(?:works?\s+(?:for me|great|perfectly|well))(?:\s*[.!]|$)/i,
    /(?:i(?:'ve| have)\s+(?:booked|confirmed|scheduled))/i,
    /(?:(?:that|this)\s+(?:time|slot|day)\s+(?:works?|is\s+(?:fine|good|great|perfect)))(?:\s*[.!]|$)/i,
  ],
  willSendLink: [
    /(?:i(?:'ll| will)\s+send(?:ing)?\s+(?:you|the|a)?\s*(?:meeting|video|zoom|teams?)?\s*(?:link|invite|details))/i,
    /(?:(?:meeting|video|zoom|teams?)\s*(?:link|invite)\s+(?:will be|coming|on the way|to follow|shortly))/i,
    /(?:sending\s+(?:you\s+)?(?:the\s+)?(?:meeting\s+)?(?:details|link|invite))/i,
    /(?:here(?:'s| is)\s+(?:the\s+)?(?:meeting\s+)?(?:link|invite))/i,
    /(?:(?:link|invite)\s+(?:is\s+)?(?:below|attached|here))/i,
  ],
  // FIX RSA-3: Tightened general confirmation patterns
  // These should NOT match if followed by "but", "however", "?", or conditional phrases
  generalConfirmation: [
    // Match "yes" only when it's a standalone confirmation (end of sentence or followed by positive)
    /(?:^|\.\s+)(?:yes|yep|yeah|yea|absolutely|confirmed|all set)(?:\s*[.!]|,?\s+(?:that|this|i'll|i will|see you))/i,
    // Match positive phrases only at end of sentence or standalone
    /(?:sounds?\s+(?:good|great|perfect|lovely|wonderful))(?:\s*[.!]|$)/i,
    // Single word confirmations only if they appear to end the thought
    /(?:^|\.\s+)(?:perfect|great|wonderful|excellent|lovely|fantastic)(?:\s*[.!]|,?\s+(?:i'll|see you|looking))/i,
    // "That's fine/great" etc. only when not followed by "but"
    /(?:that(?:'s|s)?\s+(?:fine|great|perfect|wonderful|lovely))(?:\s*[.!]|$)(?!\s*but)/i,
    // Definitive positive responses
    /(?:^|\.\s+)(?:of course|certainly|definitely)(?:\s*[.!]|,?\s+(?:i|that|the))/i,
  ],
  // Negative/ambiguous patterns - if these appear, do NOT treat as confirmed
  // Used to gate the generalConfirmation patterns
  ambiguousIndicators: [
    /\?/,  // Questions
    /(?:but|however|although|though)\s/i,  // Contradictions
    /(?:can we|could we|would it be|is it possible)/i,  // Requests for change
    /(?:actually|instead|rather)\s/i,  // Corrections
    /(?:not sure|uncertain|don't know|might not)/i,  // Uncertainty
    /(?:unfortunately|sorry|apolog)/i,  // Negative sentiment
  ],
  // NEW: Detect meeting links in email - if present, it's implicitly confirmed
  meetingLinkPresent: [
    /(?:https?:\/\/)?(?:[\w-]+\.)?zoom\.us\/j\/\d+/i,
    /(?:https?:\/\/)?teams\.microsoft\.com\/l\/meetup-join/i,
    /(?:https?:\/\/)?meet\.google\.com\/[\w-]+/i,
    /(?:https?:\/\/)?whereby\.com\/[\w-]+/i,
    /(?:https?:\/\/)?calendly\.com\/[\w-]+/i,
  ],
};

// Out of office detection
const OUT_OF_OFFICE_PATTERNS = [
  /(?:out of (?:the )?office|ooo|on (?:leave|vacation|holiday))/i,
  /(?:away from (?:my )?(?:desk|email))/i,
  /(?:automatic reply|auto-?reply|auto-?response)/i,
  /(?:limited access to email)/i,
];

/**
 * Extract time slots mentioned in email
 */
function extractSlots(text: string): ExtractedSlot[] {
  const slots: ExtractedSlot[] = [];
  const seen = new Set<string>();

  for (const pattern of SLOT_PATTERNS) {
    let match;
    const regex = new RegExp(pattern.source, pattern.flags);

    while ((match = regex.exec(text)) !== null) {
      const raw = match[0].trim();

      // Deduplicate
      if (seen.has(raw.toLowerCase())) continue;
      seen.add(raw.toLowerCase());

      const slot: ExtractedSlot = { raw };

      // Parse components based on pattern match
      const dayMatch = raw.match(/\b(\w+day)\b/i);
      if (dayMatch) slot.dayOfWeek = dayMatch[1];

      const timeMatch = raw.match(/(\d{1,2}(?::\d{2})?)\s*(am|pm)/i);
      if (timeMatch) {
        let hours = parseInt(timeMatch[1].split(':')[0]);
        const minutes = timeMatch[1].includes(':') ? timeMatch[1].split(':')[1] : '00';
        const ampm = timeMatch[2].toLowerCase();

        if (ampm === 'pm' && hours !== 12) hours += 12;
        if (ampm === 'am' && hours === 12) hours = 0;

        slot.time = `${hours.toString().padStart(2, '0')}:${minutes}`;
      }

      const dateMatch = raw.match(/(\w+)\s+(\d{1,2})(?:st|nd|rd|th)?/i);
      if (dateMatch) slot.date = `${dateMatch[1]} ${dateMatch[2]}`;

      slot.isRange = /(?:between|from|to|-|and)/.test(raw);

      slots.push(slot);
    }
  }

  return slots;
}

/**
 * Check for therapist confirmation patterns
 */
function detectTherapistConfirmation(
  text: string,
  isFromTherapist: boolean
): TherapistConfirmation | null {
  if (!isFromTherapist) return null;

  const result: TherapistConfirmation = {
    isConfirmed: false,
  };

  // Check for actual meeting link in email - strongest signal of confirmation
  for (const pattern of CONFIRMATION_PATTERNS.meetingLinkPresent) {
    if (pattern.test(text)) {
      result.isConfirmed = true;
      result.confirmationType = 'meeting_link';
      result.willSendLink = true; // Link is already present
      return result; // No need to check further
    }
  }

  // Check for slot confirmation
  for (const pattern of CONFIRMATION_PATTERNS.slotConfirmed) {
    if (pattern.test(text)) {
      result.isConfirmed = true;
      result.confirmationType = 'slot';
      break;
    }
  }

  // Check if they'll send meeting link
  for (const pattern of CONFIRMATION_PATTERNS.willSendLink) {
    if (pattern.test(text)) {
      result.willSendLink = true;
      if (!result.isConfirmed) {
        result.isConfirmed = true;
        result.confirmationType = 'meeting_link';
      }
      break;
    }
  }

  // Check general confirmation (lower priority)
  // But first check for ambiguous indicators that suggest this isn't a true confirmation
  if (!result.isConfirmed) {
    const hasAmbiguity = CONFIRMATION_PATTERNS.ambiguousIndicators.some(pattern => pattern.test(text));

    if (!hasAmbiguity) {
      for (const pattern of CONFIRMATION_PATTERNS.generalConfirmation) {
        if (pattern.test(text)) {
          result.isConfirmed = true;
          result.confirmationType = 'booking';
          break;
        }
      }
    }
  }

  return result.isConfirmed ? result : null;
}

/**
 * Detect the primary intent of an email
 */
function detectIntent(text: string): { intent: EmailIntent; confidence: number } {
  const scores: Record<EmailIntent, number> = {
    slot_selection: 0,
    availability_question: 0,
    reschedule_request: 0,
    cancellation: 0,
    confirmation: 0,
    meeting_link_issue: 0,
    general_question: 0,
    off_topic: 0,
    urgent: 0,
    unknown: 0,
  };

  const textLower = text.toLowerCase();

  for (const [intent, patterns] of Object.entries(INTENT_PATTERNS)) {
    for (const pattern of patterns) {
      if (pattern.test(textLower)) {
        scores[intent as EmailIntent] += 1;
      }
    }
  }

  // Find highest scoring intent
  let maxIntent: EmailIntent = 'unknown';
  let maxScore = 0;

  for (const [intent, score] of Object.entries(scores)) {
    if (score > maxScore) {
      maxScore = score;
      maxIntent = intent as EmailIntent;
    }
  }

  // FIX #30: Adjusted confidence formula — previous formula was too generous
  // (1 match = 0.7 "moderate", 2 matches = 1.0 "high").
  // New: 1 match = 0.45 (low), 2 matches = 0.65 (moderate), 3+ = high
  const confidence = Math.min(1, maxScore * 0.2 + (maxScore > 0 ? 0.25 : 0));

  return { intent: maxIntent, confidence };
}

/**
 * Detect sentiment of an email
 */
function detectSentiment(text: string): EmailSentiment {
  const textLower = text.toLowerCase();

  // Check in order of specificity
  const sentimentOrder: EmailSentiment[] = ['urgent', 'frustrated', 'confused', 'positive', 'neutral'];

  for (const sentiment of sentimentOrder) {
    const patterns = SENTIMENT_PATTERNS[sentiment];
    for (const pattern of patterns) {
      if (pattern.test(textLower)) {
        return sentiment;
      }
    }
  }

  return 'neutral';
}

/**
 * Check if email is an out-of-office auto-reply
 */
function isOutOfOffice(text: string): boolean {
  const textLower = text.toLowerCase();
  return OUT_OF_OFFICE_PATTERNS.some(pattern => pattern.test(textLower));
}

/**
 * Calculate urgency level based on various factors
 */
function calculateUrgency(
  intent: EmailIntent,
  sentiment: EmailSentiment,
  text: string
): 'low' | 'medium' | 'high' {
  // High urgency indicators
  if (intent === 'urgent' || sentiment === 'urgent') return 'high';
  if (sentiment === 'frustrated') return 'high';

  // Medium urgency
  if (intent === 'cancellation') return 'medium';
  if (intent === 'reschedule_request') return 'medium';
  if (intent === 'meeting_link_issue') return 'medium';

  // Check for time-sensitive language
  const urgentPhrases = /(?:today|asap|urgent|immediately|within \d+ hour)/i;
  if (urgentPhrases.test(text)) return 'high';

  return 'low';
}

/**
 * Generate action suggestions based on classification
 */
function generateSuggestedAction(classification: Omit<EmailClassification, 'suggestedAction'>): string | undefined {
  // Highest priority: Meeting link already sent - definitely confirmed
  if (classification.isFromTherapist && classification.therapistConfirmation?.confirmationType === 'meeting_link' && classification.therapistConfirmation?.willSendLink) {
    return 'Therapist has sent/confirmed meeting link. Use mark_scheduling_complete to finalize the booking.';
  }

  // Therapist confirmed the slot
  if (classification.isFromTherapist && classification.therapistConfirmation?.isConfirmed) {
    return 'Therapist has confirmed. Ask for meeting link if not already sent, then use mark_scheduling_complete.';
  }

  if (classification.intent === 'slot_selection' && classification.extractedSlots.length === 1) {
    return `User selected: ${classification.extractedSlots[0].raw}. Confirm with therapist.`;
  }

  if (classification.intent === 'slot_selection' && classification.extractedSlots.length > 1) {
    return 'User mentioned multiple slots. Clarify which one they prefer.';
  }

  if (classification.intent === 'cancellation') {
    return 'User wants to cancel. Use cancel_appointment tool after confirming.';
  }

  if (classification.intent === 'reschedule_request') {
    return 'User wants to reschedule. Ask for new preferred times.';
  }

  if (classification.intent === 'meeting_link_issue') {
    return 'User reports missing or broken meeting link. Email the therapist to resend the link to the client.';
  }

  if (classification.sentiment === 'frustrated') {
    return 'User may be frustrated. Respond promptly and empathetically.';
  }

  if (classification.flags.isOutOfOffice) {
    return 'This is an auto-reply. No response needed now; user will respond when back.';
  }

  return undefined;
}

/**
 * Classify an incoming email
 *
 * @param emailBody - The email content to classify
 * @param fromEmail - Sender's email address
 * @param therapistEmail - The therapist's email address
 * @param userEmail - The user/client's email address
 * @returns Classification result with intent, sentiment, and extracted data
 */
export function classifyEmail(
  emailBody: string,
  fromEmail: string,
  therapistEmail: string,
  userEmail: string
): EmailClassification {
  const isFromTherapist = fromEmail.toLowerCase() === therapistEmail.toLowerCase();

  const { intent, confidence } = detectIntent(emailBody);
  const sentiment = detectSentiment(emailBody);
  const extractedSlots = extractSlots(emailBody);
  const therapistConfirmation = detectTherapistConfirmation(emailBody, isFromTherapist);
  const urgencyLevel = calculateUrgency(intent, sentiment, emailBody);

  const textLower = emailBody.toLowerCase();

  const flags = {
    mentionsMultipleSlots: extractedSlots.length > 1,
    mentionsPreferences: /(?:prefer|rather|better for me|works? better)/i.test(textLower),
    mentionsConstraints: /(?:can(?:'t|not)|busy|unavailable|only available|except|not on)/i.test(textLower),
    mentionsRescheduling: /(?:reschedule|change|move|different time)/i.test(textLower),
    mentionsCancellation: /(?:cancel|call off|no longer)/i.test(textLower),
    isOutOfOffice: isOutOfOffice(emailBody),
  };

  const baseClassification: Omit<EmailClassification, 'suggestedAction'> = {
    intent,
    confidence,
    sentiment,
    extractedSlots,
    therapistConfirmation,
    isFromTherapist,
    urgencyLevel,
    flags,
  };

  const suggestedAction = generateSuggestedAction(baseClassification);

  const classification: EmailClassification = {
    ...baseClassification,
    suggestedAction,
  };

  logger.debug(
    {
      intent,
      confidence,
      sentiment,
      slotsFound: extractedSlots.length,
      isFromTherapist,
      urgencyLevel,
      flags,
    },
    'Email classified'
  );

  return classification;
}

/**
 * Quick check if an email needs special handling
 * (high urgency, frustrated sentiment, or auto-reply)
 */
export function needsSpecialHandling(classification: EmailClassification): {
  needsAttention: boolean;
  reason?: string;
} {
  if (classification.flags.isOutOfOffice) {
    return { needsAttention: true, reason: 'out_of_office' };
  }

  if (classification.urgencyLevel === 'high') {
    return { needsAttention: true, reason: 'urgent' };
  }

  if (classification.sentiment === 'frustrated') {
    return { needsAttention: true, reason: 'frustrated_user' };
  }

  if (classification.intent === 'cancellation') {
    return { needsAttention: true, reason: 'cancellation_request' };
  }

  return { needsAttention: false };
}

/**
 * FIX RSA-5: Format email classification for inclusion in Claude prompt
 * Includes confidence level and warnings for low-confidence classifications
 */
export function formatClassificationForPrompt(classification: EmailClassification): string {
  const CONFIDENCE_THRESHOLD = 0.6;

  const lines: string[] = [];

  // Intent with confidence level
  const confidenceLevel = classification.confidence >= 0.8 ? 'high' :
                          classification.confidence >= CONFIDENCE_THRESHOLD ? 'moderate' : 'low';
  lines.push(`- Detected intent: ${classification.intent} (${confidenceLevel} confidence)`);

  // Warning for low confidence
  if (classification.confidence < CONFIDENCE_THRESHOLD) {
    lines.push(`- ⚠️ LOW CONFIDENCE: Verify this interpretation before acting. The email may be ambiguous.`);
  }

  // Sentiment
  lines.push(`- Sentiment: ${classification.sentiment}`);

  // Urgency
  lines.push(`- Urgency: ${classification.urgencyLevel}`);

  // Extracted times
  if (classification.extractedSlots.length > 0) {
    lines.push(`- Mentioned times: ${classification.extractedSlots.map(s => s.raw).join(', ')}`);
  }

  // Therapist confirmation with confidence caveat
  if (classification.therapistConfirmation?.isConfirmed) {
    let confirmationNote = `- Therapist appears to be confirming`;
    if (classification.therapistConfirmation.willSendLink) {
      confirmationNote += ' and will send meeting link';
    }
    // Add caveat for generalConfirmation type which is more ambiguous
    if (classification.therapistConfirmation.confirmationType === 'booking') {
      confirmationNote += ' (verify this is a definite confirmation before marking complete)';
    }
    lines.push(confirmationNote);
  }

  // Suggested action
  if (classification.suggestedAction) {
    if (classification.confidence >= CONFIDENCE_THRESHOLD) {
      lines.push(`- Suggested action: ${classification.suggestedAction}`);
    } else {
      lines.push(`- Possible action: ${classification.suggestedAction} (verify intent first)`);
    }
  }

  return lines.join('\n');
}
