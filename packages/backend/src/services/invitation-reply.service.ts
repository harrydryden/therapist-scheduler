/**
 * Invitation Reply Service
 *
 * Handles inbound email replies from people we sent a SignupInvitation to.
 *
 * Flow:
 *   1. Email lands at scheduling@ from a sender with a pending (or recent)
 *      invitation row.
 *   2. The email-message-processor's appointment-matcher returns null (the
 *      sender has no booking yet — they haven't even completed signup).
 *   3. Before falling into the unmatched-tracker path, the processor calls
 *      `tryHandleInvitationReply` which detects the pending-invite case
 *      and replies in-thread.
 *
 * The reply uses the existing knowledge-base ('user' audience entries) as
 * the only source of factual claims; the system prompt strictly forbids
 * speculation. If a question can't be answered from the knowledge base,
 * the agent redirects the recipient to the web app or asks them to use
 * their original invitation link to sign up.
 *
 * The reply is sent in-thread (preserving threadId) so the recipient
 * sees it as a continuation of the original invitation conversation.
 */

import { prisma } from '../utils/database';
import { logger } from '../utils/logger';
import { redis } from '../utils/redis';
import { getSettingValue } from './settings.service';
import { knowledgeService } from './knowledge.service';
import { AIService } from './ai.service';
import { emailProcessingService } from './email-processing.service';
import { slackNotificationService } from './slack-notification.service';
import { firstName } from '../utils/first-name';
import type { EmailMessage } from '../utils/email-mime-parser';

/**
 * Cooldown window per invitation. Once an auto-reply fires, further inbound
 * messages from the same recipient are routed to admins (via Slack) instead
 * of triggering another LLM-composed reply. Prevents both reply loops with
 * misbehaving auto-responders and bad UX from someone who's unhappy with
 * the first reply and keeps writing back.
 */
const COOLDOWN_SECONDS = 60 * 60; // 1 hour
const COOLDOWN_KEY_PREFIX = 'invitation-reply:cooldown:';

/** Max length of message bodies we surface to Slack (defence against very long inbounds). */
const SLACK_BODY_PREVIEW = 600;

/**
 * If the sender has a pending or recently-accepted invitation, compose and
 * send an auto-reply. Returns true if we handled the email (caller should
 * markMessageProcessed); false otherwise (caller continues with the
 * unmatched-tracker fallback).
 *
 * "Recently accepted" is included so the response remains friendly during
 * the brief window after signup completes — they may have lingering
 * questions before booking. After 30 days we let the email fall through
 * to the unmatched-tracker.
 */
export async function tryHandleInvitationReply(
  email: EmailMessage,
  traceId: string,
): Promise<boolean> {
  const fromEmail = extractEmailAddress(email.from);
  if (!fromEmail) return false;

  // RFC 3834: skip out-of-office, vacation responders, mailer-daemons, and
  // anything else that flags itself as auto-submitted. Replying to those
  // would create a mail loop (their auto-responder bounces our auto-reply,
  // we re-respond, etc.). Header is "no" for human replies.
  if (email.autoSubmitted && email.autoSubmitted !== 'no') {
    logger.info(
      { traceId, messageId: email.id, fromEmail, autoSubmitted: email.autoSubmitted },
      'Skipping invitation auto-reply: inbound is auto-submitted (RFC 3834)',
    );
    return false;
  }

  const invitation = await prisma.signupInvitation.findFirst({
    where: {
      email: fromEmail,
      // Pending OR recently accepted — both warrant a friendly reply.
      OR: [
        { acceptedAt: null, revokedAt: null, expiresAt: { gt: new Date() } },
        { acceptedAt: { gt: new Date(Date.now() - 30 * 24 * 60 * 60 * 1000) } },
      ],
      archivedAt: null,
    },
    select: {
      id: true,
      email: true,
      name: true,
      acceptedAt: true,
    },
    orderBy: { createdAt: 'desc' },
  });

  if (!invitation) return false;

  // Cooldown: if we already auto-replied to this invitation within the
  // last hour, don't run another LLM call. Surface the message to admins
  // via Slack so a human can follow up with appropriate context, and
  // return true so the caller marks the inbound processed (we did handle
  // it — the handling was "escalate").
  const cooldownKey = `${COOLDOWN_KEY_PREFIX}${invitation.id}`;
  const cooldownActive = await safeRedisGet(cooldownKey, traceId);
  if (cooldownActive) {
    logger.info(
      { traceId, messageId: email.id, invitationId: invitation.id, fromEmail },
      'Invitation auto-reply suppressed by cooldown — escalating to admins',
    );
    void notifyAdminsOfFollowupReply({ email, fromEmail, invitation }).catch((err) => {
      logger.warn(
        { err, traceId, messageId: email.id, invitationId: invitation.id },
        'Failed to send Slack alert for cooldown-suppressed invitation reply',
      );
    });
    return true;
  }

  logger.info(
    { traceId, messageId: email.id, invitationId: invitation.id, fromEmail },
    'Inbound email matched a pending/recent invitation — generating auto-reply',
  );

  try {
    const replyBody = await composeReplyBody({
      emailContent: email.body,
      emailSubject: email.subject,
      recipientName: invitation.name || null,
      hasAccepted: invitation.acceptedAt !== null,
      traceId,
    });

    const replySubject = email.subject.toLowerCase().startsWith('re:')
      ? email.subject
      : `Re: ${email.subject}`;

    await emailProcessingService.sendEmail({
      to: fromEmail,
      subject: replySubject,
      body: replyBody,
      threadId: email.threadId,
    });

    // Set cooldown AFTER successful send. Best-effort: a Redis outage
    // means the cooldown won't apply but we've already replied this turn,
    // so the worst case is a duplicate reply on a fast follow-up.
    await safeRedisSet(cooldownKey, '1', COOLDOWN_SECONDS, traceId);

    logger.info(
      { traceId, messageId: email.id, invitationId: invitation.id },
      'Sent invitation auto-reply',
    );

    // Visibility: notify admins of every auto-reply during early rollout
    // so we can spot bad LLM responses before recipients do. Fire-and-
    // forget — Slack failure must not block returning true.
    void notifyAdminsOfAutoReply({
      email,
      fromEmail,
      invitation,
      replyBody,
    }).catch((err) => {
      logger.warn(
        { err, traceId, messageId: email.id, invitationId: invitation.id },
        'Failed to send Slack alert for invitation auto-reply',
      );
    });

    return true;
  } catch (err) {
    // Swallow + log: if the auto-reply fails we'd rather have the message
    // fall through to the unmatched-tracker (which alerts admins) than
    // silently drop it. Returning false routes it back through the normal
    // unmatched path.
    logger.error(
      { err, traceId, messageId: email.id, invitationId: invitation.id },
      'Failed to compose/send invitation auto-reply — falling through to unmatched handler',
    );
    return false;
  }
}

/**
 * Slack notification shapes. Both use sendAlert with severity 'low' so
 * they don't page anyone and don't drown out real alerts.
 */
async function notifyAdminsOfAutoReply(params: {
  email: EmailMessage;
  fromEmail: string;
  invitation: { id: string; name: string | null };
  replyBody: string;
}): Promise<void> {
  // PII discipline: identify the invitee by first name only — never echo
  // their email address into Slack. The invitation ID is the canonical
  // pointer admins click through to.
  const inviteeFirstName = firstName(params.invitation.name, '(invitee)');
  await slackNotificationService.sendAlert({
    title: 'Invitation auto-reply sent',
    severity: 'low',
    details:
      `Auto-replied to *${inviteeFirstName}*.\n\n` +
      `*Their question:*\n${truncate(params.email.body, SLACK_BODY_PREVIEW)}\n\n` +
      `*Our reply:*\n${truncate(params.replyBody, SLACK_BODY_PREVIEW)}`,
    additionalFields: {
      'Invitation ID': params.invitation.id,
      'Subject': truncate(params.email.subject, 100),
    },
  });
}

async function notifyAdminsOfFollowupReply(params: {
  email: EmailMessage;
  fromEmail: string;
  invitation: { id: string; name: string | null };
}): Promise<void> {
  // PII discipline: first name only; no email address in Slack.
  const inviteeFirstName = firstName(params.invitation.name, '(invitee)');
  await slackNotificationService.sendAlert({
    title: 'Invitee replied again — needs human follow-up',
    severity: 'medium',
    details:
      `*${inviteeFirstName}* replied to their invitation thread within the ` +
      `auto-reply cooldown window. The previous auto-reply may not have ` +
      `answered them.\n\n` +
      `*Their message:*\n${truncate(params.email.body, SLACK_BODY_PREVIEW)}`,
    additionalFields: {
      'Invitation ID': params.invitation.id,
      'Subject': truncate(params.email.subject, 100),
    },
  });
}

function truncate(text: string, max: number): string {
  if (!text) return '';
  if (text.length <= max) return text;
  return text.slice(0, max) + '…';
}

async function safeRedisGet(key: string, traceId: string): Promise<string | null> {
  try {
    return await redis.get(key);
  } catch (err) {
    logger.warn({ err, traceId, key }, 'Redis GET failed for invitation-reply cooldown — proceeding without cooldown');
    return null;
  }
}

async function safeRedisSet(key: string, value: string, ttlSeconds: number, traceId: string): Promise<void> {
  try {
    await redis.set(key, value, 'EX', ttlSeconds);
  } catch (err) {
    logger.warn({ err, traceId, key }, 'Redis SET failed for invitation-reply cooldown — next message may double-reply');
  }
}

interface ComposeReplyParams {
  emailContent: string;
  emailSubject: string;
  recipientName: string | null;
  hasAccepted: boolean;
  traceId: string;
}

async function composeReplyBody(params: ComposeReplyParams): Promise<string> {
  const webAppUrl = (await getSettingValue<string>('weeklyMailing.webAppUrl')) || 'https://free.spill.app';
  const knowledge = await knowledgeService.getKnowledgeForPrompt();
  const knowledgeBlock = knowledge.forUser?.trim() || '(no knowledge entries available)';

  const recipientName = params.recipientName || 'there';
  const stage = params.hasAccepted
    ? 'They have already completed signup and can book a session at any time.'
    : 'They have not yet completed signup — their original invitation email contains a private link.';

  const systemPrompt = [
    `You are replying on behalf of Spill (a workplace therapy platform) to someone who was sent a private invitation to join the free therapy programme. ${stage}`,
    '',
    'Your job:',
    '1. If the question is answered by the knowledge base below, give a concise, warm answer in 2–4 short sentences. Use only the knowledge base for factual claims.',
    '2. If the question is not in the knowledge base, OR if it asks for personal advice, OR if it commits Spill to anything specific, do NOT speculate. Briefly acknowledge the question, say a member of the team will get back to them if needed, and direct them to the web app for general information.',
    '3. Always end the email with this exact line on its own paragraph: "If you\'d like to proceed with signup, please use the private link in your original invitation email. If you can\'t find it, just reply and we\'ll re-issue."',
    '4. Sign off as: "The Spill team".',
    '5. Keep the entire reply under 150 words. Plain text only — no markdown headings or lists.',
    '6. Do not invent facts, prices, timelines, qualifications, or commitments not present in the knowledge base.',
    '',
    `Web app URL (mention only if relevant): ${webAppUrl}`,
    '',
    'Knowledge base (the ONLY source of facts you may use):',
    knowledgeBlock,
  ].join('\n');

  const userPrompt = [
    `The recipient's name is "${recipientName}".`,
    `Their email subject was: "${params.emailSubject}"`,
    'Their email body:',
    '---',
    params.emailContent.slice(0, 4000),
    '---',
    '',
    'Compose the reply email body now. Output ONLY the reply text (no greeting prefix, no "Subject:" line, no quoted original).',
  ].join('\n');

  const aiService = new AIService({
    // Fast model — this is a short Q&A response, not an agentic task.
    model: undefined,
    maxTokens: 500,
    temperature: 0.4,
  });

  const response = await aiService.generateResponse(userPrompt, systemPrompt, {
    traceId: params.traceId,
    maxTokens: 500,
    temperature: 0.4,
  });

  const trimmed = response.content.trim();
  // Belt-and-braces: prepend a greeting if the model omitted one.
  if (!/^hi\b|^hello\b|^hey\b/i.test(trimmed)) {
    return `Hi ${recipientName},\n\n${trimmed}`;
  }
  return trimmed;
}

/**
 * Extract the bare email address from a header that may be in either
 * `Name <addr@domain>` or `addr@domain` form. Returns the lowercased
 * address, or null if no plausible address is present.
 */
function extractEmailAddress(rawFrom: string): string | null {
  if (!rawFrom) return null;
  const match = rawFrom.match(/<([^>]+)>/) || rawFrom.match(/([^\s<>]+@[^\s<>]+)/);
  if (!match) return null;
  const addr = match[1].trim().toLowerCase();
  if (!addr.includes('@')) return null;
  return addr;
}
