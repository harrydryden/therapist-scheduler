/**
 * Agent Profile (Layer C in the agent memory design)
 *
 * The first two layers of agent memory are per-thread:
 *   - Layer A (utils/conversation-facts.ts) — regex-extracted scheduling
 *     primitives. Live on conversationState.
 *   - Layer B (services/agent-memory.service.ts) — agent-curated free-form
 *     notes + episodic availability windows. Live on appointment.memory.
 *     STRICTLY scoped per appointment; explicit cross-thread isolation
 *     contract.
 *
 * Layer C deliberately crosses thread boundaries. When a user books a
 * second appointment with a different therapist, the agent should start
 * warm — knowing the user prefers brief replies, books afternoons, etc.
 * That requires storing observations on the User row (per-user) and the
 * Therapist row (per-therapist), then injecting them into the agent's
 * system prompt for every appointment that involves that party.
 *
 * The privacy model is the entire point of this service:
 *
 *   1. Storage is keyed on User.id / Therapist.id. The read/write API
 *      only accepts those primary keys; there is no findFirst, no email
 *      lookup, no fallback path. Cross-user / cross-therapist leakage
 *      is impossible at the storage layer. Pinned by tests in
 *      __tests__/agent-profile.test.ts.
 *
 *   2. Phase 1 (this file) ships the storage + read path only. The only
 *      writers are admin endpoints in admin-users.routes.ts and
 *      admin-therapists.routes.ts. There is no auto-population yet.
 *      Profiles are empty by default; the format-for-prompt functions
 *      return '' for empty profiles so the system prompt section
 *      renders nothing until admins manually add notes.
 *
 *   3. Phase 2 (separate PR, gated behind a feature flag) will add
 *      automatic distillation on appointment completion. That layer
 *      stacks four independent privacy guards:
 *         - LLM denylist in the distillation system prompt
 *         - Zod schema validation
 *         - Server-side regex denylist for clinical / third-party content
 *         - Read-time per-party scoping (this file's contract)
 *      Phase 1 implements the fourth guard now so Phase 2 only has to
 *      add the first three.
 *
 *   4. Right to be forgotten: clearUserProfile / clearTherapistProfile
 *      wipe the column. The standard user-deletion path (cascade)
 *      already removes the row including the profile.
 */

import { Prisma } from '@prisma/client';
import { prisma } from '../utils/database';
import { logger } from '../utils/logger';
import crypto from 'crypto';

/**
 * Profiles cap at fewer notes than per-thread memory: they accumulate
 * across many appointments, so a small cap forces selectivity. Older
 * entries get evicted FIFO as new ones land.
 */
export const MAX_PROFILE_NOTES = 10;

/** Same per-note length as Layer B — fits comfortably in the prompt. */
export const MAX_PROFILE_NOTE_LENGTH = 280;

/**
 * Profile categories are deliberately tighter than Layer B's four
 * (preference / constraint / context / decision). Cross-thread context
 * is a smaller, safer set:
 *   - communication: how this party prefers to communicate
 *     ("brief replies", "responds before 10am UK")
 *   - scheduling: time-of-day / cadence patterns
 *     ("books afternoons", "weekly check-ins on Mondays")
 *   - context: stable situational background that affects scheduling
 *     ("travels frequently", "two-week notice before holidays")
 *
 * No 'preference' / 'decision' / 'constraint' — those are too broad
 * and risk capturing clinical or per-conversation signals. The
 * narrower set forces distillation to pick scheduling-relevant
 * observations only.
 */
export type ProfileCategory = 'communication' | 'scheduling' | 'context';

const VALID_CATEGORIES: readonly ProfileCategory[] = [
  'communication',
  'scheduling',
  'context',
];

export interface ProfileNote {
  /** Stable per-note id; deterministic hash of (category, normalized text). */
  id: string;
  category: ProfileCategory;
  text: string;
  /** Where the note came from. Phase 1 only emits 'admin'; Phase 2 adds 'distilled'. */
  source: 'admin' | 'distilled';
  /** For source='distilled': the appointment id this was extracted from. Absent for admin notes. */
  appointmentId?: string;
  createdAt: string;
}

export interface AgentProfile {
  notes: ProfileNote[];
  /** Wall-clock at last write. Surfaced in admin views; not used by the agent. */
  updatedAt: string;
  version: 'v1';
}

const EMPTY_PROFILE: AgentProfile = { notes: [], updatedAt: '', version: 'v1' };

/** Hash of (category, normalized text) — same shape as Layer B's noteId. */
function noteId(category: ProfileCategory, text: string): string {
  return crypto
    .createHash('sha256')
    .update(`${category}:${text.trim().toLowerCase()}`)
    .digest('hex')
    .substring(0, 16);
}

/**
 * Validate a profile blob coming back from the database. Returns a safe
 * empty profile if the shape is wrong — corrupted data shouldn't break
 * the agent loop.
 */
function parseProfile(raw: unknown): AgentProfile {
  if (!raw || typeof raw !== 'object') return EMPTY_PROFILE;
  const obj = raw as { notes?: unknown; updatedAt?: unknown; version?: unknown };

  const notes: ProfileNote[] = [];
  if (Array.isArray(obj.notes)) {
    for (const item of obj.notes) {
      if (!item || typeof item !== 'object') continue;
      const n = item as Partial<ProfileNote>;
      if (typeof n.id !== 'string' || typeof n.text !== 'string' || typeof n.createdAt !== 'string') continue;
      if (!VALID_CATEGORIES.includes(n.category as ProfileCategory)) continue;
      if (n.source !== 'admin' && n.source !== 'distilled') continue;
      notes.push({
        id: n.id,
        category: n.category as ProfileCategory,
        text: n.text,
        source: n.source,
        appointmentId: typeof n.appointmentId === 'string' ? n.appointmentId : undefined,
        createdAt: n.createdAt,
      });
    }
  }

  return {
    notes,
    updatedAt: typeof obj.updatedAt === 'string' ? obj.updatedAt : '',
    version: 'v1',
  };
}

// ─── User profile ───────────────────────────────────────────────────────────

/**
 * Read the agent profile for a user.
 *
 * STRICT: read is by primary key only. Returns empty profile when the
 * user doesn't exist; never falls back to a broader query.
 */
export async function getUserProfile(userId: string): Promise<AgentProfile> {
  const row = await prisma.user.findUnique({
    where: { id: userId },
    select: { agentNotes: true },
  });
  if (!row) return EMPTY_PROFILE;
  return parseProfile(row.agentNotes);
}

export interface AddProfileNoteParams {
  category: ProfileCategory;
  text: string;
  source: 'admin' | 'distilled';
  /** Required when source='distilled'; absent for admin notes. */
  appointmentId?: string;
}

export interface AddProfileNoteResult {
  /** True if the write produced a new note; false if the same note was already present. */
  added: boolean;
  /** Profile state after the write (or unchanged on dedup). */
  profile: AgentProfile;
  /** Note id (existing or newly created). */
  noteId: string;
}

/**
 * Append a note to a user's agent profile.
 *
 * Behaviour mirrors Layer B's addNote:
 *   - Same (category, normalized text) on this user is a no-op.
 *   - When the array is at MAX_PROFILE_NOTES, oldest entry is evicted
 *     (FIFO) so newer observations are retained.
 *
 * STRICT: write is by primary key only. The caller passes a User.id;
 * the function uses Prisma `update({where: {id: userId}})`. There is
 * no path by which a write intended for user A can land on user B.
 */
export async function addUserProfileNote(
  userId: string,
  params: AddProfileNoteParams,
): Promise<AddProfileNoteResult> {
  const text = params.text.trim().slice(0, MAX_PROFILE_NOTE_LENGTH);
  if (!text) {
    throw new Error('addUserProfileNote: text cannot be empty');
  }
  const id = noteId(params.category, text);

  const current = await getUserProfile(userId);

  if (current.notes.some((n) => n.id === id)) {
    logger.debug(
      { userId, noteId: id, category: params.category },
      'agent-profile: user note already present, skipping (idempotent)',
    );
    return { added: false, profile: current, noteId: id };
  }

  const next: ProfileNote = {
    id,
    category: params.category,
    text,
    source: params.source,
    appointmentId: params.appointmentId,
    createdAt: new Date().toISOString(),
  };

  const trimmed = current.notes.slice(-(MAX_PROFILE_NOTES - 1));
  const updated: AgentProfile = {
    notes: [...trimmed, next],
    updatedAt: new Date().toISOString(),
    version: 'v1',
  };

  await prisma.user.update({
    where: { id: userId },
    data: { agentNotes: updated as unknown as object },
    select: { id: true },
  });

  logger.info(
    { userId, noteId: id, category: params.category, source: params.source, totalNotes: updated.notes.length },
    'agent-profile: user note added',
  );

  return { added: true, profile: updated, noteId: id };
}

/**
 * Wipe a user's agent profile. Used for right-to-be-forgotten flows
 * and admin-driven resets when a profile has drifted off-topic.
 *
 * STRICT: scoped by User.id only.
 */
export async function clearUserProfile(userId: string): Promise<void> {
  // Prisma's nullable Json columns require Prisma.DbNull to set the
  // underlying SQL NULL; plain `null` is rejected by the type system.
  await prisma.user.update({
    where: { id: userId },
    data: { agentNotes: Prisma.DbNull },
    select: { id: true },
  });
  logger.info({ userId }, 'agent-profile: user profile cleared');
}

// ─── Therapist profile ──────────────────────────────────────────────────────
//
// Mirrors the user functions; deliberately not collapsed into a generic
// helper. Per-entity scoping is the privacy contract of this module —
// keeping the user and therapist code paths separate makes it impossible
// for a future refactor to accidentally route one entity's writes to the
// other.

export async function getTherapistProfile(therapistId: string): Promise<AgentProfile> {
  const row = await prisma.therapist.findUnique({
    where: { id: therapistId },
    select: { agentNotes: true },
  });
  if (!row) return EMPTY_PROFILE;
  return parseProfile(row.agentNotes);
}

export async function addTherapistProfileNote(
  therapistId: string,
  params: AddProfileNoteParams,
): Promise<AddProfileNoteResult> {
  const text = params.text.trim().slice(0, MAX_PROFILE_NOTE_LENGTH);
  if (!text) {
    throw new Error('addTherapistProfileNote: text cannot be empty');
  }
  const id = noteId(params.category, text);

  const current = await getTherapistProfile(therapistId);

  if (current.notes.some((n) => n.id === id)) {
    logger.debug(
      { therapistId, noteId: id, category: params.category },
      'agent-profile: therapist note already present, skipping (idempotent)',
    );
    return { added: false, profile: current, noteId: id };
  }

  const next: ProfileNote = {
    id,
    category: params.category,
    text,
    source: params.source,
    appointmentId: params.appointmentId,
    createdAt: new Date().toISOString(),
  };

  const trimmed = current.notes.slice(-(MAX_PROFILE_NOTES - 1));
  const updated: AgentProfile = {
    notes: [...trimmed, next],
    updatedAt: new Date().toISOString(),
    version: 'v1',
  };

  await prisma.therapist.update({
    where: { id: therapistId },
    data: { agentNotes: updated as unknown as object },
    select: { id: true },
  });

  logger.info(
    { therapistId, noteId: id, category: params.category, source: params.source, totalNotes: updated.notes.length },
    'agent-profile: therapist note added',
  );

  return { added: true, profile: updated, noteId: id };
}

export async function clearTherapistProfile(therapistId: string): Promise<void> {
  await prisma.therapist.update({
    where: { id: therapistId },
    data: { agentNotes: Prisma.DbNull },
    select: { id: true },
  });
  logger.info({ therapistId }, 'agent-profile: therapist profile cleared');
}

// ─── Prompt formatting ──────────────────────────────────────────────────────

interface FormatOptions {
  /** Heading shown above the rendered notes. */
  heading: string;
  /** Optional one-liner shown beneath the heading. */
  description?: string;
}

function formatProfileForPrompt(profile: AgentProfile, opts: FormatOptions): string {
  if (profile.notes.length === 0) return '';

  const groups: Record<ProfileCategory, string[]> = {
    communication: [],
    scheduling: [],
    context: [],
  };
  for (const note of profile.notes) {
    groups[note.category].push(`- ${note.text}`);
  }

  const sections: string[] = [];
  const labels: Record<ProfileCategory, string> = {
    communication: 'Communication',
    scheduling: 'Scheduling',
    context: 'Context',
  };
  for (const cat of ['communication', 'scheduling', 'context'] as const) {
    if (groups[cat].length > 0) {
      sections.push(`**${labels[cat]}:**\n${groups[cat].join('\n')}`);
    }
  }

  const description = opts.description ? `${opts.description}\n\n` : '';

  return `## ${opts.heading}
${description}${sections.join('\n\n')}
`;
}

/**
 * Render a user's profile as a system-prompt section. Returns '' for
 * empty profiles so the prompt builder can drop the section entirely.
 *
 * The agent is told via the heading that this is *prior-bookings*
 * data, so it understands the temporal context (these aren't from the
 * current conversation).
 */
export function formatUserProfileForPrompt(profile: AgentProfile): string {
  return formatProfileForPrompt(profile, {
    heading: 'What we know about this client from prior bookings',
    description:
      'Observations distilled from this client\'s previous scheduling conversations. Use them to anticipate preferences, but trust the current conversation if it contradicts a note.',
  });
}

/** Render a therapist's profile as a system-prompt section. */
export function formatTherapistProfileForPrompt(profile: AgentProfile): string {
  return formatProfileForPrompt(profile, {
    heading: 'What we know about this therapist from prior bookings',
    description:
      'Observations distilled from this therapist\'s previous scheduling conversations. Use them to anticipate response cadence and preferences, but trust the current conversation if it contradicts a note.',
  });
}
