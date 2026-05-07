/**
 * Tests for the shared first-name extractor (utils/first-name.ts).
 *
 * Used in every user/therapist email salutation so we say "Hi John,"
 * not "Hi John Smith,". Edge cases here matter because real-world
 * inputs include null / empty / whitespace-only / single-word names.
 */

import { firstName } from '../utils/first-name';

describe('firstName', () => {
  it('returns the substring before the first whitespace for a multi-word name', () => {
    expect(firstName('John Smith')).toBe('John');
    expect(firstName('Mary Jane Watson')).toBe('Mary');
  });

  it('returns the whole name when there is no whitespace', () => {
    expect(firstName('Madonna')).toBe('Madonna');
  });

  it('treats consecutive whitespace as a single delimiter', () => {
    expect(firstName('John   Smith')).toBe('John');
    expect(firstName('John\tSmith')).toBe('John');
    expect(firstName('John\nSmith')).toBe('John');
  });

  it('trims leading whitespace before extracting', () => {
    expect(firstName('  John Smith')).toBe('John');
    expect(firstName('\t Mary')).toBe('Mary');
  });

  it('returns the default fallback for null', () => {
    expect(firstName(null)).toBe('there');
  });

  it('returns the default fallback for undefined', () => {
    expect(firstName(undefined)).toBe('there');
  });

  it('returns the default fallback for an empty string', () => {
    expect(firstName('')).toBe('there');
  });

  it('returns the default fallback for whitespace-only input', () => {
    expect(firstName('   ')).toBe('there');
    expect(firstName('\t\n')).toBe('there');
  });

  it('honours a custom fallback when provided', () => {
    expect(firstName(null, 'the client')).toBe('the client');
    expect(firstName(undefined, 'your therapist')).toBe('your therapist');
    expect(firstName('', 'friend')).toBe('friend');
    expect(firstName('   ', 'friend')).toBe('friend');
  });

  it('does not invoke the fallback when a real first name is present', () => {
    expect(firstName('Alice', 'fallback')).toBe('Alice');
    expect(firstName('Alice Wonderland', 'fallback')).toBe('Alice');
  });

  it('preserves case (no normalization)', () => {
    // The salutation should match the user's preferred capitalisation.
    expect(firstName('alice')).toBe('alice');
    expect(firstName('MCDONALD smith')).toBe('MCDONALD');
    expect(firstName('mary-jane Watson')).toBe('mary-jane');
  });

  it('handles names containing internal punctuation as a single token', () => {
    // Hyphenated or apostrophised first names are a single whitespace-
    // delimited token; we keep them whole.
    expect(firstName("O'Brien Patrick")).toBe("O'Brien");
    expect(firstName('Anne-Marie Dupont')).toBe('Anne-Marie');
  });
});
