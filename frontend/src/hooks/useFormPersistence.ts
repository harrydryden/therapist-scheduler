import { useState, useEffect, useCallback, useRef } from 'react';

interface FormPersistenceOptions {
  /** Unique key for localStorage */
  storageKey: string;
  /** Debounce delay in ms (default: 1000) */
  debounceMs?: number;
  /** Whether to show restore prompt (default: true) */
  promptOnRestore?: boolean;
  /** Maximum age of draft in ms before auto-discarding (default: 24 hours) */
  maxAgeMs?: number;
}

interface StoredDraft<T> {
  data: T;
  timestamp: number;
}

interface FormPersistenceReturn<T> {
  /** Whether a restorable draft exists */
  hasDraft: boolean;
  /** The draft data if available */
  draftData: T | null;
  /** Draft timestamp if available */
  draftTimestamp: number | null;
  /** Save current form state to localStorage */
  saveDraft: (data: T) => void;
  /** Restore draft and clear the restore prompt */
  restoreDraft: () => T | null;
  /** Dismiss the draft (mark as handled without restoring) */
  dismissDraft: () => void;
  /** Clear the stored draft permanently */
  clearDraft: () => void;
}

/**
 * Custom hook for persisting form state across navigation.
 * Includes debounced auto-save, restore prompts, and draft age limits.
 */
export function useFormPersistence<T>(
  options: FormPersistenceOptions
): FormPersistenceReturn<T> {
  const {
    storageKey,
    debounceMs = 1000,
    maxAgeMs = 24 * 60 * 60 * 1000, // 24 hours
  } = options;

  const [hasDraft, setHasDraft] = useState(false);
  const [draftData, setDraftData] = useState<T | null>(null);
  const [draftTimestamp, setDraftTimestamp] = useState<number | null>(null);
  const debounceTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Check for existing draft on mount
  useEffect(() => {
    try {
      const stored = localStorage.getItem(storageKey);
      if (stored) {
        const parsed: StoredDraft<T> = JSON.parse(stored);
        const age = Date.now() - parsed.timestamp;

        // Check if draft is too old
        if (age > maxAgeMs) {
          localStorage.removeItem(storageKey);
          return;
        }

        setHasDraft(true);
        setDraftData(parsed.data);
        setDraftTimestamp(parsed.timestamp);
      }
    } catch {
      // Invalid stored data, clean it up
      localStorage.removeItem(storageKey);
    }
  }, [storageKey, maxAgeMs]);

  // Debounced save function
  const saveDraft = useCallback(
    (data: T) => {
      // Clear any pending debounce
      if (debounceTimeoutRef.current) {
        clearTimeout(debounceTimeoutRef.current);
      }

      debounceTimeoutRef.current = setTimeout(() => {
        try {
          const draft: StoredDraft<T> = {
            data,
            timestamp: Date.now(),
          };
          localStorage.setItem(storageKey, JSON.stringify(draft));
        } catch (err) {
          // Handle quota exceeded or other storage errors
          console.warn('Failed to save form draft:', err);
        }
      }, debounceMs);
    },
    [storageKey, debounceMs]
  );

  // Restore draft
  const restoreDraft = useCallback(() => {
    const data = draftData;
    setHasDraft(false);
    return data;
  }, [draftData]);

  // Dismiss draft without restoring
  const dismissDraft = useCallback(() => {
    setHasDraft(false);
    setDraftData(null);
    setDraftTimestamp(null);
    localStorage.removeItem(storageKey);
  }, [storageKey]);

  // Clear draft (e.g., after successful submission)
  const clearDraft = useCallback(() => {
    if (debounceTimeoutRef.current) {
      clearTimeout(debounceTimeoutRef.current);
    }
    setHasDraft(false);
    setDraftData(null);
    setDraftTimestamp(null);
    localStorage.removeItem(storageKey);
  }, [storageKey]);

  // Cleanup debounce timeout on unmount
  useEffect(() => {
    return () => {
      if (debounceTimeoutRef.current) {
        clearTimeout(debounceTimeoutRef.current);
      }
    };
  }, []);

  return {
    hasDraft,
    draftData,
    draftTimestamp,
    saveDraft,
    restoreDraft,
    dismissDraft,
    clearDraft,
  };
}

/**
 * Format a timestamp into a human-readable relative time string
 */
export function formatDraftAge(timestamp: number): string {
  const now = Date.now();
  const diffMs = now - timestamp;
  const diffMinutes = Math.floor(diffMs / (1000 * 60));
  const diffHours = Math.floor(diffMs / (1000 * 60 * 60));

  if (diffMinutes < 1) {
    return 'just now';
  } else if (diffMinutes < 60) {
    return `${diffMinutes} minute${diffMinutes !== 1 ? 's' : ''} ago`;
  } else if (diffHours < 24) {
    return `${diffHours} hour${diffHours !== 1 ? 's' : ''} ago`;
  } else {
    const date = new Date(timestamp);
    return date.toLocaleDateString();
  }
}
