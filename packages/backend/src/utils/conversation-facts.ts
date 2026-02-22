/**
 * Conversation Facts Extraction
 *
 * Inspired by OpenClaw's memory layering pattern, this extracts key facts from
 * conversations into a structured format. Facts are included at the top of the
 * system prompt to help Claude maintain context in long conversations.
 *
 * This prevents issues where Claude loses track of:
 * - Times that were proposed
 * - The time the user selected
 * - Preferences expressed by either party
 * - Blockers or constraints mentioned
 */

import { logger } from './logger';

/**
 * Structured facts extracted from a scheduling conversation
 */
export interface ConversationFacts {
  // Times that have been mentioned or proposed
  proposedTimes: string[];

  // Time the user selected (if any)
  selectedTime?: string;

  // Time both parties confirmed (if any)
  confirmedTime?: string;

  // Therapist's stated preferences
  therapistPreferences: string[];

  // User's stated preferences
  userPreferences: string[];

  // Things that block certain times/dates
  blockers: string[];

  // Any special notes (e.g., "meeting will be via Zoom")
  specialNotes: string[];

  // Last updated timestamp
  updatedAt: string;
}

/**
 * Create empty facts object
 */
export function createEmptyFacts(): ConversationFacts {
  return {
    proposedTimes: [],
    therapistPreferences: [],
    userPreferences: [],
    blockers: [],
    specialNotes: [],
    updatedAt: new Date().toISOString(),
  };
}

/**
 * Time-related patterns for extraction
 */
const TIME_PATTERNS = [
  // Day + time: "Monday at 3pm", "Tuesday 2:30pm"
  /\b(monday|tuesday|wednesday|thursday|friday|saturday|sunday)\s+(?:at\s+)?(\d{1,2}(?::\d{2})?\s*(?:am|pm)?)/gi,

  // Date + time: "January 15th at 2pm", "15th March 3pm"
  /\b(\d{1,2}(?:st|nd|rd|th)?\s+(?:of\s+)?(?:jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|jun(?:e)?|jul(?:y)?|aug(?:ust)?|sep(?:tember)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?)|(?:jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|jun(?:e)?|jul(?:y)?|aug(?:ust)?|sep(?:tember)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?)\s+\d{1,2}(?:st|nd|rd|th)?)\s+(?:at\s+)?(\d{1,2}(?::\d{2})?\s*(?:am|pm)?)/gi,

  // Relative: "tomorrow at 3pm", "next Monday 2pm"
  /\b(tomorrow|next\s+(?:monday|tuesday|wednesday|thursday|friday|saturday|sunday))\s+(?:at\s+)?(\d{1,2}(?::\d{2})?\s*(?:am|pm)?)/gi,
];

/**
 * Preference patterns
 */
const PREFERENCE_PATTERNS = {
  therapist: [
    /(?:i\s+)?prefer\s+([^.!?]+)/gi,
    /(?:i'm\s+)?(?:usually\s+)?(?:available|free)\s+([^.!?]+)/gi,
    /(?:my|the)\s+(?:best|preferred)\s+(?:time|day)s?\s+(?:is|are)\s+([^.!?]+)/gi,
    /(?:mornings?|afternoons?|evenings?)\s+(?:work|are)\s+(?:best|better)\s+(?:for me)?/gi,
  ],
  user: [
    /(?:i\s+)?(?:can|could|would)\s+(?:do|make)\s+([^.!?]+)/gi,
    /(?:i'm\s+)?(?:available|free)\s+([^.!?]+)/gi,
    /(?:that|this)\s+(?:works?|sounds?\s+good)/gi,
    /(?:i'd\s+)?prefer\s+([^.!?]+)/gi,
  ],
};

/**
 * Blocker patterns
 */
const BLOCKER_PATTERNS = [
  /(?:i'm\s+)?(?:not\s+)?(?:away|traveling|out\s+of\s+(?:town|office)|on\s+(?:holiday|vacation|leave))\s+([^.!?]+)/gi,
  /(?:won't|can't|cannot)\s+(?:be\s+)?(?:available|make\s+it|do)\s+([^.!?]+)/gi,
  /(?:that|this)\s+(?:day|time|week)\s+(?:doesn't|won't|won't)\s+work/gi,
  /(?:unfortunately|sorry),?\s+(?:i\s+)?(?:can't|cannot|won't)/gi,
];

/**
 * Selection patterns (user picking a time)
 */
const SELECTION_PATTERNS = [
  /(?:let's\s+)?(?:go\s+)?(?:with|for)\s+([^.!?]+)/gi,
  /(?:i'll\s+)?(?:take|choose|pick)\s+([^.!?]+)/gi,
  /(?:that|this)\s+(?:works?|sounds?\s+(?:good|great|perfect))/gi,
  /(?:monday|tuesday|wednesday|thursday|friday|saturday|sunday)\s+(?:at\s+)?(\d{1,2}(?::\d{2})?\s*(?:am|pm)?)\s+(?:works?|sounds?\s+(?:good|great|perfect)|please)/gi,
];

/**
 * Confirmation patterns (therapist confirming)
 */
const CONFIRMATION_PATTERNS = [
  /(?:confirmed|booked|see\s+you\s+(?:then|on|at))/gi,
  /(?:that's\s+)?(?:confirmed|all\s+set|booked\s+in)/gi,
  /(?:i'll\s+)?send\s+(?:you\s+)?(?:the\s+)?(?:meeting\s+)?link/gi,
];

/**
 * Extract facts from a single message
 */
function extractFromMessage(
  content: string,
  isFromTherapist: boolean,
  existingFacts: ConversationFacts
): ConversationFacts {
  const facts = { ...existingFacts };
  const contentLower = content.toLowerCase();

  // Extract proposed times
  for (const pattern of TIME_PATTERNS) {
    const matches = content.matchAll(pattern);
    for (const match of matches) {
      const time = match[0].trim();
      if (!facts.proposedTimes.includes(time) && facts.proposedTimes.length < 10) {
        facts.proposedTimes.push(time);
      }
    }
  }

  // Extract preferences
  const prefPatterns = isFromTherapist
    ? PREFERENCE_PATTERNS.therapist
    : PREFERENCE_PATTERNS.user;
  const prefArray = isFromTherapist
    ? facts.therapistPreferences
    : facts.userPreferences;

  for (const pattern of prefPatterns) {
    const matches = content.matchAll(pattern);
    for (const match of matches) {
      const pref = (match[1] || match[0]).trim();
      if (pref.length > 5 && pref.length < 100 && !prefArray.includes(pref) && prefArray.length < 5) {
        prefArray.push(pref);
      }
    }
  }

  // Extract blockers
  for (const pattern of BLOCKER_PATTERNS) {
    const matches = content.matchAll(pattern);
    for (const match of matches) {
      const blocker = (match[1] || match[0]).trim();
      if (blocker.length > 5 && blocker.length < 100 && !facts.blockers.includes(blocker) && facts.blockers.length < 5) {
        facts.blockers.push(blocker);
      }
    }
  }

  // Check for user selection (only from user messages)
  if (!isFromTherapist) {
    for (const pattern of SELECTION_PATTERNS) {
      if (pattern.test(content)) {
        // Try to extract the specific time they selected
        for (const timePattern of TIME_PATTERNS) {
          const timeMatch = content.match(timePattern);
          if (timeMatch) {
            facts.selectedTime = timeMatch[0].trim();
            break;
          }
        }
        break;
      }
    }
  }

  // Check for therapist confirmation
  if (isFromTherapist) {
    for (const pattern of CONFIRMATION_PATTERNS) {
      if (pattern.test(content)) {
        // The confirmed time should be the selected time or most recently proposed time
        facts.confirmedTime = facts.selectedTime || facts.proposedTimes[facts.proposedTimes.length - 1];
        break;
      }
    }
  }

  // Check for meeting link (special note)
  const meetingLinkPatterns = [
    /https?:\/\/(?:[\w-]+\.)?zoom\.us\/j\/\d+/i,
    /https?:\/\/teams\.microsoft\.com\/l\/meetup-join/i,
    /https?:\/\/meet\.google\.com\/[\w-]+/i,
  ];

  for (const pattern of meetingLinkPatterns) {
    if (pattern.test(content)) {
      const note = 'Meeting link has been shared';
      if (!facts.specialNotes.includes(note)) {
        facts.specialNotes.push(note);
      }
      break;
    }
  }

  facts.updatedAt = new Date().toISOString();

  return facts;
}

/**
 * Extract facts from an array of conversation messages
 */
export function extractFacts(
  messages: Array<{ role: string; content: string }>,
  therapistEmail: string,
  userEmail: string
): ConversationFacts {
  let facts = createEmptyFacts();

  for (const message of messages) {
    // Determine if message is from therapist
    // In our system, 'user' role emails can come from either the client or therapist
    // We need to check the content for email headers or use heuristics
    const isFromTherapist = message.content.toLowerCase().includes(therapistEmail.toLowerCase());

    try {
      facts = extractFromMessage(message.content, isFromTherapist, facts);
    } catch (err) {
      logger.warn({ err, role: message.role }, 'Error extracting facts from message');
    }
  }

  return facts;
}

/**
 * Update existing facts with a new message
 */
export function updateFacts(
  existingFacts: ConversationFacts | undefined,
  messageContent: string,
  isFromTherapist: boolean
): ConversationFacts {
  const facts = existingFacts || createEmptyFacts();

  try {
    return extractFromMessage(messageContent, isFromTherapist, facts);
  } catch (err) {
    logger.warn({ err, isFromTherapist }, 'Error updating facts from message');
    return facts;
  }
}

/**
 * Format facts for inclusion in system prompt
 */
export function formatFactsForPrompt(facts: ConversationFacts): string {
  const sections: string[] = [];

  if (facts.confirmedTime) {
    sections.push(`**CONFIRMED TIME:** ${facts.confirmedTime}`);
  } else if (facts.selectedTime) {
    sections.push(`**USER SELECTED:** ${facts.selectedTime} (awaiting therapist confirmation)`);
  }

  if (facts.proposedTimes.length > 0) {
    const recent = facts.proposedTimes.slice(-5); // Last 5 proposed times
    sections.push(`**Times Discussed:** ${recent.join(', ')}`);
  }

  if (facts.therapistPreferences.length > 0) {
    sections.push(`**Therapist Preferences:** ${facts.therapistPreferences.join('; ')}`);
  }

  if (facts.userPreferences.length > 0) {
    sections.push(`**Client Preferences:** ${facts.userPreferences.join('; ')}`);
  }

  if (facts.blockers.length > 0) {
    sections.push(`**Blockers/Unavailable:** ${facts.blockers.join('; ')}`);
  }

  if (facts.specialNotes.length > 0) {
    sections.push(`**Notes:** ${facts.specialNotes.join('; ')}`);
  }

  if (sections.length === 0) {
    return ''; // No facts to display
  }

  return `## Conversation Facts (Auto-Extracted)
${sections.join('\n')}
`;
}

/**
 * Merge facts from Claude's response (if it extracts additional facts)
 * Claude can be prompted to return facts in a structured format
 */
export function mergeFacts(
  existingFacts: ConversationFacts,
  newFacts: Partial<ConversationFacts>
): ConversationFacts {
  return {
    proposedTimes: [...new Set([...existingFacts.proposedTimes, ...(newFacts.proposedTimes || [])])].slice(-10),
    selectedTime: newFacts.selectedTime || existingFacts.selectedTime,
    confirmedTime: newFacts.confirmedTime || existingFacts.confirmedTime,
    therapistPreferences: [...new Set([...existingFacts.therapistPreferences, ...(newFacts.therapistPreferences || [])])].slice(0, 5),
    userPreferences: [...new Set([...existingFacts.userPreferences, ...(newFacts.userPreferences || [])])].slice(0, 5),
    blockers: [...new Set([...existingFacts.blockers, ...(newFacts.blockers || [])])].slice(0, 5),
    specialNotes: [...new Set([...existingFacts.specialNotes, ...(newFacts.specialNotes || [])])].slice(0, 5),
    updatedAt: new Date().toISOString(),
  };
}
