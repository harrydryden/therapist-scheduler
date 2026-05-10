/**
 * Tests for the cross-appointment agent profile (Layer C).
 *
 * The most important tests in this file pin the privacy contract that
 * the design depends on:
 *
 *   1. Cross-user isolation: a write for user A must never appear when
 *      reading user B's profile. Same for therapists.
 *   2. User-vs-therapist isolation: writing a user-profile note must
 *      not land on a same-id therapist row, and vice versa.
 *   3. Read path uses findUnique only. A future refactor that
 *      introduces findFirst / email lookup would break this suite.
 *
 * Beyond isolation, we cover the operational guarantees that downstream
 * callers and the system prompt depend on: FIFO eviction at the cap,
 * dedup on (category, normalized text), defensive parsing of corrupted
 * JSON, and the prompt-format helpers.
 */

jest.mock('../utils/logger', () => ({
  logger: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
}));

// Separate stores per entity so a write to one table cannot leak to the
// other. The mocked prisma client dispatches strictly on `where.id`; a
// service bug that used a different field would not match here.
const userStore: Record<string, unknown> = {};
const therapistStore: Record<string, unknown> = {};

const mockUserFindUnique = jest.fn(async ({ where }: { where: { id: string } }) => {
  if (!(where.id in userStore)) return null;
  return { agentNotes: userStore[where.id] };
});

const mockUserUpdate = jest.fn(async ({ where, data }: { where: { id: string }; data: { agentNotes: unknown } }) => {
  if (!(where.id in userStore)) {
    throw new Error('P2025: record not found');
  }
  userStore[where.id] = data.agentNotes;
  return { id: where.id };
});

const mockTherapistFindUnique = jest.fn(async ({ where }: { where: { id: string } }) => {
  if (!(where.id in therapistStore)) return null;
  return { agentNotes: therapistStore[where.id] };
});

const mockTherapistUpdate = jest.fn(async ({ where, data }: { where: { id: string }; data: { agentNotes: unknown } }) => {
  if (!(where.id in therapistStore)) {
    throw new Error('P2025: record not found');
  }
  therapistStore[where.id] = data.agentNotes;
  return { id: where.id };
});

jest.mock('../utils/database', () => ({
  prisma: {
    user: {
      findUnique: (...a: unknown[]) => mockUserFindUnique(...(a as [{ where: { id: string } }])),
      update: (...a: unknown[]) => mockUserUpdate(...(a as [{ where: { id: string }; data: { agentNotes: unknown } }])),
    },
    therapist: {
      findUnique: (...a: unknown[]) => mockTherapistFindUnique(...(a as [{ where: { id: string } }])),
      update: (...a: unknown[]) => mockTherapistUpdate(...(a as [{ where: { id: string }; data: { agentNotes: unknown } }])),
    },
  },
}));

import {
  getUserProfile,
  addUserProfileNote,
  clearUserProfile,
  getTherapistProfile,
  addTherapistProfileNote,
  clearTherapistProfile,
  formatUserProfileForPrompt,
  formatTherapistProfileForPrompt,
  MAX_PROFILE_NOTES,
  MAX_PROFILE_NOTE_LENGTH,
  type AgentProfile,
} from '../services/agent-profile.service';

beforeEach(() => {
  jest.clearAllMocks();
  for (const k of Object.keys(userStore)) delete userStore[k];
  for (const k of Object.keys(therapistStore)) delete therapistStore[k];
});

function seedUser(id: string, initial: unknown = null) {
  userStore[id] = initial;
}

function seedTherapist(id: string, initial: unknown = null) {
  therapistStore[id] = initial;
}

describe('agent-profile: cross-entity isolation', () => {
  it('user writes are scoped to the supplied user id only', async () => {
    seedUser('user-A');
    seedUser('user-B');

    await addUserProfileNote('user-A', {
      category: 'communication',
      text: 'A-note: prefers brief replies',
      source: 'admin',
    });
    await addUserProfileNote('user-B', {
      category: 'scheduling',
      text: 'B-note: books mornings',
      source: 'admin',
    });

    const profA = await getUserProfile('user-A');
    const profB = await getUserProfile('user-B');

    expect(profA.notes).toHaveLength(1);
    expect(profA.notes[0].text).toContain('A-note');

    expect(profB.notes).toHaveLength(1);
    expect(profB.notes[0].text).toContain('B-note');
    expect(profB.notes.some((n) => n.text.includes('A-note'))).toBe(false);
  });

  it('therapist writes are scoped to the supplied therapist id only', async () => {
    seedTherapist('thx-A');
    seedTherapist('thx-B');

    await addTherapistProfileNote('thx-A', {
      category: 'communication',
      text: 'A-thx-note: replies within an hour',
      source: 'admin',
    });
    await addTherapistProfileNote('thx-B', {
      category: 'scheduling',
      text: 'B-thx-note: tight 24h cancellation policy',
      source: 'admin',
    });

    const profA = await getTherapistProfile('thx-A');
    const profB = await getTherapistProfile('thx-B');

    expect(profA.notes).toHaveLength(1);
    expect(profA.notes[0].text).toContain('A-thx-note');

    expect(profB.notes).toHaveLength(1);
    expect(profB.notes[0].text).toContain('B-thx-note');
    expect(profB.notes.some((n) => n.text.includes('A-thx-note'))).toBe(false);
  });

  it('user writes cannot land on a same-id therapist row (separate tables)', async () => {
    // Same id for both — this would catch a bug that mistakenly used
    // the wrong delegate.
    const id = 'shared-id';
    seedUser(id);
    seedTherapist(id);

    await addUserProfileNote(id, {
      category: 'communication',
      text: 'user-side note',
      source: 'admin',
    });

    const userProfile = await getUserProfile(id);
    const therapistProfile = await getTherapistProfile(id);

    expect(userProfile.notes).toHaveLength(1);
    expect(therapistProfile.notes).toHaveLength(0);
    expect(mockTherapistUpdate).not.toHaveBeenCalled();
  });

  it('therapist writes cannot land on a same-id user row', async () => {
    const id = 'shared-id';
    seedUser(id);
    seedTherapist(id);

    await addTherapistProfileNote(id, {
      category: 'scheduling',
      text: 'therapist-side note',
      source: 'admin',
    });

    expect((await getUserProfile(id)).notes).toHaveLength(0);
    expect((await getTherapistProfile(id)).notes).toHaveLength(1);
    expect(mockUserUpdate).not.toHaveBeenCalled();
  });

  it('reads use findUnique only (no findFirst fallback)', async () => {
    seedUser('user-A', {
      notes: [{ id: 'x', category: 'communication', text: 'foo', source: 'admin', createdAt: '2026-01-01T00:00:00Z' }],
      updatedAt: '2026-01-01T00:00:00Z',
      version: 'v1',
    });

    await getUserProfile('user-A');

    expect(mockUserFindUnique).toHaveBeenCalledTimes(1);
    expect(mockUserFindUnique).toHaveBeenCalledWith(
      expect.objectContaining({ where: { id: 'user-A' } }),
    );
  });

  it('returns empty profile for unknown id (no cross-contamination via fallthrough)', async () => {
    seedUser('user-A', {
      notes: [{ id: 'x', category: 'communication', text: 'A-only', source: 'admin', createdAt: '2026-01-01T00:00:00Z' }],
      updatedAt: '2026-01-01T00:00:00Z',
      version: 'v1',
    });

    const profile = await getUserProfile('user-does-not-exist');
    expect(profile.notes).toHaveLength(0);
  });
});

describe('agent-profile: FIFO + dedup', () => {
  it('evicts oldest note FIFO once the cap is exceeded', async () => {
    seedUser('user-A');

    // Push MAX_PROFILE_NOTES + 1 distinct notes. Each must be unique so
    // dedup doesn't kick in.
    for (let i = 0; i < MAX_PROFILE_NOTES + 1; i++) {
      await addUserProfileNote('user-A', {
        category: 'context',
        text: `observation #${i}`,
        source: 'admin',
      });
    }

    const profile = await getUserProfile('user-A');
    expect(profile.notes).toHaveLength(MAX_PROFILE_NOTES);
    // The first note ("#0") must have been evicted; the newest ("#10")
    // must be present.
    expect(profile.notes.some((n) => n.text.includes('observation #0'))).toBe(false);
    expect(profile.notes[profile.notes.length - 1].text).toContain(`observation #${MAX_PROFILE_NOTES}`);
  });

  it('dedup: identical (category, normalized text) is a no-op', async () => {
    seedUser('user-A');

    const r1 = await addUserProfileNote('user-A', {
      category: 'communication',
      text: 'Prefers brief replies',
      source: 'admin',
    });
    expect(r1.added).toBe(true);

    const r2 = await addUserProfileNote('user-A', {
      category: 'communication',
      text: '  prefers BRIEF replies  ', // whitespace + case difference
      source: 'admin',
    });
    expect(r2.added).toBe(false);
    expect(r2.noteId).toBe(r1.noteId);

    const profile = await getUserProfile('user-A');
    expect(profile.notes).toHaveLength(1);
  });

  it('dedup is per-category — same text under a different category is added', async () => {
    seedUser('user-A');

    await addUserProfileNote('user-A', {
      category: 'communication',
      text: 'punctual',
      source: 'admin',
    });
    const r = await addUserProfileNote('user-A', {
      category: 'scheduling',
      text: 'punctual',
      source: 'admin',
    });

    expect(r.added).toBe(true);
    const profile = await getUserProfile('user-A');
    expect(profile.notes).toHaveLength(2);
  });

  it('truncates note text past MAX_PROFILE_NOTE_LENGTH', async () => {
    seedUser('user-A');
    const long = 'x'.repeat(MAX_PROFILE_NOTE_LENGTH + 50);

    await addUserProfileNote('user-A', {
      category: 'context',
      text: long,
      source: 'admin',
    });

    const profile = await getUserProfile('user-A');
    expect(profile.notes[0].text.length).toBe(MAX_PROFILE_NOTE_LENGTH);
  });

  it('empty / whitespace-only text is rejected', async () => {
    seedUser('user-A');
    await expect(
      addUserProfileNote('user-A', { category: 'context', text: '   ', source: 'admin' }),
    ).rejects.toThrow(/empty/);
  });
});

describe('agent-profile: clear', () => {
  it('clearUserProfile sets the column to null and only touches the right user', async () => {
    seedUser('user-A');
    seedUser('user-B');
    await addUserProfileNote('user-A', { category: 'context', text: 'will be cleared', source: 'admin' });
    await addUserProfileNote('user-B', { category: 'context', text: 'survives', source: 'admin' });

    await clearUserProfile('user-A');

    // Readback after clear is the empty profile. Prisma's nullable JSON
    // column is cleared via Prisma.DbNull, so we don't assert on the
    // raw stored value — the contract is "next read is empty".
    expect((await getUserProfile('user-A')).notes).toHaveLength(0);
    // B untouched
    expect((await getUserProfile('user-B')).notes).toHaveLength(1);
  });

  it('clearTherapistProfile only affects the supplied therapist row', async () => {
    seedTherapist('thx-A');
    seedTherapist('thx-B');
    await addTherapistProfileNote('thx-A', { category: 'context', text: 'will be cleared', source: 'admin' });
    await addTherapistProfileNote('thx-B', { category: 'context', text: 'survives', source: 'admin' });

    await clearTherapistProfile('thx-A');

    expect((await getTherapistProfile('thx-A')).notes).toHaveLength(0);
    expect((await getTherapistProfile('thx-B')).notes).toHaveLength(1);
  });
});

describe('agent-profile: defensive parsing', () => {
  it('returns empty profile when the column is null', async () => {
    seedUser('user-A', null);
    const profile = await getUserProfile('user-A');
    expect(profile).toEqual({ notes: [], updatedAt: '', version: 'v1' });
  });

  it('returns empty profile when the column is an unexpected primitive', async () => {
    seedUser('user-A', 'corrupt-string');
    const profile = await getUserProfile('user-A');
    expect(profile.notes).toEqual([]);
  });

  it('skips malformed notes inside an otherwise valid profile blob', async () => {
    seedUser('user-A', {
      notes: [
        // valid
        { id: 'a', category: 'communication', text: 'good note', source: 'admin', createdAt: '2026-01-01T00:00:00Z' },
        // invalid category — must be filtered
        { id: 'b', category: 'preference', text: 'wrong-category', source: 'admin', createdAt: '2026-01-01T00:00:00Z' },
        // missing text — must be filtered
        { id: 'c', category: 'context', source: 'admin', createdAt: '2026-01-01T00:00:00Z' },
        // invalid source — must be filtered
        { id: 'd', category: 'scheduling', text: 'bad-source', source: 'evil', createdAt: '2026-01-01T00:00:00Z' },
      ],
      updatedAt: '2026-01-01T00:00:00Z',
      version: 'v1',
    });

    const profile = await getUserProfile('user-A');
    expect(profile.notes).toHaveLength(1);
    expect(profile.notes[0].id).toBe('a');
  });
});

describe('agent-profile: prompt formatting', () => {
  it('returns empty string for an empty profile', () => {
    const empty: AgentProfile = { notes: [], updatedAt: '', version: 'v1' };
    expect(formatUserProfileForPrompt(empty)).toBe('');
    expect(formatTherapistProfileForPrompt(empty)).toBe('');
  });

  it('groups notes by category and renders a labelled section', () => {
    const profile: AgentProfile = {
      notes: [
        { id: '1', category: 'communication', text: 'Prefers brief replies', source: 'admin', createdAt: '2026-01-01' },
        { id: '2', category: 'scheduling', text: 'Books afternoons', source: 'admin', createdAt: '2026-01-01' },
        { id: '3', category: 'communication', text: 'Responds before 10am UK', source: 'admin', createdAt: '2026-01-01' },
      ],
      updatedAt: '2026-01-01',
      version: 'v1',
    };

    const out = formatUserProfileForPrompt(profile);
    expect(out).toContain('## What we know about this client from prior bookings');
    expect(out).toContain('**Communication:**');
    expect(out).toContain('**Scheduling:**');
    expect(out).toContain('- Prefers brief replies');
    expect(out).toContain('- Responds before 10am UK');
    expect(out).toContain('- Books afternoons');
    // No empty 'Context' subsection rendered when no notes in that category
    expect(out).not.toContain('**Context:**');
  });

  it('therapist heading is distinct from user heading (prompt clarity)', () => {
    const profile: AgentProfile = {
      notes: [
        { id: '1', category: 'communication', text: 'Replies quickly', source: 'admin', createdAt: '2026-01-01' },
      ],
      updatedAt: '2026-01-01',
      version: 'v1',
    };

    const out = formatTherapistProfileForPrompt(profile);
    expect(out).toContain('## What we know about this therapist from prior bookings');
    expect(out).not.toContain('this client from prior bookings');
  });
});
