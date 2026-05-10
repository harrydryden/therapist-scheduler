/**
 * Tests for the per-thread agent memory.
 *
 * The most important test in this file is the cross-appointment
 * isolation case: notes written to appointment A must never appear when
 * reading appointment B, and vice versa. The agent design relies on
 * primary-key scoping at the storage layer; this test pins that contract
 * so any future refactor that introduces a `findFirst` / email-based
 * lookup / shared global cache breaks the suite.
 */

jest.mock('../utils/logger', () => ({
  logger: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
}));

// In-memory store keyed by appointment id. The mock prisma below
// dispatches strictly on the where.id field — a buggy implementation
// of the service that uses a non-id query would not match here and the
// test would fail loudly.
const memoryStore: Record<string, unknown> = {};

const mockFindUnique = jest.fn(async ({ where }: { where: { id: string } }) => {
  if (!(where.id in memoryStore)) return null;
  return { memory: memoryStore[where.id] };
});

const mockUpdate = jest.fn(async ({ where, data }: { where: { id: string }; data: { memory: unknown } }) => {
  // Mirror Prisma: throws (P2025) if the row doesn't exist. Tests
  // pre-create rows so this only fires for genuine bad lookups.
  if (!(where.id in memoryStore)) {
    throw new Error('P2025: record not found');
  }
  memoryStore[where.id] = data.memory;
  return { id: where.id };
});

jest.mock('../utils/database', () => ({
  prisma: {
    appointmentRequest: {
      findUnique: (...a: unknown[]) => mockFindUnique(...(a as [{ where: { id: string } }])),
      update: (...a: unknown[]) => mockUpdate(...(a as [{ where: { id: string }; data: { memory: unknown } }])),
    },
  },
}));

import {
  addNote,
  getThreadMemory,
  formatMemoryForPrompt,
  addAvailabilityWindow,
  getActiveWindows,
  formatAvailabilityWindowsForPrompt,
  MAX_NOTES_PER_THREAD,
  MAX_NOTE_LENGTH,
  MAX_WINDOWS_PER_THREAD,
} from '../services/agent-memory.service';

beforeEach(() => {
  jest.clearAllMocks();
  // Reset the in-memory store for each test
  for (const k of Object.keys(memoryStore)) delete memoryStore[k];
});

function seedAppointment(id: string, initialMemory: unknown = null) {
  memoryStore[id] = initialMemory;
}

describe('agent-memory: cross-appointment isolation', () => {
  it('addNote writes are scoped to the supplied appointment id only', async () => {
    seedAppointment('apt-A');
    seedAppointment('apt-B');

    await addNote('apt-A', 'preference', 'A-note: user prefers single-line emails');
    await addNote('apt-B', 'context', 'B-note: user mentioned a job interview Friday');

    const memA = await getThreadMemory('apt-A');
    const memB = await getThreadMemory('apt-B');

    // A must contain only A-note
    expect(memA.notes).toHaveLength(1);
    expect(memA.notes[0].text).toContain('A-note');

    // B must contain only B-note — NEVER A's content
    expect(memB.notes).toHaveLength(1);
    expect(memB.notes[0].text).toContain('B-note');
    expect(memB.notes.some((n) => n.text.includes('A-note'))).toBe(false);
  });

  it('getThreadMemory only queries by primary key (no findFirst fallback)', async () => {
    seedAppointment('apt-A', {
      notes: [{ id: 'x', category: 'preference', text: 'foo', createdAt: '2026-01-01T00:00:00Z' }],
    });

    await getThreadMemory('apt-A');

    // findUnique must be the only query method called.
    // The mock prisma client doesn't expose findFirst at all, so any
    // accidental switch to findFirst would throw at runtime — but we
    // also assert the expected call shape here so the contract is
    // explicit, not implicit.
    expect(mockFindUnique).toHaveBeenCalledTimes(1);
    expect(mockFindUnique).toHaveBeenCalledWith(
      expect.objectContaining({ where: { id: 'apt-A' } }),
    );
  });

  it('returns empty memory for unknown appointment id (no cross-contamination via fallthrough)', async () => {
    seedAppointment('apt-A', {
      notes: [{ id: 'x', category: 'preference', text: 'A-only', createdAt: '2026-01-01T00:00:00Z' }],
    });

    // Nonexistent appointment — must NOT leak A's notes
    const mem = await getThreadMemory('apt-does-not-exist');
    expect(mem.notes).toHaveLength(0);
  });

  it('concurrent writes on different appointments do not bleed (sequential simulation)', async () => {
    // We can't truly test concurrent writes without race orchestration,
    // but we can verify that interleaved writes maintain isolation.
    seedAppointment('apt-A');
    seedAppointment('apt-B');

    await addNote('apt-A', 'preference', 'A1');
    await addNote('apt-B', 'preference', 'B1');
    await addNote('apt-A', 'context', 'A2');
    await addNote('apt-B', 'context', 'B2');
    await addNote('apt-A', 'decision', 'A3');

    const memA = await getThreadMemory('apt-A');
    const memB = await getThreadMemory('apt-B');

    expect(memA.notes.map((n) => n.text)).toEqual(['A1', 'A2', 'A3']);
    expect(memB.notes.map((n) => n.text)).toEqual(['B1', 'B2']);
  });
});

describe('agent-memory: addNote behaviour', () => {
  it('returns added=true for a new note and stores it', async () => {
    seedAppointment('apt-1');
    const result = await addNote('apt-1', 'preference', 'user prefers afternoons');
    expect(result.added).toBe(true);
    expect(result.memory.notes).toHaveLength(1);
    expect(result.memory.notes[0].text).toBe('user prefers afternoons');
    expect(result.memory.notes[0].category).toBe('preference');
  });

  it('returns added=false for a duplicate note (same category + text)', async () => {
    seedAppointment('apt-1');
    await addNote('apt-1', 'preference', 'user prefers afternoons');
    const second = await addNote('apt-1', 'preference', 'user prefers afternoons');
    expect(second.added).toBe(false);
    expect(second.memory.notes).toHaveLength(1);
  });

  it('treats text differing only by case/whitespace as the same note', async () => {
    seedAppointment('apt-1');
    await addNote('apt-1', 'preference', 'User prefers afternoons');
    const second = await addNote('apt-1', 'preference', '   user prefers afternoons   ');
    expect(second.added).toBe(false);
    expect(second.memory.notes).toHaveLength(1);
  });

  it('treats same text in different categories as different notes', async () => {
    seedAppointment('apt-1');
    await addNote('apt-1', 'preference', 'mornings only');
    const second = await addNote('apt-1', 'constraint', 'mornings only');
    expect(second.added).toBe(true);
    expect(second.memory.notes).toHaveLength(2);
  });

  it('truncates notes longer than MAX_NOTE_LENGTH at storage time', async () => {
    seedAppointment('apt-1');
    const longText = 'x'.repeat(MAX_NOTE_LENGTH + 50);
    const result = await addNote('apt-1', 'context', longText);
    expect(result.memory.notes[0].text.length).toBe(MAX_NOTE_LENGTH);
  });
});

describe('agent-memory: FIFO eviction', () => {
  it('evicts the oldest note once MAX_NOTES_PER_THREAD is exceeded', async () => {
    seedAppointment('apt-1');

    // Fill to capacity
    for (let i = 0; i < MAX_NOTES_PER_THREAD; i++) {
      await addNote('apt-1', 'context', `note-${i}`);
    }
    let mem = await getThreadMemory('apt-1');
    expect(mem.notes).toHaveLength(MAX_NOTES_PER_THREAD);
    expect(mem.notes[0].text).toBe('note-0');

    // One more — should evict note-0 (the oldest)
    await addNote('apt-1', 'context', 'overflow');
    mem = await getThreadMemory('apt-1');
    expect(mem.notes).toHaveLength(MAX_NOTES_PER_THREAD);
    expect(mem.notes[0].text).toBe('note-1'); // note-0 gone
    expect(mem.notes[mem.notes.length - 1].text).toBe('overflow'); // newest at the end
  });
});

describe('agent-memory: corrupt-data robustness', () => {
  it('returns empty memory when stored value is the wrong shape', async () => {
    // Various shapes a future bug might leave in the column. None
    // should throw or leak — all should fall back to empty memory.
    const corruptCases = [
      'a string',
      42,
      [],
      { wrong: 'shape' },
      { notes: 'not-an-array' },
      { notes: [{ id: 'no-text' }] }, // missing required fields
      { notes: [null] },
    ];

    for (const c of corruptCases) {
      seedAppointment('apt-corrupt', c);
      const mem = await getThreadMemory('apt-corrupt');
      expect(mem.notes).toEqual([]);
    }
  });

  it('drops malformed individual notes but keeps valid ones', async () => {
    seedAppointment('apt-mixed', {
      notes: [
        { id: 'good', category: 'preference', text: 'valid', createdAt: '2026-01-01T00:00:00Z' },
        { id: 'bad', category: 'NOT_A_CATEGORY', text: 'invalid', createdAt: '2026-01-01T00:00:00Z' },
        { id: 'also-good', category: 'context', text: 'also valid', createdAt: '2026-01-01T00:00:00Z' },
      ],
    });
    const mem = await getThreadMemory('apt-mixed');
    expect(mem.notes.map((n) => n.text)).toEqual(['valid', 'also valid']);
  });
});

describe('agent-memory: prompt formatting', () => {
  it('returns empty string when there are no notes', () => {
    expect(formatMemoryForPrompt({ notes: [], availabilityWindows: [] })).toBe('');
  });

  it('groups notes by category in stable order', () => {
    const formatted = formatMemoryForPrompt({
      notes: [
        { id: '1', category: 'context', text: 'job interview Friday', createdAt: '2026-01-01' },
        { id: '2', category: 'preference', text: 'prefers afternoons', createdAt: '2026-01-01' },
        { id: '3', category: 'preference', text: 'short emails', createdAt: '2026-01-01' },
        { id: '4', category: 'decision', text: 'weekly Mondays going forward', createdAt: '2026-01-01' },
      ],
      availabilityWindows: [],
    });

    // Stable order is preference → constraint → context → decision
    const prefIdx = formatted.indexOf('Preferences');
    const ctxIdx = formatted.indexOf('Context');
    const decIdx = formatted.indexOf('Decisions');
    expect(prefIdx).toBeGreaterThan(-1);
    expect(ctxIdx).toBeGreaterThan(prefIdx);
    expect(decIdx).toBeGreaterThan(ctxIdx);

    // Each note's text appears in the output
    expect(formatted).toContain('prefers afternoons');
    expect(formatted).toContain('short emails');
    expect(formatted).toContain('job interview Friday');
    expect(formatted).toContain('weekly Mondays going forward');
  });

  it('omits empty category sections', () => {
    const formatted = formatMemoryForPrompt({
      notes: [
        { id: '1', category: 'preference', text: 'just one', createdAt: '2026-01-01' },
      ],
      availabilityWindows: [],
    });
    expect(formatted).toContain('Preferences');
    expect(formatted).not.toContain('Constraints');
    expect(formatted).not.toContain('Context');
    expect(formatted).not.toContain('Decisions');
  });
});

describe('agent-memory: availability windows — cross-appointment isolation', () => {
  it('windows written to one appointment never appear when reading another', async () => {
    seedAppointment('apt-A');
    seedAppointment('apt-B');

    await addAvailabilityWindow('apt-A', {
      startsAt: '2099-01-05T10:00:00+00:00',
      endsAt: '2099-01-05T11:00:00+00:00',
      status: 'available',
      source: 'therapist',
      quote: 'A: this Friday morning',
    });
    await addAvailabilityWindow('apt-B', {
      startsAt: '2099-01-12T14:00:00+00:00',
      endsAt: '2099-01-12T15:00:00+00:00',
      status: 'unavailable',
      source: 'therapist',
      quote: 'B: out next Friday afternoon',
    });

    const memA = await getThreadMemory('apt-A');
    const memB = await getThreadMemory('apt-B');

    expect(memA.availabilityWindows).toHaveLength(1);
    expect(memA.availabilityWindows[0].quote).toContain('A:');
    expect(memB.availabilityWindows).toHaveLength(1);
    expect(memB.availabilityWindows[0].quote).toContain('B:');
    // The critical assertion: B's read does NOT contain A's content.
    expect(memB.availabilityWindows.some((w) => w.quote.includes('A:'))).toBe(false);
  });

  it('notes and windows live in the same memory blob without overwriting each other', async () => {
    seedAppointment('apt-1');
    await addNote('apt-1', 'preference', 'prefers afternoons');
    await addAvailabilityWindow('apt-1', {
      startsAt: '2099-01-05T10:00:00+00:00',
      endsAt: '2099-01-05T11:00:00+00:00',
      status: 'available',
      source: 'therapist',
      quote: 'this Friday',
    });
    await addNote('apt-1', 'context', 'job interview Friday');

    const mem = await getThreadMemory('apt-1');
    expect(mem.notes.map((n) => n.text)).toEqual(['prefers afternoons', 'job interview Friday']);
    expect(mem.availabilityWindows).toHaveLength(1);
  });
});

describe('agent-memory: addAvailabilityWindow validation', () => {
  beforeEach(() => seedAppointment('apt-1'));

  it('rejects unparseable timestamps', async () => {
    await expect(
      addAvailabilityWindow('apt-1', {
        startsAt: 'not a date',
        endsAt: '2099-01-05T11:00:00+00:00',
        status: 'available',
        source: 'therapist',
        quote: 'q',
      }),
    ).rejects.toThrow(/parseable ISO/);
  });

  it('rejects endsAt <= startsAt', async () => {
    await expect(
      addAvailabilityWindow('apt-1', {
        startsAt: '2099-01-05T11:00:00+00:00',
        endsAt: '2099-01-05T10:00:00+00:00',
        status: 'available',
        source: 'therapist',
        quote: 'q',
      }),
    ).rejects.toThrow(/strictly after/);
  });

  it('dedupes identical windows on the same appointment', async () => {
    const params = {
      startsAt: '2099-01-05T10:00:00+00:00',
      endsAt: '2099-01-05T11:00:00+00:00',
      status: 'available' as const,
      source: 'therapist' as const,
      quote: 'this Friday morning',
    };
    const first = await addAvailabilityWindow('apt-1', params);
    const second = await addAvailabilityWindow('apt-1', { ...params, quote: 'paraphrased differently' });
    expect(first.added).toBe(true);
    expect(second.added).toBe(false);
    // Quote on the stored window is from the first call, not overwritten
    // by the second's paraphrase.
    expect(second.memory.availabilityWindows[0].quote).toBe('this Friday morning');
  });

  it('treats different status as different windows', async () => {
    const base = {
      startsAt: '2099-01-05T10:00:00+00:00',
      endsAt: '2099-01-05T11:00:00+00:00',
      source: 'therapist' as const,
      quote: 'q',
    };
    await addAvailabilityWindow('apt-1', { ...base, status: 'available' });
    const second = await addAvailabilityWindow('apt-1', { ...base, status: 'unavailable' });
    expect(second.added).toBe(true);
    expect(second.memory.availabilityWindows).toHaveLength(2);
  });
});

describe('agent-memory: window FIFO eviction', () => {
  it('evicts the oldest window once MAX_WINDOWS_PER_THREAD is exceeded', async () => {
    seedAppointment('apt-1');
    // Each window must have a unique (start, end) combo to dedupe across,
    // so we space them by an hour.
    const baseStart = Date.parse('2099-01-01T00:00:00+00:00');
    for (let i = 0; i < MAX_WINDOWS_PER_THREAD; i++) {
      const s = new Date(baseStart + i * 3600_000).toISOString();
      const e = new Date(baseStart + (i + 1) * 3600_000).toISOString();
      await addAvailabilityWindow('apt-1', {
        startsAt: s,
        endsAt: e,
        status: 'available',
        source: 'therapist',
        quote: `slot-${i}`,
      });
    }
    let mem = await getThreadMemory('apt-1');
    expect(mem.availabilityWindows).toHaveLength(MAX_WINDOWS_PER_THREAD);
    expect(mem.availabilityWindows[0].quote).toBe('slot-0');

    // One overflow → evicts slot-0
    const overflowStart = new Date(baseStart + (MAX_WINDOWS_PER_THREAD) * 3600_000).toISOString();
    const overflowEnd = new Date(baseStart + (MAX_WINDOWS_PER_THREAD + 1) * 3600_000).toISOString();
    await addAvailabilityWindow('apt-1', {
      startsAt: overflowStart,
      endsAt: overflowEnd,
      status: 'available',
      source: 'therapist',
      quote: 'overflow',
    });
    mem = await getThreadMemory('apt-1');
    expect(mem.availabilityWindows).toHaveLength(MAX_WINDOWS_PER_THREAD);
    expect(mem.availabilityWindows[0].quote).toBe('slot-1');
    expect(mem.availabilityWindows[mem.availabilityWindows.length - 1].quote).toBe('overflow');
  });
});

describe('agent-memory: getActiveWindows future-only filter', () => {
  it('drops windows whose endsAt is in the past', () => {
    const now = new Date('2026-06-01T12:00:00Z');
    const memory = {
      notes: [],
      availabilityWindows: [
        // Past — must be dropped
        {
          id: 'past',
          startsAt: '2026-05-15T10:00:00Z',
          endsAt: '2026-05-15T11:00:00Z',
          status: 'available' as const,
          source: 'therapist' as const,
          quote: 'past',
          recordedAt: '2026-05-10T10:00:00Z',
        },
        // Future — kept
        {
          id: 'future',
          startsAt: '2026-06-05T10:00:00Z',
          endsAt: '2026-06-05T11:00:00Z',
          status: 'available' as const,
          source: 'therapist' as const,
          quote: 'future',
          recordedAt: '2026-05-30T10:00:00Z',
        },
      ],
    };
    const active = getActiveWindows(memory, now);
    expect(active).toHaveLength(1);
    expect(active[0].id).toBe('future');
  });

  it('sorts active windows by startsAt ascending', () => {
    const now = new Date('2026-06-01T12:00:00Z');
    const memory = {
      notes: [],
      availabilityWindows: [
        {
          id: 'later',
          startsAt: '2026-06-20T10:00:00Z',
          endsAt: '2026-06-20T11:00:00Z',
          status: 'available' as const,
          source: 'therapist' as const,
          quote: 'later',
          recordedAt: '2026-05-30T10:00:00Z',
        },
        {
          id: 'sooner',
          startsAt: '2026-06-05T10:00:00Z',
          endsAt: '2026-06-05T11:00:00Z',
          status: 'available' as const,
          source: 'therapist' as const,
          quote: 'sooner',
          recordedAt: '2026-05-30T10:00:00Z',
        },
      ],
    };
    const active = getActiveWindows(memory, now);
    expect(active.map((w) => w.id)).toEqual(['sooner', 'later']);
  });
});

describe('agent-memory: window prompt formatting', () => {
  it('returns empty string when there are no future windows', () => {
    expect(formatAvailabilityWindowsForPrompt({ notes: [], availabilityWindows: [] })).toBe('');
  });

  it('separates available from unavailable sections', () => {
    const now = new Date('2026-06-01T12:00:00Z');
    const formatted = formatAvailabilityWindowsForPrompt(
      {
        notes: [],
        availabilityWindows: [
          {
            id: 'a1',
            startsAt: '2026-06-05T10:00:00Z',
            endsAt: '2026-06-05T11:00:00Z',
            status: 'available',
            source: 'therapist',
            quote: 'this Friday',
            recordedAt: '2026-05-30T10:00:00Z',
          },
          {
            id: 'b1',
            startsAt: '2026-06-15T00:00:00Z',
            endsAt: '2026-06-22T00:00:00Z',
            status: 'unavailable',
            source: 'therapist',
            quote: 'out the week of the 15th',
            recordedAt: '2026-05-30T10:00:00Z',
          },
        ],
      },
      now,
    );
    expect(formatted).toContain('Mentioned available windows');
    expect(formatted).toContain('Mentioned unavailable windows');
    expect(formatted).toContain('this Friday');
    expect(formatted).toContain('out the week of the 15th');
  });

  it('omits expired windows from the rendered prompt', () => {
    const now = new Date('2026-06-01T12:00:00Z');
    const formatted = formatAvailabilityWindowsForPrompt(
      {
        notes: [],
        availabilityWindows: [
          {
            id: 'expired',
            startsAt: '2026-05-15T10:00:00Z',
            endsAt: '2026-05-15T11:00:00Z',
            status: 'available',
            source: 'therapist',
            quote: 'last week',
            recordedAt: '2026-05-10T10:00:00Z',
          },
        ],
      },
      now,
    );
    expect(formatted).toBe('');
  });
});
