import { useEffect, useRef, type RefObject } from 'react';

const FOCUSABLE_SELECTOR = [
  'a[href]',
  'button:not([disabled])',
  'textarea:not([disabled])',
  'input:not([disabled]):not([type="hidden"])',
  'select:not([disabled])',
  '[tabindex]:not([tabindex="-1"])',
].join(',');

/** Focusable descendants of `container`, in DOM order. */
export function getFocusableElements(container: HTMLElement): HTMLElement[] {
  return Array.from(container.querySelectorAll<HTMLElement>(FOCUSABLE_SELECTOR)).filter(
    (el) => !el.hasAttribute('disabled') && el.getAttribute('aria-hidden') !== 'true',
  );
}

/**
 * Where Tab should land when it would otherwise leave the dialog: the
 * index to focus, or null to let the browser move focus normally.
 * `current` is the index of the focused element (-1 = focus is elsewhere).
 */
export function trapTarget(count: number, current: number, backwards: boolean): number | null {
  if (count === 0) return null;
  if (current === -1) return backwards ? count - 1 : 0;
  if (backwards && current === 0) return count - 1;
  if (!backwards && current === count - 1) return 0;
  return null;
}

/**
 * Accessible modal behaviour for dialogs and drawers: moves focus inside
 * on open, keeps Tab / Shift+Tab inside, closes on Escape (without letting
 * the key reach an enclosing dialog, so Esc on a confirm closes only the
 * confirm), and returns focus to whatever was focused before on close.
 */
export function useDialogA11y(
  ref: RefObject<HTMLElement>,
  { active = true, onEscape }: { active?: boolean; onEscape?: () => void } = {},
): void {
  const onEscapeRef = useRef(onEscape);
  onEscapeRef.current = onEscape;

  useEffect(() => {
    if (!active) return;
    const container = ref.current;
    if (!container) return;

    const previouslyFocused = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    if (!container.contains(document.activeElement)) {
      (getFocusableElements(container)[0] ?? container).focus();
    }

    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        if (onEscapeRef.current) {
          event.stopPropagation();
          onEscapeRef.current();
        }
        return;
      }
      if (event.key !== 'Tab') return;
      const items = getFocusableElements(container);
      if (items.length === 0) {
        event.preventDefault();
        container.focus();
        return;
      }
      const target = trapTarget(items.length, items.indexOf(document.activeElement as HTMLElement), event.shiftKey);
      if (target !== null) {
        event.preventDefault();
        items[target].focus();
      }
    };

    container.addEventListener('keydown', onKeyDown);
    return () => {
      container.removeEventListener('keydown', onKeyDown);
      if (previouslyFocused && document.contains(previouslyFocused)) {
        previouslyFocused.focus();
      }
    };
  }, [active, ref]);
}
